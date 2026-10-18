/*!
 * BlockFace — 给图片贴 Minecraft 头像
 * Copyright 2026 Dainsleif
 * Licensed under the Apache License, Version 2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LoadedImage } from '../core/sources/imageLoader';
import {
  addLayer,
  clearUnusedSkins,
  collectRoomPayload,
  describeEncodeFailure,
  editor,
  getSkin,
  registerSkin,
  removeLayer,
  removeSkin,
  retryTaintedSkins,
  setCollabHooks,
  undo,
  updateAppearance,
  updateLayer,
} from './editor';

function createMockLoadedImage(width = 64, height = 64): LoadedImage {
  return {
    element: {} as HTMLImageElement,
    width,
    height,
    tainted: false,
    url: 'mock://skin.png',
  };
}

/** 一张"读不到像素"的素材：tainted 为真、带可重取的源地址 */
function createTaintedLoadedImage(url = 'https://example.test/skin.png'): LoadedImage {
  return { element: {} as HTMLImageElement, width: 64, height: 64, tainted: true, url };
}

describe('editor store - 素材管理与历史栈保护', () => {
  beforeEach(() => {
    editor.layers = [];
    editor.selectedId = null;
    clearUnusedSkins(); // 清理上一轮测试遗留的闲置素材
  });

  it('内置皮肤不允许删除', () => {
    const result = removeSkin('builtin-steve');
    expect(result).toBe(false);
  });

  it('正在被画布图层使用的素材不允许删除', () => {
    const custom = registerSkin(createMockLoadedImage(), 'upload', '测试皮肤1', '上传', 'skin-test-1');
    addLayer(custom.id);

    const deleted = removeSkin(custom.id);
    expect(deleted).toBe(false);
    expect(getSkin(custom.id)).not.toBeNull();
  });

  it('图层删除进入撤销历史后，素材仍受历史保护不可删除，undo 后素材完好', () => {
    const custom = registerSkin(createMockLoadedImage(), 'upload', '测试皮肤2', '上传', 'skin-test-2');
    const layer = addLayer(custom.id);

    // 删除图层，此时操作被压入 past 历史栈
    removeLayer(layer.id);
    expect(editor.layers.length).toBe(0);

    // 尝试删除该素材，应当被历史保护拦截
    const deleted = removeSkin(custom.id);
    expect(deleted).toBe(false);
    expect(getSkin(custom.id)).not.toBeNull();

    // 尝试批量清理闲置素材，由于该素材存在于历史栈中，也不应被清理
    const cleaned = clearUnusedSkins();
    expect(cleaned).toBe(0);
    expect(getSkin(custom.id)).not.toBeNull();

    // 撤销删除，图层重新回到画布，关联的素材完好存在
    undo();
    expect(editor.layers.length).toBe(1);
    expect(editor.layers[0].skinId).toBe(custom.id);
    expect(getSkin(editor.layers[0].skinId)).not.toBeNull();
  });

  it('没有任何图层或历史引用的真正闲置素材可以被正常清理', () => {
    const custom = registerSkin(createMockLoadedImage(), 'upload', '闲置皮肤', '上传', 'skin-unused-99');
    expect(getSkin(custom.id)).not.toBeNull();

    const cleaned = clearUnusedSkins();
    expect(cleaned).toBeGreaterThanOrEqual(1);
    expect(getSkin(custom.id)).toBeNull();
  });
});

