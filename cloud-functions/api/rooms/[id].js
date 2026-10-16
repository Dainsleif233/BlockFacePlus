/*!
 * BlockFace+ · 房间读取 / 管理员全量更新 / 删除
 * Copyright 2026 Dainsleif · Apache License 2.0
 *
 * GET    /api/rooms/[id]  密码登录：返回房间元信息 + 全部头像 + 角色（editor/admin）
 * PUT    /api/rooms/[id]  仅管理员：全量同步头像（含位置、增删），按 key 差异化落盘
 * DELETE /api/rooms/[id]  仅管理员：删除整个房间
 *
 * 头像一头像一键，"合并"就是按 key 增删改；PUT 用 ifRevision 做乐观并发检查。
 */

import {
  ApiError,
  MAX_LAYERS,
  authenticate,
  avatarKey,
  deleteRoom,
  errorResponse,
  getStoreStrong,
  jsonResponse,
  normalizeAvatarRecord,
  passwordOf,
  publicRoom,
  readJsonBody,
  requireRoom,
  roomPrefix,
} from '../lib.js';

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function listAvatarKeys(roomId) {
  const store = await getStoreStrong();
  const { blobs } = await store.list({ prefix: roomPrefix(roomId) + 'avatars/' });
  return { store, keys: blobs.map((b) => b.key) };
}

export async function onRequestGet(context) {
  try {
    const roomId = context.params.id;
    const meta = await requireRoom(roomId);
    const role = authenticate(meta, passwordOf(context.request), context.clientIp);

    const { store, keys } = await listAvatarKeys(roomId);
    const records = await Promise.all(keys.map((key) => store.get(key, { type: 'json' })));
    const avatars = records
      .filter((r) => r !== null)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

    return jsonResponse({ room: publicRoom(meta), avatars, role });
  } catch (error) {
    if (error instanceof ApiError) return errorResponse(error.status, error.message, error.extra);
    console.error('[rooms:get]', error);
    return errorResponse(500, '服务器开小差了，稍后再试');
  }
}

export async function onRequestPut(context) {
  try {
    const roomId = context.params.id;
    const meta = await requireRoom(roomId);
    const role = authenticate(meta, passwordOf(context.request), context.clientIp);
    if (role !== 'admin') throw new ApiError(403, '只有管理员能改布局');

    const body = await readJsonBody(context.request);
    if (!isRecord(body)) throw new ApiError(400, '请求体格式不对');

    // 并发凭证必填：没有它，一个读旧状态的客户端就能绕过乐观锁直接盖掉别人的改动
    const ifRevision = body.ifRevision;
    if (!Number.isFinite(ifRevision)) throw new ApiError(400, '缺少 ifRevision 并发凭证');
    if (ifRevision !== (meta.revision ?? 0)) {
      throw new ApiError(409, '房间刚被别人改过，请刷新后再提交', { revision: meta.revision ?? 0 });
    }

    const rawLayers = Array.isArray(body.layers) ? body.layers : [];
    if (rawLayers.length > MAX_LAYERS) throw new ApiError(400, `头像最多 ${MAX_LAYERS} 个`);
    const seenIds = new Set();
    const desired = rawLayers.map((item, index) => {
      const record = normalizeAvatarRecord(item, index);
      if (!record) throw new ApiError(400, `第 ${index + 1} 个头像的数据不合法`);
      if (seenIds.has(record.id)) throw new ApiError(400, '头像 id 重复');
      seenIds.add(record.id);
      return { ...record, order: index };
    });

    const { store, keys } = await listAvatarKeys(roomId);
    const existing = new Map();
    await Promise.all(keys.map(async (key) => {
      const id = key.slice(key.lastIndexOf('/') + 1).replace(/\.json$/, '');
      existing.set(id, await store.get(key, { type: 'json' }));
    }));

    const now = Date.now();
    const writes = [];
    const deletes = [];

    for (const record of desired) {
      const before = existing.get(record.id) ?? null;
      const { updatedAt: _ignored, ...comparable } = before ?? {};
      // 内容一模一样就跳过写盘：不动 updatedAt，别把别人正在提交的并发检查搅乱
      if (before && JSON.stringify(comparable) === JSON.stringify(record)) continue;
      writes.push(store.setJSON(avatarKey(roomId, record.id), { ...record, updatedAt: now }));
    }
    for (const [id] of existing) {
      if (!seenIds.has(id)) deletes.push(store.delete(avatarKey(roomId, id)));
    }

    await Promise.all([...writes, ...deletes]);

    const revision = (meta.revision ?? 0) + 1;
    await store.setJSON(metaKey(roomId), { ...meta, revision });
    return jsonResponse({ revision });
  } catch (error) {
    if (error instanceof ApiError) return errorResponse(error.status, error.message, error.extra);
    console.error('[rooms:put]', error);
    return errorResponse(500, '服务器开小差了，稍后再试');
  }
}

export async function onRequestDelete(context) {
  try {
    const roomId = context.params.id;
    const meta = await requireRoom(roomId);
    const role = authenticate(meta, passwordOf(context.request), context.clientIp);
    if (role !== 'admin') throw new ApiError(403, '只有管理员能删除房间');

    await deleteRoom(roomId);
    return jsonResponse({ ok: true });
  } catch (error) {
    if (error instanceof ApiError) return errorResponse(error.status, error.message, error.extra);
    console.error('[rooms:delete]', error);
    return errorResponse(500, '服务器开小差了，稍后再试');
  }
}

export function onRequestPost() {
  return errorResponse(405, 'Method not allowed');
}
