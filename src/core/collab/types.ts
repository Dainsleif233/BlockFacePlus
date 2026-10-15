/*!
 * BlockFace+ · 协同房间的前端协议类型
 * Copyright 2026 Dainsleif · Apache License 2.0
 */

import type { PresetSkin } from '../model/preset';

/** 房间的画布尺寸（= 底图尺寸） */
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
 * 一条头像记录 = 预设里的 PresetLayer + 身份（id）与并发凭证（updatedAt）。
 * 服务端一头像一键，改内容就是覆盖这一个 key，天然免冲突。
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
  /** 上次更新时间戳，编辑者提交时带上它做逐条冲突检查 */
  updatedAt: number;
}

export interface RoomInfo {
  roomId: string;
  doc: RoomDoc;
  baseImage: RoomBaseImage | null;
  createdAt: number;
  expiresAt: number;
  revision: number;
  status: 'draft' | 'ready';
}

export type RoomRole = 'editor' | 'admin';

export interface RoomSnapshot {
  room: RoomInfo;
  avatars: RoomAvatarRecord[];
  role: RoomRole;
}

/** 创建/全量同步时的一条头像草稿：updatedAt 由服务端生成，客户端不带 */
export type RoomAvatarDraft = Omit<RoomAvatarRecord, 'updatedAt'>;

export interface CreateRoomPayload {
  doc: RoomDoc;
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

/** 编辑者一次增量提交的最小单元：换掉的皮肤 + 旧时间戳做并发检查 */
export interface AvatarUpdate {
  id: string;
  skin: PresetSkin;
  expectUpdatedAt?: number;
}

export interface PatchResult {
  results: { id: string; ok: boolean; updatedAt?: number; error?: string }[];
  revision: number;
}

export const EXPIRY_DAYS = [3, 7, 14] as const;
export type ExpiryDays = (typeof EXPIRY_DAYS)[number];
