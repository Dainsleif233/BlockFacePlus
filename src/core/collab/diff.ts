/*!
 * BlockFace+ · 房间差量计算（纯函数，无副作用、无 IO）
 * Copyright 2026 Dainsleif · Apache License 2.0
 *
 * "差量上传"就落在这个文件里：拿进房时的基线（baseline）和当前画布比，
 * 只把真的变了的头像、真的变了的字段挑出来。没动的头像一个字节都不发，
 * 没动的字段一个键都不带 —— 服务端那边对应的就是"没提到的行不碰、没带的键不改"。
 */

import type { PresetSkin } from '../model/preset';
import type { AppearancePatch, AvatarUpdate, LayoutPatch, PatchItemResult, RoomAvatarDraft } from './types';

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

/** 进房那一刻记下的基线：字段快照 + 服务端给的三个版本戳（各自独立推进） */
export interface LayerBaseline {
  state: LayerState;
  skinUpdatedAt: number;
  layoutUpdatedAt: number;
  appearanceUpdatedAt: number;
}

export interface RoomPatch {
  updates: AvatarUpdate[];
  adds: RoomAvatarDraft[];
  deletes: string[];
  /** 皮肤编码失败（跨域污染之类）的头像数：其余字段照常提交，这几个留作待提交 */
  failedSkins: number;
  /**
   * 编码失败的图层 id，与 failedSkins 同源、只是留下的信息更多。
   * 只说"有 1 个头像无法编码"用户无从下手：得能指认是哪一个、为什么、该怎么办。
   */
  failedSkinLayerIds: string[];
}

function layoutDiff(before: LayerState, after: LayerState): LayoutPatch {
  const patch: LayoutPatch = {};
  if (before.name !== after.name) patch.name = after.name;
  if (before.x !== after.x) patch.x = after.x;
  if (before.y !== after.y) patch.y = after.y;
  if (before.size !== after.size) patch.size = after.size;
  if (before.rotation !== after.rotation) patch.rotation = after.rotation;
  if (before.opacity !== after.opacity) patch.opacity = after.opacity;
  if (before.visible !== after.visible) patch.visible = after.visible;
  if (before.order !== after.order) patch.order = after.order;
  return patch;
}

/** 外观差量：只挑真的变了的键，没变的一个都不带 */
function appearanceDiff(before: LayerState, after: LayerState): AppearancePatch {
  const patch: AppearancePatch = {};
  if (before.overlay !== after.overlay) patch.overlay = after.overlay;
  if (before.flipH !== after.flipH) patch.flipH = after.flipH;
  return patch;
}

function hasKeys(patch: LayoutPatch | AppearancePatch): boolean {
  return Object.keys(patch).length > 0;
}

/**
 * 这台后端认不认识「外观域」：进房快照里每一行都带 appearanceUpdatedAt 才算认识。
 *
 * 判据是"这个键在不在"，不是"戳大不大"。老房间行迁移过来就是 0，那是合法的
 * "从未推进"；若拿 > 0 去判，本来支持外观的后端会被误判成不支持，编辑者的开关又被锁回去。
 * 空房间无从判断，按认识处理（没有头像也就没有外观可改）。
 */
export function supportsAppearanceDomain(records: { appearanceUpdatedAt?: number }[]): boolean {
  return records.length === 0 || records.every((record) => typeof record.appearanceUpdatedAt === 'number');
}

