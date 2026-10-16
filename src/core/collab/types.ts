/*!
 * BlockFace+ · 协同房间的前端协议类型
 * Copyright 2026 Dainsleif · Apache License 2.0
 *
 * 服务端的"表"与这里一一对应：
 *   房间身份（只读） / 底图（画布尺寸 + 指针） / 头像行（布局字段 + 皮肤字段 + 两个版本戳）
 * 一次提交只带**改动过的东西**，服务端只写被提到的那些行。
 */

import type { PresetSkin } from '../model/preset';

/** 房间的画布尺寸（= 底图尺寸，只有这一份真相） */
export interface RoomDoc {
  width: number;
  height: number;
}

export interface RoomBaseImage {
  name: string;
  type: string;
  width: number;
  height: number;
}

/**
 * 一行头像 = 布局字段 + 皮肤字段 + 两个版本戳。
 * 两个版本戳分开：挪位置只推进 layoutUpdatedAt，换皮肤只推进 skinUpdatedAt，
 * 于是"有人在挪位置"和"有人在换皮肤"不会互相判成冲突。
 */
export interface RoomAvatarRecord {
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
  /** 图层顺序，0 在最底层 */
  order: number;
  skin: PresetSkin | null;
  /** 皮肤内容的版本戳，换皮肤时带回去做并发检查 */
  skinUpdatedAt: number;
  /** 布局字段的版本戳，挪位置时带回去做并发检查 */
  layoutUpdatedAt: number;
}

export interface RoomInfo {
  roomId: string;
  doc: RoomDoc;
  baseImage: RoomBaseImage | null;
  createdAt: number;
  expiresAt: number;
  status: 'draft' | 'ready';
}

export type RoomRole = 'editor' | 'admin';

export interface RoomSnapshot {
  room: RoomInfo;
  avatars: RoomAvatarRecord[];
  role: RoomRole;
}

/** 新增一行头像时提交的草稿：版本戳由服务端生成，客户端不带 */
export type RoomAvatarDraft = Omit<RoomAvatarRecord, 'skinUpdatedAt' | 'layoutUpdatedAt'>;

export interface CreateRoomPayload {
  baseImage: { name: string; type: string; width: number; height: number };
  layers: RoomAvatarDraft[];
  /** 过期天数，只认 3 / 7 / 14 */
  expiresDays: number;
}

export interface CreateRoomResult {
  roomId: string;
  editPassword: string;
  adminPassword: string;
  expiresAt: number;
  upload: { url: string; key: string; expiresAt: number };
}

/** 布局字段的局部补丁：只带真的变了的键，没带的键服务端一律不动 */
export interface LayoutPatch {
  name?: string;
  x?: number;
  y?: number;
  size?: number;
  rotation?: number;
  opacity?: number;
  overlay?: boolean;
  flipH?: boolean;
  visible?: boolean;
  order?: number;
}

/** 改一行：只带改动的那部分（换皮肤 / 挪位置 可以同时带，也可以只带一个） */
export interface AvatarUpdate {
  id: string;
  layout?: LayoutPatch;
  skin?: PresetSkin;
  /** 布局并发凭证：进房时拿到的 layoutUpdatedAt */
  expectLayoutUpdatedAt?: number;
  /** 皮肤并发凭证：进房时拿到的 skinUpdatedAt */
  expectSkinUpdatedAt?: number;
}

export interface PatchPayload {
  updates?: AvatarUpdate[];
  adds?: RoomAvatarDraft[];
  deletes?: string[];
}

export interface PatchItemResult {
  id: string;
  ok: boolean;
  error?: string;
  skinUpdatedAt?: number;
  layoutUpdatedAt?: number;
}

export interface PatchResult {
  results: PatchItemResult[];
}

export const EXPIRY_DAYS = [3, 7, 14] as const;
export type ExpiryDays = (typeof EXPIRY_DAYS)[number];
