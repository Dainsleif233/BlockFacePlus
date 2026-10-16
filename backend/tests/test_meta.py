# BlockFace+ · /api/health 与 /api/config
# Copyright 2026 Dainsleif · Apache License 2.0

from __future__ import annotations

import pytest

from bfp import __main__ as entry

DEFAULT_CONFIG = {
    "version": "0.2.0",
    "expiryDays": [3, 7, 14, 30, 90],
    "maxExpiryDays": 3650,
    "maxLayers": 10000,
    "maxBaseImageBytes": 134217728,
    "maxSkinDataUrlChars": 32000000,
    "maxJsonBodyBytes": 268435456,
    "maxDocSize": 65536,
    "minLayerSize": 1,
    "maxLayerSize": 262144,
    "maxAvatarName": 512,
    "maxPosition": 10000000,
}


async def test_health_needs_no_auth(harness):
    response = await harness.client.get("/api/health")
    assert response.status_code == 200
    assert response.json() == {"ok": True, "version": "0.2.0"}
    # JSON 接口一律不许浏览器猜类型
    assert response.headers["x-content-type-options"] == "nosniff"


async def test_config_returns_relaxed_defaults(harness):
    response = await harness.client.get("/api/config")
    assert response.status_code == 200
    assert response.json() == DEFAULT_CONFIG


async def test_config_defaults_are_way_above_the_old_platform_limits():
    """放宽是本轮改造的目的之一，这里把"放宽了多少"钉成断言，防止被无意改回去"""
    assert DEFAULT_CONFIG["maxBaseImageBytes"] > 10 * 1024 * 1024  # 旧：10MB
    assert DEFAULT_CONFIG["maxJsonBodyBytes"] > 6 * 1024 * 1024  # 旧：平台硬限 6MB
    assert DEFAULT_CONFIG["maxLayers"] > 512  # 旧：512 行
    assert DEFAULT_CONFIG["maxExpiryDays"] > 14  # 旧：3/7/14
    assert DEFAULT_CONFIG["minLayerSize"] < 16  # 旧：16
    assert DEFAULT_CONFIG["maxLayerSize"] > 4096  # 旧：4096
    assert DEFAULT_CONFIG["maxAvatarName"] > 200  # 旧：200


async def test_config_follows_env_overrides(open_harness, tmp_path):
    async with open_harness(
        tmp_path,
        BF_MAX_LAYERS="17",
        BF_MAX_BASE_IMAGE_BYTES="2048",
        BF_MAX_EXPIRY_DAYS="30",
    ) as harness:
        payload = (await harness.client.get("/api/config")).json()
        assert payload["maxLayers"] == 17
        assert payload["maxBaseImageBytes"] == 2048
        assert payload["maxExpiryDays"] == 30


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
