# BlockFace+ · 房间的创建 / 读取 / 删除
# Copyright 2026 Dainsleif · Apache License 2.0
#
# POST   /api/rooms              建房（草稿态）
# GET    /api/rooms/{roomId}     进房：房间信息 + 全部头像 + 角色
# DELETE /api/rooms/{roomId}     仅管理员：物理删除
#
# 改头像走 PATCH /api/rooms/{roomId}/avatars，底图走 /api/rooms/{roomId}/base。
# 这个文件里的 GET 只读、不写任何一行 —— 所以它永远不会抹掉别人刚保存的东西。
#
# require_room / get_db / get_settings 也在这里：它是"拿到一间能用的房"的唯一入口，
# 四个路由模块全都从这儿走，房间号校验、过期处理只需要写一遍。

from __future__ import annotations

import asyncio
import json
import math
from typing import Any

import aiosqlite
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from .config import Settings
from .db import Database
from .errors import (
    ROOM_EXPIRED,
    ROOM_NOT_FOUND,
    ApiError,
    json_response,
    password_of,
    read_json_body,
)
from .normalize import (
    ext_for_content_type,
    is_record,
    normalize_avatar_record,
    normalize_base_name,
    normalize_doc_size,
    normalize_room_id,
    round_js,
    to_number,
)
from .security import (
    ADMIN_PASSWORD_LENGTH,
    EDIT_PASSWORD_LENGTH,
    authenticate,
    generate_admin_password,
    generate_edit_password,
    generate_room_id,
    hash_password,
    now_ms,
)
from .sweep import delete_room

__all__ = [
    "AVATAR_INSERT",
    "avatar_insert_params",
    "get_db",
    "get_settings",
    "public_room",
    "require_room",
    "room_avatar",
    "router",
]

router = APIRouter(prefix="/api/rooms", tags=["rooms"])

DAY_MS = 86_400_000

AVATAR_INSERT = (
    "INSERT INTO avatars (room_id, id, name, x, y, size, rotation, opacity, overlay, flip_h, visible, "
    "order_index, skin_json, skin_updated_at, layout_updated_at) "
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
)


def get_settings(request: Request) -> Settings:
    return request.app.state.settings


def get_db(request: Request) -> Database:
    return request.app.state.db


async def require_room(request: Request, room_id: str) -> tuple[aiosqlite.Row, aiosqlite.Row | None]:
    """读取房间身份并做存在性 / 过期检查；不过关直接抛 ApiError。

    房间号是从 URL 里抠出来的、要直接拼进 SQL 与文件路径，所以第一步先按生成时的字符集验一遍。
    放过 '../'、空字符这类东西，拼出来的就是路径穿越；未鉴权就能反复触发。
    校验放在这里，四个入口（读 / 改头像 / 删 / 底图）自动全覆盖。
    """
    settings = get_settings(request)
    db = get_db(request)
    normalized = normalize_room_id(room_id)
    if normalized is None:
        raise ApiError(404, ROOM_NOT_FOUND)
    meta = await db.fetchone("SELECT * FROM rooms WHERE room_id = ?", (normalized,))
    if meta is None:
        raise ApiError(404, ROOM_NOT_FOUND)
    if now_ms() > meta["expires_at"]:
        # 过期就地删房：这类房间不会再被访问，不删就一直占着底图字节
        await delete_room(db, settings, normalized)
        raise ApiError(410, ROOM_EXPIRED)
    base = await db.fetchone("SELECT * FROM room_base WHERE room_id = ?", (normalized,))
    return meta, base


def public_room(meta: aiosqlite.Row, base: aiosqlite.Row | None) -> dict[str, Any]:
    """房间对外的样子：身份来自 rooms，画布尺寸与底图来自 room_base。

    画布尺寸就是底图尺寸 —— 只有这一份真相，不需要也别再存第二份。
    """
    ready = base is not None and base["status"] == "ready"
    return {
        "roomId": meta["room_id"],
        "doc": {
            "width": base["width"] if base is not None else 0,
            "height": base["height"] if base is not None else 0,
        },
        "baseImage": (
            {
                "name": base["name"],
                "type": base["type"],
                "width": base["width"],
                "height": base["height"],
            }
            if ready
            else None
        ),
        "createdAt": meta["created_at"],
        "expiresAt": meta["expires_at"],
        "status": "ready" if ready else "draft",
    }


def room_avatar(row: aiosqlite.Row) -> dict[str, Any]:
    """数据库一行 → 契约里的 RoomAvatarRecord（camelCase，布尔还原成真布尔）"""
    return {
        "id": row["id"],
        "name": row["name"],
        "x": row["x"],
        "y": row["y"],
        "size": row["size"],
        "rotation": row["rotation"],
        "opacity": row["opacity"],
        "overlay": bool(row["overlay"]),
        "flipH": bool(row["flip_h"]),
        "visible": bool(row["visible"]),
        "order": row["order_index"],
        "skin": json.loads(row["skin_json"]) if row["skin_json"] else None,
        "skinUpdatedAt": row["skin_updated_at"],
        "layoutUpdatedAt": row["layout_updated_at"],
    }


