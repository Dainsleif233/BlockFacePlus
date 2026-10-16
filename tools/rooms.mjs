#!/usr/bin/env node
/*!
 * BlockFace+ · 房间运维脚本
 * Copyright 2026 Dainsleif · Apache License 2.0
 *
 * 直接读写 Blob（绕过 HTTP 接口，因此不需要管理员密码），用途：
 *   - 快查：列出房间、状态（底图是否就绪）、创建/过期时间、画布尺寸、头像与底图数量；
 *   - 残留：找出「对象还在、索引或元信息已不在」的孤儿对象（过期清扫没扫到的、
 *           或早期版本留下的），这类数据没人能访问，只白占容量；
 *   - 清理：删掉指定房间、清掉已过期房间、清掉孤儿对象。
 *
 * 用法（默认只预演，加 --yes 才真的删）：
 *   node tools/rooms.mjs ls [--expired] [--size] [--json]
 *   node tools/rooms.mjs orphans [--size] [--json]
 *   node tools/rooms.mjs rm <roomId...> [--yes]
 *   node tools/rooms.mjs gc [--yes]              # 清掉索引里已过期的房间
 *   node tools/rooms.mjs rm-orphans [--yes]      # 清掉孤儿对象
 *
 * 凭据（外网访问 Blob 需要 projectId + token）按顺序取：
 *   1) --project / --token
 *   2) 环境变量 PAGES_PROJECT_ID / PAGES_BLOB_DEPLOY_CREDENTIAL
 *   3) 项目根 .env 里的同名键
 *   4) .edgeone/project.json 的 ProjectId + edgeone CLI 登录态（~/.edgeone 中 key=eo_token）
 *
 * 注意：这里读写的是云端 store（部署后用的那份），与本地 dev 实例的内存态无关。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getStore } from '@edgeone/pages-blob';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_STORE = 'blockface-plus';
const DAY = 24 * 3600 * 1000;

/* ------------------------------ 参数 ------------------------------ */

const argv = process.argv.slice(2);
const cmd = argv[0] ?? 'help';
const flags = new Set();
const opts = {};
const positional = [];
for (let i = 1; i < argv.length; i += 1) {
  const a = argv[i];
  if (!a.startsWith('--')) { positional.push(a); continue; }
  const [k, v] = a.slice(2).split('=');
  if (v !== undefined) opts[k] = v;
  else if (['project', 'token', 'store', 'keep'].includes(k)) { opts[k] = argv[i + 1]; i += 1; }
  else flags.add(k);
}
const want = (f) => flags.has(f);
const flagValue = (f) => opts[f];

/* ------------------------------ 凭据 ------------------------------ */

function readKeyValueFile(file) {
  if (!existsSync(file)) return {};
  const out = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*"?([^"\r\n]*)"?\s*$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function readProjectIdFromCli() {
  const file = path.join(ROOT, '.edgeone', 'project.json');
  if (!existsSync(file)) return undefined;
  try { return JSON.parse(readFileSync(file, 'utf8')).ProjectId; } catch { return undefined; }
}

/** edgeone CLI 的登录态：~/.edgeone/<hash> 里存 { key: 'eo_token', value: { Token } } */
function readTokenFromCli() {
  const dir = path.join(homedir(), '.edgeone');
  if (!existsSync(dir)) return undefined;
  for (const f of readdirSync(dir)) {
    if (f.endsWith('.json')) continue;
    try {
      const j = JSON.parse(readFileSync(path.join(dir, f), 'utf8'));
      if (j?.key === 'eo_token' && j?.value?.Token) return j.value.Token;
    } catch { /* 忽略非凭据文件 */ }
  }
  return undefined;
}

function resolveAuth() {
  const envFile = readKeyValueFile(path.join(ROOT, '.env'));
  const projectId = flagValue('project') ?? process.env.PAGES_PROJECT_ID ?? envFile.PAGES_PROJECT_ID ?? readProjectIdFromCli();
  const token = flagValue('token') ?? process.env.PAGES_BLOB_DEPLOY_CREDENTIAL ?? envFile.PAGES_BLOB_DEPLOY_CREDENTIAL ?? readTokenFromCli();
  if (!projectId || !token) {
    const missing = [!projectId && 'projectId', !token && 'token'].filter(Boolean).join(' + ');
    console.error(`缺凭据（${missing}）：用 --project/--token，或在 .env 写 PAGES_PROJECT_ID / PAGES_BLOB_DEPLOY_CREDENTIAL。`);
    process.exit(2);
  }
  return { projectId, token };
}

