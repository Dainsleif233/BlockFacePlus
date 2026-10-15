/*!
 * BlockFace+ · 协同 API 的页内 mock（仅供 e2e 使用）
 * Copyright 2026 Dainsleif · Apache License 2.0
 *
 * 应用代码绝不 import 这个文件；只有 tools/e2e*.js 会动态 import('/src/dev/collabMock.ts')。
 * 生产构建因无人引用而整体摇掉。
 *
 * 用一段内存状态模拟云函数 + Blob 的关键语义：
 *  - 密码头定角色（编辑者/管理员），错密码 401、编辑者改布局 403；
 *  - PATCH 只收 {id, skin, expectUpdatedAt}，乱带位置字段记协议违规；
 *  - expectUpdatedAt 对不上逐条返回 conflict（模拟"别人刚改过"）；
 *  - PUT 全量同步校验 ifRevision，对不上 409；
 *  - 底图字节走"预签名 URL"（/mock-upload），confirm 后房间变 ready。
 */

interface MockAvatar {
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
  order: number;
  skin: {
    dataUrl: string;
    width: number;
    height: number;
    frontOnly?: boolean;
  } | null;
  updatedAt: number;
}

export interface CollabMockOptions {
  roomId: string;
  editPassword: string;
  adminPassword: string;
  doc: { width: number; height: number };
  baseImage: { name: string; type: string; width: number; height: number } | null;
  baseBlob?: Blob | null;
  avatars?: MockAvatar[];
  /** 初始 revision（默认 3） */
  revision?: number;
}

export interface CollabMock {
  /** 所有打进 mock 的请求（时间序） */
  calls: { method: string; path: string; password: string | null; body: unknown; bytes: number }[];
  /** 协议违规（PATCH 带了位置字段之类） */
  violations: string[];
  /** 实时房间状态 */
  state: {
    roomId: string;
    doc: { width: number; height: number };
    status: 'draft' | 'ready';
    revision: number;
    avatars: MockAvatar[];
    deleted: boolean;
    uploadedBytes: number;
    /** PATCH 收到的最近一次 updates 原文 */
    lastPatchUpdates: unknown[] | null;
    /** PUT 收到的最近一次全量 layers 原文与 ifRevision */
    lastPut: { layers: unknown[]; ifRevision: number | undefined } | null;
  };
  /** 动态改行为：让下一次 PATCH 全部返回 conflict */
  setConflictAll(on: boolean): void;
}

function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

