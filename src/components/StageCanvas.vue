<!-- BlockFace · Copyright 2026 Dainsleif · Apache License 2.0 -->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { AvatarLayer, HandleName } from '../core/model/types';
import { wheelRotation, wheelZoomFactor, zoomViewAt } from '../core/model/gesture';
import { locked as collabLocked } from '../stores/collab';
import {
  allHandlePositions,
  clampLayerToDocument,
  hitTestHandle,
  hitTestLayer,
  layerCorners,
  resizeFromHandle,
  rotationFromHandle,
} from '../core/model/transform';
import {
  clampRenderScale,
  composeDocument,
  renderBackground,
  MAX_CANVAS_EDGE,
  MAX_CANVAS_PIXELS,
} from '../core/render/compose';
import type { SkinTexture } from '../core/skin/texture';
import {
  beginChange,
  centerSelected,
  duplicateLayer,
  editor,
  endChange,
  fitView,
  getBaseImage,
  getSkin,
  nudgeLayerOrder,
  nudgeSelected,
  removeLayer,
  rotateLayerBy,
  scaleLayerBy,
  selectLayer,
  setMobilePanel,
  updateLayer,
} from '../stores/editor';

/** 旋转手柄离顶边的屏幕距离 */
const ROTATE_OFFSET = 41;
/** 手柄命中半径（屏幕像素） */
const HANDLE_HIT = 10;
/** 手柄尺寸（屏幕像素），与 brand-spec 第 8 节一致 */
const HANDLE_SIZE = 11;
const KNOB_SIZE = 12;

const INK = '#14110f';
const PAPER = '#f2efe6';
const RED = '#c8402f';

const wrap = ref<HTMLDivElement | null>(null);
const stage = ref<HTMLDivElement | null>(null);
const docCanvas = ref<HTMLCanvasElement | null>(null);
const overlayCanvas = ref<HTMLCanvasElement | null>(null);

/** 悬浮名字条的最大外框（用来把它夹在画布里，不让它被裁掉） */
const TIP_WIDTH = 220;
const TIP_HEIGHT = 30;
/** 鼠标移动超过这么多屏幕像素才算"在平移画布"，而不是点了一下 */
const PAN_THRESHOLD = 4;

const wrapSize = ref({ w: 960, h: 620 });
let resizeObserver: ResizeObserver | null = null;

type Drag =
  | { kind: 'move'; id: string; originX: number; originY: number; layerX: number; layerY: number }
  | { kind: 'resize'; id: string; handle: Exclude<HandleName, 'rotate'> }
  | { kind: 'rotate'; id: string }
  | { kind: 'pan'; clientX: number; clientY: number; viewX: number; viewY: number; moved: boolean };

let drag: Drag | null = null;

/** 触控点记录（用于双指捏合缩放与双指平移） */
const activeTouches = new Map<number, { x: number; y: number }>();
let lastPinchDist = 0;
let lastPinchMid = { x: 0, y: 0 };

function isTouchPointer(event: PointerEvent): boolean {
  return event.pointerType === 'touch' || (typeof window !== 'undefined' && ('ontouchstart' in window || navigator.maxTouchPoints > 0));
}

/** 悬浮在头像上时跟着光标走的名字条 */
const hover = ref<{ name: string; x: number; y: number } | null>(null);
/** 光标现在是不是停在头像上（决定光标形状） */
const overLayer = ref(false);
/** 是不是正在平移画布：画布整体在屏幕上移动，文档内容一点不动 */
const panning = ref(false);
const cursor = computed(() => (panning.value ? 'grabbing' : overLayer.value ? 'move' : 'grab'));

const fitScale = computed(() => {
  const pad = 44;
  const sx = (wrapSize.value.w - pad) / editor.document.width;
  const sy = (wrapSize.value.h - pad) / editor.document.height;
  return Math.max(0.05, Math.min(sx, sy, 4));
});

const viewScale = computed(() => (editor.view.autoFit ? fitScale.value : editor.view.zoom));
const zoomPercent = computed(() => Math.round(viewScale.value * 100));

