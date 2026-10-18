/*!
 * BlockFace — 给图片贴 Minecraft 头像
 * Copyright 2026 Dainsleif
 * Licensed under the Apache License, Version 2.0
 */

import { computed, reactive, ref } from 'vue';
import { createPresetSkin, type PresetSkin } from '../core/model/preset';
import type { RoomAvatarRecord, RoomDoc } from '../core/collab/types';
import { scaleSizeBy, tidyAngle } from '../core/model/gesture';
import { clampLayerToDocument } from '../core/model/transform';
import { createId, MIN_LAYER_SIZE, type AvatarLayer, type BaseImageMeta } from '../core/model/types';
import { composeDocument } from '../core/render/compose';
import { headCache } from '../core/render/headCache';
import {
  canvasToBlob,
  copyBlobToClipboard,
  downloadBlob,
  suggestFilename,
} from '../core/render/exportImage';
import { loadImage, type LoadedImage } from '../core/sources/imageLoader';
import {
  accountCandidatesFor,
  BUILTIN_SKINS,
  loadFirstAvailable,
  MUA_PROVIDER,
  resolveAccountSkin,
  SkinLookupError,
  validateMuaName,
  type SkinCandidate,
} from '../core/sources/providers';
import { assertUsableSkin, describeCustomImage, describeSkin, type SkinOrigin, type SkinTexture } from '../core/skin/texture';

/* ------------------------------------------------------------------ *
 * 非响应式资源登记处
 * HTMLImageElement / SkinTexture 体积大且不可序列化，放进响应式对象会带来
 * 深代理开销与意外比较问题，因此统一登记在这里，响应式状态里只留 id。
 * ------------------------------------------------------------------ */

const baseImages = new Map<string, HTMLImageElement>();
/** 底图原始文件：协同发布时上传服务器要用原件，转码反而损画质 */
const baseFiles = new Map<string, File>();
const skins = new Map<string, SkinTexture>();

export function getBaseImage(id: string | null): HTMLImageElement | null {
  return id ? baseImages.get(id) ?? null : null;
}

export function getSkin(id: string | null): SkinTexture | null {
  return id ? skins.get(id) ?? null : null;
}

/* ------------------------------------------------------------------ *
 * 状态
 * ------------------------------------------------------------------ */

export interface SkinRecord {
  id: string;
  meta: ReturnType<typeof describeSkin>;
  origin: SkinOrigin;
  sourceLabel: string;
  provider: string;
  tainted: boolean;
}

export interface Notice {
  tone: 'info' | 'success' | 'warn' | 'error';
  message: string;
  at: number;
}

interface Snapshot {
  document: { width: number; height: number };
  baseImageId: string | null;
  layers: AvatarLayer[];
  selectedId: string | null;
  activeSkinId: string | null;
}

interface EditorState {
  document: { width: number; height: number };
  baseImage: BaseImageMeta | null;
  baseImageId: string | null;
  skins: SkinRecord[];
  activeSkinId: string | null;
  layers: AvatarLayer[];
  selectedId: string | null;
  /** 画布视图：缩放倍率 + 平移（屏幕像素）。它只是"看得方便"，不属于文档内容，所以不进历史 */
  view: {
    zoom: number;
    autoFit: boolean;
    x: number;
    y: number;
    viewportWidth: number;
    viewportHeight: number;
  };
  busy: string | null;
  notice: Notice | null;
  showGrid: boolean;
  proxyTemplate: string;
  /** 皮肤登记表版本号，异步加载完成后自增，驱动 canvas 组件重绘 */
  skinRevision: number;
}

export const DEFAULT_DOCUMENT = { width: 1280, height: 800 };
export const DEFAULT_PROXY_TEMPLATE = 'https://images.weserv.nl/?url=';

const state = reactive<EditorState>({
  document: { ...DEFAULT_DOCUMENT },
  baseImage: null,
  baseImageId: null,
  skins: [],
  activeSkinId: null,
  layers: [],
  selectedId: null,
  view: { zoom: 1, autoFit: true, x: 0, y: 0, viewportWidth: 960, viewportHeight: 620 },
  busy: null,
  notice: null,
  showGrid: false,
  proxyTemplate: DEFAULT_PROXY_TEMPLATE,
  skinRevision: 0,
});

/* ------------------------------------------------------------------ *
 * 历史记录
 * ------------------------------------------------------------------ */

const past: Snapshot[] = [];
const future: Snapshot[] = [];
let openChange = false;

/* ------------------------------------------------------------------ *
 * 协同房间钩子
 *
 * collab 状态在另一个模块里，直接互相 import 会成环，所以这里只留挂钩：
 * collab 启动时把三个实现注册进来，离线模式下一概不生效。
 * ------------------------------------------------------------------ */

export interface CollabHooks {
  /** 布局变更守卫：返回 false 表示拒绝（编辑者模式下位置与数量冻结） */
  canMutateLayout(action: string): boolean;
  /** 皮肤被应用到既有图层后回调（编辑者模式用来记"哪些头像改过"） */
  onSkinApplied(layerId: string): void;
  /** 当前角色是否布局冻结（编辑者换肤时不自动改名等外观联动） */
  isLayoutFrozen(): boolean;
}

let collabHooks: CollabHooks | null = null;

export function setCollabHooks(hooks: CollabHooks | null): void {
  collabHooks = hooks;
}

/** 布局变更统一闸口：没注册钩子（纯离线）时永远放行 */
function ensureLayoutMutable(action: string): boolean {
  return collabHooks ? collabHooks.canMutateLayout(action) : true;
}

/**
 * 快照数组本身不需要响应式（把 60 份快照都做成 Proxy 也没意义），
 * 但"能不能撤销"必须响应式，否则按钮的 disabled 会永远停在初始值上。
 * 所以每次历史变化都把这个计数器 +1，让下面的 computed 重新求值。
 */
const historyVersion = ref(0);
function touchHistory(): void {
  historyVersion.value += 1;
}

function snapshot(): Snapshot {
  return {
    document: { ...state.document },
    baseImageId: state.baseImageId,
    layers: state.layers.map((l) => ({ ...l })),
    selectedId: state.selectedId,
    activeSkinId: state.activeSkinId,
  };
}

function restore(snap: Snapshot): void {
  state.document = { ...snap.document };
  state.baseImageId = snap.baseImageId;
  state.baseImage = snap.baseImageId ? readBaseMeta(snap.baseImageId) : null;
  state.layers = snap.layers.map((l) => ({ ...l }));
  state.selectedId = snap.selectedId;
  state.activeSkinId = snap.activeSkinId;
}

const baseMeta = new Map<string, BaseImageMeta>();
function readBaseMeta(id: string): BaseImageMeta | null {
  return baseMeta.get(id) ?? null;
}

/** 清理未被当前画布或撤销/重做历史引用的底图，防止大图片长期驻留导致内存泄漏 */
function sweepUnusedBaseImages(): void {
  const activeIds = new Set<string>();
  if (state.baseImageId) activeIds.add(state.baseImageId);
  for (const snap of past) {
    if (snap.baseImageId) activeIds.add(snap.baseImageId);
  }
  for (const snap of future) {
    if (snap.baseImageId) activeIds.add(snap.baseImageId);
  }
  for (const id of Array.from(baseImages.keys())) {
    if (!activeIds.has(id)) {
      baseImages.delete(id);
      baseMeta.delete(id);
      baseFiles.delete(id);
    }
  }
}

