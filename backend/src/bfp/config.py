# BlockFace+ · 运行配置（全部来自环境变量）
# Copyright 2026 Dainsleif · Apache License 2.0
#
# 为什么不用全局常量：测试要给每个用例一份独立的临时数据目录与独立的数据库，
# 所以配置是个不可变对象，由 create_app(settings) 注入，app.state.settings 是唯一出口。
#
# 另一条规矩：相对路径的 BF_DATA_DIR 一律相对 backend/ 目录解析。
# 部署时 systemd 的 cwd 未必是 backend/，如果按 cwd 解析，默认值 ./data 会飘到
# 意料之外的地方（比如 /），表现为"库在，房间全没了"。定死基准目录就没这个问题。

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

__all__ = ["BACKEND_DIR", "DEFAULT_VERSION", "Settings"]

# config.py 在 backend/src/bfp/ 下，往上三级就是 backend/
BACKEND_DIR = Path(__file__).resolve().parents[2]

# 与 pyproject.toml 的 version 保持一致；/api/health 与 /api/config 都回它
DEFAULT_VERSION = "0.2.0"

_DAY_SECONDS = 86_400


def _env_int(env: Mapping[str, str], name: str, default: int, *, minimum: int = 0) -> int:
    """读一个整数环境变量；写错了就当场炸，别让服务带着错配置跑起来"""
    raw = env.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        value = int(raw.strip())
    except ValueError:
        raise SystemExit(f"环境变量 {name} 不是合法的整数：{raw!r}") from None
    if value < minimum:
        raise SystemExit(f"环境变量 {name} 不能小于 {minimum}：{value}")
    return value


def _env_str(env: Mapping[str, str], name: str, default: str) -> str:
    raw = env.get(name)
    if raw is None:
        return default
    raw = raw.strip()
    return raw or default


def _env_list(env: Mapping[str, str], name: str, default: str) -> tuple[str, ...]:
    return tuple(part.strip() for part in _env_str(env, name, default).split(",") if part.strip())


@dataclass(frozen=True, slots=True)
class Settings:
    """一次进程生命周期内不变的配置快照"""

    version: str
    data_dir: Path
    cors_origins: tuple[str, ...]
    trusted_hosts: tuple[str, ...]
    host: str
    port: int

    # 公开上限（默认值 = 契约第 4 节放宽后的数值）
    max_layers: int
    max_skin_data_url_chars: int
    max_base_image_bytes: int
    max_doc_size: int
    max_position: int
    min_layer_size: int
    max_layer_size: int
    max_avatar_name: int
    max_json_body_bytes: int
    max_expiry_days: int

    # 限流与清扫
    auth_window_seconds: int
    auth_max_fails: int
    draft_ttl_seconds: int
    sweep_interval_seconds: int

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> Settings:
        source = os.environ if env is None else env
        raw_data_dir = _env_str(source, "BF_DATA_DIR", "./data")
        data_dir = Path(raw_data_dir).expanduser()
        if not data_dir.is_absolute():
            # 相对路径以 backend/ 为基准，理由见文件头
            data_dir = BACKEND_DIR / data_dir
        min_layer_size = _env_int(source, "BF_MIN_LAYER_SIZE", 1, minimum=1)
        max_layer_size = _env_int(source, "BF_MAX_LAYER_SIZE", 262_144, minimum=1)
        if max_layer_size < min_layer_size:
            raise SystemExit(
                f"环境变量 BF_MAX_LAYER_SIZE（{max_layer_size}）不能小于 BF_MIN_LAYER_SIZE（{min_layer_size}）"
            )
        return cls(
            version=DEFAULT_VERSION,
            data_dir=data_dir.resolve(),
            cors_origins=_env_list(source, "BF_CORS_ORIGINS", "*"),
            trusted_hosts=_env_list(source, "BF_TRUSTED_HOSTS", "*"),
            host=_env_str(source, "BF_HOST", "127.0.0.1"),
            port=_env_int(source, "BF_PORT", 8088, minimum=1),
            max_layers=_env_int(source, "BF_MAX_LAYERS", 10_000, minimum=1),
            max_skin_data_url_chars=_env_int(source, "BF_MAX_SKIN_DATA_URL_CHARS", 32_000_000, minimum=1),
            max_base_image_bytes=_env_int(source, "BF_MAX_BASE_IMAGE_BYTES", 134_217_728, minimum=1),
            max_doc_size=_env_int(source, "BF_MAX_DOC_SIZE", 65_536, minimum=1),
            max_position=_env_int(source, "BF_MAX_POSITION", 10_000_000, minimum=0),
            min_layer_size=min_layer_size,
            max_layer_size=max_layer_size,
            max_avatar_name=_env_int(source, "BF_MAX_AVATAR_NAME", 512, minimum=1),
            max_json_body_bytes=_env_int(source, "BF_MAX_JSON_BODY_BYTES", 268_435_456, minimum=1),
            max_expiry_days=_env_int(source, "BF_MAX_EXPIRY_DAYS", 3650, minimum=1),
            auth_window_seconds=_env_int(source, "BF_AUTH_WINDOW_SECONDS", 60, minimum=1),
            auth_max_fails=_env_int(source, "BF_AUTH_MAX_FAILS", 20, minimum=1),
            draft_ttl_seconds=_env_int(source, "BF_DRAFT_TTL_SECONDS", _DAY_SECONDS, minimum=1),
            sweep_interval_seconds=_env_int(source, "BF_SWEEP_INTERVAL_SECONDS", 1800, minimum=0),
        )

    @property
    def db_path(self) -> Path:
        """SQLite 库就在数据目录根下，不再单独开一个变量（少一个能配错的地方）"""
        return self.data_dir / "bfp.sqlite3"

    @property
    def base_dir(self) -> Path:
        """底图字节目录：{BF_DATA_DIR}/base/{roomId}.{ext}"""
        return self.data_dir / "base"

    def public_config(self) -> dict[str, object]:
        """GET /api/config 的响应体（契约 2.8）：只回公开上限，不泄漏任何存储/路径信息"""
        return {
            "version": self.version,
            "expiryDays": [3, 7, 14, 30, 90],
            "maxExpiryDays": self.max_expiry_days,
            "maxLayers": self.max_layers,
            "maxBaseImageBytes": self.max_base_image_bytes,
            "maxSkinDataUrlChars": self.max_skin_data_url_chars,
            "maxJsonBodyBytes": self.max_json_body_bytes,
            "maxDocSize": self.max_doc_size,
            "minLayerSize": self.min_layer_size,
            "maxLayerSize": self.max_layer_size,
            "maxAvatarName": self.max_avatar_name,
            "maxPosition": self.max_position,
        }
