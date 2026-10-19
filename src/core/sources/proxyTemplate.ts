/*!
 * BlockFace — 给图片贴 Minecraft 头像
 * Copyright 2026 Dainsleif
 * Licensed under the Apache License, Version 2.0
 */

/**
 * 取图代理的默认模板：**本站自己的**边缘函数，同源相对路径。
 *
 * 端点是 `edge-functions/imgproxy.ts`（`GET /imgproxy?url=`），逻辑在
 * `edge-functions/_lib/imgproxy-core.ts`，由本项目的 EdgeOne Makers 部署一起发出去。
 *
 * 为什么是相对路径而不是某个域名：同源图片按定义不会污染画布。取图代理的**全部意义**
 * 就在于拿到可读像素——如果代理在另一个域上，它就必须额外回正确的 CORS 头，
 * 那一环抖一下，用户拿到的就是一张"能看不能存"的头像。同源把这一环彻底去掉了：
 * 少了 DNS/TLS 握手、少了 CORS 协商，也就不存在"代理答应了但头没发对"这种可能。
 *
 * 这也让 CSP 变简单：`img-src 'self'` 本来就放行，不必为代理单列一行。
 *
 * 本地 `vite dev` / `vite preview` 由 vite 的中间件提供同一份逻辑（见 vite.config.ts 的
 * imgProxy 插件），线上由边缘函数提供 —— 两边跑的是同一个 imgproxy-core。
 *
 * 注意它是**站点根**的绝对路径：项目部署在子路径下（`https://x/blockface/`）时，
 * `/imgproxy` 会打到域名的根上。那种部署方式必须用 VITE_IMG_PROXY_TEMPLATE 指到实际位置。
 */
export const SELF_HOSTED_PROXY_TEMPLATE = '/imgproxy?url={url}'

/**
 * 实际使用的默认模板。
 *
 * 构建期可用 `VITE_IMG_PROXY_TEMPLATE` 换成别的地址（例如把代理独立部署时的绝对 URL）。
 * 换的时候注意两件事：
 *  1. 换成绝对 URL 就变成跨域取图，对方**必须**回 `Access-Control-Allow-Origin`，
 *     否则画布又被污染 —— 这正是本端点当初要解决的问题；
 *  2. `vite.config.ts` 用同一个变量算出要放行的 CSP 来源，两边读的是同一份环境值。
 */
export const DEFAULT_PROXY_TEMPLATE: string =
  ((import.meta.env.VITE_IMG_PROXY_TEMPLATE as string | undefined) ?? '').trim() ||
  SELF_HOSTED_PROXY_TEMPLATE

/**
 * 把代理模板缩成一句能进提示文案的话。
 *
 * 同源模板缩出来是"本站"，别的缩成主机名。完整模板动辄七八十个字符，塞进
 * 「取图代理（...）不通」里会把整句话淹掉；用户真正需要认的也只是"是哪个站"。
 */
export function describeProxyTemplate(template: string): string {
  if (!template) return '未配置'
  // 相对路径（同源）没有 host：那不是"未配置"，是本站自己
  if (template.startsWith('/')) return '本站'
  try {
    return new URL(template.replace('{url}', '')).host
  } catch {
    return template
  }
}