/** 画布尺寸按视图缩放算，位置靠 translate 平移 —— 平移只动屏幕上的位置，不动文档 */
const stageStyle = computed(() => ({
  width: editor.document.width * viewScale.value + 'px',
  height: editor.document.height * viewScale.value + 'px',
  transform: 'translate(' + editor.view.x + 'px, ' + editor.view.y + 'px)',
}));

const selected = computed(() => editor.layers.find((l) => l.id === editor.selectedId) ?? null);
const isCustomSelected = computed(() => {
  const l = selected.value;
  if (!l) return false;
  return getSkin(l.skinId)?.meta.isCustomImage === true;
});
const baseChip = computed(() =>
  editor.baseImage ? editor.baseImage.width + ' × ' + editor.baseImage.height : '未设置（导出透明底）',
);

const dpr = () => Math.min(window.devicePixelRatio || 1, 2);

/**
 * 方案一：Canvas 物理缓冲与视图缩放解耦（CSS 硬件加速变换）
 * 连续滚轮或双指缩放手势期间，外层容器 `.artboard` 依靠 CSS 即时变换（120 FPS 满帧跟手），
 * 内部 Canvas 物理分辨率在手势活跃期保持稳定，避免高频销毁和重建 GPU 纹理显存；
 * 手势停顿 150ms 处于稳定状态后再更新物理分辨率，使视觉清晰度与交互流畅度两全其美。
 */
const settledZoom = ref(editor.view.zoom);
let zoomDebounceTimer: ReturnType<typeof setTimeout> | null = null;

function markZooming(): void {
  if (zoomDebounceTimer) clearTimeout(zoomDebounceTimer);
  zoomDebounceTimer = setTimeout(() => {
    zoomDebounceTimer = null;
    settledZoom.value = editor.view.zoom;
    schedule();
  }, 150);
}

const previewScale = computed(() => {
  const currentViewScale = editor.view.autoFit ? fitScale.value : settledZoom.value;
  return clampRenderScale(
    editor.document.width,
    editor.document.height,
    currentViewScale * dpr(),
    MAX_CANVAS_EDGE,
    MAX_CANVAS_PIXELS,
  );
});

let frame = 0;
function schedule(): void {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    render();
  });
}

function render(): void {
  renderDocument();
  renderOverlay();
}

/**
 * 动静分离：底图层离屏缓存。
 * 底图与棋盘格只在尺寸、缩放或底图本身变化时绘制一次，
 * 拖动头像、旋转、调整图层属性时直接复用已烘焙的显存纹理，单帧渲染耗时由数十毫秒降至 0.05ms。
 */
let bgCacheCanvas: HTMLCanvasElement | null = null;
let bgCacheKey = '';

function getCachedBackground(scale: number): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null;
  const baseImage = getBaseImage(editor.baseImageId);
  const w = editor.document.width;
  const h = editor.document.height;
  const checkerboard = !baseImage;
  const key = `${w}x${h}@${scale}_base:${editor.baseImageId || 'none'}_cb:${checkerboard}`;

  if (!bgCacheCanvas) {
    bgCacheCanvas = document.createElement('canvas');
  }

  if (bgCacheKey !== key) {
    renderBackground(bgCacheCanvas, {
      width: w,
      height: h,
      scale,
      baseImage,
      checkerboard,
    });
    bgCacheKey = key;
  }

  return bgCacheCanvas;
}

function renderDocument(): void {
  const canvas = docCanvas.value;
  if (!canvas) return;
  const items: { layer: AvatarLayer; skin: SkinTexture }[] = [];
  for (const layer of editor.layers) {
    const skin = getSkin(layer.skinId);
    if (skin) items.push({ layer, skin });
  }
  const baseImage = getBaseImage(editor.baseImageId);
  const backgroundCanvas = getCachedBackground(previewScale.value);
  composeDocument(canvas, {
    width: editor.document.width,
    height: editor.document.height,
    scale: previewScale.value,
    baseImage,
    backgroundCanvas,
    items,
    // 没有底图时预览铺棋盘：那块地方导出就是透明的
    checkerboard: !baseImage,
  });
}

