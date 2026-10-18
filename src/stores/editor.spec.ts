/*!
 * BlockFace — 给图片贴 Minecraft 头像
 * Copyright 2026 Dainsleif
 * Licensed under the Apache License, Version 2.0
 */

import { beforeEach, describe, expect, it } from 'vitest';
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
  undo,
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

  it('污染过的素材在提示里被点名，并给出两条可走的路', () => {
    const text = describeEncodeFailure([
      { name: '头像 1', skinLabel: 'UpSGE', tainted: true },
    ]);
    expect(text).toContain('头像 1');
    expect(text).toContain('UpSGE');
    expect(text).toContain('代理');
    expect(text).toContain('上传皮肤');
  });

  it('没被污染（只是编码不出来）时说的是重新载入，不甩锅给跨域', () => {
    const text = describeEncodeFailure([{ name: '头像 2', skinLabel: 'a.png', tainted: false }]);
    expect(text).toContain('头像 2');
    expect(text).toContain('重新载入');
    expect(text).not.toContain('代理');
  });

  it('没有失败项时返回空串，调用方可以直接拿来当 if 条件', () => {
    expect(describeEncodeFailure([])).toBe('');
  });
});
