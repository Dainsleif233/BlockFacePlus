# BlockFace+ · 统一的错误形状与请求体读取
# Copyright 2026 Dainsleif · Apache License 2.0
#
# 所有接口的错误响应都是 {"error": "<中文人话>"}，前端只认这一个字段。
# 这里同时也是"路由模块需要 import 但不想互相 import"的那个公共落脚点：
# rooms/avatars/base/security/normalize 都要抛 ApiError，所以它必须待在谁都不依赖的模块里。

from __future__ import annotations

import json
from typing import Any

from fastapi import Request
from fastapi.responses import JSONResponse

__all__ = ["ApiError", "error_response", "json_response", "password_of", "read_json_body"]

# 错误文案的单一出处：状态码语义见契约第 1 节
ROOM_NOT_FOUND = "房间不存在或已被删除"
ROOM_EXPIRED = "房间已过期"
BAD_PASSWORD = "密码不对"
TOO_MANY_FAILS = "这个房间密码试错太频繁，{} 秒后再来"


class ApiError(Exception):
    """带 HTTP 状态码的业务错误；由 main.py 注册的处理器翻成 {"error": ...}"""

    def __init__(self, status: int, message: str, extra: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.status = status
        self.message = message
        self.extra = extra or {}


def json_response(data: Any, status: int = 200) -> JSONResponse:
    return JSONResponse(
        data,
        status_code=status,
        # 不让浏览器猜类型：JSON 接口的类型嗅探是 XSS 的老入口
        headers={"X-Content-Type-Options": "nosniff"},
    )


def error_response(status: int, message: str, extra: dict[str, Any] | None = None) -> JSONResponse:
    return json_response({"error": message, **(extra or {})}, status)


def password_of(request: Request) -> str:
    """密码只走 X-BF-Room-Pwd 头，绝不进 URL / query / 日志"""
    return request.headers.get("x-bf-room-pwd", "") or ""


async def read_json_body(request: Request, max_bytes: int) -> Any:
    """边读边计数地取 JSON 请求体。

    为什么不直接 await request.json()：那会把超大 body 先整个读进内存再判超限，
    等于把 BF_MAX_JSON_BODY_BYTES 这道闸门装在了内存耗尽之后。
    Content-Length 先挡一道（能挡掉绝大多数），没声明长度或声明撒谎的，
    再靠边读边计数兜底 —— 一旦超限立刻 413，剩下的字节不读了。
    """
    declared = request.headers.get("content-length")
    if declared is not None:
        try:
            if int(declared) > max_bytes:
                raise ApiError(413, "请求体太大")
        except ValueError:
            pass
    chunks: list[bytes] = []
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > max_bytes:
            raise ApiError(413, "请求体太大")
        chunks.append(chunk)
    raw = b"".join(chunks)
    if not raw:
        raise ApiError(400, "请求体不是合法 JSON")
    try:
        return json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise ApiError(400, "请求体不是合法 JSON") from None
