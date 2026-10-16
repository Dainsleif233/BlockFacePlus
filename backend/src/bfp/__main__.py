# BlockFace+ · `python -m bfp` 自启（等价于 uv run uvicorn bfp.main:app）
# Copyright 2026 Dainsleif · Apache License 2.0
#
# 只在需要"一个进程搞定"的场合用它（比如本地随手起一个）；
# 生产用 systemd 时直接跑 uvicorn 命令行更好，日志、worker 数都更可控。
# 主机/端口默认取 BF_HOST / BF_PORT，命令行参数优先。
#
# 必须有真正的 argparse：uvicorn.run() 不吃 --help，早期版本会把
# `python -m bfp --help` 当成"没有参数"直接起一个服务，想查用法的人反而多出一个后台进程。

from __future__ import annotations

import argparse
from collections.abc import Sequence

import uvicorn

from .config import Settings
from .main import create_app

__all__ = ["build_parser", "main"]


def build_parser(settings: Settings) -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m bfp",
        description="启动 BlockFace+ 后端（等价于 uv run uvicorn bfp.main:app）",
    )
    parser.add_argument("--host", default=settings.host, help=f"监听地址，默认取 BF_HOST（当前 {settings.host}）")
    parser.add_argument(
        "--port", type=int, default=settings.port, help=f"监听端口，默认取 BF_PORT（当前 {settings.port}）"
    )
    return parser


def main(argv: Sequence[str] | None = None) -> None:
    settings = Settings.from_env()
    args = build_parser(settings).parse_args(argv)
    # 直接把 app 对象交给 uvicorn：这样进程里只有一份 Settings，
    # 不会出现"命令行用 A 配置、app 又按环境变量读成 B 配置"的分裂
    uvicorn.run(create_app(settings), host=args.host, port=args.port)


if __name__ == "__main__":
    main()
