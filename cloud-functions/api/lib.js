/*!
 * BlockFace+ · 协同房间后端共享工具
 * Copyright 2026 Dainsleif · Apache License 2.0
 *
 * EdgeOne Makers 没有托管数据库，所有状态都存 Blob（@edgeone/pages-blob）。
 * 键位前缀就是"表名"：
 *   rooms/<roomId>/meta.json            房间元信息（含密码哈希，绝不外发）
 *   rooms/<roomId>/avatars/<id>.json    每个头像一条记录（一头像一键，天然免合并冲突）
 *   rooms/<roomId>/images/base*.png     底图字节
 *   index/<roomId>.json                 过期清扫用的轻量索引
 * 全部读写使用 strong 一致性：写完的下一次读必须能读到。
 */

import { getStore } from '@edgeone/pages-blob';
import crypto from 'node:crypto';

export const STORE_NAME = 'blockface-plus';
export const MAX_LAYERS = 128;
export const MAX_SKIN_DATA_URL = 1_500_000;
export const MAX_POSITION = 32768;
export const MIN_LAYER_SIZE = 16;
export const MAX_LAYER_SIZE = 4096;
export const MAX_DOC_SIZE = 8192;
export const MAX_BASE_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_PATCH_UPDATES = 64;
/** 与前端 preset.ts 同一口径：白名单 data URI，防止 javascript: 之类的东西混进 <img src> */
const SKIN_DATA_URL_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+\/=]*$/;
const ROOM_ID_RE = /^[A-Za-z0-9_-]{6,64}$/;
const LAYER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** 密码字符表：去掉 0/1/l/o 这类肉眼易混的字符，抄写不出错 */
const PASSWORD_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';
const EXPIRY_DAYS = new Set([3, 7, 14]);
const DAY_MS = 86_400_000;
const CONTENT_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

export class ApiError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.extra = extra;
  }
}

/* ------------------------------------------------------------------ *
 * Blob 存取
 * ------------------------------------------------------------------ */

let storePromise = null;

/** 全项目共用的强一致 store 单例：写完的下一次读必须能读到 */
export function getStoreStrong() {
  if (!storePromise) {
    storePromise = Promise.resolve(getStore({ name: STORE_NAME, consistency: 'strong' }));
  }
  return storePromise;
}

function store() {
  return getStoreStrong();
}

export function roomPrefix(roomId) {
  return `rooms/${roomId}/`;
}

export function metaKey(roomId) {
  return `rooms/${roomId}/meta.json`;
}

export function avatarKey(roomId, layerId) {
  return `rooms/${roomId}/avatars/${layerId}.json`;
}

export function indexKey(roomId) {
  return `index/${roomId}.json`;
}

export function extForContentType(contentType) {
  return CONTENT_EXT[String(contentType || '').toLowerCase()] ?? null;
}

/** 反查：底图确认时只拿得到文件后缀，需要还原 MIME 类型 */
const EXT_CONTENT_TYPE = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

export function contentTypeForExt(ext) {
  return EXT_CONTENT_TYPE[String(ext || '').toLowerCase()] ?? null;
}

/* ------------------------------------------------------------------ *
 * 密码：生成 / 哈希 / 校验
 *
 * 密码只在创建响应里出现一次，之后任何接口都不会回传；
 * 落库只存 scrypt 哈希，校验用 timingSafeEqual 防时序侧信道。
 * ------------------------------------------------------------------ */

function randomPassword(length) {
  const bytes = crypto.randomBytes(length * 2);
  let out = '';
  for (let i = 0; out.length < length && i < bytes.length; i += 1) {
    // 拒绝采样：256 不能被 32 整除，直接取模会有极轻微偏斜
    const b = bytes[i];
    if (b < 256 - (256 % PASSWORD_ALPHABET.length)) out += PASSWORD_ALPHABET[b % PASSWORD_ALPHABET.length];
  }
  return out;
}

export function generateRoomId() {
  return crypto.randomBytes(9).toString('base64url').replaceAll('-', 'a').replaceAll('_', 'b');
}

export function generateEditPassword() {
  return randomPassword(8);
}

