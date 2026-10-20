/*!
 * BlockFace — 给图片贴 Minecraft 头像
 * Copyright 2026 Dainsleif
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { FACE_PIXELS, HAT_REGIONS, HEAD_REGIONS, type Region } from '../skin/regions';
import type { SkinTexture } from '../skin/texture';

export interface HeadRenderOptions {
  /** 是否叠上帽子层（皮肤第二层，UV 同区域 x + 32） */
  overlay: boolean;
  /** 头像正脸边长（设备像素） */
  pixelSize: number;
  /** 强制指定高清倍率；缺省时从皮肤元信息推导 */
  scale?: number;
}

/**
 * 帽子层外壳：游戏内第二层每边外扩 0.5 基准像素（帽盒 9×9 对脸 8×8）。
 * 平面头像用它复现「外层比内层大一圈」：
 * - 帽子层正脸**整层**按 `(边长 + 2×帽沿) / 边长`（≈ 9/8）以最近邻采样放大，
 *   铺满外扩后的画布——外圈显示的是帽子层边缘 texel 的外侧半格（真实第二层内容），
 *   不是把边缘像素拉伸出来的环带；
 * - 底层正脸按 pixelSize 居中（1:1 铺满不含外扩的正脸区域），帽子层最后画（在脸之前）；
 * - 文档里的包围盒 / 命中测试仍按底层正脸 `layer.size` 计算，外圈刻意溢出包围盒。
 */
export const OVERLAY_SHELL = 0.5;

/** 帽沿在离屏画布上的设备像素宽度（至少 1px，避免小尺寸缩略图上外圈完全消失） */
export function hatRimPixels(pixelSize: number): number {
  return Math.max(1, Math.round((pixelSize * OVERLAY_SHELL) / FACE_PIXELS));
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function drawRegion(
  ctx: CanvasRenderingContext2D,
  skin: SkinTexture,
  region: Region,
  scale: number,
  dest: Rect,
): void {
  ctx.drawImage(
    skin.image,
    region[0] * scale,
    region[1] * scale,
    region[2] * scale,
    region[3] * scale,
    dest.x,
    dest.y,
    dest.w,
    dest.h,
  );
}

/**
 * 把头像的正脸渲染到一张离屏 canvas（正方形）。
 *
 * 平面正脸 = 皮肤贴图的正面 8×8 区域；高清皮肤按 `scale = 宽 / 64`
 * 折算源坐标，因此 64 / 128 / 256 / 512 走的是同一条代码路径。
 * 采样强制 nearest-neighbor（imageSmoothingEnabled = false）以保住像素边缘。
 *
 * 开着帽子层时（见 OVERLAY_SHELL）：先按 pixelSize 画底层正脸（居中），
 * 再把帽子层正脸整层放大铺满画布压在其上——与游戏内帽盒 9×9 对脸 8×8 的外扩一致。
 * 通用头像图片（isCustomImage）没有第二层语义，画布就是正脸本身。
 */
export function renderHeadCanvas(skin: SkinTexture, options: HeadRenderOptions): HTMLCanvasElement {
  const scale = options.scale ?? skin.meta.scale;
  const size = Math.max(1, Math.round(options.pixelSize));
  // 外扩只属于 Minecraft 双层皮肤；通用头像图片无第二层，保持等大
  const rim = options.overlay && !skin.meta.isCustomImage ? hatRimPixels(size) : 0;
  const side = size + rim * 2;

  const canvas = document.createElement('canvas');
  canvas.width = side;
  canvas.height = side;

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('当前浏览器不支持 Canvas 2D');

  if (skin.meta.isCustomImage) {
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    const imgWidth = skin.meta.width;
    const imgHeight = skin.meta.height;
    const aspect = imgWidth / imgHeight;
    let dw = side;
    let dh = side;
    let dx = 0;
    let dy = 0;
    if (aspect > 1) {
      dh = side / aspect;
      dy = (side - dh) / 2;
    } else if (aspect < 1) {
      dw = side * aspect;
      dx = (side - dw) / 2;
    }
    ctx.drawImage(skin.image, dx, dy, dw, dh);
    return canvas;
  }

  ctx.imageSmoothingEnabled = false;

  // frontOnly 预设：底层与帽子层正脸左右并排（16×8 或高清等比），区域换算成同一套基准坐标
  const [baseRegion, hatRegion]: [Region, Region] = skin.meta.frontOnly
    ? [[0, 0, 8, 8], [8, 0, 8, 8]]
    : [HEAD_REGIONS.front, HAT_REGIONS.front];

  const face: Rect = { x: rim, y: rim, w: size, h: size };

  drawRegion(ctx, skin, baseRegion, scale, face);

  if (options.overlay) {
    // 帽子层整层放大铺满外扩画布：内圈与底层正脸逐 texel 对齐（1:1 网格中心重合），外圈即游戏内的半个基准像素外扩
    drawRegion(ctx, skin, hatRegion, scale, { x: 0, y: 0, w: side, h: side });
  }

  return canvas;
}
