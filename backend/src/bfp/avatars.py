# BlockFace+ · 头像行的差量提交（唯一的写头像入口）
# Copyright 2026 Dainsleif · Apache License 2.0
#
# PATCH /api/rooms/{roomId}/avatars
# 入参：
#   {
#     updates: [{ id, layout?: {位置/大小/旋转/顺序/名字…}, appearance?: {overlay, flipH},
#                 skin?: PresetSkin, expectLayoutUpdatedAt?, expectAppearanceUpdatedAt?,
#                 expectSkinUpdatedAt? }],
#     adds:    [完整的一行头像记录],
#     deletes: [id]
#   }
# 出参：{ results: [{ id, ok, error?, skinUpdatedAt?, layoutUpdatedAt?, appearanceUpdatedAt? }] }
#
# 三条铁律（与旧实现逐条对齐）：
#  1. 只写请求里真的提到的行 —— 没提到的行一个字节都不碰；
#  2. 行内按字段域写 —— layout / appearance / skin 各管各的列与版本戳，
#     所以"有人在挪位置""有人在切帽子层""有人在换皮肤"三件事互不冲突；
#  3. 缺的键不动（不是"用默认值补齐"），所以前端可以只发改动的最小集合。
#
# 编辑者：能换皮肤、能改外观（帽子层 / 水平翻转）；layout 原样忽略、不报错；加/删头像 403。
# 管理员：三者皆可。旧客户端把 overlay/flipH 塞在 layout 里发过来时管理员的这条仍然生效，
# 只是它推进的是外观域的戳，不是布局的。
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
    normalize_appearance_patch,
    normalize_avatar_record,
    normalize_layout_patch,
    normalize_skin_record,
    split_layout_domains,
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