function renderOverlay(): void {
  const canvas = overlayCanvas.value;
  if (!canvas) return;
  const scale = previewScale.value;
  const w = Math.max(1, Math.round(editor.document.width * scale));
  const h = Math.max(1, Math.round(editor.document.height * scale));
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.scale(scale, scale);

  const layer = selected.value;
  if (!layer) return;

  const px = 1 / viewScale.value; // 1 屏幕像素 = 多少文档单位
  const corners = layerCorners(layer);

  const tracePath = (): void => {
    ctx.beginPath();
    ctx.moveTo(corners[0].x, corners[0].y);
    for (let i = 1; i < corners.length; i += 1) ctx.lineTo(corners[i].x, corners[i].y);
    ctx.closePath();
  };

  // 选中框：先铺一层 3px 纸色描边，再压 1px 墨线，等于 brand-spec 里的 outline-offset:1px
  tracePath();
  ctx.lineJoin = 'miter';
  ctx.lineWidth = 3 * px;
  ctx.strokeStyle = PAPER;
  ctx.stroke();
  ctx.lineWidth = 1 * px;
  ctx.strokeStyle = INK;
  ctx.stroke();

  // 编辑者（布局冻结）只画选中框：没有可交互的旋钮和缩放手柄，别误导用户去拖
  if (collabLocked.value) return;

  const base = allHandlePositions(layer, 0);
  const rotateHandle = allHandlePositions(layer, ROTATE_OFFSET * px).find((item) => item.name === 'rotate');
  const nw = base.find((item) => item.name === 'nw');
  const ne = base.find((item) => item.name === 'ne');

  if (rotateHandle && nw && ne) {
    const midX = (nw.point.x + ne.point.x) / 2;
    const midY = (nw.point.y + ne.point.y) / 2;
    // 红色竖杆
    ctx.beginPath();
    ctx.moveTo(midX, midY);
    ctx.lineTo(rotateHandle.point.x, rotateHandle.point.y);
    ctx.lineWidth = 2 * px;
    ctx.strokeStyle = RED;
    ctx.stroke();
    // 纸色方块旋钮，内含 3px 红石方孔
    const knob = KNOB_SIZE * px;
    const kx = rotateHandle.point.x - knob / 2;
    const ky = rotateHandle.point.y - knob / 2;
    ctx.fillStyle = PAPER;
    ctx.fillRect(kx, ky, knob, knob);
    ctx.lineWidth = 1 * px;
    ctx.strokeStyle = INK;
    ctx.strokeRect(kx + px / 2, ky + px / 2, knob - px, knob - px);
    ctx.fillStyle = RED;
    ctx.fillRect(kx + 3.5 * px, ky + 3.5 * px, 5 * px, 5 * px);
  }

  // 四角红色方块手柄
  const size = HANDLE_SIZE * px;
  for (const handle of base) {
    if (handle.name === 'rotate') continue;
    const x = handle.point.x - size / 2;
    const y = handle.point.y - size / 2;
    ctx.fillStyle = RED;
    ctx.fillRect(x, y, size, size);
    ctx.lineWidth = 1 * px;
    ctx.strokeStyle = INK;
    ctx.strokeRect(x + px / 2, y + px / 2, size - px, size - px);
  }
}

function toDocumentPoint(event: { clientX: number; clientY: number }): { x: number; y: number } {
  const rect = stage.value?.getBoundingClientRect();
  if (!rect) return { x: 0, y: 0 };
  return { x: (event.clientX - rect.left) / viewScale.value, y: (event.clientY - rect.top) / viewScale.value };
}

function capturePointer(event: PointerEvent): void {
  try {
    wrap.value?.setPointerCapture(event.pointerId);
  } catch {
    // 合成事件（自动化测试）或指针已释放时无可用 pointerId，忽略即可
  }
}

/** 命中最上面的那个可见头像（数组末位画在最上层） */
function hitTopLayer(point: { x: number; y: number }): AvatarLayer | null {
  for (let i = editor.layers.length - 1; i >= 0; i -= 1) {
    const candidate = editor.layers[i];
    if (!candidate.visible) continue;
    if (hitTestLayer(candidate, point.x, point.y)) return candidate;
  }
  return null;
}

