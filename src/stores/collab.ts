/*!
 * BlockFace+ · 协同房间状态中枢
 * Copyright 2026 Dainsleif · Apache License 2.0
 *
 * 三种入口，一套画布：
 *  - 离线（无 ?room=）：就是原来的 BlockFace，"共同编辑"把当前画布发布成房间；
 *  - 编辑者（URL + 编辑密码）：布局冻结，只能换头像内容；
 *  - 管理员（URL + 管理员密码）：任意修改，另可删除房间。
 *
 * 提交一律是差量：拿进房时的基线和当前画布比，只把真的变了的行与字段发出去。
 * 换底图、换头像内容、保存布局在服务端是三张互不相干的表，在前端也是三份互不相干的改动。
 *
 * 与 editor.ts 的耦合走钩子（setCollabHooks），避免模块循环依赖。
 */

import { computed, reactive, shallowRef } from 'vue';
import { deleteBaseEntry, readBaseEntry, writeBaseEntry } from '../core/collab/baseCache';
import { CollabApiError, MAX_BASE_IMAGE_BYTES, chunkBySize, collabApi, formatBytes, fullSubmitTooLarge, mergePatchResults } from '../core/collab/api';
import {
  advanceBaseline,
  buildRoomPatch,
  countPending,
  patchIsEmpty,
  type LayerBaseline,
  type LayerState,
  type RoomPatch,
} from '../core/collab/diff';
import * as session from '../core/collab/session';
import type { PatchItemResult, PatchPayload, RoomAvatarRecord, RoomBaseImage, RoomDoc, RoomInfo, RoomRole } from '../core/collab/types';
import {
  collectRoomPayload,
  encodeLayerSkin,
  loadRoomDocument,
  notify,
  setCollabHooks,
  editor,
} from './editor';

export type CollabPhase = 'boot' | 'gate' | 'loading' | 'ready' | 'gone' | 'error';

interface CollabState {
  mode: 'offline' | 'room';
  phase: CollabPhase;
  roomId: string | null;
  role: RoomRole | null;
  room: RoomInfo | null;
  /** 门禁 / 错误界面上展示的文案 */
  message: string;
  submitting: boolean;
  /** 进房装载文档时的遮罩态 */
  busyLoading: boolean;
  publishOpen: boolean;
  /**
   * 当前画布上的底图是不是服务器发的预览版（非管理员默认是）。
   * 只用于给用户一句实话 —— 坐标空间与它无关，永远是快照里的 doc。
   */
  basePreview: boolean;
}

const state = reactive<CollabState>({
  mode: 'offline',
  phase: 'boot',
  roomId: null,
  role: null,
  room: null,
  message: '',
  submitting: false,
  busyLoading: false,
  publishOpen: false,
  basePreview: false,
});

/**
 * 进房时的基线：一行头像在该时刻的字段快照 + 服务端给的两个版本戳。
 * 提交时拿它和当前画布比出差量；提交成功后只把成功的那些行推进到新基线。
 * shallowRef 只在整表替换时触发：不在这张表上原地 set，要改一律替换出新 Map。
 */
const baseline = shallowRef<Map<string, LayerBaseline>>(new Map());

const locked = computed(() => state.mode === 'room' && state.role === 'editor');
const isAdmin = computed(() => state.mode === 'room' && state.role === 'admin');
/** 待提交数 = 相对基线动过的行数（换肤、挪位置、新增、删除各算一处），撤销回基线即时归零 */
const dirtyCount = computed(() => countPending(baseline.value, layerStates()));

const LAYOUT_LOCK_MESSAGE = '协同编辑下布局已锁定：位置与数量由发起者固定，只能换头像内容';

/* ------------------------------------------------------------------ *
 * 钩子注册：editor.ts 的守卫在这里落地
 * ------------------------------------------------------------------ */

setCollabHooks({
  canMutateLayout(action: string): boolean {
    if (!locked.value) return true;
    void action;
    notify('warn', LAYOUT_LOCK_MESSAGE);
    return false;
  },
  onSkinApplied(layerId: string): void {
    // 待提交计数走实时差分（撤销回基线会自动归零），这里无需登记
    void layerId;
  },
  isLayoutFrozen(): boolean {
    return locked.value;
  },
});

