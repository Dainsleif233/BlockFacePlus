# BlockFace+ · 建房 / 进房 / 删房 / 过期
# Copyright 2026 Dainsleif · Apache License 2.0

from __future__ import annotations

import re
import time

from conftest import JPEG_BYTES, draft, pwd, room_body

from bfp.security import now_ms

PASSWORD_ALPHABET = set("23456789abcdefghjkmnpqrstuvwxyz")
ROOM_ID_RE = re.compile("^[A-Za-z0-9_-]{6,64}$")
DAY_MS = 86_400_000


async def test_create_room_returns_room_id_and_passwords_once(harness):
    before = int(time.time() * 1000)
    response = await harness.create(expires_days=7)
    after = int(time.time() * 1000)
    assert response.status_code == 201, response.text
    data = response.json()

    assert ROOM_ID_RE.match(data["roomId"])
    assert len(data["editPassword"]) == 8
    assert len(data["adminPassword"]) == 12
    assert set(data["editPassword"]) <= PASSWORD_ALPHABET
    assert set(data["adminPassword"]) <= PASSWORD_ALPHABET
    # 毫秒整数、与前端 Date.now() 同口径
    assert before + 7 * DAY_MS <= data["expiresAt"] <= after + 7 * DAY_MS
    assert set(data) == {"roomId", "editPassword", "adminPassword", "expiresAt"}


async def test_passwords_are_only_stored_as_scrypt_hashes(harness):
    room_id, edit_password, admin_password = await harness.create_ok()
    row = await harness.db.fetchone("SELECT * FROM rooms WHERE room_id = ?", (room_id,))
    for column, plain in (("edit_password_hash", edit_password), ("admin_password_hash", admin_password)):
        stored = row[column]
        assert stored.startswith("scrypt$16384$8$1$"), stored
        assert plain not in stored
        assert len(stored.split("$")) == 6
    assert row["edit_password_length"] == 8
    assert row["admin_password_length"] == 12

    # 进房响应里绝不能出现密码（只有创建那一次回传）
    snapshot = await harness.client.get(f"/api/rooms/{room_id}", headers=pwd(edit_password))
    assert "Password" not in snapshot.text


async def test_create_rejects_missing_or_invalid_base_image(harness):
    missing = await harness.client.post("/api/rooms", json={"layers": [draft("l1")], "expiresDays": 7})
    assert missing.status_code == 400
    assert missing.json()["error"] == "缺少底图信息"

    bad_type = await harness.create(image={"name": "x", "type": "image/svg+xml", "width": 10, "height": 10})
    assert bad_type.status_code == 400
    assert bad_type.json()["error"] == "底图只支持 PNG / JPG / WebP / GIF"

    # __proto__/constructor 这类旧实现踩过的键，必须同样落到白名单之外
    for weird in ("constructor", "__proto__", "toString"):
        response = await harness.create(image={"name": "x", "type": weird, "width": 10, "height": 10})
        assert response.status_code == 400, weird

    for width, height in ((0, 10), (10, 0), (-1, 10), (999999, 10), ("abc", 10)):
        response = await harness.create(image={"name": "x", "type": "image/png", "width": width, "height": height})
        assert response.status_code == 400, (width, height)
        assert response.json()["error"] == "底图尺寸不合法"


async def test_create_rejects_layer_problems(harness):
    empty = await harness.create(layers=[])
    assert empty.status_code == 400
    assert empty.json()["error"] == "至少要先摆一个头像再发布"

    # 注意：size 传 "不是数字" 是**合法**的 —— 与 JS 的 Number() 口径一致，会回落到默认 256。
    # 真正不合法的是整条不是对象、或 id 不符合 LAYER_ID_RE。
    invalid = await harness.create(layers=[draft("l1"), "这不是一行头像"])
    assert invalid.status_code == 400
    assert "第 2 个头像" in invalid.json()["error"]

    fallback = await harness.create(layers=[draft("l1", size="不是数字")])
    assert fallback.status_code == 201
    room_id = fallback.json()["roomId"]
    body = (await harness.client.get(f"/api/rooms/{room_id}", headers=pwd(fallback.json()["editPassword"]))).json()
    assert body["avatars"][0]["size"] == 256

    bad_id = await harness.create(layers=[draft("l1"), draft("有中文的id")])
    assert bad_id.status_code == 400

    duplicated = await harness.create(layers=[draft("l1"), draft("l1")])
    assert duplicated.status_code == 400
    assert duplicated.json()["error"] == "头像 id 重复"


