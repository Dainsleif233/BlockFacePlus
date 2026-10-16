# BlockFace+ · 底图上传与读取
# Copyright 2026 Dainsleif · Apache License 2.0
#
# POST /api/rooms/{roomId}/base   multipart/form-data（file / name / width / height）
# GET  /api/rooms/{roomId}/base   流式返回底图字节（带缓存头，内容基本不变）
#
# 与旧版的区别：不再有"预签名直传 + confirm 两步"。云函数请求体只有 6MB，底图只能绕开它；
# VPS 上的 FastAPI 可以直接收字节，于是上传就是一次请求：边收边计数、落临时文件、
# 校验魔数、原子替换，一步到位。少一步就少一个"签了名传了不确认"的中间态。
#
# 这个文件只写 room_base 与 base/ 下的字节，绝不碰房间身份表，也绝不碰任何一行头像。
# 画布尺寸就是底图尺寸，所以尺寸跟着底图一起更新，没有第二份真相。

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from urllib.parse import quote

from fastapi import APIRouter, Request
from fastapi.responses import FileResponse, JSONResponse

# 注意：isinstance 判断必须用 starlette 的 UploadFile。fastapi.UploadFile 是它的**子类**，
# 拿子类去做 isinstance 会把 multipart 解析出来的真实文件对象判成"不是文件"，
# 表现就是每一次上传都 400「缺少底图文件」。
from starlette.datastructures import FormData, UploadFile

# 直接用 starlette 的 multipart 解析器（而不是 request.form()）只有一个原因：
# request.form() 会把整个请求体先收完再交给我们，于是"边读边计数"就成了一句空话——
# 一个声称 chunked、实际灌 10GB 的请求会先塞满系统临时目录。
# 这里自己喂一个计数用的流，超限在**读取阶段**就抛 413，剩下的字节根本不读。
# starlette 版本由 uv.lock 钉死，所以这个内部接口的形态是确定的。
from starlette.formparsers import MultiPartParser

from .errors import ApiError, json_response, password_of
from .normalize import (
    ext_for_content_type,
    normalize_base_name,
    normalize_doc_size,
    sniff_image_type,
)
from .rooms import get_db, get_settings, require_room
from .security import authenticate, now_ms
from .storage import StagedBaseImage, base_image_path

__all__ = ["router"]

router = APIRouter(prefix="/api/rooms", tags=["base"])

# 上传分片大小：64KiB 是"计数够细"与"系统调用够少"之间的折中
CHUNK_SIZE = 64 * 1024
# multipart 除了文件还有边界、字段名、name/width/height 这些零碎，留 1MiB 余量
_FORM_SLACK_BYTES = 1024 * 1024


def _field_text(form: object, key: str) -> str | None:
    """取一个文本字段；客户端把 width 写成文件时返回 None（当成缺字段处理）"""
    value = form.get(key) if hasattr(form, "get") else None
    return value if isinstance(value, str) else None


async def _read_form(request: Request, limit: int) -> FormData:
    """带上限地解析 multipart：超限在读取阶段就抛 413，不把超量字节收进临时文件"""
    content_type = request.headers.get("content-type", "")
    if not content_type.lower().startswith("multipart/form-data"):
        raise ApiError(400, "请求体必须是 multipart/form-data")

    async def counted_stream() -> AsyncIterator[bytes]:
        total = 0
        async for chunk in request.stream():
            total += len(chunk)
            if total > limit + _FORM_SLACK_BYTES:
                raise ApiError(413, f"底图超过 {_format_mb(limit)} 上限")
            yield chunk

    parser = MultiPartParser(request.headers, counted_stream(), max_files=1, max_fields=8)
    return await parser.parse()


def _format_mb(size: int) -> str:
    if size % (1024 * 1024) == 0:
        return f"{size // (1024 * 1024)}MB"
    return f"{size / (1024 * 1024):.1f}MB"


