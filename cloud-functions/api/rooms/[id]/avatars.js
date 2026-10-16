/*!
 * BlockFace+ · 编辑者增量提交（"合并"入口）
 * Copyright 2026 Dainsleif · Apache License 2.0
 *
 * PATCH /api/rooms/[id]/avatars
 * 入参：{ updates: [{ id, skin, expectUpdatedAt? }] }
 * 出参：{ results: [{ id, ok, updatedAt? , error? }], revision }
 *
 * 普通编辑者只能改头像内容（皮肤贴图）：服务端只从请求里取 skin 字段，
 * 位置/大小/旋转等一律以库里为准，想改布局在这个接口上无处着力。
 * 一头像一键，逐条覆盖互不影响；expectUpdatedAt 对不上的条目按冲突跳过。
 */

import {
  ApiError,
  LAYER_ID_RE,
  MAX_PATCH_UPDATES,
  authenticate,
  avatarKey,
  errorResponse,
  getStoreStrong,
  jsonResponse,
  metaKey,
  normalizeSkinRecord,
  passwordOf,
  readJsonBody,
  requireRoom,
} from '../../lib.js';


function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function onRequestPatch(context) {
  try {
    const roomId = context.params.id;
    const meta = await requireRoom(roomId);
    const role = authenticate(meta, passwordOf(context.request), context.clientIp);
    if (role !== 'editor' && role !== 'admin') throw new ApiError(403, '没有权限');

    const body = await readJsonBody(context.request);
    if (!isRecord(body) || !Array.isArray(body.updates)) throw new ApiError(400, '请求体格式不对');
    if (body.updates.length === 0) return jsonResponse({ results: [], revision: meta.revision ?? 0 });
    if (body.updates.length > MAX_PATCH_UPDATES) throw new ApiError(400, `一次最多提交 ${MAX_PATCH_UPDATES} 个头像`);

    const store = await getStoreStrong();

    // 先整批读出旧记录，再整批校验，最后把通过的条目一次性写回
    const loaded = await Promise.all(
      body.updates.map(async (update) => {
        // id 直接参与拼存储键：放过 `../` 这类东西会让 store.get 抛异常（整个请求 500），
        // 也会在 avatars/ 下造出子路径。这里用和落库同一套字符白名单卡死。
        if (!isRecord(update) || typeof update.id !== 'string' || !LAYER_ID_RE.test(update.id)) {
          return { update, before: null, invalid: true };
        }
        const before = await store.get(avatarKey(roomId, update.id), { type: 'json' });
        return { update, before, invalid: false };
      }),
    );

    const now = Date.now();
    const results = [];
    const writes = [];
    let revision = meta.revision ?? 0;

    for (const { update, before, invalid } of loaded) {
      const id = isRecord(update) ? update.id : String(update?.id ?? '');
      if (invalid || !before) {
        results.push({ id, ok: false, error: !before ? 'not-found' : 'invalid' });
        continue;
      }
      // 编辑者只能换皮肤：其它字段以库里为准，请求里带了也不看
      if (typeof update.expectUpdatedAt === 'number' && update.expectUpdatedAt !== before.updatedAt) {
        results.push({ id, ok: false, error: 'conflict' });
        continue;
      }
      const skin = normalizeSkinRecord(update.skin);
      if (!skin) {
        results.push({ id, ok: false, error: 'invalid-skin' });
        continue;
      }
      const next = { ...before, skin, updatedAt: now };
      writes.push(store.setJSON(avatarKey(roomId, id), next));
      results.push({ id, ok: true, updatedAt: now });
      revision += 1;
    }

    await Promise.all(writes);
    if (writes.length > 0) {
      await store.setJSON(metaKey(roomId), { ...meta, revision });
    }
    return jsonResponse({ results, revision });
  } catch (error) {
    if (error instanceof ApiError) return errorResponse(error.status, error.message, error.extra);
    console.error('[rooms:avatars]', error);
    return errorResponse(500, '服务器开小差了，稍后再试');
  }
}

export function onRequestGet() { return errorResponse(405, 'Method not allowed'); }
export function onRequestPut() { return errorResponse(405, 'Method not allowed'); }
export function onRequestPost() { return errorResponse(405, 'Method not allowed'); }
export function onRequestDelete() { return errorResponse(405, 'Method not allowed'); }