/** 开始一次可撤销的改动；同一交互内重复调用只记一次 */
export function beginChange(): void {
  if (openChange) return;
  past.push(snapshot());
  if (past.length > 60) past.shift();
  future.length = 0;
  openChange = true;
  touchHistory();
}

/** 结束当前改动，允许记录下一次 */
export function endChange(): void {
  if (wheelTimer) {
    clearTimeout(wheelTimer);
    wheelTimer = null;
  }
  if (nudgeTimer) {
    clearTimeout(nudgeTimer);
    nudgeTimer = null;
  }
  openChange = false;
}

/** 一次性改动（不需要成对调用） */
function commit(): void {
  beginChange();
  endChange();
}

/**
 * 滚轮手势专用的历史：滚轮来得又快又密，一个事件记一条会把撤销列表冲爆，
 * 所以整个手势只收一条，停止滚动 400ms 后自动收尾。
 */
let wheelTimer: ReturnType<typeof setTimeout> | null = null;
export function beginWheelChange(): void {
  beginChange();
  if (wheelTimer) clearTimeout(wheelTimer);
  wheelTimer = setTimeout(() => {
    wheelTimer = null;
    endChange();
  }, 400);
}

let nudgeTimer: ReturnType<typeof setTimeout> | null = null;
export function beginNudgeChange(): void {
  beginChange();
  if (nudgeTimer) clearTimeout(nudgeTimer);
  nudgeTimer = setTimeout(() => {
    nudgeTimer = null;
    endChange();
  }, 400);
}

export function undo(): void {
  const snap = past.pop();
  if (!snap) return;
  future.push(snapshot());
  restore(snap);
  endChange();
  sweepUnusedBaseImages();
  touchHistory();
}

export function redo(): void {
  const snap = future.pop();
  if (!snap) return;
  past.push(snapshot());
  restore(snap);
  endChange();
  sweepUnusedBaseImages();
  touchHistory();
}

/* ------------------------------------------------------------------ *
 * 选择与图层
 * ------------------------------------------------------------------ */

export const selectedLayer = computed(() => state.layers.find((l) => l.id === state.selectedId) ?? null);
export const activeSkin = computed(() => state.skins.find((s) => s.id === state.activeSkinId) ?? null);
export const canUndo = computed(() => {
  void historyVersion.value; // 建立响应式依赖：历史一变就重算，否则按钮永远停在初始状态
  return past.length > 0;
});
export const canRedo = computed(() => {
  void historyVersion.value;
  return future.length > 0;
});

/**
 * 头像可用的最大边长：比画布短边还大没有意义（贴出去也只会被裁掉），
 * 所以上限跟着底图尺寸走。界面上的"大小"滑杆必须用同一个上限，
 * 否则滑杆右端会有一截拖了没反应的死区。
 */
export const maxLayerSize = computed(() => Math.max(64, Math.min(state.document.width, state.document.height)));

function clampSize(size: number): number {
  return Math.round(Math.min(maxLayerSize.value, Math.max(MIN_LAYER_SIZE, size)));
}

export function setViewportSize(width: number, height: number): void {
  if (width > 0 && height > 0) {
    state.view.viewportWidth = Math.round(width);
    state.view.viewportHeight = Math.round(height);
  }
}

export function getFitScale(
  docWidth = state.document.width,
  docHeight = state.document.height,
  vw = state.view.viewportWidth,
  vh = state.view.viewportHeight,
): number {
  const pad = 44;
  const sx = (vw - pad) / docWidth;
  const sy = (vh - pad) / docHeight;
  return Math.max(0.05, Math.min(sx, sy, 4));
}

export function getViewScale(): number {
  return state.view.autoFit ? getFitScale() : state.view.zoom;
}

/**
 * 新增头像时的初始摆放：
 * 自动缩放并放置在当前工作区中心（而不是画布中心固定大小）。
 */
export function defaultLayerPlacement(): { x: number; y: number; size: number } {
  const scale = getViewScale();
  const vw = state.view.viewportWidth || 960;
  const vh = state.view.viewportHeight || 620;

  // 工作区可视区域换算到文档坐标系中的跨度
  const visibleWidth = vw / scale;
  const visibleHeight = vh / scale;

  // 自动缩放：在当前视野中占约 35%（舒适可视比例），并通过 clampSize 限制在安全与文档合法范围内
  const rawSize = Math.round(Math.min(visibleWidth, visibleHeight) * 0.35);
  const size = clampSize(rawSize);

  // 工作区中心换算到文档坐标系：
  // 画布容器在工作区中 flex 居中，translate(view.x, view.y) 产生偏移
  // 工作区中心对应文档坐标 (doc.width / 2 - view.x / scale, doc.height / 2 - view.y / scale)
  const rawX = state.document.width / 2 - state.view.x / scale;
  const rawY = state.document.height / 2 - state.view.y / scale;

  // 保证图层即使在大幅平移时，也至少保留一部分在画布内可见
  const clamped = clampLayerToDocument({ x: rawX, y: rawY, size }, state.document.width, state.document.height);

  return {
    x: Math.round(clamped.x),
    y: Math.round(clamped.y),
    size,
  };
}

export function notify(tone: Notice['tone'], message: string): void {
  state.notice = { tone, message, at: Date.now() };
}

export function addLayer(skinId: string, overrides: Partial<AvatarLayer> = {}): AvatarLayer {
  const placement = defaultLayerPlacement();
  const size = overrides.size ?? placement.size;
  const x = overrides.x ?? placement.x;
  const y = overrides.y ?? placement.y;
  const record = state.skins.find((s) => s.id === skinId);
  const isCustom = record?.meta.isCustomImage;
  const prefix = isCustom ? '图片' : '头像';
  const defaultName = `${prefix} ${state.layers.length + 1}${record ? ` · ${record.sourceLabel}` : ''}`;
  const layer: AvatarLayer = {
    id: createId('layer'),
    skinId,
    name: overrides.name ?? defaultName,
    // 默认叠上第二层（帽子层）。官方 Steve 这层正面是一圈不透明灰，会把额头两行
    // 与两鬓盖成灰的（占成品 34% 面积），看着像坏图，但它就是官方原始数据，
    // 开着才是正版渲染结果；不想要的人在属性面板关掉即可。
    overlay: true,
    x,
    y,
    size,
    rotation: 0,
    opacity: 1,
    flipH: false,
    visible: true,
    ...overrides,
  };
  state.layers.push(layer);
  state.selectedId = layer.id;
  return layer;
}

export function removeLayer(id: string): void {
  if (!ensureLayoutMutable('remove')) return;
  const index = state.layers.findIndex((l) => l.id === id);
  if (index < 0) return;
  beginChange();
  state.layers.splice(index, 1);
  if (state.selectedId === id) state.selectedId = state.layers.at(-1)?.id ?? null;
  endChange();
}

export function duplicateLayer(id: string): void {
  if (!ensureLayoutMutable('duplicate')) return;
  const source = state.layers.find((l) => l.id === id);
  if (!source) return;
  beginChange();
  const next = clampLayerToDocument(
    { x: source.x + source.size * 0.2, y: source.y + source.size * 0.2, size: source.size },
    state.document.width,
    state.document.height,
  );
  const copy: AvatarLayer = {
    ...source,
    id: createId('layer'),
    x: next.x,
    y: next.y,
    name: `${source.name} 副本`,
  };
  state.layers.push(copy);
  state.selectedId = copy.id;
  endChange();
}

/**
 * 把图层挪到数组第 index 位（0 是最底层，最后一位是最上层）。
 * 拖动过程中用 record = false 就地重排、松手时再收一条历史，这样整次拖动只占一格撤销。
 */
