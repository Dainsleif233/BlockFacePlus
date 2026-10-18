/*!
 * BlockFace+ · 协同房间状态中枢：外观域接线
 * Copyright 2026 Dainsleif · Apache License 2.0
 *
 * 这里测的是 collab.ts 里"接线"的那几处，不是差量算法本身（那是 diff.spec.ts 的事）：
 *  - 编辑者的外观锁 appearanceLocked 什么时候生效；
 *  - 进房快照怎么判断后端认不认识外观域；
 *  - 判定为老后端时，提交要不要改走兼容写法；
 *  - 服务端把外观静默丢掉之后，状态、文案、基线分别怎么收场。
 *
 * collab.ts 是模块级单例、还直接摸网络与编辑器，所以这里只把它下面那两层换掉：
 * editor 用一份最小假实现（保持 reactive，dirtyCount 依赖它），网络用 collabApi 上的 spy。
 * 房间状态本身则每个用例重新进一次房 —— 进房会重建基线，等于天然的 reset。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AvatarLayer } from '../core/model/types';
import type { PresetSkin } from '../core/model/preset';
import { collabApi } from '../core/collab/api';
import type {
  PatchItemResult,
  PatchPayload,
  RoomAvatarRecord,
  RoomRole,
  RoomSnapshot,
} from '../core/collab/types';
import type { CollabHooks } from './editor';

/** collab.ts 真正会从 editor 那里读的东西，只有这几样 */
interface FakeEditor {
  layers: AvatarLayer[];
  baseImageId: string | null;
  document: { width: number; height: number };
}

const env = vi.hoisted(() => ({
  /** 假的编辑器状态；下面 mock 出来的 editor 会在它外面套一层 reactive */
  editor: {
    layers: [] as AvatarLayer[],
    baseImageId: null as string | null,
    document: { width: 1280, height: 800 },
  },
  /** 套了 reactive 的那一份：读 dirtyCount 这类 computed 必须走它 */
  liveEditor: null as FakeEditor | null,
  /** collab.ts 发出去的所有 notify，按时间顺序 */
  notices: [] as { tone: string; message: string }[],
  /** collab.ts 在模块加载时注册进来的钩子（布局守卫就是通过它落到 editor 的） */
  hooks: null as CollabHooks | null,
  /** 假的 sessionStorage：密码得能存下来，否则提交入口会直接退回门禁 */
  passwords: new Map<string, string>(),
}));

vi.mock('./editor', async () => {
  const { reactive } = await import('vue');
  // 真 editor 的 state 就是 reactive 的，这里保持一致：dirtyCount 是 computed，不响应式会读到旧值
  const editor = reactive(env.editor);
  env.liveEditor = editor as unknown as FakeEditor;

  return {
    editor,
    notify(tone: string, message: string): void {
      env.notices.push({ tone, message });
    },
    setCollabHooks(hooks: CollabHooks): void {
      env.hooks = hooks;
    },
    /** 只做进房装载里与协同有关的那一步：把服务端行搬成画布图层 */
    async loadRoomDocument(_base: File, records: RoomAvatarRecord[]): Promise<{ fallbackSkins: number }> {
      editor.layers.splice(0, editor.layers.length);
      for (const record of records) {
        editor.layers.push({
          id: record.id,
          skinId: `skin-${record.id}`,
          name: record.name,
          x: record.x,
          y: record.y,
          size: record.size,
          rotation: record.rotation,
          opacity: record.opacity,
          overlay: record.overlay,
          flipH: record.flipH,
          visible: record.visible,
        });
      }
      return { fallbackSkins: 0 };
    },
    collectRoomPayload: () => ({ baseImage: null, baseFile: null }),
    describeEncodeFailure: () => '',
    /** 一张能编码的假皮肤：只要有 dataUrl，差量就会把 adds 发出去 */
    encodeLayerSkin: (layerId: string): PresetSkin => ({
      dataUrl: `data:image/png;base64,${layerId}`,
      width: 16,
      height: 8,
    }),
    getSkin: () => null,
    retryTaintedSkins: async () => 0,
  };
});