describe('editor store - 新增头像在工作区中心自动缩放摆放', () => {
  beforeEach(() => {
    editor.layers = [];
    editor.selectedId = null;
    editor.document = { width: 1280, height: 800 };
    editor.view = { zoom: 1, autoFit: true, x: 0, y: 0, viewportWidth: 960, viewportHeight: 620 };
  });

  it('默认适应视图且未平移时，新头像放置在工作区中心（即画布正中），大小自适应工作区', () => {
    const custom = registerSkin(createMockLoadedImage(), 'upload', '测试头像1', '上传', 'skin-place-1');
    const layer = addLayer(custom.id);

    expect(layer.x).toBe(640);
    expect(layer.y).toBe(400);
    // 960x620 视口，1280x800 画布，fitScale = (620-44)/800 = 0.72
    // visibleHeight = 620 / 0.72 = 861.1, 861.1 * 0.35 ≈ 301
    expect(layer.size).toBeGreaterThan(200);
    expect(layer.size).toBeLessThan(400);
  });

  it('平移工作区后，新头像准确落在当前工作区中心所映射的文档位置', () => {
    editor.view.autoFit = false;
    editor.view.zoom = 1;
    // 画布向左平移 200px、向上平移 100px，工作区中心看到的是画布更靠右下的区域
    editor.view.x = -200;
    editor.view.y = -100;

    const custom = registerSkin(createMockLoadedImage(), 'upload', '测试头像2', '上传', 'skin-place-2');
    const layer = addLayer(custom.id);

    // docCenterX = 1280 / 2 - (-200) / 1 = 640 + 200 = 840
    // docCenterY = 800 / 2 - (-100) / 1 = 400 + 100 = 500
    expect(layer.x).toBe(840);
    expect(layer.y).toBe(500);
  });

  it('放大工作区后，新头像自动缩放保持在当前视野内的合适比例（尺寸在文档坐标下缩小）', () => {
    editor.view.autoFit = false;
    editor.view.zoom = 2; // 放大 2 倍
    editor.view.x = 0;
    editor.view.y = 0;

    const custom = registerSkin(createMockLoadedImage(), 'upload', '测试头像3', '上传', 'skin-place-3');
    const layer = addLayer(custom.id);

    // 视口尺寸 960x620，在 2 倍缩放下，可视范围为 480x310，310 * 0.35 ≈ 108
    expect(layer.size).toBe(109);
    expect(layer.x).toBe(640);
    expect(layer.y).toBe(400);
  });

  it('工作区大幅平移离开画布时，图层位置受 clamp 限制，至少保留部分在画布内可见', () => {
    editor.view.autoFit = false;
    editor.view.zoom = 1;
    editor.view.x = -9999;
    editor.view.y = -9999;

    const custom = registerSkin(createMockLoadedImage(), 'upload', '测试头像4', '上传', 'skin-place-4');
    const layer = addLayer(custom.id);

    expect(layer.x).toBeLessThan(1280 + layer.size);
    expect(layer.y).toBeLessThan(800 + layer.size);
    expect(layer.x).toBeGreaterThan(0);
    expect(layer.y).toBeGreaterThan(0);
  });

  it('传入显式 overrides 时尊重原有显式尺寸与坐标', () => {
    const custom = registerSkin(createMockLoadedImage(), 'upload', '测试头像5', '上传', 'skin-place-5');
    const layer = addLayer(custom.id, { x: 123, y: 456, size: 78 });

    expect(layer.x).toBe(123);
    expect(layer.y).toBe(456);
    expect(layer.size).toBe(78);
  });
});

describe('encode failure reporting', () => {
  beforeEach(() => {
    editor.layers = [];
    editor.selectedId = null;
    clearUnusedSkins();
  });

  it('皮肤位图画不出来时，载荷点名是哪个头像、哪张素材', () => {
    // element 不是真正的图片，drawImage 会抛，正好就是"无法编码"那条路
    const broken = registerSkin(createMockLoadedImage(), 'mua', 'UpSGE', 'MUA 联合认证', 'skin-broken');
    const layer = addLayer(broken.id);

    const payload = collectRoomPayload();
    expect(payload.failedSkins).toBe(1);
    expect(payload.failedSkinLayers).toHaveLength(1);
    expect(payload.failedSkinLayers[0].id).toBe(layer.id);
    expect(payload.failedSkinLayers[0].name).toBe(layer.name);
    expect(payload.failedSkinLayers[0].skinLabel).toBe('UpSGE');
  });

  it('全部编码成功时失败列表为空', () => {
    const payload = collectRoomPayload();
    expect(payload.failedSkins).toBe(0);
    expect(payload.failedSkinLayers).toEqual([]);
  });

  it('读不出像素的素材在提示里被点名，并给出两条能真正走通的路', () => {
    const text = describeEncodeFailure([
      { name: '头像 1', skinLabel: 'UpSGE', tainted: true },
    ]);
    expect(text).toContain('头像 1');
    expect(text).toContain('UpSGE');
    // 用户能做的只有这两件：重取一次，或把图存到本地再导入
    expect(text).toContain('重取');
    expect(text).toContain('上传皮肤');
  });

  it('提示里不出现实现术语 —— 那些词对用户没有可执行含义', () => {
    // "干净""污染""跨域""CORS""编码""代理模板"都曾是这里的话。用户看不懂，
    // 而且"配置代理模板"这个建议本身就是错的：界面上根本没有这个设置。
    const jargon = ['干净', '污染', '跨域', 'CORS', '编码', '代理', '画布'];
    for (const item of [{ tainted: true }, { tainted: false }]) {
      const text = describeEncodeFailure([{ name: '头像 3', skinLabel: 'x.png', ...item }]);
      for (const word of jargon) expect(text).not.toContain(word);
    }
  });

  it('读不出内容（与网站许可无关）时也只说该怎么办', () => {
    const text = describeEncodeFailure([{ name: '头像 2', skinLabel: 'a.png', tainted: false }]);
    expect(text).toContain('头像 2');
    expect(text).toContain('上传皮肤');
    expect(text).not.toContain('重取');
  });

  it('没有失败项时返回空串，调用方可以直接拿来当 if 条件', () => {
    expect(describeEncodeFailure([])).toBe('');
  });
});

