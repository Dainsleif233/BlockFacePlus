/*!
 * BlockFace+ · 协同 API 客户端单元测试
 * Copyright 2026 Dainsleif · Apache License 2.0
 */

import { describe, expect, it } from 'vitest';
import { chunkUpdates } from './api';
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
