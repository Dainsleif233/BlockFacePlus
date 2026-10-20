/** 把官方 Steve / Alex 帽子层正面的 8×8 画成 ASCII，看清它到底挡在哪 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(2400);
const store = window.__blockface;
const { renderHeadCanvas } = await import('/src/core/render/head.ts');
const sheetData = (skin) => {
  const c = document.createElement('canvas');
  c.width = skin.meta.width; c.height = skin.meta.height;
  const x = c.getContext('2d');
  x.imageSmoothingEnabled = false;
  x.drawImage(skin.image, 0, 0, c.width, c.height);
  return x.getImageData(0, 0, c.width, c.height).data;
};
const out = {};
for (const id of ['builtin-steve', 'builtin-alex']) {
  const skin = store.getSkin(id);
  const w = skin.meta.width;
  const d = sheetData(skin);
  const rows = [];
  for (let y = 0; y < 8; y += 1) {
    let line = '';
    for (let x = 0; x < 8; x += 1) {
      const i = (((8 + y) * w) + (40 + x)) * 4;
      line += d[i + 3] === 0 ? '.' : (d[i + 3] === 255 ? '#' : '+');
    }
    rows.push(line);
  }

  // 64 倍整数放大下，逐点核对"正面 UV 映射"和"帽子层 source-over 合成"
  const headNoHat = renderHeadCanvas(skin, { overlay: false, pixelSize: 64 });
  const headHat = renderHeadCanvas(skin, { overlay: true, pixelSize: 64 });
  const noHat = headNoHat.getContext('2d').getImageData(0, 0, 64, 64).data;
  // 开帽层后画布带帽沿（64 → 4×2 = 72），正脸整体平移帽沿宽，取样按画布真实宽度重算偏移
  const rim = (headHat.width - 64) / 2;
  const hat = headHat.getContext('2d').getImageData(0, 0, headHat.width, headHat.width).data;
  let faceMismatch = 0;
  let compositeMaxDiff = 0;
  let compositeMismatch = 0;
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      const fx = 8 + x, fy = 8 + y;
      const hx = 40 + x, hy = 8 + y;
      const fi = ((fy * w) + fx) * 4;
      const hi = ((hy * w) + hx) * 4;
      const oi = (((y * 8) + 4) * 64 + (x * 8) + 4) * 4;
      const oih = ((((y * 8) + 4 + rim) * headHat.width) + (x * 8) + 4 + rim) * 4;
      if (noHat[oi] !== d[fi] || noHat[oi + 1] !== d[fi + 1] || noHat[oi + 2] !== d[fi + 2]) faceMismatch += 1;
      const a = d[hi + 3] / 255;
      for (let k = 0; k < 3; k += 1) {
        const expect = Math.round(d[hi + k] * a + d[fi + k] * (1 - a));
        const diff = Math.abs(expect - hat[oih + k]);
        if (diff > compositeMaxDiff) compositeMaxDiff = diff;
        if (diff > 1) compositeMismatch += 1;
      }
    }
  }
  out[id] = { hatFront: rows, faceMismatch, compositeMaxDiff, compositeMismatch };
}

// 文档画布上的像素与头像离屏画布上的像素是否一致（验证合成环节没有额外混色）
const doc = document.querySelector('.artboard__doc');
out.note = 'doc canvas present: ' + !!doc;
return out;
