# BlockFace+ · 底图上传与下载
# Copyright 2026 Dainsleif · Apache License 2.0
#
# 盯的是契约 2.5 / 2.6：只认 PNG/JPEG/WebP/GIF、边收边计数、超限 413 且不留半截文件、
# 同一间房同一后缀只有一个文件、下载时响应头齐全。

from __future__ import annotations

from urllib.parse import quote

from conftest import (
    GIF_BYTES,
    JPEG_BYTES,
    NOT_IMAGE_BYTES,
    PNG_BYTES,
    WEBP_BYTES,
    draft,
    pwd,
)

CRLF = bytes([13, 10])


def multipart_body(boundary: str, content: bytes, filename: str = "base.png", **fields: str) -> bytes:
    """手搓 multipart 体：用来测"没有 Content-Length 的 chunked 请求"这条路径"""
    chunks = []
    for key, value in fields.items():
        chunks.append(f"--{boundary}".encode() + CRLF)
        chunks.append(f'Content-Disposition: form-data; name="{key}"'.encode() + CRLF + CRLF)
        chunks.append(str(value).encode() + CRLF)
    chunks.append(f"--{boundary}".encode() + CRLF)
    chunks.append(f'Content-Disposition: form-data; name="file"; filename="{filename}"'.encode() + CRLF)
    chunks.append(b"Content-Type: image/png" + CRLF + CRLF)
    chunks.append(content + CRLF)
    chunks.append(f"--{boundary}--".encode() + CRLF)
    return b"".join(chunks)


async def test_malformed_multipart_is_400_not_500(harness):
    """畸形 multipart 必须是 400，不能一路冒到兜底处理器变成 500。

    回归用例：base.py 直接用 starlette 的 MultiPartParser（为了在读取阶段就计数、超限不落地），
    它抛的 MultiPartException 以前没人接，于是「客户端发错了」被报成「服务器开小差了」，
    调用方拿不到任何可行动的信息。下面三类都实测复现过 500。
    """
    room_id, edit, _admin = await harness.create_ok()
    headers = pwd(edit)

    # 1) 声明了 multipart 却没有 boundary
    no_boundary = await harness.client.post(
        f"/api/rooms/{room_id}/base",
        headers={**headers, "Content-Type": "multipart/form-data"},
        content=b"not-really-multipart",
    )
    assert no_boundary.status_code == 400, no_boundary.text
    assert "multipart" in no_boundary.json()["error"]

    # 2) 字段数超过 max_fields=8（第 9 个字段就把解析器顶掉）
    too_many_fields = await harness.client.post(
        f"/api/rooms/{room_id}/base",
        headers=headers,
        files=[(f"f{i}", (None, str(i))) for i in range(9)],
    )
    assert too_many_fields.status_code == 400, too_many_fields.text

    # 3) 文件数超过 max_files=1
    too_many_files = await harness.client.post(
        f"/api/rooms/{room_id}/base",
        headers=headers,
        files=[
            ("file", ("a.png", PNG_BYTES, "image/png")),
            ("file2", ("b.png", PNG_BYTES, "image/png")),
        ],
    )
    assert too_many_files.status_code == 400, too_many_files.text


async def test_base_is_conflict_until_uploaded(harness):
    room_id, edit, _admin = await harness.create_ok()
    response = await harness.client.get(f"/api/rooms/{room_id}/base", headers=pwd(edit))
    assert response.status_code == 409
    assert response.json()["error"] == "底图尚未上传完成"


async def test_upload_then_download_round_trip(harness):
    room_id, edit, _admin = await harness.create_ok()
    name = "我的 底图.png"

    uploaded = await harness.upload(room_id, edit, content=PNG_BYTES, name=name, width=800, height=600)
    assert uploaded.status_code == 200, uploaded.text
    assert uploaded.json() == {
        "ok": True,
        "doc": {"width": 800, "height": 600},
        "baseImage": {"name": name, "type": "image/png", "width": 800, "height": 600},
    }
    # 同一间房同一后缀只有一个文件
    assert harness.base_files(room_id) == [f"{room_id}.png"]

    room = (await harness.client.get(f"/api/rooms/{room_id}", headers=pwd(edit))).json()["room"]
    assert room["status"] == "ready"
    assert room["baseImage"] == {"name": name, "type": "image/png", "width": 800, "height": 600}
    assert room["doc"] == {"width": 800, "height": 600}

    downloaded = await harness.client.get(f"/api/rooms/{room_id}/base", headers=pwd(edit))
    assert downloaded.status_code == 200
    assert downloaded.content == PNG_BYTES
    assert downloaded.headers["content-type"] == "image/png"
    assert downloaded.headers["x-content-type-options"] == "nosniff"
    assert downloaded.headers["cache-control"] == "private, max-age=60"
    # 响应头不能是非 ASCII，所以文件名 percent-encoding（safe="" 连 / 也编码，与前端 decodeURIComponent 对齐）
    assert downloaded.headers["x-bf-base-name"] == quote(name, safe="")


