/*!
 * BlockFace+ · 协同 API 的页内 mock（仅供 e2e 使用）
 * Copyright 2026 Dainsleif · Apache License 2.0
 *
 * 应用代码绝不 import 这个文件；只有 tools/e2e*.js 会动态 import('/src/dev/collabMock.ts')。
 * 生产构建因无人引用而整体摇掉。
 *
 * 用一段内存状态模拟云函数 + Blob 的关键语义：
 *  - 密码头定角色（编辑者/管理员），错密码 401；
 *  - 头像行的差量提交：updates（可带 layout / skin）/ adds / deletes，逐条返回结果；
 *  - 两个版本戳分开管：换皮肤只看 skinUpdatedAt，挪位置只看 layoutUpdatedAt，
 *    所以"别人在挪位置"不会把你的换皮肤判成冲突（反之亦然）；
 *  - 全量覆盖那条老路（PUT /api/rooms/<id>）已经拆掉：一被调用就记录在案并回 405；
 *  - 底图字节走"预签名 URL"（/mock-upload），confirm 后房间变 ready，只改 base 不动任何头像行。
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
  skinUpdatedAt: number;
  layoutUpdatedAt: number;
}

export interface CollabMockOptions {
  roomId: string;
  editPassword: string;
  adminPassword: string;
  doc: { width: number; height: number };
  baseImage: { name: string; type: string; width: number; height: number } | null;
  baseBlob?: Blob | null;
  avatars?: MockAvatar[];
  /**
   * 初始是否就绪。默认 true（直进房间的编辑者/管理员阶段用）；
   * 发布自测阶段传 false，房间从 draft 起步，走真实的"上传→confirm→ready"生命周期。
   */
  startReady?: boolean;
}

