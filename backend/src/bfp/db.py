# BlockFace+ · SQLite 访问层（aiosqlite 单连接 + WAL + 写锁）
# Copyright 2026 Dainsleif · Apache License 2.0
#
# 为什么是单连接：这个服务的写量很小（一间房几十到几千行，一次提交只动被提到的行），
# 单连接把"并发写"这件事从根上消掉——不需要重试、不需要关心 SQLITE_BUSY。
# 读走同一个连接：aiosqlite 内部有独立线程串行化所有语句，一次 execute 一个新 cursor，
# 所以并发读是安全的（不会互相踩 cursor）。
#
# 唯一需要小心的是"读-改-写"序列：比如 PATCH 头像要先读版本戳再决定写不写。
# 这类操作必须整个包在 transaction() 里，写锁保证同一时刻只有一个这样的序列在跑。

from __future__ import annotations

import asyncio
import sqlite3
from collections.abc import AsyncIterator, Sequence
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import aiosqlite

__all__ = ["SCHEMA_PATH", "Database"]

SCHEMA_PATH = Path(__file__).resolve().parent / "schema.sql"


# 旧库升级：schema.sql 里的 CREATE TABLE IF NOT EXISTS 对**已存在**的表不会生效，
# 所以新增列必须在这里补一次 ALTER TABLE，否则升级后第一次查 preview_* 就是
# "no such column"，整个服务起不来。只加列、不改不删，向前兼容。
_ADDED_COLUMNS: dict[str, dict[str, str]] = {
    "room_base": {
        "preview_ext": "TEXT",
        "preview_type": "TEXT",
        "preview_width": "INTEGER",
        "preview_height": "INTEGER",
    },
    # 外观域（帽子层/翻转）原来和布局共用一个版本戳，旧行没有这一列。
    # 补成 0 = 「从未推进过外观」，GET 原样返回，客户端据此把外观基线放在 0 上。
    "avatars": {"appearance_updated_at": "INTEGER NOT NULL DEFAULT 0"},
}


async def _switch_to_wal(conn: aiosqlite.Connection) -> None:
    """把日志模式切到 WAL，遇到锁竞争时退避重试。

    为什么不能只靠 busy_timeout：这个 PRAGMA 在"库当前还不是 WAL"时要拿排他锁，
    而这条路径**不调用 busy handler**，别人短暂占锁定它就直接抛 SQLITE_BUSY。
    典型场景是新装：服务与 bfp-ops 同时启动，两边都还没有 WAL 标记。
    重试总时长与 busy_timeout 一致（5 秒），超过就照常抛出，不无限等。
    """
    deadline = asyncio.get_running_loop().time() + 5.0
    delay = 0.02
    while True:
        try:
            await conn.execute("PRAGMA journal_mode=WAL")
            return
        except sqlite3.OperationalError as exc:
            if "locked" not in str(exc) and "busy" not in str(exc):
                raise
            if asyncio.get_running_loop().time() >= deadline:
                raise
            await asyncio.sleep(delay)
            delay = min(delay * 2, 0.4)


async def _migrate(conn: aiosqlite.Connection) -> None:
    """把旧库补到当前结构。

    整段必须包在 BEGIN IMMEDIATE 里，不能"先 PRAGMA 查缺哪列、再逐条 ALTER"：
    这个服务和一个 bfp-ops 是**两个进程**，完全可能同时启动。并发时两边都会查到
    "缺 preview_ext"，然后两边都去 ALTER —— 后拿到锁的那个直接抛
    duplicate column name，启动失败。拿写锁之后再查一次，才能让「我看到缺列」
    和「我动手补列」之间没有缝隙；第二个进程拿到锁时看到列已经有了，就什么都不做。
    """
    await conn.execute("BEGIN IMMEDIATE")
    try:
        for table, columns in _ADDED_COLUMNS.items():
            async with conn.execute(f"PRAGMA table_info({table})") as cursor:
                existing = {row["name"] for row in await cursor.fetchall()}
            for name, sql_type in columns.items():
                if name not in existing:
                    try:
                        await conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {sql_type}")
                    except sqlite3.OperationalError as exc:
                        # 理论上有了写锁就不会走到这里；留一条是因为"旧版本的
                        # 另一个进程"不遵这个约定，而重复列等价于目标已达成。
                        if "duplicate column name" not in str(exc):
                            raise
    except BaseException:
        await conn.execute("ROLLBACK")
        raise
    await conn.execute("COMMIT")


