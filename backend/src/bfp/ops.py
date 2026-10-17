# BlockFace+ · 运维命令行（bfp-ops）
# Copyright 2026 Dainsleif · Apache License 2.0
#
# 为什么要有个 CLI：这套后端把状态放在"SQLite + 文件"里，出问题时最需要的是
# "现在到底有哪些房间、哪间房的底图文件没了、能不能立刻清一遍过期房"。
# 这些动作不该逼运维去手写 SQL 或者重启服务。
#
# 它复用服务本身的 config/db/storage/sweep —— 命令行和后台任务共用一套判据，
# 不会出现"后台这么删、手动那么删"的两套真相。
#
# 只有四个子命令，而且 delete 必须显式 --yes：删房间不可恢复，防手滑。

from __future__ import annotations

import argparse
import asyncio
import contextlib
import json
import os
import sys
from collections.abc import Sequence
from datetime import datetime
from typing import Any

from .config import DEFAULT_VERSION, Settings
from .db import Database
from .previews import render_preview
from .security import now_ms
from .storage import base_image_path, preview_file, preview_meta
from .sweep import SweepResult, delete_room, sweep_once, sweep_preview

__all__ = ["main"]


def _fmt_time(ms: int | None) -> str:
    if not ms:
        return "-"
    return datetime.fromtimestamp(ms / 1000).strftime("%Y-%m-%d %H:%M:%S")


def _dump(payload: Any) -> None:
    print(json.dumps(payload, ensure_ascii=False, indent=2))


def _build_parser() -> argparse.ArgumentParser:
    # 全局参数用 parents 挂到每个子命令上：`bfp-ops --data-dir X list` 与
    # `bfp-ops list --data-dir X` 都能用，运维不用记参数该放哪边
    common = argparse.ArgumentParser(add_help=False)
    # default=SUPPRESS 不是洁癖，是必须的：子解析器会把**自己那套默认值**整份盖回父命名空间，
    # 于是 `bfp-ops --data-dir X list` 里的 X 会被子命令的 data_dir=None 冲掉，
    # 静默退回到默认数据目录（症状是"命令成功、但操作的是另一个库"）。
    # SUPPRESS 让子命令在没显式给参数时不碰这个属性，父级解析出来的值才留得住。
    common.add_argument(
        "--data-dir",
        metavar="DIR",
        default=argparse.SUPPRESS,
        help="覆盖 BF_DATA_DIR（默认 ./data，相对 backend/ 解析）",
    )

    parser = argparse.ArgumentParser(
        prog="bfp-ops",
        description="BlockFace+ 协同后端运维工具（直接操作 SQLite 与底图文件）",
    )
    parser.add_argument("--version", action="version", version=f"bfp-ops {DEFAULT_VERSION}")
    parser.add_argument("--data-dir", metavar="DIR", help="覆盖 BF_DATA_DIR（默认 ./data，相对 backend/ 解析）")
    sub = parser.add_subparsers(dest="command", required=True, metavar="命令")

    p_list = sub.add_parser("list", parents=[common], help="列出所有房间")
    p_list.add_argument("--json", action="store_true", dest="as_json", help="以 JSON 输出，便于脚本消费")

    p_inspect = sub.add_parser("inspect", parents=[common], help="查看单个房间详情")
    p_inspect.add_argument("room_id", metavar="roomId", help="房间号")
    p_inspect.add_argument("--json", action="store_true", dest="as_json", help="以 JSON 输出")

    p_delete = sub.add_parser("delete", parents=[common], help="删除房间（不可恢复）")
    p_delete.add_argument("room_id", metavar="roomId", help="房间号")
    p_delete.add_argument("--yes", action="store_true", help="确认删除，不加这个开关会拒绝执行")

    p_sweep = sub.add_parser("sweep", parents=[common], help="立即清扫过期房间与超时草稿房")
    p_sweep.add_argument("--dry-run", action="store_true", help="只统计会删哪些，不真的删")

    p_previews = sub.add_parser("previews", parents=[common], help="为已有房间补生成预览底图")
    p_previews.add_argument("--dry-run", action="store_true", dest="dry_run", help="只统计需要补几间，不真的生成")
    p_previews.add_argument("--force", action="store_true", help="连已经有预览的房间也重建一遍")
    return parser