export function generateAdminPassword() {
  return randomPassword(12);
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 32).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const [scheme, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const actual = crypto.scryptSync(password, salt, 32);
  const expected = Buffer.from(hash, 'hex');
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

/* ------------------------------------------------------------------ *
 * 失败鉴权的简易限流（内存态，冷启动清零 —— 够抬高暴力尝试的门槛）
 * ------------------------------------------------------------------ */

const AUTH_WINDOW_MS = 5 * 60_000;
const AUTH_MAX_FAILS = 10;
const failedAuth = new Map();

export function isRateLimited(ip) {
  const entry = failedAuth.get(ip);
  if (!entry) return false;
  if (Date.now() > entry.resetAt) {
    failedAuth.delete(ip);
    return false;
  }
  return entry.count >= AUTH_MAX_FAILS;
}

export function recordAuthFailure(ip) {
  const now = Date.now();
  const entry = failedAuth.get(ip);
  if (entry && now <= entry.resetAt) {
    entry.count += 1;
  } else {
    failedAuth.set(ip, { count: 1, resetAt: now + AUTH_WINDOW_MS });
  }
  if (failedAuth.size > 5000) failedAuth.clear();
}

export function clearAuthFailures(ip) {
  failedAuth.delete(ip);
}

export function checkPassword(meta, password) {
  if (typeof password !== 'string' || password.length === 0 || password.length > 128) return null;
  if (verifyPassword(password, meta.adminPasswordHash)) return 'admin';
  if (verifyPassword(password, meta.editPasswordHash)) return 'editor';
  return null;
}

/* ------------------------------------------------------------------ *
 * 数据整理：与前端 preset.ts 同一套口径，超界一律夹回合法区间
 * ------------------------------------------------------------------ */

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clampNumber(value, min, max, fallback) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function normalizeSkinRecord(raw) {
  const record = isRecord(raw) ? raw : null;
  if (!record) return null;
  if (typeof record.dataUrl !== 'string' || record.dataUrl.length > MAX_SKIN_DATA_URL) return null;
  if (!SKIN_DATA_URL_RE.test(record.dataUrl)) return null;
  const skin = {
    dataUrl: record.dataUrl,
    width: Math.round(clampNumber(record.width, 8, 8192, 64)),
    height: Math.round(clampNumber(record.height, 8, 8192, 64)),
  };
  if (record.isCustomImage === true) skin.isCustomImage = true;
  if (record.frontOnly === true) skin.frontOnly = true;
  return skin;
}

/** 把任意来源的一条头像记录收拾干净；收拾不出来返回 null */
export function normalizeAvatarRecord(raw, index = 0) {
  if (!isRecord(raw)) return null;
  if (typeof raw.id !== 'string' || !LAYER_ID_RE.test(raw.id)) return null;
  const rawName = typeof raw.name === 'string' ? raw.name.trim() : '';
  const order = Math.max(0, Math.round(clampNumber(raw.order, 0, Number.MAX_SAFE_INTEGER, index)));
  const skin = raw.skin === null || raw.skin === undefined ? null : normalizeSkinRecord(raw.skin);
  if (raw.skin != null && !skin) return null;
  return {
    id: raw.id,
    name: (rawName || '头像 ' + (index + 1)).slice(0, 40),
    x: clampNumber(raw.x, -MAX_POSITION, MAX_POSITION, 0),
    y: clampNumber(raw.y, -MAX_POSITION, MAX_POSITION, 0),
    size: Math.round(clampNumber(raw.size, MIN_LAYER_SIZE, MAX_LAYER_SIZE, 256)),
    rotation: Math.round(clampNumber(raw.rotation, -3600, 3600, 0)),
    opacity: clampNumber(raw.opacity, 0, 1, 1),
    overlay: raw.overlay !== false,
    flipH: raw.flipH === true,
    visible: raw.visible !== false,
    order,
    skin,
  };
}

export function normalizeRoomId(raw) {
  return typeof raw === 'string' && ROOM_ID_RE.test(raw) ? raw : null;
}

/* ------------------------------------------------------------------ *
 * 房间生命周期
 * ------------------------------------------------------------------ */

export async function getRoomMeta(roomId) {
  const s = await store();
  return s.get(metaKey(roomId), { type: 'json' });
}

/** 过期房间就地删除，然后返回 410 语义 */
export function isExpired(meta, now = Date.now()) {
  return typeof meta?.expiresAt === 'number' && now > meta.expiresAt;
}

export async function deleteRoom(roomId) {
  const s = await store();
  const { blobs } = await s.list({ prefix: roomPrefix(roomId) });
  await Promise.all(blobs.map((b) => s.delete(b.key)));
  await s.delete(indexKey(roomId));
}

/** 顺带清理：把索引里已过期的房间连锅端掉（惰性过期 + 创建时摊销清扫） */
export async function sweepExpiredRooms(now = Date.now()) {
  const s = await store();
  const { blobs } = await s.list({ prefix: 'index/' });
  const expired = [];
  for (const b of blobs) {
    const entry = await s.get(b.key, { type: 'json' });
    if (entry && typeof entry.roomId === 'string' && isExpired(entry, now)) expired.push(entry.roomId);
  }
  await Promise.all(expired.map((roomId) => deleteRoom(roomId).catch(() => {})));
  return expired.length;
}

export function publicRoom(meta) {
  return {
    roomId: meta.roomId,
    doc: meta.doc,
    baseImage: meta.baseImage ?? null,
    createdAt: meta.createdAt,
    expiresAt: meta.expiresAt,
    revision: meta.revision ?? 0,
    status: meta.status ?? 'ready',
  };
}

/** 读取房间并做存在性 / 过期检查；不过关直接抛 ApiError */
export async function requireRoom(roomId) {
  const meta = await getRoomMeta(roomId);
  if (!meta) throw new ApiError(404, '房间不存在或已被删除');
  if (isExpired(meta)) {
    await deleteRoom(roomId).catch(() => {});
    throw new ApiError(410, '房间已过期');
  }
  return meta;
}

/** 鉴权 + 限流；密码错一律 401，不区分"房间不存在"以外的细节 */
export function authenticate(meta, password, ip) {
  if (isRateLimited(ip)) throw new ApiError(429, '尝试太频繁，请几分钟后再来');
  const role = checkPassword(meta, password);
  if (!role) {
    recordAuthFailure(ip);
    throw new ApiError(401, '密码不对');
  }
  clearAuthFailures(ip);
  return role;
}

/* ------------------------------------------------------------------ *
 * 请求 / 响应小工具
 * ------------------------------------------------------------------ */

export function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

export function errorResponse(status, message, extra = {}) {
  return jsonResponse({ error: message, ...extra }, status);
}

export function passwordOf(request) {
  const header = request.headers.get('x-bf-room-pwd');
  return typeof header === 'string' ? header : '';
}

export async function readJsonBody(request, maxChars = 5 * 1024 * 1024) {
  const text = await request.text();
  if (text.length > maxChars) throw new ApiError(413, '请求体太大');
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(400, '请求体不是合法 JSON');
  }
}

export function pickExpiryMs(days) {
  return EXPIRY_DAYS.has(days) ? days * DAY_MS : null;
}

export { DAY_MS };
