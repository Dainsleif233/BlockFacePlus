/*!
 * BlockFace — 给图片贴 Minecraft 头像
 * Copyright 2026 Dainsleif
 * Licensed under the Apache License, Version 2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { AvatarLayer } from '../model/types';
import type { SkinTexture } from '../skin/texture';
import {
  clampRenderScale,
  composeDocument,
  renderBackground,
  MAX_CANVAS_EDGE,
  MAX_CANVAS_PIXELS,
} from './compose';
import type { HeadCache } from './headCache';

function createMockCanvas(width = 0, height = 0) {
  const ctx = {
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    drawImage: vi.fn(),
    fillRect: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    scale: vi.fn(),
    translate: vi.fn(),
    rotate: vi.fn(),
    createPattern: vi.fn(() => ({})),
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    globalAlpha: 1,
    imageSmoothingEnabled: true,
  };
  const canvas = {
    width,
    height,
    getContext: vi.fn((type: string) => (type === '2d' ? ctx : null)),
  };
  return { canvas: canvas as unknown as HTMLCanvasElement, ctx };
}

describe('clampRenderScale', () => {
  it('在安全范围内保持原缩放倍率不变', () => {
    // 默认文档 1280x800，scale = 1
    expect(clampRenderScale(1280, 800, 1)).toBe(1);
    // scale = 2 => 2560x1600 (4.096M pixels <= 16M, 2560 <= 4096)
    expect(clampRenderScale(1280, 800, 2)).toBe(2);
  });

  it('单边超出 MAX_CANVAS_EDGE 时钳位缩放倍率', () => {
    // 1280x800，如果缩放为 6x => 7680x4800，超过 4096
    // 限制为 4096 / 1280 = 3.2
    const clamped = clampRenderScale(1280, 800, 6);
    expect(clamped).toBeCloseTo(3.2, 5);
    expect(Math.round(1280 * clamped)).toBe(MAX_CANVAS_EDGE);
    expect(Math.round(800 * clamped)).toBeLessThanOrEqual(MAX_CANVAS_EDGE);
  });

  it('超高分辨率底图自动根据最大边长下调倍率', () => {
    // 8000x4000 的大底图，即使 desiredScale = 1，也必须被限制在 4096 以内
    const clamped = clampRenderScale(8000, 4000, 1);
    expect(clamped).toBeCloseTo(4096 / 8000, 5);
    expect(Math.round(8000 * clamped)).toBe(4096);
    expect(Math.round(4000 * clamped)).toBe(2048);
  });

  it('总像素超出 MAX_CANVAS_PIXELS 时钳位缩放倍率', () => {
    // 4000x4000（本身 16M 像素），若 desiredScale = 2 则达 64M 像素
    // 像素上限 16,777,216 => scale 限制为 sqrt(16777216 / 16000000) = 1.024
    const clamped = clampRenderScale(4000, 4000, 2);
    expect(clamped).toBeCloseTo(1.024, 4);
    const totalPixels = Math.round(4000 * clamped) * Math.round(4000 * clamped);
    expect(totalPixels).toBeLessThanOrEqual(MAX_CANVAS_PIXELS);
  });

  it('自定义 maxEdge 与 maxPixels 参数生效', () => {
    expect(clampRenderScale(1000, 1000, 2, 1500, 10000000)).toBe(1.5);
  });

  it('非法尺寸或倍率优雅返回 1', () => {
    expect(clampRenderScale(0, 800, 2)).toBe(1);
    expect(clampRenderScale(1280, -10, 2)).toBe(1);
    expect(clampRenderScale(1280, 800, 0)).toBe(1);
  });
});

describe('renderBackground 与动静分离缓存', () => {
  it('正确设置底图画布物理分辨率并重置变换', () => {
    const { canvas, ctx } = createMockCanvas();
    renderBackground(canvas, {
      width: 200,
      height: 100,
      scale: 2,
    });
    expect(canvas.width).toBe(400);
    expect(canvas.height).toBe(200);
    expect(ctx.setTransform).toHaveBeenCalledWith(1, 0, 0, 1, 0, 0);
    expect(ctx.clearRect).toHaveBeenCalledWith(0, 0, 400, 200);
  });

  it('composeDocument 传入匹配的 backgroundCanvas 时直接快速 blit', () => {
    const { canvas: bgCanvas } = createMockCanvas(100, 100);
    const { canvas: docCanvas, ctx: docCtx } = createMockCanvas();

    composeDocument(docCanvas, {
      width: 100,
      height: 100,
      backgroundCanvas: bgCanvas,
      items: [],
    });

    expect(docCanvas.width).toBe(100);
    expect(docCanvas.height).toBe(100);
    expect(docCtx.drawImage).toHaveBeenCalledWith(bgCanvas, 0, 0);
  });
});

describe('composeDocument 头像贴合', () => {
  // 离屏头像：开着帽层时画布大于正脸（外扩），关着时等于正脸。
  // composeDocument 按 head.width 与正脸比例居中贴合，正脸精确对齐 layer.size，帽沿溢出包围盒。
  const skin = { meta: { isCustomImage: false } } as SkinTexture;
  const baseLayer = {
    visible: true,
    x: 0,
    y: 0,
    size: 200,
    rotation: 0,
    opacity: 1,
    flipH: false,
    overlay: false,
  } as AvatarLayer;

  function composeHead(layer: AvatarLayer, scale = 1) {
    const { canvas, ctx } = createMockCanvas();
    const cache = {
      get: vi.fn((_skin: unknown, overlay: boolean, size: number) => {
        // Mock 采用 1.25 倍整除比例，验证外扩画布贴合居中几何
        const width = overlay ? Math.round(size * 1.25) : size;
        return { width, height: width };
      }),
    } as unknown as HeadCache;
    const head = cache.get(skin, layer.overlay, Math.round(layer.size * scale));
    composeDocument(canvas, { width: 600, height: 600, scale, items: [{ layer, skin }], cache });
    return { ctx, cache, head };
  }

  it('无帽层：离屏画布 = 正脸，直接按包围盒居中贴合', () => {
    const layer = { ...baseLayer, overlay: false } as AvatarLayer;
    const { ctx, head } = composeHead(layer);
    expect(ctx.drawImage).toHaveBeenCalledWith(head, -100, -100, 200, 200);
  });

  it('开帽层：按 head.width 比例缩放，外扩后仍以正脸中心贴合包围盒', () => {
    const layer = { ...baseLayer, overlay: true } as AvatarLayer;
    const { ctx, cache, head } = composeHead(layer);
    // head.width = 250（正脸 200，外扩至 250）→ 贴合矩形 = (-125,-125,250,250)
    expect(head.width).toBe(250);
    expect(cache.get).toHaveBeenCalledWith(skin, true, 200);
    expect(ctx.drawImage).toHaveBeenCalledWith(head, -125, -125, 250, 250);
  });

  it('开帽层 + 二倍导出：按输出设备像素取离屏头像，按正脸比例缩放保持文档贴合尺寸不变', () => {
    const layer = { ...baseLayer, overlay: true } as AvatarLayer;
    const { ctx, cache, head } = composeHead(layer, 2);
    expect(cache.get).toHaveBeenCalledWith(skin, true, 400);
    expect(head.width).toBe(500);
    expect(ctx.drawImage).toHaveBeenCalledWith(head, -125, -125, 250, 250);
  });
});