/* ------------------------------------------------------------------ *
 * 基线
 * ------------------------------------------------------------------ */

/** 当前画布在协议里的样子；order 用数组下标（服务端写入时也按下标，两边同一口径） */
function layerStates(): LayerState[] {
  return editor.layers.map((layer, index) => ({
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
    skinId: layer.skinId,
  }));
}

/** 载入时的底图 id：提交时对比判断管理员有没有换底图 */
let baselineBaseId: string | null = null;

function captureBaseline(records: RoomAvatarRecord[] = []): void {
  const stamps = new Map(records.map((r) => [r.id, r]));
  const next = new Map<string, LayerBaseline>();
  for (const layerState of layerStates()) {
    const record = stamps.get(layerState.id);
    next.set(layerState.id, {
      state: layerState,
      skinUpdatedAt: record?.skinUpdatedAt ?? 0,
      layoutUpdatedAt: record?.layoutUpdatedAt ?? 0,
    });
  }
  baseline.value = next;
  baselineBaseId = editor.baseImageId;
}

function currentPassword(): string {
  return state.roomId ? session.loadRoomPassword(state.roomId) ?? '' : '';
}

/* ------------------------------------------------------------------ *
 * 进房 / 刷新
 * ------------------------------------------------------------------ */

async function enterRoom(password: string): Promise<void> {
  if (!state.roomId) return;
  state.phase = 'loading';
  state.message = '';
  try {
    const snapshot = await collabApi.getRoom(state.roomId, password);
    if (snapshot.room.status === 'draft') {
      state.phase = 'error';
      state.message = '房间还没发布完成（底图尚未上传），请等发起者重新发布';
      return;
    }
    if (!snapshot.room.baseImage) {
      state.phase = 'error';
      state.message = '房间缺少底图，无法显示';
      return;
    }

    // 先看本地有没有上次存的字节：有就带着它的 ETag 去问，服务端答 304 就从本地读，
    // 一个字节的图都不用传。ETag 里带变体（预览/原图），所以切角色不会串。
    let cached = await readBaseEntry(state.roomId);
    let base = await collabApi.fetchBase(state.roomId, password, { etag: cached?.etag });
    if (base.notModified && !cached) {
      // 理论上不会发生（只有带着 ETag 去问才可能收到 304），真碰上就当缓存坏了：
      // 清掉重问一次，此时没有 ETag，服务端必定回 200。绝不拿空字节去当底图。
      await deleteBaseEntry(state.roomId);
      cached = null;
      base = await collabApi.fetchBase(state.roomId, password);
    }

    let baseBlob: Blob;
    let baseName: string;
    let baseType: string;
    let baseVariant: 'preview' | 'full';
    if (base.notModified) {
      // 走到这里 cached 必然存在（上面已经兜过），TS 需要一句断言帮忙收窄
      baseBlob = cached!.blob;
      baseName = cached!.name;
      baseType = cached!.type;
      baseVariant = cached!.variant;
    } else {
      baseBlob = base.blob;
      baseName = base.name;
      baseType = base.type;
      baseVariant = base.variant;
      if (base.etag) {
        // 写缓存失败（配额满、隐私模式）不该影响进房：它只是"下次能省一次下载"
        void writeBaseEntry({
          roomId: state.roomId,
          etag: base.etag,
          variant: base.variant,
          name: base.name,
          type: base.type,
          blob: base.blob,
          savedAt: Date.now(),
        });
      }
    }

    // 记下这一份是预览还是原图：只影响提示文案。
    // 坐标空间仍然来自 snapshot.room.doc（原图尺寸），两者刻意不混在一起。
    state.basePreview = baseVariant === 'preview';
    const baseFile = new File([baseBlob], baseName, { type: baseType });
    state.busyLoading = true;
    try {
      await loadRoomDocument(baseFile, snapshot.avatars, snapshot.room.doc);
    } finally {
      state.busyLoading = false;
    }
    // 装载完画布才有 layerStates 可比：基线必须在 loadRoomDocument 之后建
    captureBaseline(snapshot.avatars);

    session.saveRoomPassword(state.roomId, password);
    state.role = snapshot.role;
    state.room = snapshot.room;
    state.phase = 'ready';

    if (snapshot.role === 'admin') {
      notify('info', '已用管理员密码进入：可以任意修改，完成后记得提交');
    } else {
      notify('info', '进入协同编辑：布局已锁定，点选头像换内容，完成后提交');
    }
  } catch (error) {
    if (error instanceof CollabApiError) {
      if (error.status === 401) {
        state.phase = 'gate';
        state.message = error.message;
        return;
      }
      if (error.status === 410) {
        state.phase = 'gone';
        state.message = error.message;
        return;
      }
      state.phase = 'error';
      state.message = error.message;
      return;
    }
    state.phase = 'error';
    state.message = (error as Error).message || '载入房间失败';
  }
}

