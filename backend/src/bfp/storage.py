# BlockFace+ · 底图字节落盘
# Copyright 2026 Dainsleif · Apache License 2.0
#
# 底图不进数据库：SQLite 里存 128MiB 的 BLOB 会让库文件暴涨、备份变慢、WAL 疯狂膨胀。
# 库里的 room_base 只存"指针"（后缀 + MIME + 名字 + 尺寸），字节躺在文件系统上：
#   {BF_DATA_DIR}/base/{roomId}.{ext}
#
# 两条不变量：
#  1. 一间房、一个后缀只有一个文件 —— 换底图是覆盖同一个名字，不留 base-<时间戳> 这种死文件；
#  2. 写入必须原子 —— 先写同目录下的临时文件，写完 fsync 再 os.replace。
#     直接往目标文件上写的话，写到一半崩了/被 kill 了，库里指针指向的就是半张图，
#     而且下一次上传之前它一直"看起来是好的"。

from __future__ import annotations

import os
import tempfile
from pathlib import Path

from .config import Settings

__all__ = ["StagedBaseImage", "base_image_path", "delete_room_files", "find_base_image", "orphan_base_files"]

# 上传暂存文件名的前缀：以点开头，正常目录列表里看不见，也绝不会和房间号撞（房间号不含点）
_TEMP_PREFIX = "."
_TEMP_SUFFIX = ".upload"


def base_dir(settings: Settings) -> Path:
    return settings.base_dir


def base_image_path(settings: Settings, room_id: str, ext: str) -> Path:
    return settings.base_dir / f"{room_id}.{ext.lower()}"


def find_base_image(settings: Settings, room_id: str) -> Path | None:
    """按房间号找底图，不管后缀（库里存的是后缀，这里用于兜底与清理）"""
    for candidate in settings.base_dir.glob(f"{room_id}.*"):
        if candidate.is_file() and not candidate.name.startswith(_TEMP_PREFIX):
            return candidate
    return None


def orphan_base_files(settings: Settings, room_id: str, keep_ext: str) -> list[Path]:
    """除 keep_ext 之外的该房间底图文件（换底图时清理用）"""
    keep = f"{room_id}.{keep_ext.lower()}"
    out: list[Path] = []
    for candidate in settings.base_dir.glob(f"{room_id}.*"):
        if candidate.name == keep or candidate.name.startswith(_TEMP_PREFIX):
            continue
        if candidate.is_file():
            out.append(candidate)
    return out


def delete_room_files(settings: Settings, room_id: str) -> int:
    """物理清空一间房的底图字节与上传残片。返回删掉的文件数。"""
    removed = 0
    for candidate in settings.base_dir.glob(f"{room_id}.*"):
        try:
            if candidate.is_file():
                candidate.unlink()
                removed += 1
        except OSError:
            # 删不掉就算了：房间行已经没了，剩下的只是没人引用的孤儿文件
            pass
    for candidate in settings.base_dir.glob(f"{_TEMP_PREFIX}{room_id}.*{_TEMP_SUFFIX}"):
        try:
            if candidate.is_file():
                candidate.unlink()
                removed += 1
        except OSError:
            pass
    return removed


class StagedBaseImage:
    """边收边落的底图上传暂存器。

    用法（三个方法都是同步的，调用方负责在需要时丢进线程池 —— 见 base.py 里的 commit）：
        staged = StagedBaseImage(settings, room_id)
        staged.write(chunk)     # 可以一直写，写超了由调用方抛 413
        staged.abort()          # 任何失败路径都必须调用（清掉半截文件）
        staged.commit(ext)      # 原子替换到最终路径，并清掉该房间其它后缀

    为什么上传不是"先读进内存再判断"：底图上限 128MiB，先攒内存等于把限制装在内存耗尽之后。

    为什么 write() 直接在事件循环里写句柄、而 commit() 却要 to_thread：
    write 收到的分片是 64KiB（base.py 的 CHUNK_SIZE），落到带缓冲的文件对象上通常只是一次
    缓冲区拷贝，偶尔一次写系统调用；每个分片都往线程池丢一次，线程切换的开销比这次写还大。
    而 commit() 要做的是 fsync —— 那是真的会等磁盘的动作，必须让出事件循环。
    """

    def __init__(self, settings: Settings, room_id: str) -> None:
        self.settings = settings
        self.room_id = room_id
        self.size = 0
        self._head = bytearray()
        settings.base_dir.mkdir(parents=True, exist_ok=True)
        fd, name = tempfile.mkstemp(dir=settings.base_dir, prefix=f"{_TEMP_PREFIX}{room_id}.", suffix=_TEMP_SUFFIX)
        self._path = Path(name)
        self._handle = os.fdopen(fd, "wb")
        self._closed = False

    @property
    def temp_path(self) -> Path:
        return self._path

    @property
    def head(self) -> bytes:
        """开头 32 字节：用于按魔数认类型，不用等整张图收完"""
        return bytes(self._head)

    def write(self, chunk: bytes) -> None:
        if self._closed:
            raise RuntimeError("暂存文件已关闭")
        if len(self._head) < 32:
            self._head.extend(chunk[: 32 - len(self._head)])
        self._handle.write(chunk)
        self.size += len(chunk)

    def close(self) -> None:
        if not self._closed:
            self._closed = True
            try:
                self._handle.flush()
                os.fsync(self._handle.fileno())
            finally:
                self._handle.close()

    def unlink(self) -> None:
        try:
            self._path.unlink(missing_ok=True)
        except OSError:
            pass

    def abort(self) -> None:
        self.close()
        self.unlink()

    def commit(self, ext: str) -> Path:
        """落定到 {roomId}.{ext}。返回最终路径。"""
        self.close()
        final = base_image_path(self.settings, self.room_id, ext)
        # os.replace 在同一文件系统内是原子的：要么看到旧文件，要么看到完整的新文件
        os.replace(self._path, final)
        for stale in orphan_base_files(self.settings, self.room_id, ext):
            try:
                stale.unlink()
            except OSError:
                pass
        return final

