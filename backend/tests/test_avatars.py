# BlockFace+ · 头像行的差量提交（唯一的写头像入口）
# Copyright 2026 Dainsleif · Apache License 2.0
#
# 这一组用例盯的是三条铁律与角色约束：
#   只写被提到的行 / 行内按字段域写 / 缺的键不动 /
#   编辑者能换皮肤、能改外观（帽子层、水平翻转），layout 整条忽略。

from __future__ import annotations

from conftest import VALID_SKIN, draft, pwd


async def snapshot(harness, room_id: str, password: str) -> dict:
    response = await harness.client.get(f"/api/rooms/{room_id}", headers=pwd(password))
    assert response.status_code == 200, response.text
    return response.json()


async def patch(harness, room_id: str, password: str, body: dict):
    return await harness.client.patch(f"/api/rooms/{room_id}/avatars", headers=pwd(password), json=body)


async def test_layout_patch_writes_only_mentioned_keys(harness):
    room_id, _edit, admin = await harness.create_ok(layers=[draft("l1", x=1, y=2, size=64, order=0)])
    before = (await snapshot(harness, room_id, admin))["avatars"][0]

    response = await patch(harness, room_id, admin, {"updates": [{"id": "l1", "layout": {"x": 100}}]})
    assert response.status_code == 200, response.text
    result = response.json()["results"][0]
    assert result["ok"] is True
    assert result["layoutUpdatedAt"] > before["layoutUpdatedAt"] or result["layoutUpdatedAt"] == before["layoutUpdatedAt"]

    after = (await snapshot(harness, room_id, admin))["avatars"][0]
    assert after["x"] == 100
    # 缺的键一个都没动
    assert after["y"] == before["y"]
    assert after["size"] == before["size"]
    assert after["name"] == before["name"]
    # 布局域推进，皮肤域原封不动
    assert after["skinUpdatedAt"] == before["skinUpdatedAt"]


async def test_layout_patch_clamps_instead_of_rejecting(harness):
    room_id, _edit, admin = await harness.create_ok(layers=[draft("l1")])
    response = await patch(
        harness,
        room_id,
        admin,
        {"updates": [{"id": "l1", "layout": {"x": 10**12, "y": -(10**12), "size": 99_999_999, "rotation": 99999}}]},
    )
    assert response.json()["results"][0]["ok"] is True
    avatar = (await snapshot(harness, room_id, admin))["avatars"][0]
    assert avatar["x"] == 100_000
    assert avatar["y"] == -100_000
    assert avatar["size"] == 16_384
    assert avatar["rotation"] == 3600


async def test_non_mentioned_rows_are_untouched(harness):
    room_id, _edit, admin = await harness.create_ok(layers=[draft("l1"), draft("l2")])
    before = {a["id"]: a for a in (await snapshot(harness, room_id, admin))["avatars"]}

    await patch(harness, room_id, admin, {"updates": [{"id": "l1", "layout": {"x": 7}}]})
    after = {a["id"]: a for a in (await snapshot(harness, room_id, admin))["avatars"]}
    assert after["l2"] == before["l2"]


async def test_editor_can_change_skin_but_layout_is_silently_ignored(harness):
    room_id, edit, _admin = await harness.create_ok(layers=[draft("l1", x=5)])
    before = (await snapshot(harness, room_id, edit))["avatars"][0]

    response = await patch(
        harness,
        room_id,
        edit,
        {"updates": [{"id": "l1", "layout": {"x": 999}, "skin": VALID_SKIN}]},
    )
    assert response.status_code == 200, response.text
    result = response.json()["results"][0]
    assert result["ok"] is True
    # layout 被原样忽略：版本戳不推进（不是报错，也不是写进去）
    assert result["layoutUpdatedAt"] == before["layoutUpdatedAt"]

    after = (await snapshot(harness, room_id, edit))["avatars"][0]
    assert after["x"] == 5
    assert after["skin"]["dataUrl"] == VALID_SKIN["dataUrl"]
    assert after["skinUpdatedAt"] > before["skinUpdatedAt"]


async def test_editor_cannot_add_or_delete(harness):
    room_id, edit, _admin = await harness.create_ok(layers=[draft("l1")])
    assert (await patch(harness, room_id, edit, {"adds": [draft("l2")]})).status_code == 403
    assert (await patch(harness, room_id, edit, {"deletes": ["l1"]})).status_code == 403
    assert (await patch(harness, room_id, edit, {"updates": [], "adds": [], "deletes": []})).status_code == 200


