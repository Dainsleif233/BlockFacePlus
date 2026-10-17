/*!
 * BlockFace+ · 底图本地缓存的可用性判定
 * Copyright 2026 Dainsleif · Apache License 2.0
 *
 * 这里只测"这份缓存能不能用"这条纯逻辑 —— 它决定了会不会拿一份没人验证过的旧图去渲染。
 * IndexedDB 本身在 Node 里不存在，顺带也锁住"没有 IndexedDB 就静默降级"这条路径。
 */

import { describe, expect, it } from 'vitest';
import { MAX_AGE_MS, cachedEntryIsUsable, deleteBaseEntry, readBaseEntry, writeBaseEntry } from './baseCache';

function entry(overrides: Record<string, unknown> = {}) {
  return {
    roomId: 'r1',
    etag: '"v1-2-3"',
    variant: 'preview' as const,
    name: '底图.webp',
    type: 'image/webp',
    blob: new Blob(['bytes']),
    savedAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe('cachedEntryIsUsable', () => {
  it('新鲜的、带 ETag 的条目可以用', () => {
    expect(cachedEntryIsUsable(entry() as never, 1_700_000_000_000 + 1000)).toBe(true);
  });

  it('没有条目就别谈可用', () => {
    expect(cachedEntryIsUsable(null, 1_700_000_000_000)).toBe(false);
  });

  // 没有 ETag 就只能盲信本地副本 —— 那等于把"管理员换了底图"这件事永久藏起来
  it('没有 ETag 的条目一律不用', () => {
    expect(cachedEntryIsUsable(entry({ etag: '' }) as never, 1_700_000_000_000)).toBe(false);
  });

  it('超过房间最长寿命（14 天）就作废', () => {
    expect(cachedEntryIsUsable(entry() as never, 1_700_000_000_000 + MAX_AGE_MS)).toBe(true);
    expect(cachedEntryIsUsable(entry() as never, 1_700_000_000_000 + MAX_AGE_MS + 1)).toBe(false);
  });

  it('空字节或坏时间戳都当没有', () => {
    expect(cachedEntryIsUsable(entry({ blob: new Blob([]) }) as never, 1_700_000_000_000)).toBe(false);
    expect(cachedEntryIsUsable(entry({ savedAt: Number.NaN }) as never, 1_700_000_000_000)).toBe(false);
  });
});

// Node 里没有 indexedDB：所有操作都必须静默降级，绝不能因此进不了房间
describe('没有 IndexedDB 时', () => {
  it('读回 null，写和删都不抛', async () => {
    expect(typeof indexedDB).toBe('undefined');
    expect(await readBaseEntry('r1')).toBeNull();
    await expect(writeBaseEntry(entry() as never)).resolves.toBeUndefined();
    await expect(deleteBaseEntry('r1')).resolves.toBeUndefined();
  });
});
