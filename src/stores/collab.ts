/*!
 * BlockFace+ · 协同房间状态中枢
 * Copyright 2026 Dainsleif · Apache License 2.0
 *
 * 三种入口，一套画布：
 *  - 离线（无 ?room=）：就是原来的 BlockFace，"共同编辑"把当前画布发布成房间；
 *  - 编辑者（URL + 编辑密码）：布局冻结，只能换头像内容，"完成"提交增量；
 *  - 管理员（URL + 管理员密码）：任意修改，"完成"全量同步，另可删除房间。
 *
 * 与 editor.ts 的耦合走钩子（setCollabHooks），避免模块循环依赖。
 */

import { computed, reactive, shallowRef } from 'vue';
import { CollabApiError, MAX_BASE_IMAGE_BYTES, chunkUpdates, collabApi, formatBytes, fullSubmitTooLarge } from '../core/collab/api';
import * as session from '../core/collab/session';
import type { AvatarUpdate, RoomInfo, RoomRole } from '../core/collab/types';
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
});

/**
 * 载入时的基线：图层 id → 当时的 skinId；提交时对比找出"改过内容"的头像。
 * shallowRef 只在整表替换时触发：不在这张表上原地 set，要改一律替换出新 Map。
 */
const baselineSkin = shallowRef(new Map<string, string>());
/** 载入时每条头像的 updatedAt，提交时作为逐条冲突检查凭证 */
const baselineStamp = new Map<string, number>();

const locked = computed(() => state.mode === 'room' && state.role === 'editor');
const isAdmin = computed(() => state.mode === 'room' && state.role === 'admin');
/** 待提交数 = 当前 skinId 与基线不同的头像数：撤销回基线即时归零，不会残留过期徽章 */
const dirtyCount = computed(() => {
  let count = 0;
  for (const layer of editor.layers) {
    const baseline = baselineSkin.value.get(layer.id);
    if (baseline !== undefined && baseline !== layer.skinId) count += 1;
  }
  return count;
});

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
 * 进房 / 刷新
 * ------------------------------------------------------------------ */

/** 载入时的底图 id：提交时对比判断管理员有没有换底图 */
let baselineBaseId: string | null = null;

function captureBaseline(): void {
  baselineSkin.value = new Map(editor.layers.map((l) => [l.id, l.skinId]));
  baselineBaseId = editor.baseImageId;
  baselineStamp.clear();
}

function currentPassword(): string {
  return state.roomId ? session.loadRoomPassword(state.roomId) ?? '' : '';
}

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

    const base = await collabApi.fetchBase(state.roomId, password);
    const baseFile = new File([base.blob], base.name, { type: base.type });
    state.busyLoading = true;
    try {
      await loadRoomDocument(baseFile, snapshot.avatars, snapshot.room.doc);
    } finally {
      state.busyLoading = false;
    }
    // 先重置基线（会清空两张 Map），再把服务端时间戳填回去——顺序反了凭证就全没了
    captureBaseline();
    for (const record of snapshot.avatars) baselineStamp.set(record.id, record.updatedAt);

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

/** 把编辑者改过的头像编码成增量提交；编码失败返回错误文案 */
function collectEditorUpdates(): { updates: AvatarUpdate[]; skinIds: Map<string, string>; error: string | null } {
  const changed = editor.layers.filter((l) => {
    const baseline = baselineSkin.value.get(l.id);
    return baseline !== undefined && baseline !== l.skinId;
  });
  if (changed.length === 0) return { updates: [], skinIds: new Map(), error: null };
  const updates: AvatarUpdate[] = [];
  const skinIds = new Map<string, string>();
  for (const layer of changed) {
    const skin = encodeLayerSkin(layer.id);
    if (!skin) return { updates: [], skinIds: new Map(), error: `「${layer.name}」的皮肤无法编码（可能是跨域来源），换一张再提交` };
    updates.push({ id: layer.id, skin, expectUpdatedAt: baselineStamp.get(layer.id) });
    // 记下提交那一刻的 skinId：成功后基线拨到这个值，等待期间的新改动不会被旧基线吞掉
    skinIds.set(layer.id, layer.skinId);
  }
  return { updates, skinIds, error: null };
}

/** 底图超出服务端上限（10MB）时给出可直接照做的文案，null 表示没超 */
function baseTooLarge(file: File): string | null {
  if (file.size <= MAX_BASE_IMAGE_BYTES) return null;
  return `底图 ${formatBytes(file.size)}，超过 ${MAX_BASE_IMAGE_BYTES / (1024 * 1024)}MB 上限，先压小再试`;
}

/**
 * 直传底图到预签名地址。
 * 存储端对超限体量或中途断掉的连接是直接掐断、不回响应，浏览器只能抛一句 TypeError，
 * 所以这里把网络层失败翻译成能照做的提示。
 */
async function putBaseImage(url: string, file: File, type: string): Promise<void> {
  let response: Response;
  try {
    response = await fetch(url, { method: 'PUT', body: file, headers: { 'Content-Type': type } });
  } catch {
    throw new Error(`底图上传中断（${formatBytes(file.size)}）：网络不稳或体量超过上传通道上限，压小后重试`);
  }
  if (!response.ok) throw new Error(`底图上传失败（${response.status}）`);
}