const { projectId, token } = cmd === 'help' ? {} : resolveAuth();
const store = cmd === 'help' ? null : getStore({
  name: flagValue('store') ?? DEFAULT_STORE,
  projectId,
  token,
  consistency: 'strong',
});

/* ------------------------------ 格式化 ------------------------------ */

const WIDE = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/;

function width(text) {
  let n = 0;
  for (const ch of String(text)) n += WIDE.test(ch) ? 2 : 1;
  return n;
}

function pad(text, size) {
  const s = String(text);
  return s + ' '.repeat(Math.max(0, size - width(s)));
}

function table(headers, rows) {
  const sizes = headers.map((h, i) => Math.max(width(h), ...rows.map((r) => width(r[i] ?? ''))));
  console.log(headers.map((h, i) => pad(h, sizes[i])).join('  '));
  console.log(sizes.map((s) => '-'.repeat(s)).join('  '));
  for (const r of rows) console.log(r.map((c, i) => pad(c ?? '', sizes[i])).join('  '));
}

function fmtTime(ts) {
  if (typeof ts !== 'number') return '-';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtLeft(expiresAt, now) {
  if (typeof expiresAt !== 'number') return '-';
  const diff = expiresAt - now;
  const abs = Math.abs(diff);
  const text = abs >= DAY ? `${Math.floor(abs / DAY)}天${Math.floor((abs % DAY) / 3600000)}小时` : `${Math.floor(abs / 3600000)}小时`;
  return diff >= 0 ? `剩 ${text}` : `已过期 ${text}`;
}

function fmtBytes(n) {
  if (!n) return '0B';
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
  if (n >= 1024) return `${Math.round(n / 1024)}KB`;
  return `${n}B`;
}

/* ------------------------------ 存储操作 ------------------------------ */

const metaKey = (id) => `rooms/${id}/meta.json`;
const baseKey = (id) => `rooms/${id}/base.json`;
const indexKey = (id) => `index/${id}.json`;
const roomPrefix = (id) => `rooms/${id}/`;
const throttleKey = (id) => `throttle/${id}.json`;

async function listAll(prefix) {
  const { blobs } = await store.list({ prefix, paginate: true });
  return blobs.map((b) => b.key);
}

async function getJson(key) {
  try { return await store.get(key, { type: 'json' }); } catch { return null; }
}

async function readIndex() {
  const keys = await listAll('index/');
  const entries = [];
  for (const key of keys) {
    const entry = await getJson(key);
    if (entry?.roomId) entries.push({ ...entry, indexKey: key });
  }
  return entries;
}

async function roomStats(roomId, withSize) {
  const keys = await listAll(roomPrefix(roomId));
  let avatars = 0;
  let images = 0;
  let bytes = 0;
  for (const key of keys) {
    if (key.includes('/avatars/')) avatars += 1;
    else if (key.includes('/images/')) images += 1;
    if (withSize) {
      try {
        const meta = await store.getMetadata(key);
        // getMetadata 是 HEAD：返回 { cacheControl, contentType, etag, headers }，体积在 headers 里
        const h = meta?.headers ?? {};
        bytes += Number(h['content-length'] ?? h['Content-Length'] ?? meta?.size ?? 0) || 0;
      } catch { /* 个别对象读不到元信息不影响统计 */ }
    }
  }
  return { avatars, images, objects: keys.length, bytes };
}

async function deleteKeys(keys, dryRun, log = true) {
  if (dryRun) {
    for (const key of keys.slice(0, 30)) console.log('  将删除 ' + key);
    if (keys.length > 30) console.log(`  ...还有 ${keys.length - 30} 个`);
    return 0;
  }
  let done = 0;
  for (const key of keys) {
    try { await store.delete(key); done += 1; if (log && keys.length <= 30) console.log('  已删除 ' + key); } catch (e) { console.error('  删除失败 ' + key + '：' + e.message); }
  }
  return done;
}

/* ------------------------------ 子命令 ------------------------------ */

async function cmdLs() {
  const now = Date.now();
  const entries = await readIndex();
  const filtered = want('expired') ? entries.filter((e) => typeof e.expiresAt === 'number' && now > e.expiresAt) : entries;
  filtered.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
  const withSize = want('size');
  const rows = [];
  for (const e of filtered) {
    const meta = await getJson(metaKey(e.roomId));
    // 底图的指针与画布尺寸都在 base.json 里，meta.json 只存房间身份
    const base = await getJson(baseKey(e.roomId));
    const stats = await roomStats(e.roomId, withSize);
    rows.push({
      roomId: e.roomId,
      status: base?.status ?? (base ? '?' : '无底图'),
      created: fmtTime(e.createdAt),
      expires: fmtTime(e.expiresAt),
      left: fmtLeft(e.expiresAt, now),
      expired: typeof e.expiresAt === 'number' && now > e.expiresAt,
      canvas: base ? `${base.width}×${base.height}` : '-',
      avatars: stats.avatars,
      images: stats.images,
      objects: stats.objects,
      bytes: withSize ? fmtBytes(stats.bytes) : '-',
      base: base?.name ?? '-',
    });
  }
  if (want('json')) { console.log(JSON.stringify(rows, null, 2)); return; }
  if (rows.length === 0) { console.log(want('expired') ? '没有已过期的房间。' : '索引里没有房间。'); return; }
  table(
    ['房间号', '状态', '创建', '过期', '剩余', '画布', '头像', '底图', ...(withSize ? ['占用'] : []), '对象'],
    rows.map((r) => [r.roomId, r.status, r.created, r.expires, r.left, r.canvas, r.avatars, r.images, ...(withSize ? [r.bytes] : []), r.objects]),
  );
  const expired = rows.filter((r) => r.expired).length;
  console.log(`\n共 ${rows.length} 个房间${expired ? `，其中 ${expired} 个已过期（可 gc）` : ''}。`);
}

async function scanOrphans(withSize) {
  const { directories } = await store.list({ prefix: 'rooms/', directories: true, paginate: true });
  const dirIds = directories.map((d) => d.replace(/^rooms\//, '').replace(/\/$/, '')).filter(Boolean);
  const entries = await readIndex();
  const indexIds = new Set(entries.map((e) => e.roomId));
  const dirSet = new Set(dirIds);
  const orphanDirs = dirIds.filter((id) => !indexIds.has(id));
  const orphanIndex = entries.filter((e) => !dirSet.has(e.roomId));
  const rows = [];
  for (const id of orphanDirs) {
    const stats = await roomStats(id, withSize);
    rows.push({ roomId: id, avatars: stats.avatars, images: stats.images, objects: stats.objects, bytes: withSize ? fmtBytes(stats.bytes) : '-' });
  }
  // 限流状态是我方新增的键位：房间没了它就成了没人认领的垃圾，一并算孤儿
  const throttleIds = (await listAll('throttle/')).map((k) => k.replace(/^throttle\//, '').replace(/\.json$/, ''));
  const orphanThrottle = throttleIds.filter((id) => !indexIds.has(id)).map((id) => ({ roomId: id, key: throttleKey(id) }));
  return { rows, orphanIndex, orphanThrottle };
}

async function cmdOrphans() {
  const withSize = want('size');
  const { rows, orphanIndex, orphanThrottle } = await scanOrphans(withSize);
  if (want('json')) { console.log(JSON.stringify({ orphanDirs: rows, orphanIndex, orphanThrottle }, null, 2)); return; }
  if (rows.length === 0) console.log('没有孤儿对象。');
  else {
    table(['房间号', '头像', '底图', ...(withSize ? ['占用'] : []), '对象'], rows.map((r) => [r.roomId, r.avatars, r.images, ...(withSize ? [r.bytes] : []), r.objects]));
    console.log(`\n共 ${rows.length} 个「对象在、索引没了」的孤儿房间，用 rm-orphans 清掉。`);
  }
  if (orphanIndex.length > 0) console.log(`另有 ${orphanIndex.length} 条「索引在、对象没了」的残留索引：${orphanIndex.map((e) => e.roomId).join(', ')}`);
  if (orphanThrottle.length > 0) console.log(`另有 ${orphanThrottle.length} 个房间已不在、限流状态还在的残留键：${orphanThrottle.map((e) => e.roomId).join(', ')}`);
}

async function cmdRm() {
  if (positional.length === 0) { console.error('用法：node tools/rooms.mjs rm <roomId...> [--yes]'); process.exit(2); }
  const dryRun = !want('yes');
  for (const roomId of positional) {
    const keys = [...(await listAll(roomPrefix(roomId))), indexKey(roomId), throttleKey(roomId)];
    console.log(`${dryRun ? '[预演] ' : ''}房间 ${roomId}：${keys.length} 个对象`);
    const done = await deleteKeys(keys, dryRun);
    if (!dryRun) console.log(`  完成，删除 ${done}/${keys.length}`);
  }
  if (dryRun) console.log('\n以上为预演，加 --yes 才会真删。');
}

async function cmdGc() {
  const now = Date.now();
  const entries = await readIndex();
  const expired = entries.filter((e) => typeof e.expiresAt === 'number' && now > e.expiresAt);
  if (expired.length === 0) { console.log('没有已过期的房间。'); return; }
  const dryRun = !want('yes');
  let planned = 0;
  let deleted = 0;
  for (const e of expired) {
    const keys = [...(await listAll(roomPrefix(e.roomId))), indexKey(e.roomId), throttleKey(e.roomId)];
    console.log(`${dryRun ? '[预演] ' : ''}${e.roomId}（${fmtLeft(e.expiresAt, now)}）：${keys.length} 个对象`);
    planned += keys.length;
    deleted += await deleteKeys(keys, dryRun, false);
  }
  console.log(`\n已过期房间 ${expired.length} 个，${dryRun ? `预计删除 ${planned} 个对象（加 --yes 执行）` : `已删除 ${deleted}/${planned} 个对象`}。`);
}

async function cmdRmOrphans() {
  const { rows, orphanIndex, orphanThrottle } = await scanOrphans(false);
  if (rows.length === 0 && orphanIndex.length === 0 && orphanThrottle.length === 0) { console.log('没有孤儿数据。'); return; }
  const dryRun = !want('yes');
  let planned = 0;
  let deleted = 0;
  for (const r of rows) {
    const keys = await listAll(roomPrefix(r.roomId));
    console.log(`${dryRun ? '[预演] ' : ''}孤儿房间 ${r.roomId}：${keys.length} 个对象`);
    planned += keys.length;
    deleted += await deleteKeys(keys, dryRun, false);
  }
  for (const e of orphanIndex) {
    console.log(`${dryRun ? '[预演] ' : ''}残留索引 ${e.indexKey}`);
    planned += 1;
    deleted += await deleteKeys([e.indexKey], dryRun, false);
  }
  for (const e of orphanThrottle) {
    console.log(`${dryRun ? '[预演] ' : ''}残留限流键 ${e.key}`);
    planned += 1;
    deleted += await deleteKeys([e.key], dryRun, false);
  }
  console.log(`\n${dryRun ? `预计删除 ${planned} 个孤儿对象（加 --yes 执行）` : `已删除 ${deleted}/${planned} 个孤儿对象`}。`);
}

/* ------------------------------ 入口 ------------------------------ */

function usage() {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].split('/*!')[1].replace(/^ \* ?/gm, '').trim());
}

const commands = { ls: cmdLs, orphans: cmdOrphans, rm: cmdRm, gc: cmdGc, 'rm-orphans': cmdRmOrphans, help: usage };

const run = commands[cmd];
if (!run) { console.error(`未知命令 ${cmd}，可选：${Object.keys(commands).join(' / ')}`); usage(); process.exit(2); }
if (cmd !== 'help') console.log(`store=${flagValue('store') ?? DEFAULT_STORE}  project=${projectId}\n`);
try { await run(); } catch (e) { console.error('执行失败：' + (e?.message ?? e)); process.exit(1); }
