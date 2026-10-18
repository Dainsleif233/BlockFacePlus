/*!
 * BlockFace — 给图片贴 Minecraft 头像
 * Copyright 2026 Dainsleif
 * Licensed under the Apache License, Version 2.0
 */

/** 触发浏览器下载；文件名里的非法字符会被替换 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // 交给浏览器完成读取后再回收
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function canvasToBlob(canvas: HTMLCanvasElement, type = 'image/png', quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('导出失败：画布为空'))),
        type,
        quality,
      );
    } catch (error) {
      // 图片来自别的网站、对方不允许读取像素时，浏览器在这里抛 SecurityError
      reject(
        new Error(
          '导出失败：画布里有从别的网站直接取来的图片，那个网站不允许本程序读取图片内容。把这张图下载到本地，用「上传皮肤」导入后再导出。',
          { cause: error },
        ),
      );
    }
  });
}

export function suggestFilename(prefix = 'blockface', ext = 'png'): string {
  const now = new Date();
  const pad = (n: number) => n.toString().padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${prefix}-${stamp}.${ext}`;
}

/** 将生成的图片 Blob 直接复制到剪贴板，便于粘贴进聊天工具 */
export async function copyBlobToClipboard(blob: Blob): Promise<void> {
  if (typeof navigator === 'undefined' || !navigator.clipboard || typeof ClipboardItem === 'undefined') {
    throw new Error('当前环境不支持直接复制图片到剪贴板');
  }
  await navigator.clipboard.write([new ClipboardItem({ [blob.type || 'image/png']: blob })]);
}
