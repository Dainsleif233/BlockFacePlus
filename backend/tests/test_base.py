# BlockFace+ · 底图上传与下载
# Copyright 2026 Dainsleif · Apache License 2.0
#
# 盯的是契约 2.5 / 2.6：只认 PNG/JPEG/WebP/GIF、边收边计数、超限 413 且不留半截文件、
# 同一间房同一后缀只有一个文件、下载时响应头齐全。

from __future__ import annotations

from io import BytesIO
from urllib.parse import quote

import pytest
from PIL import Image

from conftest import (
    GIF_BYTES,
    JPEG_BYTES,
    NOT_IMAGE_BYTES,
    PNG_BYTES,
    WEBP_BYTES,
    draft,
    gif_bytes,
    png_bytes,
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
    room_id, edit, admin = await harness.create_ok()
    name = "我的 底图.png"
    content = png_bytes(800, 600)

    uploaded = await harness.upload(room_id, edit, content=content, name=name, width=800, height=600)
    assert uploaded.status_code == 200, uploaded.text
    payload = uploaded.json()
    assert payload["ok"] is True
    assert payload["doc"] == {"width": 800, "height": 600}
    assert payload["baseImage"] == {
        "name": name,
        "type": "image/png",
        "width": 800,
        "height": 600,
        # 800x600 没超过默认长边 2048，预览与原图同尺寸（只做了重编码，好压体积）
        "preview": {"width": 800, "height": 600},
    }
    # 同一间房同一后缀只有一个文件
    assert harness.base_files(room_id) == [f"{room_id}.png"]

    room = (await harness.client.get(f"/api/rooms/{room_id}", headers=pwd(edit))).json()["room"]
    assert room["status"] == "ready"
    assert room["baseImage"] == {
        "name": name,
        "type": "image/png",
        "width": 800,
        "height": 600,
        "preview": {"width": 800, "height": 600},
    }
    assert room["doc"] == {"width": 800, "height": 600}

    # 管理员拿到的是原图字节
    downloaded = await harness.client.get(f"/api/rooms/{room_id}/base", headers=pwd(admin))
    assert downloaded.status_code == 200
    assert downloaded.content == content
    assert downloaded.headers["content-type"] == "image/png"
    assert downloaded.headers["x-content-type-options"] == "nosniff"
    assert downloaded.headers["cache-control"] == "private, max-age=60"
    assert downloaded.headers["x-bf-base-variant"] == "full"
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


async def test_multipart_spool_dir_lives_in_the_data_dir(open_harness, tmp_path):
    """上传暂存必须落在数据目录，不能落在 /tmp

    生产 unit 里 PrivateTmp=true 让 /tmp 是内存盘：一条 50MiB 底图被解析器滚到那里，
    就等于白吃 50MiB 内存，几条并发还能把 tmpfs 写满、让解析器抛 OSError（500 而不是 413）。
    """
    import tempfile

    original = tempfile.tempdir
    try:
        async with open_harness(tmp_path) as harness:
            assert tempfile.tempdir == str(harness.data_dir / "tmp")
            assert (harness.data_dir / "tmp").is_dir()
            # 真正过一次上传：暂存目录用完之后不该留下任何文件
            room_id, _edit, admin = await harness.create_ok()
            assert (await harness.upload(room_id, admin)).status_code == 200
            assert list((harness.data_dir / "tmp").iterdir()) == []
    finally:
        tempfile.tempdir = original


async def test_upload_after_concurrent_room_delete_rolls_back_file(harness, monkeypatch):
    room_id, _edit, admin = await harness.create_ok()

    from bfp import base as base_module

    real_commit = base_module.StagedBaseImage.commit

    def delete_room_before_metadata_commit(staged, ext, *, cleanup=True):
        import sqlite3

        with sqlite3.connect(harness.settings.db_path) as connection:
            connection.execute("PRAGMA foreign_keys = ON")
            connection.execute("DELETE FROM rooms WHERE room_id = ?", (room_id,))
            connection.commit()
        return real_commit(staged, ext, cleanup=cleanup)

    monkeypatch.setattr(base_module.StagedBaseImage, "commit", delete_room_before_metadata_commit)
    response = await harness.upload(room_id, admin, content=JPEG_BYTES)
    assert response.status_code == 404
    assert response.json()["error"] == "房间不存在或已被删除"
    assert harness.base_files(room_id) == []


async def test_failed_metadata_update_restores_previous_base(harness):
    room_id, _edit, admin = await harness.create_ok()
    assert (await harness.upload(room_id, admin, content=PNG_BYTES)).status_code == 200

    async with harness.db.transaction() as conn:
        await conn.execute(
            "CREATE TRIGGER fail_room_base_update BEFORE UPDATE ON room_base "
            "BEGIN SELECT RAISE(ABORT, 'forced metadata failure'); END;"
        )

    with pytest.raises(Exception, match="forced metadata failure"):
        await harness.upload(room_id, admin, content=JPEG_BYTES)
    assert harness.all_base_files() == [f"{room_id}.png"]
    downloaded = await harness.client.get(f"/api/rooms/{room_id}/base", headers=pwd(admin))
    assert downloaded.status_code == 200
    assert downloaded.content == PNG_BYTES


async def test_avatar_rows_survive_base_upload(harness):
    """底图上传只动 room_base 与字节，绝不碰任何一行头像"""
    room_id, _edit, admin = await harness.create_ok(layers=[draft("l1", x=3), draft("l2", x=4)])
    before = (await harness.client.get(f"/api/rooms/{room_id}", headers=pwd(admin))).json()["avatars"]
    assert (await harness.upload(room_id, admin)).status_code == 200
    after = (await harness.client.get(f"/api/rooms/{room_id}", headers=pwd(admin))).json()["avatars"]
    assert after == before

# --------------------------------------------------------------------------- #
# 预览底图（方案二）：除管理员外都只拿缩小版
#
# 这一组用例守的是同一件事：**坐标空间不许跟着预览变**。
# 预览只是像素源，room_base.width/height 与快照的 doc 永远是原图尺寸 ——
# 一旦 doc 变成 256x192，所有人的头像坐标就会整体错位。
# --------------------------------------------------------------------------- #


async def test_non_admin_gets_a_downscaled_preview(open_harness, tmp_path):
    async with open_harness(tmp_path, BF_BASE_PREVIEW_MAX_EDGE="256") as harness:
        room_id, edit, admin = await harness.create_ok()
        content = png_bytes(1024, 768)

        uploaded = await harness.upload(room_id, admin, content=content, width=1024, height=768)
        assert uploaded.status_code == 200, uploaded.text
        assert uploaded.json()["baseImage"]["preview"] == {"width": 256, "height": 192}
        # 上传回执里的 doc 仍然是原图尺寸
        assert uploaded.json()["doc"] == {"width": 1024, "height": 768}

        room = (await harness.client.get(f"/api/rooms/{room_id}", headers=pwd(edit))).json()["room"]
        assert room["doc"] == {"width": 1024, "height": 768}
        assert room["baseImage"]["width"] == 1024
        assert room["baseImage"]["height"] == 768
        assert room["baseImage"]["preview"] == {"width": 256, "height": 192}

        # 管理员：原图字节一模一样
        admin_download = await harness.client.get(f"/api/rooms/{room_id}/base", headers=pwd(admin))
        assert admin_download.status_code == 200
        assert admin_download.headers["x-bf-base-variant"] == "full"
        assert admin_download.content == content

        # 编辑者：缩小后的 WebP
        editor_download = await harness.client.get(f"/api/rooms/{room_id}/base", headers=pwd(edit))
        assert editor_download.status_code == 200
        assert editor_download.headers["x-bf-base-variant"] == "preview"
        assert editor_download.headers["content-type"] == "image/webp"
        assert len(editor_download.content) < len(content)
        with Image.open(BytesIO(editor_download.content)) as image:
            assert image.size == (256, 192)


async def test_preview_keeps_the_original_aspect_ratio(open_harness, tmp_path):
    """短边必须由原比例推出来：写死比例会让头像在预览图上整体偏移"""
    async with open_harness(tmp_path, BF_BASE_PREVIEW_MAX_EDGE="200") as harness:
        room_id, _edit, admin = await harness.create_ok()

        landscape = await harness.upload(room_id, admin, content=png_bytes(1000, 333), width=1000, height=333)
        assert landscape.status_code == 200, landscape.text
        preview = landscape.json()["baseImage"]["preview"]
        assert preview["width"] == 200
        assert abs(preview["height"] - 333 * 200 / 1000) <= 1

        portrait = await harness.upload(room_id, admin, content=png_bytes(333, 1000), width=333, height=1000)
        assert portrait.status_code == 200, portrait.text
        preview = portrait.json()["baseImage"]["preview"]
        assert preview["height"] == 200
        assert abs(preview["width"] - 333 * 200 / 1000) <= 1


async def test_preview_can_be_switched_off(open_harness, tmp_path):
    """BF_BASE_PREVIEW_MAX_EDGE=0：不生成预览，所有人（含编辑者）都拿原图"""
    async with open_harness(tmp_path, BF_BASE_PREVIEW_MAX_EDGE="0") as harness:
        room_id, edit, admin = await harness.create_ok()
        content = png_bytes(1024, 768)

        uploaded = await harness.upload(room_id, admin, content=content, width=1024, height=768)
        assert uploaded.status_code == 200, uploaded.text
        assert uploaded.json()["baseImage"]["preview"] is None

        room = (await harness.client.get(f"/api/rooms/{room_id}", headers=pwd(edit))).json()["room"]
        assert room["baseImage"]["preview"] is None

        for password in (edit, admin):
            downloaded = await harness.client.get(f"/api/rooms/{room_id}/base", headers=pwd(password))
            assert downloaded.headers["x-bf-base-variant"] == "full"
            assert downloaded.content == content


async def test_room_without_preview_falls_back_to_the_full_image(open_harness, tmp_path):
    """老房间（加预览之前建的）没有预览：宁可用原图，也不许报错"""
    async with open_harness(tmp_path, BF_BASE_PREVIEW_MAX_EDGE="256") as harness:
        room_id, edit, admin = await harness.create_ok()
        content = png_bytes(1024, 768)
        assert (await harness.upload(room_id, admin, content=content, width=1024, height=768)).status_code == 200

        # 模拟"升级前就存在、还没跑 previews 回填"的房间
        async with harness.db.transaction() as conn:
            await conn.execute(
                "UPDATE room_base SET preview_ext = NULL, preview_type = NULL, "
                "preview_width = NULL, preview_height = NULL WHERE room_id = ?",
                (room_id,),
            )
        for stale in (harness.data_dir / "base" / "preview").glob(f"{room_id}.*"):
            stale.unlink()

        downloaded = await harness.client.get(f"/api/rooms/{room_id}/base", headers=pwd(edit))
        assert downloaded.status_code == 200
        assert downloaded.headers["x-bf-base-variant"] == "full"
        assert downloaded.content == content


async def test_snapshot_and_download_agree_when_preview_row_is_dirty(open_harness, tmp_path):
    """四列"全有或全无"是约定不是约束：脏数据下快照与下载必须说同一件事

    旧实现有三套判据：base.py 看 preview_ext + 文件在不在，public_room 还多要一个
    preview_width，ops.inspect 只看 preview_ext。构造一行"preview_ext/preview_type 有值、
    preview_width/preview_height 为 NULL"（直接 UPDATE 数据库，模拟旧写入点留下的脏状态）
    就能让快照说"没有预览"、下载却发预览。
    现在两条路都从 storage 的同一个判定出发，这里断言的正是"它们不会再分叉"。
    """
    async with open_harness(tmp_path, BF_BASE_PREVIEW_MAX_EDGE="128") as harness:
        room_id, edit, admin = await harness.create_ok()
        uploaded = await harness.upload(room_id, admin, content=png_bytes(512, 512), width=512, height=512)
        assert uploaded.status_code == 200, uploaded.text
        assert (harness.data_dir / "base" / "preview" / f"{room_id}.webp").is_file()

        # 只抹掉尺寸两列：preview_ext / preview_type 与盘上的文件都还在
        async with harness.db.transaction() as conn:
            await conn.execute(
                "UPDATE room_base SET preview_width = NULL, preview_height = NULL WHERE room_id = ?",
                (room_id,),
            )

        room = (await harness.client.get(f"/api/rooms/{room_id}", headers=pwd(edit))).json()["room"]
        downloaded = await harness.client.get(f"/api/rooms/{room_id}/base", headers=pwd(edit))
        assert downloaded.status_code == 200
        assert downloaded.headers["x-bf-base-variant"] == "preview"
        # 这句就是验收点：快照说有预览 ⇔ 实际下载真的发预览
        assert room["baseImage"]["preview"] is not None

        # 反过来也一样：文件不在了，两边都必须说"没有预览"，下载退回原图
        (harness.data_dir / "base" / "preview" / f"{room_id}.webp").unlink()
        room_after = (await harness.client.get(f"/api/rooms/{room_id}", headers=pwd(edit))).json()["room"]
        download_after = await harness.client.get(f"/api/rooms/{room_id}/base", headers=pwd(edit))
        assert download_after.headers["x-bf-base-variant"] == "full"
        assert download_after.content == png_bytes(512, 512)
        # 元数据还声明着预览（public_room 不做 IO），但"文件可用"这一层已经不再声称有 ——
        # 这正是两层职责分明的样子：声明归 preview_meta，可用归 preview_file。
        assert room_after["baseImage"]["preview"] == {"width": None, "height": None}


async def test_replacing_the_base_rebuilds_the_preview(open_harness, tmp_path):
    async with open_harness(tmp_path, BF_BASE_PREVIEW_MAX_EDGE="128") as harness:
        room_id, edit, admin = await harness.create_ok()

        first = png_bytes(512, 512, (10, 20, 30))
        assert (await harness.upload(room_id, admin, content=first, width=512, height=512)).status_code == 200

        second = png_bytes(256, 128, (200, 100, 50))
        uploaded = await harness.upload(room_id, admin, content=second, width=256, height=128)
        assert uploaded.status_code == 200, uploaded.text
        assert uploaded.json()["baseImage"]["preview"] == {"width": 128, "height": 64}

        # 预览目录里一间房只留一个文件，旧的那份不能变成孤儿
        assert sorted(path.name for path in (harness.data_dir / "base" / "preview").iterdir()) == [f"{room_id}.webp"]

        downloaded = await harness.client.get(f"/api/rooms/{room_id}/base", headers=pwd(edit))
        assert downloaded.headers["x-bf-base-variant"] == "preview"
        with Image.open(BytesIO(downloaded.content)) as image:
            assert image.size == (128, 64)


async def test_animated_gif_gets_no_preview(open_harness, tmp_path):
    """动图抽一帧就是内容不一致，不只是清晰度差：直接不生成预览"""
    async with open_harness(tmp_path, BF_BASE_PREVIEW_MAX_EDGE="64") as harness:
        room_id, edit, admin = await harness.create_ok()
        content = gif_bytes(200, 200, frames=2)

        uploaded = await harness.upload(
            room_id, admin, content=content, filename="base.gif", width=200, height=200
        )
        assert uploaded.status_code == 200, uploaded.text
        assert uploaded.json()["baseImage"]["preview"] is None

        downloaded = await harness.client.get(f"/api/rooms/{room_id}/base", headers=pwd(edit))
        assert downloaded.headers["x-bf-base-variant"] == "full"
        assert downloaded.content == content


async def test_undecodable_image_still_uploads_without_a_preview(open_harness, tmp_path):
    """魔数对、像素坏：预览生成失败也不能把一次成功的上传变成 500"""
    async with open_harness(tmp_path, BF_BASE_PREVIEW_MAX_EDGE="64") as harness:
        room_id, edit, admin = await harness.create_ok()
        # PNG 魔数 + 垃圾数据：sniff_image_type 认，Pillow 解不动
        content = PNG_BYTES + b"garbage"

        uploaded = await harness.upload(room_id, admin, content=content, width=200, height=200)
        assert uploaded.status_code == 200, uploaded.text
        assert uploaded.json()["baseImage"]["preview"] is None

        downloaded = await harness.client.get(f"/api/rooms/{room_id}/base", headers=pwd(edit))
        assert downloaded.status_code == 200
        assert downloaded.headers["x-bf-base-variant"] == "full"
        assert downloaded.content == content


async def test_delete_room_also_removes_preview_files(open_harness, tmp_path):
    async with open_harness(tmp_path, BF_BASE_PREVIEW_MAX_EDGE="128") as harness:
        room_id, _edit, admin = await harness.create_ok()
        assert (await harness.upload(room_id, admin, content=png_bytes(512, 512), width=512, height=512)).status_code == 200
        preview_dir = harness.data_dir / "base" / "preview"
        assert list(preview_dir.iterdir()) != []

        assert (await harness.client.delete(f"/api/rooms/{room_id}", headers=pwd(admin))).status_code == 200
        assert list(preview_dir.iterdir()) == []

# --------------------------------------------------------------------------- #
# 条件请求（304）：带宽小的时候，回源"再下一遍整张图"是最贵的浪费
# --------------------------------------------------------------------------- #


async def test_base_download_answers_304_when_the_etag_matches(open_harness, tmp_path):
    async with open_harness(tmp_path, BF_BASE_PREVIEW_MAX_EDGE="256") as harness:
        room_id, edit, admin = await harness.create_ok()
        assert (await harness.upload(room_id, admin, content=png_bytes(512, 512), width=512, height=512)).status_code == 200

        first = await harness.client.get(f"/api/rooms/{room_id}/base", headers=pwd(admin))
        assert first.status_code == 200
        etag = first.headers["etag"]
        assert etag and etag.startswith('"')
        # 响应体取决于密码，必须声明 Vary，否则私有缓存会把预览当原图复用。
        # （CORS 中间件会再往 Vary 上追加 Origin，所以这里只查包含关系）
        assert "X-BF-Room-Pwd" in first.headers["vary"]

        second = await harness.client.get(
            f"/api/rooms/{room_id}/base", headers={**pwd(admin), "If-None-Match": etag}
        )
        assert second.status_code == 304
        # 304 不带正文：省下来的正是这几十 MB
        assert second.content == b""
        assert second.headers["etag"] == etag
        assert second.headers["cache-control"] == "private, max-age=60"
        assert second.headers["x-bf-base-variant"] == "full"


async def test_304_accepts_weak_and_star_forms(open_harness, tmp_path):
    async with open_harness(tmp_path, BF_BASE_PREVIEW_MAX_EDGE="256") as harness:
        room_id, _edit, admin = await harness.create_ok()
        assert (await harness.upload(room_id, admin, content=png_bytes(64, 64), width=64, height=64)).status_code == 200
        etag = (await harness.client.get(f"/api/rooms/{room_id}/base", headers=pwd(admin))).headers["etag"]

        # RFC 9110：If-None-Match 用弱比较，W/ 前缀不影响命中
        weak = await harness.client.get(
            f"/api/rooms/{room_id}/base", headers={**pwd(admin), "If-None-Match": f"W/{etag}"}
        )
        assert weak.status_code == 304

        star = await harness.client.get(
            f"/api/rooms/{room_id}/base", headers={**pwd(admin), "If-None-Match": "*"}
        )
        assert star.status_code == 304

        # 不匹配就得老老实实发全量
        stale = await harness.client.get(
            f"/api/rooms/{room_id}/base", headers={**pwd(admin), "If-None-Match": '"deadbeef"'}
        )
        assert stale.status_code == 200
        assert stale.content == png_bytes(64, 64)


async def test_etag_is_variant_specific(open_harness, tmp_path):
    """同一个 URL 对编辑者与管理员发不同字节：ETag 必须分开，否则会串角色"""
    async with open_harness(tmp_path, BF_BASE_PREVIEW_MAX_EDGE="128") as harness:
        room_id, edit, admin = await harness.create_ok()
        assert (await harness.upload(room_id, admin, content=png_bytes(512, 512), width=512, height=512)).status_code == 200

        full = await harness.client.get(f"/api/rooms/{room_id}/base", headers=pwd(admin))
        preview = await harness.client.get(f"/api/rooms/{room_id}/base", headers=pwd(edit))
        assert full.headers["etag"] != preview.headers["etag"]

        # 拿原图的 ETag 去问预览：不匹配，必须回 200 而不是 304
        mixed = await harness.client.get(
            f"/api/rooms/{room_id}/base", headers={**pwd(edit), "If-None-Match": full.headers["etag"]}
        )
        assert mixed.status_code == 200
        assert mixed.headers["x-bf-base-variant"] == "preview"


async def test_etag_changes_after_the_base_is_replaced(open_harness, tmp_path):
    async with open_harness(tmp_path, BF_BASE_PREVIEW_MAX_EDGE="256") as harness:
        room_id, _edit, admin = await harness.create_ok()
        assert (await harness.upload(room_id, admin, content=png_bytes(64, 64), width=64, height=64)).status_code == 200
        before = (await harness.client.get(f"/api/rooms/{room_id}/base", headers=pwd(admin))).headers["etag"]

        assert (await harness.upload(room_id, admin, content=png_bytes(320, 200), width=320, height=200)).status_code == 200
        after = await harness.client.get(
            f"/api/rooms/{room_id}/base", headers={**pwd(admin), "If-None-Match": before}
        )
        assert after.status_code == 200
        assert after.headers["etag"] != before
        assert after.content == png_bytes(320, 200)
