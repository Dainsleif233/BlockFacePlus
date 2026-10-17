# BlockFace+ · 测试公共设施
# Copyright 2026 Dainsleif · Apache License 2.0
#
# 每个用例一份独立的临时 BF_DATA_DIR（tmp_path）与独立数据库：用例之间绝不串味。
# 直接通过 httpx 的 ASGITransport 打 app，不起真进程、不占端口 —— 也就不用管端口冲突与清理。
# 注意 ASGITransport 不会自己跑 lifespan，所以这里显式进一次 app.router.lifespan_context。

from __future__ import annotations

import base64
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx
import pytest

from bfp.config import Settings
from bfp.main import create_app

# 1x1 的真 PNG（base64 是纯 ASCII，源码里不会出现奇怪字节）
PNG_BYTES = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=="
)
JPEG_BYTES = bytes([0xFF, 0xD8, 0xFF]) + b"fake-jpeg-body"
WEBP_BYTES = b"RIFF" + bytes([0, 0, 0, 0]) + b"WEBP" + b"fake-webp-body"
GIF_BYTES = b"GIF89a" + b"fake-gif-body"
NOT_IMAGE_BYTES = b"<html>definitely not an image</html>"

VALID_SKIN = {"dataUrl": "data:image/png;base64,AAAA", "width": 64, "height": 64}


def draft(layer_id: str, **overrides: Any) -> dict[str, Any]:
    """一行 RoomAvatarDraft（版本戳由服务端生成，客户端不带）"""
    record: dict[str, Any] = {
        "id": layer_id,
        "name": layer_id,
        "x": 0,
        "y": 0,
        "size": 64,
        "rotation": 0,
        "opacity": 1,
        "overlay": True,
        "flipH": False,
        "visible": True,
        "order": 0,
        "skin": None,
    }
    record.update(overrides)
    return record


def png_bytes(width: int, height: int, color: tuple[int, int, int] = (200, 30, 60)) -> bytes:
    """真正能被 Pillow 解码的 PNG。

    上面那个 1x1 常量只够验魔数：Pillow 读它会报 broken data stream
    （浏览器宽容，图像库不宽容），用它测预览永远测不到"生成成功"那条路。
    """
    from io import BytesIO

    from PIL import Image

    buffer = BytesIO()
    Image.new("RGB", (width, height), color).save(buffer, "PNG")
    return buffer.getvalue()


def gif_bytes(width: int, height: int, frames: int = 2) -> bytes:
    """多帧 GIF：用来验证"动图不生成静态预览"这条约束"""
    from io import BytesIO

    from PIL import Image

    images = [Image.new("RGB", (width, height), (i * 40 % 255, 30, 60)) for i in range(frames)]
    buffer = BytesIO()
    images[0].save(buffer, "GIF", save_all=True, append_images=images[1:], duration=100)
    return buffer.getvalue()


def room_body(
    layers: list[dict[str, Any]] | None = None,
    expires_days: int = 7,
    image: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "baseImage": image or {"name": "底图.png", "type": "image/png", "width": 1920, "height": 1080},
        "layers": [draft("l1")] if layers is None else layers,
        "expiresDays": expires_days,
    }


def pwd(password: str) -> dict[str, str]:
    return {"X-BF-Room-Pwd": password}


@dataclass
class Harness:
    client: httpx.AsyncClient
    app: Any
    settings: Settings
    data_dir: Path

    @property
    def db(self) -> Any:
        return self.app.state.db

    async def create(self, **overrides: Any) -> httpx.Response:
        return await self.client.post("/api/rooms", json=room_body(**overrides))

    async def create_ok(self, **overrides: Any) -> tuple[str, str, str]:
        response = await self.create(**overrides)
        assert response.status_code == 201, response.text
        data = response.json()
        return data["roomId"], data["editPassword"], data["adminPassword"]

    async def upload(
        self,
        room_id: str,
        password: str,
        content: bytes = PNG_BYTES,
        name: str = "底图.png",
        width: int | str = 1920,
        height: int | str = 1080,
        filename: str = "base.png",
    ) -> httpx.Response:
        return await self.client.post(
            f"/api/rooms/{room_id}/base",
            headers=pwd(password),
            data={"name": name, "width": str(width), "height": str(height)},
            files={"file": (filename, content, "image/png")},
        )

    def base_files(self, room_id: str) -> list[str]:
        return sorted(path.name for path in (self.data_dir / "base").glob(f"{room_id}.*"))

    def all_base_files(self) -> list[str]:
        return sorted(path.name for path in (self.data_dir / "base").iterdir() if path.is_file())


@asynccontextmanager
async def _open(tmp_path: Path, **env_overrides: str) -> AsyncIterator[Harness]:
    env = {"BF_DATA_DIR": str(tmp_path / "data"), **env_overrides}
    settings = Settings.from_env(env)
    app = create_app(settings)
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        # 默认 raise_app_exceptions=True：真出了未捕获异常就让用例炸出来，别被 500 掩盖
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
            yield Harness(client, app, settings, settings.data_dir)


@pytest.fixture
async def harness(tmp_path: Path) -> AsyncIterator[Harness]:
    """默认配置（全部用契约第 4 节的默认值）"""
    async with _open(tmp_path) as instance:
        yield instance


@pytest.fixture
def open_harness() -> Callable[..., Any]:
    """需要自定义上限的用例用这个工厂：async with open_harness(tmp_path, BF_MAX_LAYERS="2")"""

    def factory(tmp_path: Path, **env_overrides: str):
        return _open(tmp_path, **env_overrides)

    return factory