async def test_admin_can_add_and_delete(harness):
    room_id, _edit, admin = await harness.create_ok(layers=[draft("l1")])

    added = await patch(harness, room_id, admin, {"adds": [draft("l2", name="新头像", order=3)]})
    result = added.json()["results"][0]
    assert result["id"] == "l2" and result["ok"] is True
    assert result["skinUpdatedAt"] == result["layoutUpdatedAt"]  # 新增行的三个戳同时生成
    assert result["appearanceUpdatedAt"] == result["skinUpdatedAt"]
    avatars = (await snapshot(harness, room_id, admin))["avatars"]
    assert [a["id"] for a in avatars] == ["l1", "l2"]
    assert avatars[1]["name"] == "新头像"
    assert avatars[1]["order"] == 3

    # id 已被占用就报 exists，绝不悄悄覆盖别人的行
    exists = await patch(harness, room_id, admin, {"adds": [draft("l2", name="想覆盖")]})
    assert exists.json()["results"] == [{"id": "l2", "ok": False, "error": "exists"}]

    removed = await patch(harness, room_id, admin, {"deletes": ["l2"]})
    assert removed.json()["results"] == [{"id": "l2", "ok": True}]
    # 删不存在的行也当成功（重复提交不会炸）
    again = await patch(harness, room_id, admin, {"deletes": ["l2"]})
    assert again.json()["results"] == [{"id": "l2", "ok": True}]
    assert [a["id"] for a in (await snapshot(harness, room_id, admin))["avatars"]] == ["l1"]


async def test_update_error_codes(harness):
    # 每条用不同的 id：同一个 id 在一次请求里会被去重成"最后一条"（与旧实现一致），
    # 要看全每种错误就得给每种一个不同的目标行
    room_id, _edit, admin = await harness.create_ok(
        layers=[draft("l1"), draft("l2"), draft("l3"), draft("l4")]
    )
    response = await patch(
        harness,
        room_id,
        admin,
        {
            "updates": [
                {"id": "不合法 id", "layout": {"x": 1}},
                {"id": "ghost", "layout": {"x": 1}},
                {"id": "l1", "layout": "不是对象"},
                {"id": "l2", "skin": {"dataUrl": "data:image/svg+xml;base64,AAAA"}},
                {"id": "l3", "skin": None},
                {"id": "l4", "appearance": "不是对象"},
            ]
        },
    )
    assert [item["error"] for item in response.json()["results"]] == [
        "invalid",
        "not-found",
        "invalid-layout",
        "invalid-skin",
        "invalid-skin",
        "invalid-appearance",
    ]
    assert all(item["ok"] is False for item in response.json()["results"])


async def test_same_id_in_updates_collapses_to_the_last_one(harness):
    """与旧实现同口径：同一个 id 出现多次时以最后一次为准，只留一条结果"""
    room_id, _edit, admin = await harness.create_ok(layers=[draft("l1")])
    response = await patch(
        harness,
        room_id,
        admin,
        {"updates": [{"id": "l1", "layout": {"x": 1}}, {"id": "l1", "layout": "不是对象"}]},
    )
    assert [item["error"] for item in response.json()["results"]] == ["invalid-layout"]


async def test_skin_domain_is_written_independently(harness):
    room_id, _edit, admin = await harness.create_ok(layers=[draft("l1", x=42)])
    before = (await snapshot(harness, room_id, admin))["avatars"][0]

    response = await patch(harness, room_id, admin, {"updates": [{"id": "l1", "skin": VALID_SKIN}]})
    result = response.json()["results"][0]
    assert result["skinUpdatedAt"] > before["skinUpdatedAt"]
    assert result["layoutUpdatedAt"] == before["layoutUpdatedAt"]

    after = (await snapshot(harness, room_id, admin))["avatars"][0]
    assert after["skin"] == VALID_SKIN
    assert after["x"] == 42
    assert after["layoutUpdatedAt"] == before["layoutUpdatedAt"]


