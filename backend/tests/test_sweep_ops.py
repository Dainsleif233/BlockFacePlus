# BlockFace+ · 后台清扫与 bfp-ops 命令行
# Copyright 2026 Dainsleif · Apache License 2.0
#
# 清扫的两条判据（过期房间 / 超过 BF_DRAFT_TTL_SECONDS 的草稿房）后台与命令行必须一致，
# 所以这里既有直接调 sweep_once 的用例，也有走真实 CLI 的用例。

from __future__ import annotations

import asyncio
import json

from conftest import _open, png_bytes, pwd

from bfp.ops import main as ops_main
from bfp.security import now_ms
from bfp.sweep import sweep_once, sweep_preview


async def _make_rooms(harness):
    """建三间房：live（已就绪）/ expired（已过期）/ stale（草稿放太久）"""
    live, _edit, live_admin = await harness.create_ok()
    expired, _edit2, _admin2 = await harness.create_ok()
    stale, _edit3, _admin3 = await harness.create_ok()
    assert (await harness.upload(live, live_admin)).status_code == 200
    async with harness.db.transaction() as conn:
        await conn.execute("UPDATE rooms SET expires_at = ? WHERE room_id = ?", (now_ms() - 1, expired))
        await conn.execute("UPDATE rooms SET created_at = ? WHERE room_id = ?", (now_ms() - 120_000, stale))
    return live, expired, stale, live_admin


async def test_sweep_once_removes_expired_and_stale_drafts(open_harness, tmp_path):
    async with open_harness(tmp_path, BF_DRAFT_TTL_SECONDS="60") as harness:
        live, expired, stale, live_admin = await _make_rooms(harness)

        result = await sweep_once(harness.db, harness.settings)
        assert (result.expired, result.drafts, result.deleted) == (1, 1, 2)

        assert (await harness.client.get(f"/api/rooms/{live}", headers=pwd(live_admin))).status_code == 200
        assert (await harness.client.get(f"/api/rooms/{expired}", headers=pwd("whatever1"))).status_code == 404
        assert (await harness.client.get(f"/api/rooms/{stale}", headers=pwd("whatever1"))).status_code == 404
        # 清扫出的房间，底图字节也一并清掉
        assert harness.all_base_files() == [f"{live}.png"]


async def test_ready_rooms_are_never_swept_as_drafts(open_harness, tmp_path):
    async with open_harness(tmp_path, BF_DRAFT_TTL_SECONDS="60") as harness:
        room_id, _edit, admin = await harness.create_ok()
        assert (await harness.upload(room_id, admin)).status_code == 200
        # 房间很老，但它已经就绪：不该被当成"没人回来传底图的草稿"
        async with harness.db.transaction() as conn:
            await conn.execute("UPDATE rooms SET created_at = ? WHERE room_id = ?", (now_ms() - 10**9, room_id))
        result = await sweep_once(harness.db, harness.settings)
        assert result.deleted == 0
        assert (await harness.client.get(f"/api/rooms/{room_id}", headers=pwd(admin))).status_code == 200


async def test_sweep_preview_does_not_delete(open_harness, tmp_path):
    async with open_harness(tmp_path, BF_DRAFT_TTL_SECONDS="60") as harness:
        _live, _expired, _stale, _live_admin = await _make_rooms(harness)
        preview = await sweep_preview(harness.db, harness.settings)
        assert (preview.expired, preview.drafts, preview.deleted) == (1, 1, 0)
        rows = await harness.db.fetchall("SELECT room_id FROM rooms")
        assert len(rows) == 3


async def test_background_sweeper_runs_on_startup(open_harness, tmp_path):
    """lifespan 起来就先扫一轮：停机期间攒下的过期房间不用等一个周期"""
    async with open_harness(tmp_path, BF_SWEEP_INTERVAL_SECONDS="3600") as harness:
        room_id, _edit, _admin = await harness.create_ok()
        async with harness.db.transaction() as conn:
            await conn.execute("UPDATE rooms SET expires_at = ? WHERE room_id = ?", (now_ms() - 1, room_id))

    # 换一个 app 实例照着同一个数据目录起来：启动那一刻应该把这间过期房扫掉
    async with open_harness(tmp_path, BF_SWEEP_INTERVAL_SECONDS="3600") as second:
        # 给后台任务一点时间跑完第一轮（它是 create_task，不阻塞 lifespan）
        for _ in range(50):
            if await second.db.fetchone("SELECT 1 FROM rooms WHERE room_id = ?", (room_id,)) is None:
                break
            await asyncio.sleep(0.02)
        assert await second.db.fetchone("SELECT 1 FROM rooms WHERE room_id = ?", (room_id,)) is None


def seed(tmp_path):
    """用真实的建房路径铺一份数据，然后交给 CLI（CLI 必须在没有 app 的情况下也能干活）"""
    async def run():
        async with _open(tmp_path, BF_DRAFT_TTL_SECONDS="60") as harness:
            live, _edit, live_admin = await harness.create_ok()
            expired, _edit2, _admin2 = await harness.create_ok()
            stale, _edit3, _admin3 = await harness.create_ok()
            assert (await harness.upload(live, live_admin)).status_code == 200
            async with harness.db.transaction() as conn:
                await conn.execute("UPDATE rooms SET expires_at = ? WHERE room_id = ?", (now_ms() - 1, expired))
                await conn.execute("UPDATE rooms SET created_at = ? WHERE room_id = ?", (now_ms() - 120_000, stale))
            return live, expired, stale

    return asyncio.run(run())