def avatar_insert_params(room_id: str, record: dict[str, Any], now: int) -> tuple[Any, ...]:
    """新建一行头像的绑定参数（建房与 PATCH 的 adds 共用，保证两条路落库口径一致）"""
    return (
        room_id,
        record["id"],
        record["name"],
        record["x"],
        record["y"],
        record["size"],
        record["rotation"],
        record["opacity"],
        int(record["overlay"]),
        int(record["flipH"]),
        int(record["visible"]),
        record["order"],
        json.dumps(record["skin"], ensure_ascii=False) if record["skin"] is not None else None,
        now,
        now,
    )


@router.post("", status_code=201)
async def create_room(request: Request) -> JSONResponse:
    settings = get_settings(request)
    db = get_db(request)
    body = await read_json_body(request, settings.max_json_body_bytes)
    if not is_record(body):
        raise ApiError(400, "请求体格式不对")

    base_image = body.get("baseImage")
    if not is_record(base_image):
        raise ApiError(400, "缺少底图信息")
    ext = ext_for_content_type(base_image.get("type"))
    if ext is None:
        raise ApiError(400, "底图只支持 PNG / JPG / WebP / GIF")
    width = normalize_doc_size(base_image.get("width"), settings)
    height = normalize_doc_size(base_image.get("height"), settings)
    if width is None or height is None:
        raise ApiError(400, "底图尺寸不合法")

    raw_layers = body.get("layers") if isinstance(body.get("layers"), list) else []
    if not raw_layers:
        raise ApiError(400, "至少要先摆一个头像再发布")
    if len(raw_layers) > settings.max_layers:
        raise ApiError(400, f"头像最多 {settings.max_layers} 个")
    seen: set[str] = set()
    layers: list[dict[str, Any]] = []
    for index, item in enumerate(raw_layers):
        record = normalize_avatar_record(item, index, settings)
        if record is None:
            raise ApiError(400, f"第 {index + 1} 个头像的数据不合法")
        if record["id"] in seen:
            raise ApiError(400, "头像 id 重复")
        seen.add(record["id"])
        layers.append(record)

    days = to_number(body.get("expiresDays"))
    if not math.isfinite(days):
        raise ApiError(400, f"过期天数只能在 1 到 {settings.max_expiry_days} 天之间")
    days = round_js(days)
    if days < 1 or days > settings.max_expiry_days:
        raise ApiError(400, f"过期天数只能在 1 到 {settings.max_expiry_days} 天之间")

    room_id = generate_room_id()
    now = now_ms()
    # 毫秒整数时间戳，与前端 Date.now() 同一口径；契约 4 节里上限放宽到 3650 天
    expires_at = now + days * DAY_MS
    edit_password = generate_edit_password()
    admin_password = generate_admin_password()
    # scrypt 是 CPU 活，两次派生丢进线程池并发跑，别在事件循环里排两遍
    edit_hash, admin_hash = await asyncio.gather(
        hash_password(edit_password),
        hash_password(admin_password),
    )

    async with db.transaction() as conn:
        await conn.execute(
            "INSERT INTO rooms (room_id, created_at, expires_at, edit_password_hash, admin_password_hash, "
            "edit_password_length, admin_password_length) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (room_id, now, expires_at, edit_hash, admin_hash, EDIT_PASSWORD_LENGTH, ADMIN_PASSWORD_LENGTH),
        )
        # 草稿态：尺寸与名字先按建房请求记下，等 POST /base 把字节传上来才变 ready
        await conn.execute(
            "INSERT INTO room_base (room_id, ext, type, name, width, height, status, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, 'draft', ?)",
            (room_id, ext, str(base_image["type"]).lower(), normalize_base_name(base_image.get("name")), width, height, now),
        )
        await conn.executemany(AVATAR_INSERT, [avatar_insert_params(room_id, record, now) for record in layers])

    # 密码只在本响应里出现这一次，之后任何接口都不回传
    return json_response(
        {
            "roomId": room_id,
            "editPassword": edit_password,
            "adminPassword": admin_password,
            "expiresAt": expires_at,
        },
        201,
    )


@router.get("/{room_id}")
async def get_room(request: Request, room_id: str) -> JSONResponse:
    settings = get_settings(request)
    db = get_db(request)
    meta, base = await require_room(request, room_id)
    role = await authenticate(db, settings, meta, password_of(request))
    rows = await db.fetchall(
        "SELECT * FROM avatars WHERE room_id = ? ORDER BY order_index ASC, id ASC",
        (meta["room_id"],),
    )
    return json_response(
        {
            "room": public_room(meta, base),
            "avatars": [room_avatar(row) for row in rows],
            "role": role,
        }
    )


@router.delete("/{room_id}")
async def delete_room_endpoint(request: Request, room_id: str) -> JSONResponse:
    settings = get_settings(request)
    db = get_db(request)
    meta, _base = await require_room(request, room_id)
    role = await authenticate(db, settings, meta, password_of(request))
    if role != "admin":
        raise ApiError(403, "只有管理员能删除房间")
    await delete_room(db, settings, meta["room_id"])
    return json_response({"ok": True})
