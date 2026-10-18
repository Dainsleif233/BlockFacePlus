/*!
 * BlockFace — 给图片贴 Minecraft 头像
 * Copyright 2026 Dainsleif
 * Licensed under the Apache License, Version 2.0
 *
 * 只测纯逻辑（代理模板拼址 / 重试标记）。真解码交给浏览器，
 * 由 tools/e2e.js 在真实环境里覆盖。
 */

import { describe, expect, it, vi } from 'vitest';
import { applyProxy, withRetryMarker } from './imageLoader';

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