/** 编辑者/管理员点"完成"：角色不同走不同通道 */
export async function submitChanges(): Promise<void> {
  if (state.submitting || !state.room || !state.roomId) return;
  const password = currentPassword();
  if (!password) {
    state.phase = 'gate';
    return;
  }

  if (state.role === 'editor') {
    const { updates, skinIds, error } = collectEditorUpdates();
    if (error) {
      notify('error', error);
      return;
    }
    if (updates.length === 0) {
      notify('info', '没有改动需要提交：点选一个头像，在左侧换上自己的皮肤');
      return;
    }
    state.submitting = true;
    try {
      const chunks = chunkUpdates(updates);
      const conflicts: string[] = [];
      const failures: string[] = [];
      let saved = 0;
      for (const chunk of chunks) {
        const result = await collabApi.patchAvatars(state.roomId, password, chunk);
        for (const item of result.results) {
          if (item.ok) {
            saved += 1;
            const submitted = skinIds.get(item.id);
            if (submitted !== undefined) {
              baselineSkin.value = new Map(baselineSkin.value).set(item.id, submitted);
            }
            if (item.updatedAt !== undefined) baselineStamp.set(item.id, item.updatedAt);
          } else if (item.error === 'conflict') {
            conflicts.push(item.id);
          } else {
            failures.push(item.id);
          }
        }
      }
      const parts: string[] = [];
      if (saved > 0) parts.push(`已保存 ${saved} 个头像`);
      if (conflicts.length > 0) parts.push(`${conflicts.length} 个头像刚被别人改过，请刷新后重试`);
      if (failures.length > 0) parts.push(`${failures.length} 个头像提交失败`);
      const tone = conflicts.length === 0 && failures.length === 0 ? 'success' : 'warn';
      notify(tone, parts.join('；') || '提交完成');
      // 冲突/失败的条目不用额外登记：基线没动，差分自然会继续把它们算作待提交
    } catch (error) {
      notify('error', error instanceof CollabApiError ? error.message : '提交失败，稍后再试');
    } finally {
      state.submitting = false;
    }
    return;
  }

  // 管理员：全量同步（含位置、增删）
  const payload = collectRoomPayload();
  if (!payload.baseImage || !payload.baseFile) {
    notify('error', '房间缺少底图，无法提交');
    return;
  }
  if (payload.failedSkins > 0) {
    notify('error', `有 ${payload.failedSkins} 个头像的皮肤无法编码，请先换掉再提交`);
    return;
  }
  // 先量体积再动手：这一步之后紧接着就是换底图，别等底图传完了才发现图层整批发不过去
  const oversize = fullSubmitTooLarge({ layers: payload.layers, ifRevision: state.room.revision });
  if (oversize) {
    notify('error', oversize);
    return;
  }
  state.submitting = true;
  try {
    let revision = state.room.revision;
    if (editor.baseImageId !== baselineBaseId) {
      // 底图换过：先走预签名直传 + 回执确认；confirm 会推进 revision，图层同步要用新值
      const tooLarge = baseTooLarge(payload.baseFile);
      if (tooLarge) {
        notify('error', tooLarge);
        return;
      }
      const sign = await collabApi.signBaseUpload(state.roomId, password, payload.baseImage.type);
      await putBaseImage(sign.upload.url, payload.baseFile, payload.baseImage.type);
      const confirmed = await collabApi.confirmBase(state.roomId, password, {
        key: sign.upload.key,
        name: payload.baseImage.name,
        type: payload.baseImage.type,
        width: payload.baseImage.width,
        height: payload.baseImage.height,
      });
      revision = confirmed.revision;
      state.room = {
        ...state.room,
        doc: confirmed.doc,
        baseImage: {
          name: payload.baseImage.name,
          type: payload.baseImage.type,
          width: payload.baseImage.width,
          height: payload.baseImage.height,
        },
        revision,
      };
      baselineBaseId = editor.baseImageId;
    }
    await collabApi.putLayers(state.roomId, password, payload.layers, revision);
    state.room = { ...state.room, revision: (await collabApi.getRoom(state.roomId, password)).room.revision };
    captureBaseline();
    notify('success', `已同步 ${payload.layers.length} 个头像到房间`);
  } catch (error) {
    if (error instanceof CollabApiError && error.status === 409) {
      notify('warn', '房间刚被别人改过，正在载入最新版本…');
      await reloadRoom();
      return;
    }
    notify('error', error instanceof CollabApiError ? error.message : '提交失败，稍后再试');
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
  step: 'form' | 'creating' | 'uploading' | 'finalizing' | 'done';
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

  // 建房是"一次把整间房发过去"，没有分块能力：体积超了服务端只会回 413，这里提前说清楚
  const oversize = fullSubmitTooLarge({
    doc: payload.doc,
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
      doc: payload.doc,
      baseImage: payload.baseImage,
      layers: payload.layers,
      expiresDays,
    });
    publish.step = 'uploading';
    await putBaseImage(created.upload.url, payload.baseFile, payload.baseImage.type);

    publish.step = 'finalizing';
    await collabApi.confirmBase(created.roomId, created.editPassword, {
      name: payload.baseImage.name,
      type: payload.baseImage.type,
      width: payload.baseImage.width,
      height: payload.baseImage.height,
    });

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
