/*!
 * BlockFace+ · 协同房间后端共享工具
 * Copyright 2026 Dainsleif · Apache License 2.0
 *
 * EdgeOne Makers 没有托管数据库，所有状态都存 Blob（@edgeone/pages-blob）。
 * 键位就是"表"，**一张表只有一个主人**，谁都不许整份回写别人的表：
 *
 *   rooms/<roomId>/meta.json              房间身份：房间号/创建时间/过期时间/两个密码哈希
 *                                         —— 建房时写一次，此后没有任何代码路径会再写它
 *   rooms/<roomId>/base.json              底图指针 + 画布尺寸 + 房间状态（draft/ready）
 *                                         —— 只有底图这两条路（sign / confirm）会写
 *   rooms/<roomId>/avatars/<id>.json      一个头像一行：布局字段 + 皮肤字段 + 两个版本戳
 *                                         —— 改布局只动布局字段，换皮肤只动皮肤字段
 *   rooms/<roomId>/images/base.<ext>      底图字节
 *   index/<roomId>.json                   过期清扫用索引
 *   throttle/<roomId>.json                登录失败限流
 *
 * 为什么这么拆：早先三件事（换底图 / 换头像内容 / 保存布局）都往同一份 meta.json 里
 * 整份回写，后写的那次必然带着自己开头读到的旧内容，把先写的那次的成果覆盖掉——
 * 实测能造出"底图指针指向已被删除的文件、房间永久打不开"。现在三件事的键在物理上
 * 不重叠，互相覆盖这件事从根上不可能发生。
 * 全部读写使用 strong 一致性：写完的下一次读必须能读到。
 */

import { getStore } from '@edgeone/pages-blob';
import crypto from 'node:crypto';
import { promisify } from 'node:util';

export const STORE_NAME = 'blockface-plus';
/**
 * 一间房最多多少行头像。
 * 每行一个对象、一次房间加载要把它们全读出来，所以这里是个真的代价上限，
 * 不是拿来恶心人的数量限制：512 行已经远超正常拼图的规模。
 * 单次请求里能带多少条由请求体积决定（见 readJsonBody），不再按条数卡人。
 */
export const MAX_LAYERS = 512;
export const MAX_SKIN_DATA_URL = 1_500_000;
/** 头像名会跟着每次房间加载回给所有成员，留个宽裕的上限防止有人拿它灌字节 */
export const MAX_AVATAR_NAME = 200;
export const MAX_POSITION = 32768;
export const MIN_LAYER_SIZE = 16;
export const MAX_LAYER_SIZE = 4096;
export const MAX_DOC_SIZE = 8192;
export const MAX_BASE_IMAGE_BYTES = 10 * 1024 * 1024;
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

/**
 * 限量并发：房间可以有几百行头像，一次全丢给存储层会开几百条连接。
 * 分批发、每批内部并发，够快也不失礼。
 */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  for (let i = 0; i < items.length; i += limit) {
    const slice = items.slice(i, i + limit);
    const done = await Promise.all(slice.map((item, k) => fn(item, i + k)));
    for (let k = 0; k < done.length; k += 1) out[i + k] = done[k];
  }
  return out;
}

export function roomPrefix(roomId) {
  return `rooms/${roomId}/`;
}

/** 房间身份表：只在建房时写 */
export function metaKey(roomId) {
  return `rooms/${roomId}/meta.json`;
}

/** 底图表：底图指针 + 画布尺寸 + 房间状态 */
export function baseKey(roomId) {
  return `rooms/${roomId}/base.json`;
}

export function avatarKey(roomId, layerId) {
  return `rooms/${roomId}/avatars/${layerId}.json`;
}

/**
 * 底图对象键：同一间房、同一个后缀**只有一个键**。
 * 换底图用 base-<Date.now()>.<ext> 造新键的话，每次签名都是一个新对象：
 * 签了名传了不确认，库里就留一份永远没人引用的死文件。
 */
export function baseImageKey(roomId, ext) {
  return `rooms/${roomId}/images/base.${ext}`;
}

export function indexKey(roomId) {
  return `index/${roomId}.json`;
}

