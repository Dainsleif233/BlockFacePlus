# BlockFace+ · 房间清理（后台清扫 + 删除房间）
# Copyright 2026 Dainsleif · Apache License 2.0
#
# 三类垃圾：
#   1. 过期房间（expiresAt 已过）—— 惰性删除在每次读取时就地处理，后台再兜一遍；
#   2. 草稿房（建了房一直没传底图）—— 没人会再回来，超过 BF_DRAFT_TTL_SECONDS 就清；
#   3. 上传残片（进程被 kill 时留下的 .upload 临时文件）—— 跟房间一起走。
#
# 为什么要有后台任务：惰性删除只在"有人访问那间房"时生效。一间再没人碰的过期房间
# 会一直占着底图字节，而 VPS 的磁盘是我们自己掏钱的。

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass

from .config import Settings
from .db import Database
from .security import now_ms
from .storage import delete_room_files

__all__ = ["SweepResult", "delete_room", "sweep_loop", "sweep_once", "sweep_preview"]

log = logging.getLogger("bfp.sweep")


@dataclass(frozen=True, slots=True)
class SweepResult:
    expired: int = 0
    drafts: int = 0
    deleted: int = 0

    def __str__(self) -> str:
        return f"删除房间 {self.deleted} 间（过期 {self.expired}，超时草稿 {self.drafts}）"


async def delete_room(db: Database, settings: Settings, room_id: str) -> bool:
    """物理清空一间房：先清库里的行（级联带走底图表/头像行/限流状态），再清盘上的字节。

    顺序不能反：先删文件而库行还在的话，那间房会变成"打得开但底图永远 404"的半死状态；
    反过来最多留下几个没人引用的孤儿文件，下次清扫顺手也能扫掉。
    """
    async with db.transaction() as conn:
        cursor = await conn.execute("DELETE FROM rooms WHERE room_id = ?", (room_id,))
        deleted = cursor.rowcount > 0
        await cursor.close()
    await asyncio.to_thread(delete_room_files, settings, room_id)
    return deleted


async def _collect(db: Database, settings: Settings, moment: int) -> tuple[list[str], list[str]]:
    """捞出这一轮该清的房间号：(过期, 超时草稿)。sweep_once 与 sweep_preview 共用同一套判据。"""
    expired_rows = await db.fetchall("SELECT room_id FROM rooms WHERE expires_at < ?", (moment,))
    draft_rows = await db.fetchall(
        "SELECT r.room_id AS room_id FROM rooms r JOIN room_base b ON b.room_id = r.room_id "
        "WHERE b.status = 'draft' AND r.created_at < ?",
        (moment - settings.draft_ttl_seconds * 1000,),
    )
    return [row["room_id"] for row in expired_rows], [row["room_id"] for row in draft_rows]


async def sweep_preview(db: Database, settings: Settings, now: int | None = None) -> SweepResult:
    """只统计不删除：bfp-ops sweep --dry-run 用，避免"看一眼会删什么"这件事本身有副作用"""
    moment = now_ms() if now is None else now
    expired, drafts = await _collect(db, settings, moment)
    return SweepResult(expired=len(expired), drafts=len(drafts), deleted=0)


async def sweep_once(db: Database, settings: Settings, now: int | None = None) -> SweepResult:
    """跑一轮清扫，返回这一轮的结果（bfp-ops sweep 也用它，保证命令行和后台口径一致）"""
    moment = now_ms() if now is None else now
    expired, drafts = await _collect(db, settings, moment)
    # 同一间房既过期又是草稿时只删一次（dict.fromkeys 保序去重）
    deleted = 0
    for room_id in dict.fromkeys(expired + drafts):
        try:
            if await delete_room(db, settings, room_id):
                deleted += 1
        except Exception:  # 一间房删失败不该让整轮清扫停摆
            log.warning("清扫房间 %s 失败", room_id, exc_info=True)
    if deleted:
        log.info("清扫完成：%s", SweepResult(len(expired), len(drafts), deleted))
    return SweepResult(expired=len(expired), drafts=len(drafts), deleted=deleted)


async def sweep_loop(db: Database, settings: Settings) -> None:
    """后台清扫任务：由 lifespan 起、由 lifespan 优雅取消。

    启动先扫一轮（服务停机期间攒下的过期房间不用等一个周期），之后按间隔轮询。
    BF_SWEEP_INTERVAL_SECONDS=0 表示关掉后台清扫，此时只能手动 bfp-ops sweep。
    """
    interval = settings.sweep_interval_seconds
    if interval <= 0:
        log.info("BF_SWEEP_INTERVAL_SECONDS=0，后台清扫已关闭")
        return
    while True:
        try:
            await sweep_once(db, settings)
        except asyncio.CancelledError:
            raise
        except Exception:  # 清扫失败不能把整个服务带下去
            log.warning("清扫出错，等下一个周期再试", exc_info=True)
        await asyncio.sleep(interval)
