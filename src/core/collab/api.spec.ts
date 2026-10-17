/*!
 * BlockFace+ · 协同 API 客户端单元测试
 * Copyright 2026 Dainsleif · Apache License 2.0
 *
 * 这里守的是"传输边界"：路径前缀、multipart 的形态、体积关口。
 * 不守"一次能改多少个头像" —— 条数不设限，只有请求体体积要切块。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  API_BASE,
  MAX_BASE_IMAGE_BYTES,
  MAX_CREATE_CHARS,
  MAX_PATCH_CHARS,
  chunkBySize,
  collabApi,
  fullSubmitTooLarge,
  mergePatchResults,
} from './api';
import type { AvatarUpdate } from './types';

function update(index: number, bodyChars: number): AvatarUpdate {
  return {
    id: 'layer-' + index,
    skin: {
      dataUrl: 'data:image/png;base64,' + 'A'.repeat(bodyChars),
      width: 16,
      height: 8,
    },
    expectSkinUpdatedAt: index,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** 把 fetch 换成只记录调用的桩，返回一份固定 JSON */
function stubFetch(body: unknown, status = 200): { url: string; init: RequestInit }[] {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal('fetch', vi.fn((url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(jsonResponse(body, status));
  }));
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('API_BASE 前缀', () => {
  it('没配 VITE_API_BASE_URL 时是空串（同源），路径仍是熟悉的 /api/...', () => {
    expect(API_BASE).toBe('');
  });

  it('所有端点都打在 /api 前缀上，房间号照旧做 URL 编码', async () => {
    const calls = stubFetch({ results: [] });
    const base = { name: 'b.png', type: 'image/png', width: 8, height: 8 };

    await collabApi.createRoom({ baseImage: base, layers: [], expiresDays: 7 });
    await collabApi.getRoom('r 1', 'pw');
    await collabApi.patchAvatars('r 1', 'pw', { deletes: ['l1'] });
    await collabApi.deleteRoom('r 1', 'pw');
    await collabApi.uploadBase('r 1', 'pw', new Blob(['x'], { type: 'image/png' }), base);
    await collabApi.fetchBase('r 1', 'pw');

    expect(calls.map((c) => c.url)).toEqual([
      '/api/rooms',
      '/api/rooms/r%201',
      '/api/rooms/r%201/avatars',
      '/api/rooms/r%201',
      '/api/rooms/r%201/base',
      '/api/rooms/r%201/base',
    ]);
    expect(calls.map((c) => c.init.method)).toEqual(['POST', 'GET', 'PATCH', 'DELETE', 'POST', undefined]);
    // 密码只走自定义头，任何情况下都不进 URL
    expect((calls[1].init.headers as Record<string, string>)['X-BF-Room-Pwd']).toBe('pw');
    expect(calls.every((c) => !c.url.includes('pw'))).toBe(true);
  });

  it('配了 VITE_API_BASE_URL 就拼在前面，末尾多余的斜杠被去掉', async () => {
    vi.stubEnv('VITE_API_BASE_URL', 'https://api.example.com///');
    vi.resetModules();
    const mod = await import('./api');
    expect(mod.API_BASE).toBe('https://api.example.com');

    const calls = stubFetch({});
    await mod.collabApi.getRoom('r1', 'pw');
    expect(calls[0].url).toBe('https://api.example.com/api/rooms/r1');
  });
});

describe('uploadBase', () => {
  const meta = { name: '底图.png', type: 'image/png', width: 1920, height: 1080 };
  const okBody = { ok: true, doc: { width: 1920, height: 1080 }, baseImage: meta };

  it('走 multipart，且绝不手写 Content-Type —— boundary 必须由浏览器生成', async () => {
    const calls = stubFetch(okBody);
    const result = await collabApi.uploadBase('room-1', 'pw', new Blob(['png-bytes'], { type: 'image/png' }), meta);

    expect(calls).toHaveLength(1);
    const { url, init } = calls[0];
    expect(url).toBe('/api/rooms/room-1/base');
    expect(init.method).toBe('POST');

    const headers = init.headers as Record<string, string>;
    expect(headers['X-BF-Room-Pwd']).toBe('pw');
    // 手写 Content-Type 会把 boundary 写死，后端解析 multipart 直接失败
    expect(Object.keys(headers)).toEqual(['X-BF-Room-Pwd']);

    const form = init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get('name')).toBe('底图.png');
    expect(form.get('width')).toBe('1920');
    expect(form.get('height')).toBe('1080');

    // 文件名只有走 append 的第三个参数才留得住：中文名与后缀都在
    const part = form.get('file') as File;
    expect(part.name).toBe('底图.png');
    expect(part.type).toBe('image/png');
    expect(await part.text()).toBe('png-bytes');

    expect(result).toEqual(okBody);
  });

  it('Blob 自带 MIME 为空时，用调用方给的 meta.type 补上', async () => {
    const calls = stubFetch({ ok: true, doc: { width: 4, height: 4 }, baseImage: { ...meta, name: 'b.webp', type: 'image/webp' } });
    const bare = new Blob(['webp-bytes']);
    expect(bare.type).toBe('');

    await collabApi.uploadBase('room-1', 'pw', bare, { name: 'b.webp', type: 'image/webp', width: 4, height: 4 });

    const part = (calls[0].init.body as FormData).get('file') as File;
    expect(part.name).toBe('b.webp');
    expect(part.type).toBe('image/webp');
  });

  it('服务端的人话错误原样抛出来（不是一句 Failed to fetch）', async () => {
    stubFetch({ error: '底图太大了' }, 413);
    await expect(collabApi.uploadBase('room-1', 'pw', new Blob(['x']), meta))
      .rejects.toMatchObject({ status: 413, message: '底图太大了' });
  });
});