async def test_version_stamp_conflict_per_domain(harness):
    room_id, _edit, admin = await harness.create_ok(layers=[draft("l1")])
    before = (await snapshot(harness, room_id, admin))["avatars"][0]

    # 先按真实戳改一次布局，戳就过期了
    first = await patch(
        harness,
        room_id,
        admin,
        {"updates": [{"id": "l1", "layout": {"x": 8}, "expectLayoutUpdatedAt": before["layoutUpdatedAt"]}]},
    )
    assert first.json()["results"][0]["ok"] is True

    stale = await patch(
        harness,
        room_id,
        admin,
        {"updates": [{"id": "l1", "layout": {"x": 9}, "expectLayoutUpdatedAt": before["layoutUpdatedAt"]}]},
    )
    assert stale.json()["results"] == [{"id": "l1", "ok": False, "error": "conflict"}]

    # 皮肤域的戳与布局域的戳互不影响：皮肤戳还是旧的，所以这次皮肤改动不该冲突
    still_fresh = await patch(
        harness,
        room_id,
        admin,
        {"updates": [{"id": "l1", "skin": VALID_SKIN, "expectSkinUpdatedAt": before["skinUpdatedAt"]}]},
    )
    assert still_fresh.json()["results"][0]["ok"] is True

    # 戳对了就放行
    current = (await snapshot(harness, room_id, admin))["avatars"][0]
    ok = await patch(
        harness,
        room_id,
        admin,
        {"updates": [{"id": "l1", "layout": {"x": 10}, "expectLayoutUpdatedAt": current["layoutUpdatedAt"]}]},
    )
    assert ok.json()["results"][0]["ok"] is True
    # expectXxx 不是数字时不做检查（与 typeof === 'number' 同口径）
    loose = await patch(
        harness,
        room_id,
        admin,
        {"updates": [{"id": "l1", "layout": {"x": 11}, "expectLayoutUpdatedAt": "abc"}]},
    )
    assert loose.json()["results"][0]["ok"] is True


async def test_empty_patch_is_a_noop_and_keeps_version_stamps(harness):
    room_id, _edit, admin = await harness.create_ok(layers=[draft("l1")])
    before = (await snapshot(harness, room_id, admin))["avatars"][0]

    response = await patch(harness, room_id, admin, {"updates": [{"id": "l1", "layout": {}}]})
    assert response.json()["results"] == [
        {
            "id": "l1",
            "ok": True,
            "skinUpdatedAt": before["skinUpdatedAt"],
            "layoutUpdatedAt": before["layoutUpdatedAt"],
            "appearanceUpdatedAt": before["appearanceUpdatedAt"],
        }
    ]
    empty = await patch(harness, room_id, admin, {})
    assert empty.status_code == 200
    assert empty.json() == {"results": []}


async def test_deletes_land_after_writes(harness):
    """同一个 id 既在 updates 又在 deletes 时，结果必须是确定的：删掉"""
    room_id, _edit, admin = await harness.create_ok(layers=[draft("l1"), draft("l2")])
    response = await patch(
        harness,
        room_id,
        admin,
        {"updates": [{"id": "l1", "layout": {"x": 3}}], "deletes": ["l1"]},
    )
    assert response.status_code == 200
    assert [a["id"] for a in (await snapshot(harness, room_id, admin))["avatars"]] == ["l2"]


async def test_same_id_twice_in_one_request_last_wins(harness):
    room_id, _edit, admin = await harness.create_ok(layers=[draft("l1")])
    response = await patch(
        harness,
        room_id,
        admin,
        {"updates": [{"id": "l1", "layout": {"x": 1}}, {"id": "l1", "layout": {"x": 2}}]},
    )
    assert len(response.json()["results"]) == 1
    assert response.json()["results"][0]["ok"] is True
    assert (await snapshot(harness, room_id, admin))["avatars"][0]["x"] == 2


async def test_delete_batch_is_not_limited_by_room_capacity(harness):
    room_id, _edit, admin = await harness.create_ok(layers=[draft("l1")])
    # 单次条数不是容量限制；删除不存在的 id 仍是幂等成功。
    response = await patch(harness, room_id, admin, {"deletes": [f"ghost-{i}" for i in range(513)]})
    assert response.status_code == 200, response.text
    assert len(response.json()["results"]) == 513