# 补丁键 → 数据库列名。"order" 是 SQL 关键字，落库叫 order_index。
# 外观域单列：这两个键不再跟布局共用一个版本戳，否则编辑者一旦不能改布局，
# 帽子层和翻转也跟着冻住 —— 而它们跟位置/尺寸没有任何关系。
LAYOUT_COLUMNS = {
    "name": "name",
    "x": "x",
    "y": "y",
    "size": "size",
    "rotation": "rotation",
    "opacity": "opacity",
    "visible": "visible",
    "order": "order_index",
}
APPEARANCE_COLUMNS = {
    "overlay": "overlay",
    "flipH": "flip_h",
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


def _ok_result(
    layer_id: str,
    skin_updated_at: int,
    layout_updated_at: int,
    appearance_updated_at: int,
) -> dict[str, Any]:
    """一条「成功」结果的统一形状。

    三个域各回各的版本戳，客户端拿它当同域名下一次写入的并发凭证；
    空操作、改、增三条分支的返回结构必须一致，否则前端要按分支分别处理。
    """
    return {
        "id": layer_id,
        "ok": True,
        "skinUpdatedAt": skin_updated_at,
        "layoutUpdatedAt": layout_updated_at,
        "appearanceUpdatedAt": appearance_updated_at,
    }


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


async def _count_avatars(
    conn: aiosqlite.Connection,
    room_id: str,
    only_ids: Sequence[str] | None = None,
) -> int:
    """数一数这间房有几行；给了 only_ids 就只数这些 id 里真实存在的"""
    sql = "SELECT COUNT(*) AS n FROM avatars WHERE room_id = ?"
    params: list[Any] = [room_id]
    if only_ids:
        sql += " AND id IN (" + ", ".join("?" * len(only_ids)) + ")"
        params.extend(only_ids)
    cursor = await conn.execute(sql, params)
    try:
        row = await cursor.fetchone()
    finally:
        await cursor.close()
    return int(row["n"]) if row is not None else 0


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

    if not updates and not adds and not deletes:
        return json_response({"results": []})

    results: list[dict[str, Any]] = []

    async with db.transaction() as conn:
        # 版本戳必须严格递增；毫秒时钟在连续请求中可能不前进，导致旧凭证被误放行。
        # 三个域的戳都要纳入最大值，少一列就会出现「外观写了个比旧戳还小的 now」，
        # 于是下一条并发请求拿旧凭证照样放行。
        cursor = await conn.execute(
            "SELECT MAX(latest) AS latest FROM ("
            "SELECT skin_updated_at AS latest FROM avatars WHERE room_id = ? "
            "UNION ALL SELECT layout_updated_at FROM avatars WHERE room_id = ? "
            "UNION ALL SELECT appearance_updated_at FROM avatars WHERE room_id = ?"
            ")",
            (meta["room_id"], meta["room_id"], meta["room_id"]),
        )
        try:
            latest_row = await cursor.fetchone()
        finally:
            await cursor.close()
        latest = int(latest_row["latest"]) if latest_row and latest_row["latest"] is not None else 0
        now = max(now_ms(), latest + 1)
        # 行数上限是「一间房」的，不是「一次请求」的。只按单次请求判等于没有上限：
        # 分四十次 adds 就能把一间房堆到 512 行以上，而 GET /api/rooms/{id} 是一次性
        # 全量返回的 —— 房间越界之后，任何一次进房都要把整间房读进内存。
        # 判在事务里：两个并发的 adds 不会各自读到同一个旧行数，然后都判定「还没满」。
        if adds:
            total = await _count_avatars(conn, meta["room_id"])
            # 同一批里的 deletes 会腾出位置，只数真实存在的那些删：否则「删一个不存在的 id + 加一个」
            # 就能一直绕开上限（服务端对不存在的行也返回成功，那是幂等，不是允许白占位）。
            freed = await _count_avatars(conn, meta["room_id"], deletes) if deletes else 0
            if total - freed + len(adds) > settings.max_layers:
                raise ApiError(
                    400,
                    f"这间房已经有 {total} 个头像，再加 {len(adds)} 个会超过一间房的上限"
                    f"（{settings.max_layers}）：先删几个再试",
                )

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
            appearance: dict[str, Any] = {}
            if is_admin and "layout" in update:
                parsed = normalize_layout_patch(update["layout"], settings)
                if parsed is None:
                    results.append({"id": layer_id, "ok": False, "error": "invalid-layout"})
                    continue
                # 旧客户端会把 overlay/flipH 塞在 layout 里：那两个键归外观域，
                # 推进的也是 appearance_updated_at —— 布局戳不该为一次翻转动弹。
                layout, legacy_appearance = split_layout_domains(parsed)
                appearance.update(legacy_appearance)
            if "appearance" in update:
                # 显式 appearance 写在 layout 之后：同一条 update 两个地方都带了同一个键时，
                # 以意图更明确的 appearance 为准，而不是看字典的插入顺序。
                parsed = normalize_appearance_patch(update["appearance"])
                if parsed is None:
                    results.append({"id": layer_id, "ok": False, "error": "invalid-appearance"})
                    continue
                appearance.update(parsed)
            has_layout = bool(layout)
            has_appearance = bool(appearance)

            skin: dict[str, Any] | None = None
            if "skin" in update:
                # 注意：显式的 null 也会走到这里并被判成 invalid-skin —— 与旧实现一致
                skin = normalize_skin_record(update["skin"], settings)
                if skin is None:
                    results.append({"id": layer_id, "ok": False, "error": "invalid-skin"})
                    continue
            has_skin = skin is not None

            if not has_layout and not has_appearance and not has_skin:
                # 什么也没改：当成功处理，且不写盘（不推进版本戳，别人的并发凭证不受影响）
                results.append(
                    _ok_result(
                        layer_id,
                        row["skin_updated_at"],
                        row["layout_updated_at"],
                        row["appearance_updated_at"] or 0,
                    )
                )
                continue

            expect_layout = update.get("expectLayoutUpdatedAt")
            if has_layout and _is_number(expect_layout) and expect_layout != row["layout_updated_at"]:
                results.append({"id": layer_id, "ok": False, "error": "conflict"})
                continue
            # 外观有自己的一把凭证：外观推进过之后，拿旧外观戳来改布局不该被判成冲突，
            # 反过来也一样 —— 两个域就这么各认各的。
            expect_appearance = update.get("expectAppearanceUpdatedAt")
            if (
                has_appearance
                and _is_number(expect_appearance)
                and expect_appearance != (row["appearance_updated_at"] or 0)
            ):
                results.append({"id": layer_id, "ok": False, "error": "conflict"})
                continue
            expect_skin = update.get("expectSkinUpdatedAt")
            if has_skin and _is_number(expect_skin) and expect_skin != row["skin_updated_at"]:
                results.append({"id": layer_id, "ok": False, "error": "conflict"})
                continue

            skin_updated_at = row["skin_updated_at"]
            layout_updated_at = row["layout_updated_at"]
            appearance_updated_at = row["appearance_updated_at"] or 0
            if has_layout and layout:
                assignments = ", ".join(f"{LAYOUT_COLUMNS[key]} = ?" for key in layout)
                values = [_sql_value(value) for value in layout.values()]
                layout_updated_at = now
                await conn.execute(
                    f"UPDATE avatars SET {assignments}, layout_updated_at = ? WHERE room_id = ? AND id = ?",
                    [*values, now, meta["room_id"], layer_id],
                )
            if has_appearance:
                # 单独一条 UPDATE：外观改动绝不推进 layout_updated_at，两者互不牵连
                assignments = ", ".join(f"{APPEARANCE_COLUMNS[key]} = ?" for key in appearance)
                values = [_sql_value(value) for value in appearance.values()]
                appearance_updated_at = now
                await conn.execute(
                    f"UPDATE avatars SET {assignments}, appearance_updated_at = ? "
                    "WHERE room_id = ? AND id = ?",
                    [*values, now, meta["room_id"], layer_id],
                )
            if has_skin:
                skin_updated_at = now
                await conn.execute(
                    "UPDATE avatars SET skin_json = ?, skin_updated_at = ? WHERE room_id = ? AND id = ?",
                    (json.dumps(skin, ensure_ascii=False), now, meta["room_id"], layer_id),
                )
            results.append(
                _ok_result(layer_id, skin_updated_at, layout_updated_at, appearance_updated_at)
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
            results.append(_ok_result(layer_id, now, now, now))

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
