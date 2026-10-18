# BlockFace+ · 旧库升级
# Copyright 2026 Dainsleif · Apache License 2.0
#
# schema.sql 里全是 CREATE TABLE IF NOT EXISTS：对**已存在**的表，新增列不会自己出现。
# 线上库是带着数据升级的，`db.connect()` 必须在不丢数据的前提下把新列补上，
# 否则升级后第一条查询就是 "no such column: preview_ext"，整个服务起不来。

from __future__ import annotations

import asyncio
import sqlite3
from pathlib import Path
from typing import Any

import aiosqlite
import pytest

import bfp.db as bfp_db
from bfp.db import Database

# 加预览之前的 room_base：没有 preview_* 四列
LEGACY_SCHEMA = """
CREATE TABLE rooms (
  room_id               TEXT    PRIMARY KEY,
  created_at            INTEGER NOT NULL,
  expires_at            INTEGER NOT NULL,
  edit_password_hash    TEXT    NOT NULL,
  admin_password_hash   TEXT    NOT NULL,
  edit_password_length  INTEGER NOT NULL,
  admin_password_length INTEGER NOT NULL
);
CREATE TABLE room_base (
  room_id    TEXT    PRIMARY KEY REFERENCES rooms (room_id) ON DELETE CASCADE,
  ext        TEXT    NOT NULL,
  type       TEXT    NOT NULL,
  name       TEXT    NOT NULL,
  width      INTEGER NOT NULL,
  height     INTEGER NOT NULL,
  status     TEXT    NOT NULL CHECK (status IN ('draft', 'ready')),
  updated_at INTEGER NOT NULL
);
"""


async def test_legacy_database_gains_the_preview_columns(tmp_path):
    db_path = tmp_path / "bfp.sqlite3"
    with sqlite3.connect(db_path) as legacy:
        legacy.executescript(LEGACY_SCHEMA)
        legacy.execute(
            "INSERT INTO rooms VALUES (?, ?, ?, ?, ?, ?, ?)",
            ("room1", 1, 2, "h1", "h2", 8, 12),
        )
        legacy.execute(
            "INSERT INTO room_base VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            ("room1", "png", "image/png", "底图.png", 1920, 1080, "ready", 3),
        )

    db = Database(db_path)
    await db.connect()
    try:
        columns = {row["name"] for row in await db.fetchall("PRAGMA table_info(room_base)")}
        assert {"preview_ext", "preview_type", "preview_width", "preview_height"} <= columns

        # 老数据一个字节都不能少：升级只加列，不改不删
        row = await db.fetchone("SELECT * FROM room_base WHERE room_id = ?", ("room1",))
        assert row["width"] == 1920
        assert row["height"] == 1080
        assert row["status"] == "ready"
        # 新列默认 NULL = 没有预览，非管理员会退回拿原图
        assert row["preview_ext"] is None
        assert row["preview_width"] is None
    finally:
        await db.close()


async def test_migration_is_idempotent(tmp_path):
    """同一个库连两次：第二次不能因为列已存在而崩掉"""
    db_path = tmp_path / "bfp.sqlite3"
    first = Database(db_path)
    await first.connect()
    await first.close()

    second = Database(db_path)
    await second.connect()
    try:
        columns = {row["name"] for row in await second.fetchall("PRAGMA table_info(room_base)")}
        assert "preview_ext" in columns
    finally:
        await second.close()


async def test_concurrent_connections_migrate_a_legacy_database_safely(tmp_path):
    """服务和 bfp-ops 同时启动时，两边都会跑迁移。

    修复前：两个连接都查到"缺 preview_ext"，然后都去 ALTER，后一个抛
    "duplicate column name" 直接把启动打挂（4 进程 10/10 轮必崩）。
    _migrate 现在整段包在 BEGIN IMMEDIATE 里、拿到写锁之后才查，所以并发安全。
    这里用同一个进程里的多个连接压它 —— 触发的是同一段 SQL、同一种争用。
    """
    db_path = tmp_path / "bfp.sqlite3"
    with sqlite3.connect(db_path) as legacy:
        legacy.executescript(LEGACY_SCHEMA)
        legacy.execute(
            "INSERT INTO room_base VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            ("room1", "png", "image/png", "底图.png", 1920, 1080, "ready", 3),
        )

    # 刻意不预置 WAL：新装时库还是 rollback journal，"切 WAL"这一步同样会撞锁，
    # 而那条 PRAGMA 不走 busy handler，只能靠 _switch_to_wal 自己退避重试。
    connections = [Database(db_path) for _ in range(6)]
    results = await asyncio.gather(
        *(db.connect() for db in connections), return_exceptions=True
    )
    errors = [result for result in results if isinstance(result, BaseException)]
    try:
        assert errors == [], f"并发迁移不能有任何一边失败：{errors}"
        # 每个连接都要能看到补齐后的列
        for db in connections:
            columns = {row["name"] for row in await db.fetchall("PRAGMA table_info(room_base)")}
            assert {"preview_ext", "preview_type", "preview_width", "preview_height"} <= columns
        row = await connections[0].fetchone("SELECT * FROM room_base WHERE room_id = ?", ("room1",))
        assert row["width"] == 1920
        assert row["preview_ext"] is None
    finally:
        for db in connections:
            await db.close()


