/*!
 * BlockFace — 给图片贴 Minecraft 头像
 * Copyright 2026 Dainsleif
 * Licensed under the Apache License, Version 2.0
 */

import { describe, expect, it } from 'vitest';
import { hatRimPixels, OVERLAY_SHELL } from './head';

describe('hatRimPixels', () => {
  it('帽沿 = 正脸边长的 1/16（每边外扩半个基准像素，8 基准像素对边）', () => {
    expect(OVERLAY_SHELL).toBe(0.5);
    expect(hatRimPixels(64)).toBe(4);
    expect(hatRimPixels(128)).toBe(8);
    expect(hatRimPixels(512)).toBe(32);
  });

  it('小尺寸保底 1px，帽沿不会整圈消失', () => {
    expect(hatRimPixels(1)).toBe(1);
    expect(hatRimPixels(8)).toBe(1);
  });
});
