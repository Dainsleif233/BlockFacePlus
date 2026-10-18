/*!
 * BlockFace — 给图片贴 Minecraft 头像
 * Copyright 2026 Dainsleif
 * Licensed under the Apache License, Version 2.0
 */

import { describeSkin, type SkinMeta } from '../skin/texture';

export interface LoadedImage {
  element: HTMLImageElement;
  width: number;
  height: number;
  /** 画布是否已被跨域污染：污染后 toBlob/toDataURL 会抛异常 */
  tainted: boolean;
  /** 实际加载成功的地址（可能是代理地址） */
  url: string;
}

export interface LoadOptions {
  /**
   * 跨域代理模板，`{url}` 会被替换为经过 encodeURIComponent 的原始地址。
   * 例：`https://images.weserv.nl/?url={url}`
   */
  proxyTemplate?: string | null;
  /** 是否优先使用 CORS 请求，默认 true */
  cors?: boolean;
  /** 单次加载超时时间（毫秒），默认 15000 */
  timeoutMs?: number;
}

/**
 * 皮肤贴图 CDN 会返回 http 形式的地址，页面在 https 下会被混合内容策略拦截，统一升级。
 */
export function normalizeTextureUrl(url: string): string {
  return url.replace(/^http:\/\/textures\.minecraft\.net/i, 'https://textures.minecraft.net');
}

export function applyProxy(template: string, url: string): string {
  return template.includes('{url}')
    ? template.replace('{url}', encodeURIComponent(url))
    : `${template}${encodeURIComponent(url)}`;
}

/**
 * 代理地址再加一个一次性参数。
 *
 * 代理失败有两种：上游真挂了（重试没用），和中间链路抖动（重试就好）。
 * 后一种实测能占到并发请求的四分之一，而且失败会被浏览器按 URL 记进负缓存 ——
 * 拿同一个地址立刻重试往往连请求都不发，所以换一个查询参数把缓存键改掉。
 */
export function withRetryMarker(url: string): string {
  const marker = `_bfretry=${Date.now().toString(36)}`;
  const hashIndex = url.indexOf('#');
  const head = hashIndex >= 0 ? url.slice(0, hashIndex) : url;
  const tail = hashIndex >= 0 ? url.slice(hashIndex) : '';
  return `${head}${head.includes('?') ? '&' : '?'}${marker}${tail}`;
}

/**
 * 走代理加载，失败再给一次机会。
 *
 * 为什么要重试：代理是第三方公共设施，冷启动和并发场景下 `Failed to fetch` 不是个例
 * （实测 8 个并发请求里有 2 个这样失败，串行则基本不失败）。
 * 不重试的代价很具体 —— 第 2 级失败会掉到第 3 级非 CORS 兜底，图能显示、
 * 但画布被污染，于是这张皮肤再也导不出来、也提交不进房间。
 */
async function loadProxied(proxyUrl: string, timeoutMs: number): Promise<HTMLImageElement> {
  try {
    return await loadOnce(proxyUrl, true, timeoutMs);
  } catch (firstError) {
    try {
      return await loadOnce(withRetryMarker(proxyUrl), true, timeoutMs);
    } catch {
      throw firstError;
    }
  }
}

function loadOnce(url: string, cors: boolean, timeoutMs = 15000): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      img.onload = null;
      img.onerror = null;
    };

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        cleanup();
        img.src = '';
        reject(new Error(`加载图片超时（${timeoutMs}ms）：${url}`));
      }, timeoutMs);
    }

    if (cors) img.crossOrigin = 'anonymous';
    img.onload = () => {
      cleanup();
      if (!img.naturalWidth || !img.naturalHeight) {
        reject(new Error('图片内容为空'));
        return;
      }
      resolve(img);
    };
    img.onerror = () => {
      cleanup();
      reject(new Error(`无法加载图片：${url}`));
    };
    img.src = url;
  });
}

/**
 * 加载一张跨域图片。
 *
 * 三级策略，保证「能显示就尽量显示，能导出就尽量可导出」：
 * 1. 直接以 CORS 方式加载（首选，画布不被污染，可导出）
 * 2. 失败且配置了代理 → 通过代理加载
 * 3. 仍失败 → 退回非 CORS 加载（能看见，但画布被污染，导出前必须提示用户）
 */
export async function loadImage(rawUrl: string, options: LoadOptions = {}): Promise<LoadedImage> {
  const url = normalizeTextureUrl(rawUrl.trim());
  if (!url) throw new Error('地址为空');
  const useCors = options.cors !== false;
  const timeoutMs = options.timeoutMs ?? 15000;

  try {
    const element = await loadOnce(url, useCors, timeoutMs);
    return { element, width: element.naturalWidth, height: element.naturalHeight, tainted: false, url };
  } catch (primaryError) {
    if (options.proxyTemplate) {
      try {
        const proxied = applyProxy(options.proxyTemplate, url);
        const element = await loadProxied(proxied, timeoutMs);
        return { element, width: element.naturalWidth, height: element.naturalHeight, tainted: false, url: proxied };
      } catch {
        /* 落到下一级 */
      }
    }
    try {
      const element = await loadOnce(url, false, timeoutMs);
      return { element, width: element.naturalWidth, height: element.naturalHeight, tainted: true, url };
    } catch {
      throw primaryError;
    }
  }
}

/** 校验皮肤图片尺寸是否可渲染 */
export function inspectLoadedSkin(image: LoadedImage): SkinMeta {
  return describeSkin(image.width, image.height);
}