export function moveLayerTo(id: string, index: number, record = true): void {
  if (!ensureLayoutMutable('reorder')) return;
  const from = state.layers.findIndex((l) => l.id === id);
  if (from < 0) return;
  const to = Math.max(0, Math.min(state.layers.length - 1, index));
  if (to === from) return;
  if (record) commit();
  const [layer] = state.layers.splice(from, 1);
  state.layers.splice(to, 0, layer);
}

/** 上移/下移一层（键盘操作），delta 为正表示往上层走 */
export function nudgeLayerOrder(id: string, delta: number): void {
  const from = state.layers.findIndex((l) => l.id === id);
  if (from < 0) return;
  moveLayerTo(id, from + delta);
}

export function updateLayer(id: string, patch: Partial<AvatarLayer>, record = true): void {
  if (!ensureLayoutMutable('edit')) return;
  const layer = state.layers.find((l) => l.id === id);
  if (!layer) return;
  if (record) commit();
  Object.assign(layer, patch);
  if (patch.size !== undefined) layer.size = clampSize(patch.size);
}

/**
 * 外观入口：帽子层与水平翻转。
 *
 * 单独开一条**不过布局闸口**的路，是因为这两个开关是纯外观，跟位置/尺寸/数量无关。
 * 协同房间里编辑者被禁改的是布局，不是外观 —— 让他俩共用一个入口，就等于
 * 「编辑者不能挪头像」顺带把「编辑者不能切帽子层」也冻住了。
 *
 * 反过来说，updateLayer 的闸口一个都不能松：编辑者仍然改不了 x/y/size/order/name。
 */
export function updateAppearance(
  id: string,
  patch: Partial<Pick<AvatarLayer, 'overlay' | 'flipH'>>,
  record = true,
): void {
  const layer = state.layers.find((l) => l.id === id);
  if (!layer) return;
  if (record) commit();
  Object.assign(layer, patch);
}

/** 滚轮缩放一个头像：以图层中心为锚点按倍率改边长 */
export function scaleLayerBy(id: string, factor: number): void {
  const layer = state.layers.find((l) => l.id === id);
  if (!layer) return;
  if (!ensureLayoutMutable('resize')) return;
  beginWheelChange();
  layer.size = scaleSizeBy(layer.size, factor, MIN_LAYER_SIZE, maxLayerSize.value);
}

/** Shift + 滚轮旋转一个头像 */
export function rotateLayerBy(id: string, degrees: number): void {
  const layer = state.layers.find((l) => l.id === id);
  if (!layer) return;
  if (!ensureLayoutMutable('rotate')) return;
  beginWheelChange();
  layer.rotation = tidyAngle(layer.rotation + degrees);
}

export function nudgeSelected(dx: number, dy: number): void {
  const layer = selectedLayer.value;
  if (!layer) return;
  if (!ensureLayoutMutable('move')) return;
  beginNudgeChange();
  const next = clampLayerToDocument(
    { x: layer.x + dx, y: layer.y + dy, size: layer.size },
    state.document.width,
    state.document.height,
  );
  layer.x = next.x;
  layer.y = next.y;
}

export function centerSelected(): void {
  const layer = selectedLayer.value;
  if (!layer) return;
  if (!ensureLayoutMutable('move')) return;
  commit();
  layer.x = state.document.width / 2;
  layer.y = state.document.height / 2;
}

export function fitSelectedToDocument(): void {
  const layer = selectedLayer.value;
  if (!layer) return;
  if (!ensureLayoutMutable('resize')) return;
  commit();
  layer.size = clampSize(Math.min(state.document.width, state.document.height) * 0.8);
  layer.x = state.document.width / 2;
  layer.y = state.document.height / 2;
}

export function selectLayer(id: string | null): void {
  state.selectedId = id;
  const layer = state.layers.find((l) => l.id === id);
  if (layer) state.activeSkinId = layer.skinId;
}

/* ------------------------------------------------------------------ *
 * 皮肤装载
 * ------------------------------------------------------------------ */

function registerSkin(
  loaded: LoadedImage,
  origin: SkinOrigin,
  sourceLabel: string,
  provider: string,
  id?: string,
  activate = true,
  isCustomImage = false,
  isFrontOnly = false,
): SkinTexture {
  const meta = isCustomImage
    ? describeCustomImage(loaded.width, loaded.height)
    : describeSkin(loaded.width, loaded.height, isFrontOnly);
  if (!isCustomImage) {
    assertUsableSkin(meta);
  }
  const skinId = id ?? createId('skin');
  const texture: SkinTexture = {
    id: skinId,
    image: loaded.element,
    meta,
    origin,
    sourceLabel,
    tainted: loaded.tainted,
    // blob: 地址在载入后立刻 revoke，留着只会指向一张不存在的图
    sourceUrl: loaded.url.startsWith('blob:') ? undefined : loaded.url,
  };
  skins.set(skinId, texture);

  const record: SkinRecord = { id: skinId, meta, origin, sourceLabel, provider, tainted: loaded.tainted };
  const existing = state.skins.findIndex((s) => s.id === skinId);
  if (existing >= 0) state.skins[existing] = record;
  else state.skins.push(record);
  if (activate) state.activeSkinId = skinId;
  // 贴图是异步解码的，canvas 组件靠这个版本号感知"该重画了"
  state.skinRevision += 1;
  return texture;
}

/**
 * 预加载内置皮肤（只登记，不应用到图层），让 Steve/Alex 卡片一开始就是真实渲染。
 */
export async function preloadBuiltins(): Promise<void> {
  for (const builtin of BUILTIN_SKINS) {
    const skinId = `builtin-${builtin.id}`;
    if (skins.has(skinId)) continue;
    try {
      const loaded = await loadImage(builtin.url, { cors: false });
      registerSkin(loaded, 'builtin', builtin.name, '内置', skinId, false);
    } catch {
      // 单张失败不影响其它入口
    }
  }
}

async function loadCandidate(candidate: SkinCandidate): Promise<LoadedImage> {
  return loadImage(candidate.url, { proxyTemplate: state.proxyTemplate });
}

/**
 * 应用一份皮肤：若当前有选中图层则替换其皮肤，否则新建图层。
 * 这样「点 Steve」和「给选中的头像换皮肤」是同一个动作，符合贴纸工具的心智模型。
 */
function applySkin(skinId: string): void {
  const layer = selectedLayer.value;
  const record = state.skins.find((s) => s.id === skinId);
  const isCustom = record?.meta.isCustomImage;
  const prefix = isCustom ? '图片' : '头像';
  if (layer) {
    commit();
    layer.skinId = skinId;
    // 协同编辑者的场景里名字是布局的一部分，换肤不动它
    if (record && !(collabHooks?.isLayoutFrozen() ?? false)) {
      layer.name = `${prefix} · ${record.sourceLabel}`;
    }
    notify('success', `已应用到选中的${prefix}`);
    collabHooks?.onSkinApplied(layer.id);
  } else {
    // 布局冻结的角色（协同编辑者）没有"新增"这条路：得先点选一个头像再换肤
    if (collabHooks?.isLayoutFrozen() ?? false) {
      notify('warn', '先在画布上点选一个头像，再给它换皮肤');
      return;
    }
    commit();
    addLayer(skinId);
  }
}

/**
 * 再放一个头像：无论当前是否选中图层，都新建一个。
 * 皮肤列表的点击语义是「应用到选中」，只有这里明确是「再加一个」——
 * 否则用户点完 Steve 再点 Alex 会以为在新增，实际却把 Steve 换掉了。
 */
