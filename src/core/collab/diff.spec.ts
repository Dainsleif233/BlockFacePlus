/*!
 * BlockFace+ · 差量计算单元测试
 * Copyright 2026 Dainsleif · Apache License 2.0
 *
 * 这是"差量上传"的地基：只发真的变了的行与字段，没动的行一个字节都不带。
 */

import { describe, expect, it } from 'vitest';
import {
  advanceBaseline,
  buildRoomPatch,
  countPending,
  patchIsEmpty,
  type LayerBaseline,
  type LayerState,
} from './diff';
import type { PresetSkin } from '../model/preset';

function state(over: Partial<LayerState> = {}): LayerState {
  return {
    id: 'srv-1',
    name: '头像一',
    x: 10,
    y: 20,
    size: 100,
    rotation: 0,
    opacity: 1,
    overlay: true,
    flipH: false,
    visible: true,
    order: 0,
    skinId: 'skin-a',
    ...over,
  };
}

function baselineOf(state_: LayerState, skinUpdatedAt = 1000, layoutUpdatedAt = 2000): LayerBaseline {
  return { state: state_, skinUpdatedAt, layoutUpdatedAt };
}

const skin = (tag: string): PresetSkin => ({ dataUrl: 'data:image/png;base64,' + tag, width: 16, height: 8 });

describe('buildRoomPatch', () => {
  it('什么都没动就是空差量', () => {
    const layer = state();
    const patch = buildRoomPatch(new Map([['srv-1', baselineOf(layer)]]), [layer], () => skin('A'));
    expect(patchIsEmpty(patch)).toBe(true);
    expect(patch.failedSkins).toBe(0);
  });

  it('换皮肤只带 skin 与皮肤版本戳，布局字段一个都不带', () => {
    const before = state();
    const after = state({ skinId: 'skin-b' });
    const patch = buildRoomPatch(new Map([['srv-1', baselineOf(before)]]), [after], () => skin('B'));
    expect(patch.updates).toHaveLength(1);
    expect(Object.keys(patch.updates[0]).sort()).toEqual(['expectSkinUpdatedAt', 'id', 'skin']);
    expect(patch.updates[0].expectSkinUpdatedAt).toBe(1000);
    expect(patch.updates[0].layout).toBeUndefined();
  });

  it('挪位置只带变化的那几个布局字段与布局版本戳', () => {
    const before = state();
    const after = state({ x: 50, y: 60 });
    const patch = buildRoomPatch(new Map([['srv-1', baselineOf(before)]]), [after], () => skin('A'));
    expect(patch.updates).toHaveLength(1);
    expect(patch.updates[0].layout).toEqual({ x: 50, y: 60 });
    expect(patch.updates[0].expectLayoutUpdatedAt).toBe(2000);
    expect(patch.updates[0].skin).toBeUndefined();
    expect(patch.updates[0].expectSkinUpdatedAt).toBeUndefined();
  });

  it('同时换肤与挪位置时两个版本戳都带上', () => {
    const before = state();
    const after = state({ x: 50, skinId: 'skin-b' });
    const patch = buildRoomPatch(new Map([['srv-1', baselineOf(before)]]), [after], () => skin('B'));
    expect(patch.updates[0].expectLayoutUpdatedAt).toBe(2000);
    expect(patch.updates[0].expectSkinUpdatedAt).toBe(1000);
  });

  it('顺序变化也走布局差量', () => {
    const a = state();
    const b = state({ id: 'srv-2', skinId: 'skin-b', order: 1 });
    const patch = buildRoomPatch(new Map([['srv-1', baselineOf(a)], ['srv-2', baselineOf(b)]]), [{ ...a, order: 1 }, { ...b, order: 0 }], () => skin('A'));
    expect(patch.updates).toHaveLength(2);
    expect(patch.updates.map((u) => u.layout)).toEqual([{ order: 1 }, { order: 0 }]);
  });

  it('新增的行整行进 adds，删除的行进 deletes', () => {
    const kept = state();
    const gone = state({ id: 'srv-2', skinId: 'skin-b', order: 1 });
    const fresh = state({ id: 'layer-new', skinId: 'skin-c', order: 2 });
    const patch = buildRoomPatch(
      new Map([['srv-1', baselineOf(kept)], ['srv-2', baselineOf(gone)]]),
      [kept, fresh],
      (id) => (id === 'layer-new' ? skin('C') : skin('A')),
    );
    expect(patch.updates).toHaveLength(0);
    expect(patch.adds).toHaveLength(1);
    expect(patch.adds[0].id).toBe('layer-new');
    expect(patch.adds[0].skin).toEqual(skin('C'));
    expect(patch.deletes).toEqual(['srv-2']);
  });

  it('皮肤编码不出来时布局照常提交，失败的记在 failedSkins 里', () => {
    const before = state();
    const after = state({ x: 50, skinId: 'skin-b' });
    const patch = buildRoomPatch(new Map([['srv-1', baselineOf(before)]]), [after], () => null);
    expect(patch.failedSkins).toBe(1);
    expect(patch.updates[0].layout).toEqual({ x: 50 });
    expect(patch.updates[0].skin).toBeUndefined();
  });

  it('新增的行皮肤编码不出来就整条留着，不会造出一个没有皮肤的头像', () => {
    const patch = buildRoomPatch(new Map(), [state({ id: 'layer-new' })], () => null);
    expect(patch.adds).toHaveLength(0);
    expect(patch.failedSkins).toBe(1);
  });
});

