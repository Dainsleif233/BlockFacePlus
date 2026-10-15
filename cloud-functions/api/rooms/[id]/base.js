/*!
 * BlockFace+ · 底图直传与读取
 * Copyright 2026 Dainsleif · Apache License 2.0
 *
 * GET  /api/rooms/[id]/base   拉底图字节（按密码鉴权；带缓存头，内容基本不变）
 * POST /api/rooms/[id]/base   两种意图：
 *   { intent: 'sign' }    仅管理员：换底图前申请预签名上传 URL
 *   { intent: 'confirm' } 底图上传完成后回执确认；草稿期（创建中）编辑者密码也放行，
 *                         房间就绪后仅管理员（换底图）
 */

import {
  ApiError,
  MAX_BASE_IMAGE_BYTES,
  MAX_DOC_SIZE,
  authenticate,
  errorResponse,
  extForContentType,
  getStoreStrong,
  jsonResponse,
  passwordOf,
  readJsonBody,
  requireRoom,
  roomPrefix,
} from '../../lib.js';

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sanitizeName(raw) {
  return String(raw ?? '')
    .replace(/[\u0000-\u001f]/g, '')
    .trim()
    .slice(0, 80);
}

function baseKeyOf(meta, ext) {
  return `rooms/${meta.roomId}/images/base.${ext}`;
}

export async function onRequestGet(context) {
  try {
    const meta = await requireRoom(context.params.id);
    const role = authenticate(meta, passwordOf(context.request), context.clientIp);
    if (!role) throw new ApiError(401, '密码不对');

    if (!meta.baseImage) throw new ApiError(409, '底图尚未上传完成');
    const store = await getStoreStrong();
    const bytes = await store.get(meta.baseImage.key, { type: 'arrayBuffer' });
    if (!bytes) throw new ApiError(404, '底图文件丢失');

    return new Response(bytes, {
      status: 200,
      headers: {
        'Content-Type': meta.baseImage.type,
        'Cache-Control': 'private, max-age=60',
      },
    });
  } catch (error) {
    if (error instanceof ApiError) return errorResponse(error.status, error.message, error.extra);
    console.error('[rooms:base:get]', error);
    return errorResponse(500, '服务器开小差了，稍后再试');
  }
}

export async function onRequestPost(context) {
  try {
    const meta = await requireRoom(context.params.id);
    const role = authenticate(meta, passwordOf(context.request), context.clientIp);
    const body = await readJsonBody(context.request);
    if (!isRecord(body)) throw new ApiError(400, '请求体格式不对');

    const store = await getStoreStrong();

    if (body.intent === 'sign') {
      // 换底图：只有管理员；预签名 URL 十分钟内有效，够前端直传
      if (role !== 'admin') throw new ApiError(403, '只有管理员能更换底图');
      const ext = extForContentType(body.type);
      if (!ext) throw new ApiError(400, '底图只支持 PNG / JPG / WebP / GIF');
      const key = `rooms/${meta.roomId}/images/base-${Date.now()}.${ext}`;
      const { url, expiresAt } = await store.createUploadUrl(key, {
        expireSeconds: 600,
        contentType: String(body.type).toLowerCase(),
      });
      return jsonResponse({ upload: { url, key, expiresAt } });
    }

    if (body.intent === 'confirm') {
      const isDraft = meta.status === 'draft';
      // 草稿期是"创建者正在发布"的窗口，编辑者密码可确认；就绪之后换底图仅管理员
      if (!isDraft && role !== 'admin') throw new ApiError(403, '只有管理员能更换底图');

      const pending = isDraft ? meta.pendingBase : null;
      const key = isDraft
        ? pending?.key
        : typeof body.key === 'string' && body.key.startsWith(roomPrefix(meta.roomId) + 'images/base-')
          ? body.key
          : null;
      if (!key) throw new ApiError(400, '缺少待确认的底图');

      const headers = (await store.getWithHeaders(key))?.headers ?? {};
      const length = Number(headers['content-length'] ?? headers['Content-Length'] ?? 0);
      if (length > MAX_BASE_IMAGE_BYTES) {
        await store.delete(key).catch(() => {});
        throw new ApiError(413, '底图超过 10MB 上限');
      }

      const ext = key.slice(key.lastIndexOf('.') + 1);
      const type = isDraft ? pending?.type : extForContentType(ext) ? `image/${ext === 'jpg' ? 'jpeg' : ext}` : null;
      if (!type) throw new ApiError(400, '底图类型不合法');

      const width = Math.round(Number(body.width));
      const height = Math.round(Number(body.height));
      if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1 || width > MAX_DOC_SIZE || height > MAX_DOC_SIZE) {
        throw new ApiError(400, '底图尺寸不合法');
      }

      const baseImage = { key, type, name: sanitizeName(body.name) || '底图', width, height };
      const nextMeta = {
        ...meta,
        baseImage,
        status: 'ready',
        doc: { width, height },
        pendingBase: null,
        revision: (meta.revision ?? 0) + 1,
      };
      await store.setJSON(`rooms/${meta.roomId}/meta.json`, nextMeta);

      // 换底图成功后清掉旧文件，别让 1GB 额度被旧图吃掉
      if (!isDraft && meta.baseImage && meta.baseImage.key !== key) {
        await store.delete(meta.baseImage.key).catch(() => {});
      }
      return jsonResponse({ ok: true, doc: { width, height }, revision: nextMeta.revision });
    }

    throw new ApiError(400, '未知操作');
  } catch (error) {
    if (error instanceof ApiError) return errorResponse(error.status, error.message, error.extra);
    console.error('[rooms:base:post]', error);
    return errorResponse(500, '服务器开小差了，稍后再试');
  }
}

export function onRequestPut() { return errorResponse(405, 'Method not allowed'); }
export function onRequestDelete() { return errorResponse(405, 'Method not allowed'); }