export function addAvatar(): void {
  if (!ensureLayoutMutable('add')) return;
  const skinId = state.activeSkinId ?? state.skins[0]?.id ?? null;
  if (!skinId || !skins.has(skinId)) {
    notify('warn', '先从左侧载入一张皮肤，再加头像');
    return;
  }
  commit();
  addLayer(skinId);
  notify('success', '已新增一个头像');
}

/** 把已登记的皮肤应用到当前选中图层（没有选中则新建图层） */
export function useExistingSkin(skinId: string): void {
  if (!skins.has(skinId)) return;
  applySkin(skinId);
}

/** 获取当前画布以及撤销/重做历史中所有被引用的皮肤素材 id */
function getReferencedSkinIds(): Set<string> {
  const ids = new Set(state.layers.map((l) => l.skinId));
  for (const snap of past) {
    for (const l of snap.layers) ids.add(l.skinId);
  }
  for (const snap of future) {
    for (const l of snap.layers) ids.add(l.skinId);
  }
  return ids;
}

/**
 * 移除一张已登记的皮肤素材。
 * 若素材正在被当前画布或撤销/重做历史上的图层引用，则拒绝删除以防画面破损；内置皮肤不可删除。
 */
export function removeSkin(id: string): boolean {
  if (id.startsWith('builtin-')) {
    notify('warn', '内置皮肤不可删除');
    return false;
  }
  const inUse = state.layers.some((l) => l.skinId === id);
  if (inUse) {
    notify('warn', '该素材正在被画布图层使用，请先删除对应图层或更换素材');
    return false;
  }
  const inHistory =
    past.some((s) => s.layers.some((l) => l.skinId === id)) ||
    future.some((s) => s.layers.some((l) => l.skinId === id));
  if (inHistory) {
    notify('warn', '该素材在撤销/重做历史中被引用，不可直接删除');
    return false;
  }
  skins.delete(id);
  headCache.evictSkin(id);
  const index = state.skins.findIndex((s) => s.id === id);
  if (index >= 0) {
    state.skins.splice(index, 1);
  }
  if (state.activeSkinId === id) {
    state.activeSkinId = state.skins[0]?.id ?? null;
  }
  state.skinRevision += 1;
  notify('success', '已删除素材');
  return true;
}

/**
 * 清理所有未被当前图层或历史快照引用的非内置素材，释放图片显存与内存。
 */
export function clearUnusedSkins(): number {
  const referencedIds = getReferencedSkinIds();
  const toRemove = state.skins.filter((s) => s.origin !== 'builtin' && !referencedIds.has(s.id));
  if (toRemove.length === 0) {
    notify('info', '没有闲置素材需要清理');
    return 0;
  }
  for (const record of toRemove) {
    skins.delete(record.id);
    headCache.evictSkin(record.id);
    const index = state.skins.findIndex((s) => s.id === record.id);
    if (index >= 0) state.skins.splice(index, 1);
  }
  if (!state.skins.some((s) => s.id === state.activeSkinId)) {
    state.activeSkinId = state.skins[0]?.id ?? null;
  }
  state.skinRevision += 1;
  notify('success', `已清理 ${toRemove.length} 张闲置素材`);
  return toRemove.length;
}

export async function useBuiltinSkin(builtinId: string): Promise<void> {
  const builtin = BUILTIN_SKINS.find((b) => b.id === builtinId);
  if (!builtin) return;
  state.busy = `加载 ${builtin.name}`;
  try {
    const loaded = await loadImage(builtin.url, { cors: false });
    const skinId = `builtin-${builtin.id}`;
    registerSkin(loaded, 'builtin', builtin.name, '内置', skinId);
    applySkin(skinId);
  } catch (error) {
    notify('error', `内置皮肤加载失败：${(error as Error).message}`);
  } finally {
    state.busy = null;
  }
}

export async function useAccountSkin(name: string): Promise<void> {
  state.busy = `查询 ${name}`;
  try {
    const resolution = await resolveAccountSkin(name);
    // 档案服务明确说没有这个人时，镜像站给的默认皮肤是假数据，不能拿来当正版皮肤
    const candidates = accountCandidatesFor(resolution);
    if (candidates.length === 0) {
      throw new SkinLookupError(`正版账号里没有「${name}」`);
    }
    const { result, provider } = await loadFirstAvailable(candidates, loadCandidate);
    const skinId = createId('skin');
    registerSkin(result, 'account', resolution.displayName, provider, skinId);
    applySkin(skinId);
    notify(
      resolution.resolved ? 'success' : 'warn',
      resolution.resolved
        ? `已加载 ${resolution.displayName} 的皮肤`
        : `正版档案未找到「${name}」，已从 ${provider} 取到一张同名皮肤`,
    );
  } catch (error) {
    notify('error', (error as Error).message);
  } finally {
    state.busy = null;
  }
}

/**
 * MUA 联合认证皮肤的上游地址。
 *
 * 和正版 ID 一样是**纯前端直连**：skin.mualliance.ltd 不返回 Access-Control-Allow-Origin，
 * 所以真正的取图交给 loadImage 那套三级降级 —— 先按 CORS 直取，
 * 不行就走用户配置的跨域代理（默认 images.weserv.nl，与「网络地址」入口完全同一套），
 * 再不行退回非 CORS 加载（能看见，但画布被污染、导出前会提示）。
 * 这里不另造一条取图路径：多一条路径就多一份"两边行为不一致"的债。
 */
export function muaSkinUrl(name: string): string {
  return 'https://skin.mualliance.ltd/api/union/skin/byname/' + encodeURIComponent(name);
}

async function loadMuaSkin(name: string): Promise<{ loaded: LoadedImage; provider: string; label: string }> {
  const clean = validateMuaName(name);
  let loaded: LoadedImage;
  try {
    loaded = await loadImage(muaSkinUrl(clean), { proxyTemplate: state.proxyTemplate });
  } catch {
    // 上游用 404 表示"Union 里没这个 ID"，500 表示"这个角色所属的成员皮肤站自己挂了"。
    // 走 <img> 加载时两种都只是 onerror，前端分不出来 —— 所以不臆断成"名字不存在"，
    // 把两种可能都摆出来，用户才知道该改名字还是该等一会儿再试。
    throw new SkinLookupError(
      `没取到 MUA 联合认证「${clean}」的皮肤：Union 里没有这个 ID，或它所属的皮肤站暂时不可用`,
    );
  }
  return { loaded: requireSkin(loaded), provider: MUA_PROVIDER, label: clean };
}

export async function useMuaSkin(name: string): Promise<void> {
  state.busy = `查询 ${name}`;
  try {
    const { loaded, label } = await loadMuaSkin(name);
    const skinId = createId('skin');
    registerSkin(loaded, 'mua', label, MUA_PROVIDER, skinId);
    applySkin(skinId);
    notify(
      loaded.tainted ? 'warn' : 'success',
      loaded.tainted
        ? `已加载「${label}」（若保存受限请点「重取」或改用本地上传）`
        : `已加载 MUA 联合认证「${label}」的皮肤`,
    );
  } catch (error) {
    notify('error', (error as Error).message);
  } finally {
    state.busy = null;
  }
}