/** 应用启动时调用：根据 URL 决定进离线模式还是进房间 */
export function boot(): void {
  const roomId = session.roomIdFromLocation();
  if (!roomId) {
    state.mode = 'offline';
    state.phase = 'ready';
    return;
  }
  state.mode = 'room';
  state.roomId = roomId;
  const password = session.loadRoomPassword(roomId);
  if (!password) {
    state.phase = 'gate';
    return;
  }
  void enterRoom(password);
}

/** 用（新输入的）密码进房 */
export async function submitGate(password: string): Promise<void> {
  const trimmed = password.trim();
  if (!trimmed) {
    state.message = '请输入密码';
    state.phase = 'gate';
    return;
  }
  await enterRoom(trimmed);
}

/** 放弃门禁，回首页离线模式 */
export function leaveRoom(): void {
  if (state.roomId) session.clearRoomPassword(state.roomId);
  window.location.assign(window.location.pathname);
}

/** 重新拉取房间（冲突后 / 手动刷新） */
export async function reloadRoom(): Promise<void> {
  const password = currentPassword();
  if (!password) {
    state.phase = 'gate';
    return;
  }
  await enterRoom(password);
}

/* ------------------------------------------------------------------ *
 * 提交
 * ------------------------------------------------------------------ */

/** 底图超出后端上限（BF_MAX_BASE_IMAGE_BYTES，50MB）时给出可直接照做的文案，null 表示没超 */
function baseTooLarge(file: File): string | null {
  if (file.size <= MAX_BASE_IMAGE_BYTES) return null;
  return `底图 ${formatBytes(file.size)}，超过 ${MAX_BASE_IMAGE_BYTES / (1024 * 1024)}MB 上限，先压小再试`;
}

/**
 * 上传底图：建房时的首图与管理员换底图共用这一个入口，一次 multipart 请求搞定。
 * 服务端的话（401/403/413…）原样上抛；剩下的失败只可能是断网，翻译成能照做的提示。
 */
async function sendBaseImage(
  roomId: string,
  password: string,
  file: File,
  baseImage: { name: string; type: string; width: number; height: number },
): Promise<{ doc: RoomDoc; baseImage: RoomBaseImage }> {
  try {
    const uploaded = await collabApi.uploadBase(roomId, password, file, baseImage);
    return { doc: uploaded.doc, baseImage: uploaded.baseImage };
  } catch (error) {
    if (error instanceof CollabApiError) throw error;
    throw new Error(`底图上传失败或中断（${formatBytes(file.size)}）：检查网络后重试`);
  }
}

/**
 * 把差量切成几个请求发出去。
 * 只有体积边界：updates 与 adds 各自按体积分块，deletes 跟第一批走 —— 条数不设限，
 * 改得多就多几个请求，一条都不会丢。
 */
async function sendPatch(password: string, patch: RoomPatch): Promise<PatchItemResult[]> {
  const roomId = state.roomId;
  if (!roomId) return [];
  const batches: PatchPayload[] = [];
  for (const chunk of chunkBySize(patch.updates)) batches.push({ updates: chunk });
  for (const chunk of chunkBySize(patch.adds)) batches.push({ adds: chunk });
  if (patch.deletes.length > 0) {
    if (batches.length === 0) batches.push({});
    batches[0].deletes = patch.deletes;
  }
  const collected = [];
  for (const batch of batches) collected.push(await collabApi.patchAvatars(roomId, password, batch));
  return mergePatchResults(collected);
}

