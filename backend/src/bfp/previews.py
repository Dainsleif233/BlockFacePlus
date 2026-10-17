# BlockFace+ · 预览底图生成（非管理员下载的那一份）
# Copyright 2026 Dainsleif · Apache License 2.0
#
# 为什么要有预览图：服务器带宽小，底图又是单张几十 MiB 的整图下载，
# 每来一个人进房就把上行带宽吃满。把"看"和"拿原图"拆开之后，
# 普通成员只拉一份长边 max_edge 的 WebP（通常几百 KB），管理员仍然拿原图。
#
# 三条不能破的约束：
#  1. **坐标空间不变**：预览只是像素源，按同一比例缩小；房间的画布尺寸
#     （room_base.width/height）永远描述原图。前端把预览按 cover 铺满同一个
#     画布盒子，头像坐标因此不需要任何换算 —— 一旦让 doc 跟着预览变，
#     所有人看到的头像位置就会整体错位。
#  2. **比例不能变**：短边由长边按原图比例算出来，绝不写成固定的 16:9 之类。
#  3. **失败不能影响上传**：Pillow 解不动（异常图、解压炸弹、动图）就返回 None，
#     调用方把 preview_* 留空，退化成"所有人拿原图"，而不是让上传失败。
#
# 动图（多帧 GIF / 动画 WebP）刻意不生成预览：抽一帧会让非管理员看到一个
# 静止版本，那是**内容**不一致，不只是清晰度差异。

from __future__ import annotations

import logging
import os
import tempfile
from pathlib import Path
from typing import NamedTuple

from PIL import Image, ImageOps

from .config import Settings
from .storage import preview_dir, preview_files

__all__ = ["PreviewResult", "render_preview"]

log = logging.getLogger("bfp.previews")

# WebP 是这里唯一"又小又保真"的选择；编码器不可用时退回 JPEG / PNG
WEBP_QUALITY = 82
WEBP_METHOD = 4
JPEG_QUALITY = 85
# 临时文件以点开头：preview_files 用 "{roomId}.*" 匹配，永远看不到它
_TEMP_PREFIX = ".preview-"
_TEMP_SUFFIX = ".upload"


class PreviewResult(NamedTuple):
    ext: str
    mime: str
    width: int
    height: int


def _target_size(width: int, height: int, max_edge: int) -> tuple[int, int]:
    """按长边缩到 max_edge，短边由原比例推出（绝不改比例）"""
    long_edge = max(width, height)
    if long_edge <= max_edge:
        return width, height
    ratio = max_edge / long_edge
    if width >= height:
        target_w = max_edge
        target_h = max(1, round(height * ratio))
    else:
        target_h = max_edge
        target_w = max(1, round(width * ratio))
    return target_w, target_h


def _prepare(image: Image.Image) -> Image.Image:
    """统一成 WebP/JPEG 能直接保存的模式"""
    has_alpha = image.mode in ("RGBA", "LA", "PA") or (
        image.mode == "P" and "transparency" in image.info
    )
    return image.convert("RGBA" if has_alpha else "RGB")


def _save(image: Image.Image, path: Path) -> tuple[str, str]:
    """依次尝试 WebP → JPEG → PNG，返回 (后缀, MIME)"""
    errors: list[str] = []
    for ext, mime, save in (
        ("webp", "image/webp", lambda target: image.save(target, "WEBP", quality=WEBP_QUALITY, method=WEBP_METHOD)),
        ("jpg", "image/jpeg", lambda target: image.convert("RGB").save(target, "JPEG", quality=JPEG_QUALITY, optimize=True, progressive=True)),
        ("png", "image/png", lambda target: image.save(target, "PNG", optimize=True)),
    ):
        try:
            save(str(path))
            return ext, mime
        except Exception:  # 编码器缺失 / 模式不支持：换下一个格式，别把上传带下去
            errors.append(ext)
    raise RuntimeError("预览图编码失败，尝试过：" + "/".join(errors))


def render_preview(source: Path, settings: Settings, room_id: str) -> PreviewResult | None:
    """从原图生成预览并落到 base/preview/{roomId}.{ext}；无法生成时返回 None。

    同步函数，调用方负责丢进线程池（解码 + 缩放是纯 CPU 活）。
    """
    max_edge = settings.base_preview_max_edge
    if max_edge <= 0:
        return None

    directory = preview_dir(settings)
    directory.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(dir=directory, prefix=f"{_TEMP_PREFIX}{room_id}-", suffix=_TEMP_SUFFIX)
    os.close(fd)
    temp_path = Path(temp_name)

    try:
        try:
            with Image.open(source) as opened:
                if getattr(opened, "is_animated", False):
                    log.info("房间 %s 的底图是多帧动图，跳过预览生成（避免内容不一致）", room_id)
                    return None
                image = ImageOps.exif_transpose(opened)
                target = _target_size(image.width, image.height, max_edge)
                prepared = _prepare(image)
                if prepared.size != target:
                    resample = getattr(Image, "Resampling", Image).LANCZOS
                    prepared = prepared.resize(target, resample)
        except Image.DecompressionBombError:
            log.warning("房间 %s 的底图像素量过大，跳过预览生成（继续用原图）", room_id)
            return None
        except Exception:
            log.warning("房间 %s 的底图解不出预览，继续用原图", room_id, exc_info=True)
            return None

        ext, mime = _save(prepared, temp_path)
        final = directory / f"{room_id}.{ext}"
        os.replace(temp_path, final)
        # 换格式（webp ↔ jpg）时把旧的清掉，一间房只留一个预览文件
        for stale in preview_files(settings, room_id):
            if stale.name != final.name:
                try:
                    stale.unlink()
                except OSError:
                    pass
        return PreviewResult(ext=ext, mime=mime, width=prepared.width, height=prepared.height)
    finally:
        try:
            temp_path.unlink(missing_ok=True)
        except OSError:
            pass