/** MUA 联合认证 ID：一个走老路，多个各新增一个（与正版账号 ID 的批量口径一致） */
export async function useMuaSkins(text: string): Promise<BatchResult> {
  const names = splitBatchInput(text);
  if (names.length === 0) {
    notify('error', '请输入 MUA 联合认证 ID');
    return { ok: 0, failed: [] };
  }
  if (names.length === 1) {
    const before = state.skins.length;
    await useMuaSkin(names[0]);
    return state.skins.length > before ? { ok: 1, failed: [] } : { ok: 0, failed: [names[0]] };
  }
  return batchAdd(
    names.map((name): BatchItem => ({
      label: name,
      origin: 'mua',
      load: () => loadMuaSkin(name),
    })),
    '查询 MUA',
  );
}

function isSkinFile(file: File): boolean {
  return file.type === 'image/png' || /\.png$/i.test(file.name);
}

export function isImageFile(file: File): boolean {
  return file.type.startsWith('image/') || /\.(png|jpe?g|webp|gif|bmp|svg|avif)$/i.test(file.name);
}

export async function useImageFile(file: File): Promise<void> {
  if (!isImageFile(file)) {
    notify('error', '请选择图片文件（PNG / JPG / WebP 等）');
    return;
  }
  state.busy = `读取 ${file.name}`;
  try {
    const url = URL.createObjectURL(file);
    try {
      const loaded = await loadImage(url, { cors: false });
      const skinId = createId('skin');
      registerSkin(loaded, 'upload', file.name.replace(/\.[^.]+$/, ''), '本地图片', skinId, true, true);
      applySkin(skinId);
      notify('success', `已载入图片 ${file.name}`);
    } finally {
      URL.revokeObjectURL(url);
    }
  } catch (error) {
    notify('error', (error as Error).message);
  } finally {
    state.busy = null;
  }
}

export async function useSkinFile(file: File): Promise<void> {
  if (!isSkinFile(file)) {
    notify('error', '请选择 PNG 格式的皮肤贴图');
    return;
  }
  state.busy = `读取 ${file.name}`;
  try {
    const url = URL.createObjectURL(file);
    try {
      const loaded = await loadImage(url, { cors: false });
      const skinId = createId('skin');
      registerSkin(loaded, 'upload', file.name.replace(/\.[^.]+$/, ''), '本地上传', skinId);
      applySkin(skinId);
      notify('success', `已载入皮肤 ${file.name}`);
    } finally {
      URL.revokeObjectURL(url);
    }
  } catch (error) {
    notify('error', (error as Error).message);
  } finally {
    state.busy = null;
  }
}

export async function useSkinUrl(rawUrl: string): Promise<void> {
  const url = rawUrl.trim();
  if (!url) {
    notify('error', '请输入皮肤贴图地址');
    return;
  }
  state.busy = '下载皮肤';
  try {
    const loaded = await loadImage(url, { proxyTemplate: state.proxyTemplate });
    const skinId = createId('skin');
    const label = url.split('/').pop()?.slice(0, 24) || '远程皮肤';
    registerSkin(loaded, 'url', label, new URL(url).hostname, skinId);
    applySkin(skinId);
    notify(
      loaded.tainted ? 'warn' : 'success',
      loaded.tainted
        ? '皮肤已载入（若保存受限请点「重取」或改用本地上传）'
        : '皮肤已载入',
    );
  } catch (error) {
    notify('error', `皮肤地址加载失败：${(error as Error).message}`);
  } finally {
    state.busy = null;
  }
}

/* ------------------------------------------------------------------ *
 * 底图与文档
 * ------------------------------------------------------------------ */

export async function setBaseImage(file: File): Promise<void> {
  if (!ensureLayoutMutable('base')) return;
  state.busy = '读取图片';
  try {
    const url = URL.createObjectURL(file);
    try {
      const loaded = await loadImage(url, { cors: false });
      const id = createId('base');
      baseImages.set(id, loaded.element);
      baseFiles.set(id, file);
      const meta: BaseImageMeta = {
        id,
        name: file.name.replace(/\.[^.]+$/, ''),
        width: loaded.width,
        height: loaded.height,
        tainted: loaded.tainted,
      };
      baseMeta.set(id, meta);
      beginChange();
      state.baseImageId = id;
      state.baseImage = meta;
      state.document = { width: loaded.width, height: loaded.height };
      for (const layer of state.layers) {
        const next = clampLayerToDocument(layer, state.document.width, state.document.height);
        layer.x = next.x;
        layer.y = next.y;
      }
      endChange();
      sweepUnusedBaseImages();
      fitView();
      notify('success', `已载入底图 ${meta.name}（${meta.width}×${meta.height}）`);
    } finally {
      URL.revokeObjectURL(url);
    }
  } catch (error) {
    notify('error', `图片加载失败：${(error as Error).message}`);
  } finally {
    state.busy = null;
  }
}

export function clearBaseImage(): void {
  if (!ensureLayoutMutable('base')) return;
  commit();
  state.baseImageId = null;
  state.baseImage = null;
  state.document = { ...DEFAULT_DOCUMENT };
  sweepUnusedBaseImages();
}

/**
 * 回到「适应窗口」：缩放交给组件按窗口尺寸算（autoFit），这里把平移清零。
 * 视图的缩放与平移只是"看得方便"，不属于文档内容，因此不进撤销历史。
 */
export function fitView(): void {
  state.view.autoFit = true;
  state.view.x = 0;
  state.view.y = 0;
}

export function setDocumentSize(width: number, height: number): void {
  if (!ensureLayoutMutable('doc')) return;
  commit();
  state.document = { width: Math.round(width), height: Math.round(height) };
  for (const layer of state.layers) {
    const next = clampLayerToDocument(layer, state.document.width, state.document.height);
    layer.x = next.x;
    layer.y = next.y;
  }
}

/* ------------------------------------------------------------------ *
 * 导出
 * ------------------------------------------------------------------ */

function composeToCanvas(checkerboard: boolean): HTMLCanvasElement | null {
  const canvas = document.createElement('canvas');
  const items = state.layers
    .map((layer) => ({ layer, skin: getSkin(layer.skinId) }))
    .filter((item): item is { layer: AvatarLayer; skin: SkinTexture } => item.skin !== null);
  if (state.layers.length > 0 && items.length === 0) {
    notify('error', '皮肤尚未加载完成，无法合成');
    return null;
  }
  if (items.length < state.layers.length) {
    const missing = state.layers.length - items.length;
    notify('warn', `有 ${missing} 个头像的皮肤尚未就绪，已略过未加载项`);
  }
  const baseImage = getBaseImage(state.baseImageId);
  try {
    composeDocument(canvas, {
      width: state.document.width,
      height: state.document.height,
      baseImage,
      items,
      checkerboard,
    });
  } catch (error) {
    notify('error', (error as Error).message);
    return null;
  }
  return canvas;
}

/** 导出固定 1 倍：导出尺寸就是画布尺寸，所见即所得 */
export async function exportPng(): Promise<void> {
  const canvas = composeToCanvas(false);
  if (!canvas) return;
  try {
    const blob = await canvasToBlob(canvas);
    downloadBlob(blob, suggestFilename());
    notify('success', `已导出 ${canvas.width}×${canvas.height} PNG`);
  } catch (error) {
    notify('error', (error as Error).message);
  }
}

/** 一键复制合成图到剪贴板，方便直接粘贴发送 */
export async function copyPng(): Promise<void> {
  const canvas = composeToCanvas(false);
  if (!canvas) return;
  try {
    const blob = await canvasToBlob(canvas);
    await copyBlobToClipboard(blob);
    notify('success', `已复制 ${canvas.width}×${canvas.height} 图像到剪贴板`);
  } catch (error) {
    notify('error', (error as Error).message);
  }
}

