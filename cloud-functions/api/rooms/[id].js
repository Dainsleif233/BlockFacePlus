/*!
 * BlockFace+ · 房间读取 / 删除
 * Copyright 2026 Dainsleif · Apache License 2.0
 *
 * GET    /api/rooms/[id]  密码登录：返回房间信息 + 全部头像 + 角色（editor/admin）
 * DELETE /api/rooms/[id]  仅管理员：删除整个房间
 *
 * 改头像/布局走 PATCH /api/rooms/[id]/avatars，底图走 /api/rooms/[id]/base。
 * 这个文件只读、只删，不写任何一张表 —— 所以它永远不会抹掉别人刚保存的东西。
 */

import {
  ApiError,
  authenticate,
  deleteRoom,
  errorResponse,
  getStoreStrong,
  jsonResponse,
  mapLimit,
  passwordOf,
  publicRoom,
  requireRoom,
  roomPrefix,
} from '../lib.js';

export async function onRequestGet(context) {
  try {
    const roomId = context.params.id;
    const { meta, base } = await requireRoom(roomId);
    const role = await authenticate(meta, passwordOf(context.request));

    // 头像与布局同在一行里，读一次就够；版本戳一并带回去给客户端做并发凭证
    const store = await getStoreStrong();
    const { blobs } = await store.list({ prefix: roomPrefix(roomId) + 'avatars/' });
    const records = await mapLimit(blobs, 32, (blob) => store.get(blob.key, { type: 'json' }));
    const avatars = records
      .filter((r) => r && typeof r.id === 'string')
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

    return jsonResponse({ room: publicRoom(meta, base), avatars, role });
  } catch (error) {
    if (error instanceof ApiError) return errorResponse(error.status, error.message, error.extra);
    console.error('[rooms:get]', error);
    return errorResponse(500, '服务器开小差了，稍后再试');
  }
}

export async function onRequestDelete(context) {
  try {
    const roomId = context.params.id;
    const { meta } = await requireRoom(roomId);
    const role = await authenticate(meta, passwordOf(context.request));
    if (role !== 'admin') throw new ApiError(403, '只有管理员能删除房间');

    await deleteRoom(roomId);
    return jsonResponse({ ok: true });
  } catch (error) {
    if (error instanceof ApiError) return errorResponse(error.status, error.message, error.extra);
    console.error('[rooms:delete]', error);
    return errorResponse(500, '服务器开小差了，稍后再试');
  }
}

// 全量覆盖这条老路已经拆掉了：改头像一律走 PATCH .../avatars 的差量提交
export function onRequestPut() { return errorResponse(405, '改头像请用 PATCH /api/rooms/[id]/avatars'); }
export function onRequestPatch() { return errorResponse(405, '改头像请用 PATCH /api/rooms/[id]/avatars'); }
export function onRequestPost() { return errorResponse(405, 'Method not allowed'); }