/** 某个图层相对基线是否动过（不含皮肤编码，纯比较，随时可算） */
function isDirty(base: LayerBaseline | undefined, after: LayerState): boolean {
  if (!base) return true;
  return (
    base.state.skinId !== after.skinId ||
    hasKeys(layoutDiff(base.state, after)) ||
    hasKeys(appearanceDiff(base.state, after))
  );
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

export interface BuildOptions {
  /**
   * 目标后端还不认识外观域时，把外观差量并回 layout —— 老后端就是在那儿认 overlay/flipH 的。
   *
   * 为什么不能只是"什么都不发"：那等于让新前端在某些后端上比老前端还能得少。
   * 发布是前后端分开走的（前端在 Pages、后端在 VPS），中间必然有一段窗口是一新一旧，
   * 这段时间里管理员点翻转得能存住，所以退回老协议的写法，而不是悄悄丢掉。
   * 并发凭证同时退回 expectLayoutUpdatedAt：老后端只有这一把戳，推进的也是 layout_updated_at。
   */
  legacyAppearance?: boolean;
}

/** 老协议里 layout 顺便承载着外观字段，合并时按这个形状拼 */
type LegacyLayoutPatch = LayoutPatch & AppearancePatch;

/**
 * 算出这次要提交什么。
 * encodeSkin 由调用方提供（要动 canvas，是唯一不纯的一步）；解不出来只影响皮肤那部分，
 * 布局改动照样提交，解不出来的记在 failedSkins 里让上层提示。
 */
export function buildRoomPatch(
  baseline: Map<string, LayerBaseline>,
  current: LayerState[],
  encodeSkin: (layerId: string) => PresetSkin | null,
  options: BuildOptions = {},
): RoomPatch {
  const patch: RoomPatch = { updates: [], adds: [], deletes: [], failedSkins: 0, failedSkinLayerIds: [] };
  const seen = new Set<string>();

  /** 记一次编码失败：计数与 id 必须同时更新，否则两处信息会对不上 */
  const noteFailedSkin = (layerId: string): void => {
    patch.failedSkins += 1;
    patch.failedSkinLayerIds.push(layerId);
  };

  for (const layer of current) {
    seen.add(layer.id);
    const base = baseline.get(layer.id);
    if (!base) {
      // 新增的行：整行发过去（皮肤必须给，给不出来这条就留着下次）
      const skin = encodeSkin(layer.id);
      if (!skin) { noteFailedSkin(layer.id); continue; }
      patch.adds.push({ ...layer, skin } as RoomAvatarDraft);
      continue;
    }
    const layout = layoutDiff(base.state, layer);
    const appearance = appearanceDiff(base.state, layer);
    const update: AvatarUpdate = { id: layer.id };
    if (options.legacyAppearance) {
      // 老后端：外观并进 layout 一起走。layout 原有的键先铺、外观后压，
      // 两边永远不会同名（外观只可能是 overlay/flipH），这里只是把"谁说了算"写明白。
      const merged: LegacyLayoutPatch = { ...layout, ...appearance };
      if (hasKeys(merged)) {
        update.layout = merged;
        update.expectLayoutUpdatedAt = base.layoutUpdatedAt;
      }
    } else {
      if (hasKeys(layout)) {
        update.layout = layout;
        update.expectLayoutUpdatedAt = base.layoutUpdatedAt;
      }
      if (hasKeys(appearance)) {
        update.appearance = appearance;
        // 外观有独立的版本戳：只翻了帽子层不会连带推进布局戳，也不会被布局冲突挡住
        update.expectAppearanceUpdatedAt = base.appearanceUpdatedAt;
      }
    }
    if (base.state.skinId !== layer.skinId) {
      const skin = encodeSkin(layer.id);
      if (!skin) noteFailedSkin(layer.id);
      else {
        update.skin = skin;
        update.expectSkinUpdatedAt = base.skinUpdatedAt;
      }
    }
    if (update.layout || update.appearance || update.skin) patch.updates.push(update);
  }

  for (const id of baseline.keys()) if (!seen.has(id)) patch.deletes.push(id);
  return patch;
}

/** 有没有东西要提交（不看皮肤编码，用于按钮/提示的即时反馈） */
export function patchIsEmpty(patch: RoomPatch): boolean {
  return patch.updates.length === 0 && patch.adds.length === 0 && patch.deletes.length === 0;
}

/**
 * 这一轮发出去的外观差量，服务端是不是**静默丢掉**了。
 *
 * 判据：确实发过 appearance，而且这几行里有成功回执 —— 但回执里一个 appearanceUpdatedAt 都没有。
 * 老后端不认识这个键，会把它当未知字段整条扔掉，回执却照样是 ok:true，于是界面说"已保存"，
 * 用户刷新一下开关又弹回去。
 *
 * 为什么要每次提交都再确认一遍，而不是只在进房时判一次：进房快照漏得掉一种情况 ——
 * 空房间连老后端时快照里一行头像都没有，supportsAppearanceDomain([]) 只能按"支持"处理；
 * 之后管理员加一行、再点翻转，才发现这台后端根本不认外观域。
 *
 * 只在"成功却没回戳"时判定：如果这几行全被拒（冲突/非法），说明什么都没落库，
 * 那是另一类问题，不该据此认定后端老旧 —— 否则一次普通冲突就会把新后端误判成老后端，
 * 白白把外观并进 layout。
 */
export function appearanceDroppedByServer(sent: RoomPatch, results: PatchItemResult[]): boolean {
  const sentAppearanceIds = new Set(
    sent.updates.filter((update) => update.appearance !== undefined).map((update) => update.id),
  );
  if (sentAppearanceIds.size === 0) return false;
  const accepted = results.filter((result) => result.ok && sentAppearanceIds.has(result.id));
  if (accepted.length === 0) return false;
  return accepted.every((result) => typeof result.appearanceUpdatedAt !== 'number');
}

export interface AdvanceOptions {
  /**
   * 服务端没认外观差量：外观两个字段留在旧基线上，这一轮不往前推。
   *
   * 推了就等于"已经同步"，待提交数会归零，用户再也没有一次机会把这次改动补上去。
   * 留着它，下一次提交才会重新算成待提交，走 legacyAppearance 合并发出去。
   */
  holdAppearance?: boolean;
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
  options: AdvanceOptions = {},
): void {
  const byId = new Map(current.map((layer) => [layer.id, layer]));
  const stamps = new Map(results.filter((r) => r.ok).map((r) => [r.id, r]));

  const settle = (id: string): void => {
    const layer = byId.get(id);
    const stamp = stamps.get(id);
    if (!layer || !stamp) return;
    const prev = baseline.get(id);
    // 服务端没存外观时，基线的外观字段必须停在旧值上：跟着新值走的话，
    // 下一轮差分就认为"外观没变"，那两下点击就真的丢了
    const held =
      options.holdAppearance && prev
        ? { ...layer, overlay: prev.state.overlay, flipH: prev.state.flipH }
        : layer;
    baseline.set(id, {
      state: held,
      skinUpdatedAt: stamp.skinUpdatedAt ?? prev?.skinUpdatedAt ?? 0,
      layoutUpdatedAt: stamp.layoutUpdatedAt ?? prev?.layoutUpdatedAt ?? 0,
      // 老后端不返回 appearanceUpdatedAt：保留上一次的戳，别把它清零
      appearanceUpdatedAt: options.holdAppearance
        ? prev?.appearanceUpdatedAt ?? 0
        : stamp.appearanceUpdatedAt ?? prev?.appearanceUpdatedAt ?? 0,
    });
  };

  for (const update of sent.updates) settle(update.id);
  for (const add of sent.adds) settle(add.id);
  // 删除是管理员说了算，服务端不会因为版本戳拒绝；本地照旧把基线里的行去掉
  for (const id of sent.deletes) baseline.delete(id);
}
