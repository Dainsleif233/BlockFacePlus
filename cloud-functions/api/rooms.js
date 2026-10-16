/*!
 * BlockFace+ · 创建协同房间
 * Copyright 2026 Dainsleif · Apache License 2.0
 *
 * POST /api/rooms
 * 入参：{ baseImage: { name, type, width, height }, layers: [头像记录], expiresDays }
 * 出参：{ roomId, editPassword, adminPassword, expiresAt, upload: { url, key } }
 *
 * 密码只在本响应里出现一次，之后不回传；底图走预签名 URL 由前端直传 Blob，
 * 字节不经过函数（云函数请求体上限 6MB，底图不该挤这条路）。
 *
 * 建房是唯一一次同时写三张表的时刻：房间身份、底图、每个头像一行。
 * 之后这三张表各有各的主人，谁都不会再碰别人的。
 */

import {
  ADMIN_PASSWORD_LENGTH,
  ApiError,
  EDIT_PASSWORD_LENGTH,
  MAX_DOC_SIZE,
  MAX_LAYERS,
  avatarKey,
  baseImageKey,
  baseKey,
  errorResponse,
  extForContentType,
  generateAdminPassword,
  generateEditPassword,
  generateRoomId,
  getStoreStrong,
  hashPassword,
  indexKey,
  jsonResponse,
  mapLimit,
  metaKey,
  normalizeAvatarRecord,
  normalizeBaseName,
  pickExpiryMs,
  readJsonBody,
  sweepExpiredRooms,
} from './lib.js';

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function onRequestPost(context) {
  try {
    const body = await readJsonBody(context.request);
    if (!isRecord(body)) throw new ApiError(400, '请求体格式不对');

    const baseImage = isRecord(body.baseImage) ? body.baseImage : null;
    if (!baseImage) throw new ApiError(400, '缺少底图信息');
    const ext = extForContentType(baseImage.type);
    if (!ext) throw new ApiError(400, '底图只支持 PNG / JPG / WebP / GIF');

    const width = Math.round(Number(baseImage.width));
    const height = Math.round(Number(baseImage.height));
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1 || width > MAX_DOC_SIZE || height > MAX_DOC_SIZE) {
      throw new ApiError(400, '底图尺寸不合法');
    }

    const rawLayers = Array.isArray(body.layers) ? body.layers : [];
    if (rawLayers.length === 0) throw new ApiError(400, '至少要先摆一个头像再发布');
    if (rawLayers.length > MAX_LAYERS) throw new ApiError(400, `头像最多 ${MAX_LAYERS} 个`);
    const seenIds = new Set();
    const layers = rawLayers.map((item, index) => {
      const record = normalizeAvatarRecord(item, index);
      if (!record) throw new ApiError(400, `第 ${index + 1} 个头像的数据不合法`);
      if (seenIds.has(record.id)) throw new ApiError(400, '头像 id 重复');
      seenIds.add(record.id);
      return record;
    });

    const days = Math.round(Number(body.expiresDays));
    const ttlMs = pickExpiryMs(days);
    if (ttlMs === null) throw new ApiError(400, '过期时间只支持 3 / 7 / 14 天');

    const roomId = generateRoomId();
    const now = Date.now();
    const expiresAt = now + ttlMs;
    const imageKey = baseImageKey(roomId, ext);

    const editPassword = generateEditPassword();
    const adminPassword = generateAdminPassword();
    const [editPasswordHash, adminPasswordHash] = await Promise.all([hashPassword(editPassword), hashPassword(adminPassword)]);

    // 表一：房间身份。写完这一次，之后没有任何代码路径会再写它
    const meta = {
      roomId,
      createdAt: now,
      expiresAt,
      editPasswordHash,
      adminPasswordHash,
      // 记下密码长度：校验时长度对不上的一把不用去算 scrypt（见 checkPassword）
      editPasswordLength: EDIT_PASSWORD_LENGTH,
      adminPasswordLength: ADMIN_PASSWORD_LENGTH,
    };

    // 表二：底图。草稿期先记下待上传的键，确认（confirm）时才变 ready
    const base = {
      key: imageKey,
      type: String(baseImage.type).toLowerCase(),
      name: normalizeBaseName(baseImage.name),
      width,
      height,
      status: 'draft',
      pending: { key: imageKey, type: String(baseImage.type).toLowerCase() },
      updatedAt: now,
    };

    const store = await getStoreStrong();
    await store.setJSON(metaKey(roomId), meta);
    await store.setJSON(baseKey(roomId), base);
    await store.setJSON(indexKey(roomId), { roomId, createdAt: now, expiresAt });
    // 表三：一个头像一行。行内布局与皮肤各有各的版本戳，改一个不会动另一个
    await mapLimit(layers, 32, (record) => store.setJSON(avatarKey(roomId, record.id), {
      ...record,
      skinUpdatedAt: now,
      layoutUpdatedAt: now,
    }));

    const { url, expiresAt: urlExpiresAt } = await store.createUploadUrl(imageKey, {
      expireSeconds: 3600,
      contentType: base.type,
    });

    // 创建是最低频的入口，正好把过期房间顺手清一清（惰性过期的摊销清扫）
    sweepExpiredRooms().catch(() => {});

    return jsonResponse({
      roomId,
      editPassword,
      adminPassword,
      expiresAt,
      upload: { url, key: imageKey, expiresAt: urlExpiresAt },
    }, 201);
  } catch (error) {
    if (error instanceof ApiError) return errorResponse(error.status, error.message, error.extra);
    console.error('[rooms:create]', error);
    return errorResponse(500, '服务器开小差了，稍后再试');
  }
}

// 其余方法一律 405，说明这个文件只管创建
export function onRequestGet() { return errorResponse(405, 'Method not allowed'); }
export function onRequestPut() { return errorResponse(405, 'Method not allowed'); }
export function onRequestPatch() { return errorResponse(405, 'Method not allowed'); }
export function onRequestDelete() { return errorResponse(405, 'Method not allowed'); }