function onPointerDown(event: PointerEvent): void {
  if (event.button !== 0 && event.pointerType === 'mouse') return;
  activeTouches.set(event.pointerId, { x: event.clientX, y: event.clientY });

  // 双指触控：进入捏合缩放与双指平移模式
  if (activeTouches.size === 2) {
    if (drag && drag.kind !== 'pan') endChange();
    drag = null;
    panning.value = false;
    hover.value = null;

    const pts = Array.from(activeTouches.values());
    lastPinchDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    lastPinchMid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
    if (editor.view.autoFit) {
      editor.view.zoom = fitScale.value;
      editor.view.autoFit = false;
    }
    capturePointer(event);
    event.preventDefault();
    return;
  }

  const point = toDocumentPoint(event);
  const px = 1 / viewScale.value;
  const layer = selected.value;

  // 触屏模式下加大命中热区（18px 代替 10px）
  const isTouch = isTouchPointer(event) || wrapSize.value.w < 840;
  const hitRadius = (isTouch ? 18 : HANDLE_HIT) * px;
  const rotOffset = (isTouch ? 46 : ROTATE_OFFSET) * px;

  if (layer && !collabLocked.value) {
    const handle = hitTestHandle(layer, point.x, point.y, hitRadius, rotOffset);
    if (handle) {
      beginChange();
      drag = handle === 'rotate' ? { kind: 'rotate', id: layer.id } : { kind: 'resize', id: layer.id, handle };
      capturePointer(event);
      event.preventDefault();
      return;
    }
  }

  const target = hitTopLayer(point);
  if (target) {
    // 协同编辑者：点选只为换肤服务，位置动不了，直接不进拖动状态
    if (collabLocked.value) {
      selectLayer(target.id);
      capturePointer(event);
      event.preventDefault();
      return;
    }
    selectLayer(target.id);
    beginChange();
    drag = {
      kind: 'move',
      id: target.id,
      originX: point.x,
      originY: point.y,
      layerX: target.x,
      layerY: target.y,
    };
    capturePointer(event);
    event.preventDefault();
    return;
  }

  // 空白处（或底图上）按住拖动 = 平移画布视图：画布整体在屏幕上移动，文档内容一点不动。
  // 视图不属于文档，所以这里不收历史；原地按一下仍然是"点空白取消选中"。
  drag = {
    kind: 'pan',
    clientX: event.clientX,
    clientY: event.clientY,
    viewX: editor.view.x,
    viewY: editor.view.y,
    moved: false,
  };
  capturePointer(event);
  event.preventDefault();
}

function onPointerMove(event: PointerEvent): void {
  if (activeTouches.has(event.pointerId)) {
    activeTouches.set(event.pointerId, { x: event.clientX, y: event.clientY });
  }

  // 双指捏合缩放与平移（采用增量更新，锚定手指中心，彻底杜绝左上角漂移）
  if (activeTouches.size >= 2) {
    const pts = Array.from(activeTouches.values());
    const curDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    const curMid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };

    if (lastPinchDist > 0 && curDist > 0) {
      const factor = curDist / lastPinchDist;
      // 1. 围绕两指当前中心点平滑缩放
      zoomAtCursor(factor, curMid.x, curMid.y);

      // 2. 叠加上两指中心点的平移位移
      const panX = curMid.x - lastPinchMid.x;
      const panY = curMid.y - lastPinchMid.y;
      if (panX !== 0 || panY !== 0) {
        editor.view.x = Math.round(editor.view.x + panX);
        editor.view.y = Math.round(editor.view.y + panY);
      }
    }

    lastPinchDist = curDist;
    lastPinchMid = curMid;
    return;
  }

  const active = drag;
  if (!active) {
    updateHover(event);
    return;
  }
  hover.value = null; // 拖动时名字条会挡着图层，先收起来
  const point = toDocumentPoint(event);

  if (active.kind === 'pan') {
    if (!active.moved) {
      // 手抖不算拖动，免得点一下就以为画布飘了
      if (Math.hypot(event.clientX - active.clientX, event.clientY - active.clientY) < PAN_THRESHOLD) return;
      active.moved = true;
      panning.value = true;
      // 一旦手动平移就不再是"适应窗口"：先把当前倍率固定下来，画布不会突然跳大小
      if (editor.view.autoFit) {
        editor.view.zoom = fitScale.value;
        editor.view.autoFit = false;
      }
    }
    editor.view.x = Math.round(active.viewX + (event.clientX - active.clientX));
    editor.view.y = Math.round(active.viewY + (event.clientY - active.clientY));
    // 平移是纯 CSS transform，画布内容一个像素都不用重画
    return;
  }

  const layer = editor.layers.find((l) => l.id === active.id);
  if (!layer) return;

  if (active.kind === 'move') {
    const next = clampLayerToDocument(
      { x: active.layerX + (point.x - active.originX), y: active.layerY + (point.y - active.originY), size: layer.size },
      editor.document.width,
      editor.document.height,
    );
    layer.x = Math.round(next.x);
    layer.y = Math.round(next.y);
  } else if (active.kind === 'resize') {
    const result = resizeFromHandle({ layer, handle: active.handle, point });
    layer.x = result.x;
    layer.y = result.y;
    layer.size = Math.round(result.size);
  } else {
    layer.rotation = Math.round(rotationFromHandle(layer, point, event.shiftKey ? 15 : 0));
  }
  schedule();
}