export interface CollabMock {
  /** 所有打进 mock 的请求（时间序） */
  calls: { method: string; path: string; password: string | null; body: unknown; bytes: number }[];
  /** 协议违规（编辑者带了布局字段、PATCH 多带字段之类） */
  violations: string[];
  /** 实时房间状态 */
  state: {
    roomId: string;
    doc: { width: number; height: number };
    status: 'draft' | 'ready';
    avatars: MockAvatar[];
    /** 当前底图信息（换底图后更新） */
    baseImage: { name: string; type: string; width: number; height: number; key?: string } | null;
    /** 当前底图字节（直传后更新） */
    baseBlob: Blob | null;
    deleted: boolean;
    uploadedBytes: number;
    /** 收下的一串差量原文（差量会按体积拆成多个请求，所以这里是一串而不是一条） */
    patches: { updates: Record<string, unknown>[]; adds: Record<string, unknown>[]; deletes: string[] }[];
    /** PATCH 次数 */
    patchCount: number;
    /** PUT 全量同步被调用的次数（应当永远是 0） */
    putCalls: number;
  };
  /** 动态改行为：让下一次 PATCH 的更新全部返回 conflict */
  setConflictAll(on: boolean): void;
  /** 清空已收下的差量（每次点提交前调一次，好按"这一次提交"来断言） */
  resetPatches(): void;
  /** 把它们汇总成一次提交的样子 */
  patchSummary(): { updates: Record<string, unknown>[]; adds: Record<string, unknown>[]; deletes: string[] };
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
    status: options.startReady === false ? 'draft' : options.baseBlob ? 'ready' : 'draft',
    avatars: (options.avatars ?? []).map((a) => ({ ...a })),
    baseImage: options.baseImage ? { ...options.baseImage } : null,
    baseBlob: options.baseBlob ?? null,
    deleted: false,
    uploadedBytes: 0,
    patches: [],
    patchCount: 0,
    putCalls: 0,
  };

  const roomInfo = () => ({
    roomId: state.roomId,
    doc: state.doc,
    baseImage: state.baseImage,
    createdAt: Date.now() - 60_000,
    expiresAt: Date.now() + 7 * 24 * 3600 * 1000,
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
      if (rawBody instanceof Blob) state.baseBlob = rawBody; // 直传的字节落进"存储"，GET base 能取回
      return json({ ok: true });
    }

    // ---- 创建房间（发布流程，集合路径没有 id 段，不要求密码） ----
    if (method === 'POST' && path === '/api/rooms') {
      const payload = body as { layers?: unknown[]; baseImage?: { type?: string }; expiresDays?: number };
      if (!payload || !Array.isArray(payload.layers) || payload.layers.length === 0) {
        return json({ error: '至少先摆一个头像再发布' }, 400);
      }
      if (payload.expiresDays !== 3 && payload.expiresDays !== 7 && payload.expiresDays !== 14) {
        return json({ error: '过期时间只认 3/7/14 天' }, 400);
      }
      if (state.status === 'draft' && !options.baseBlob) {
        return json({ error: 'mock 缺底图' }, 400);
      }
      const ext = (payload.baseImage?.type ?? 'image/png') === 'image/jpeg' ? 'jpg' : 'png';
      return json({
        roomId: state.roomId,
        editPassword: options.editPassword,
        adminPassword: options.adminPassword,
        expiresAt: Date.now() + (payload.expiresDays ?? 7) * 24 * 3600 * 1000,
        upload: { url: '/mock-upload', key: 'rooms/' + state.roomId + '/images/base.' + ext, expiresAt: Math.floor(Date.now() / 1000) + 3600 },
      });
    }

    const match = path.match(/^\/api\/rooms\/([^/]+)(\/(avatars|base))?$/);
    if (!match) return json({ error: 'mock 没实现这个路由：' + method + ' ' + path }, 404);
    const [, id, tailRaw] = match;
    const tail = tailRaw ? tailRaw.slice(1) : ''; // 捕获组带前导斜杠，剥掉统一比较
    if (id !== state.roomId) return json({ error: 'mock 里没有这个房间' }, 404);

    if (state.deleted) return json({ error: '房间已删除' }, 410);

    const role = roleOf(password);
    if (!role) return json({ error: '密码不对，或房间已过期' }, 401);

    // ---- 房间信息 ----
    if (method === 'GET' && !tail) {
      const sorted = [...state.avatars].sort((a, b) => a.order - b.order);
      return json({ room: roomInfo(), avatars: sorted, role });
    }

    // ---- 全量覆盖（已废弃）：一被调用就记在案，回 405 ----
    if (method === 'PUT' && !tail) {
      state.putCalls += 1;
      return json({ error: '改头像请用 PATCH /api/rooms/[id]/avatars' }, 405);
    }

    // ---- 头像行的差量提交 ----
    if (method === 'PATCH' && tail === 'avatars') {
      const payload = body as { updates?: Record<string, unknown>[]; adds?: Record<string, unknown>[]; deletes?: string[] };
      const updates = Array.isArray(payload?.updates) ? payload.updates : [];
      const adds = Array.isArray(payload?.adds) ? payload.adds : [];
      const deletes = Array.isArray(payload?.deletes) ? payload.deletes : [];
      state.patches.push({ updates, adds, deletes });
      state.patchCount += 1;

      if (role !== 'admin' && (adds.length > 0 || deletes.length > 0)) {
        return json({ error: '只有管理员能增加或删除头像' }, 403);
      }
      if (state.status !== 'ready') return json({ error: '房间还没发布完成' }, 400);

      const results: { id: string; ok: boolean; error?: string; skinUpdatedAt?: number; layoutUpdatedAt?: number }[] = [];
      const now = Date.now();

      for (const update of updates) {
        const uid = String(update.id ?? '');
        for (const key of Object.keys(update)) {
          if (!['id', 'skin', 'layout', 'expectSkinUpdatedAt', 'expectLayoutUpdatedAt'].includes(key)) {
            violations.push('PATCH 多带了字段 ' + key + '（只允许 id/skin/layout/两个 expect*）');
          }
        }
        const avatar = state.avatars.find((a) => a.id === uid);
        if (!avatar) { results.push({ id: uid, ok: false, error: 'not-found' }); continue; }

        const layout = role === 'admin' && update.layout && typeof update.layout === 'object'
          ? (update.layout as Record<string, unknown>)
          : null;
        if (role !== 'admin' && update.layout) violations.push('编辑者 PATCH 带了 layout（' + uid + '）');
        const hasLayout = !!layout && Object.keys(layout).length > 0;
        const hasSkin = update.skin !== undefined;
        if (!hasLayout && !hasSkin) { results.push({ id: uid, ok: true, skinUpdatedAt: avatar.skinUpdatedAt, layoutUpdatedAt: avatar.layoutUpdatedAt }); continue; }

        if (hasLayout && (conflictAll || update.expectLayoutUpdatedAt !== avatar.layoutUpdatedAt)) {
          results.push({ id: uid, ok: false, error: 'conflict' });
          continue;
        }
        if (hasSkin && (conflictAll || update.expectSkinUpdatedAt !== avatar.skinUpdatedAt)) {
          results.push({ id: uid, ok: false, error: 'conflict' });
          continue;
        }
        if (hasLayout) { Object.assign(avatar, layout); avatar.layoutUpdatedAt = now; }
        if (hasSkin) { avatar.skin = update.skin as MockAvatar['skin']; avatar.skinUpdatedAt = now; }
        results.push({ id: uid, ok: true, skinUpdatedAt: avatar.skinUpdatedAt, layoutUpdatedAt: avatar.layoutUpdatedAt });
      }

      for (const add of adds) {
        const aid = String(add.id ?? '');
        if (state.avatars.some((a) => a.id === aid)) { results.push({ id: aid, ok: false, error: 'exists' }); continue; }
        state.avatars.push({ ...(add as unknown as MockAvatar), skinUpdatedAt: now, layoutUpdatedAt: now });
        results.push({ id: aid, ok: true, skinUpdatedAt: now, layoutUpdatedAt: now });
      }

      for (const did of deletes) {
        const at = state.avatars.findIndex((a) => a.id === did);
        if (at >= 0) state.avatars.splice(at, 1);
        results.push({ id: did, ok: true });
      }

      return json({ results });
    }

    // ---- 删除房间 ----
    if (method === 'DELETE' && !tail) {
      if (role !== 'admin') return json({ error: '只有管理员能删除房间' }, 403);
      state.deleted = true;
      return json({ ok: true });
    }

    // ---- 底图 ----
    if (method === 'GET' && tail === 'base') {
      if (state.status !== 'ready' || !state.baseBlob) return json({ error: '底图还没就绪' }, 404);
      return new Response(state.baseBlob, {
        status: 200,
        headers: {
          'Content-Type': state.baseImage?.type ?? 'image/png',
          'X-BF-Base-Name': encodeURIComponent(state.baseImage?.name ?? 'base.png'),
        },
      } as ResponseInit);
    }
    if (method === 'POST' && tail === 'base') {
      const payload = body as { intent?: string; type?: string; name?: string; key?: string; width?: number; height?: number };
      if (payload?.intent === 'sign') {
        if (role !== 'admin') return json({ error: '只有管理员能换底图' }, 403);
        const ext = (payload.type ?? 'image/png') === 'image/jpeg' ? 'jpg' : 'png';
        // 固定键：同一间房同一个后缀只对应一个键，重传就是覆盖
        return json({ upload: { url: '/mock-upload', key: 'rooms/' + state.roomId + '/images/base.' + ext, expiresAt: Math.floor(Date.now() / 1000) + 600 } });
      }
      if (payload?.intent === 'confirm') {
        // 草稿期编辑者密码可确认；房间就绪后只有管理员能换底图，且 key 必须是那种固定键
        if (state.status === 'ready') {
          if (role !== 'admin') return json({ error: '只有管理员能更换底图' }, 403);
          const prefix = 'rooms/' + state.roomId + '/images/base.';
          if (typeof payload.key !== 'string' || !payload.key.startsWith(prefix)) {
            return json({ error: '缺少待确认的底图' }, 400);
          }
        }
        state.status = 'ready';
        state.doc = { width: payload.width ?? state.doc.width, height: payload.height ?? state.doc.height };
        state.baseImage = {
          name: typeof payload.name === 'string' ? payload.name : state.baseImage?.name ?? '底图',
          type: typeof payload.type === 'string' ? payload.type : state.baseImage?.type ?? 'image/png',
          width: payload.width ?? state.doc.width,
          height: payload.height ?? state.doc.height,
          key: typeof payload.key === 'string' ? payload.key : state.baseImage?.key,
        };
        return json({ ok: true, doc: state.doc });
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
    resetPatches(): void {
      state.patches = [];
    },
    patchSummary(): { updates: Record<string, unknown>[]; adds: Record<string, unknown>[]; deletes: string[] } {
      return {
        updates: state.patches.flatMap((p) => p.updates),
        adds: state.patches.flatMap((p) => p.adds),
        deletes: state.patches.flatMap((p) => p.deletes),
      };
    },
  };
}
