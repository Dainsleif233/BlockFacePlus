# BlockFace+ · 旧库升级
# Copyright 2026 Dainsleif · Apache License 2.0
#
# schema.sql 里全是 CREATE TABLE IF NOT EXISTS：对**已存在**的表，新增列不会自己出现。
# 线上库是带着数据升级的，`db.connect()` 必须在不丢数据的前提下把新列补上，
# 否则升级后第一条查询就是 "no such column: preview_ext"，整个服务起不来。

from __future__ import annotations

import sqlite3

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
