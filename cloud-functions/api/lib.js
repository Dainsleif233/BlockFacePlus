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
import { promisify } from 'node:util';

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
export const LAYER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** 密码字符表：去掉 0/1/l/o 这类肉眼易混的字符，抄写不出错 */
const PASSWORD_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';
/**
 * 密码长度：编辑 8 位、管理员 12 位。
 * 校验时先看长度 —— 长度对不上的那把密码根本不用去算 scrypt，
 * 于是「乱长度」的尝试是零成本，「可能是真的」的尝试只需要一次派生（原来是两次）。
 */
export const EDIT_PASSWORD_LENGTH = 8;
export const ADMIN_PASSWORD_LENGTH = 12;
const EXPIRY_DAYS = new Set([3, 7, 14]);
const DAY_MS = 86_400_000;
/**
 * 后缀 ⇄ MIME 的对照表，必须是「没有原型」的表。
 * 普通对象字面量上 `CONTENT_EXT['constructor']`、`['__proto__']` 会查到继承来的属性而返回真值，
 * 白名单等于形同虚设（实测能把 type 传成 constructor / __proto__ 并建出一间底图永远显示不出来的房间）。
 */
const CONTENT_EXT = Object.freeze(Object.assign(Object.create(null), {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}));

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

/**
 * 底图对象键：同一间房、同一个后缀**只有一个键**。
 * 早先换底图用 base-<Date.now()>.<ext> 造新键，每次签名都是一个新对象：
 * 签了名传了不确认，库里就留一份永远没人引用的死文件，1GB 额度被这么吃掉。
 */
export function baseImageKey(roomId, ext) {
  return `rooms/${roomId}/images/base.${ext}`;
}

export function indexKey(roomId) {
  return `index/${roomId}.json`;
}

/**
 * 把房间里除 keep 之外的底图对象全清掉。
 * 换过后缀的旧图、上传中断的残渣、早期版本留下的 base-<时间戳>，都没有 meta 引用，
 * 不主动收就只会一直占着额度。keep 传数组，调用方自己决定要留哪几份。
 */
export async function pruneBaseImages(roomId, keep) {
  const s = await store();
  const keepSet = new Set((Array.isArray(keep) ? keep : [keep]).filter(Boolean));
  const { blobs } = await s.list({ prefix: `rooms/${roomId}/images/base` });
  const junk = blobs.map((b) => b.key).filter((key) => !keepSet.has(key));
  await Promise.all(junk.map((key) => s.delete(key).catch(() => {})));
  return junk.length;
}

export function extForContentType(contentType) {
  if (typeof contentType !== 'string') return null;
  return CONTENT_EXT[contentType.toLowerCase()] ?? null;
}

/** 反查：底图确认时只拿得到文件后缀，需要还原 MIME 类型 */
const EXT_CONTENT_TYPE = Object.freeze(Object.assign(Object.create(null), {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
}));