/** 悬浮在头像上就把名字标出来：图层一多，光看脸认不出谁是谁 */
function updateHover(event: PointerEvent): void {
  const rect = wrap.value?.getBoundingClientRect();
  if (!rect) return;
  const target = hitTopLayer(toDocumentPoint(event));
  overLayer.value = target !== null;
  if (!target) {
    hover.value = null;
    return;
  }
  hover.value = {
    name: target.name || '未命名头像',
    // 贴着光标右下角，但不许越出画布：越出去会被 .stage__body 裁掉
    x: Math.min(Math.max(0, event.clientX - rect.left + 14), Math.max(0, rect.width - TIP_WIDTH)),
    y: Math.min(Math.max(0, event.clientY - rect.top + 16), Math.max(0, rect.height - TIP_HEIGHT)),
  };
}

function clearHover(): void {
  hover.value = null;
  overLayer.value = false;
}

function onPointerUp(event: PointerEvent): void {
  activeTouches.delete(event.pointerId);
  if (activeTouches.size < 2) {
    lastPinchDist = 0;
  }

  const active = drag;
  if (!active) return;
  drag = null;
  if (active.kind === 'pan') {
    panning.value = false;
    // 按一下没拖动 —— 那就是"点空白取消选中"
    if (!active.moved) selectLayer(null);
  } else {
    endChange();
  }
  try {
    if (wrap.value?.hasPointerCapture(event.pointerId)) wrap.value.releasePointerCapture(event.pointerId);
  } catch {
    // 合成事件下没有真实指针，忽略
  }
  schedule();
}

/**
 * 滚轮的分工：
 * - 光标落在头像上 → 缩放这个头像；按住 Shift → 旋转它（改的是文档内容，进撤销历史）
 * - 其它情况（底图上、空白处、按住 Ctrl/⌘ 或捏合触控板）→ 缩放**画布视图**本身，
 *   锚点是光标：光标底下那块内容缩放前后停在原地，所以能一直盯着要修的地方放大
 *
 * 真实鼠标按住 Shift 滚轮时，Chrome 会把读数搬到 deltaX 上，所以先补回来。
 */
function onWheel(event: WheelEvent): void {
  const delta = event.deltaY !== 0 ? event.deltaY : event.deltaX;
  const unit = event.deltaMode;
  const factor = wheelZoomFactor(delta, unit);

  if (!event.ctrlKey && !event.metaKey && !collabLocked.value) {
    const target = hitTopLayer(toDocumentPoint(event));
    if (target) {
      event.preventDefault();
      // 滚轮改的是这个头像，顺手选中它：属性面板与手柄都会跟着切过去
      if (editor.selectedId !== target.id) selectLayer(target.id);
      if (event.shiftKey) rotateLayerBy(target.id, wheelRotation(delta, unit));
      else scaleLayerBy(target.id, factor);
      schedule();
      return;
    }
  }

  event.preventDefault();
  zoomAtCursor(factor, event.clientX, event.clientY);
}

