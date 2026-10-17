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
import logging
from collections.abc import AsyncIterator
from pathlib import Path
from urllib.parse import quote

from fastapi import APIRouter, Request, Response
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
from starlette.formparsers import MultiPartException, MultiPartParser

from .config import Settings
from .errors import ApiError, ROOM_NOT_FOUND, json_response, password_of
from .normalize import (
    ext_for_content_type,
    normalize_base_name,
    normalize_doc_size,
    sniff_image_type,
)
from .previews import render_preview
from .rooms import get_db, get_settings, require_room
from .security import authenticate, now_ms
from .storage import (
    StagedBaseImage,
    backup_base_files,
    base_image_path,
    cleanup_base_backups,
    orphan_base_files,
    preview_file,
    preview_files,
    rollback_base_files,
)

__all__ = ["router"]

log = logging.getLogger("bfp.base")

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
    try:
        return await parser.parse()
    except MultiPartException as exc:
        # 畸形表单（缺 boundary、字段或文件超量、part 头不合规…）必须是 400。
        # 不接住的话它会一路冒到 main.py 的兜底处理器变成 500：客户端只看到「服务器开小差了」，
        # 而这类错 100% 是请求本身有问题，不是服务端故障（实测过：无 boundary、9 个字段、2 个文件都是 500）。
        # 保留解析器的原话是为了可行动 ——「Too many fields. Maximum number of fields is 8.」
        # 比一句笼统的「请求不合法」更能告诉调用方该删哪个字段。
        raise ApiError(400, f"请求体不是合法的 multipart 表单（{exc}）") from None


def _drop_previews(settings: Settings, room_id: str) -> None:
    """删掉这间房残留的预览文件（预览生成失败时用：宁可退回原图，也不留旧图的预览）"""
    for stale in preview_files(settings, room_id):
        try:
            stale.unlink()
        except OSError:
            pass


def _base_etag(path: Path, variant: str) -> str:
    """强校验器：文件 mtime + 大小 + **变体**。

    变体必须进 ETag：同一个 URL 对不同角色发不同字节，共用 ETag 会让
    "编辑者的预览"与"管理员要的原图"被当成同一份东西复用。
    """
    stat = path.stat()
    return f'"{variant}-{stat.st_mtime_ns:x}-{stat.st_size:x}"'


def _matches_etag(if_none_match: str | None, etag: str) -> bool:
    """If-None-Match 走弱比较（RFC 9110 §13.1.2）：忽略 W/ 前缀，逗号分隔逐项比"""
    if not if_none_match:
        return False
    target = etag.strip()
    for candidate in if_none_match.split(","):
        candidate = candidate.strip()
        if not candidate:
            continue
        if candidate == "*":
            return True
        if candidate.removeprefix("W/").strip() == target:
            return True
    return False


def _serve_base(
    request: Request, path: Path, media_type: str, name: str, variant: str
) -> Response:
    """原图与预览共用的出口：带 ETag，命中 If-None-Match 就回 304。

    304 的价值在小带宽机器上很直接：浏览器缓存过期后必须回来问一句，
    答 200 就是整张图重下一遍（50MiB 的图能重下几十秒），答 304 只有几百字节头。
    """
    headers = _base_headers(name, variant)
    etag = _base_etag(path, variant)
    headers["ETag"] = etag
    # 响应体取决于密码（编辑者拿预览、管理员拿原图），按 HTTP 语义必须声明 Vary。
    # 共享缓存本来就被 Cache-Control: private 挡住，这里只是让私有缓存别串角色。
    headers["Vary"] = "X-BF-Room-Pwd"
    if _matches_etag(request.headers.get("if-none-match"), etag):
        # 304 不带正文，也不回 Content-Type/Content-Length
        keep = ("ETag", "Cache-Control", "Vary", "X-BF-Base-Variant")
        return Response(status_code=304, headers={key: headers[key] for key in keep if key in headers})
    return FileResponse(path, media_type=media_type, headers=headers)


def _base_headers(name: str, variant: str) -> dict[str, str]:
    return {
        # 响应头不允许非 ASCII：文件名 percent-encoding，前端 decodeURIComponent 解回来
        # safe="" 是为了把 "/" 也编码掉，与旧实现的 encodeURIComponent 一致
        "X-BF-Base-Name": quote(name, safe=""),
        # 白名单之外不让浏览器猜类型：避免上传内容被当成可执行文档
        "X-Content-Type-Options": "nosniff",
        # 告诉前端这一份到底是原图还是预览。坐标空间不靠它 ——
        # 画布尺寸永远来自快照的 doc，这里只是给 UI 一句实话。
        "X-BF-Base-Variant": variant,
        "Cache-Control": "private, max-age=60",
    }


