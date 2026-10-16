/*!
 * BlockFace+ · 头像行的差量提交（唯一的写头像入口）
 * Copyright 2026 Dainsleif · Apache License 2.0
 *
 * PATCH /api/rooms/[id]/avatars
 * 入参：
 *   {
 *     updates: [{ id, layout?: {位置/大小/旋转/顺序/名字…}, skin?: PresetSkin,
 *                 expectLayoutUpdatedAt?, expectSkinUpdatedAt? }],
 *     adds:    [完整的一行头像记录],
 *     deletes: [id]
 *   }
 * 出参：{ results: [{ id, ok, error?, skinUpdatedAt?, layoutUpdatedAt? }] }
 *
 * 三条铁律：
 *  1. 只写请求里真的提到的行 —— 没提到的行一个字节都不碰；
 *  2. 行内按字段域写 —— layout 补丁只覆盖布局字段，skin 只覆盖皮肤字段，
 *     两个版本戳各管各的，所以"有人在挪位置"和"有人在换皮肤"互不冲突；
 *  3. 缺的键不动（不是"用默认值补齐"），所以前端可以只发改动的最小集合。
 *
 * 编辑者：只能换皮肤（layout 原样忽略，加/删头像 403）；管理员：三者皆可。
 */

import {
  ApiError,
  LAYER_ID_RE,
  MAX_LAYERS,
  authenticate,
  avatarKey,
  errorResponse,
  getStoreStrong,
  jsonResponse,
  mapLimit,
  normalizeAvatarRecord,
  normalizeLayoutPatch,
  normalizeSkinRecord,
  passwordOf,
  readJsonBody,
  requireRoom,
} from '../../lib.js';

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 同一个 id 在一次请求里出现多次时以最后一次为准，顺序保持首次出现的位置 */
function dedupeById(items, keyOf) {
  const seen = new Set();
  const out = [];
  const byKey = new Map();
  for (const item of items) {
    const key = keyOf(item);
    if (seen.has(key)) {
      const at = byKey.get(key);
      out[at] = item;
      continue;
    }
    seen.add(key);
    byKey.set(key, out.length);
    out.push(item);
  }
  return out;
}

