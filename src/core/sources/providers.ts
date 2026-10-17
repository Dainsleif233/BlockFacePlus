/*!
 * BlockFace — 给图片贴 Minecraft 头像
 * Copyright 2026 Dainsleif
 * Licensed under the Apache License, Version 2.0
 */

import alexSkinUrl from '../../assets/skins/alex.png';
import steveSkinUrl from '../../assets/skins/steve.png';
import { normalizeTextureUrl } from './imageLoader';

export interface SkinCandidate {
  url: string;
  provider: string;
}

export interface AccountResolution {
  /** 按优先级排列的候选贴图地址，调用方按顺序尝试直到成功 */
  candidates: SkinCandidate[];
  /** 服务端返回的规范玩家名（大小写） */
  displayName: string;
  /** 是否在正版档案中确认存在 */
  resolved: boolean;
}

/** 内置皮肤：随应用分发的真实默认皮肤贴图 */
export interface BuiltinSkin {
  id: string;
  name: string;
  description: string;
  url: string;
}

/**
 * 内置皮肤贴图取自 Mojang 官方材质服务（sessionserver 档案 → textures.minecraft.net），
 * 与正版默认皮肤逐像素一致。两张图都小于 4 KB，Vite 会把它们内联成 data URI，
 * 因此不存在跨域问题，也不会污染 canvas——纯前端、离线、file:// 打开都能正常导出。
 */
export const BUILTIN_SKINS: BuiltinSkin[] = [
  {
    id: 'steve',
    name: 'Steve',
    description: '经典默认皮肤',
    url: steveSkinUrl,
  },
  {
    id: 'alex',
    name: 'Alex',
    description: '纤细手臂默认皮肤',
    url: alexSkinUrl,
  },
];

export class SkinLookupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkinLookupError';
  }
}

const NAME_PATTERN = /^[A-Za-z0-9_]{3,16}$/;

export function validateAccountName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new SkinLookupError('请输入正版账号 ID');
  if (!NAME_PATTERN.test(trimmed)) {
    throw new SkinLookupError('正版 ID 只能包含字母、数字与下划线，长度 3–16 位');
  }
  return trimmed;
}

/** MUA 联合认证的皮肤地址在 skin.mualliance.ltd，这个名字会出现在素材来源与提示文案里 */
export const MUA_PROVIDER = 'MUA 联合认证';

/**
 * MUA 联合认证的角色名。
 *
 * 复用 /^[A-Za-z0-9_]{3,16}$/：Union 里的角色名就是 Minecraft 角色名，与正版 ID 同一套规则。
 * 挡的是"名字里塞进斜杠或问号、把上游路径拼歪"这类问题 ——
 * 这个地址是直接拼进 URL 的，不做校验等于让输入框去决定请求打到哪。
 */
export function validateMuaName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new SkinLookupError('请输入 MUA 联合认证 ID');
  if (!NAME_PATTERN.test(trimmed)) {
    throw new SkinLookupError('MUA 联合认证 ID 只能包含字母、数字与下划线，长度 3–16 位');
  }
  return trimmed;
}

interface PlayerDbPlayer {
  username?: string;
  skin_texture?: string;
}

/**
 * 查询正版账号的皮肤贴图地址。
 *
 * 为什么不用 Mojang 官方接口：`api.mojang.com` 与 `sessionserver.mojang.com` 实测
 * **不返回 Access-Control-Allow-Origin**，纯前端应用无法读取其响应（详见 docs/product-facts.md）。
 * 因此主路径用 playerdb.co（返回 CORS `*` 且附带 textures.minecraft.net 地址），
 * 备选 mc-heads.net / minotar.net；贴图 CDN 本身带 CORS，可直接绘入画布。
 */
function combineTimeoutSignal(
  timeoutMs: number,
  externalSignal?: AbortSignal,
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error(`请求超时（${timeoutMs}ms）`));
  }, timeoutMs);

  let onAbort: (() => void) | undefined;
  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort(externalSignal.reason);
    } else {
      onAbort = () => controller.abort(externalSignal.reason);
      externalSignal.addEventListener('abort', onAbort, { once: true });
    }
  }

  const cleanup = () => {
    clearTimeout(timer);
    if (externalSignal && onAbort) {
      externalSignal.removeEventListener('abort', onAbort);
    }
  };

  return { signal: controller.signal, cleanup };
}

export async function resolveAccountSkin(name: string, signal?: AbortSignal): Promise<AccountResolution> {
  const trimmed = validateAccountName(name);
  const fallback: SkinCandidate[] = [
    { url: `https://mc-heads.net/skin/${encodeURIComponent(trimmed)}`, provider: 'mc-heads.net' },
    { url: `https://minotar.net/skin/${encodeURIComponent(trimmed)}`, provider: 'minotar.net' },
  ];

  const { signal: fetchSignal, cleanup } = combineTimeoutSignal(6000, signal);
  try {
    const response = await fetch(`https://playerdb.co/api/player/minecraft/${encodeURIComponent(trimmed)}`, {
      signal: fetchSignal,
      headers: { Accept: 'application/json' },
    });
    if (response.ok) {
      const payload = (await response.json()) as { data?: { player?: PlayerDbPlayer } };
      const player = payload?.data?.player;
      if (player?.skin_texture) {
        return {
          displayName: player.username ?? trimmed,
          resolved: true,
          candidates: [
            { url: normalizeTextureUrl(player.skin_texture), provider: 'textures.minecraft.net' },
            ...fallback,
          ],
        };
      }
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    // 超时或网络异常不视为「不存在」，继续走备选服务
  } finally {
    cleanup();
  }

  return { displayName: trimmed, resolved: false, candidates: fallback };
}

/** 递归尝试候选地址，返回第一个成功加载的结果 */
export async function loadFirstAvailable<T>(
  candidates: SkinCandidate[],
  loader: (candidate: SkinCandidate) => Promise<T>,
): Promise<{ result: T; provider: string }> {
  const errors: string[] = [];
  for (const candidate of candidates) {
    try {
      const result = await loader(candidate);
      return { result, provider: candidate.provider };
    } catch (error) {
      errors.push(`${candidate.provider}: ${(error as Error).message}`);
    }
  }
  throw new SkinLookupError(`所有皮肤来源都失败了（${errors.join('；')}）`);
}