def _format_mb(size: int) -> str:
    if size % (1024 * 1024) == 0:
        return f"{size // (1024 * 1024)}MB"
    return f"{size / (1024 * 1024):.1f}MB"


@router.get("/{room_id}/base")
async def get_base(request: Request, room_id: str) -> FileResponse:
    settings = get_settings(request)
    db = get_db(request)
    meta, base_row = await require_room(request, room_id)
    role = await authenticate(db, settings, meta, password_of(request))

    if base_row is None or base_row["status"] != "ready":
        raise ApiError(409, "底图尚未上传完成")

    # 除管理员外都只拿预览：这是"服务器带宽小"最直接的解法，
    # 而管理员要负责换底图与导出，必须拿到原始像素。
    # 预览缺失（老房间没回填 / 生成失败 / 动图）时退回原图 —— 正确性优先于省流量。
    if role != "admin" and settings.base_preview_max_edge > 0:
        # 唯一判定在 storage.preview_file()：快照（public_room）与这里必须说同一件事
        available = preview_file(settings, meta["room_id"], base_row)
        if available is not None:
            preview_path, preview_type, _ext = available
            return _serve_base(request, preview_path, preview_type, base_row["name"], "preview")

    path = base_image_path(settings, meta["room_id"], base_row["ext"])
    if not path.is_file():
        raise ApiError(404, "底图文件丢失")

    return _serve_base(request, path, base_row["type"], base_row["name"], "full")


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
    backups: list[tuple] = []
    committed = False
    try:
        # 旧文件先做同文件系统硬链接备份；数据库失败时可以恢复，不必把底图读进内存。
        backups = await asyncio.to_thread(backup_base_files, settings, meta["room_id"])
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
        # 先替换文件但保留旧后缀，等元数据事务成功后再清理；失败则恢复备份。
        await asyncio.to_thread(staged.commit, ext, cleanup=False)
        committed = True
        updated_at = now_ms()
        async with db.transaction() as conn:
            # preview_* 一起清空：旧预览属于旧图，留着就会被当成新图的预览发出去。
            # 新预览在事务提交之后才生成（解码缩放是慢活，不该占着写锁）。
            cursor = await conn.execute(
                "UPDATE room_base SET ext = ?, type = ?, name = ?, width = ?, height = ?, status = 'ready', "
                "updated_at = ?, preview_ext = NULL, preview_type = NULL, preview_width = NULL, "
                "preview_height = NULL WHERE room_id = ?",
                (ext, content_type, name, width, height, updated_at, meta["room_id"]),
            )
            if cursor.rowcount != 1:
                # 房间可能在上传耗时期间被管理员删除；不能把新文件当成成功上传留下。
                raise ApiError(404, ROOM_NOT_FOUND)
    except BaseException:
        staged.abort()
        await asyncio.to_thread(
            rollback_base_files, settings, meta["room_id"], backups, committed=committed
        )
        raise
    finally:
        await upload.close()

    await asyncio.to_thread(cleanup_base_backups, backups)
    for stale in orphan_base_files(settings, meta["room_id"], ext):
        try:
            stale.unlink()
        except OSError:
            pass

    # 预览是"锦上添花"：生成失败就退回原图，绝不能让一次成功的上传变成 500。
    preview: dict[str, int] | None = None
    try:
        result = await asyncio.to_thread(
            render_preview,
            base_image_path(settings, meta["room_id"], ext),
            settings,
            meta["room_id"],
        )
    except Exception:  # noqa: BLE001 —— 预览出任何岔子都不该影响这次上传
        log.warning("房间 %s 的预览生成失败，本次不提供预览", meta["room_id"], exc_info=True)
        result = None

    if result is not None:
        try:
            async with db.transaction() as conn:
                # updated_at 做守卫：万一这期间又有人换了底图，别把旧图的预览尺寸写上去
                await conn.execute(
                    "UPDATE room_base SET preview_ext = ?, preview_type = ?, preview_width = ?, "
                    "preview_height = ? WHERE room_id = ? AND updated_at = ?",
                    (result.ext, result.mime, result.width, result.height, meta["room_id"], updated_at),
                )
            preview = {"width": result.width, "height": result.height}
        except Exception:  # noqa: BLE001 —— 同上，元数据写不进去也只是没有预览
            log.warning("房间 %s 的预览元数据写入失败", meta["room_id"], exc_info=True)
    else:
        await asyncio.to_thread(_drop_previews, settings, meta["room_id"])

    return json_response(
        {
            "ok": True,
            "doc": {"width": width, "height": height},
            "baseImage": {
                "name": name,
                "type": content_type,
                "width": width,
                "height": height,
                "preview": preview,
            },
        }
    )
