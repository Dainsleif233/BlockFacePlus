# BlockFace+ · /api/health 与 /api/config
# Copyright 2026 Dainsleif · Apache License 2.0

from __future__ import annotations

import pytest

from bfp import __main__ as entry
from conftest import png_bytes, pwd

DEFAULT_CONFIG = {
    "version": "0.2.0",
    "expiryDays": [3, 7, 14],
    "maxLayers": 512,
    "maxBaseImageBytes": 52428800,
    "basePreviewMaxEdge": 2048,
    "maxSkinDataUrlChars": 5000000,
    "maxJsonBodyBytes": 67108864,
    "maxDocSize": 16384,
    "minLayerSize": 16,
    "maxLayerSize": 16384,
    "maxAvatarName": 200,
    "maxPosition": 100000,
}


async def test_health_needs_no_auth(harness):
    response = await harness.client.get("/api/health")
    assert response.status_code == 200
    assert response.json() == {"ok": True, "version": "0.2.0"}
    # JSON 接口一律不许浏览器猜类型
    assert response.headers["x-content-type-options"] == "nosniff"


async def test_unknown_route_and_wrong_method_keep_the_error_shape(harness):
    """契约第 1 节：所有错误响应都是 {"error": "<中文人话>"}。

    回归用例：不注册处理器时这两条会走 FastAPI 默认的 {"detail": "Not Found"}，
    而前端 parseError 只认 error 字段 —— 拿不到 detail 就只能显示「请求失败（404）」，
    对着这句话既不知道错在哪，也搜不到任何东西。
    """
    missing = await harness.client.get("/api/nope")
    assert missing.status_code == 404
    assert set(missing.json()) == {"error"}
    assert missing.json()["error"] == "接口不存在"

    wrong_method = await harness.client.put("/api/rooms/abcdefghijkl", headers=pwd("x"))
    assert wrong_method.status_code == 405
    assert wrong_method.json()["error"] == "这个接口不支持该请求方法"
    # 405 必须带上 Allow：不然排错的人会以为路由压根没注册
    assert "GET" in wrong_method.headers["allow"]


async def test_config_returns_the_published_limits(harness):
    response = await harness.client.get("/api/config")
    assert response.status_code == 200
    assert response.json() == DEFAULT_CONFIG


async def test_config_defaults_are_pinned_by_the_contract():
    """契约第 4 节那张表就是这份数值 —— 改上限必须先改契约，所以在这里钉死。

    相对旧云函数（cloud-functions/api/lib.js 里那批硬编码常量）只剩这么几处不同：
    底图 10MiB → 50MiB、单条皮肤 1.5M → 5M 字符、画布 8192 → 16384（坐标与图层上限跟着走）、
    几何上限改成可配的旋钮；头像行数 512、名字 200、失败次数 10 与 3/7/14 的过期档位都已回到旧值。
    """
    assert DEFAULT_CONFIG["maxLayers"] == 512
    assert DEFAULT_CONFIG["maxAvatarName"] == 200
    assert DEFAULT_CONFIG["maxBaseImageBytes"] == 50 * 1024 * 1024
    assert DEFAULT_CONFIG["maxSkinDataUrlChars"] == 5_000_000
    assert DEFAULT_CONFIG["maxDocSize"] == 16_384
    assert DEFAULT_CONFIG["maxLayerSize"] == DEFAULT_CONFIG["maxDocSize"]  # 图层最大就是一个画布
    assert DEFAULT_CONFIG["minLayerSize"] == 16
    assert DEFAULT_CONFIG["maxJsonBodyBytes"] == 64 * 1024 * 1024
    assert DEFAULT_CONFIG["maxPosition"] == 100_000
    assert DEFAULT_CONFIG["expiryDays"] == [3, 7, 14]


async def test_config_follows_env_overrides(open_harness, tmp_path):
    async with open_harness(
        tmp_path,
        BF_MAX_LAYERS="17",
        BF_MAX_BASE_IMAGE_BYTES="2048",
        BF_MAX_DOC_SIZE="4096",
        # 过期档位不是可配项：这个旋钮已经删掉，写进环境也不生效
        BF_MAX_EXPIRY_DAYS="30",
    ) as harness:
        payload = (await harness.client.get("/api/config")).json()
        assert payload["maxLayers"] == 17
        assert payload["maxBaseImageBytes"] == 2048
        assert payload["maxDocSize"] == 4096
        assert payload["expiryDays"] == [3, 7, 14]


async def test_cors_preflight_allows_password_header_and_exposes_base_name(harness):
    response = await harness.client.options(
        "/api/rooms/abcdefghijkl",
        headers={
            "Origin": "https://pages.example.com",
            "Access-Control-Request-Method": "PATCH",
            "Access-Control-Request-Headers": "X-BF-Room-Pwd,Content-Type",
        },
    )
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "*"
    allow_methods = response.headers["access-control-allow-methods"]
    for method in ("GET", "POST", "PATCH", "DELETE", "OPTIONS"):
        assert method in allow_methods
    assert "x-bf-room-pwd" in response.headers["access-control-allow-headers"].lower()
    # 不用 cookie，所以永远不回 allow-credentials（与 allow-origin: * 也是冲突的组合）
    assert "access-control-allow-credentials" not in response.headers

    # expose-headers 是给"真实响应"用的（预检响应按规范不带它），所以要在真请求上看
    actual = await harness.client.get("/api/health", headers={"Origin": "https://pages.example.com"})
    assert actual.headers["access-control-allow-origin"] == "*"
    assert "x-bf-base-name" in actual.headers["access-control-expose-headers"].lower()


