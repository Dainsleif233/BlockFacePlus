/*!
 * BlockFace — 给图片贴 Minecraft 头像
 * Copyright 2026 Dainsleif
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * 皮肤贴图的元信息与校验。
 *
 * 合法贴图（社区通行标准）：
 * - `64×64` 现代格式
 * - `64×32` 旧版格式（1.7 及以前；头部区域完整，含帽子层，因此头像渲染无损）
 * - `16×8` 正脸双层格式（预设轻量化存储，正脸底层与帽子层并排，width === height * 2）
 * - `128×128 / 256×256 / 512×512`（及对应 128×64 旧版等）高清皮肤（OptiFine 社区标准，恒为 64 的整数倍）
 */
export interface SkinMeta {
  width: number;
  height: number;
  /** 高清倍率 = width / 64（标准/旧版）或 width / 16（正脸双层），用于 UV 等比缩放 */
  scale: number;
  /** 是否为 64×32 旧版格式（height * 2 === width） */
  legacy: boolean;
  /**
   * 是否为正脸双层格式（底层正脸与帽子正脸并排，16×8 等比，height * 2 === width）。
   * 16×8 / 32×16 靠尺寸就能自证；64×32、128×64 与旧版整肤同尺寸，只能靠预设里显式带的
   * `frontOnly` 标记认出来（见 PresetSkin.frontOnly），因此这个字段必须一路带下去。
   */
  frontOnly?: boolean;
  valid: boolean;
  /** 中文规格标签，直接用于界面展示 */
  label: string;
  /** 是否为普通图片（非 Minecraft 皮肤贴图，无需 UV 切割正面与帽子） */
  isCustomImage?: boolean;
}

const LEGACY_LABEL = '旧版格式';
const FRONT_ONLY_LABEL = '正脸双层';
const HD_LABEL = '高清';

export function describeSkin(width: number, height: number, forceFrontOnly?: boolean): SkinMeta {
  // 正脸双层格式：两张 8×8 (或 8*scale) 正脸并排，宽度为高度的 2 倍（16×8、32×16 等）。
  // 64×32、128×64 与旧版整肤同尺寸，靠尺寸判不出来，只能认显式标记 forceFrontOnly。
  const isFrontOnly = forceFrontOnly === true || (height * 2 === width && width < 64 && width >= 16 && width % 16 === 0);
  if (isFrontOnly) {
    const scale = width / 16;
    const valid = Number.isInteger(scale) && scale >= 1;
    const label = scale > 1 ? `${width}×${height} · ${FRONT_ONLY_LABEL}（${HD_LABEL} ×${scale}）` : `${width}×${height} · ${FRONT_ONLY_LABEL}`;
    return {
      width,
      height,
      scale: valid ? scale : 1,
      legacy: false,
      frontOnly: true,
      valid,
      label: valid ? label : `${width}×${height} · 格式不支持`,
    };
  }

  const square = width === height;
  // 旧版格式高度恰为宽度的一半（如 64×32、128×64），因此不能要求 height 也是 64 的倍数
  const legacy = height * 2 === width;
  const widthAligned = width >= 64 && width % 64 === 0;
  const valid = widthAligned && (square || legacy);

  const scale = valid ? width / 64 : 1;

  let label: string;
  if (!valid) {
    label = `${width}×${height} · 格式不支持`;
  } else if (legacy) {
    label = `${width}×${height} · ${LEGACY_LABEL}`;
  } else if (scale > 1) {
    label = `${width}×${height} · ${HD_LABEL} ×${scale}`;
  } else {
    label = `${width}×${height} · 标准`;
  }

  return { width, height, scale, legacy, frontOnly: false, valid, label };
}

/** 皮肤的来源类型，用于界面归因与错误文案 */
export type SkinOrigin = 'builtin' | 'account' | 'mua' | 'upload' | 'url' | 'preset';

export interface SkinTexture {
  id: string;
  /** 已解码的位图（禁止放入 Vue 响应式对象，故单独登记） */
  image: CanvasImageSource;
  meta: SkinMeta;
  origin: SkinOrigin;
  /** 人类可读的来源描述，例如玩家名或文件名 */
  sourceLabel: string;
  /** 画布是否被跨域污染（污染后无法导出 PNG） */
  tainted: boolean;
}

export function describeCustomImage(width: number, height: number): SkinMeta {
  const valid = width > 0 && height > 0;
  return {
    width,
    height,
    scale: 1,
    legacy: false,
    valid,
    label: valid ? `${width}×${height} · 头像图片` : '图片尺寸无效',
    isCustomImage: true,
  };
}

export function assertUsableSkin(meta: SkinMeta): void {
  if (!meta.valid) {
    throw new Error(
      `皮肤尺寸 ${meta.width}×${meta.height} 不被支持。请使用 64×64、64×32、16×8（正脸双层），或对应的 128/256/512 高清规格。如需直接贴上，请使用「上传头像图片」。`,
    );
  }
}