export function contentTypeForExt(ext) {
  if (typeof ext !== 'string') return null;
  return EXT_CONTENT_TYPE[ext.toLowerCase()] ?? null;
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

/** 异步版：scryptSync 会把整个事件循环堵住，一个 isolate 同时只能伺候一个请求 */
const scrypt = promisify(crypto.scrypt);

/** 落库格式没变（scrypt$盐$哈希），老房间的哈希照样能验 */
export async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = (await scrypt(password, salt, 32)).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

export async function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const [scheme, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'hex');
  if (expected.length === 0) return false;
  const actual = await scrypt(password, salt, expected.length);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

/* ------------------------------------------------------------------ *
 * 失败鉴权的限流：**按房间**算，状态落盘
 *
 * 三个坑都踩过了，记录在此：
 *  1. 按 IP 计数 → 同一个 NAT 后面的人一起被关，纯连坐；
 *  2. 计数放内存 → 这套运行时每次请求都是全新的模块状态，实测连发 15 次错密码
 *     一个 429 都没出，等于没写（生产是否复用 isolate 不由我们决定，不能赌）；
 *  3. 计数写进 meta → 又多一个整文档覆盖的写者，容易和底图/头像的写入互相抹。
 * 所以：状态单独落一个键，按房间算，读一次看一眼锁，写只发生在失败时。
 * ------------------------------------------------------------------ */

const AUTH_WINDOW_MS = 60_000;
const AUTH_MAX_FAILS = 10;

function throttleKey(roomId) {
  return `throttle/${roomId}.json`;
}

/** 只看一眼锁定状态；读不到（含存储抖动）一律当成没锁，别把正常人挡在外面 */
async function readThrottle(roomId) {
  try {
    const s = await store();
    return await s.get(throttleKey(roomId), { type: 'json' });
  } catch {
    return null;
  }
}

async function noteAuthFailure(roomId, now) {
  const prev = await readThrottle(roomId);
  const inWindow = prev && typeof prev.windowStart === 'number' && now - prev.windowStart < AUTH_WINDOW_MS;
  const count = inWindow ? Number(prev.count ?? 0) + 1 : 1;
  const state = count >= AUTH_MAX_FAILS
    ? { lockedUntil: now + AUTH_WINDOW_MS }
    : { count, windowStart: inWindow ? prev.windowStart : now };
  try {
    const s = await store();
    await s.setJSON(throttleKey(roomId), state);
  } catch {
    /* 限流本身不该把登录请求打成 500 */
  }
}

/**
 * 校验密码并给出角色。
 * 长度先过一道：管理员 12 位、编辑 8 位 —— 长度对不上的那把根本不用去算 scrypt。
 * 长度存在 meta 里（老房间没有就按当前约定），以后要改长度也不会把老房间锁在门外。
 */
export async function checkPassword(meta, password) {
  if (typeof password !== 'string' || password.length === 0 || password.length > 128) return null;
  const adminLen = typeof meta.adminPasswordLength === 'number' ? meta.adminPasswordLength : ADMIN_PASSWORD_LENGTH;
  const editLen = typeof meta.editPasswordLength === 'number' ? meta.editPasswordLength : EDIT_PASSWORD_LENGTH;
  if (password.length === adminLen && (await verifyPassword(password, meta.adminPasswordHash))) return 'admin';
  if (password.length === editLen && (await verifyPassword(password, meta.editPasswordHash))) return 'editor';
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
  // 限流状态跟着房间一起走，别留下没人清的孤儿键
  await s.delete(throttleKey(roomId)).catch(() => {});
}

/** 顺带清理：把索引里已过期的房间连锅端掉（惰性过期 + 创建时摊销清扫） */
export async function sweepExpiredRooms(now = Date.now()) {
  const s = await store();
  // 清扫是建房时捎带的摊销任务：单页 + 截断，一次最多看 24 个索引，
  // 历史房间再多也不会把创建接口拖进超时（下一批留给下一次创建）。
  const { blobs } = await s.list({ prefix: 'index/', paginate: false });
  const batch = blobs.slice(0, 24);
  const entries = await Promise.all(
    batch.map(async (b) => {
      try {
        return await s.get(b.key, { type: 'json' });
      } catch {
        return null;
      }
    }),
  );
  const expired = entries
    .filter((entry) => entry && typeof entry.roomId === 'string' && isExpired(entry, now))
    .map((entry) => entry.roomId);
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

/**
 * 读取房间并做存在性 / 过期检查；不过关直接抛 ApiError。
 *
 * 房间号是从 URL 里抠出来的、要直接拼进存储键，所以第一步先按生成时的字符集验一遍：
 * 放过 `../`、空字符这类东西，存储层会直接报错并落到调用方的兜底分支变成 500，
 * 而未鉴权就能反复触发（实测 GET /api/rooms/..%2FAAAAAA、/a%00b 都是 500）。
 * 校验放在这里，四个入口（读/全量写/删/头像/底图）全都自动覆盖。
 */
export async function requireRoom(roomId) {
  if (!normalizeRoomId(roomId)) throw new ApiError(404, '房间不存在或已被删除');
  const meta = await getRoomMeta(roomId);
  if (!meta) throw new ApiError(404, '房间不存在或已被删除');
  if (isExpired(meta)) {
    await deleteRoom(roomId).catch(() => {});
    throw new ApiError(410, '房间已过期');
  }
  return meta;
}

/** 鉴权 + 限流；密码错一律 401，不区分"房间不存在"以外的细节 */
export async function authenticate(meta, password) {
  const now = Date.now();
  const throttle = await readThrottle(meta.roomId);
  // 锁上了就地拒绝：这一条不跑 scrypt，也就没有 CPU 可刷
  if (throttle && typeof throttle.lockedUntil === 'number' && now < throttle.lockedUntil) {
    throw new ApiError(429, `这个房间密码试错太频繁，${Math.ceil((throttle.lockedUntil - now) / 1000)} 秒后再来`);
  }
  const role = await checkPassword(meta, password);
  if (!role) {
    await noteAuthFailure(meta.roomId, now);
    throw new ApiError(401, '密码不对');
  }
  return role;
}

/* ------------------------------------------------------------------ *
 * 请求 / 响应小工具
 * ------------------------------------------------------------------ */

export function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      // 别让浏览器把 JSON 当 HTML 猜：JSON 接口的类型嗅探是 XSS 的老入口
      'X-Content-Type-Options': 'nosniff',
    },
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
  // 先看声明的字节数，别把超大 body 整个读进内存。
  // UTF-8 下 1 个 UTF-16 单元最多编成 3 字节，所以字节数超过 maxChars * 3 的请求，
  // 字符数必然超限 —— 提前拒掉，合法请求一个都不会被误伤。
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxChars * 3) throw new ApiError(413, '请求体太大');
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