/* ------------------------------------------------------------------ *
 * 批量添加
 *
 * 一次贴一排头像是这工具最常见的用法（一个班、一支队伍）。
 * 口径：填一个 = 老规矩（换掉选中的头像，没选中就新增）；填多个 = 各新增一个 ——
 * 一次给一列名单时，用户要的显然是"都加上"，不是互相覆盖。
 * ------------------------------------------------------------------ */

/** 一次批量的上限：再多就不是"贴几个头像"，而是导入了 */
export const MAX_BATCH = 12;

export interface BatchResult {
  ok: number;
  failed: string[];
}

/** 名单按空格、逗号、分号、换行拆开 —— 从聊天窗口里粘出来就是长这样 */
export function splitBatchInput(text: string): string[] {
  return text
    .split(/[\s,，、;；]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, MAX_BATCH);
}

/** 尺寸不合规的贴图在这里就拦掉，别等画的时候才炸 */
function requireSkin(loaded: LoadedImage): LoadedImage {
  assertUsableSkin(describeSkin(loaded.width, loaded.height));
  return loaded;
}

function shortLabel(text: string): string {
  return text.length > 24 ? text.slice(0, 24) + '…' : text;
}

/** 一次贴多个时别都堆在正中间：按方阵摆开，一眼能数清有几个 */
function gridSlots(count: number): { x: number; y: number; size: number }[] {
  const cols = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / cols);
  const cellWidth = state.document.width / (cols + 1);
  const cellHeight = state.document.height / (rows + 1);
  const size = clampSize(Math.min(cellWidth, cellHeight) * 1.2);
  return Array.from({ length: count }, (_, index) => ({
    x: Math.round(cellWidth * ((index % cols) + 1)),
    y: Math.round(cellHeight * (Math.floor(index / cols) + 1)),
    size,
  }));
}

interface BatchItem {
  /** 失败时用来指认是谁 */
  label: string;
  origin: SkinOrigin;
  isCustomImage?: boolean;
  load: () => Promise<{ loaded: LoadedImage; provider: string; label: string }>;
}

/** 逐个加载，成功的各占一层；整批只收一条历史，撤销一次就整批退回 */
async function batchAdd(items: BatchItem[], what: string): Promise<BatchResult> {
  if (!ensureLayoutMutable('add-batch')) return { ok: 0, failed: [] };
  const ready: { loaded: LoadedImage; provider: string; label: string; origin: SkinOrigin; isCustomImage?: boolean }[] = [];
  const failed: string[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    state.busy = `批量${what} ${index + 1}/${items.length}`;
    try {
      ready.push({ ...(await item.load()), origin: item.origin, isCustomImage: item.isCustomImage });
    } catch {
      failed.push(shortLabel(item.label));
    }
  }
  state.busy = null;

  if (ready.length === 0) {
    notify('error', `${what}都没成功：${failed.join('、')}`);
    return { ok: 0, failed };
  }

  commit();
  const slots = gridSlots(ready.length);
  ready.forEach((entry, index) => {
    const skinId = createId('skin');
    registerSkin(entry.loaded, entry.origin, entry.label, entry.provider, skinId, false, entry.isCustomImage);
    addLayer(skinId, slots[index]);
    state.activeSkinId = skinId;
  });
  notify(
    failed.length > 0 ? 'warn' : 'success',
    failed.length > 0
      ? `批量添加了 ${ready.length} 个头像，${failed.length} 个失败（${failed.join('、')}）`
      : `批量添加了 ${ready.length} 个头像`,
  );
  return { ok: ready.length, failed };
}

/** 账号 ID：一个走老路（应用到选中的头像），多个就各新增一个 */
export async function useAccountSkins(text: string): Promise<BatchResult> {
  const names = splitBatchInput(text);
  if (names.length === 0) {
    notify('error', '请输入正版账号 ID');
    return { ok: 0, failed: [] };
  }
  if (names.length === 1) {
    const before = state.skins.length;
    await useAccountSkin(names[0]);
    return state.skins.length > before ? { ok: 1, failed: [] } : { ok: 0, failed: [names[0]] };
  }
  return batchAdd(
    names.map((name): BatchItem => ({
      label: name,
      origin: 'account',
      load: async () => {
        const resolution = await resolveAccountSkin(name);
        const { result, provider } = await loadFirstAvailable(resolution.candidates, loadCandidate);
        return { loaded: requireSkin(result), provider, label: resolution.displayName };
      },
    })),
    '查询账号',
  );
}

/** 皮肤文件：一张走老路，多张各新增一个 */
export async function useSkinFiles(files: File[]): Promise<BatchResult> {
  const usable = files.filter((file) => isSkinFile(file));
  if (usable.length === 0) {
    notify('error', '请选择 PNG 格式的皮肤贴图');
    return { ok: 0, failed: [] };
  }
  if (usable.length === 1) {
    const before = state.skins.length;
    await useSkinFile(usable[0]);
    return state.skins.length > before ? { ok: 1, failed: [] } : { ok: 0, failed: [usable[0].name] };
  }
  return batchAdd(
    usable.map((file): BatchItem => ({
      label: file.name,
      origin: 'upload',
      load: async () => {
        const url = URL.createObjectURL(file);
        try {
          const loaded = requireSkin(await loadImage(url, { cors: false }));
          return { loaded, provider: '本地上传', label: file.name.replace(/\.[^.]+$/, '') };
        } finally {
          URL.revokeObjectURL(url);
        }
      },
    })),
    '读取皮肤',
  );
}

/** 头像图片文件：一张走老路，多张各新增一个 */
export async function useImageFiles(files: File[]): Promise<BatchResult> {
  const usable = files.filter((file) => isImageFile(file));
  if (usable.length === 0) {
    notify('error', '请选择有效的图片文件（PNG / JPG / WebP 等）');
    return { ok: 0, failed: [] };
  }
  if (usable.length === 1) {
    const before = state.skins.length;
    await useImageFile(usable[0]);
    return state.skins.length > before ? { ok: 1, failed: [] } : { ok: 0, failed: [usable[0].name] };
  }
  return batchAdd(
    usable.map((file): BatchItem => ({
      label: file.name,
      origin: 'upload',
      isCustomImage: true,
      load: async () => {
        const url = URL.createObjectURL(file);
        try {
          const loaded = await loadImage(url, { cors: false });
          return { loaded, provider: '本地图片', label: file.name.replace(/\.[^.]+$/, '') };
        } finally {
          URL.revokeObjectURL(url);
        }
      },
    })),
    '读取图片',
  );
}

/** 皮肤地址：一条走老路，多条各新增一个 */
export async function useSkinUrls(text: string): Promise<BatchResult> {
  const urls = splitBatchInput(text);
  if (urls.length === 0) {
    notify('error', '请输入皮肤贴图地址');
    return { ok: 0, failed: [] };
  }
  if (urls.length === 1) {
    const before = state.skins.length;
    await useSkinUrl(urls[0]);
    return state.skins.length > before ? { ok: 1, failed: [] } : { ok: 0, failed: [urls[0]] };
  }
  return batchAdd(
    urls.map((url): BatchItem => ({
      label: url,
      origin: 'url',
      load: async () => {
        const loaded = requireSkin(await loadImage(url, { proxyTemplate: state.proxyTemplate }));
        const parsed = new URL(url);
        return { loaded, provider: parsed.hostname, label: url.split('/').pop()?.slice(0, 24) || parsed.hostname };
      },
    })),
    '下载皮肤',
  );
}

