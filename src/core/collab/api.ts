/*!
 * BlockFace+ · 协同房间 API 客户端
 * Copyright 2026 Dainsleif · Apache License 2.0
 *
 * 全部同源请求（前端与函数同站部署，无需 CORS）；密码走自定义头，不进 URL。
 * 底图字节走预签名 URL 直传 Blob，不经过本客户端。
 *
 * 改头像只有一条路：PATCH .../avatars 的差量提交（只带改动过的行与字段）。
 * 没有"整间房全量上传"这回事了 —— 也就没有因此而来的体积上限和预检。
 */

import type {
  CreateRoomPayload,
  CreateRoomResult,
  PatchItemResult,
  PatchPayload,
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
  if (serialized !== undefined && options.maxChars !== undefined && serialized.length > options.maxChars) {
    throw new CollabApiError(413, oversizeMessage(serialized.length, options.maxChars));
  }

  const response = await fetch(path, { method, headers, body: serialized });
  if (!response.ok) throw await parseError(response);
  return (await response.json()) as T;
}

export const collabApi = {
  createRoom(payload: CreateRoomPayload): Promise<CreateRoomResult> {
    return request('POST', '/api/rooms', { body: payload, maxChars: MAX_CREATE_CHARS });
  },

  getRoom(roomId: string, password: string): Promise<RoomSnapshot> {
    return request('GET', `/api/rooms/${encodeURIComponent(roomId)}`, { password });
  },

  /** 差量提交：updates / adds / deletes 三个都可选，服务端只写被提到的那些行 */
  patchAvatars(roomId: string, password: string, payload: PatchPayload): Promise<PatchResult> {
    return request('PATCH', `/api/rooms/${encodeURIComponent(roomId)}/avatars`, {
      password,
      body: payload,
      maxChars: MAX_PATCH_CHARS,
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

  /** 底图上传完成后的回执确认（画布尺寸一并更新，它就是底图尺寸） */
  confirmBase(
    roomId: string,
    password: string,
    payload: { key?: string; name: string; type: string; width: number; height: number },
  ): Promise<{ ok: boolean; doc: { width: number; height: number } }> {
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

/**
 * 单次请求的体积上限（字符数）。
 * 这是**传输**边界（云函数请求体上限 6MB，留出余量），不是"一次能改多少个头像"的限制：
 * 改得再多也只是自动切成几个请求，一条都不会丢。
 */
export const MAX_PATCH_CHARS = 4_000_000;

/** 建房是真正的一次性全量（一间全新的房），请求体上限与后端 readJsonBody 默认值对齐 */
export const MAX_CREATE_CHARS = 5 * 1024 * 1024;

function oversizeMessage(chars: number, limit: number): string {
  return `这次要传的内容约 ${formatBytes(chars)}，超过单次请求的 ${formatBytes(limit)} 上限：把自定义图压小一点再试`;
}

/**
 * 建房前的体积预检：超了返回一句人话，没问题返回 null。
 * 只用在"发布"上 —— 那是唯一一次真的要把整间房发过去的操作。
 */
export function fullSubmitTooLarge(payload: unknown, limit = MAX_CREATE_CHARS): string | null {
  let chars = 0;
  try {
    chars = JSON.stringify(payload)?.length ?? 0;
  } catch {
    return null; // 序列化都失败的话交给真正的请求去报错，别在这儿吞掉
  }
  return chars > limit ? oversizeMessage(chars, limit) : null;
}

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
 * 按体积把一批条目切成几个请求（内嵌皮肤是 base64，一张高清自定义图可能几百 KB）。
 * 只按体积切，不按条数卡人：条数上限交给"一间房最多几行"这个真实边界。
 * 单条就超限的也独立成块（会由服务端的 413 拒掉并给出人话提示），绝不悄悄丢掉。
 */
export function chunkBySize<T>(items: T[], maxChars = MAX_PATCH_CHARS): T[][] {
  const chunks: T[][] = [];
  let current: T[] = [];
  let size = 2; // "[]" 本身
  for (const item of items) {
    const itemSize = JSON.stringify(item).length + (current.length > 0 ? 1 : 0);
    if (current.length > 0 && size + itemSize > maxChars) {
      chunks.push(current);
      current = [];
      size = 2;
    }
    current.push(item);
    size += itemSize;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/** 把多批提交的结果合成一份，供上层统一回填基线与汇总提示 */
export function mergePatchResults(all: PatchResult[]): PatchItemResult[] {
  return all.flatMap((r) => r.results ?? []);
}
