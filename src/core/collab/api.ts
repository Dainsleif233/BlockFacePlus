/*!
 * BlockFace+ · 协同房间 API 客户端
 * Copyright 2026 Dainsleif · Apache License 2.0
 *
 * 全部同源请求（前端与函数同站部署，无需 CORS）；密码走自定义头，不进 URL。
 * 底图字节走预签名 URL 直传 Blob，不经过本客户端。
 */

import type {
  AvatarUpdate,
  CreateRoomPayload,
  CreateRoomResult,
  PatchResult,
  RoomSnapshot,
} from './types';

export class CollabApiError extends Error {
  status: number;
  payload: Record<string, unknown>;

  constructor(status: number, message: string, payload: Record<string, unknown> = {}) {
    super(message);
    this.name = 'CollabApiError';
    this.status = status;
    this.payload = payload;
  }
}

const PASSWORD_HEADER = 'X-BF-Room-Pwd';

async function parseError(response: Response): Promise<CollabApiError> {
  let message = `请求失败（${response.status}）`;
  let payload: Record<string, unknown> = {};
  try {
    const data = (await response.json()) as Record<string, unknown>;
    if (data) {
      payload = data;
      if (typeof data.error === 'string') message = data.error;
    }
  } catch {
    /* 非 JSON 错误体，用默认文案 */
  }
  return new CollabApiError(response.status, message, payload);
}

async function request<T>(
  method: string,
  path: string,
  options: { password?: string; body?: unknown; maxChars?: number } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  if (options.password) headers[PASSWORD_HEADER] = options.password;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  const serialized = options.body === undefined ? undefined : JSON.stringify(options.body);
  // 体积预检：整间房一次性提交没有分块能力，超了服务端只会回 413，
  // 与其让人对着「请求体太大」发愣，不如在这里先说人话
  if (serialized !== undefined && options.maxChars !== undefined && serialized.length > options.maxChars) {
    throw new CollabApiError(413, oversizeMessage(serialized.length, options.maxChars));
  }

  const response = await fetch(path, {
    method,
    headers,
    body: serialized,
  });
  if (!response.ok) throw await parseError(response);
  return (await response.json()) as T;
}

export const collabApi = {
  createRoom(payload: CreateRoomPayload): Promise<CreateRoomResult> {
    return request('POST', '/api/rooms', { body: payload, maxChars: MAX_FULL_SUBMIT_CHARS });
  },

  getRoom(roomId: string, password: string): Promise<RoomSnapshot> {
    return request('GET', `/api/rooms/${encodeURIComponent(roomId)}`, { password });
  },

  patchAvatars(roomId: string, password: string, updates: AvatarUpdate[]): Promise<PatchResult> {
    return request('PATCH', `/api/rooms/${encodeURIComponent(roomId)}/avatars`, { password, body: { updates } });
  },

  putLayers(
    roomId: string,
    password: string,
    layers: unknown[],
    ifRevision?: number,
  ): Promise<{ revision: number }> {
    return request('PUT', `/api/rooms/${encodeURIComponent(roomId)}`, {
      password,
      body: { layers, ...(ifRevision === undefined ? {} : { ifRevision }) },
      maxChars: MAX_FULL_SUBMIT_CHARS,
    });
  },

  deleteRoom(roomId: string, password: string): Promise<{ ok: boolean }> {
    return request('DELETE', `/api/rooms/${encodeURIComponent(roomId)}`, { password });
  },

  /** 换底图前申请预签名上传 URL（仅管理员） */
  signBaseUpload(roomId: string, password: string, type: string): Promise<{ upload: { url: string; key: string; expiresAt: number } }> {
    return request('POST', `/api/rooms/${encodeURIComponent(roomId)}/base`, {
      password,
      body: { intent: 'sign', type },
    });
  },

  /** 底图上传完成后的回执确认 */
  confirmBase(
    roomId: string,
    password: string,
    payload: { key?: string; name: string; type: string; width: number; height: number },
  ): Promise<{ ok: boolean; doc: { width: number; height: number }; revision: number }> {
    return request('POST', `/api/rooms/${encodeURIComponent(roomId)}/base`, {
      password,
      body: { intent: 'confirm', ...payload },
    });
  },

  /** 拉底图字节；调用方负责转成可用的图片对象 */
  async fetchBase(roomId: string, password: string): Promise<{ blob: Blob; name: string; type: string }> {
    const response = await fetch(`/api/rooms/${encodeURIComponent(roomId)}/base`, {
      headers: { [PASSWORD_HEADER]: password },
    });
    if (!response.ok) throw await parseError(response);
    // 文件名可能是中文：服务端用 percent-encoding 放进响应头（响应头不允许非 ASCII），这里解回来
    let name = '底图';
    const rawName = response.headers.get('X-BF-Base-Name');
    if (rawName) {
      try { name = decodeURIComponent(rawName); } catch { name = rawName; }
    }
    return {
      blob: await response.blob(),
      name,
      type: response.headers.get('Content-Type') ?? 'image/png',
    };
  },
};

