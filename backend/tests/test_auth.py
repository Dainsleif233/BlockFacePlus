# BlockFace+ · 密码鉴权与失败限流
# Copyright 2026 Dainsleif · Apache License 2.0
#
# 盯的是契约第 1 节的状态码语义（401 密码不对 / 429 试错太频繁）与"按房间限流"。

from __future__ import annotations

import gc
import hashlib
import threading

from conftest import PNG_BYTES, pwd

from bfp.security import _AUTH_LOCKS, now_ms

WRONG = "wrong123"  # 8 位，长度与编辑密码一致，会真的跑一次 scrypt


async def test_wrong_or_missing_password_is_401_everywhere(harness):
    room_id, _edit, admin = await harness.create_ok()

    assert (await harness.client.get(f"/api/rooms/{room_id}", headers=pwd(WRONG))).status_code == 401
    assert (
        await harness.client.patch(f"/api/rooms/{room_id}/avatars", headers=pwd(WRONG), json={"updates": []})
    ).status_code == 401
    assert (await harness.client.get(f"/api/rooms/{room_id}/base", headers=pwd(WRONG))).status_code == 401
    assert (await harness.client.delete(f"/api/rooms/{room_id}", headers=pwd(WRONG))).status_code == 401
    assert (await harness.upload(room_id, WRONG)).status_code == 401

    # 没有 X-BF-Room-Pwd 头
    assert (await harness.client.get(f"/api/rooms/{room_id}")).status_code == 401
    # 长度不对（9 位）：同样 401，而且这一条连 scrypt 都不用跑
    assert (await harness.client.get(f"/api/rooms/{room_id}", headers=pwd("wrongpass9"))).status_code == 401

    body = (await harness.client.get(f"/api/rooms/{room_id}", headers=pwd(WRONG))).json()
    assert body["error"] == "密码不对"

    # 失败次数不该把正确密码也挡住（默认上限 20 次，上面一共失败 7 次）
    assert (await harness.client.get(f"/api/rooms/{room_id}", headers=pwd(admin))).status_code == 200


async def test_lockout_after_max_fails(open_harness, tmp_path):
    async with open_harness(tmp_path, BF_AUTH_MAX_FAILS="3", BF_AUTH_WINDOW_SECONDS="60") as harness:
        room_id, _edit, admin = await harness.create_ok()
        for _ in range(3):
            assert (await harness.client.get(f"/api/rooms/{room_id}", headers=pwd(WRONG))).status_code == 401

        locked = await harness.client.get(f"/api/rooms/{room_id}", headers=pwd(admin))
        assert locked.status_code == 429
        assert "秒后再来" in locked.json()["error"]

        # 锁着的时候连正确的密码也不放行；而且这一条不碰限流状态（说明没跑 scrypt 也没计数）
        row = await harness.db.fetchone("SELECT * FROM room_throttle WHERE room_id = ?", (room_id,))
        assert row["fail_count"] == 3
        assert row["locked_until"] > now_ms()
        assert (await harness.client.get(f"/api/rooms/{room_id}", headers=pwd(WRONG))).status_code == 429
        row_after = await harness.db.fetchone("SELECT * FROM room_throttle WHERE room_id = ?", (room_id,))
        assert row_after["fail_count"] == 3
        assert row_after["locked_until"] == row["locked_until"]


async def test_lock_expires_and_count_starts_over(open_harness, tmp_path):
    async with open_harness(tmp_path, BF_AUTH_MAX_FAILS="2", BF_AUTH_WINDOW_SECONDS="60") as harness:
        room_id, _edit, admin = await harness.create_ok()
        assert (await harness.client.get(f"/api/rooms/{room_id}", headers=pwd(WRONG))).status_code == 401
        assert (await harness.client.get(f"/api/rooms/{room_id}", headers=pwd(WRONG))).status_code == 401
        assert (await harness.client.get(f"/api/rooms/{room_id}", headers=pwd(admin))).status_code == 429

        # 把锁与窗口都拨到过去：等价于"等窗口过去"
        async with harness.db.transaction() as conn:
            await conn.execute(
                "UPDATE room_throttle SET locked_until = ?, window_start = ? WHERE room_id = ?",
                (now_ms() - 1, now_ms() - 61_000, room_id),
            )
        assert (await harness.client.get(f"/api/rooms/{room_id}", headers=pwd(admin))).status_code == 200

        # 窗口外的一次失败从 1 开始计数（不是接着上次的 2）
        assert (await harness.client.get(f"/api/rooms/{room_id}", headers=pwd(WRONG))).status_code == 401
        row = await harness.db.fetchone("SELECT * FROM room_throttle WHERE room_id = ?", (room_id,))
        assert row["fail_count"] == 1
        assert row["locked_until"] is None


async def test_throttle_is_per_room(open_harness, tmp_path):
    async with open_harness(tmp_path, BF_AUTH_MAX_FAILS="2") as harness:
        locked_room, _edit, _admin = await harness.create_ok()
        other_room, _edit2, other_admin = await harness.create_ok()

        assert (await harness.client.get(f"/api/rooms/{locked_room}", headers=pwd(WRONG))).status_code == 401
        assert (await harness.client.get(f"/api/rooms/{locked_room}", headers=pwd(WRONG))).status_code == 401
        assert (await harness.client.get(f"/api/rooms/{locked_room}", headers=pwd(other_admin))).status_code == 429
        # 另一间房完全不受影响：不能按 IP 连坐
        assert (await harness.client.get(f"/api/rooms/{other_room}", headers=pwd(other_admin))).status_code == 200


async def test_auth_locks_do_not_retain_deleted_room_ids(harness):
    room_id, _edit, admin = await harness.create_ok()
    assert (await harness.client.get(f"/api/rooms/{room_id}", headers=pwd(admin))).status_code == 200
    assert room_id not in _AUTH_LOCKS
    gc.collect()
    assert len(_AUTH_LOCKS) == 0


async def test_scrypt_derivation_runs_in_a_worker_thread(harness, monkeypatch):
    """scrypt 是阻塞的 CPU 活，必须丢出事件循环。

    不用墙钟计时来判断（那东西在 CI 上时快时慢、还分不清"并发"和"串行"），
    直接看派生发生在哪个线程：只要它落在工作线程里，事件循环就没被堵住。
    """
    seen: list[threading.Thread] = []
    real_scrypt = hashlib.scrypt

    def spy(*args, **kwargs):
        seen.append(threading.current_thread())
        return real_scrypt(*args, **kwargs)

    # bfp.security 里是"调用时查 hashlib.scrypt 属性"，所以补丁能生效
    monkeypatch.setattr(hashlib, "scrypt", spy)

    room_id, _edit, _admin = await harness.create_ok()  # 建房本身也要派生两次
    assert (await harness.client.get(f"/api/rooms/{room_id}", headers=pwd(WRONG))).status_code == 401
    assert len(seen) >= 3
    assert all(thread is not threading.main_thread() for thread in seen)


async def test_base_upload_needs_password_before_reading_body(harness):
    room_id, _edit, _admin = await harness.create_ok()
    response = await harness.client.post(
        f"/api/rooms/{room_id}/base",
        headers=pwd(WRONG),
        files={"file": ("b.png", PNG_BYTES, "image/png")},
        data={"name": "x", "width": "10", "height": "10"},
    )
    assert response.status_code == 401
    assert harness.all_base_files() == []