@router.get("/{room_id}/base")
async def get_base(request: Request, room_id: str) -> FileResponse:
    settings = get_settings(request)
    db = get_db(request)
    meta, base_row = await require_room(request, room_id)
    await authenticate(db, settings, meta, password_of(request))

    if base_row is None or base_row["status"] != "ready":
        raise ApiError(409, "底图尚未上传完成")
    path = base_image_path(settings, meta["room_id"], base_row["ext"])
    if not path.is_file():
        raise ApiError(404, "底图文件丢失")

    return FileResponse(
        path,
        media_type=base_row["type"],
        headers={
            # 响应头不允许非 ASCII：文件名 percent-encoding，前端 decodeURIComponent 解回来
            # safe="" 是为了把 "/" 也编码掉，与旧实现的 encodeURIComponent 一致
            "X-BF-Base-Name": quote(base_row["name"], safe=""),
            # 白名单之外不让浏览器猜类型：避免上传内容被当成可执行文档
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "private, max-age=60",
        },
    )


@router.post("/{room_id}/base")
async def upload_base(request: Request, room_id: str) -> JSONResponse:
    settings = get_settings(request)
    db = get_db(request)
    meta, base_row = await require_room(request, room_id)
    role = await authenticate(db, settings, meta, password_of(request))

    # 草稿期是"创建者正在发布"的窗口，编辑者密码也能确认；房间就绪之后换底图仅管理员
    is_draft = base_row is None or base_row["status"] != "ready"
    if not is_draft and role != "admin":
        raise ApiError(403, "只有管理员能更换底图")

    # 先看声明的字节数：绝大多数超限请求在这一行就被挡掉了，连 body 都不用读
    declared = request.headers.get("content-length")
    if declared is not None:
        try:
            if int(declared) > settings.max_base_image_bytes + _FORM_SLACK_BYTES:
                raise ApiError(413, f"底图超过 {_format_mb(settings.max_base_image_bytes)} 上限")
        except ValueError:
            pass

    form = await _read_form(request, settings.max_base_image_bytes)
    upload = form.get("file")
    if not isinstance(upload, UploadFile):
        raise ApiError(400, "缺少底图文件")
    name = normalize_base_name(_field_text(form, "name"))
    width = normalize_doc_size(_field_text(form, "width"), settings)
    height = normalize_doc_size(_field_text(form, "height"), settings)
    if width is None or height is None:
        raise ApiError(400, "底图尺寸不合法")

    staged = StagedBaseImage(settings, meta["room_id"])
    try:
        # 边读边计数：超过上限立刻 413，剩下的字节不读了，半截临时文件在 except 里清掉
        while True:
            chunk = await upload.read(CHUNK_SIZE)
            if not chunk:
                break
            staged.write(chunk)
            if staged.size > settings.max_base_image_bytes:
                raise ApiError(413, f"底图超过 {_format_mb(settings.max_base_image_bytes)} 上限")
        if staged.size == 0:
            raise ApiError(400, "底图文件是空的")
        # 只认字节魔数，不信客户端声明的 Content-Type
        content_type = sniff_image_type(staged.head)
        if content_type is None:
            raise ApiError(400, "底图只支持 PNG / JPG / WebP / GIF")
        ext = ext_for_content_type(content_type)
        if ext is None:
            raise ApiError(400, "底图只支持 PNG / JPG / WebP / GIF")
        # 原子替换到 base/{roomId}.{ext}，并清掉同一间房其它后缀的旧底图（不留孤儿文件）
        await asyncio.to_thread(staged.commit, ext)
    except BaseException:
        staged.abort()
        raise
    finally:
        await upload.close()

    updated_at = now_ms()
    async with db.transaction() as conn:
        await conn.execute(
            "UPDATE room_base SET ext = ?, type = ?, name = ?, width = ?, height = ?, status = 'ready', "
            "updated_at = ? WHERE room_id = ?",
            (ext, content_type, name, width, height, updated_at, meta["room_id"]),
        )

    return json_response(
        {
            "ok": True,
            "doc": {"width": width, "height": height},
            "baseImage": {"name": name, "type": content_type, "width": width, "height": height},
        }
    )
