/*!
 * BlockFace — 给图片贴 Minecraft 头像
 * Copyright 2026 Dainsleif
 * Licensed under the Apache License, Version 2.0
 *
 * 只测纯逻辑（代理模板拼址 / 重试标记 / 哪一级会发请求）。真解码交给浏览器，
 * 由 tools/e2e.js 在真实环境里覆盖。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyProxy, loadImage, withRetryMarker } from './imageLoader';

describe('applyProxy', () => {
  it('模板里有 {url} 占位符就替换成编码后的地址', () => {
    const url = 'https://a.com/x y.png';
    expect(applyProxy('https://proxy.example/?url={url}', url)).toBe(
      'https://proxy.example/?url=' + encodeURIComponent(url),
    );
  });

  it('没有占位符就直接拼在末尾', () => {
    const url = 'https://a.com/x.png';
    expect(applyProxy('https://proxy.example/raw?u=', url)).toBe(
      'https://proxy.example/raw?u=' + encodeURIComponent(url),
    );
  });

  it('把地址里的查询串一并编码，否则代理会把 ? 当成自己的参数', () => {
    const url = 'https://a.com/x.png?token=1&sig=2';
    const proxied = applyProxy('https://proxy.example/?url=', url);
    expect(proxied).not.toContain('token=1&sig=2');
    expect(proxied).toBe('https://proxy.example/?url=' + encodeURIComponent(url));
  });
});

describe('withRetryMarker', () => {
  it('原本没有查询串时用 ? 接上标记', () => {
    expect(withRetryMarker('https://proxy.example/raw')).toMatch(
      /^https:\/\/proxy\.example\/raw\?_bfretry=[a-z0-9]+$/,
    );
  });

  it('已有查询串时用 & 接上，不破坏原有参数', () => {
    const marked = withRetryMarker('https://proxy.example/?url=abc');
    expect(marked.startsWith('https://proxy.example/?url=abc&_bfretry=')).toBe(true);
  });

  it('两次生成的标记不同 —— 否则浏览器会命中同一条失败缓存', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const first = withRetryMarker('https://proxy.example/raw');
      vi.setSystemTime(new Date('2026-01-01T00:00:01Z'));
      const second = withRetryMarker('https://proxy.example/raw');
      expect(first).not.toBe(second);
    } finally {
      vi.useRealTimers();
    }
  });

  it('把标记插在 # 之前，别把片段标识弄坏', () => {
    expect(withRetryMarker('https://proxy.example/raw#frag')).toMatch(
      /^https:\/\/proxy\.example\/raw\?_bfretry=[a-z0-9]+#frag$/,
    );
  });
});

/**
 * 记录「谁被真的请求了」。loadImage 的每一次尝试都经过 `new Image()`，
 * 所以把它换掉就能看清走了哪几级 —— 这是断言「砍掉的两级确实不再发请求」的唯一办法。
 */
function stubImages(respond: (url: string, cors: boolean) => 'ok' | 'fail') {
  const attempts: { url: string; cors: boolean }[] = [];
  class FakeImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    naturalWidth = 0;
    naturalHeight = 0;
    crossOrigin: string | null = null;
    private current = '';
    get src(): string {
      return this.current;
    }
    set src(value: string) {
      if (!value) return; // loadOnce 超时时会把 src 清空，那次不算请求
      this.current = value;
      const cors = this.crossOrigin === 'anonymous';
      attempts.push({ url: value, cors });
      const outcome = respond(value, cors);
      queueMicrotask(() => {
        if (outcome === 'ok') {
          this.naturalWidth = 64;
          this.naturalHeight = 64;
          this.onload?.();
        } else {
          this.onerror?.();
        }
      });
    }
  }
  vi.stubGlobal('Image', FakeImage);
  return attempts;
}

const MUA_URL = 'https://skin.mualliance.ltd/api/union/skin/byname/UpSGE';
// 用真实默认模板（同源相对路径）而不是编一个域名：拼址逻辑对相对路径同样成立，
// 而这里一旦换成绝对地址，测试就再也发现不了「默认模板变成跨域」这种回归
const PROXY = '/imgproxy?url={url}';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('loadImage 的 proxyOnly（MUA 入口用它）', () => {
  it('只打一次代理，既不 CORS 直取也不掉非 CORS 兜底', async () => {
    const attempts = stubImages(() => 'ok');
    const loaded = await loadImage(MUA_URL, { proxyTemplate: PROXY, proxyOnly: true });
    expect(attempts).toEqual([
      { url: '/imgproxy?url=' + encodeURIComponent(MUA_URL), cors: true },
    ]);
    expect(loaded.tainted).toBe(false);
    expect(loaded.width).toBe(64);
  });

  it('代理不通就报错 —— 绝不退化成「能看不能存」的污染图', async () => {
    const attempts = stubImages(() => 'fail');
    await expect(loadImage(MUA_URL, { proxyTemplate: PROXY, proxyOnly: true })).rejects.toThrow();
    // 代理自己重试过一次（第二次换了缓存键），但始终没碰过上游地址
    expect(attempts).toHaveLength(2);
    expect(attempts.every((a) => a.url.startsWith('/imgproxy'))).toBe(true);
    // 始终带上 crossOrigin：走代理图的就是可读像素，掉回非 CORS 就白代理了
    expect(attempts.every((a) => a.cors)).toBe(true);
    expect(attempts[1].url).toContain('_bfretry=');
  });

  it('没配代理时当场报错，而不是偷偷绕回直取', async () => {
    const attempts = stubImages(() => 'ok');
    await expect(loadImage(MUA_URL, { proxyOnly: true })).rejects.toThrow('代理');
    expect(attempts).toHaveLength(0);
  });

  it('不传 proxyOnly 时三级降级照旧（这是别的入口的行为，没被牵连）', async () => {
    // 直取 → 代理 → 代理重试 → 非 CORS 兜底：最后那次才是不要 CORS 的
    const attempts = stubImages((_url, cors) => (cors ? 'fail' : 'ok'));
    const loaded = await loadImage('https://a.com/x.png', { proxyTemplate: PROXY });
    expect(attempts.map((a) => a.cors)).toEqual([true, true, true, false]);
    expect(attempts[3].url).toBe('https://a.com/x.png');
    expect(loaded.tainted).toBe(true);
  });
});