async def test_upload_accepts_every_whitelisted_type(harness):
    for content, expected_type, expected_ext in (
        (PNG_BYTES, "image/png", "png"),
        (JPEG_BYTES, "image/jpeg", "jpg"),
        (WEBP_BYTES, "image/webp", "webp"),
        (GIF_BYTES, "image/gif", "gif"),
    ):
        room_id, _edit, admin = await harness.create_ok()
        response = await harness.upload(room_id, admin, content=content)
        assert response.status_code == 200, (expected_type, response.text)
        assert response.json()["baseImage"]["type"] == expected_type
        assert harness.base_files(room_id) == [f"{room_id}.{expected_ext}"]


async def test_upload_trusts_magic_bytes_not_client_headers(harness):
    room_id, _edit, admin = await harness.create_ok()

    # 客户端谎称是 image/png，内容是 HTML：拒绝
    lying = await harness.upload(room_id, admin, content=NOT_IMAGE_BYTES, filename="evil.png")
    assert lying.status_code == 400
    assert lying.json()["error"] == "底图只支持 PNG / JPG / WebP / GIF"
    assert harness.all_base_files() == []
    assert (await harness.client.get(f"/api/rooms/{room_id}/base", headers=pwd(admin))).status_code == 409

    # 文件名/声明的 URL 后缀是 .html，但字节真的是 PNG：按字节认，收下
    honest = await harness.upload(room_id, admin, content=PNG_BYTES, filename="weird.html")
    assert honest.status_code == 200
    assert honest.json()["baseImage"]["type"] == "image/png"
    assert harness.base_files(room_id) == [f"{room_id}.png"]


async def test_upload_role_rules(harness):
    room_id, edit, admin = await harness.create_ok()

    # 草稿期：编辑者与管理员都能确认
    assert (await harness.upload(room_id, edit)).status_code == 200
    # 就绪后：编辑者换底图 403，管理员可以
    forbidden = await harness.upload(room_id, edit, content=JPEG_BYTES)
    assert forbidden.status_code == 403
    assert forbidden.json()["error"] == "只有管理员能更换底图"
    assert (await harness.upload(room_id, admin, content=JPEG_BYTES)).status_code == 200

    # 密码不对：401，且不会动底图
    wrong = await harness.upload(room_id, "wrongpass")
    assert wrong.status_code == 401
    assert harness.base_files(room_id) == [f"{room_id}.jpg"]


async def test_upload_rejects_bad_dimensions_and_missing_file(harness):
    room_id, _edit, admin = await harness.create_ok()
    for width, height in ((0, 100), (100, 0), (10**9, 100), ("abc", 100)):
        response = await harness.upload(room_id, admin, width=width, height=height)
        assert response.status_code == 400, (width, height)
        assert response.json()["error"] == "底图尺寸不合法"

    # multipart 里没有名为 file 的那一部分
    no_file = await harness.client.post(
        f"/api/rooms/{room_id}/base",
        headers=pwd(admin),
        data={"name": "x", "width": "10", "height": "10"},
        files={"other": ("x.png", PNG_BYTES, "image/png")},
    )
    assert no_file.status_code == 400
    assert no_file.json()["error"] == "缺少底图文件"

    # 根本不是 multipart
    not_multipart = await harness.client.post(
        f"/api/rooms/{room_id}/base", headers=pwd(admin), json={"name": "x"}
    )
    assert not_multipart.status_code == 400
    assert not_multipart.json()["error"] == "请求体必须是 multipart/form-data"
    assert harness.all_base_files() == []


async def test_upload_switching_extension_cleans_the_others(open_harness, tmp_path):
    async with open_harness(tmp_path) as harness:
        room_id, _edit, admin = await harness.create_ok()
        assert (await harness.upload(room_id, admin, content=PNG_BYTES)).status_code == 200
        assert (await harness.upload(room_id, admin, content=JPEG_BYTES)).status_code == 200
        # 换后缀之后旧的那张必须消失，不能留孤儿文件
        assert harness.base_files(room_id) == [f"{room_id}.jpg"]
        assert harness.all_base_files() == [f"{room_id}.jpg"]

        # 再换回 png：jpg 同样被清掉，同时验证"覆盖"确实换成了新字节
        new_png = PNG_BYTES + b"tail"
        assert (await harness.upload(room_id, admin, content=new_png, filename="b.png")).status_code == 200
        assert harness.all_base_files() == [f"{room_id}.png"]
        downloaded = await harness.client.get(f"/api/rooms/{room_id}/base", headers=pwd(admin))
        assert downloaded.content == new_png

        # 同一后缀再传一次还是只有一个文件（覆盖，不是新增）
        assert (await harness.upload(room_id, admin, content=JPEG_BYTES + b"x")).status_code == 200
        assert harness.all_base_files() == [f"{room_id}.jpg"]
        downloaded = await harness.client.get(f"/api/rooms/{room_id}/base", headers=pwd(admin))
        assert downloaded.content == JPEG_BYTES + b"x"


