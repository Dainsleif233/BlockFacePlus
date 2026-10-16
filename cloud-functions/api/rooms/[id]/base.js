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
  baseImageKey,
  errorResponse,
  contentTypeForExt,
  extForContentType,
  getStoreStrong,
  jsonResponse,
  passwordOf,
  pruneBaseImages,
  readJsonBody,
  metaKey,
  requireRoom,
  roomPrefix,
} from '../../lib.js';

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 换底图的键只可能是 sign 发出去的那种固定键（rooms/<id>/images/base.<后缀>），别的一律不认 */
function swapKeyOf(roomId, raw) {
  if (typeof raw !== 'string') return null;
  const prefix = `${roomPrefix(roomId)}images/base.`;
  if (!raw.startsWith(prefix)) return null;
  return contentTypeForExt(raw.slice(prefix.length)) ? raw : null;
}

function sanitizeName(raw) {
  return String(raw ?? '')
    .replace(/[\u0000-\u001f]/g, '')
    .trim()
    .slice(0, 80);
}

export async function onRequestGet(context) {
  try {
    const meta = await requireRoom(context.params.id);
    const role = await authenticate(meta, passwordOf(context.request));
    if (!role) throw new ApiError(401, '密码不对');

    if (!meta.baseImage) throw new ApiError(409, '底图尚未上传完成');
    const store = await getStoreStrong();
    const bytes = await store.get(meta.baseImage.key, { type: 'arrayBuffer' });
    if (!bytes) throw new ApiError(404, '底图文件丢失');

    return new Response(bytes, {
      status: 200,
      headers: {
        'Content-Type': meta.baseImage.type,
        // 白名单之外不让浏览器猜类型：避免上传内容被当成可执行文档
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, max-age=60',
        // 响应头不允许非 ASCII：文件名 percent-encoding，前端 decodeURIComponent 解回来
        'X-BF-Base-Name': encodeURIComponent(meta.baseImage.name || '底图'),
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
    const role = await authenticate(meta, passwordOf(context.request));
    const body = await readJsonBody(context.request);
    if (!isRecord(body)) throw new ApiError(400, '请求体格式不对');

    const store = await getStoreStrong();

    if (body.intent === 'sign') {
      // 换底图：只有管理员；预签名 URL 十分钟内有效，够前端直传
      if (role !== 'admin') throw new ApiError(403, '只有管理员能更换底图');
      const type = String(body.type ?? '').toLowerCase();
      const ext = extForContentType(type);
      if (!ext) throw new ApiError(400, '底图只支持 PNG / JPG / WebP / GIF');
      // 同一间房、同一个后缀只对应一个键：重新上传就是覆盖，
      // 不会因为「签了名传了不确认」在库里堆出一串没人引用的死文件
      const key = baseImageKey(meta.roomId, ext);
      const { url, expiresAt } = await store.createUploadUrl(key, { expireSeconds: 600, contentType: type });
      // 顺手把上一次没确认的残渣收掉（这次要传的、以及当前正在用的底图除外）
      await pruneBaseImages(meta.roomId, [key, meta.baseImage?.key]).catch(() => {});
      return jsonResponse({ upload: { url, key, expiresAt } });
    }

    if (body.intent === 'confirm') {
      const isDraft = meta.status === 'draft';
      // 草稿期是"创建者正在发布"的窗口，编辑者密码可确认；就绪之后换底图仅管理员
      if (!isDraft && role !== 'admin') throw new ApiError(403, '只有管理员能更换底图');

      // 草稿期的键是创建时发的那个；房间就绪后只认 sign 发出去的那种固定键
      const pending = isDraft ? meta.pendingBase : null;
      const key = isDraft ? pending?.key : swapKeyOf(meta.roomId, body.key);
      if (!key) throw new ApiError(400, '缺少待确认的底图');

      // 只认真正躺在存储里的对象：拿不到头部就别把房间推进 ready，
      // 否则会得到一间「发布成功、底图永远 404」的房间。
      const head = await store.getWithHeaders(key).catch(() => null);
      const headers = head?.headers ?? {};
      const length = Number(headers['content-length'] ?? headers['Content-Length'] ?? 0);
      if (!head || !Number.isFinite(length) || length <= 0) {
        throw new ApiError(409, '底图还没传上来，重新上传一次');
      }
      if (length > MAX_BASE_IMAGE_BYTES) {
        await store.delete(key).catch(() => {});
        throw new ApiError(413, '底图超过 10MB 上限');
      }

      const ext = key.slice(key.lastIndexOf('.') + 1);
      // 房间就绪后的换底图：手里只有 key 的后缀，用反查表还原 MIME（extForContentType 的方向是反的）
      const type = isDraft ? pending?.type : contentTypeForExt(ext);
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
      await store.setJSON(metaKey(meta.roomId), nextMeta);

      // 确认之后清掉同前缀的其它底图：旧后缀的、上传中断的、历史遗留的 base-<时间戳>。
      // 它们都没有 meta 引用，不收就一直占着 1GB 的额度。
      await pruneBaseImages(meta.roomId, key).catch(() => {});
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