export function installCollabMock(options: CollabMockOptions): CollabMock {
  const calls: CollabMock['calls'] = [];
  const violations: string[] = [];
  let conflictAll = false;

  const state: CollabMock['state'] = {
    roomId: options.roomId,
    doc: { ...options.doc },
    status: options.baseBlob ? 'ready' : 'draft',
    revision: options.revision ?? 3,
    avatars: (options.avatars ?? []).map((a) => ({ ...a })),
    deleted: false,
    uploadedBytes: 0,
    lastPatchUpdates: null,
    lastPut: null,
  };

  const roomInfo = () => ({
    roomId: state.roomId,
    doc: state.doc,
    baseImage: options.baseImage,
    createdAt: Date.now() - 60_000,
    expiresAt: Date.now() + 7 * 24 * 3600 * 1000,
    revision: state.revision,
    status: state.status,
  });

  const roleOf = (password: string | null): 'editor' | 'admin' | null => {
    if (password === options.adminPassword) return 'admin';
    if (password === options.editPassword) return 'editor';
    return null;
  };

  async function readBody(init: RequestInit | undefined): Promise<unknown> {
    if (!init || init.body === undefined || init.body === null) return null;
    if (typeof init.body === 'string') {
      try { return JSON.parse(init.body); } catch { return init.body; }
    }
    return init.body;
  }

  function byteCount(body: unknown): number {
    if (typeof body === 'string') return body.length;
    if (body instanceof Blob) return body.size;
    return 0;
  }

  async function route(method: string, path: string, password: string | null, body: unknown, rawBody: RequestInit['body']): Promise<Response> {
    if (path === '/mock-upload' && method === 'PUT') {
      state.uploadedBytes = byteCount(rawBody);
      return json({ ok: true });
    }

        // ---- 创建房间（发布流程，集合路径没有 id 段） ----
    if (method === 'POST' && path === '/api/rooms') {
      const payload = body as { layers?: unknown[]; doc?: { width: number; height: number }; expiresDays?: number };
      if (!payload || !Array.isArray(payload.layers) || payload.layers.length === 0) {
        return json({ error: '至少先摆一个头像再发布' }, 400);
      }
      if (payload.expiresDays !== 3 && payload.expiresDays !== 7 && payload.expiresDays !== 14) {
        return json({ error: '过期时间只认 3/7/14 天' }, 400);
      }
      return json({
        roomId: state.roomId,
        editPassword: options.editPassword,
        adminPassword: options.adminPassword,
        expiresAt: Date.now() + (payload.expiresDays ?? 7) * 24 * 3600 * 1000,
        upload: { url: '/mock-upload', key: 'rooms/' + state.roomId + '/images/base.png', expiresAt: Math.floor(Date.now() / 1000) + 3600 },
      });
    }
const match = path.match(/^\/api\/rooms\/([^/]+)(\/(avatars|base))?$/);
    if (!match) return json({ error: 'mock 没实现这个路由：' + method + ' ' + path }, 404);
    const [, id, tailRaw] = match;
    const tail = tailRaw ? tailRaw.slice(1) : ''; // 捕获组带前导斜杠，剥掉统一比较
    if (id !== state.roomId) return json({ error: 'mock 里没有这个房间' }, 404);

    // ---- 创建房间（发布流程） ----
    if (method === 'POST' && path === '/api/rooms') {
      const payload = body as { layers?: unknown[]; doc?: { width: number; height: number }; expiresDays?: number };
      if (!payload || !Array.isArray(payload.layers) || payload.layers.length === 0) {
        return json({ error: '至少先摆一个头像再发布' }, 400);
      }
      if (payload.expiresDays !== 3 && payload.expiresDays !== 7 && payload.expiresDays !== 14) {
        return json({ error: '过期时间只认 3/7/14 天' }, 400);
      }
      if (state.status === 'draft' && !options.baseBlob) {
        return json({ error: 'mock 缺底图' }, 400);
      }
      return json({
        roomId: state.roomId,
        editPassword: options.editPassword,
        adminPassword: options.adminPassword,
        expiresAt: Date.now() + (payload.expiresDays ?? 7) * 24 * 3600 * 1000,
        upload: { url: '/mock-upload', key: 'rooms/' + state.roomId + '/images/base.png', expiresAt: Math.floor(Date.now() / 1000) + 3600 },
      });
    }

    if (state.deleted) return json({ error: '房间已删除' }, 410);

    const role = roleOf(password);
    if (!role) return json({ error: '密码不对，或房间已过期' }, 401);

    // ---- 房间信息 ----
    if (method === 'GET' && !tail) {
      const sorted = [...state.avatars].sort((a, b) => a.order - b.order);
      return json({ room: roomInfo(), avatars: sorted, role });
    }

    // ---- 编辑者/管理员增量 ----
    if (method === 'PATCH' && tail === 'avatars') {
      const payload = body as { updates?: Array<{ id: string; skin?: unknown; expectUpdatedAt?: number }> };
      const updates = payload && Array.isArray(payload.updates) ? payload.updates : [];
      state.lastPatchUpdates = updates;
      for (const update of updates) {
        const keys = Object.keys(update);
        for (const key of keys) {
          if (!['id', 'skin', 'expectUpdatedAt'].includes(key)) {
            violations.push('PATCH 多带了字段 ' + key + '（协议只允许 id/skin/expectUpdatedAt）');
          }
        }
      }
      if (state.status !== 'ready') return json({ error: '房间还没发布完成' }, 400);
      const results = updates.map((update) => {
        const avatar = state.avatars.find((a) => a.id === update.id);
        if (!avatar) return { id: update.id, ok: false, error: 'missing' };
        if (conflictAll || update.expectUpdatedAt !== avatar.updatedAt) {
          return { id: update.id, ok: false, error: 'conflict' };
        }
        avatar.skin = (update.skin ?? avatar.skin) as MockAvatar['skin'];
        avatar.updatedAt = Date.now();
        return { id: update.id, ok: true, updatedAt: avatar.updatedAt };
      });
      state.revision += 1;
      return json({ results, revision: state.revision });
    }

    // ---- 管理员全量同步 ----
    if (method === 'PUT' && !tail) {
      if (role !== 'admin') return json({ error: '只有管理员能改布局' }, 403);
      const payload = body as { layers?: unknown[]; ifRevision?: number };
      const layers = payload && Array.isArray(payload.layers) ? payload.layers : [];
      state.lastPut = { layers, ifRevision: payload?.ifRevision };
      if (payload?.ifRevision !== undefined && payload.ifRevision !== state.revision) {
        return json({ error: '房间刚被别人改过，请刷新后再提交' }, 409);
      }
      if (state.status !== 'ready') return json({ error: '房间还没发布完成' }, 400);
      state.avatars = (layers as MockAvatar[]).map((layer, index) => ({
        ...(layer as Omit<MockAvatar, 'updatedAt'>),
        updatedAt: Date.now(),
        order: typeof layer.order === 'number' ? layer.order : index,
      }));
      state.revision += 1;
      return json({ revision: state.revision });
    }

    // ---- 删除房间 ----
    if (method === 'DELETE' && !tail) {
      if (role !== 'admin') return json({ error: '只有管理员能删除房间' }, 403);
      state.deleted = true;
      return json({ ok: true });
    }

    // ---- 底图 ----
    if (method === 'GET' && tail === 'base') {
      if (state.status !== 'ready' || !options.baseBlob) return json({ error: '底图还没就绪' }, 404);
      return new Response(options.baseBlob, {
        status: 200,
        headers: {
          'Content-Type': options.baseImage?.type ?? 'image/png',
          'X-BF-Base-Name': encodeURIComponent(options.baseImage?.name ?? 'base.png'),
        },
      } as ResponseInit);
    }
    if (method === 'POST' && tail === 'base') {
      const payload = body as { intent?: string; type?: string; name?: string; width?: number; height?: number };
      if (payload?.intent === 'sign') {
        if (role !== 'admin') return json({ error: '只有管理员能换底图' }, 403);
        return json({ upload: { url: '/mock-upload', key: 'rooms/' + state.roomId + '/images/base-' + Date.now() + '.png', expiresAt: Math.floor(Date.now() / 1000) + 600 } });
      }
      if (payload?.intent === 'confirm') {
        state.status = 'ready';
        state.doc = { width: payload.width ?? state.doc.width, height: payload.height ?? state.doc.height };
        state.revision += 1;
        return json({ ok: true, doc: state.doc, revision: state.revision });
      }
      return json({ error: 'mock 不认识这个 base intent' }, 400);
    }

    return json({ error: 'mock 没实现：' + method + ' ' + path }, 404);
  }

  const realFetch = window.fetch.bind(window);
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input), window.location.href);
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const password = init?.headers && typeof init.headers === 'object' && !(init.headers instanceof Headers)
      ? ((init.headers as Record<string, string>)['X-BF-Room-Pwd'] ?? null)
      : null;
    // 只接管自己的命名空间，其余（静态资源、外链）全部透传给真实 fetch
    if (!url.pathname.startsWith('/api/') && url.pathname !== '/api/rooms' && url.pathname !== '/mock-upload') {
      return realFetch(input as RequestInfo, init);
    }
    const body = await readBody(init);
    calls.push({ method, path: url.pathname, password, body, bytes: byteCount(init?.body) });
    return route(method, url.pathname, password, body, init?.body ?? null);
  }) as typeof window.fetch;

  return {
    calls,
    violations,
    state,
    setConflictAll(on: boolean): void {
      conflictAll = on;
    },
  };
}
