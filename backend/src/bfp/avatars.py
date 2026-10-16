# BlockFace+ · 头像行的差量提交（唯一的写头像入口）
# Copyright 2026 Dainsleif · Apache License 2.0
#
# PATCH /api/rooms/{roomId}/avatars
# 入参：
#   {
#     updates: [{ id, layout?: {位置/大小/旋转/顺序/名字…}, skin?: PresetSkin,
#                 expectLayoutUpdatedAt?, expectSkinUpdatedAt? }],
#     adds:    [完整的一行头像记录],
#     deletes: [id]
#   }
# 出参：{ results: [{ id, ok, error?, skinUpdatedAt?, layoutUpdatedAt? }] }
#
# 三条铁律（与旧实现逐条对齐）：
#  1. 只写请求里真的提到的行 —— 没提到的行一个字节都不碰；
#  2. 行内按字段域写 —— layout 补丁只覆盖布局列，skin 只覆盖皮肤列，
#     两个版本戳各管各的，所以"有人在挪位置"和"有人在换皮肤"互不冲突；
#  3. 缺的键不动（不是"用默认值补齐"），所以前端可以只发改动的最小集合。
#
# 编辑者：只能换皮肤（layout 原样忽略、不报错；加/删头像 403）；管理员：三者皆可。
#
# 整段读写包在一个事务里：先读版本戳、再决定写不写、最后落地。
# 不包事务的话，两个并发请求会各自读到同一个旧戳，然后都判定"没冲突"——双方都赢，一方白写。

from __future__ import annotations

import json
from collections.abc import Sequence
from typing import Any

import aiosqlite
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from .errors import ApiError, json_response, password_of, read_json_body
from .normalize import (
    LAYER_ID_RE,
    is_record,
    normalize_avatar_record,
    normalize_layout_patch,
    normalize_skin_record,
)
from .rooms import (
    AVATAR_INSERT,
    avatar_insert_params,
    get_db,
    get_settings,
    require_room,
)
from .security import authenticate, now_ms

__all__ = ["router"]

router = APIRouter(prefix="/api/rooms", tags=["avatars"])

# 补丁键 → 数据库列名。"order" 是 SQL 关键字，落库叫 order_index
LAYOUT_COLUMNS = {
    "name": "name",
    "x": "x",
    "y": "y",
    "size": "size",
    "rotation": "rotation",
    "opacity": "opacity",
    "overlay": "overlay",
    "flipH": "flip_h",
    "visible": "visible",
    "order": "order_index",
}


def _js_id(raw: Any) -> str:
    """对齐 JS 的 String(item.id ?? '')：id 不是字符串时也要给出一个稳定的结果键"""
    if raw is None:
        return ""
    if isinstance(raw, bool):
        return "true" if raw else "false"
    if isinstance(raw, str):
        return raw
    if isinstance(raw, int):
        return str(raw)
    if isinstance(raw, float):
        return str(int(raw)) if raw.is_integer() else repr(raw)
    if isinstance(raw, (dict, list)):
        return "[object Object]"
    return str(raw)


def _is_number(value: Any) -> bool:
    """JS 的 typeof value === 'number'：bool 不算数字"""
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _sql_value(value: Any) -> Any:
    return int(value) if isinstance(value, bool) else value


