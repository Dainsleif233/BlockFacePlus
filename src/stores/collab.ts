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

import { computed, reactive, ref } from 'vue';
import { CollabApiError, chunkUpdates, collabApi } from '../core/collab/api';
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

/** 编辑者改过的头像 id（换肤即标记；提交成功后清空） */
const dirtyIds = ref(new Set<string>());

/** 载入时的基线：图层 id → 当时的 skinId；提交时对比找"改过内容"的头像 */
const baselineSkin = new Map<string, string>();
/** 载入时每条头像的 updatedAt，提交时作为逐条冲突检查凭证 */
const baselineStamp = new Map<string, number>();

const locked = computed(() => state.mode === 'room' && state.role === 'editor');
const isAdmin = computed(() => state.mode === 'room' && state.role === 'admin');
const dirtyCount = computed(() => dirtyIds.value.size);

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
    if (!locked.value) return;
    dirtyIds.value = new Set(dirtyIds.value).add(layerId);
  },
  isLayoutFrozen(): boolean {
    return locked.value;
  },
});

/* ------------------------------------------------------------------ *
 * 进房 / 刷新
 * ------------------------------------------------------------------ */

function captureBaseline(): void {
  baselineSkin.clear();
  baselineStamp.clear();
  dirtyIds.value = new Set();
  for (const layer of editor.layers) {
    baselineSkin.set(layer.id, layer.skinId);
  }
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
function collectEditorUpdates(): { updates: AvatarUpdate[]; error: string | null } {
  const changed = editor.layers.filter((l) => baselineSkin.get(l.id) !== undefined && baselineSkin.get(l.id) !== l.skinId);
  if (changed.length === 0) return { updates: [], error: null };
  const updates: AvatarUpdate[] = [];
  for (const layer of changed) {
    const skin = encodeLayerSkin(layer.id);
    if (!skin) return { updates: [], error: `「${layer.name}」的皮肤无法编码（可能是跨域来源），换一张再提交` };
    updates.push({ id: layer.id, skin, expectUpdatedAt: baselineStamp.get(layer.id) });
  }
  return { updates, error: null };
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
    const { updates, error } = collectEditorUpdates();
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
            const layer = editor.layers.find((l) => l.id === item.id);
            if (layer) baselineSkin.set(item.id, layer.skinId);
            if (item.updatedAt !== undefined) baselineStamp.set(item.id, item.updatedAt);
            const next = new Set(dirtyIds.value);
            next.delete(item.id);
            dirtyIds.value = next;
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
      if (conflicts.length > 0 || failures.length > 0) {
        dirtyIds.value = new Set([...dirtyIds.value, ...conflicts, ...failures]);
      }
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
  state.submitting = true;
  try {
    await collabApi.putLayers(state.roomId, password, payload.layers, state.room.revision);
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

  publish.step = 'creating';
  try {
    const created = await collabApi.createRoom({
      doc: payload.doc,
      baseImage: payload.baseImage,
      layers: payload.layers,
      expiresDays,
    });
    publish.step = 'uploading';
    const response = await fetch(created.upload.url, {
      method: 'PUT',
      body: payload.baseFile,
      headers: { 'Content-Type': payload.baseImage.type },
    });
    if (!response.ok) throw new Error(`底图上传失败（${response.status}）`);

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
