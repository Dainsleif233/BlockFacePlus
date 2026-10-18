/*!
 * BlockFace+ · 协同房间的前端协议类型
 * Copyright 2026 Dainsleif · Apache License 2.0
 *
 * 服务端的"表"与这里一一对应：
 *   房间身份（只读） / 底图（画布尺寸 + 指针） / 头像行（布局 + 外观 + 皮肤三个域 + 三个版本戳）
 * 一次提交只带**改动过的东西**，服务端只写被提到的那些行与字段。
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
  /**
   * 原图尺寸 —— 这就是画布坐标空间。
   * 非管理员拿到的像素源可能是缩小过的预览图，但这里永远是原图尺寸：
   * 头像坐标只跟它对齐，一旦让 width/height 跟着预览变，所有人的头像都会错位。
   */
  width: number;
  height: number;
  /** 预览图尺寸；null = 服务器没给预览（老房间 / 动图 / 已关闭），所有人拿原图 */
  preview: { width: number; height: number } | null;
}

/**
 * 一行头像 = 布局字段 + 外观字段 + 皮肤字段 + 三个版本戳。
 * 三个版本戳分开：挪位置只推进 layoutUpdatedAt，切帽子层/翻转只推进 appearanceUpdatedAt，
 * 换皮肤只推进 skinUpdatedAt。于是"有人在挪位置"和"有人在换皮肤"不会互相判成冲突，
 * 编辑者能改的那部分（皮肤 + 外观）也不会被布局锁连带冻住。
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
  /**
   * 外观字段（帽子层 / 水平翻转）的版本戳。
   * 老房间行迁移过来是 0（"从未推进"）；老后端根本不返回这个键 —— 那正是前端
   * 用来判断"这台后端还不认识外观域"的依据，见 stores/collab.ts 的 appearanceSupported。
   */
  appearanceUpdatedAt: number;
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
export type RoomAvatarDraft = Omit<
  RoomAvatarRecord,
  'skinUpdatedAt' | 'layoutUpdatedAt' | 'appearanceUpdatedAt'
>;

export interface CreateRoomPayload {
  baseImage: { name: string; type: string; width: number; height: number };
  layers: RoomAvatarDraft[];
  /** 过期天数：白名单 3/7/14，前后端是同一份（后端 config.EXPIRY_DAYS） */
  expiresDays: number;
}

/** 建房回执：只有身份与两把密码，没有上传地址 —— 底图随后由 uploadBase 直接传 */
export interface CreateRoomResult {
  roomId: string;
  editPassword: string;
  adminPassword: string;
  expiresAt: number;
}

/**
 * 布局字段的局部补丁：只带真的变了的键，没带的键服务端一律不动。
 *
 * 帽子层与水平翻转**不在这里**。它们曾经跟着布局一起走，结果编辑者一被禁改布局，
 * 两个纯外观开关也跟着冻住。现在它们是并列的 AppearancePatch，有自己的版本戳与并发凭证。
 * 老客户端把 overlay/flipH 塞进 layout 里服务端仍然认（兼容别名），但前端不再这么发。
 */
export interface LayoutPatch {
  name?: string;
  x?: number;
  y?: number;
  size?: number;
  rotation?: number;
  opacity?: number;
  visible?: boolean;
  order?: number;
}

/** 外观字段（帽子层 / 水平翻转）的局部补丁：管理员与编辑者都能写 */
export interface AppearancePatch {
  overlay?: boolean;
  flipH?: boolean;
}

/** 改一行：只带改动的那部分（换皮肤 / 挪位置 / 改外观 可以同时带，也可以只带一个） */
export interface AvatarUpdate {
  id: string;
  layout?: LayoutPatch;
  appearance?: AppearancePatch;
  skin?: PresetSkin;
  /** 布局并发凭证：进房时拿到的 layoutUpdatedAt */
  expectLayoutUpdatedAt?: number;
  /** 外观并发凭证：进房时拿到的 appearanceUpdatedAt */
  expectAppearanceUpdatedAt?: number;
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
  appearanceUpdatedAt?: number;
}

export interface PatchResult {
  results: PatchItemResult[];
}

export const EXPIRY_DAYS = [3, 7, 14] as const;
export type ExpiryDays = (typeof EXPIRY_DAYS)[number];
