# BlockFace+ · 密码生成 / scrypt 校验 / 失败限流
# Copyright 2026 Dainsleif · Apache License 2.0
#
# 密码只在创建响应里出现一次，此后任何接口都不回传；落库只存 scrypt 哈希。
#
# 三个刻意的设计：
#  1. 校验先看长度 —— 编辑 8 位、管理员 12 位，长度对不上的那把根本不去算 scrypt。
#     于是"乱长度"的尝试是零成本，"可能是真的"的尝试只需要一次派生。
#  2. scrypt 是纯 CPU 的阻塞调用（n=16384 一次约几十毫秒），必须丢进线程池，
#     否则一个改密码请求就能把整个事件循环钉住，所有人的请求一起卡。
#  3. 限流状态落库、按房间算：放内存里等于没写（进程一重启就清零），
#     按 IP 算会连坐同一个 NAT 后面的所有人。

from __future__ import annotations

import asyncio
import hashlib
import hmac
import logging
import math
import secrets
import time
from typing import Any

from .config import Settings
from .db import Database
from .errors import BAD_PASSWORD, TOO_MANY_FAILS, ApiError

__all__ = [
    "ADMIN_PASSWORD_LENGTH",
    "EDIT_PASSWORD_LENGTH",
    "authenticate",
    "check_password",
    "generate_admin_password",
    "generate_edit_password",
    "generate_room_id",
    "hash_password",
    "now_ms",
    "verify_password",
]

log = logging.getLogger("bfp.security")

# 去掉 0/1/l/o 这类肉眼易混的字符，抄写不出错
PASSWORD_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz"
EDIT_PASSWORD_LENGTH = 8
ADMIN_PASSWORD_LENGTH = 12
PASSWORD_MAX_LENGTH = 128

# scrypt 参数：写进哈希串里，将来调参了老房间照样能验
SCRYPT_N = 16384
SCRYPT_R = 8
SCRYPT_P = 1
SCRYPT_DKLEN = 32
SALT_BYTES = 16

# 房间号字符集：token_urlsafe 的字母表正好是它，所以第一把就必然合法
ROOM_ID_BYTES = 9
_ROOM_ID_ALPHABET = frozenset("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-")
_ROOM_ID_MIN = 6
_ROOM_ID_MAX = 64


def now_ms() -> int:
    """毫秒整数时间戳：前端和契约里的 createdAt / expiresAt / 版本戳全是这个口径"""
    return int(time.time() * 1000)


def generate_room_id() -> str:
    """secrets.token_urlsafe(9) → 12 个字符；再兜一道正则，保证永远符合 ^[A-Za-z0-9_-]{6,64}$"""
    while True:
        candidate = secrets.token_urlsafe(ROOM_ID_BYTES)
        if _ROOM_ID_MIN <= len(candidate) <= _ROOM_ID_MAX and all(c in _ROOM_ID_ALPHABET for c in candidate):
            return candidate


def _random_password(length: int) -> str:
    """拒绝采样：256 不能被 31 整除，直接取模会有极轻微偏斜"""
    out: list[str] = []
    alphabet = PASSWORD_ALPHABET
    limit = 256 - (256 % len(alphabet))
    while len(out) < length:
        for byte in secrets.token_bytes(length * 2):
            if byte < limit:
                out.append(alphabet[byte % len(alphabet)])
                if len(out) == length:
                    break
    return "".join(out)


def generate_edit_password() -> str:
    return _random_password(EDIT_PASSWORD_LENGTH)


def generate_admin_password() -> str:
    return _random_password(ADMIN_PASSWORD_LENGTH)


def _scrypt_hex(password: str, salt_hex: str, n: int, r: int, p: int, dklen: int) -> str:
    digest = hashlib.scrypt(
        password.encode("utf-8"),
        salt=bytes.fromhex(salt_hex),
        n=n,
        r=r,
        p=p,
        dklen=dklen,
    )
    return digest.hex()


async def hash_password(password: str) -> str:
    """返回 scrypt$n$r$p$<salt_hex>$<hash_hex>"""
    salt_hex = secrets.token_bytes(SALT_BYTES).hex()
    digest_hex = await asyncio.to_thread(_scrypt_hex, password, salt_hex, SCRYPT_N, SCRYPT_R, SCRYPT_P, SCRYPT_DKLEN)
    return f"scrypt${SCRYPT_N}${SCRYPT_R}${SCRYPT_P}${salt_hex}${digest_hex}"