def _dedupe(items: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    """同一个 id 在一次请求里出现多次时以最后一次为准，顺序保持首次出现的位置。

    Python 的 dict 就是这个语义（键已存在时只换值、不动位置），所以直接用它。
    """
    out: dict[str, dict[str, Any]] = {}
    for item in items:
        out[_js_id(item.get("id"))] = item
    return list(out.values())


async def _fetch_avatar(conn: aiosqlite.Connection, room_id: str, layer_id: str) -> aiosqlite.Row | None:
    cursor = await conn.execute(
        "SELECT * FROM avatars WHERE room_id = ? AND id = ?",
        (room_id, layer_id),
    )
    try:
        return await cursor.fetchone()
    finally:
        await cursor.close()


@router.patch("/{room_id}/avatars")
async def patch_avatars(request: Request, room_id: str) -> JSONResponse:
    settings = get_settings(request)
    db = get_db(request)
    meta, _base = await require_room(request, room_id)
    role = await authenticate(db, settings, meta, password_of(request))
    is_admin = role == "admin"

    body = await read_json_body(request, settings.max_json_body_bytes)
    if not is_record(body):
        raise ApiError(400, "请求体格式不对")

    raw_updates = body.get("updates") if isinstance(body.get("updates"), list) else []
    raw_adds = body.get("adds") if isinstance(body.get("adds"), list) else []
    raw_deletes = body.get("deletes") if isinstance(body.get("deletes"), list) else []

    if not is_admin and (raw_adds or raw_deletes):
        raise ApiError(403, "只有管理员能增加或删除头像")

    updates = _dedupe([item for item in raw_updates if is_record(item)])
    adds = _dedupe([item for item in raw_adds if is_record(item)])
    deletes = list(dict.fromkeys(item for item in raw_deletes if isinstance(item, str)))

    # 一次请求能提到的行数不会超过"房间最多几行"：超过就是有人在灌请求，不是正常用法
    for label, items in (("修改", updates), ("新增", adds), ("删除", deletes)):
        if len(items) > settings.max_layers:
            raise ApiError(400, f"一次提交的{label}条数超过一间房的上限（{settings.max_layers}）")

    if not updates and not adds and not deletes:
        return json_response({"results": []})

    now = now_ms()
    results: list[dict[str, Any]] = []

    async with db.transaction() as conn:
        # ---- 改：只读请求里提到的那些行，不扫全房 ----
        for update in updates:
            layer_id = _js_id(update.get("id"))
            if not LAYER_ID_RE.match(layer_id):
                results.append({"id": layer_id, "ok": False, "error": "invalid"})
                continue
            row = await _fetch_avatar(conn, meta["room_id"], layer_id)
            if row is None:
                results.append({"id": layer_id, "ok": False, "error": "not-found"})
                continue

            # 编辑者送来的 layout 一律不看（不是报错，是根本不写）
            layout: dict[str, Any] | None = None
            if is_admin and "layout" in update:
                layout = normalize_layout_patch(update["layout"], settings)
                if layout is None:
                    results.append({"id": layer_id, "ok": False, "error": "invalid-layout"})
                    continue
            has_layout = bool(layout)

            skin: dict[str, Any] | None = None
            if "skin" in update:
                # 注意：显式的 null 也会走到这里并被判成 invalid-skin —— 与旧实现一致
                skin = normalize_skin_record(update["skin"], settings)
                if skin is None:
                    results.append({"id": layer_id, "ok": False, "error": "invalid-skin"})
                    continue
            has_skin = skin is not None

            if not has_layout and not has_skin:
                # 什么也没改：当成功处理，且不写盘（不推进版本戳，别人的并发凭证不受影响）
                results.append(
                    {
                        "id": layer_id,
                        "ok": True,
                        "skinUpdatedAt": row["skin_updated_at"],
                        "layoutUpdatedAt": row["layout_updated_at"],
                    }
                )
                continue

            expect_layout = update.get("expectLayoutUpdatedAt")
            if has_layout and _is_number(expect_layout) and expect_layout != row["layout_updated_at"]:
                results.append({"id": layer_id, "ok": False, "error": "conflict"})
                continue
            expect_skin = update.get("expectSkinUpdatedAt")
            if has_skin and _is_number(expect_skin) and expect_skin != row["skin_updated_at"]:
                results.append({"id": layer_id, "ok": False, "error": "conflict"})
                continue

            skin_updated_at = row["skin_updated_at"]
            layout_updated_at = row["layout_updated_at"]
            if has_layout and layout:
                assignments = ", ".join(f"{LAYOUT_COLUMNS[key]} = ?" for key in layout)
                values = [_sql_value(value) for value in layout.values()]
                layout_updated_at = now
                await conn.execute(
                    f"UPDATE avatars SET {assignments}, layout_updated_at = ? WHERE room_id = ? AND id = ?",
                    [*values, now, meta["room_id"], layer_id],
                )
            if has_skin:
                skin_updated_at = now
                await conn.execute(
                    "UPDATE avatars SET skin_json = ?, skin_updated_at = ? WHERE room_id = ? AND id = ?",
                    (json.dumps(skin, ensure_ascii=False), now, meta["room_id"], layer_id),
                )
            results.append(
                {
                    "id": layer_id,
                    "ok": True,
                    "skinUpdatedAt": skin_updated_at,
                    "layoutUpdatedAt": layout_updated_at,
                }
            )

        # ---- 增：新的一行，id 已被占用就报错，绝不悄悄覆盖别人的行 ----
        for index, add in enumerate(adds):
            layer_id = _js_id(add.get("id"))
            if not LAYER_ID_RE.match(layer_id):
                results.append({"id": layer_id, "ok": False, "error": "invalid"})
                continue
            if await _fetch_avatar(conn, meta["room_id"], layer_id) is not None:
                results.append({"id": layer_id, "ok": False, "error": "exists"})
                continue
            record = normalize_avatar_record(add, index, settings)
            if record is None:
                results.append({"id": layer_id, "ok": False, "error": "invalid"})
                continue
            await conn.execute(AVATAR_INSERT, avatar_insert_params(meta["room_id"], record, now))
            results.append({"id": layer_id, "ok": True, "skinUpdatedAt": now, "layoutUpdatedAt": now})

        # ---- 删：管理员说了算，不跟版本戳较劲（删不存在的行也当成功，重复提交不会炸）----
        # 放在所有写入之后落地：同一个 id 既在 updates 又在 deletes 时，
        # 结果必须是确定的"删掉"，不能靠事务里语句的先后去赌
        for layer_id in deletes:
            if not LAYER_ID_RE.match(layer_id):
                results.append({"id": layer_id, "ok": False, "error": "invalid"})
                continue
            await conn.execute(
                "DELETE FROM avatars WHERE room_id = ? AND id = ?",
                (meta["room_id"], layer_id),
            )
            results.append({"id": layer_id, "ok": True})

    return json_response({"results": results})
