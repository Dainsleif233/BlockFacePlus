/*!
 * BlockFace+ · 房间差量计算（纯函数，无副作用、无 IO）
 * Copyright 2026 Dainsleif · Apache License 2.0
 *
 * "差量上传"就落在这个文件里：拿进房时的基线（baseline）和当前画布比，
 * 只把真的变了的头像、真的变了的字段挑出来。没动的头像一个字节都不发，
 * 没动的字段一个键都不带 —— 服务端那边对应的就是"没提到的行不碰、没带的键不改"。
 */

import type { PresetSkin } from '../model/preset';
import type { AvatarUpdate, LayoutPatch, PatchItemResult, RoomAvatarDraft } from './types';

/** 参与"布局"比较的字段（与后端 normalizeLayoutPatch 一一对应） */
export const LAYOUT_KEYS = ['name', 'x', 'y', 'size', 'rotation', 'opacity', 'overlay', 'flipH', 'visible', 'order'] as const;

/** 画布上的一个图层在协议里的样子（皮肤只留本地素材 id，用来判断"换没换"） */
export interface LayerState {
  id: string;
  name: string;
  x: number;
  y: number;
  size: number;
  rotation: number;
  opacity: number;
  overlay: boolean;
  flipH: boolean;
  visible: boolean;
  order: number;
  skinId: string | null;
}

/** 进房那一刻记下的基线：字段快照 + 服务端给的两个版本戳 */
export interface LayerBaseline {
  state: LayerState;
  skinUpdatedAt: number;
  layoutUpdatedAt: number;
}

export interface RoomPatch {
  updates: AvatarUpdate[];
  adds: RoomAvatarDraft[];
  deletes: string[];
  /** 皮肤编码失败（跨域污染之类）的头像数：其余字段照常提交，这几个留作待提交 */
  failedSkins: number;
}

function layoutDiff(before: LayerState, after: LayerState): LayoutPatch {
  const patch: LayoutPatch = {};
  if (before.name !== after.name) patch.name = after.name;
  if (before.x !== after.x) patch.x = after.x;
  if (before.y !== after.y) patch.y = after.y;
  if (before.size !== after.size) patch.size = after.size;
  if (before.rotation !== after.rotation) patch.rotation = after.rotation;
  if (before.opacity !== after.opacity) patch.opacity = after.opacity;
  if (before.overlay !== after.overlay) patch.overlay = after.overlay;
  if (before.flipH !== after.flipH) patch.flipH = after.flipH;
  if (before.visible !== after.visible) patch.visible = after.visible;
  if (before.order !== after.order) patch.order = after.order;
  return patch;
}

function hasKeys(patch: LayoutPatch): boolean {
  return Object.keys(patch).length > 0;
}

/** 某个图层相对基线是否动过（不含皮肤编码，纯比较，随时可算） */
function isDirty(base: LayerBaseline | undefined, after: LayerState): boolean {
  if (!base) return true;
  return base.state.skinId !== after.skinId || hasKeys(layoutDiff(base.state, after));
}

/** 待提交的改动条数：新增、删除、以及每一个动过的行各算一处 */
export function countPending(baseline: Map<string, LayerBaseline>, current: LayerState[]): number {
  let count = 0;
  const seen = new Set<string>();
  for (const layer of current) {
    seen.add(layer.id);
    if (isDirty(baseline.get(layer.id), layer)) count += 1;
  }
  for (const id of baseline.keys()) if (!seen.has(id)) count += 1;
  return count;
}

/**
 * 算出这次要提交什么。
 * encodeSkin 由调用方提供（要动 canvas，是唯一不纯的一步）；解不出来只影响皮肤那部分，
 * 布局改动照样提交，解不出来的记在 failedSkins 里让上层提示。
 */
export function buildRoomPatch(
  baseline: Map<string, LayerBaseline>,
  current: LayerState[],
  encodeSkin: (layerId: string) => PresetSkin | null,
): RoomPatch {
  const patch: RoomPatch = { updates: [], adds: [], deletes: [], failedSkins: 0 };
  const seen = new Set<string>();

  for (const layer of current) {
    seen.add(layer.id);
    const base = baseline.get(layer.id);
    if (!base) {
      // 新增的行：整行发过去（皮肤必须给，给不出来这条就留着下次）
      const skin = encodeSkin(layer.id);
      if (!skin) { patch.failedSkins += 1; continue; }
      patch.adds.push({ ...layer, skin } as RoomAvatarDraft);
      continue;
    }
    const layout = layoutDiff(base.state, layer);
    const update: AvatarUpdate = { id: layer.id };
    if (hasKeys(layout)) {
      update.layout = layout;
      update.expectLayoutUpdatedAt = base.layoutUpdatedAt;
    }
    if (base.state.skinId !== layer.skinId) {
      const skin = encodeSkin(layer.id);
      if (!skin) patch.failedSkins += 1;
      else {
        update.skin = skin;
        update.expectSkinUpdatedAt = base.skinUpdatedAt;
      }
    }
    if (update.layout || update.skin) patch.updates.push(update);
  }

  for (const id of baseline.keys()) if (!seen.has(id)) patch.deletes.push(id);
  return patch;
}

/** 有没有东西要提交（不看皮肤编码，用于按钮/提示的即时反馈） */
export function patchIsEmpty(patch: RoomPatch): boolean {
  return patch.updates.length === 0 && patch.adds.length === 0 && patch.deletes.length === 0;
}

/**
 * 提交结果回填基线：只有成功的条目才推进，失败的（冲突/找不到/非法）原样留着继续算待提交，
 * 这样用户看到"还有 N 处没提交"跟实际一致。
 */
export function advanceBaseline(
  baseline: Map<string, LayerBaseline>,
  current: LayerState[],
  sent: RoomPatch,
  results: PatchItemResult[],
): void {
  const byId = new Map(current.map((layer) => [layer.id, layer]));
  const stamps = new Map(results.filter((r) => r.ok).map((r) => [r.id, r]));

  const settle = (id: string): void => {
    const layer = byId.get(id);
    const stamp = stamps.get(id);
    if (!layer || !stamp) return;
    const prev = baseline.get(id);
    baseline.set(id, {
      state: layer,
      skinUpdatedAt: stamp.skinUpdatedAt ?? prev?.skinUpdatedAt ?? 0,
      layoutUpdatedAt: stamp.layoutUpdatedAt ?? prev?.layoutUpdatedAt ?? 0,
    });
  };

  for (const update of sent.updates) settle(update.id);
  for (const add of sent.adds) settle(add.id);
  // 删除是管理员说了算，服务端不会因为版本戳拒绝；本地照旧把基线里的行去掉
  for (const id of sent.deletes) baseline.delete(id);
}