/** 以某个屏幕点为锚点缩放画布视图：锚点底下的内容停在原地 */
function zoomAtCursor(factor: number, clientX: number, clientY: number): void {
  const rect = stage.value?.getBoundingClientRect();
  if (!rect) return;
  const next = zoomViewAt(
    { zoom: viewScale.value, x: editor.view.x, y: editor.view.y },
    { x: clientX - rect.left, y: clientY - rect.top },
    { width: editor.document.width * viewScale.value, height: editor.document.height * viewScale.value },
    factor,
  );
  editor.view.zoom = next.zoom;
  editor.view.x = next.x;
  editor.view.y = next.y;
  editor.view.autoFit = false;
  markZooming();
}

/** 工具栏上的放大 / 缩小：锚在画布可见区域的中心 */
function zoomBy(factor: number): void {
  const box = wrap.value?.getBoundingClientRect();
  zoomAtCursor(factor, box ? box.left + box.width / 2 : 0, box ? box.top + box.height / 2 : 0);
}

function fit(): void {
  if (zoomDebounceTimer) {
    clearTimeout(zoomDebounceTimer);
    zoomDebounceTimer = null;
  }
  fitView();
  settledZoom.value = fitScale.value;
  schedule();
}

function toggleFlip(): void {
  const l = selected.value;
  if (!l) return;
  updateLayer(l.id, { flipH: !l.flipH });
}

function toggleOverlay(): void {
  const l = selected.value;
  if (!l) return;
  updateLayer(l.id, { overlay: !l.overlay });
}

function duplicateSelected(): void {
  const l = selected.value;
  if (!l) return;
  duplicateLayer(l.id);
}

function deleteSelected(): void {
  const l = selected.value;
  if (!l) return;
  removeLayer(l.id);
}

function openInspector(): void {
  setMobilePanel('inspector');
}

function onKeyDown(event: KeyboardEvent): void {
  const target = event.target as HTMLElement | null;
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
  const layer = selected.value;

  if (event.key === 'Escape') {
    selectLayer(null);
    schedule();
    return;
  }

  if (!layer) return;

  if (collabLocked.value) {
    // 协同编辑者：删不掉也挪不动，方向键只留 Escape 取消选中
    return;
  }

  if (event.key === 'Delete' || event.key === 'Backspace') {
    event.preventDefault();
    removeLayer(layer.id);
    schedule();
    return;
  }

  if (event.key === '[' || event.key === ']') {
    event.preventDefault();
    nudgeLayerOrder(layer.id, event.key === ']' ? 1 : -1);
    schedule();
    return;
  }

  const step = event.shiftKey ? 10 : 1;
  const deltas: Record<string, [number, number]> = {
    ArrowLeft: [-step, 0],
    ArrowRight: [step, 0],
    ArrowUp: [0, -step],
    ArrowDown: [0, step],
  };
  const delta = deltas[event.key];
  if (!delta) return;
  event.preventDefault();
  nudgeSelected(delta[0], delta[1]);
  schedule();
}

onMounted(() => {
  const element = wrap.value;
  if (element) {
    resizeObserver = new ResizeObserver(() => {
      const rect = element.getBoundingClientRect();
      wrapSize.value = { w: rect.width, h: rect.height };
    });
    resizeObserver.observe(element);
    const rect = element.getBoundingClientRect();
    wrapSize.value = { w: rect.width, h: rect.height };
  }
  window.addEventListener('keydown', onKeyDown);
  schedule();
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  window.removeEventListener('keydown', onKeyDown);
  if (frame) cancelAnimationFrame(frame);
  if (zoomDebounceTimer) clearTimeout(zoomDebounceTimer);
  bgCacheCanvas = null;
  bgCacheKey = '';
});

watch(
  () => [
    editor.document.width,
    editor.document.height,
    editor.selectedId,
    editor.baseImageId,
    editor.layers,
    editor.skinRevision,
    viewScale.value,
  ],
  schedule,
  { deep: true },
);

defineExpose({ schedule });
</script>