describe('retryTaintedSkins —— 一次「完成」就要能把皮肤救回来', () => {
  beforeEach(() => {
    editor.layers = [];
    editor.selectedId = null;
    clearUnusedSkins();
  });

  it('第一次没取到干净图不算数，会接着再试', async () => {
    // 这条锁的是"点一次完成只保存一半"的根因：代理抖一下就会先失败一次。
    // 只试一次的话这张皮肤会被判为无法编码、跳过不提交，用户必须再点一次。
    const skin = registerSkin(createTaintedLoadedImage(), 'mua', 'UpSGE', 'MUA 联合认证', 'skin-retry-1');
    let attempts = 0;
    const fixed = await retryTaintedSkins(async () => {
      attempts += 1;
      // 前两次都掉回第 3 级兜底（tainted 仍为真），第三次才拿到干净图
      return attempts < 3 ? createTaintedLoadedImage() : createMockLoadedImage();
    });

    expect(attempts).toBe(3);
    expect(fixed).toBe(1);
    expect(getSkin(skin.id)?.tainted).toBe(false);
  });

  it('怎么试都拿不到干净图时如实回报换了几张（0），不假装成功', async () => {
    registerSkin(createTaintedLoadedImage(), 'mua', 'UpSGE', 'MUA 联合认证', 'skin-retry-2');
    let attempts = 0;
    const fixed = await retryTaintedSkins(async () => {
      attempts += 1;
      return createTaintedLoadedImage();
    });

    expect(fixed).toBe(0);
    expect(attempts).toBe(3);
  });

  it('取图直接抛错时按失败处理，不把异常甩给「完成」', async () => {
    registerSkin(createTaintedLoadedImage(), 'mua', 'UpSGE', 'MUA 联合认证', 'skin-retry-3');
    let attempts = 0;
    const fixed = await retryTaintedSkins(async () => {
      attempts += 1;
      throw new Error('无法加载图片');
    });

    expect(fixed).toBe(0);
    expect(attempts).toBe(3);
    expect(editor.busy).toBeNull();
  });

  it('已经是干净图的素材不会被打扰', async () => {
    registerSkin(createMockLoadedImage(), 'upload', '本地图', '上传', 'skin-retry-4');
    let attempts = 0;
    const fixed = await retryTaintedSkins(async () => {
      attempts += 1;
      return createMockLoadedImage();
    });

    expect(fixed).toBe(0);
    expect(attempts).toBe(0);
  });
});

describe('updateAppearance —— 外观域不经过布局闸口', () => {
  beforeEach(() => {
    editor.layers = [];
    editor.selectedId = null;
    clearUnusedSkins();
  });

  afterEach(() => {
    // 钩子是模块级单例，不摘掉会漏到后面的用例里
    setCollabHooks(null);
  });

  it('布局被冻结时外观照改，布局入口依旧被拒', () => {
    const custom = registerSkin(createMockLoadedImage(), 'upload', '测试皮肤9', '上传', 'skin-appearance-1');
    const layer = addLayer(custom.id);
    const asked: string[] = [];
    setCollabHooks({
      canMutateLayout(action: string): boolean {
        asked.push(action);
        return false;
      },
      onSkinApplied(): void {},
      isLayoutFrozen(): boolean {
        return true;
      },
    });

    updateLayer(layer.id, { x: 999 });
    expect(layer.x).not.toBe(999);

    updateAppearance(layer.id, { overlay: false, flipH: true });
    expect(layer.overlay).toBe(false);
    expect(layer.flipH).toBe(true);
    // 只有布局那一次问过闸口：外观不该被布局锁连带拦住
    expect(asked).toEqual(['edit']);
  });

  it('图层不存在时静默返回，不动画布也不抛错', () => {
    setCollabHooks(null);
    const before = editor.layers.length;
    expect(() => updateAppearance('layer-missing', { flipH: true })).not.toThrow();
    expect(editor.layers).toHaveLength(before);
  });

  it('外观改动进撤销历史，可以撤回', () => {
    setCollabHooks(null);
    const custom = registerSkin(createMockLoadedImage(), 'upload', '测试皮肤10', '上传', 'skin-appearance-2');
    const layer = addLayer(custom.id);
    expect(layer.overlay).toBe(true);
    updateAppearance(layer.id, { overlay: false });
    expect(editor.layers.find((l) => l.id === layer.id)?.overlay).toBe(false);
    undo();
    expect(editor.layers.find((l) => l.id === layer.id)?.overlay).toBe(true);
  });
});
