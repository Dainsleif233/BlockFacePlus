/*!
 * BlockFace — 给图片贴 Minecraft 头像
 * Copyright 2026 Dainsleif
 * Licensed under the Apache License, Version 2.0
 */

/**
 * 取图代理的默认模板：本项目自建的 EdgeOne Makers 端点。
 *
 * 端点实现在 `D:\Code\jsucraft\api` 的 `src/imgproxy.ts`（`GET /imgproxy?url=`），
 * 只放行 Minecraft 皮肤源，并统一输出 `Access-Control-Allow-Origin: *` —— 那才是
 * 关键：代理存在的意义不是"能不能取到字节"，而是取回来的图能不能读像素。任何
 * 不发 CORS 头的第三方代理都会让画布被污染，导不出也提交不了。
 *
 * 为什么不再用 `images.weserv.nl`：那是第三方公共设施，并发/冷启动下会偶发
 * `Failed to fetch`（2026-10 实测 8 并发里 2 个失败，40 并发时 31/40 超过 8 秒），
 * 一旦失败就掉到第 3 级非 CORS 兜底 —— 图能看见、却再也提交不进房间。
 *
 * 模板里的 `{url}` 会被替换成 encodeURIComponent 后的原始地址（见 applyProxy）。
 */
export const SELF_HOSTED_PROXY_TEMPLATE = 'https://api.jsumc.fun/imgproxy?url={url}'

/**
 * 实际使用的默认模板。
 *
 * 构建期可用 `VITE_IMG_PROXY_TEMPLATE` 换成别的地址（例如自建端点还没上线时的临时
 * 回退）。**必须与 CSP 保持一致**：`vite.config.ts` 用同一个变量算出 img-src 里要
 * 放行的 origin，两边读的是同一份环境值，所以别在运行期改这个常量。
 */
export const DEFAULT_PROXY_TEMPLATE: string =
  ((import.meta.env.VITE_IMG_PROXY_TEMPLATE as string | undefined) ?? '').trim() ||
  SELF_HOSTED_PROXY_TEMPLATE

/**
 * 把代理模板缩成一句能进提示文案的话（一般就是主机名）。
 *
 * 完整模板动辄七八十个字符，塞进「取图代理（...）不通」里会把整句话淹掉；
 * 用户真正需要认的也只有"是哪个站"。模板空着就让调用方看到"未配置"。
 */
export function describeProxyTemplate(template: string): string {
  if (!template) return '未配置';
  try {
    return new URL(template.replace('{url}', '')).host;
  } catch {
    return template;
  }
}