async def test_create_only_accepts_the_three_expiry_options(harness):
    """过期天数是白名单 3/7/14，不是区间 —— 与旧云函数的 has() 判断、UI 的三个按钮一致"""
    for days in (0, -1, 1, 15, 30, 90, 3650, 3.5, "abc", None, 1.5e9):
        response = await harness.create(expires_days=days)
        assert response.status_code == 400, days
        assert response.json()["error"] == "过期天数只能是 3 / 7 / 14 天"

    # 干脆不带这个字段也走同一条 400，而不是 500
    body = room_body()
    body.pop("expiresDays")
    missing = await harness.client.post("/api/rooms", json=body)
    assert missing.status_code == 400
    assert missing.json()["error"] == "过期天数只能是 3 / 7 / 14 天"

    for days in (3, 7, 14):
        assert (await harness.create(expires_days=days)).status_code == 201


async def test_create_enforces_max_layers_from_env(open_harness, tmp_path):
    async with open_harness(tmp_path, BF_MAX_LAYERS="2") as harness:
        ok = await harness.create(layers=[draft("l1"), draft("l2")])
        assert ok.status_code == 201
        too_many = await harness.create(layers=[draft("l1"), draft("l2"), draft("l3")])
        assert too_many.status_code == 400
        assert "头像最多 2 个" == too_many.json()["error"]


async def test_create_rejects_oversized_json_body(open_harness, tmp_path):
    async with open_harness(tmp_path, BF_MAX_JSON_BODY_BYTES="128") as harness:
        response = await harness.create()
        assert response.status_code == 413
        assert response.json()["error"] == "请求体太大"


async def test_get_room_snapshot_for_draft(harness):
    room_id, edit_password, admin_password = await harness.create_ok(
        layers=[draft("later", order=5), draft("first", order=0, name="第一个")]
    )

    as_admin = await harness.client.get(f"/api/rooms/{room_id}", headers=pwd(admin_password))
    assert as_admin.status_code == 200
    body = as_admin.json()
    assert body["role"] == "admin"
    assert body["room"]["roomId"] == room_id
    # 草稿态：底图还没传，baseImage 为 null；画布尺寸是建房时声明的那个
    assert body["room"]["status"] == "draft"
    assert body["room"]["baseImage"] is None
    assert body["room"]["doc"] == {"width": 1920, "height": 1080}
    # 按 order 升序
    assert [avatar["id"] for avatar in body["avatars"]] == ["first", "later"]
    assert body["avatars"][0]["name"] == "第一个"
    assert body["avatars"][0]["skin"] is None
    assert body["avatars"][0]["skinUpdatedAt"] == body["avatars"][0]["layoutUpdatedAt"]

    as_editor = await harness.client.get(f"/api/rooms/{room_id}", headers=pwd(edit_password))
    assert as_editor.status_code == 200
    assert as_editor.json()["role"] == "editor"


async def test_get_room_not_found_and_invalid_ids(harness):
    for room_id in ("abcdefghijkl", "abc", "a" * 65, "bad!id!!"):
        response = await harness.client.get(f"/api/rooms/{room_id}", headers=pwd("whatever1"))
        assert response.status_code == 404, room_id
        assert response.json()["error"] == "房间不存在或已被删除"