import { appearanceLocked, collab, dirtyCount, lastSubmitReport, submitChanges, submitGate } from './collab';

function record(over: Partial<RoomAvatarRecord> = {}): RoomAvatarRecord {
  return {
    id: 'srv-1',
    name: '头像一',
    x: 10,
    y: 20,
    size: 100,
    rotation: 0,
    opacity: 1,
    overlay: true,
    flipH: false,
    visible: true,
    order: 0,
    skin: null,
    skinUpdatedAt: 1000,
    layoutUpdatedAt: 2000,
    appearanceUpdatedAt: 1500,
    ...over,
  };
}

/**
 * 老后端返回的行：GET 里**根本没有** appearanceUpdatedAt 这个键。
 * 注意与"迁移过来的 0"区分 —— 0 是合法值，键缺失才说明这台后端不认识外观域。
 */
function legacyRecord(over: Partial<Omit<RoomAvatarRecord, 'appearanceUpdatedAt'>> = {}): RoomAvatarRecord {
  const raw: Record<string, unknown> = { ...record(), ...over };
  delete raw.appearanceUpdatedAt;
  return raw as unknown as RoomAvatarRecord;
}

function snapshotOf(role: RoomRole, avatars: RoomAvatarRecord[]): RoomSnapshot {
  return {
    room: {
      roomId: 'room-test',
      doc: { width: 1280, height: 800 },
      baseImage: { name: 'b.png', type: 'image/png', width: 1280, height: 800, preview: null },
      createdAt: 0,
      expiresAt: 0,
      status: 'ready',
    },
    avatars,
    role,
  };
}

/** 走一遍真实的进房流程（网络与装载都换成了假实现），顺便把基线建起来 */
async function enter(role: RoomRole, avatars: RoomAvatarRecord[]): Promise<void> {
  vi.spyOn(collabApi, 'getRoom').mockResolvedValue(snapshotOf(role, avatars));
  vi.spyOn(collabApi, 'fetchBase').mockResolvedValue({
    notModified: false,
    blob: new Blob(['png']),
    name: 'b.png',
    type: 'image/png',
    variant: 'preview',
    etag: null,
  });
  await submitGate('pwd');
  // 进房失败时后面的断言会变得莫名其妙，这里先在最前面挡住
  expect(collab.phase).toBe('ready');
}

/**
 * 接送出去的差量，并按顺序回放进准备好的回执。
 * 用队列而不是每个用例重新 spy：同一个用例里往往要连着提交两次（第一次被丢、第二次走兼容写法）。
 */
function stubPatches(...responses: PatchItemResult[][]): PatchPayload[] {
  const sent: PatchPayload[] = [];
  let call = 0;
  vi.spyOn(collabApi, 'patchAvatars').mockImplementation(async (_roomId, _password, payload) => {
    sent.push(payload);
    const results = responses[Math.min(call, responses.length - 1)];
    call += 1;
    return { results };
  });
  return sent;
}

/** 当前画布上第一个图层（多数用例只有一行） */
function firstLayer(): AvatarLayer {
  const layer = env.liveEditor?.layers[0];
  if (!layer) throw new Error('画布上没有图层，用例前提没成立');
  return layer;
}