async def test_version_stamps_advance_when_clock_does_not(open_harness, tmp_path, monkeypatch):
    import bfp.avatars as avatars_module

    async with open_harness(tmp_path) as harness:
        room_id, _edit, admin = await harness.create_ok(layers=[draft("l1")])
        monkeypatch.setattr(avatars_module, "now_ms", lambda: 1_000)
        before = (await snapshot(harness, room_id, admin))["avatars"][0]
        first = await patch(harness, room_id, admin, {"updates": [{"id": "l1", "layout": {"x": 1}}]})
        second = await patch(harness, room_id, admin, {"updates": [{"id": "l1", "layout": {"x": 2}}]})
        assert first.json()["results"][0]["layoutUpdatedAt"] > before["layoutUpdatedAt"]
        assert second.json()["results"][0]["layoutUpdatedAt"] > first.json()["results"][0]["layoutUpdatedAt"]

        # 外观域同样要跟单调：它和布局共用一个 now，时钟停住时得靠「旧戳 + 1」推上去，
        # 否则两次翻转会拿到同一个戳，第二个人拿第一次的凭证照样能写。
        # 基准取这行在写外观之前的三域最大戳：外观没自己的历史时它等于布局戳，
        # 正是「时钟停住，只能靠旧戳 + 1 往上顶」的那个起点。
        before_appearance = (await snapshot(harness, room_id, admin))["avatars"][0]
        baseline = max(
            before_appearance["skinUpdatedAt"],
            before_appearance["layoutUpdatedAt"],
            before_appearance["appearanceUpdatedAt"],
        )
        third = await patch(harness, room_id, admin, {"updates": [{"id": "l1", "appearance": {"overlay": False}}]})
        fourth = await patch(harness, room_id, admin, {"updates": [{"id": "l1", "appearance": {"overlay": True}}]})
        # 不是「比其他域大」（同一个 now 下这几乎恒真），而是必须真的比写之前的戳大：
        # 少了这一句，now 退回纯时钟也会通过。
        assert third.json()["results"][0]["appearanceUpdatedAt"] > baseline
        assert fourth.json()["results"][0]["appearanceUpdatedAt"] > third.json()["results"][0]["appearanceUpdatedAt"]


async def test_adds_are_normalized_like_create(harness):
    room_id, _edit, admin = await harness.create_ok(layers=[draft("l1")])
    added = await patch(
        harness,
        room_id,
        admin,
        {
            "adds": [
                # size 8000 在上限（16384）之内，原样保留；超上限的才夹回去
                {"id": "l9", "size": 8000, "rotation": "720", "overlay": "不是布尔", "visible": False, "skin": VALID_SKIN},
                {"id": "l10", "size": 10**9, "x": 10**12, "y": -(10**12)},
                # 不是对象的那条会被直接过滤掉（与旧实现的 .filter(isRecord) 一致），
                # 所以结果里不会出现它；id 不合法的那种才会回 invalid
                "缺 id 行",
                {"id": 12345, "layout": {"x": 1}},
            ]
        },
    )
    results = added.json()["results"]
    assert [item["id"] for item in results] == ["l9", "l10", "12345"]
    assert results[0]["ok"] is True and results[1]["ok"] is True
    assert results[2]["ok"] is False and results[2]["error"] == "invalid"

    avatar = next(a for a in (await snapshot(harness, room_id, admin))["avatars"] if a["id"] == "l9")
    assert avatar["size"] == 8_000
    assert avatar["rotation"] == 720
    assert avatar["overlay"] is True  # 非 false 一律 true
    assert avatar["visible"] is False
    assert avatar["name"] == "头像 1"  # 缺名字时按 adds 的下标兜底
    assert avatar["skin"] == VALID_SKIN

    clamped = next(a for a in (await snapshot(harness, room_id, admin))["avatars"] if a["id"] == "l10")
    assert clamped["size"] == 16_384  # 夹到上限（= 画布边长上限，图层不可能比画布还大）
    assert clamped["x"] == 100_000
    assert clamped["y"] == -100_000