def test_ops_list_and_inspect(tmp_path, capsys):
    live, _expired, _stale = seed(tmp_path)
    data_dir = tmp_path / "data"

    assert ops_main(["--data-dir", str(data_dir), "list"]) == 0
    output = capsys.readouterr().out
    assert live in output
    assert "共 3 间房" in output

    assert ops_main(["--data-dir", str(data_dir), "list", "--json"]) == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["count"] == 3
    assert {room["roomId"] for room in payload["rooms"]} == set(payload and [r["roomId"] for r in payload["rooms"]])
    assert any(room["status"] == "ready" for room in payload["rooms"])

    assert ops_main(["inspect", live, "--data-dir", str(data_dir)]) == 0
    output = capsys.readouterr().out
    assert live in output and "ready" in output
    assert f"{live}.png" in output  # 底图文件路径与字节数都打出来了

    assert ops_main(["--data-dir", str(data_dir), "inspect", "不存在房间号x"]) == 1
    assert "不存在" in capsys.readouterr().err


def test_ops_delete_needs_confirmation(tmp_path, capsys):
    live, _expired, _stale = seed(tmp_path)
    data_dir = tmp_path / "data"

    assert ops_main(["--data-dir", str(data_dir), "delete", live]) == 2
    assert "--yes" in capsys.readouterr().err
    # 没确认就绝不删
    assert ops_main(["--data-dir", str(data_dir), "list", "--json"]) == 0
    assert json.loads(capsys.readouterr().out)["count"] == 3

    assert ops_main(["--data-dir", str(data_dir), "delete", live, "--yes"]) == 0
    assert live in capsys.readouterr().out
    assert ops_main(["--data-dir", str(data_dir), "list", "--json"]) == 0
    assert json.loads(capsys.readouterr().out)["count"] == 2
    # 底图字节也清掉了
    assert not (data_dir / "base" / f"{live}.png").exists()

    assert ops_main(["--data-dir", str(data_dir), "delete", live, "--yes"]) == 1


def test_ops_sweep_dry_run_then_real(tmp_path, capsys, monkeypatch):
    _live, _expired, _stale = seed(tmp_path)
    data_dir = tmp_path / "data"
    # CLI 的判据同样来自环境变量（它不读 app 的内存配置）：
    # seed 时用的就是 60 秒，所以这里必须给一致的 TTL，否则命令行看不到那间"超时草稿房"
    monkeypatch.setenv("BF_DRAFT_TTL_SECONDS", "60")

    assert ops_main(["--data-dir", str(data_dir), "sweep", "--dry-run"]) == 0
    preview = capsys.readouterr().out
    assert "1 间过期房" in preview and "1 间超时草稿房" in preview
    # dry-run 不能有副作用
    assert ops_main(["--data-dir", str(data_dir), "list", "--json"]) == 0
    assert json.loads(capsys.readouterr().out)["count"] == 3

    assert ops_main(["--data-dir", str(data_dir), "sweep"]) == 0
    assert "删除房间 2 间（过期 1，超时草稿 1）" in capsys.readouterr().out
    assert ops_main(["--data-dir", str(data_dir), "list", "--json"]) == 0
    assert json.loads(capsys.readouterr().out)["count"] == 1


def test_ops_cli_is_usable_without_the_service_running(tmp_path, capsys):
    """CLI 直接开库，不需要 app/uvicorn；空目录也不能炸"""
    data_dir = tmp_path / "empty-data"
    assert ops_main(["--data-dir", str(data_dir), "list"]) == 0
    assert "共 0 间房" in capsys.readouterr().out
    assert (data_dir / "bfp.sqlite3").exists()

def test_ops_previews_backfills_existing_rooms(tmp_path, capsys):
    """升级前建的房间 preview_* 是 NULL：跑一次 previews 就能把带宽省回来"""
    live, _expired, _stale = seed(tmp_path)
    data_dir = tmp_path / "data"

    # seed 里传的是只够验魔数的 1x1 PNG（Pillow 解不动），这里换成真图
    target = data_dir / "base" / f"{live}.png"
    target.write_bytes(png_bytes(600, 300))

    assert ops_main(["--data-dir", str(data_dir), "previews", "--dry-run"]) == 0
    assert "需要补预览" in capsys.readouterr().out

    assert ops_main(["--data-dir", str(data_dir), "previews"]) == 0
    assert "补生成完成" in capsys.readouterr().out
    assert (data_dir / "base" / "preview" / f"{live}.webp").is_file()

    # 回头再跑一次：已经有预览的房间不该被重复处理
    assert ops_main(["--data-dir", str(data_dir), "previews", "--dry-run"]) == 0
    assert "0 间需要补预览" in capsys.readouterr().out

    assert ops_main(["inspect", live, "--data-dir", str(data_dir)]) == 0
    assert "预览       600x300" in capsys.readouterr().out