beforeEach(() => {
  env.editor.layers.splice(0, env.editor.layers.length);
  env.editor.baseImageId = null;
  env.notices.length = 0;
  env.passwords.clear();
  // 房间状态是模块级单例：每个用例都回到"已进房"的干净起点，基线由用例自己进房时重建
  Object.assign(collab, {
    mode: 'room',
    phase: 'ready',
    roomId: 'room-test',
    role: null,
    room: null,
    message: '',
    submitting: false,
    busyLoading: false,
    publishOpen: false,
    basePreview: false,
    appearanceSupported: true,
  });
  vi.stubGlobal('window', {
    location: { search: '', pathname: '/', href: 'http://localhost/' },
    sessionStorage: {
      getItem: (key: string) => env.passwords.get(key) ?? null,
      setItem: (key: string, value: string) => {
        env.passwords.set(key, value);
      },
      removeItem: (key: string) => {
        env.passwords.delete(key);
      },
    },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('collab store - 外观锁 appearanceLocked', () => {
  it('编辑者遇上认识外观域的后端：外观不锁，帽子层与翻转照常可点', async () => {
    await enter('editor', [record()]);
    expect(collab.appearanceSupported).toBe(true);
    expect(appearanceLocked.value).toBe(false);
  });

  it('编辑者遇上老后端：外观退回锁态，不让开关假装能用', async () => {
    await enter('editor', [legacyRecord()]);
    expect(collab.appearanceSupported).toBe(false);
    expect(appearanceLocked.value).toBe(true);
  });

  it('管理员从不受外观锁约束：老后端上也要靠兼容写法把改动存住', async () => {
    await enter('admin', [legacyRecord()]);
    expect(appearanceLocked.value).toBe(false);
  });

  it('离线模式不锁', () => {
    Object.assign(collab, { mode: 'offline', role: null });
    expect(appearanceLocked.value).toBe(false);
  });
});

describe('collab store - 进房时判断后端认不认识外观域', () => {
  it('快照每行都带外观戳：判定为支持，进房提示里提得到帽子层与翻转', async () => {
    await enter('editor', [record()]);
    const message = env.notices.at(-1)?.message ?? '';
    expect(message).toContain('切帽子层');
    expect(message).toContain('水平翻转');
  });

  it('快照里没有这个键：判定为不支持，进房提示只提换头像内容', async () => {
    await enter('editor', [legacyRecord()]);
    const message = env.notices.at(-1)?.message ?? '';
    expect(collab.appearanceSupported).toBe(false);
    expect(message).not.toContain('切帽子层');
    expect(message).toContain('换内容');
  });

  it('布局被拦下的提示跟着能力走：老后端上不再承诺那两个开关', async () => {
    await enter('editor', [legacyRecord()]);
    expect(env.hooks?.canMutateLayout('move')).toBe(false);
    const message = env.notices.at(-1)?.message ?? '';
    expect(message).not.toContain('切帽子层');
    expect(message).toContain('这台服务器暂不支持');
  });

  it('布局被拦下的提示：支持外观域时照旧说明还能切帽子层', async () => {
    await enter('editor', [record()]);
    expect(env.hooks?.canMutateLayout('move')).toBe(false);
    expect(env.notices.at(-1)?.message ?? '').toContain('切帽子层');
  });

  it('管理员改布局不被拦', async () => {
    await enter('admin', [record()]);
    expect(env.hooks?.canMutateLayout('move')).toBe(true);
  });
});

describe('collab store - 提交时的外观域接线', () => {
  it('只翻帽子层：发 appearance 与外观并发凭证，布局一个键都不带', async () => {
    await enter('editor', [record()]);
    firstLayer().overlay = false;

    const sent = stubPatches([
      { id: 'srv-1', ok: true, skinUpdatedAt: 1000, layoutUpdatedAt: 2000, appearanceUpdatedAt: 4000 },
    ]);
    await submitChanges();

    expect(sent).toHaveLength(1);
    const update = sent[0].updates?.[0];
    expect(update?.appearance).toEqual({ overlay: false });
    expect(update?.expectAppearanceUpdatedAt).toBe(1500);
    // 编辑者的 layout 会被服务端整条忽略，外观绝不能混进去
    expect(update?.layout).toBeUndefined();
    expect(update?.expectLayoutUpdatedAt).toBeUndefined();
    expect(dirtyCount.value).toBe(0);
    expect(lastSubmitReport()).toContain('已保存 1 处改动');
  });

  it('进房就认出老后端：翻转并进 layout 发出去，不带任何外观键', async () => {
    await enter('admin', [legacyRecord()]);
    firstLayer().flipH = true;

    const sent = stubPatches([{ id: 'srv-1', ok: true, skinUpdatedAt: 1000, layoutUpdatedAt: 5000 }]);
    await submitChanges();

    const update = sent[0].updates?.[0];
    expect(update?.layout).toEqual({ flipH: true });
    expect(update?.expectLayoutUpdatedAt).toBe(2000);
    // 老后端不认这两个键：发过去只会被当成未知字段丢掉
    expect(update?.appearance).toBeUndefined();
    expect(update?.expectAppearanceUpdatedAt).toBeUndefined();
  });
});

describe('collab store - 服务端静默丢弃外观之后的降级兜底', () => {
  it('成功回执里没有外观戳：判定为老后端，提示说清没存上，基线不往前推', async () => {
    await enter('editor', [record()]);
    firstLayer().overlay = false;

    stubPatches([{ id: 'srv-1', ok: true, skinUpdatedAt: 1000, layoutUpdatedAt: 2000 }]);
    await submitChanges();

    expect(collab.appearanceSupported).toBe(false);
    // 两句话必须在同一条提示里：分开发的话前半句会被"已保存"覆盖掉
    const report = lastSubmitReport() ?? '';
    expect(report).toContain('已保存 1 处改动');
    expect(report).toContain('这台服务器还不支持单独保存帽子层与翻转');

    // 基线没推进，这一处仍然算待提交 —— 用户还有机会让它真的存上
    expect(dirtyCount.value).toBe(1);
  });

  it('下一次提交自动改用兼容写法，外观才真的落库', async () => {
    await enter('editor', [record()]);
    firstLayer().overlay = false;

    const sent = stubPatches(
      [{ id: 'srv-1', ok: true, skinUpdatedAt: 1000, layoutUpdatedAt: 2000 }],
      [{ id: 'srv-1', ok: true, skinUpdatedAt: 1000, layoutUpdatedAt: 6000 }],
    );
    await submitChanges();
    await submitChanges();

    expect(sent).toHaveLength(2);
    expect(sent[0].updates?.[0].appearance).toEqual({ overlay: false });
    // 第二次：编辑者依旧只想要这次外观改动，但它被并进了 layout
    const retry = sent[1].updates?.[0];
    expect(retry?.layout).toEqual({ overlay: false });
    expect(retry?.appearance).toBeUndefined();
    expect(dirtyCount.value).toBe(0);
  });

  it('全被冲突拒掉不算降级：什么都没落库，不该把新后端误判成老后端', async () => {
    await enter('editor', [record()]);
    firstLayer().overlay = false;

    stubPatches([{ id: 'srv-1', ok: false, error: 'conflict' }]);
    await submitChanges();

    expect(collab.appearanceSupported).toBe(true);
    expect(lastSubmitReport()).toContain('刚被别人改过');
    expect(dirtyCount.value).toBe(1);
  });

  it('空房间先加一行不会误判：这一轮压根没发外观，回执里自然也没有外观戳', async () => {
    // 空房间的快照无从判断能力，supportsAppearanceDomain([]) 只能按支持处理
    await enter('admin', []);
    expect(collab.appearanceSupported).toBe(true);

    env.liveEditor?.layers.push({
      id: 'layer-new',
      skinId: 'skin-x',
      name: '头像 1',
      x: 100,
      y: 100,
      size: 80,
      rotation: 0,
      opacity: 1,
      overlay: true,
      flipH: false,
      visible: true,
    });
    const sent = stubPatches(
      // 老后端支持 adds，但新增的行里没有外观域，回执当然不会带外观戳
      [{ id: 'layer-new', ok: true, skinUpdatedAt: 10, layoutUpdatedAt: 20 }],
      // 接着翻帽子层：这次真的发了 appearance，被老后端整条丢掉了
      [{ id: 'layer-new', ok: true, skinUpdatedAt: 10, layoutUpdatedAt: 20 }],
    );
    await submitChanges();
    expect(sent[0].adds).toHaveLength(1);
    expect(collab.appearanceSupported).toBe(true);
    expect(dirtyCount.value).toBe(0);

    const added = firstLayer();
    added.overlay = false;
    await submitChanges();

    expect(sent[1].updates?.[0].appearance).toEqual({ overlay: false });
    expect(collab.appearanceSupported).toBe(false);
    expect(dirtyCount.value).toBe(1);
    expect(lastSubmitReport()).toContain('这台服务器还不支持单独保存帽子层与翻转');
  });
});