async def test_adds_are_capped_by_the_room_total_not_by_the_request(open_harness, tmp_path):
    """行数上限是「一间房」的：每次只加一条也要把房间累计起来算

    只按单次请求判等于没有上限 —— 分几次 adds 就能把房间堆过 512 行，
    而 GET 是一次性全量返回的，房间越界之后每次进房都要把整间房读进内存。
    """
    async with open_harness(tmp_path, BF_MAX_LAYERS="3") as harness:
        room_id, _edit, admin = await harness.create_ok(layers=[draft("l1"), draft("l2")])

        # 一次只加一条，条数远没到 3，但房间累计已经到 3 行
        third = await patch(harness, room_id, admin, {"adds": [draft("l3")]})
        assert third.status_code == 200, third.text
        assert third.json()["results"][0]["ok"] is True

        fourth = await patch(harness, room_id, admin, {"adds": [draft("l4")]})
        assert fourth.status_code == 400
        assert fourth.json()["error"] == "这间房已经有 3 个头像，再加 1 个会超过一间房的上限（3）：先删几个再试"

        # 整批回滚：同一批里的 updates 也没落库
        mixed = await patch(
            harness,
            room_id,
            admin,
            {"updates": [{"id": "l1", "layout": {"x": 42}}], "adds": [draft("l5")]},
        )
        assert mixed.status_code == 400
        avatar = next(a for a in (await snapshot(harness, room_id, admin))["avatars"] if a["id"] == "l1")
        assert avatar["x"] != 42

        # 满了以后「同一批里删一行 + 加一行」必须放行：这一批的删除腾出了位置
        swap = await patch(harness, room_id, admin, {"deletes": ["l2"], "adds": [draft("l6")]})
        assert swap.status_code == 200, swap.text
        ids = [a["id"] for a in (await snapshot(harness, room_id, admin))["avatars"]]
        assert sorted(ids) == ["l1", "l3", "l6"]

        # 但删一个不存在的 id 不能白占位：服务端对不存在的行返回成功是幂等，不是允许超上限
        cheat = await patch(harness, room_id, admin, {"deletes": ["no-such-row"], "adds": [draft("l7")]})
        assert cheat.status_code == 400
        assert len((await snapshot(harness, room_id, admin))["avatars"]) == 3

        # 删掉一行之后单独再加也照样能过：上限算的是当下行数，不是历史累计
        assert (await patch(harness, room_id, admin, {"deletes": ["l3"]})).status_code == 200
        again = await patch(harness, room_id, admin, {"adds": [draft("l8")]})
        assert again.status_code == 200, again.text
        assert len((await snapshot(harness, room_id, admin))["avatars"]) == 3


async def test_editor_can_change_appearance_fields(harness):
    """编辑者能切帽子层 / 水平翻转；layout 仍然整条忽略（见下面的用例）"""
    room_id, edit, _admin = await harness.create_ok(layers=[draft("l1", x=5)])
    before = (await snapshot(harness, room_id, edit))["avatars"][0]

    response = await patch(
        harness,
        room_id,
        edit,
        {"updates": [{"id": "l1", "appearance": {"overlay": False, "flipH": True}}]},
    )
    assert response.status_code == 200, response.text
    result = response.json()["results"][0]
    assert result["ok"] is True
    assert result["appearanceUpdatedAt"] > before["appearanceUpdatedAt"]
    # 外观推进不该带着布局一起动
    assert result["layoutUpdatedAt"] == before["layoutUpdatedAt"]

    after = (await snapshot(harness, room_id, edit))["avatars"][0]
    assert after["overlay"] is False
    assert after["flipH"] is True
    assert after["x"] == 5
    assert after["layoutUpdatedAt"] == before["layoutUpdatedAt"]
    assert after["skinUpdatedAt"] == before["skinUpdatedAt"]


async def test_editor_legacy_layout_overlay_is_still_silently_ignored(harness):
    """编辑者把帽子层塞进 layout：与旧行为一致，整条忽略，也不报错"""
    room_id, edit, _admin = await harness.create_ok(layers=[draft("l1", overlay=True, flipH=False)])
    before = (await snapshot(harness, room_id, edit))["avatars"][0]

    response = await patch(
        harness,
        room_id,
        edit,
        {"updates": [{"id": "l1", "layout": {"overlay": False, "flipH": True}}]},
    )
    assert response.status_code == 200, response.text
    result = response.json()["results"][0]
    assert result["ok"] is True
    assert result["appearanceUpdatedAt"] == before["appearanceUpdatedAt"]

    after = (await snapshot(harness, room_id, edit))["avatars"][0]
    assert after["overlay"] is True
    assert after["flipH"] is False
    assert after["appearanceUpdatedAt"] == before["appearanceUpdatedAt"]