async def _cmd_list(db: Database, settings: Settings, args: argparse.Namespace) -> int:
    moment = now_ms()
    rows = await db.fetchall(
        "SELECT r.room_id AS room_id, r.created_at AS created_at, r.expires_at AS expires_at, "
        "b.status AS status, b.width AS width, b.height AS height, b.ext AS ext, "
        "(SELECT COUNT(*) FROM avatars a WHERE a.room_id = r.room_id) AS layers "
        "FROM rooms r LEFT JOIN room_base b ON b.room_id = r.room_id "
        "ORDER BY r.created_at DESC"
    )
    rooms_payload = [
        {
            "roomId": row["room_id"],
            "status": row["status"] or "draft",
            "layers": row["layers"],
            "doc": {"width": row["width"] or 0, "height": row["height"] or 0},
            "createdAt": row["created_at"],
            "expiresAt": row["expires_at"],
            "expired": row["expires_at"] < moment,
        }
        for row in rows
    ]
    if args.as_json:
        _dump({"dataDir": str(settings.data_dir), "count": len(rooms_payload), "rooms": rooms_payload})
        return 0
    print(f"数据目录 {settings.data_dir} —— 共 {len(rooms_payload)} 间房")
    if not rooms_payload:
        return 0
    print("房间号        状态   层数   创建时间             过期时间")
    for item in rooms_payload:
        expired = "  [已过期]" if item["expired"] else ""
        print(
            f"{item['roomId']:<12}  {item['status']:<5}  {item['layers']:>4}   "
            f"{_fmt_time(item['createdAt'])}  {_fmt_time(item['expiresAt'])}{expired}"
        )
    return 0