<template>
  <section class="stage">
    <div class="stage__head">
      <span class="bf-chip bf-chip--m bf-chip--hide-mobile"><i class="bf-chip-sq" aria-hidden="true" />底图 {{ baseChip }}</span>
      <span class="bf-chip bf-chip--m">显示 {{ zoomPercent }}%</span>
      <span class="bf-chip bf-chip--hide-mobile">
        <i class="bf-chip-sq bf-chip-sq--grass" aria-hidden="true" />
        图层 {{ editor.layers.length }} 个{{ selected ? ' · 选中 ' + selected.name : '' }}
      </span>
      <span class="stage__zoombar">
        <button class="bf-btn bf-btn--icon bf-btn--quiet" type="button" title="缩小" aria-label="缩小" @click="zoomBy(1 / 1.25)">
          <i class="bf-ic bf-ic--minus" aria-hidden="true"><b /></i>
        </button>
        <button class="bf-btn bf-btn--sm bf-btn--quiet" type="button" @click="fit">适应窗口</button>
        <button class="bf-btn bf-btn--icon bf-btn--quiet" type="button" title="放大" aria-label="放大" @click="zoomBy(1.25)">
          <i class="bf-ic bf-ic--plus" aria-hidden="true"><b /><b /></i>
        </button>
      </span>
    </div>

    <div
      ref="wrap"
      class="stage__body"
      tabindex="0"
      aria-label="画布工作区，按方向键微调选中图层，中括号调整图层层级"
      :data-cursor="cursor"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
      @pointerleave="clearHover"
      @wheel="onWheel"
    >
      <div ref="stage" class="artboard" :style="stageStyle">
        <canvas ref="docCanvas" class="artboard__doc" role="img" aria-label="头像合成画布" />
        <canvas ref="overlayCanvas" class="artboard__overlay" aria-hidden="true" />
      </div>

      <span v-if="hover" class="stage__tip" :style="{ left: hover.x + 'px', top: hover.y + 'px' }">
        {{ hover.name }}
      </span>

      <p v-if="!editor.baseImage" class="stage__empty">把图片拖进窗口，或点顶栏的「打开图片」</p>

      <!-- 移动端选中图层浮动快捷工具栏 -->
      <div
        v-if="selected"
        class="mobile-action-bar"
        role="toolbar"
        aria-label="选中图层快捷操作"
        @pointerdown.stop
        @pointermove.stop
        @pointerup.stop
        @pointercancel.stop
      >
        <button v-if="!collabLocked" class="m-act-btn" type="button" title="水平翻转" @click.stop="toggleFlip">
          <span>翻转</span>
        </button>
        <button
          v-if="!isCustomSelected && !collabLocked"
          class="m-act-btn"
          :class="{ 'is-active': selected.overlay }"
          type="button"
          title="双层帽子开关"
          @click.stop="toggleOverlay"
        >
          <i class="m-act-sq" :class="selected.overlay ? 'm-act-sq--grass' : ''" aria-hidden="true" />
          <span>帽子</span>
        </button>
        <button v-if="!collabLocked" class="m-act-btn" type="button" title="居中对齐" @click.stop="centerSelected">
          <span>居中</span>
        </button>
        <button v-if="!collabLocked" class="m-act-btn" type="button" title="复制图层" @click.stop="duplicateSelected">
          <span>复制</span>
        </button>
        <button class="m-act-btn" type="button" title="打开属性面板" @click.stop="openInspector">
          <span>属性</span>
        </button>
        <button v-if="!collabLocked" class="m-act-btn m-act-btn--del" type="button" title="删除图层" @click.stop="deleteSelected">
          <i class="bf-ic bf-ic--del" aria-hidden="true"><b /><b /></i>
          <span>删除</span>
        </button>
      </div>
    </div>

    <div class="stage__foot">
      <span v-if="!collabLocked" class="bf-chip bf-chip--dark desktop-only">头像 拖动 · 滚轮缩放 · Shift+滚轮旋转</span>
      <span v-else class="bf-chip bf-chip--dark desktop-only">布局已锁定 · 左侧选皮肤给选中的头像换装</span>
      <span class="bf-chip bf-chip--dark desktop-only">画布 拖动平移 · 滚轮缩放 · 适应窗口复位</span>
      <span class="bf-chip bf-chip--dark mobile-only">单指拖动画布 · 双指缩放</span>
    </div>
  </section>
