/*!
 * BlockFace+ · 协同 API 客户端单元测试
 * Copyright 2026 Dainsleif · Apache License 2.0
 *
 * 这里守的是"传输边界"，不是"一次能改多少个头像"：
 * 条数不设限，只有请求体体积要切块。
 */

import { describe, expect, it, vi } from 'vitest';
import { MAX_CREATE_CHARS, MAX_PATCH_CHARS, chunkBySize, collabApi, fullSubmitTooLarge, mergePatchResults } from './api';
import type { AvatarUpdate } from './types';

function update(index: number, bodyChars: number): AvatarUpdate {
  return {
    id: 'layer-' + index,
    skin: {
      dataUrl: 'data:image/png;base64,' + 'A'.repeat(bodyChars),
      width: 16,
      height: 8,
    },
    expectSkinUpdatedAt: index,
  };
}

describe('chunkBySize', () => {
  it('空列表切成空数组', () => {
    expect(chunkBySize([])).toEqual([]);
  });

  it('总量小于上限时整批一块', () => {
    const updates = [update(1, 100), update(2, 100), update(3, 100)];
    const chunks = chunkBySize(updates, 10_000);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(3);
  });

  it('超限时按顺序分块，块内元素不重排不丢失', () => {
    const updates = Array.from({ length: 10 }, (_, i) => update(i + 1, 3000));
    const chunks = chunkBySize(updates, 8000);
    expect(chunks.length).toBeGreaterThan(1);
    const flat = chunks.flat().map((u) => u.id);
    expect(flat).toEqual(updates.map((u) => u.id));
    for (const chunk of chunks) {
      expect(JSON.stringify(chunk).length).toBeLessThanOrEqual(8000);
    }
  });

  it('体积很小的一大批不会因为条数被切开（没有 64 条这种莫名其妙的限制）', () => {
    const updates = Array.from({ length: 150 }, (_, i) => update(i + 1, 10));
    const chunks = chunkBySize(updates);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(150);
  });

  it('单条就超限的也要独立成块，不会丢掉', () => {
    const big = update(99, 50_000);
    const chunks = chunkBySize([update(1, 100), big, update(2, 100)], 1000);
    expect(chunks).toHaveLength(3);
    expect(chunks.flat().map((u) => u.id)).toEqual(['layer-1', 'layer-99', 'layer-2']);
  });
});

describe('fullSubmitTooLarge', () => {
  it('建房上限与后端 readJsonBody 的默认值一致', () => {
    expect(MAX_CREATE_CHARS).toBe(5 * 1024 * 1024);
  });

  it('差量单批上限比后端上限小，留出余量', () => {
    expect(MAX_PATCH_CHARS).toBeLessThan(MAX_CREATE_CHARS);
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
    expect(message).toContain('压小');
  });

  it('序列化不了的内容不在这里吞掉（交给真正的请求去报错）', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(fullSubmitTooLarge(cyclic)).toBeNull();
  });

  it('差量体积超限时请求层直接抛 413，一个字节都不发出去', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const big: AvatarUpdate[] = [{ id: 'layer-1', skin: { dataUrl: 'data:image/png;base64,' + 'A'.repeat(MAX_PATCH_CHARS), width: 16, height: 8 } }];
    await expect(collabApi.patchAvatars('room1', 'pw', { updates: big })).rejects.toMatchObject({ status: 413 });
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('建房请求体积超限同样在本地拦下', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const big = {
      baseImage: { name: 'b.png', type: 'image/png', width: 1, height: 1 },
      layers: [{ skin: { dataUrl: 'data:image/png;base64,' + 'A'.repeat(MAX_CREATE_CHARS) } }],
      expiresDays: 7,
    };
    // 类型上 layers 不是合法草稿：这一条只验证"体积关口在发请求之前"
    await expect(collabApi.createRoom(big as never)).rejects.toMatchObject({ status: 413 });
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe('mergePatchResults', () => {
  it('把多批结果按顺序拼起来', () => {
    expect(mergePatchResults([
      { results: [{ id: 'a', ok: true }, { id: 'b', ok: false, error: 'conflict' }] },
      { results: [{ id: 'c', ok: true }] },
    ])).toEqual([{ id: 'a', ok: true }, { id: 'b', ok: false, error: 'conflict' }, { id: 'c', ok: true }]);
  });

  it('没带 results 的响应当空处理，不会炸', () => {
    expect(mergePatchResults([{} as never])).toEqual([]);
  });
});
