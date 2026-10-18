<!-- BlockFace · Copyright 2026 Dainsleif · Apache License 2.0 -->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { AvatarLayer, HandleName } from '../core/model/types';
import { wheelRotation, wheelZoomFactor, zoomViewAt } from '../core/model/gesture';
import { appearanceLocked, collab, locked as collabLocked } from '../stores/collab';
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
  setViewportSize,
  updateAppearance,
} from '../stores/editor';

/** 旋转手柄离顶边的屏幕距离 */
const ROTATE_OFFSET = 41;
/** 手柄命中半径（屏幕像素） */
const HANDLE_HIT = 10;
/** 手柄尺寸（屏幕像素），与 brand-spec §5 一致 */
const HANDLE_SIZE = 11;
const KNOB_SIZE = 12;
/** 头像在屏幕上的显示尺寸小于这个值，手柄就按比例微缩，免得四个角柄挤成一坨 */
const MINI_LAYER_SIZE = 28;

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

/**
 * 非管理员拿到的底图是服务器发的**预览版**（长边上限由后端 BF_BASE_PREVIEW_MAX_EDGE 决定）。
 * 这不只是"看着糊一点"：导出与复制走的是同一张贴图，出图也是这个清晰度。
 * 状态栏那行小字没人会注意，出图之后才发现细节糊了才是真难受 —— 所以画布正上方挂一条常驻横条。
 */
const basePreview = computed(() => collab.basePreview);

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

let overlayFrame = 0;
/**
 * 只重画交互手柄：手柄活在视口屏幕坐标里，平移画布或改窗口大小时它必须跟着动，
 * 而文档画布一个像素都不用重画 —— 平移不掉帧就靠这条线守住。
 */
