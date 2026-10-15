/*!
 * BlockFace+ · 房间会话：URL 解析与密码暂存
 * Copyright 2026 Dainsleif · Apache License 2.0
 *
 * 密码只放在 sessionStorage：同页刷新不丢，关掉标签页即清空。
 * 绝不写进 localStorage —— 换个安全环境打开不该自动带着旧房间的钥匙。
 */

export function roomIdFromLocation(): string | null {
  try {
    const value = new URLSearchParams(window.location.search).get('room');
    return value && /^[A-Za-z0-9_-]{6,64}$/.test(value) ? value : null;
  } catch {
    return null;
  }
}

export function roomUrl(roomId: string): string {
  const url = new URL(window.location.href);
  url.searchParams.set('room', roomId);
  return url.toString();
}

function keyOf(roomId: string): string {
  return `blockface-plus.room.${roomId}`;
}

export function loadRoomPassword(roomId: string): string | null {
  try {
    return window.sessionStorage.getItem(keyOf(roomId));
  } catch {
    return null;
  }
}

export function saveRoomPassword(roomId: string, password: string): void {
  try {
    window.sessionStorage.setItem(keyOf(roomId), password);
  } catch {
    // 隐私模式下 sessionStorage 可能不可用：退化为本次会话内存态（由调用方持有）
  }
}

export function clearRoomPassword(roomId: string): void {
  try {
    window.sessionStorage.removeItem(keyOf(roomId));
  } catch {
    /* 同上 */
  }
}