export async function onRequestPatch(context) {
  try {
    const roomId = context.params.id;
    const { meta } = await requireRoom(roomId);
    const role = await authenticate(meta, passwordOf(context.request));
    const isAdmin = role === 'admin';

    const body = await readJsonBody(context.request);
    if (!isRecord(body)) throw new ApiError(400, '请求体格式不对');

    const rawUpdates = Array.isArray(body.updates) ? body.updates : [];
    const rawAdds = Array.isArray(body.adds) ? body.adds : [];
    const rawDeletes = Array.isArray(body.deletes) ? body.deletes : [];

    if (!isAdmin && (rawAdds.length > 0 || rawDeletes.length > 0)) {
      throw new ApiError(403, '只有管理员能增加或删除头像');
    }

    const updates = dedupeById(rawUpdates.filter(isRecord), (u) => String(u.id ?? ''));
    const adds = dedupeById(rawAdds.filter(isRecord), (a) => String(a.id ?? ''));
    const deletes = [...new Set(rawDeletes.filter((id) => typeof id === 'string'))];

    // 一次请求能提到的行数不会超过"房间最多几行"：超过就是有人在灌请求，不是正常用法
    for (const [name, list] of [['修改', updates], ['新增', adds], ['删除', deletes]]) {
      if (list.length > MAX_LAYERS) throw new ApiError(400, `一次提交的${name}条数超过一间房的上限（${MAX_LAYERS}）`);
    }
    if (updates.length === 0 && adds.length === 0 && deletes.length === 0) {
      return jsonResponse({ results: [] });
    }

    const store = await getStoreStrong();
    const results = [];
    const writes = [];
    // 删除单独放一批、在写入之后落地：同一个 id 既在 updates 又在 deletes 时，
    // 结果必须是确定的"删掉"，不能靠 Promise.all 的完成顺序掷骰子
    const removals = [];
    const now = Date.now();

    // ---- 改：先把现有行读出来（只读请求里提到的那些，不扫全房） ----
    const before = await mapLimit(updates, 32, (update) => {
      const id = String(update.id ?? '');
      if (!LAYER_ID_RE.test(id)) return Promise.resolve(null);
      return store.get(avatarKey(roomId, id), { type: 'json' }).catch(() => null);
    });

    for (let i = 0; i < updates.length; i += 1) {
      const update = updates[i];
      const id = String(update.id ?? '');
      if (!LAYER_ID_RE.test(id)) { results.push({ id, ok: false, error: 'invalid' }); continue; }
      const row = before[i];
      if (!isRecord(row)) { results.push({ id, ok: false, error: 'not-found' }); continue; }

      // 编辑者送来的 layout 一律不看（不是报错，是根本不写）
      const layout = isAdmin && 'layout' in update ? normalizeLayoutPatch(update.layout) : null;
      if (isAdmin && 'layout' in update && layout === null) { results.push({ id, ok: false, error: 'invalid-layout' }); continue; }
      const hasLayout = !!layout && Object.keys(layout).length > 0;

      let skin;
      if ('skin' in update && update.skin !== undefined) {
        skin = normalizeSkinRecord(update.skin);
        if (!skin) { results.push({ id, ok: false, error: 'invalid-skin' }); continue; }
      }
      const hasSkin = !!skin;

      if (!hasLayout && !hasSkin) {
        // 什么也没改：当成功处理，且不写盘（不推进版本戳，别人的并发凭证不受影响）
        results.push({ id, ok: true, skinUpdatedAt: row.skinUpdatedAt, layoutUpdatedAt: row.layoutUpdatedAt });
        continue;
      }
      if (hasLayout && typeof update.expectLayoutUpdatedAt === 'number' && update.expectLayoutUpdatedAt !== row.layoutUpdatedAt) {
        results.push({ id, ok: false, error: 'conflict' });
        continue;
      }
      if (hasSkin && typeof update.expectSkinUpdatedAt === 'number' && update.expectSkinUpdatedAt !== row.skinUpdatedAt) {
        results.push({ id, ok: false, error: 'conflict' });
        continue;
      }

      const next = { ...row };
      if (hasLayout) { Object.assign(next, layout); next.layoutUpdatedAt = now; }
      if (hasSkin) { next.skin = skin; next.skinUpdatedAt = now; }
      writes.push(store.setJSON(avatarKey(roomId, id), next));
      results.push({ id, ok: true, skinUpdatedAt: next.skinUpdatedAt, layoutUpdatedAt: next.layoutUpdatedAt });
    }

    // ---- 增：新的一行，id 已被占用就报错，绝不悄悄覆盖别人的行 ----
    if (adds.length > 0) {
      const exists = await mapLimit(adds, 32, (add) => {
        const id = String(add.id ?? '');
        if (!LAYER_ID_RE.test(id)) return Promise.resolve(null);
        return store.get(avatarKey(roomId, id), { type: 'json' }).catch(() => null);
      });
      for (let i = 0; i < adds.length; i += 1) {
        const add = adds[i];
        const id = String(add.id ?? '');
        if (!LAYER_ID_RE.test(id)) { results.push({ id, ok: false, error: 'invalid' }); continue; }
        if (exists[i]) { results.push({ id, ok: false, error: 'exists' }); continue; }
        const record = normalizeAvatarRecord(add, i);
        if (!record) { results.push({ id, ok: false, error: 'invalid' }); continue; }
        const row = { ...record, skinUpdatedAt: now, layoutUpdatedAt: now };
        writes.push(store.setJSON(avatarKey(roomId, id), row));
        results.push({ id, ok: true, skinUpdatedAt: now, layoutUpdatedAt: now });
      }
    }

    // ---- 删：管理员说了算，不跟版本戳较劲（删不存在的行也当成功，重复提交不会炸） ----
    for (const id of deletes) {
      if (!LAYER_ID_RE.test(id)) { results.push({ id, ok: false, error: 'invalid' }); continue; }
      removals.push(store.delete(avatarKey(roomId, id)));
      results.push({ id, ok: true });
    }

    await Promise.all(writes);
    if (removals.length > 0) await Promise.all(removals);
    return jsonResponse({ results });
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