/* ------------------------------------------------------------------ *
 * 协同房间文档
 *
 * 房间里的一条头像记录 = 预设同款 PresetLayer + id + order + updatedAt：
 * 服务端一头像一键，改内容就是覆盖那一个 key。这里负责三个动作：
 *  - loadRoomDocument：进房装载（底图 + 头像，沿用服务端 id，历史清零）
 *  - encodeLayerSkin：把某图层当前皮肤编码成可存储的 PresetSkin
 *  - collectRoomPayload：发布 / 管理员全量提交时把画布整理成协议载荷
 * ------------------------------------------------------------------ */

/**
 * 载入一个协同房间：底图 + 全部头像记录。
 * 与旧套用预设的两个关键差别：
 *  1. 图层沿用服务端 id —— 之后提交增量要对得上号，不能重新 createId；
 *  2. 撤销历史清零 —— 进房间的第一眼不该能"撤销"出上一个会话的画布。
 * 皮肤解不出来的一条回退内置皮肤并计数，与套用预设同一策略。
 */
export async function loadRoomDocument(
  baseFile: File,
  records: RoomAvatarRecord[],
  doc: RoomDoc,
): Promise<{ fallbackSkins: number }> {
  state.busy = '载入房间';
  try {
    const url = URL.createObjectURL(baseFile);
    let baseLoaded: LoadedImage;
    try {
      baseLoaded = await loadImage(url, { cors: false });
    } finally {
      URL.revokeObjectURL(url);
    }
    const baseId = createId('base');
    baseImages.set(baseId, baseLoaded.element);
    baseFiles.set(baseId, baseFile);
    // 底图元数据里的宽高 = **画布坐标空间**，必须取服务端给的 doc，而不是图片自身的
    // naturalWidth/Height：非管理员拿到的是一张缩小过的预览图，拿它的尺寸当坐标空间
    // 会让整间房的头像位置整体错位（服务端存的是原图像素坐标）。
    // 预览只是像素源，按 cover 铺满同一个画布盒子，画出来与用原图逐像素对齐。
    const docWidth = doc.width > 0 ? doc.width : baseLoaded.width;
    const docHeight = doc.height > 0 ? doc.height : baseLoaded.height;
    baseMeta.set(baseId, {
      id: baseId,
      name: baseFile.name.replace(/\.[^.]+$/, '') || '底图',
      width: docWidth,
      height: docHeight,
      tainted: baseLoaded.tainted,
    });

    // 皮肤先全部解出来再动画布：中途失败保持原样，别搅成半成品
    let fallbackSkins = 0;
    const ready: { record: RoomAvatarRecord; loaded: LoadedImage; isCustom: boolean; isFrontOnly: boolean }[] = [];
    let fallbackLoaded: LoadedImage | null = null;
    for (const record of records) {
      let loaded: LoadedImage | null = null;
      let isCustom = false;
      let isFrontOnly = false;
      if (record.skin) {
        try {
          const candidate = await loadImage(record.skin.dataUrl, { cors: false });
          isCustom = record.skin.isCustomImage === true;
          isFrontOnly = record.skin.frontOnly === true;
          if (isCustom || describeSkin(candidate.width, candidate.height, isFrontOnly).valid) {
            loaded = candidate;
          }
        } catch {
          /* 走兜底 */
        }
      }
      if (!loaded) {
        try {
          if (!fallbackLoaded) fallbackLoaded = await loadImage(BUILTIN_SKINS[0].url, { cors: false });
          loaded = fallbackLoaded;
        } catch {
          continue; // 连内置皮肤都取不到：这一条只能跳过
        }
        isCustom = false;
        isFrontOnly = false;
        fallbackSkins += 1;
      }
      ready.push({ record, loaded, isCustom, isFrontOnly });
    }

    past.length = 0;
    future.length = 0;
    openChange = false;
    state.baseImageId = baseId;
    state.baseImage = baseMeta.get(baseId) ?? null;
    state.document = { ...doc };
    state.layers.length = 0;
    for (const item of ready) {
      const skinId = createId('skin');
      // 房间头像是预设同款记录：origin 沿用 preset，渲染与缩略图管线零改动
      registerSkin(item.loaded, 'preset', item.record.name, '房间', skinId, false, item.isCustom, item.isFrontOnly);
      state.layers.push({
        id: item.record.id,
        skinId,
        name: item.record.name,
        x: item.record.x,
        y: item.record.y,
        size: clampSize(item.record.size),
        rotation: item.record.rotation,
        opacity: item.record.opacity,
        overlay: item.record.overlay,
        flipH: item.record.flipH,
        visible: item.record.visible,
      });
    }
    sweepUnusedBaseImages();
    const top = state.layers.at(-1) ?? null;
    state.selectedId = top?.id ?? null;
    if (top) state.activeSkinId = top.skinId;
    fitView();
    state.skinRevision += 1;
    return { fallbackSkins };
  } finally {
    state.busy = null;
  }
}

/** 皮肤位图 → PNG data URI 与实际尺寸；MC皮肤仅存正脸双层（底层与帽子层并排，16×8 等比），通用头像等比压到 512px 以内（远小于单条 data URI 的上限 BF_MAX_SKIN_DATA_URL_CHARS，钱花在清晰度上不划算）；画布被污染时返回 null */
function skinToDataUrl(skin: SkinTexture): { dataUrl: string; width: number; height: number; frontOnly?: boolean } | null {
  try {
    const isCustom = skin.meta.isCustomImage === true;
    if (isCustom) {
      let w = skin.meta.width;
      let h = skin.meta.height;
      const maxDim = 512;
      if (w > maxDim || h > maxDim) {
        const ratio = Math.min(maxDim / w, maxDim / h);
        w = Math.max(1, Math.round(w * ratio));
        h = Math.max(1, Math.round(h * ratio));
      }
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(skin.image, 0, 0, w, h);
      const dataUrl = canvas.toDataURL('image/png');
      return { dataUrl, width: w, height: h };
    }

    // 房间记录仅存正脸双层：底层正脸与帽子层正脸并排，尺寸为 (16*scale) × (8*scale)
    const scale = skin.meta.scale;
    const faceSize = 8 * scale;
    const w = faceSize * 2;
    const h = faceSize;

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.imageSmoothingEnabled = false;

    if (skin.meta.frontOnly) {
      // 本身已经是正脸双层，直接 1:1 拷贝
      ctx.drawImage(skin.image, 0, 0, w, h);
    } else {
      // 从完整皮肤或头部展开图提取正脸底层与帽子层正脸
      // 正脸底层：HEAD_REGIONS.front [8, 8, 8, 8]
      ctx.drawImage(skin.image, 8 * scale, 8 * scale, faceSize, faceSize, 0, 0, faceSize, faceSize);
      // 帽子层正脸：HAT_REGIONS.front [40, 8, 8, 8]
      ctx.drawImage(skin.image, 40 * scale, 8 * scale, faceSize, faceSize, faceSize, 0, faceSize, faceSize);
    }

    const dataUrl = canvas.toDataURL('image/png');
    return { dataUrl, width: w, height: h, frontOnly: true };
  } catch {
    return null;
  }
}

/** 把一个图层当前的皮肤编码成可存储的 PresetSkin（缺图或画布污染时返回 null） */
export function encodeLayerSkin(layerId: string): PresetSkin | null {
  const layer = state.layers.find((l) => l.id === layerId);
  if (!layer) return null;
  const skin = getSkin(layer.skinId);
  if (!skin) return null;
  const encoded = skinToDataUrl(skin);
  if (!encoded) return null;
  // frontOnly 必须原样传下去：它是渲染时判别正脸双层贴图的唯一依据
  return createPresetSkin({ ...encoded, isCustomImage: skin.meta.isCustomImage === true });
}

