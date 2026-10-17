# BlockFace+ · 应用入口（create_app + lifespan）
# Copyright 2026 Dainsleif · Apache License 2.0
#
# uvicorn 入口就是这里的 app：`uv run uvicorn bfp.main:app --port 8088`。
#
# 为什么提供 create_app(settings)：测试要给每个用例一份独立的临时数据目录与独立数据库。
# 如果配置是模块级全局常量，就只能靠改环境变量 + 重载模块，用例之间必然串味。
# 配置是注入的不可变对象，app.state.settings 是唯一出口 —— 这条在测试里最值钱。

from __future__ import annotations

import asyncio
import contextlib
import logging
import tempfile
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.middleware.trustedhost import TrustedHostMiddleware

from . import avatars, base, rooms
from .config import Settings
from .db import Database
from .errors import ApiError, error_response, json_response
from .sweep import sweep_loop

__all__ = ["app", "create_app"]

log = logging.getLogger("bfp")

# 允许的跨域方法：本应用只有这五种，多一种都是白送的面
CORS_METHODS = ["GET", "POST", "PATCH", "DELETE", "OPTIONS"]
# If-None-Match 必须显式放行，不是可选的礼貌配置：生产是跨域部署（前端在 EdgeOne Pages、
# 后端在 VPS），它不在 CORS 安全列表里，浏览器就得先发一次预检；中间件逐字比对
# allow_headers，缺这一项预检当场 400 "Disallowed CORS headers"，条件请求这条链路整条死掉。
# 同源部署根本不发预检，所以单测与本地联调都照不出这个洞 —— 它就是这么活下来的。
CORS_HEADERS = ["X-BF-Room-Pwd", "Content-Type", "If-None-Match"]
# X-BF-Base-Variant 告诉前端这一份是原图还是预览（坐标空间不依赖它，只用于提示文案）
# ETag 同理：按 Fetch 规范，跨域响应里没有 expose 的头对 JS 一律不可见，
# 前端读到的 etag 就是 undefined，baseCache.ts 里 `if (!entry.etag) return false`
# 会把每一条缓存判成不可用 —— 字节一条都写不进 IndexedDB，下次进房照样整张重下。
CORS_EXPOSE_HEADERS = ["X-BF-Base-Name", "X-BF-Base-Variant", "ETag"]

# 非业务错误（路由不存在、方法不对…）也要维持契约第 1 节的错误形状。
# 不注册处理器的话它们会走 FastAPI 的默认响应 {"detail": "Not Found"}，
# 而前端 parseError 只认 error 字段：拿不到 detail，只能退化成「请求失败（404）」这种没法排错的文案。
_HTTP_MESSAGES: dict[int, str] = {
    400: "请求不合法",
    404: "接口不存在",
    405: "这个接口不支持该请求方法",
    413: "请求体太大",
    415: "不支持的请求内容类型",
}


def create_app(settings: Settings | None = None) -> FastAPI:
    resolved = Settings.from_env() if settings is None else settings

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        resolved.data_dir.mkdir(parents=True, exist_ok=True)
        resolved.base_dir.mkdir(parents=True, exist_ok=True)
        # multipart 解析器把 1MB 以上的文件滚进 tempfile 的默认目录（/tmp）。
        # 生产 unit 里 PrivateTmp=true 让 /tmp 是**内存盘**：一条 50MiB 底图上传就等于
        # 白吃 50MiB 内存，并发几条还能把 tmpfs 写满、让解析器抛未捕获的 OSError（500 而不是 413）。
        # 指到数据目录下的 tmp：那里是 StateDirectory，落在磁盘上，也不受 ProtectSystem=strict 限制。
        spool_dir = resolved.data_dir / "tmp"
        spool_dir.mkdir(parents=True, exist_ok=True)
        tempfile.tempdir = str(spool_dir)
        db = Database(resolved.db_path)
        await db.connect()
        app.state.db = db
        # 后台清扫：启动先扫一轮，之后按 BF_SWEEP_INTERVAL_SECONDS 轮询
        sweeper = asyncio.create_task(sweep_loop(db, resolved), name="bfp-sweep")
        try:
            yield
        finally:
            # 关停时优雅取消：先 cancel 再 await，等它从 sleep / 事务里退出来再关连接，
            # 否则可能出现"连接已关、清扫还在写"的报错刷屏
            sweeper.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await sweeper
            await db.close()

    app = FastAPI(
        title="BlockFace+ 协同后端",
        version=resolved.version,
        lifespan=lifespan,
    )
    # 测试与路由处理器都从这里取配置/连接，别再引入第二处全局状态
    app.state.settings = resolved

    if "*" not in resolved.trusted_hosts:
        app.add_middleware(TrustedHostMiddleware, allowed_hosts=list(resolved.trusted_hosts))
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(resolved.cors_origins),
        # 本应用不用 cookie（密码走自定义请求头），所以永远不开 credentials：
        # allow_origins=["*"] 与 allow_credentials=True 同时出现本身就是不合法的组合
        allow_credentials=False,
        allow_methods=CORS_METHODS,
        allow_headers=CORS_HEADERS,
        expose_headers=CORS_EXPOSE_HEADERS,
    )

    @app.exception_handler(ApiError)
    async def _api_error(_request: Request, exc: ApiError) -> JSONResponse:
        return error_response(exc.status, exc.message, exc.extra)

    @app.exception_handler(StarletteHTTPException)
    async def _http_error(_request: Request, exc: StarletteHTTPException) -> JSONResponse:
        message = _HTTP_MESSAGES.get(exc.status_code) or (
            exc.detail if isinstance(exc.detail, str) and exc.detail else f"请求失败（{exc.status_code}）"
        )
        response = error_response(exc.status_code, message)
        # 405 的 Allow、401 的 WWW-Authenticate 这类头必须原样带出去，否则排错时会以为路由根本没注册。
        # Content-Length 例外：body 已经换了，长度交给 JSONResponse 自己算。
        for key, value in (exc.headers or {}).items():
            if key.lower() != "content-length":
                response.headers[key] = value
        return response

    @app.exception_handler(RequestValidationError)
    async def _invalid_params(_request: Request, _exc: RequestValidationError) -> JSONResponse:
        # 契约的状态码表里没有 422：入参不合法统一是 400 + {"error": ...}
        return error_response(400, "请求参数不合法")

    @app.exception_handler(Exception)
    async def _unexpected(_request: Request, exc: Exception) -> JSONResponse:
        log.exception("未处理的异常", exc_info=exc)
        return error_response(500, "服务器开小差了，稍后再试")

    @app.get("/api/health", tags=["meta"])
    async def health() -> JSONResponse:
        """探活：不碰数据库、不鉴权，反代和监控都打这个"""
        return json_response({"ok": True, "version": resolved.version})

    @app.get("/api/config", tags=["meta"])
    async def config() -> JSONResponse:
        """公开上限，供前端展示与运维自查；只回数值，不泄漏任何存储/路径信息"""
        return json_response(resolved.public_config())

    app.include_router(rooms.router)
    app.include_router(avatars.router)
    app.include_router(base.router)
    return app


app = create_app()
