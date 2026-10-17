/*!
 * BlockFace+ · 协同房间 API 客户端
 * Copyright 2026 Dainsleif · Apache License 2.0
 *
 * 后端是独立部署的 FastAPI（普通 VPS），前端产物留在边缘 Pages，
 * 所以每个请求都要带上 VITE_API_BASE_URL 前缀；为空表示同源（本地开发经 Vite 代理）。
 * 密码走自定义头，绝不进 URL；底图字节走 multipart 直接传到这里，没有预签名直传那一步。
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
  RoomBaseImage,
  RoomDoc,
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

/**
 * 后端地址前缀：由构建期变量注入，末尾多余的斜杠一律去掉（拼接时统一由这里补 '/'）。
 * 空字符串 = 同源，请求打成实打实的 '/api/...'，交给 Vite 代理或反向代理。
 */
export const API_BASE: string = ((import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '').replace(/\/+$/, '');

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

  const response = await fetch(API_BASE + path, { method, headers, body: serialized });
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

  /**
   * 上传 / 更换底图：一次 multipart 请求搞定，画布尺寸随底图一起更新（它就是底图尺寸）。
   * 这是"新建房间时的首图"与"管理员换底图"共用的唯一入口。
   */
  async uploadBase(
    roomId: string,
    password: string,
    file: Blob,
    meta: { name: string; type: string; width: number; height: number },
  ): Promise<{ ok: true; doc: RoomDoc; baseImage: RoomBaseImage }> {
    const form = new FormData();
    // Blob 本身没有名字与 MIME：文件名必须走 append 的第三个参数（否则一律写成 "blob"，
    // 中文名和后缀都丢），MIME 缺失时用调用方给的 meta.type 补上。
    const part = file.type ? file : new Blob([file], { type: meta.type });
    form.append('file', part, meta.name);
    form.append('name', meta.name);
    form.append('width', String(meta.width));
    form.append('height', String(meta.height));

    const response = await fetch(`${API_BASE}/api/rooms/${encodeURIComponent(roomId)}/base`, {
      method: 'POST',
      // 只带密码头：Content-Type 交给浏览器自己写，boundary 必须和 body 是一套
      headers: { [PASSWORD_HEADER]: password },
      body: form,
    });
    if (!response.ok) throw await parseError(response);
    return (await response.json()) as { ok: true; doc: RoomDoc; baseImage: RoomBaseImage };
  },

  /** 拉底图字节；调用方负责转成可用的图片对象 */
  async fetchBase(roomId: string, password: string): Promise<{ blob: Blob; name: string; type: string }> {
    const response = await fetch(`${API_BASE}/api/rooms/${encodeURIComponent(roomId)}/base`, {
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
 * 单次请求的体积上限。单位是 JSON.stringify 出来的**字符串长度**（UTF-16 码元），不是字节数 ——
 * 头像名里带中文时，实际发出的 UTF-8 字节会比这里数出来的多。所以这两层校验都只是「提前给个提示」，
 * 真正的边界始终是服务端的 BF_MAX_JSON_BODY_BYTES（默认 64MiB，见 docs/collab-api.md 第 4 节），
 * 服务端那份 413 的 {"error": ...} 会被 UI 原样显示出来。
 *
 * PATCH 取 32MiB 是有意比服务端上限（64MiB）保守：它决定的是分块粒度，不是能力上限。
 * 这是**传输**边界，不是"一次能改多少个头像"的限制：
 * 改得再多也只是自动切成几个请求，一条都不会丢。
 */
export const MAX_PATCH_CHARS = 32 * 1024 * 1024;

/** 建房是真正的一次性全量（一间全新的房）：与后端 BF_MAX_JSON_BODY_BYTES 的默认值取齐，单位同上一段 */
export const MAX_CREATE_CHARS = 64 * 1024 * 1024;

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
 * 底图体积上限：与后端 BF_MAX_BASE_IMAGE_BYTES（50MiB）取齐。
 * 上传前先拦下来，否则几 MB 的底图要等整段上传完才由服务端回一句 413，
 * 大图上白白浪费一次完整的往返。
 */
export const MAX_BASE_IMAGE_BYTES = 50 * 1024 * 1024;

/** 把字节数说成人话，用于「底图 28.4MB，超过 50MB 上限」这类提示 */
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