async def test_cors_lets_the_conditional_base_request_work_across_origins(open_harness, tmp_path):
    """跨域下「304 + 客户端按 ETag 缓存」这两条路能不能成立，全看这两个头。

    回归用例，一测盯一个洞：
    1. `If-None-Match` 不在 allow_headers 里 → Starlette 对请求头是逐字比对的，
       预检当场 400（不是把请求放给应用），浏览器连 GET 都不会发出去；
    2. `ETag` 不在 expose_headers 里 → 请求过了也白搭：跨域响应里没 expose 的头对 JS
       一律不可见，前端读到的 etag 就是 undefined，baseCache.ts 里
       `if (!entry.etag) return false` 会把每一条缓存判成不可用，字节一条都写不进 IndexedDB。

    为什么这么久没被发现：本地是**同源**（Vite 代理）部署，同源不发预检、也没有响应头可见性
    限制 —— 这个洞只在生产那种「前端在 Pages、后端在 VPS」的跨域形态下才现形。
    """
    async with open_harness(tmp_path, BF_BASE_PREVIEW_MAX_EDGE="256") as harness:
        room_id, edit, admin = await harness.create_ok()
        uploaded = await harness.upload(room_id, admin, content=png_bytes(64, 64), width=64, height=64)
        assert uploaded.status_code == 200, uploaded.text
        origin = {"Origin": "https://pages.example.com"}

        # 1) 浏览器带着 If-None-Match 回来问之前，先发的就是这一条预检
        preflight = await harness.client.options(
            f"/api/rooms/{room_id}/base",
            headers={
                **origin,
                "Access-Control-Request-Method": "GET",
                "Access-Control-Request-Headers": "if-none-match, x-bf-room-pwd",
            },
        )
        assert preflight.status_code in (200, 204), preflight.text
        assert preflight.headers["access-control-allow-origin"] == "*"
        allowed = {
            name.strip().lower()
            for name in preflight.headers["access-control-allow-headers"].split(",")
        }
        assert "if-none-match" in allowed
        # 密码头与它是同一条预检里的两个请求头：加了新的不能把旧的顶掉
        assert "x-bf-room-pwd" in allowed

        # 2) 真响应上 ETag 必须对 JS 可见（expose-headers 按规范只作用于真实响应，预检不带）
        first = await harness.client.get(f"/api/rooms/{room_id}/base", headers={**pwd(edit), **origin})
        assert first.status_code == 200
        etag = first.headers["etag"]
        assert etag and etag.startswith('"')
        exposed = {
            name.strip().lower()
            for name in first.headers["access-control-expose-headers"].split(",")
        }
        assert "etag" in exposed
        assert "x-bf-base-variant" in exposed

        # 3) 两道门都通了缓存才真的省字节：带着拿到的 ETag 回来应当拿到 304，
        #    这也是前两次提交想要的效果 —— 这里从浏览器视角把它整个走一遍
        revalidated = await harness.client.get(
            f"/api/rooms/{room_id}/base",
            headers={**pwd(edit), **origin, "If-None-Match": etag},
        )
        assert revalidated.status_code == 304
        assert revalidated.content == b""
        assert revalidated.headers["etag"] == etag


async def test_config_accepts_narrowed_origin_whitelist(open_harness, tmp_path):
    async with open_harness(tmp_path, BF_CORS_ORIGINS="https://a.example.com,https://b.example.com") as harness:
        allowed = await harness.client.get("/api/health", headers={"Origin": "https://a.example.com"})
        assert allowed.headers["access-control-allow-origin"] == "https://a.example.com"
        denied = await harness.client.get("/api/health", headers={"Origin": "https://evil.example.com"})
        assert "access-control-allow-origin" not in denied.headers


def test_module_entry_help_only_prints_usage(monkeypatch, capsys):
    """`python -m bfp --help` 只准打印用法。

    回归用例：uvicorn.run() 自己不吃 --help，早先的实现会把这里当成"没有参数"，
    于是想看用法的人反而悄悄多出一个 8088 上的后台服务。
    """
    started: list[object] = []
    monkeypatch.setattr(entry.uvicorn, "run", lambda *args, **kwargs: started.append((args, kwargs)))

    with pytest.raises(SystemExit) as excinfo:
        entry.main(["--help"])
    assert excinfo.value.code == 0
    assert started == []
    assert "BF_HOST" in capsys.readouterr().out  # 帮助里写明了默认值来自哪个环境变量


def test_module_entry_host_and_port_come_from_env_but_cli_wins(monkeypatch):
    started: list[dict] = []
    monkeypatch.setattr(entry.uvicorn, "run", lambda app, **kwargs: started.append(kwargs))
    monkeypatch.setenv("BF_HOST", "0.0.0.0")
    monkeypatch.setenv("BF_PORT", "9001")

    entry.main([])
    assert started == [{"host": "0.0.0.0", "port": 9001}]

    entry.main(["--port", "9500"])
    assert started[-1] == {"host": "0.0.0.0", "port": 9500}

    entry.main(["--host", "127.0.0.1", "--port", "9600"])
    assert started[-1] == {"host": "127.0.0.1", "port": 9600}


def test_module_entry_rejects_a_non_numeric_port(monkeypatch, capsys):
    monkeypatch.setattr(entry.uvicorn, "run", lambda *args, **kwargs: pytest.fail("不该起服务"))
    with pytest.raises(SystemExit) as excinfo:
        entry.main(["--port", "不是端口"])
    assert excinfo.value.code == 2
    assert "port" in capsys.readouterr().err
