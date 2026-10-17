/*!
 * BlockFace+ · 底图的本地持久缓存（IndexedDB）
 * Copyright 2026 Dainsleif · Apache License 2.0
 *
 * 解决的问题：每次进房都要把底图整张拉一遍。浏览器 HTTP 缓存只能撑 60 秒
 * （服务端发的是 private, max-age=60），过了这个窗口就得回源。
 *
 * 这里的做法是**把字节按 ETag 存起来，下次带着 If-None-Match 去问**：
 *   - 服务器回 304 → 用本地这份，传输量是几百字节的头，不是几十 MB 的图；
 *   - 服务器回 200 → 底图换过了，用新的并覆盖本地。
 *
 * 三条刻意设计：
 *  1. **ETag 里带变体**（full / preview），所以"编辑者看到的预览"与"管理员要的原图"
 *     天然是两条不同的缓存，切角色不会串。
 *  2. **没有 ETag 的条目一律不用**：没有校验器就只能盲信本地副本，
 *     那等于把"管理员换了底图"这件事永久藏起来。
 *  3. **一切失败都静默降级**：隐私模式、配额满、库被删，都只是"这次没缓存"，
 *     绝不能因此进不了房间。所以这个文件里没有一处 throw 会往外冒。
 */

/** 房间最长寿命是 14 天（契约里的过期白名单），更老的条目没有保留价值 */
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
/** 单条缓存上限：再大就可能撞上配额，而这个优化本来就是"省一次下载"，不是必须 */
const MAX_BLOB_BYTES = 32 * 1024 * 1024;
const DB_NAME = 'blockface-plus';
const DB_VERSION = 1;
const STORE_NAME = 'base';

export interface CachedBase {
  roomId: string;
  /** 服务端给的强校验器；没有它这份缓存就没法验证，一律不用 */
  etag: string;
  variant: 'preview' | 'full';
  name: string;
  type: string;
  blob: Blob;
  savedAt: number;
}

/**
 * 这份缓存还能不能用（纯函数，好测）。
 * 条件：有 ETag（能去验证）、没过期。
 */
export function cachedEntryIsUsable(entry: CachedBase | null, now: number): entry is CachedBase {
  if (!entry) return false;
  if (!entry.etag) return false;
  if (!entry.blob || entry.blob.size === 0) return false;
  if (!Number.isFinite(entry.savedAt)) return false;
  return now - entry.savedAt <= MAX_AGE_MS;
}

let databasePromise: Promise<IDBDatabase | null> | null = null;

function openDatabase(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve) => {
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME, { keyPath: 'roomId' });
    };
    request.onsuccess = () => resolve(request.result);
    // 隐私模式 / 配额为 0：拿不到库就当没有缓存，不打扰调用方
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
  return databasePromise;
}

function runTransaction<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  return openDatabase().then(
    (db) =>
      new Promise<T | null>((resolve) => {
        if (!db) {
          resolve(null);
          return;
        }
        let request: IDBRequest<T>;
        try {
          request = work(db.transaction(STORE_NAME, mode).objectStore(STORE_NAME));
        } catch {
          resolve(null);
          return;
        }
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
      }),
  );
}

/** 读一间房的缓存；没有、过期、坏掉都返回 null */
export async function readBaseEntry(roomId: string): Promise<CachedBase | null> {
  const entry = await runTransaction<CachedBase | undefined>('readonly', (store) => store.get(roomId));
  if (!entry) return null;
  if (!cachedEntryIsUsable(entry, Date.now())) {
    await deleteBaseEntry(roomId);
    return null;
  }
  return entry;
}

/** 写缓存；失败（配额满、隐私模式）就静默放弃 */
export async function writeBaseEntry(entry: CachedBase): Promise<void> {
  if (entry.blob.size > MAX_BLOB_BYTES) return;
  await runTransaction('readwrite', (store) => store.put(entry));
}

export async function deleteBaseEntry(roomId: string): Promise<void> {
  await runTransaction('readwrite', (store) => store.delete(roomId));
}

export { MAX_AGE_MS };
