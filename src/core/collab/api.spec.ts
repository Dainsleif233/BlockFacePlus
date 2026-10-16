/*!
 * BlockFace+ · 协同 API 客户端单元测试
 * Copyright 2026 Dainsleif · Apache License 2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { MAX_FULL_SUBMIT_CHARS, chunkUpdates, collabApi, fullSubmitTooLarge } from './api';
import type { AvatarUpdate } from './types';

function update(index: number, bodyChars: number): AvatarUpdate {
  return {
    id: 'layer-' + index,
    skin: {
      dataUrl: 'data:image/png;base64,' + 'A'.repeat(bodyChars),
      width: 16,
      height: 8,
    },
    expectUpdatedAt: index,
  };
}

describe('chunkUpdates', () => {
  it('空列表切成空数组', () => {
    expect(chunkUpdates([])).toEqual([]);
  });

  it('总量小于上限时整批一块', () => {
    const updates = [update(1, 100), update(2, 100), update(3, 100)];
    const chunks = chunkUpdates(updates, 10_000);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(3);
  });

  it('超限时按顺序分块，块内元素不重排不丢失', () => {
    const updates = Array.from({ length: 10 }, (_, i) => update(i + 1, 3000));
    const chunks = chunkUpdates(updates, 8000);
    expect(chunks.length).toBeGreaterThan(1);
    const flat = chunks.flat().map((u) => u.id);
    expect(flat).toEqual(updates.map((u) => u.id));
    for (const chunk of chunks) {
      const size = JSON.stringify(chunk).length;
      expect(size).toBeLessThanOrEqual(8000);
    }
  });

  it('条数顶到单批上限也要切开（后端硬性限制 64 条）', () => {
    const updates = Array.from({ length: 150 }, (_, i) => update(i + 1, 10));
    const chunks = chunkUpdates(updates);
    expect(chunks.map((c) => c.length)).toEqual([64, 64, 22]);
    expect(chunks.flat().map((u) => u.id)).toEqual(updates.map((u) => u.id));
  });

  it('单条就超限的也要独立成块，不会丢掉', () => {
    const big = update(99, 50_000);
    const chunks = chunkUpdates([update(1, 100), big, update(2, 100)], 1000);
    expect(chunks).toHaveLength(3);
    expect(chunks.flat().map((u) => u.id)).toEqual(['layer-1', 'layer-99', 'layer-2']);
  });
});

describe('fullSubmitTooLarge', () => {
  it('默认上限与后端 readJsonBody 的默认值一致', () => {
    expect(MAX_FULL_SUBMIT_CHARS).toBe(5 * 1024 * 1024);
  });

  it('没超就放行', () => {
    expect(fullSubmitTooLarge({ layers: [update(1, 100)] }, 10_000)).toBeNull();
  });

  it('正好等于上限也放行（后端判的是 > 上限）', () => {
    const limit = 200;
    const body = { a: 'x'.repeat(limit - 8) }; // {"a":"…"} = 6 + n + 2
    expect(JSON.stringify(body)).toHaveLength(limit);
    expect(fullSubmitTooLarge(body, limit)).toBeNull();
  });

  it('超了给一句人话，不是把 413 甩给用户', () => {
    const message = fullSubmitTooLarge({ layers: [update(1, 6_000_000)] });
    expect(message).toBeTruthy();
    expect(message).toContain('上限');
    expect(message).toContain('减掉几张头像');
  });

  it('序列化不了的内容不在这里吞掉（交给真正的请求去报错）', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(fullSubmitTooLarge(cyclic)).toBeNull();
  });

  it('体积超限时请求层直接抛 413，一个字节都不发出去', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const big = [{ skin: { dataUrl: 'data:image/png;base64,' + 'A'.repeat(MAX_FULL_SUBMIT_CHARS) } }];
    await expect(collabApi.putLayers('room1', 'pw', big, 1)).rejects.toMatchObject({ status: 413 });
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