async def test_room_id_from_url_cannot_escape_the_data_dir(harness):
    """房间号要拼进 SQL 与文件路径，所以非法 id 必须在触库之前就被拒掉"""
    for path in ("/api/rooms/..%2F..%2Fetc", "/api/rooms/%2e%2e", "/api/rooms/a%2Fb%2Fc"):
        response = await harness.client.get(path, headers=pwd("whatever1"))
        assert response.status_code == 404, path


async def test_delete_room_requires_admin_and_wipes_everything(harness):
    room_id, edit_password, admin_password = await harness.create_ok()
    assert (await harness.upload(room_id, admin_password, content=JPEG_BYTES)).status_code == 200
    assert harness.base_files(room_id) == [f"{room_id}.jpg"]

    forbidden = await harness.client.delete(f"/api/rooms/{room_id}", headers=pwd(edit_password))
    assert forbidden.status_code == 403
    assert forbidden.json()["error"] == "只有管理员能删除房间"

    deleted = await harness.client.delete(f"/api/rooms/{room_id}", headers=pwd(admin_password))
    assert deleted.status_code == 200
    assert deleted.json() == {"ok": True}

    # 行与字节都清干净
    assert await harness.db.fetchone("SELECT 1 FROM rooms WHERE room_id = ?", (room_id,)) is None
    assert await harness.db.fetchone("SELECT 1 FROM room_base WHERE room_id = ?", (room_id,)) is None
    assert await harness.db.fetchone("SELECT 1 FROM avatars WHERE room_id = ?", (room_id,)) is None
    assert await harness.db.fetchone("SELECT 1 FROM room_throttle WHERE room_id = ?", (room_id,)) is None
    assert harness.all_base_files() == []

    assert (await harness.client.get(f"/api/rooms/{room_id}", headers=pwd(admin_password))).status_code == 404


async def test_expired_room_is_deleted_in_place_and_returns_410(harness):
    room_id, edit_password, admin_password = await harness.create_ok()
    async with harness.db.transaction() as conn:
        await conn.execute("UPDATE rooms SET expires_at = ? WHERE room_id = ?", (now_ms() - 1, room_id))

    gone = await harness.client.get(f"/api/rooms/{room_id}", headers=pwd(admin_password))
    assert gone.status_code == 410
    assert gone.json()["error"] == "房间已过期"
    # 就地删房：第二次来就是 404 了
    assert (await harness.client.get(f"/api/rooms/{room_id}", headers=pwd(edit_password))).status_code == 404

    # 其它入口同样走过期分支。注意：读路径会**就地删房**，所以每个入口各用一间新房
    async def expired_room() -> tuple[str, str, str]:
        rid, edit, admin = await harness.create_ok()
        async with harness.db.transaction() as conn:
            await conn.execute("UPDATE rooms SET expires_at = ? WHERE room_id = ?", (now_ms() - 1, rid))
        return rid, edit, admin

    rid, _edit, admin = await expired_room()
    assert (await harness.client.delete(f"/api/rooms/{rid}", headers=pwd(admin))).status_code == 410
    rid, edit, _admin = await expired_room()
    assert (
        await harness.client.patch(f"/api/rooms/{rid}/avatars", headers=pwd(edit), json={"updates": []})
    ).status_code == 410
    rid, _edit, admin = await expired_room()
    assert (await harness.client.get(f"/api/rooms/{rid}/base", headers=pwd(admin))).status_code == 410
    rid, _edit, admin = await expired_room()
    assert (await harness.upload(rid, admin)).status_code == 410


async def test_default_data_dir_lives_under_backend(monkeypatch):
    """相对 BF_DATA_DIR 一律相对 backend/ 解析：默认值不能随 cwd 乱飘"""
    from bfp.config import BACKEND_DIR, Settings

    settings = Settings.from_env({})
    assert settings.data_dir == (BACKEND_DIR / "data").resolve()
    assert settings.db_path == settings.data_dir / "bfp.sqlite3"
    assert settings.base_dir == settings.data_dir / "base"