/** 单次增量提交的体积上限（字符数）：云函数请求体上限 6MB，留出余量 */
export const MAX_PATCH_CHARS = 4_000_000;

/**
 * 整间房一次性提交的体积上限：与后端 readJsonBody 的默认值（5M 字符）对齐。
 * 建房和管理员全量同步都是"一次把整间房发过去"，没有分块能力，超了就是 413。
 */
export const MAX_FULL_SUBMIT_CHARS = 5 * 1024 * 1024;

function oversizeMessage(chars: number, limit: number): string {
  return `整间房的内容约 ${formatBytes(chars)}，超过单次提交的 ${formatBytes(limit)} 上限：减掉几张头像，或把自定义图压小再发布`;
}

/**
 * 整间房一次性提交的体积预检：超了返回一句人话，没问题返回 null。
 * 调用方两个地方：发布对话框点"发布"之前、管理员全量同步换底图之前 ——
 * 后者尤其要早查，否则底图已经换掉了才崩在图层那一步。
 */
export function fullSubmitTooLarge(payload: unknown, limit = MAX_FULL_SUBMIT_CHARS): string | null {
  let chars = 0;
  try {
    chars = JSON.stringify(payload)?.length ?? 0;
  } catch {
    return null; // 序列化都失败的话交给真正的请求去报错，别在这儿吞掉
  }
  return chars > limit ? oversizeMessage(chars, limit) : null;
}

/** 单次增量提交的条数上限：与后端 MAX_PATCH_UPDATES 对齐，超过直接 400 */
export const MAX_PATCH_UPDATES = 64;

/**
 * 底图体积上限：与后端 MAX_BASE_IMAGE_BYTES 对齐（10MB）。
 * 后端到 confirm 才校验，而上传通道本身另有更小的硬上限（实测 25MiB 处直接掐断连接、
 * 不回响应），所以前端必须在上传之前先拦下来，否则只会得到一句 Failed to fetch。
 */
export const MAX_BASE_IMAGE_BYTES = 10 * 1024 * 1024;

/** 把字节数说成人话，用于「底图 28.4MB，超过 10MB 上限」这类提示 */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${bytes}B`;
}

/**
 * 把增量更新切块，两个上限取先到者：
 *  - 体积：内嵌皮肤是 base64 data URI，一张高清自定义图可能几百 KB，顶到请求体上限就切；
 *  - 条数：后端单次最多收 64 条，超过直接 400。
 * 块间顺序提交，单块失败不影响前面已落盘的。
 */
export function chunkUpdates(
  updates: AvatarUpdate[],
  maxChars = MAX_PATCH_CHARS,
  maxCount = MAX_PATCH_UPDATES,
): AvatarUpdate[][] {
  const chunks: AvatarUpdate[][] = [];
  let current: AvatarUpdate[] = [];
  let size = 2; // "[]" 本身
  for (const update of updates) {
    const itemSize = JSON.stringify(update).length + (current.length > 0 ? 1 : 0);
    if (current.length > 0 && (current.length >= maxCount || size + itemSize > maxChars)) {
      chunks.push(current);
      current = [];
      size = 2;
    }
    current.push(update);
    size += itemSize;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}
