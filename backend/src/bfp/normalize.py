# BlockFace+ · 数据归一化（与旧 lib.js 同口径）
# Copyright 2026 Dainsleif · Apache License 2.0
#
# 与前端 preset.ts 共用一套口径：超界一律夹回合法区间，不认识的键一律丢掉。
#
# 字段分域：layout（位置/尺寸/可见性…）、appearance（帽子层/水平翻转）、skin 各有一套补丁解析，
# 因为三者各有各的版本戳：改一个不该把另外两个的并发凭证一起作废。
# 这里刻意逐行对齐旧实现，包括几个看起来奇怪但被前端依赖的行为：
#   overlay: raw.overlay !== false（缺省/任何非 false → true）
#   flipH:   raw.flipH === true（只有真的是 true 才算）
#   尺寸按字段域写：请求里没带的键**不动**，不是"用默认值补齐"
#
# 数值转换也要对齐 JS 的 Number()/Math.round()：前端算出来的浮点值原样发过来，
# 用 Python 的 round()（银行家舍入）会和浏览器差 1，落到画布上就是"位置差一像素"。
#
# 本文件刻意不出现任何反斜杠转义：控制字符用 chr() 拼、图片魔数用字节序列写，
# 免得"源码里到底是一个 NUL 还是四个字符"这种歧义在评审时说不清。

from __future__ import annotations

import math
import re
from typing import Any

from .config import Settings

__all__ = [
    "APPEARANCE_KEYS",
    "CONTENT_TYPE_FOR_EXT",
    "EXT_FOR_CONTENT_TYPE",
    "LAYER_ID_RE",
    "ROOM_ID_RE",
    "clamp_number",
    "clean_name",
    "content_type_for_ext",
    "ext_for_content_type",
    "is_record",
    "normalize_appearance_patch",
    "normalize_avatar_record",
    "normalize_base_name",
    "normalize_doc_size",
    "normalize_layout_patch",
    "normalize_room_id",
    "normalize_skin_record",
    "round_js",
    "sniff_image_type",
    "split_layout_domains",
    "to_number",
]

ROOM_ID_RE = re.compile("^[A-Za-z0-9_-]{6,64}$")
LAYER_ID_RE = re.compile("^[A-Za-z0-9_-]{1,64}$")
# 外观域的两个键。它们历史上混在 layout 里，现在单列成域，但仍然要在
# normalize_layout_patch 里认（旧客户端就是这么发的）。
APPEARANCE_KEYS = ("overlay", "flipH")
# 白名单 data URI，防止 javascript: 之类的东西混进 <img src>
SKIN_DATA_URL_RE = re.compile("^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/=]*$")

# 需要剥掉的控制字符：C0 区 + DEL。用码点拼出来，源码里就没有不可见字符
_CONTROL_CHARS = frozenset(chr(code) for code in range(0x20)) | {chr(0x7F)}

# 后缀 ⇄ MIME 对照。旧版用 Object.create(null) 防 __proto__/constructor 这类继承键命中白名单，
# Python 的 dict 天然没有原型链，但两个方向仍然只走查表（不认的键返回 None）。
EXT_FOR_CONTENT_TYPE = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
}
CONTENT_TYPE_FOR_EXT = {
    "png": "image/png",
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "webp": "image/webp",
    "gif": "image/gif",
}

BASE_NAME_MAX = 80
SKIN_MIN_DIMENSION = 8
SKIN_MAX_DIMENSION = 8192