async def _cmd_inspect(db: Database, settings: Settings, args: argparse.Namespace) -> int:
    room_id = args.room_id
    room = await db.fetchone("SELECT * FROM rooms WHERE room_id = ?", (room_id,))
    if room is None:
        if args.as_json:
            _dump({"roomId": room_id, "found": False})
        else:
            print(f"房间 {room_id} 不存在", file=sys.stderr)
        return 1
    base_row = await db.fetchone("SELECT * FROM room_base WHERE room_id = ?", (room_id,))
    layers = await db.fetchone("SELECT COUNT(*) AS n FROM avatars WHERE room_id = ?", (room_id,))
    throttle = await db.fetchone("SELECT * FROM room_throttle WHERE room_id = ?", (room_id,))
    moment = now_ms()
    file_path = (
        base_image_path(settings, room_id, base_row["ext"]) if base_row is not None else settings.base_dir / room_id
    )
    # 预览同样走 storage 里那个唯一判定：运维看到的"有预览"必须就是下载真的会发的那一份，
    # 不然排查"前端说有预览、实际拿到原图"时会被第二套口径带偏。
    preview = preview_meta(base_row)
    if preview is not None:
        available = preview_file(settings, room_id, base_row)
        preview = {
            **preview,
            "path": str(available[0]) if available is not None else None,
            "exists": available is not None,
        }
    payload = {
        "roomId": room_id,
        "found": True,
        "createdAt": room["created_at"],
        "expiresAt": room["expires_at"],
        "expired": room["expires_at"] < moment,
        "status": base_row["status"] if base_row is not None else "draft",
        "doc": {
            "width": base_row["width"] if base_row is not None else 0,
            "height": base_row["height"] if base_row is not None else 0,
        },
        "baseImage": (
            {
                "name": base_row["name"],
                "type": base_row["type"],
                "ext": base_row["ext"],
                "path": str(file_path),
                "exists": file_path.is_file(),
                "bytes": file_path.stat().st_size if file_path.is_file() else 0,
                # 预览是给非管理员的：这里一并回出来，方便判断"老房间要不要跑 previews"。
                # exists=false 就是"库里有声明、盘上没文件"那类脏状态，非管理员此刻拿的是原图。
                "preview": preview,
            }
            if base_row is not None
            else None
        ),
        "layers": layers["n"] if layers is not None else 0,
        # 密码本身不可恢复（只存 scrypt 哈希），这里只回长度，方便判断密码是哪一把
        "passwordLengths": {
            "editor": room["edit_password_length"],
            "admin": room["admin_password_length"],
        },
        "throttle": (
            {
                "windowStart": throttle["window_start"],
                "failCount": throttle["fail_count"],
                "lockedUntil": throttle["locked_until"],
                "locked": bool(throttle["locked_until"] and throttle["locked_until"] > moment),
            }
            if throttle is not None
            else None
        ),
    }
    if args.as_json:
        _dump(payload)
        return 0
    print(f"房间 {room_id}")
    print(f"  创建时间   {_fmt_time(payload['createdAt'])}")
    print(f"  过期时间   {_fmt_time(payload['expiresAt'])}{'  [已过期]' if payload['expired'] else ''}")
    print(f"  状态       {payload['status']}")
    print(f"  画布       {payload['doc']['width']} x {payload['doc']['height']}")
    print(f"  头像行数   {payload['layers']}")
    print(f"  密码长度   编辑 {payload['passwordLengths']['editor']} 位 / 管理员 {payload['passwordLengths']['admin']} 位")
    base_info = payload["baseImage"]
    if base_info is None:
        print("  底图       无记录")
    else:
        state = f"{base_info['bytes']} 字节" if base_info["exists"] else "文件缺失（库里指针还在）"
        print(f"  底图       {base_info['name']} [{base_info['type']}] -> {base_info['path']} ({state})")
        preview_info = base_info["preview"]
        if preview_info is None:
            print("  预览       无（非管理员也拿原图）")
        elif not preview_info["exists"]:
            print(f"  预览       库里声明了 {preview_info['ext']}，但文件不在盘上（非管理员此刻拿原图）")
        else:
            print(f"  预览       {preview_info['width']}x{preview_info['height']} [{preview_info['type']}]")
    throttle_info = payload["throttle"]
    if throttle_info is None:
        print("  限流       无失败记录")
    else:
        lock = f"锁定至 {_fmt_time(throttle_info['lockedUntil'])}" if throttle_info["locked"] else "未锁定"
        print(f"  限流       窗口内失败 {throttle_info['failCount']} 次，{lock}")
    return 0


async def _cmd_delete(db: Database, settings: Settings, args: argparse.Namespace) -> int:
    room_id = args.room_id
    room = await db.fetchone("SELECT room_id FROM rooms WHERE room_id = ?", (room_id,))
    if room is None:
        print(f"房间 {room_id} 不存在，无需删除", file=sys.stderr)
        return 1
    await delete_room(db, settings, room_id)
    print(f"已删除房间 {room_id}（库里的行与 base/ 下的底图字节都已清空）")
    return 0


async def _cmd_sweep(db: Database, settings: Settings, args: argparse.Namespace) -> int:
    if args.dry_run:
        result: SweepResult = await sweep_preview(db, settings)
        print(f"[dry-run] 会删除 {result.expired} 间过期房、{result.drafts} 间超时草稿房（共 {result.expired + result.drafts} 间）")
        return 0
    result = await sweep_once(db, settings)
    print(str(result))
    return 0