class Database:
    """一个进程一个实例，挂在 app.state.db 上"""

    def __init__(self, path: Path | str) -> None:
        self.path = Path(path)
        self._conn: aiosqlite.Connection | None = None
        self._write_lock = asyncio.Lock()

    @property
    def conn(self) -> aiosqlite.Connection:
        if self._conn is None:
            raise RuntimeError("数据库还没连上：请在 lifespan 里 await db.connect()")
        return self._conn

    async def connect(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        # isolation_level=None → 自动提交：写语句立刻落地，需要原子性的地方用显式 BEGIN IMMEDIATE
        conn = await aiosqlite.connect(self.path, isolation_level=None)
        # 从这里往下任何一步失败（最可能是迁移），都必须把连接关掉再抛：
        # aiosqlite 每条连接背后有一个**非 daemon** 工作线程，漏关它，进程就再也退不出去 ——
        # systemd 里表现为"服务启动失败还挂着不走"，测试里表现为 pytest 跑完不退出。
        # 开头这几句单独 try 是因为 self._conn 要等全部初始化成功才赋值，close() 够不到它。
        try:
            conn.row_factory = aiosqlite.Row
            # busy_timeout 必须**排在 journal_mode 前面**：切 WAL 本身要短暂拿一次排他锁，
            # 而 timeout 的默认值是 0 —— 碰上另一个进程正在写（bfp-ops、或上一轮还没退干净的
            # 服务）就会立刻抛 "database is locked"，整个服务起不来。这一点是实测出来的：
            # 4 个进程同时连一个全新的库，失败的那一个栈顶正是这条 PRAGMA。
            await conn.execute("PRAGMA busy_timeout=5000")
            # WAL：读不挡写、写不挡读；这也是崩溃后能恢复的前提。
            # 切 WAL 与普通写不一样：库还是 rollback journal 时，这个 PRAGMA 要拿排他锁，
            # 而且**不走 busy handler** —— 别人占着锁时会直接返回 SQLITE_BUSY，busy_timeout
            # 帮不上忙（实测：库未开 WAL 时 6 个连接并发切换，9/24 次直接失败）。
            # 所以这里自己退避重试，而不是指望 timeout。
            await _switch_to_wal(conn)
            # 级联删除靠它：删房间要顺手带走底图表、头像行、限流状态
            await conn.execute("PRAGMA foreign_keys=ON")
            await conn.execute("PRAGMA synchronous=NORMAL")
            await conn.executescript(SCHEMA_PATH.read_text(encoding="utf-8"))
            await _migrate(conn)
        except BaseException:
            await conn.close()
            raise
        self._conn = conn

    async def close(self) -> None:
        if self._conn is not None:
            await self._conn.close()
            self._conn = None

    @asynccontextmanager
    async def transaction(self) -> AsyncIterator[aiosqlite.Connection]:
        """所有写路径的唯一入口：拿写锁 + BEGIN IMMEDIATE，异常回滚。

        BEGIN IMMEDIATE（而不是 BEGIN）是为了立刻拿到写锁：如果并发的是另一个进程
        （bfp-ops sweep），延迟到第一条写语句才拿锁的话，读到旧值再写就会丢更新。
        """
        async with self._write_lock:
            conn = self.conn
            await conn.execute("BEGIN IMMEDIATE")
            try:
                yield conn
            except BaseException:
                await conn.execute("ROLLBACK")
                raise
            await conn.execute("COMMIT")

    async def fetchone(self, sql: str, params: Sequence[Any] = ()) -> aiosqlite.Row | None:
        async with self.conn.execute(sql, params) as cursor:
            return await cursor.fetchone()

    async def fetchall(self, sql: str, params: Sequence[Any] = ()) -> list[aiosqlite.Row]:
        async with self.conn.execute(sql, params) as cursor:
            return list(await cursor.fetchall())

    # 刻意不提供"顺手执行一条写语句"的便捷方法：那样很容易在事务之外写库，
    # 与 read-then-write 的序列交错。所有写都必须显式走 transaction()。