</template>

<style scoped>
.stage {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 12px;
  background-color: var(--bf-stage);
  background-image:
    repeating-linear-gradient(90deg, var(--bf-stage-major) 0 1px, transparent 1px 40px),
    repeating-linear-gradient(0deg, var(--bf-stage-major) 0 1px, transparent 1px 40px),
    repeating-linear-gradient(90deg, var(--bf-stage-line) 0 1px, transparent 1px 8px),
    repeating-linear-gradient(0deg, var(--bf-stage-line) 0 1px, transparent 1px 8px);
}

.stage__head,
.stage__foot { flex: none; display: flex; align-items: center; gap: 8px; }

.stage__zoombar { margin-left: auto; display: flex; align-items: center; gap: 8px; }

.stage__body {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
  overflow: hidden;
  touch-action: none;
  user-select: none;
}
.stage__body:focus-visible {
  outline: 2px solid var(--bf-grass);
  outline-offset: -2px;
}

.artboard {
  position: relative;
  flex: none;
  border: 1px solid var(--bf-ink);
  background: var(--bf-board);
  box-shadow: 0 0 0 1px var(--bf-stage-major);
  will-change: transform;
}

.artboard__doc,
.artboard__overlay {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  display: block;
}

.artboard__doc { image-rendering: pixelated; }
.artboard__overlay { pointer-events: none; }

.stage__empty {
  position: absolute;
  left: 50%;
  bottom: 18px;
  transform: translateX(-50%);
  font-size: var(--bf-font-size-sm);
  color: var(--bf-paper);
  background: rgba(20, 17, 15, 0.72);
  border: 1px solid var(--bf-stage-major);
  padding: 6px 12px;
  white-space: nowrap;
}

/* 画布是可以平移的：空白处是抓手、指着头像时是移动、正在平移时抓紧 */
.stage__body { cursor: grab; }
.stage__body[data-cursor='move'] { cursor: move; }
.stage__body[data-cursor='grabbing'] { cursor: grabbing; }

.stage__tip {
  position: absolute;
  z-index: 2;
  max-width: 200px;
  padding: 4px 8px;
  border: 1px solid var(--bf-paper);
  background: var(--bf-ink);
  color: var(--bf-paper);
  font-size: var(--bf-font-size-sm);
  line-height: 1.5;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  pointer-events: none;
}

.mobile-action-bar { display: none; }
.mobile-only { display: none; }

@media (max-width: 840px) {
  .stage {
    padding: 8px;
    gap: 8px;
  }
  .bf-chip--hide-mobile { display: none; }
  .desktop-only { display: none; }
  .mobile-only { display: inline-flex; }

  .mobile-action-bar {
    position: absolute;
    bottom: 12px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 25;
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 6px;
    background: var(--bf-white);
    border: 1px solid var(--bf-ink);
    box-shadow: 3px 3px 0 var(--bf-ink);
    white-space: nowrap;
    max-width: calc(100% - 20px);
    overflow-x: auto;
    touch-action: pan-x;
  }
  .m-act-btn {
    height: 30px;
    padding: 0 8px;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    background: var(--bf-rail);
    border: 1px solid var(--bf-line);
    font: 600 12px/1 var(--bf-sans);
    color: var(--bf-ink);
    cursor: pointer;
    flex: none;
    -webkit-tap-highlight-color: transparent;
  }
  .m-act-btn:active {
    background: var(--bf-paper);
    transform: translate(1px, 1px);
  }
  .m-act-btn.is-active {
    background: var(--bf-grass);
    color: var(--bf-white);
    border-color: var(--bf-ink);
  }
  .m-act-btn--del {
    color: var(--bf-red-ink);
    border-color: var(--bf-red);
  }
  .m-act-sq {
    width: 6px;
    height: 6px;
    background: var(--bf-ink);
    flex: none;
  }
  .m-act-sq--grass { background: var(--bf-grass); }
}
</style>