async def test_upload_over_limit_is_413_and_leaves_nothing(open_harness, tmp_path):
    async with open_harness(tmp_path, BF_MAX_BASE_IMAGE_BYTES="4096") as harness:
        room_id, edit, _admin = await harness.create_ok()
        response = await harness.upload(room_id, edit, content=PNG_BYTES + b"0" * 8192)
        assert response.status_code == 413
        assert "上限" in response.json()["error"]
        # 半截临时文件必须被清掉，房间也不能被推进 ready
        assert harness.all_base_files() == []
        room = (await harness.client.get(f"/api/rooms/{room_id}", headers=pwd(edit))).json()["room"]
        assert room["status"] == "draft"
        assert room["baseImage"] is None


async def test_upload_over_limit_without_content_length_is_413(open_harness, tmp_path):
    """chunked 请求没有 Content-Length：靠边读边计数在读取阶段就截断"""
    async with open_harness(tmp_path, BF_MAX_BASE_IMAGE_BYTES="1048576") as harness:
        room_id, edit, _admin = await harness.create_ok()
        boundary = "----bfpboundary"
        body = multipart_body(
            boundary,
            PNG_BYTES + b"0" * (3 * 1024 * 1024),
            name="底图.png",
            width="800",
            height="600",
        )
        assert len(body) > 2 * 1024 * 1024

        async def chunks():
            for offset in range(0, len(body), 64 * 1024):
                yield body[offset : offset + 64 * 1024]

        response = await harness.client.post(
            f"/api/rooms/{room_id}/base",
            headers={
                **pwd(edit),
                "Content-Type": f"multipart/form-data; boundary={boundary}",
            },
            content=chunks(),
        )
        assert response.status_code == 413
        assert harness.all_base_files() == []


async def test_download_404_when_bytes_disappeared(harness):
    room_id, _edit, admin = await harness.create_ok()
    assert (await harness.upload(room_id, admin)).status_code == 200
    (harness.data_dir / "base" / f"{room_id}.png").unlink()

    response = await harness.client.get(f"/api/rooms/{room_id}/base", headers=pwd(admin))
    assert response.status_code == 404
    assert response.json()["error"] == "底图文件丢失"


async def test_download_requires_password_and_room(harness):
    room_id, _edit, admin = await harness.create_ok()
    assert (await harness.upload(room_id, admin)).status_code == 200
    assert (await harness.client.get(f"/api/rooms/{room_id}/base", headers=pwd("nope1234"))).status_code == 401
    assert (await harness.client.get("/api/rooms/zzzzzzzzzzzz/base", headers=pwd(admin))).status_code == 404
    assert (await harness.client.get(f"/api/rooms/{room_id}/base")).status_code == 401


async def test_base_name_is_truncated_and_control_chars_stripped(harness):
    room_id, _edit, admin = await harness.create_ok()
    ugly = "  名" + chr(10) + "字" + "x" * 200
    response = await harness.upload(room_id, admin, name=ugly)
    assert response.status_code == 200
    stored_name = response.json()["baseImage"]["name"]
    assert chr(10) not in stored_name
    assert len(stored_name) <= 80
    header = (await harness.client.get(f"/api/rooms/{room_id}/base", headers=pwd(admin))).headers["x-bf-base-name"]
    assert header == quote(stored_name, safe="")
    assert header.isascii()


async def test_avatar_rows_survive_base_upload(harness):
    """底图上传只动 room_base 与字节，绝不碰任何一行头像"""
    room_id, _edit, admin = await harness.create_ok(layers=[draft("l1", x=3), draft("l2", x=4)])
    before = (await harness.client.get(f"/api/rooms/{room_id}", headers=pwd(admin))).json()["avatars"]
    assert (await harness.upload(room_id, admin)).status_code == 200
    after = (await harness.client.get(f"/api/rooms/{room_id}", headers=pwd(admin))).json()["avatars"]
    assert after == before
