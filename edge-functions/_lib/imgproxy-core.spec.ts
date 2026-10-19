/*!
 * BlockFace — 给图片贴 Minecraft 头像
 * Copyright 2026 Dainsleif
 * Licensed under the Apache License, Version 2.0
 *
 * 只测纯逻辑：白名单判定、错误码、上游失败怎么归一。真取图与真实 CORS 行为交给浏览器
 * （`pnpm dev` 的同一份中间件 + tools/e2e.js），这里不碰网络。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ALLOWED_HOSTS, MAX_BYTES, methodNotAllowed, optionsResponse, proxyImage, resolveTarget } from './imgproxy-core';

/** 造一个上游响应；默认是一张正常 PNG */
function upstream(body: BodyInit | null = 'png-bytes', init: ResponseInit = {}) {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'image/png' },
    ...init,
  });
}

function stubFetch(impl: (url: string) => Response | Promise<Response>) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    return impl(url);
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('resolveTarget：能代取什么，不能代取什么', () => {
  it('白名单内的 https 地址放行', () => {
    const resolved = resolveTarget('https://skin.mualliance.ltd/api/union/skin/byname/xiaoming');
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.target.hostname).toBe('skin.mualliance.ltd');
  });

  it('白名单就是这三个皮肤源 —— 多一个都是别人能白嫖带宽的口子', () => {
    expect([...ALLOWED_HOSTS]).toEqual(['skin.mualliance.ltd', 'textures.minecraft.net', 'minotar.net']);
  });

  it('白名单外的主机 403，且理由里点名是哪个主机', () => {
    const resolved = resolveTarget('https://example.com/a.png');
    expect(resolved).toMatchObject({ ok: false, status: 403 });
    if (!resolved.ok) expect(resolved.error).toContain('example.com');
  });

  it('只收 https：http 会被混合内容拦掉，也能拿来打内网明文服务', () => {
    expect(resolveTarget('http://skin.mualliance.ltd/x.png')).toMatchObject({ ok: false, status: 400 });
  });

  it('带账号密码的地址拒绝 —— 凭据不该进日志', () => {
    expect(resolveTarget('https://a:b@skin.mualliance.ltd/x.png')).toMatchObject({ ok: false, status: 400 });
  });

  it('缺参数与非法地址都是 400，不是 500', () => {
    expect(resolveTarget(null)).toMatchObject({ ok: false, status: 400 });
    expect(resolveTarget('not a url')).toMatchObject({ ok: false, status: 400 });
  });

  it('主机名大小写不影响判定', () => {
    expect(resolveTarget('https://SKIN.MUALLIANCE.LTD/x.png').ok).toBe(true);
  });
});

describe('proxyImage：上游的各种坏法都要归一成一个能读的错误', () => {
  it('成功时代取字节，并带上可读像素所需的响应头', async () => {
    stubFetch(() => upstream('png-bytes'));
    const response = await proxyImage('https://skin.mualliance.ltd/api/union/skin/byname/xiaoming');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    // ACAO 是"浏览器能不能读像素"的唯一开关，缺了这张图就白代理
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('cache-control')).toContain('max-age');
    expect(await response.text()).toBe('png-bytes');
  });

  it('上游 404/500 都归一成 502，不把上游状态码原样透给前端', async () => {
    for (const status of [404, 500]) {
      stubFetch(() => new Response('nope', { status, headers: { 'content-type': 'text/html' } }));
      const response = await proxyImage('https://skin.mualliance.ltd/api/union/skin/byname/Steve');
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({ error: '上游返回 ' + status });
    }
  });

  it('上游回 HTML 错误页时拒绝转发 —— 让浏览器把它当图片解，报错会更难懂', async () => {
    stubFetch(() => new Response('<html>500</html>', { status: 200, headers: { 'content-type': 'text/html' } }));
    const response = await proxyImage('https://skin.mualliance.ltd/x');
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: '上游返回的不是图片' });
  });

  it('空响应体与超限体积都算失败', async () => {
    stubFetch(() => upstream(''));
    expect((await proxyImage('https://minotar.net/x.png')).status).toBe(502);

    stubFetch(() => upstream('x', { headers: { 'content-type': 'image/png', 'content-length': String(MAX_BYTES + 1) } }));
    // 构造真实超限字节太重，这里直接造一个够长的 buffer
    stubFetch(() => upstream(new Uint8Array(MAX_BYTES + 1)));
    expect((await proxyImage('https://minotar.net/x.png')).status).toBe(502);
  });

  it('连不上上游是 502，超时是 504 —— 两者对用户的意义不同', async () => {
    stubFetch(() => { throw new TypeError('Failed to fetch'); });
    expect((await proxyImage('https://minotar.net/x.png')).status).toBe(502);

    stubFetch(() => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); });
    const response = await proxyImage('https://minotar.net/x.png');
    expect(response.status).toBe(504);
  });

  it('上游把我们重定向到白名单外时不再往回转', async () => {
    // Response.url 只读，只能靠构造一个 url 不同的响应来模拟"跟随重定向之后落到别处"
    const redirected = upstream('png-bytes');
    Object.defineProperty(redirected, 'url', { value: 'https://evil.example.com/x.png' });
    stubFetch(() => redirected);
    const response = await proxyImage('https://minotar.net/x.png');
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: '上游重定向到了不允许的主机' });
  });

  it('校验失败时一次上游请求都不发', async () => {
    const calls = stubFetch(() => upstream());
    expect((await proxyImage('https://example.com/a.png')).status).toBe(403);
    expect(calls).toHaveLength(0);
  });
});

describe('预检与方法限制', () => {
  it('OPTIONS 只有 GET/OPTIONS，且带 ACAO', () => {
    const response = optionsResponse();
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(response.headers.get('access-control-allow-methods')).toBe('GET, OPTIONS');
  });

  it('非 GET 一律 405 并带 Allow', async () => {
    const response = methodNotAllowed('POST');
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET, OPTIONS');
    expect(await response.json()).toEqual({ error: '不支持 POST：这个端点只读' });
  });
});