async def _cmd_previews(db: Database, settings: Settings, args: argparse.Namespace) -> int:
    """给已有房间补预览图。

    加预览是纯增量功能：老房间的 preview_* 是 NULL，非管理员会直接拿原图。
    不跑这个命令功能不会坏，只是省不下老房间的带宽。
    """
    if settings.base_preview_max_edge <= 0:
        print("BF_BASE_PREVIEW_MAX_EDGE = 0（预览已关闭），无需补生成")
        return 0

    rows = await db.fetchall(
        "SELECT room_id, ext, preview_ext, updated_at FROM room_base WHERE status = 'ready' ORDER BY room_id"
    )
    pending = [row for row in rows if args.force or not row["preview_ext"]]
    if args.dry_run:
        print(f"[dry-run] 共 {len(rows)} 间已就绪房间，其中 {len(pending)} 间需要补预览")
        return 0

    done = skipped = missing = failed = 0
    for row in pending:
        room_id = row["room_id"]
        source = base_image_path(settings, room_id, row["ext"])
        if not source.is_file():
            missing += 1
            print(f"  {room_id}：原图文件缺失，跳过", file=sys.stderr)
            continue
        try:
            result = await asyncio.to_thread(render_preview, source, settings, room_id)
        except Exception:  # noqa: BLE001 —— 一间房失败不该让整批复停下
            failed += 1
            print(f"  {room_id}：生成失败", file=sys.stderr)
            continue
        if result is None:
            skipped += 1
            continue
        async with db.transaction() as conn:
            # updated_at 做守卫：生成预览要解一张几十 MiB 的图，这期间管理员可能已经换了底图。
            # 不加守卫就会把旧图的预览尺寸写到新图那一行上（base.py 写预览元数据时同样带这个守卫）。
            cursor = await conn.execute(
                "UPDATE room_base SET preview_ext = ?, preview_type = ?, preview_width = ?, "
                "preview_height = ? WHERE room_id = ? AND updated_at = ?",
                (result.ext, result.mime, result.width, result.height, room_id, row["updated_at"]),
            )
            swapped = cursor.rowcount == 0
        if swapped:
            # 影响行数为 0 = 期间有人换了底图（或房间没了）：这一份预览不属于当前底图，跳过。
            # 文件本身留在盘上是无害的 —— 它会被下一轮 previews / 下一次上传覆盖掉。
            skipped += 1
            print(f"  {room_id}：生成期间底图已被更换，跳过", file=sys.stderr)
            continue
        done += 1
        print(f"  {room_id}：{result.width}x{result.height} {result.ext}")

    print(f"补生成完成：成功 {done} 间，跳过 {skipped} 间，文件缺失 {missing} 间，失败 {failed} 间")
    return 0 if failed == 0 and missing == 0 else 1


async def _dispatch(args: argparse.Namespace, settings: Settings) -> int:
    settings.base_dir.mkdir(parents=True, exist_ok=True)
    db = Database(settings.db_path)
    await db.connect()
    try:
        if args.command == "list":
            return await _cmd_list(db, settings, args)
        if args.command == "inspect":
            return await _cmd_inspect(db, settings, args)
        if args.command == "delete":
            return await _cmd_delete(db, settings, args)
        if args.command == "sweep":
            return await _cmd_sweep(db, settings, args)
        if args.command == "previews":
            return await _cmd_previews(db, settings, args)
        return 2
    finally:
        await db.close()


def main(argv: Sequence[str] | None = None) -> int:
    """bfp-ops 入口。返回退出码：0 成功、1 目标不存在、2 用法错误。"""
    # 运维终端千奇百怪（Windows 的 cp936、容器里的 POSIX locale）：中文输出编码不了时
    # 退化成问号，别让一条打印语句把清理任务本身搞崩
    for stream in (sys.stdout, sys.stderr):
        with contextlib.suppress(Exception):
            stream.reconfigure(errors="replace")
    parser = _build_parser()
    args = parser.parse_args(argv)
    if args.command == "delete" and not args.yes:
        print("拒绝执行：删除房间不可恢复，确认请加 --yes", file=sys.stderr)
        return 2
    env = dict(os.environ)
    if args.data_dir:
        env["BF_DATA_DIR"] = args.data_dir
    settings = Settings.from_env(env)
    return asyncio.run(_dispatch(args, settings))


if __name__ == "__main__":
    raise SystemExit(main())