/**
 * 把房间里除 keep 之外的底图对象全清掉。
 * keep 传数组，调用方自己决定要留哪几份（当前在用的那张永远要留着）。
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
 *  3. 计数写进房间表 → 又多一个整文档覆盖的写者，容易和底图/头像的写入互相抹。
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
 * 长度存在房间身份表里（老房间没有就按当前约定）。
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

/** 头像名：只剥控制字符（防换行/控制码混进 UI 与日志），长度给足不截断真实名字 */
function cleanName(raw, fallback) {
  const text = typeof raw === 'string' ? raw.replace(/[\u0000-\u001f\u007f]/g, '').trim() : '';
  return (text || fallback).slice(0, MAX_AVATAR_NAME);
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

/**
 * 布局字段的**局部**补丁：只认请求里真的带了的键。
 * 缺的键一律不动 —— 这是"换皮肤不会碰到位置、挪位置不会碰到皮肤"的落点。
 * 返回 null 表示整条不合法；返回空对象表示这条什么也不用改。
 */
export function normalizeLayoutPatch(raw) {
  if (!isRecord(raw)) return null;
  const patch = {};
  if ('name' in raw) patch.name = cleanName(raw.name, '头像');
  if ('x' in raw) patch.x = clampNumber(raw.x, -MAX_POSITION, MAX_POSITION, 0);
  if ('y' in raw) patch.y = clampNumber(raw.y, -MAX_POSITION, MAX_POSITION, 0);
  if ('size' in raw) patch.size = Math.round(clampNumber(raw.size, MIN_LAYER_SIZE, MAX_LAYER_SIZE, 256));
  if ('rotation' in raw) patch.rotation = Math.round(clampNumber(raw.rotation, -3600, 3600, 0));
  if ('opacity' in raw) patch.opacity = clampNumber(raw.opacity, 0, 1, 1);
  if ('overlay' in raw) patch.overlay = raw.overlay !== false;
  if ('flipH' in raw) patch.flipH = raw.flipH === true;
  if ('visible' in raw) patch.visible = raw.visible !== false;
  if ('order' in raw) patch.order = Math.max(0, Math.round(clampNumber(raw.order, 0, Number.MAX_SAFE_INTEGER, 0)));
  return patch;
}

/** 整条头像记录（建房 / 新增一行时用）；收拾不出来返回 null */
export function normalizeAvatarRecord(raw, index = 0) {
  if (!isRecord(raw)) return null;
  if (typeof raw.id !== 'string' || !LAYER_ID_RE.test(raw.id)) return null;
  const layout = normalizeLayoutPatch(raw);
  if (!layout) return null;
  const skin = raw.skin === null || raw.skin === undefined ? null : normalizeSkinRecord(raw.skin);
  if (raw.skin != null && !skin) return null;
  return {
    id: raw.id,
    name: layout.name ?? `头像 ${index + 1}`,
    x: layout.x ?? 0,
    y: layout.y ?? 0,
    size: layout.size ?? 256,
    rotation: layout.rotation ?? 0,
    opacity: layout.opacity ?? 1,
    overlay: layout.overlay ?? true,
    flipH: layout.flipH ?? false,
    visible: layout.visible ?? true,
    order: layout.order ?? index,
    skin,
  };
}

/**
 * 底图名：会进 X-BF-Base-Name 响应头（响应头不允许非 ASCII，前端再 decodeURIComponent 解回来），
 * 所以必须剥控制字符 + 留一个上限，别让人拿文件名把响应头灌爆。
 */
export function normalizeBaseName(raw) {
  const text = typeof raw === 'string' ? raw.replace(/[\u0000-\u001f\u007f]/g, '').trim() : '';
  return (text || '底图').slice(0, 80);
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

export async function getRoomBase(roomId) {
  const s = await store();
  return s.get(baseKey(roomId), { type: 'json' });
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

/**
 * 房间对外的样子：身份来自 meta，画布尺寸与底图来自 base。
 * 画布尺寸就是底图尺寸 —— 只有这一份真相，不需要也别再存第二份。
 */
export function publicRoom(meta, base) {
  const ready = base?.status === 'ready' && !!base.key;
  return {
    roomId: meta.roomId,
    doc: { width: base?.width ?? 0, height: base?.height ?? 0 },
    baseImage: ready
      ? { name: base.name ?? '底图', type: base.type ?? 'image/png', width: base.width, height: base.height }
      : null,
    createdAt: meta.createdAt,
    expiresAt: meta.expiresAt,
    status: ready ? 'ready' : 'draft',
  };
}

/**
 * 读取房间身份并做存在性 / 过期检查；不过关直接抛 ApiError。
 *
 * 房间号是从 URL 里抠出来的、要直接拼进存储键，所以第一步先按生成时的字符集验一遍：
 * 放过 `../`、空字符这类东西，存储层会直接报错并落到调用方的兜底分支变成 500，
 * 而未鉴权就能反复触发（实测 GET /api/rooms/..%2FAAAAAA、/a%00b 都是 500）。
 * 校验放在这里，四个入口（读/改头像/删/底图）全都自动覆盖。
 */
export async function requireRoom(roomId) {
  if (!normalizeRoomId(roomId)) throw new ApiError(404, '房间不存在或已被删除');
  const meta = await getRoomMeta(roomId);
  if (!meta) throw new ApiError(404, '房间不存在或已被删除');
  if (isExpired(meta)) {
    await deleteRoom(roomId).catch(() => {});
    throw new ApiError(410, '房间已过期');
  }
  const base = await getRoomBase(roomId);
  return { roomId, meta, base };
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
