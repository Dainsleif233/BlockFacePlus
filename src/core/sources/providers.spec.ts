import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  accountCandidatesFor,
  loadFirstAvailable,
  MUA_PROVIDER,
  resolveAccountSkin,
  type SkinCandidate,
  SkinLookupError,
  validateAccountName,
  validateMuaName,
} from './providers';

describe('validateAccountName', () => {
  it('接受 3-16 位的字母、数字与下划线', () => {
    expect(validateAccountName('Notch')).toBe('Notch');
    expect(validateAccountName('  jeb_  ')).toBe('jeb_');
    expect(validateAccountName('Player_12345')).toBe('Player_12345');
    expect(validateAccountName('abc')).toBe('abc');
    expect(validateAccountName('1234567890123456')).toBe('1234567890123456');
  });

  it('拒绝空输入或全空格', () => {
    expect(() => validateAccountName('')).toThrow(SkinLookupError);
    expect(() => validateAccountName('   ')).toThrow(SkinLookupError);
  });

  it('拒绝过短或过长的名字', () => {
    expect(() => validateAccountName('ab')).toThrow(SkinLookupError);
    expect(() => validateAccountName('12345678901234567')).toThrow(SkinLookupError);
  });

  it('拒绝包含特殊字符或中文的名字', () => {
    expect(() => validateAccountName('Player-One')).toThrow(SkinLookupError);
    expect(() => validateAccountName('史蒂夫')).toThrow(SkinLookupError);
    expect(() => validateAccountName('Notch!')).toThrow(SkinLookupError);
    expect(() => validateAccountName('hello world')).toThrow(SkinLookupError);
  });
});

describe('validateMuaName', () => {
  it('与正版 ID 同一套规则：字母、数字与下划线，3-16 位', () => {
    expect(validateMuaName('UpSGE')).toBe('UpSGE');
    expect(validateMuaName('  Dainsleif_233  ')).toBe('Dainsleif_233');
  });

  it('空输入报的是 MUA 的提示，不是正版账号的提示', () => {
    expect(() => validateMuaName('')).toThrow('请输入 MUA 联合认证 ID');
    expect(() => validateMuaName('   ')).toThrow(SkinLookupError);
  });

  it('拒绝会把上游路径拼歪的名字', () => {
    expect(() => validateMuaName('../etc/passwd')).toThrow(SkinLookupError);
    expect(() => validateMuaName('UpSGE?x=1')).toThrow(SkinLookupError);
    expect(() => validateMuaName('UpSGE/extra')).toThrow(SkinLookupError);
    expect(() => validateMuaName('ab')).toThrow(SkinLookupError);
  });

  it('来源标签是给人看的，不该是域名', () => {
    expect(MUA_PROVIDER).toBe('MUA 联合认证');
  });
});

describe('loadFirstAvailable', () => {
  it('第一个候选地址成功时立即返回该结果与提供商', () => {
    const candidates: SkinCandidate[] = [
      { url: 'https://cdn.example.com/skin1', provider: 'Primary' },
      { url: 'https://cdn.example.com/skin2', provider: 'Secondary' },
    ];
    const loader = vi.fn(async (cand: SkinCandidate) => ({ loadedUrl: cand.url }));

    return expect(loadFirstAvailable(candidates, loader)).resolves.toEqual({
      result: { loadedUrl: 'https://cdn.example.com/skin1' },
      provider: 'Primary',
    });
  });

  it('前置候选地址失败时自动按优先级降级到后续地址', async () => {
    const candidates: SkinCandidate[] = [
      { url: 'https://cdn.example.com/bad1', provider: 'ProviderA' },
      { url: 'https://cdn.example.com/bad2', provider: 'ProviderB' },
      { url: 'https://cdn.example.com/good', provider: 'ProviderC' },
    ];
    const loader = vi.fn(async (cand: SkinCandidate) => {
      if (cand.provider !== 'ProviderC') {
        throw new Error('404 Not Found');
      }
      return { ok: true };
    });

    const result = await loadFirstAvailable(candidates, loader);
    expect(result).toEqual({
      result: { ok: true },
      provider: 'ProviderC',
    });
    expect(loader).toHaveBeenCalledTimes(3);
  });

  it('所有来源均失败时抛出 SkinLookupError 并汇总各源错误', async () => {
    const candidates: SkinCandidate[] = [
      { url: 'https://cdn.example.com/bad1', provider: 'ProviderA' },
      { url: 'https://cdn.example.com/bad2', provider: 'ProviderB' },
    ];
    const loader = vi.fn(async () => {
      throw new Error('网络连接超时');
    });

    await expect(loadFirstAvailable(candidates, loader)).rejects.toThrow(SkinLookupError);
  });
});

describe('resolveAccountSkin', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('playerdb 返回正版皮肤时标记 resolved=true 并提供 textures 官方源', async () => {
    const mockResponse = {
      ok: true,
      json: async () => ({
        data: {
          player: {
            username: 'Notch',
            skin_texture: 'http://textures.minecraft.net/texture/292009a4925b58f02c77ada41065095870d21f37e600d8caa4db1476db8b090',
          },
        },
      }),
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockResponse as unknown as Response);

    const resolution = await resolveAccountSkin('notch');
    expect(resolution.resolved).toBe(true);
    expect(resolution.displayName).toBe('Notch');
    expect(resolution.candidates[0].provider).toBe('textures.minecraft.net');
    expect(resolution.candidates[0].url).toContain('https://textures.minecraft.net');
  });

  it('playerdb 异常或超时时走离线降级方案并标记 resolved=false', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('Network error'));

    const resolution = await resolveAccountSkin('Steve');
    expect(resolution.resolved).toBe(false);
    expect(resolution.displayName).toBe('Steve');
    expect(resolution.candidates.length).toBeGreaterThanOrEqual(2);
    expect(resolution.candidates.map((c) => c.provider)).toEqual(['mc-heads.net', 'minotar.net']);
    // 网络不通只是"查不通"，镜像兜底照常可用
    expect(resolution.notFound).toBe(false);
  });

  it('playerdb 明确回答 4xx 时标记 notFound，不再退回镜像', async () => {
    // minotar 对不存在的名字会返回一张 200 的默认皮肤，退回去就是"假成功"：
    // 用户账号拼错了，却看到一张 Steve 被当成自己的皮肤贴上去。
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({ ok: false, status: 400 } as unknown as Response);

    const resolution = await resolveAccountSkin('zzzzzzzzzzzzzzzz');
    expect(resolution.resolved).toBe(false);
    expect(resolution.notFound).toBe(true);
    expect(accountCandidatesFor(resolution)).toEqual([]);
  });

  it('429 限流只算查不通，仍保留镜像候选', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({ ok: false, status: 429 } as unknown as Response);

    const resolution = await resolveAccountSkin('Notch');
    expect(resolution.notFound).toBe(false);
    expect(accountCandidatesFor(resolution).length).toBeGreaterThan(0);
  });

  it('查无此人时才清空候选，查得到时原样返回', async () => {
    const resolved = {
      displayName: 'Notch',
      resolved: true,
      notFound: false,
      candidates: [{ url: 'https://textures.minecraft.net/texture/x', provider: 'textures.minecraft.net' }],
    };
    expect(accountCandidatesFor(resolved)).toHaveLength(1);
  });
});