/**
 * 把"皮肤保存不了"翻译成用户能动手的句子。
 *
 * 两件事在用户眼里是同一件：图明明画在画布上，却存不下来。原因在浏览器安全策略里 ——
 * 图片来自别的网站、对方没允许本程序读取它的像素，画布就被标记为"只能看不能读"。
 * 这些词（跨域、CORS、污染、编码）**一个都不该出现在提示里**：用户既不知道它们指什么，
 * 也没法据此行动。要说的是三件事：哪个头像、为什么、现在能做什么。
 *
 * 能做的只有两件真实存在的操作：「重取」（有时只是刚才取图临时失败）和
 * 「上传皮肤」（把图下到本地再导入，绕开对方网站的许可问题）。
 * 别再提"配置代理模板"之类 —— 界面上根本没有这个设置。
 */
export function describeEncodeFailure(
  failed: { name: string; skinLabel: string; tainted: boolean }[],
): string {
  if (failed.length === 0) return '';
  // 头像名里往往已经含了素材来源（如"头像 1 · UpSGE"），再补一次只是噪音
  const names = failed
    .map((item) =>
      item.skinLabel && !item.name.includes(item.skinLabel)
        ? `「${item.name}」（${item.skinLabel}）`
        : `「${item.name}」`,
    )
    .join('、');
  const anyTainted = failed.some((item) => item.tainted);
  return anyTainted
    ? `${names}皮肤受限无法保存：请点「重取」或改用本地「上传皮肤」`
    : `${names}皮肤读取失败：请改用本地「上传皮肤」`;
}

/**
 * 重取的尝试次数、单次超时与总预算。
 *
 * 次数要大于一是有实测依据的：代理冷启动失败后浏览器会按 URL 记负缓存，
 * 隔一会儿换地址再打往往就通。只试一次的话「完成」会只保存一半，用户得再点一次。
 * 但也不能无限等：单次 4s、总共 12s，超了就按"这次没救回来"处理。
 */
const SKIN_RETRY_ATTEMPTS = 3;
const SKIN_RETRY_TIMEOUT_MS = 4000;
const SKIN_RETRY_BUDGET_MS = 12000;

/**
 * 用代理重取一遍被污染的素材。
 *
 * 代理抖动是这次失败最常见的成因：第 2 级失败后 loadImage 会掉到第 3 级非 CORS 兜底，
 * 于是同一张图"刚才还能显示、现在却提交不了"。重取比让用户删掉重加快得多。
 *
 * 必须重试多次而不是一次：代理失败会被浏览器按 URL 记进负缓存，一次没通就放弃的话，
 * 用户点「完成」只会保存一半，剩下的得再点一次 —— 那正是"要点两次完成"的由来。
 * loadImage 内部每次都会换一个一次性参数，所以重试打的是新地址，不会命中负缓存。
 * 返回成功换上干净图的张数；不改动画布布局，只换同一个 skinId 背后的位图。
 */
export async function retryTaintedSkins(load: typeof loadImage = loadImage): Promise<number> {
  const targets = Array.from(skins.values()).filter((skin) => skin.tainted && skin.sourceUrl);
  if (targets.length === 0) return 0;
  state.busy = '重取皮肤';
  let fixed = 0;
  const deadline = Date.now() + SKIN_RETRY_BUDGET_MS;
  try {
    for (const skin of targets) {
      for (let attempt = 0; attempt < SKIN_RETRY_ATTEMPTS && Date.now() < deadline; attempt += 1) {
        let loaded: LoadedImage | null = null;
        try {
          loaded = await load(skin.sourceUrl as string, {
            proxyTemplate: state.proxyTemplate,
            timeoutMs: SKIN_RETRY_TIMEOUT_MS,
          });
        } catch {
          loaded = null;
        }
        // 掉到第 3 级兜底时 loadImage 不报错，只是把 tainted 置真 —— 那不算成功，继续下一次
        if (!loaded || loaded.tainted) continue;
        // 同一个 id 原地换图：图层、历史记录、协同一律不受影响。
        // provider / 自定义图 / 正脸双层这些登记时的属性要原样带回去，否则素材会变样。
        const record = state.skins.find((item) => item.id === skin.id);
        headCache.evictSkin(skin.id);
        registerSkin(
          loaded,
          skin.origin,
          skin.sourceLabel,
          record?.provider ?? '',
          skin.id,
          false,
          skin.meta.isCustomImage === true,
          skin.meta.frontOnly,
        );
        fixed += 1;
        break;
      }
    }
  } finally {
    state.busy = null;
  }
  return fixed;
}

/** 发布 / 管理员全量提交：把当前画布整理成房间协议载荷 */
export function collectRoomPayload(): {
  baseFile: File | null;
  doc: { width: number; height: number };
  baseImage: { name: string; type: string; width: number; height: number } | null;
  layers: {
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
    skin: PresetSkin | null;
  }[];
  failedSkins: number;
  /**
   * 编码失败的头像。只给数量没法让用户动手 —— 得能点名是哪个、卡在什么地方。
   * skinLabel 取素材的来源描述（玩家名 / 文件名 / 角色名），对用户才是可辨认的。
   */
  failedSkinLayers: { id: string; name: string; skinLabel: string; tainted: boolean }[];
} {
  const baseFile = state.baseImageId ? baseFiles.get(state.baseImageId) ?? null : null;
  const baseImage = state.baseImage
    ? {
        name: state.baseImage.name,
        type: baseFile?.type ?? 'image/png',
        width: state.document.width,
        height: state.document.height,
      }
    : null;
  let failedSkins = 0;
  const failedSkinLayers: { id: string; name: string; skinLabel: string; tainted: boolean }[] = [];
  const layers = state.layers.map((layer, index) => {
    const skin = encodeLayerSkin(layer.id);
    if (!skin) {
      failedSkins += 1;
      const texture = getSkin(layer.skinId);
      failedSkinLayers.push({
        id: layer.id,
        name: layer.name,
        skinLabel: texture?.sourceLabel ?? '未载入的皮肤',
        tainted: texture?.tainted ?? false,
      });
    }
    return {
      id: layer.id,
      name: layer.name,
      x: layer.x,
      y: layer.y,
      size: layer.size,
      rotation: layer.rotation,
      opacity: layer.opacity,
      overlay: layer.overlay,
      flipH: layer.flipH,
      visible: layer.visible,
      order: index,
      skin,
    };
  });
  return { baseFile, doc: { ...state.document }, baseImage, layers, failedSkins, failedSkinLayers };
}

/* ------------------------------------------------------------------ *
 * 移动端抽屉 / 面板导航状态
 * ------------------------------------------------------------------ */

export type MobilePanel = 'none' | 'skin' | 'inspector';

export const mobilePanel = ref<MobilePanel>('none');

export function setMobilePanel(panel: MobilePanel): void {
  mobilePanel.value = panel;
}

export function toggleMobilePanel(panel: 'skin' | 'inspector'): void {
  mobilePanel.value = mobilePanel.value === panel ? 'none' : panel;
}

/* ------------------------------------------------------------------ *
 * 对外接口
 * ------------------------------------------------------------------ */

export const editor = state;
export { BUILTIN_SKINS, SkinLookupError, registerSkin };
export type { AvatarLayer };