async def test_admin_legacy_layout_overlay_still_applies(harness):
    """旧客户端（管理员）把 overlay/flipH 塞在 layout 里：仍然生效，但只推外观戳"""
    room_id, _edit, admin = await harness.create_ok(layers=[draft("l1", x=7)])
    before = (await snapshot(harness, room_id, admin))["avatars"][0]

    response = await patch(
        harness,
        room_id,
        admin,
        {"updates": [{"id": "l1", "layout": {"overlay": False, "flipH": True}}]},
    )
    assert response.status_code == 200, response.text
    result = response.json()["results"][0]
    assert result["ok"] is True
    assert result["appearanceUpdatedAt"] > before["appearanceUpdatedAt"]
    # 布局戳不为一次翻转动弹：这两个键属于外观域
    assert result["layoutUpdatedAt"] == before["layoutUpdatedAt"]

    after = (await snapshot(harness, room_id, admin))["avatars"][0]
    assert after["overlay"] is False
    assert after["flipH"] is True
    assert after["layoutUpdatedAt"] == before["layoutUpdatedAt"]


async def test_appearance_conflict_is_scoped_to_its_own_stamp(harness):
    room_id, _edit, admin = await harness.create_ok(layers=[draft("l1")])
    before = (await snapshot(harness, room_id, admin))["avatars"][0]

    first = await patch(
        harness,
        room_id,
        admin,
        {"updates": [{"id": "l1", "appearance": {"overlay": False}, "expectAppearanceUpdatedAt": before["appearanceUpdatedAt"]}]},
    )
    assert first.json()["results"][0]["ok"] is True

    # 旧外观戳就不该再放行第二次
    stale = await patch(
        harness,
        room_id,
        admin,
        {"updates": [{"id": "l1", "appearance": {"overlay": True}, "expectAppearanceUpdatedAt": before["appearanceUpdatedAt"]}]},
    )
    assert stale.json()["results"] == [{"id": "l1", "ok": False, "error": "conflict"}]

    # 反过来：外观推进过之后，拿旧布局戳改布局不该被判冲突（两个域各认各的）
    layout_ok = await patch(
        harness,
        room_id,
        admin,
        {"updates": [{"id": "l1", "layout": {"x": 3}, "expectLayoutUpdatedAt": before["layoutUpdatedAt"]}]},
    )
    assert layout_ok.json()["results"][0]["ok"] is True

    # 外观域自己变了之后，最新外观戳就能放行
    current = (await snapshot(harness, room_id, admin))["avatars"][0]
    fresh = await patch(
        harness,
        room_id,
        admin,
        {"updates": [{"id": "l1", "appearance": {"flipH": True}, "expectAppearanceUpdatedAt": current["appearanceUpdatedAt"]}]},
    )
    assert fresh.json()["results"][0]["ok"] is True


async def test_explicit_appearance_wins_over_the_legacy_layout_copy(harness):
    """同一条 update 两个地方都带了 overlay：以显式的 appearance 为准"""
    room_id, _edit, admin = await harness.create_ok(layers=[draft("l1", overlay=True)])
    response = await patch(
        harness,
        room_id,
        admin,
        {"updates": [{"id": "l1", "layout": {"overlay": False}, "appearance": {"overlay": True}}]},
    )
    assert response.status_code == 200, response.text
    assert response.json()["results"][0]["ok"] is True
    assert (await snapshot(harness, room_id, admin))["avatars"][0]["overlay"] is True


async def test_empty_appearance_patch_is_a_noop(harness):
    room_id, _edit, admin = await harness.create_ok(layers=[draft("l1")])
    before = (await snapshot(harness, room_id, admin))["avatars"][0]

    response = await patch(harness, room_id, admin, {"updates": [{"id": "l1", "appearance": {}}]})
    assert response.json()["results"] == [
        {
            "id": "l1",
            "ok": True,
            "skinUpdatedAt": before["skinUpdatedAt"],
            "layoutUpdatedAt": before["layoutUpdatedAt"],
            "appearanceUpdatedAt": before["appearanceUpdatedAt"],
        }
    ]
    after = (await snapshot(harness, room_id, admin))["avatars"][0]
    assert after["appearanceUpdatedAt"] == before["appearanceUpdatedAt"]