function scheduleOverlay(): void {
  if (overlayFrame) return;
  overlayFrame = requestAnimationFrame(() => {
    overlayFrame = 0;
    renderOverlay();
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

  const d = dpr();
  const vw = wrapSize.value.w;
  const vh = wrapSize.value.h;
  const bw = Math.max(1, Math.round(vw * d));
  const bh = Math.max(1, Math.round(vh * d));

  // 物理分辨率紧贴工作区视口（与文档尺寸、缩放倍率都无关）：缩放和平移期间不重新分配显存
  if (canvas.width !== bw) canvas.width = bw;
  if (canvas.height !== bh) canvas.height = bh;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  // 手柄按 DPR 物理像素绘制，整数 DPR 下边缘不会糊成灰边
  ctx.setTransform(d, 0, 0, d, 0, 0);
  ctx.clearRect(0, 0, vw, vh);

  const layer = selected.value;
  if (!layer) return;

  const scale = viewScale.value;
  const artboardCenterX = vw / 2 + editor.view.x;
  const artboardCenterY = vh / 2 + editor.view.y;
  const docCenterX = editor.document.width / 2;
  const docCenterY = editor.document.height / 2;

  /** 文档逻辑坐标 → 工作区屏幕坐标（画板由 flex 居中，它的中心就是视口中心 + 平移量） */
  const toScreen = (pt: { x: number; y: number }): { x: number; y: number } => ({
    x: artboardCenterX + (pt.x - docCenterX) * scale,
    y: artboardCenterY + (pt.y - docCenterY) * scale,
  });

  /** 方块手柄：底色 + 1px 墨线细边；hole > 0 时中心再嵌一个方孔（旋转旋钮的红石孔） */
  const drawSquare = (centerX: number, centerY: number, size: number, fill: string, hole = 0): void => {
    const x = Math.round(centerX - size / 2);
    const y = Math.round(centerY - size / 2);
    ctx.fillStyle = fill;
    ctx.fillRect(x, y, size, size);
    ctx.lineWidth = 1;
    ctx.strokeStyle = INK;
    // 1px 墨线落在 +0.5 上才是一像素实线，否则会糊成两像素灰边
    ctx.strokeRect(x + 0.5, y + 0.5, size - 1, size - 1);
    if (hole > 0) {
      const inset = Math.round((size - hole) / 2);
      ctx.fillStyle = RED;
      ctx.fillRect(x + inset, y + inset, hole, hole);
    }
  };

  const corners = layerCorners(layer).map(toScreen);

  const tracePath = (): void => {
    ctx.beginPath();
    ctx.moveTo(corners[0].x, corners[0].y);
    for (let i = 1; i < corners.length; i += 1) ctx.lineTo(corners[i].x, corners[i].y);
    ctx.closePath();
  };

  // 选中框：先铺一层 3px 纸色描边，再压 1px 墨线（brand-spec §5 的「选中外框」）
  tracePath();
  ctx.lineJoin = 'miter';
  ctx.lineWidth = 3;
  ctx.strokeStyle = PAPER;
  ctx.stroke();
  ctx.lineWidth = 1;
  ctx.strokeStyle = INK;
  ctx.stroke();

  // 编辑者（布局冻结）只画选中框：没有可交互的旋钮和缩放手柄，别误导用户去拖
  if (collabLocked.value) return;

  // 头像在屏幕上缩得很小时手柄按比例微缩，避免四个角柄互相覆盖遮挡
  const mini = layer.size * scale < MINI_LAYER_SIZE;
  const handleSize = mini ? Math.max(6, Math.round(layer.size * scale * 0.38)) : HANDLE_SIZE;
  const knobSize = mini ? Math.max(7, Math.round(handleSize * (KNOB_SIZE / HANDLE_SIZE))) : KNOB_SIZE;

  // 一次算齐所有手柄（含旋转旋钮）：四角的位置与 rotateOffset 无关，找得到就够了
  const handles = allHandlePositions(layer, ROTATE_OFFSET / scale);
  const rotate = handles.find((item) => item.name === 'rotate');
  const nw = handles.find((item) => item.name === 'nw');
  const ne = handles.find((item) => item.name === 'ne');

  if (rotate && nw && ne) {
    const rot = toScreen(rotate.point);
    const cornerA = toScreen(nw.point);
    const cornerB = toScreen(ne.point);
    const midX = (cornerA.x + cornerB.x) / 2;
    const midY = (cornerA.y + cornerB.y) / 2;

    // 红色竖杆
    ctx.beginPath();
    ctx.moveTo(midX, midY);
    ctx.lineTo(rot.x, rot.y);
    ctx.lineWidth = 2;
    ctx.strokeStyle = RED;
    ctx.stroke();

    // 纸色方块旋钮，中心内嵌红石方孔
    drawSquare(rot.x, rot.y, knobSize, PAPER, Math.max(3, Math.round(knobSize * 0.42)));
  }

  // 四角红色方块手柄
  for (const handle of handles) {
    if (handle.name === 'rotate') continue;
    const pt = toScreen(handle.point);
    drawSquare(pt.x, pt.y, handleSize, RED);
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
    // 平移只动画板的 CSS transform，文档一个像素都不用重画；
    // 手柄画在视口坐标系里，靠下面那条 watch(editor.view) 单独跟画
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
  updateAppearance(l.id, { flipH: !l.flipH });
}

function toggleOverlay(): void {
  const l = selected.value;
  if (!l) return;
  updateAppearance(l.id, { overlay: !l.overlay });
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
      setViewportSize(rect.width, rect.height);
    });
    resizeObserver.observe(element);
    const rect = element.getBoundingClientRect();
    wrapSize.value = { w: rect.width, h: rect.height };
    setViewportSize(rect.width, rect.height);
  }
  window.addEventListener('keydown', onKeyDown);
  schedule();
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  window.removeEventListener('keydown', onKeyDown);
  if (frame) cancelAnimationFrame(frame);
  if (overlayFrame) cancelAnimationFrame(overlayFrame);
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

// 视口平移量与工作区尺寸只影响手柄所在的屏幕坐标系：单独重画 overlay，文档画布不重画
watch(() => [editor.view.x, editor.view.y, wrapSize.value.w, wrapSize.value.h], scheduleOverlay);

defineExpose({ schedule });
</script>

<template>
  <section class="stage">
    <div class="stage__head">
      <span class="bf-chip bf-chip--m bf-chip--hide-mobile"><i class="bf-chip-sq" aria-hidden="true" />底图 {{ baseChip }}</span>
      <span
        v-if="basePreview"
        class="bf-chip bf-chip--gold"
        role="status"
        title="当前为预览图，原图请找管理员导出"
      >
        <i class="bf-chip-sq" aria-hidden="true" />
        <b>预览图</b>
      </span>
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
      </div>

      <canvas ref="overlayCanvas" class="stage__overlay" aria-hidden="true" />

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
        <button v-if="!appearanceLocked" class="m-act-btn" type="button" title="水平翻转" @click.stop="toggleFlip">
          <span>翻转</span>
        </button>
        <button
          v-if="!isCustomSelected && !appearanceLocked"
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
      <!-- 布局锁与外观锁是两回事：这台服务器认不认识外观域决定后半句该不该写，
           写了会让用户去找上面根本没显示出来的两个按钮 -->
      <span v-else class="bf-chip bf-chip--dark desktop-only">{{
        appearanceLocked
          ? '布局已锁定 · 可换内容，位置与数量由发起者固定'
          : '布局已锁定 · 可换内容 / 切帽子层 / 水平翻转，位置与数量由发起者固定'
      }}</span>
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

.artboard__doc {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  display: block;
  image-rendering: pixelated;
}

.stage__overlay {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  display: block;
  pointer-events: none;
}

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