class _FlakyConnection:
    """按剧本抛锁错误的假连接：验证重试逻辑本身，而不是碰运气造真实争用。"""

    def __init__(self, failures: int, message: str = "database is locked") -> None:
        self.failures = failures
        self.message = message
        self.attempts = 0

    async def execute(self, sql: str):
        assert "journal_mode=WAL" in sql
        self.attempts += 1
        if self.attempts <= self.failures:
            raise sqlite3.OperationalError(self.message)
        return None


async def test_switch_to_wal_retries_through_transient_locks():
    """切 WAL 撞锁必须自己退避重试，不能一次失败就放弃。

    PRAGMA journal_mode=WAL 在"库还不是 WAL"时要拿排他锁，而那条路径**不走
    busy handler**：明明设了 busy_timeout=5000，它也在 0.00s 就返回 SQLITE_BUSY
    （实测 6 个连接并发切换，40 轮里 28 次这样立刻失败）。
    所以 _switch_to_wal 自己退避重试 —— 这里用假连接把"前两次撞锁、第三次成功"
    的剧本演出来，断言它确实重试到了成功。
    """
    conn = _FlakyConnection(failures=2)
    await bfp_db._switch_to_wal(conn)
    assert conn.attempts == 3


async def test_switch_to_wal_gives_up_on_non_lock_errors():
    """不是锁的错就别重试，原样抛出去。"""
    conn = _FlakyConnection(failures=1, message="disk I/O error")
    with pytest.raises(sqlite3.OperationalError, match="disk I/O error"):
        await bfp_db._switch_to_wal(conn)
    assert conn.attempts == 1


async def test_failed_connect_closes_the_connection(tmp_path, monkeypatch):
    """初始化中途失败必须把连接关掉。

    aiosqlite 每条连接都带一个**非 daemon** 工作线程：漏关它，进程就再也退不出去。
    systemd 里表现为「服务起不来、还挂着不走」，测试里表现为 pytest 跑完不退出。
    这里让迁移故意抛错，然后直接问那个连接对象「你被关了吗」——
    比数线程可靠：关掉之后那个线程也就自然退出了，而没关的话它会一直挂着。
    """
    db_path = tmp_path / "bfp.sqlite3"
    with sqlite3.connect(db_path) as seed:
        seed.executescript(LEGACY_SCHEMA)

    real_connect = aiosqlite.connect
    tracked: list[Any] = []

    async def tracking_connect(*args, **kwargs):
        conn = await real_connect(*args, **kwargs)
        tracked.append(conn)
        return conn

    monkeypatch.setattr(bfp_db.aiosqlite, "connect", tracking_connect)

    async def explode(conn):
        raise RuntimeError("迁移故意失败")

    monkeypatch.setattr(bfp_db, "_migrate", explode)
    db = Database(db_path)
    with pytest.raises(RuntimeError, match="迁移故意失败"):
        await db.connect()

    assert len(tracked) == 1
    # 关掉的连接再执行语句会报 "no active connection"，这就是「已关闭」的判据
    with pytest.raises(ValueError):
        await tracked[0].execute("SELECT 1")
    # 失败后 db 仍然处于「未连接」状态，close() 是安全的空操作
    await db.close()


def test_busy_timeout_is_set_before_switching_to_wal():
    """PRAGMA 的顺序是有语义的，别顺手调回来。

    切 WAL 要先拿一次排他锁，而 busy_timeout 默认是 0。顺序反过来时，只要有另一个
    进程正在写（bfp-ops、或还没退干净的上一个服务），这句就会立刻抛
    "database is locked" —— 是实测出来的：4 个进程同时连一个新库，失败的那个
    栈顶正是这条 PRAGMA。这一条只锁源码顺序：上面的并发用例覆盖行为，
    但要让它稳定复现"顺序错了"的场景得靠调度运气，不如直接把顺序钉住。
    """
    source = Path(bfp_db.__file__).read_text(encoding="utf-8")
    # 只看 connect() 里那段初始化：_switch_to_wal 的文档字符串里也提到过这个 PRAGMA，
    # 全文搜会搜到注释里去
    body = source[source.index("async def connect") : source.index("async def close")]
    assert body.index("PRAGMA busy_timeout=5000") < body.index("_switch_to_wal(conn)"), (
        "busy_timeout 必须排在切换 WAL 之前"
    )