def _parse_stored(stored: str) -> tuple[int, int, int, str, str] | None:
    parts = stored.split("$")
    if len(parts) != 6 or parts[0] != "scrypt":
        return None
    try:
        n, r, p = int(parts[1]), int(parts[2]), int(parts[3])
    except ValueError:
        return None
    if n <= 1 or r <= 0 or p <= 0 or not parts[4] or not parts[5]:
        return None
    return n, r, p, parts[4], parts[5]


async def verify_password(password: str, stored: str | None) -> bool:
    if not isinstance(stored, str):
        return False
    parsed = _parse_stored(stored)
    if parsed is None:
        return False
    n, r, p, salt_hex, expected_hex = parsed
    try:
        expected = bytes.fromhex(expected_hex)
    except ValueError:
        return False
    if not expected or len(salt_hex) % 2:
        return False
    try:
        actual_hex = await asyncio.to_thread(_scrypt_hex, password, salt_hex, n, r, p, len(expected))
    except ValueError:  # 盐不是合法十六进制等：当成验不过，别把 500 抛给调用方
        return False
    # compare_digest 防时序侧信道：先比字节再比长度，长度不等直接 False
    return len(actual_hex) == len(expected_hex) and hmac.compare_digest(actual_hex, expected_hex)


async def check_password(
    password: Any,
    *,
    admin_hash: str,
    admin_length: int,
    edit_hash: str,
    edit_length: int,
) -> str | None:
    """校验密码并给出角色：'admin' / 'editor' / None。长度先过一道筛，见文件头"""
    if not isinstance(password, str) or not password or len(password) > PASSWORD_MAX_LENGTH:
        return None
    if len(password) == admin_length and await verify_password(password, admin_hash):
        return "admin"
    if len(password) == edit_length and await verify_password(password, edit_hash):
        return "editor"
    return None


async def authenticate(db: Database, settings: Settings, room: Any, password: str) -> str:
    """鉴权 + 限流。密码错一律 401，房间不存在是 404（由 require_room 先抛），不泄漏更多细节。"""
    room_id = room["room_id"]
    now = now_ms()
    throttle = await db.fetchone(
        "SELECT window_start, fail_count, locked_until FROM room_throttle WHERE room_id = ?",
        (room_id,),
    )
    locked_until = throttle["locked_until"] if throttle is not None else None
    if locked_until is not None and now < locked_until:
        # 锁上了就地拒绝：这一条不跑 scrypt，也就没有 CPU 可刷
        remain = max(1, math.ceil((locked_until - now) / 1000))
        raise ApiError(429, TOO_MANY_FAILS.format(remain))

    role = await check_password(
        password,
        admin_hash=room["admin_password_hash"],
        admin_length=room["admin_password_length"],
        edit_hash=room["edit_password_hash"],
        edit_length=room["edit_password_length"],
    )
    if role is None:
        await _note_auth_failure(db, settings, room_id, now)
        raise ApiError(401, BAD_PASSWORD)
    return role


async def _note_auth_failure(db: Database, settings: Settings, room_id: str, now: int) -> None:
    """记一次失败。限流本身写不进去不该把登录请求打成 500，所以这里自己吞异常。"""
    window_ms = settings.auth_window_seconds * 1000
    try:
        async with db.transaction() as conn:
            row = await (
                await conn.execute(
                    "SELECT window_start, fail_count FROM room_throttle WHERE room_id = ?",
                    (room_id,),
                )
            ).fetchone()
            in_window = row is not None and now - row["window_start"] < window_ms
            count = (row["fail_count"] if in_window else 0) + 1
            if count >= settings.auth_max_fails:
                # 锁一个窗口；window_start 一起拨到现在，锁过期后计数自然从 1 重新开始
                await conn.execute(
                    "INSERT INTO room_throttle (room_id, window_start, fail_count, locked_until) "
                    "VALUES (?, ?, ?, ?) "
                    "ON CONFLICT (room_id) DO UPDATE SET window_start = excluded.window_start, "
                    "fail_count = excluded.fail_count, locked_until = excluded.locked_until",
                    (room_id, now, count, now + window_ms),
                )
            else:
                await conn.execute(
                    "INSERT INTO room_throttle (room_id, window_start, fail_count, locked_until) "
                    "VALUES (?, ?, ?, NULL) "
                    "ON CONFLICT (room_id) DO UPDATE SET window_start = excluded.window_start, "
                    "fail_count = excluded.fail_count, locked_until = NULL",
                    (room_id, row["window_start"] if in_window else now, count),
                )
    except Exception:  # 限流只是尽力而为，不能反过来把正常流程打挂
        log.warning("记录密码失败次数时出错（房间 %s），本次不计数", room_id, exc_info=True)
