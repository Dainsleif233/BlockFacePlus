/*!
 * BlockFace — 给图片贴 Minecraft 头像
 * Copyright 2026 Dainsleif
 * Licensed under the Apache License, Version 2.0
 */

/**
 * EdgeOne Makers 边缘函数：`GET /imgproxy?url=<encoded>`
 *
 * 本项目自己的取图代理。放在这里的原因见 `_lib/imgproxy-core.ts` 顶部那段：
 * 前端与它同源 —— 同源图片按定义不会污染画布，比依赖任何第三方公共代理都稳。
 *
 * 只做适配，逻辑全在 `_lib/imgproxy-core.ts`（同一份代码也给 vite dev 的中间件和单测用）。
 * 以 `_` 开头的目录不会被平台当成路由，所以 `_lib/` 不会被暴露出去。
 */
import { methodNotAllowed, optionsResponse, proxyImage } from './_lib/imgproxy-core'

export async function onRequestGet(ctx: { request: Request }): Promise<Response> {
  const url = new URL(ctx.request.url)
  return proxyImage(url.searchParams.get('url'))
}

/** 正常取图不带自定义头，不会有预检；真要发 OPTIONS 时不能落到 405 上。 */
export async function onRequestOptions(): Promise<Response> {
  return optionsResponse()
}

/** 只读端点：其他方法一律 405 且带 Allow。 */
export async function onRequest(ctx: { request: Request }): Promise<Response> {
  return methodNotAllowed(ctx.request.method)
}