# 图片魔数：PNG 的 0x89 P N G CR LF 0x1A LF、JPEG 的 FF D8 FF、WebP 的 RIFF....WEBP、GIF 的两种头
PNG_MAGIC = bytes([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
JPEG_MAGIC = bytes([0xFF, 0xD8, 0xFF])
GIF_MAGICS = (b"GIF87a", b"GIF89a")
RIFF_MAGIC = b"RIFF"
WEBP_MAGIC = b"WEBP"


def is_record(value: Any) -> bool:
    return isinstance(value, dict)


def round_js(value: float) -> int:
    """JS 的 Math.round：.5 一律往 +∞ 靠（Python 的 round 是银行家舍入，不能直接用）"""
    return math.floor(value + 0.5)


def to_number(value: Any) -> float:
    """对齐 JS 的 Number()。None → 0、bool → 0/1、字符串能解析就用解析值，其余 NaN。"""
    if value is None:
        return 0.0
    if isinstance(value, bool):
        return 1.0 if value else 0.0
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return 0.0
        try:
            return float(text)
        except ValueError:
            return math.nan
    return math.nan


def clamp_number(value: Any, minimum: float, maximum: float, fallback: float) -> float:
    number = to_number(value)
    if not math.isfinite(number):
        return fallback
    return min(maximum, max(minimum, number))


def normalize_doc_size(value: Any, settings: Settings) -> int | None:
    """画布边长：建房与上传底图两处共用。不合法返回 None（调用方翻成 400）。"""
    number = to_number(value)
    if not math.isfinite(number):
        return None
    size = round_js(number)
    if size < 1 or size > settings.max_doc_size:
        return None
    return size


def strip_control(text: str) -> str:
    return "".join(char for char in text if char not in _CONTROL_CHARS)


def clean_name(raw: Any, fallback: str, max_length: int) -> str:
    """头像名：只剥控制字符（防换行/控制码混进 UI 与日志），长度给足不截断真实名字"""
    text = strip_control(raw).strip() if isinstance(raw, str) else ""
    return (text or fallback)[:max_length]


def normalize_base_name(raw: Any) -> str:
    """底图名：会进 X-BF-Base-Name 响应头（响应头不允许非 ASCII，前端再 decodeURIComponent 解回来），
    所以必须剥控制字符 + 留一个上限，别让人拿文件名把响应头灌爆。"""
    return clean_name(raw, "底图", BASE_NAME_MAX)


def normalize_room_id(raw: Any) -> str | None:
    return raw if isinstance(raw, str) and ROOM_ID_RE.match(raw) else None


def ext_for_content_type(content_type: Any) -> str | None:
    if not isinstance(content_type, str):
        return None
    return EXT_FOR_CONTENT_TYPE.get(content_type.lower())


def content_type_for_ext(ext: Any) -> str | None:
    if not isinstance(ext, str):
        return None
    return CONTENT_TYPE_FOR_EXT.get(ext.lower())


def normalize_skin_record(raw: Any, settings: Settings) -> dict[str, Any] | None:
    record = raw if is_record(raw) else None
    if record is None:
        return None
    data_url = record.get("dataUrl")
    if not isinstance(data_url, str) or len(data_url) > settings.max_skin_data_url_chars:
        return None
    if not SKIN_DATA_URL_RE.match(data_url):
        return None
    skin: dict[str, Any] = {
        "dataUrl": data_url,
        "width": round_js(clamp_number(record.get("width"), SKIN_MIN_DIMENSION, SKIN_MAX_DIMENSION, 64)),
        "height": round_js(clamp_number(record.get("height"), SKIN_MIN_DIMENSION, SKIN_MAX_DIMENSION, 64)),
    }
    if record.get("isCustomImage") is True:
        skin["isCustomImage"] = True
    if record.get("frontOnly") is True:
        skin["frontOnly"] = True
    return skin


def _appearance_values(raw: dict[str, Any]) -> dict[str, Any]:
    """从一条 payload 里取出外观字段的补丁；缺的键不进结果。

    取值口径只在这一处：overlay 非 false 即 true、flipH 只有真的是 true 才算。
    布局域要认这两个键（旧客户端把它们塞在 layout 里），外观域也要认，
    两边的判据必须一模一样 —— 同一次改动走哪条路都得落成同一个值。
    """
    patch: dict[str, Any] = {}
    if "overlay" in raw:
        patch["overlay"] = raw["overlay"] is not False
    if "flipH" in raw:
        patch["flipH"] = raw["flipH"] is True
    return patch


def normalize_layout_patch(raw: Any, settings: Settings) -> dict[str, Any] | None:
    """布局字段的**局部**补丁：只认请求里真的带了的键。

    缺的键一律不动 —— 这是"换皮肤不会碰到位置、挪位置不会碰到皮肤"的落点。
    返回 None 表示整条不合法；返回空 dict 表示这条什么也不用改。

    overlay / flipH 已经归 appearance 域，这里保留它们是为了「整行 / 旧 payload」的宽容入口：
    旧客户端会把这两个键塞在 layout 里，删掉就凭空多出一条 invalid-layout。
    调用方拿到结果后应当用 split_layout_domains 把这两个键交还给外观域。
    """
    if not is_record(raw):
        return None
    patch: dict[str, Any] = {}
    if "name" in raw:
        patch["name"] = clean_name(raw["name"], "头像", settings.max_avatar_name)
    if "x" in raw:
        patch["x"] = clamp_number(raw["x"], -settings.max_position, settings.max_position, 0)
    if "y" in raw:
        patch["y"] = clamp_number(raw["y"], -settings.max_position, settings.max_position, 0)
    if "size" in raw:
        patch["size"] = round_js(clamp_number(raw["size"], settings.min_layer_size, settings.max_layer_size, 256))
    if "rotation" in raw:
        patch["rotation"] = round_js(clamp_number(raw["rotation"], -3600, 3600, 0))
    if "opacity" in raw:
        patch["opacity"] = clamp_number(raw["opacity"], 0, 1, 1)
    patch.update(_appearance_values(raw))
    if "visible" in raw:
        patch["visible"] = raw["visible"] is not False
    if "order" in raw:
        patch["order"] = max(0, round_js(clamp_number(raw["order"], 0, 9_007_199_254_740_991, 0)))
    return patch


def normalize_appearance_patch(raw: Any) -> dict[str, Any] | None:
    """外观字段（帽子层/水平翻转）的局部补丁：缺的键一律不动。

    取值走 _appearance_values，与布局域那条兼容入口用的是同一份判据 ——
    否则同一次改动走 layout 与走 appearance 会得出两个结果。
    返回 None 表示整条不合法；返回空 dict 表示什么也不用改。
    """
    if not is_record(raw):
        return None
    return _appearance_values(raw)


def split_layout_domains(patch: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    """把一条 layout 补丁按 APPEARANCE_KEYS 拆成 (布局, 外观)。

    旧客户端把 overlay/flipH 发在 layout 里，服务端仍然认，但它推进的必须是
    外观域的版本戳 —— 拆开的唯一理由就是这个，别让两个域共用一个戳。
    """
    layout = {key: value for key, value in patch.items() if key not in APPEARANCE_KEYS}
    appearance = {key: value for key, value in patch.items() if key in APPEARANCE_KEYS}
    return layout, appearance


def normalize_avatar_record(raw: Any, index: int, settings: Settings) -> dict[str, Any] | None:
    """整条头像记录（建房 / 新增一行时用）；收拾不出来返回 None"""
    if not is_record(raw):
        return None
    layer_id = raw.get("id")
    if not isinstance(layer_id, str) or not LAYER_ID_RE.match(layer_id):
        return None
    layout = normalize_layout_patch(raw, settings)
    if layout is None:
        return None
    # 整行记录里 overlay/flipH 同样按外观域取值；默认值不变（True / False）。
    # 这里直接调 _appearance_values 而不是 normalize_appearance_patch：raw 已经过 is_record 检查，
    # 不需要再判一次「整条是不是对象」。
    appearance = _appearance_values(raw)
    raw_skin = raw.get("skin")
    if raw_skin is None:
        skin = None
    else:
        skin = normalize_skin_record(raw_skin, settings)
        if skin is None:
            return None
    return {
        "id": layer_id,
        "name": layout.get("name", f"头像 {index + 1}"),
        "x": layout.get("x", 0),
        "y": layout.get("y", 0),
        "size": layout.get("size", 256),
        "rotation": layout.get("rotation", 0),
        "opacity": layout.get("opacity", 1),
        "overlay": appearance.get("overlay", True),
        "flipH": appearance.get("flipH", False),
        "visible": layout.get("visible", True),
        "order": layout.get("order", index),
        "skin": skin,
    }


def sniff_image_type(head: bytes) -> str | None:
    """从字节魔数认图片类型，而不是信客户端声明的 Content-Type。

    multipart 的 part 头是客户端自己写的，信它等于让"把 .html 改名成 .png"过关；
    魔数是内容自己带的，改不了。
    """
    if head.startswith(PNG_MAGIC):
        return "image/png"
    if head.startswith(JPEG_MAGIC):
        return "image/jpeg"
    if len(head) >= 12 and head.startswith(RIFF_MAGIC) and head[8:12] == WEBP_MAGIC:
        return "image/webp"
    if head.startswith(GIF_MAGICS):
        return "image/gif"
    return None
