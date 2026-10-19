/*!
 * BlockFace — 给图片贴 Minecraft 头像
 * Copyright 2026 Dainsleif
 * Licensed under the Apache License, Version 2.0
 *
 * 只测纯逻辑（默认模板长什么样、提示里怎么称呼它）。真取图交给浏览器，
 * 由 tools/e2e.js 覆盖。
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_PROXY_TEMPLATE, describeProxyTemplate, SELF_HOSTED_PROXY_TEMPLATE } from './proxyTemplate';

describe('proxyTemplate', () => {
  it('默认指向自建的 EdgeOne Makers 端点，且带 {url} 占位符', () => {
    // 占位符是必需的：web 服务器的查询串不能直接拼裸地址，applyProxy 会做 encodeURIComponent
    expect(SELF_HOSTED_PROXY_TEMPLATE).toContain('{url}');
    expect(new URL(SELF_HOSTED_PROXY_TEMPLATE.replace('{url}', '')).host).toBe('api.jsumc.fun');
    // 没设 VITE_IMG_PROXY_TEMPLATE 时用的就是它
    expect(DEFAULT_PROXY_TEMPLATE).toBe(SELF_HOSTED_PROXY_TEMPLATE);
  });

  it('提示文案里只留主机名，模板空着就说「未配置」', () => {
    expect(describeProxyTemplate('https://api.jsumc.fun/imgproxy?url={url}')).toBe('api.jsumc.fun');
    expect(describeProxyTemplate('')).toBe('未配置');
  });

  it('认不出来的模板原样返回，不抛错（它在错误路径上，不能再炸一次）', () => {
    expect(describeProxyTemplate('not a url')).toBe('not a url');
  });
});