describe('countPending', () => {
  it('对齐基线时为 0，改动一处为 1', () => {
    const layer = state();
    const baseline = new Map([['srv-1', baselineOf(layer)]]);
    expect(countPending(baseline, [layer])).toBe(0);
    expect(countPending(baseline, [{ ...layer, x: 99 }])).toBe(1);
    expect(countPending(baseline, [{ ...layer, skinId: 'skin-b' }])).toBe(1);
  });

  it('撤销回基线就回到 0', () => {
    const layer = state();
    const baseline = new Map([['srv-1', baselineOf(layer)]]);
    const moved = { ...layer, x: 99 };
    expect(countPending(baseline, [moved])).toBe(1);
    expect(countPending(baseline, [{ ...moved, x: layer.x }])).toBe(0);
  });

  it('新增与删除各算一处', () => {
    const layer = state();
    const baseline = new Map([['srv-1', baselineOf(layer)]]);
    expect(countPending(baseline, [layer, state({ id: 'layer-new' })])).toBe(1);
    expect(countPending(baseline, [])).toBe(1);
  });
});

describe('advanceBaseline', () => {
  it('成功的行推进到新基线，改动随之归零', () => {
    const before = state();
    const after = { ...before, x: 50 };
    const baseline = new Map([['srv-1', baselineOf(before)]]);
    const patch = buildRoomPatch(baseline, [after], () => skin('A'));
    advanceBaseline(baseline, [after], patch, [{ id: 'srv-1', ok: true, skinUpdatedAt: 1000, layoutUpdatedAt: 3000 }]);
    expect(baseline.get('srv-1')?.layoutUpdatedAt).toBe(3000);
    expect(countPending(baseline, [after])).toBe(0);
  });

  it('冲突的行原封不动，继续算待提交', () => {
    const before = state();
    const after = { ...before, x: 50 };
    const baseline = new Map([['srv-1', baselineOf(before)]]);
    const patch = buildRoomPatch(baseline, [after], () => skin('A'));
    advanceBaseline(baseline, [after], patch, [{ id: 'srv-1', ok: false, error: 'conflict' }]);
    expect(baseline.get('srv-1')?.state.x).toBe(before.x);
    expect(countPending(baseline, [after])).toBe(1);
  });

  it('新增成功的行进基线，删除的行移出基线', () => {
    const kept = state();
    const fresh = state({ id: 'layer-new', skinId: 'skin-c' });
    const baseline = new Map([['srv-1', baselineOf(kept)], ['srv-2', baselineOf(state({ id: 'srv-2' }))]]);
    const patch = buildRoomPatch(baseline, [kept, fresh], () => skin('C'));
    advanceBaseline(baseline, [kept, fresh], patch, [
      { id: 'layer-new', ok: true, skinUpdatedAt: 10, layoutUpdatedAt: 20 },
    ]);
    // srv-2 不在当前画布上 → 进了 deletes，提交成功后从基线里移走
    expect(patch.deletes).toEqual(['srv-2']);
    expect([...baseline.keys()].sort()).toEqual(['layer-new', 'srv-1']);
    expect(baseline.get('layer-new')?.layoutUpdatedAt).toBe(20);
  });
});