/** 提交结果汇总成人话（swapped 表示这一次还换了底图） */
function reportResults(results: PatchItemResult[], swapped = false): void {
  const ok = results.filter((r) => r.ok).length;
  const conflicts = results.filter((r) => r.error === 'conflict').length;
  const missing = results.filter((r) => r.error === 'not-found').length;
  const failed = results.filter((r) => !r.ok && r.error !== 'conflict' && r.error !== 'not-found').length;
  const parts: string[] = [];
  if (swapped) parts.push('底图已更换');
  if (ok > 0) parts.push(`已保存 ${ok} 处改动`);
  if (conflicts > 0) parts.push(`${conflicts} 处刚被别人改过，仍留着待提交`);
  if (missing > 0) parts.push(`${missing} 个头像在服务器上已被删除，刷新后可对齐`);
  if (failed > 0) parts.push(`${failed} 处提交失败`);
  const tone = conflicts === 0 && failed === 0 && missing === 0 ? 'success' : 'warn';
  notify(tone, parts.join('；') || '没有改动需要提交');
}

/** 编辑者/管理员点"完成"：都是差量提交，区别只在换底图那一步 */
export async function submitChanges(): Promise<void> {
  if (state.submitting || !state.room || !state.roomId) return;
  const password = currentPassword();
  if (!password) {
    state.phase = 'gate';
    return;
  }
  if (!editor.layers.length) {
    notify('warn', '画布上一个头像都没有，先摆一个再提交');
    return;
  }

  const patch = buildRoomPatch(baseline.value, layerStates(), (id) => encodeLayerSkin(id));
  const patchEmpty = patchIsEmpty(patch);
  // 只换了底图、头像一行没动：差量是空的，但底图那一步照样得做
  const swapBase = state.role === 'admin' && editor.baseImageId !== baselineBaseId;
  if (patchEmpty && !swapBase) {
    notify('info', patch.failedSkins > 0
      ? `有 ${patch.failedSkins} 个头像的皮肤无法编码（可能是跨域来源），换一张再提交`
      : '没有改动需要提交');
    return;
  }
  if (patch.failedSkins > 0) {
    notify('warn', `有 ${patch.failedSkins} 个头像的皮肤无法编码（可能是跨域来源），这次先跳过它们`);
  }

  state.submitting = true;
  let swapped = false;
  try {
    // 换底图：只有管理员，且只动底图那张表（画布尺寸随底图一起走）
    if (swapBase) {
      const payload = collectRoomPayload();
      if (!payload.baseImage || !payload.baseFile) throw new Error('房间缺少底图，无法提交');
      const tooLarge = baseTooLarge(payload.baseFile);
      if (tooLarge) { notify('error', tooLarge); return; }
      const uploaded = await sendBaseImage(state.roomId, password, payload.baseFile, payload.baseImage);
      // 画布尺寸与文件名以服务端落盘的结果为准（它才是真正保存字节的那一方）
      state.room = { ...state.room, doc: uploaded.doc, baseImage: uploaded.baseImage };
      baselineBaseId = editor.baseImageId;
      swapped = true;
    }

    if (patchEmpty) {
      notify('success', '底图已更换');
      return;
    }
    const results = await sendPatch(password, patch);
    // 只把成功的行推进到新基线：冲突/失败的原样留着继续算待提交
    const next = new Map(baseline.value);
    advanceBaseline(next, layerStates(), patch, results);
    baseline.value = next;
    reportResults(results, swapped);
  } catch (error) {
    if (error instanceof CollabApiError && error.status === 413) {
      notify('error', error.message);
      return;
    }
    notify('error', error instanceof CollabApiError ? error.message : ((error as Error).message || '提交失败，稍后再试'));
  } finally {
    state.submitting = false;
  }
}

