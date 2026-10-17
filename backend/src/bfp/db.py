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
}


async def _migrate(conn: aiosqlite.Connection) -> None:
    for table, columns in _ADDED_COLUMNS.items():
        async with conn.execute(f"PRAGMA table_info({table})") as cursor:
            existing = {row["name"] for row in await cursor.fetchall()}
        for name, sql_type in columns.items():
            if name not in existing:
                await conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {sql_type}")


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
        conn.row_factory = aiosqlite.Row
        # WAL：读不挡写、写不挡读；这也是崩溃后能恢复的前提
        await conn.execute("PRAGMA journal_mode=WAL")
        # 万一还有别的进程（比如 bfp-ops 命令行）在写，等 5 秒而不是立刻报错
        await conn.execute("PRAGMA busy_timeout=5000")
        # 级联删除靠它：删房间要顺手带走底图表、头像行、限流状态
        await conn.execute("PRAGMA foreign_keys=ON")
        await conn.execute("PRAGMA synchronous=NORMAL")
        await conn.executescript(SCHEMA_PATH.read_text(encoding="utf-8"))
        await _migrate(conn)
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