describe('体积上限', () => {
  it('三个上限与后端 BF_* 默认值对齐', () => {
    // 这些数字要和 backend/src/bfp/config.py 的默认值、契约第 4 节那张表同时改
    expect(MAX_PATCH_CHARS).toBe(32 * 1024 * 1024);
    expect(MAX_CREATE_CHARS).toBe(64 * 1024 * 1024);
    expect(MAX_BASE_IMAGE_BYTES).toBe(50 * 1024 * 1024);
  });

  it('单批差量上限比建房上限小，留出余量', () => {
    expect(MAX_PATCH_CHARS).toBeLessThan(MAX_CREATE_CHARS);
  });

  it('正好等于上限也放行（后端判的是 > 上限）', () => {
    const limit = 200;
    const body = { a: 'x'.repeat(limit - 8) }; // {"a":"…"} = 6 + n + 2
    expect(JSON.stringify(body)).toHaveLength(limit);
    expect(fullSubmitTooLarge(body, limit)).toBeNull();
  });

  it('没超就放行', () => {
    expect(fullSubmitTooLarge({ layers: [update(1, 100)] }, 10_000)).toBeNull();
  });

  it('超了给一句人话，不是把 413 甩给用户', () => {
    const message = fullSubmitTooLarge({ layers: [update(1, 6_000_000)] }, 1000);
    expect(message).toBeTruthy();
    expect(message).toContain('上限');
    expect(message).toContain('压小');
  });

  it('序列化不了的内容不在这里吞掉（交给真正的请求去报错）', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(fullSubmitTooLarge(cyclic)).toBeNull();
  });

  it('差量体积超限时请求层直接抛 413，一个字节都不发出去', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const big: AvatarUpdate[] = [{ id: 'layer-1', skin: { dataUrl: 'data:image/png;base64,' + 'A'.repeat(MAX_PATCH_CHARS), width: 16, height: 8 } }];
    await expect(collabApi.patchAvatars('room1', 'pw', { updates: big })).rejects.toMatchObject({ status: 413 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('建房请求体积超限同样在本地拦下（后端上限 64MiB 不会白跑一趟）', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const big = {
      baseImage: { name: 'b.png', type: 'image/png', width: 1, height: 1 },
      layers: [{ skin: { dataUrl: 'data:image/png;base64,' + 'A'.repeat(MAX_CREATE_CHARS) } }],
      expiresDays: 7,
    };
    // 类型上 layers 不是合法草稿：这一条只验证"体积关口在发请求之前"
    await expect(collabApi.createRoom(big as never)).rejects.toMatchObject({ status: 413 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('chunkBySize', () => {
  it('空列表切成空数组', () => {
    expect(chunkBySize([])).toEqual([]);
  });

  it('总量小于上限时整批一块', () => {
    const updates = [update(1, 100), update(2, 100), update(3, 100)];
    const chunks = chunkBySize(updates, 10_000);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(3);
  });

  it('超限时按顺序分块，块内元素不重排不丢失', () => {
    const updates = Array.from({ length: 10 }, (_, i) => update(i + 1, 3000));
    const chunks = chunkBySize(updates, 8000);
    expect(chunks.length).toBeGreaterThan(1);
    const flat = chunks.flat().map((u) => u.id);
    expect(flat).toEqual(updates.map((u) => u.id));
    for (const chunk of chunks) {
      expect(JSON.stringify(chunk).length).toBeLessThanOrEqual(8000);
    }
  });

  it('体积很小的一大批不会因为条数被切开（没有 64 条这种莫名其妙的限制）', () => {
    const updates = Array.from({ length: 150 }, (_, i) => update(i + 1, 10));
    const chunks = chunkBySize(updates);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(150);
  });

  it('单条就超限的也要独立成块，不会丢掉', () => {
    const big = update(99, 50_000);
    const chunks = chunkBySize([update(1, 100), big, update(2, 100)], 1000);
    expect(chunks).toHaveLength(3);
    expect(chunks.flat().map((u) => u.id)).toEqual(['layer-1', 'layer-99', 'layer-2']);
  });
});

describe('mergePatchResults', () => {
  it('把多批结果按顺序拼起来', () => {
    expect(mergePatchResults([
      { results: [{ id: 'a', ok: true }, { id: 'b', ok: false, error: 'conflict' }] },
      { results: [{ id: 'c', ok: true }] },
    ])).toEqual([{ id: 'a', ok: true }, { id: 'b', ok: false, error: 'conflict' }, { id: 'c', ok: true }]);
  });

  it('没带 results 的响应当空处理，不会炸', () => {
    expect(mergePatchResults([{} as never])).toEqual([]);
  });
});