/** 管理员删除整个房间（UI 侧做二次确认） */
export async function removeRoom(): Promise<void> {
  if (!state.roomId || !isAdmin.value) return;
  const password = currentPassword();
  if (!password) {
    state.phase = 'gate';
    return;
  }
  state.submitting = true;
  try {
    await collabApi.deleteRoom(state.roomId, password);
    session.clearRoomPassword(state.roomId);
    // 房间没了，本地那份底图字节也不会再用到：顺手清掉，别把别人的图留在盘上
    void deleteBaseEntry(state.roomId);
    notify('success', '房间已删除');
    // e2e 测试口：不真的导航，停在 gone 界面方便断言
    if ((window as unknown as Record<string, unknown>).__BFPLUS_E2E_STAY__) {
      state.phase = 'gone';
      state.submitting = false;
      return;
    }
    window.location.assign(window.location.pathname);
  } catch (error) {
    notify('error', error instanceof CollabApiError ? error.message : '删除失败，稍后再试');
    state.submitting = false;
  }
}

/* ------------------------------------------------------------------ *
 * 发布（离线 → 房间）
 * ------------------------------------------------------------------ */

export interface PublishResult {
  roomId: string;
  shareUrl: string;
  editPassword: string;
  adminPassword: string;
  expiresAt: number;
}

const publish = reactive<{
  step: 'form' | 'creating' | 'uploading' | 'done';
  error: string;
  result: PublishResult | null;
}>({
  step: 'form',
  error: '',
  result: null,
});

export function openPublish(): void {
  publish.step = 'form';
  publish.error = '';
  publish.result = null;
  state.publishOpen = true;
}

export function closePublish(): void {
  state.publishOpen = false;
}

export async function publishRoom(expiresDays: number): Promise<void> {
  if (publish.step !== 'form' && publish.step !== 'done') return;
  publish.error = '';

  const payload = collectRoomPayload();
  if (!payload.baseImage || !payload.baseFile) {
    publish.error = '先放一张底图再发布';
    return;
  }
  if (payload.layers.length === 0) {
    publish.error = '至少先摆一个头像再发布';
    return;
  }
  if (payload.failedSkins > 0) {
    publish.error = `有 ${payload.failedSkins} 个头像的皮肤无法编码，先换个来源或重新载入`;
    return;
  }

  const tooLarge = baseTooLarge(payload.baseFile);
  if (tooLarge) {
    publish.error = tooLarge;
    return;
  }

  // 建房是唯一一次真的把整间房发过去（一间全新的房），体积超了服务端只会回 413，这里提前说清楚
  const oversize = fullSubmitTooLarge({
    baseImage: payload.baseImage,
    layers: payload.layers,
    expiresDays,
  });
  if (oversize) {
    publish.error = oversize;
    return;
  }

  publish.step = 'creating';
  try {
    const created = await collabApi.createRoom({
      baseImage: payload.baseImage,
      layers: payload.layers,
      expiresDays,
    });
    // 建房拿到的只是身份与密码，底图紧接着单独传一次；传完房间才从 draft 变 ready
    publish.step = 'uploading';
    // 底图这一步失败就不再回滚房间：它还是 draft，后端会按 BF_DRAFT_TTL_SECONDS 收走，
    // 用户重试一次是全新的房间，比删掉一个可能已经传了一半的房间干净
    await sendBaseImage(created.roomId, created.editPassword, payload.baseFile, payload.baseImage);

    // 房主本人进房要拿管理员权限：会话里存管理员密码；编辑密码只展示给成员，不落会话
    session.saveRoomPassword(created.roomId, created.adminPassword);
    publish.result = {
      roomId: created.roomId,
      shareUrl: session.roomUrl(created.roomId),
      editPassword: created.editPassword,
      adminPassword: created.adminPassword,
      expiresAt: created.expiresAt,
    };
    publish.step = 'done';
  } catch (error) {
    publish.step = 'form';
    publish.error = error instanceof CollabApiError ? error.message : ((error as Error).message || '发布失败，稍后再试');
  }
}

/** 发布完成後直接进房继续体验自己的房间 */
export function enterPublishedRoom(): void {
  if (!publish.result) return;
  window.location.assign(publish.result.shareUrl);
}

export const collab = state;
export const publishState = publish;
export { dirtyCount, isAdmin, locked };
export type { CollabState };
