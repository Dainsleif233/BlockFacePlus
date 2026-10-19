/*!
 * BlockFace — 给图片贴 Minecraft 头像
 * Copyright 2026 Dainsleif
 * Licensed under the Apache License, Version 2.0
 */

/**
 * 取图代理的全部逻辑。
 *
 * 端点本身极薄（`edge-functions/imgproxy.ts` 只负责把请求转进来），因为这份代码要被
 * 三处共用：线上的边缘函数、`vite dev`/`vite preview` 的开发中间件、以及单元测试。
 * 三处各写一份的代价是"本地能过、线上拦掉"——这类分歧只能靠共用同一份代码避免。
 *
 * ## 它为什么存在
 *
 * `skin.mualliance.ltd` 不发 `Access-Control-Allow-Origin`。浏览器带
 * `crossOrigin="anonymous"` 取图必然失败；不带 CORS 虽然能显示，但画布被污染，
 * `toDataURL()` / `toBlob()` 抛 SecurityError，图片再也导不出来、提交不进房间。
 * 中间加一跳服务端转发，浏览器看到的就是一张普通图片。
 *
 * ## 为什么放在本站而不是第三方
 *
 * 端点与前端的**同源**是关键：同源图片按定义不会污染画布，连 CORS 头都不需要。
 * 这比"找一个会回 CORS 头的公共代理"可靠得多——公共代理抖一下，用户得到的就是
 * 一张"能看不能存"的头像。跨域头仍然照发（`*`），是为了让别处也能用这个端点，
 * 以及前端改成跨域部署时不必再改后端。
 */

/**
 * 允许经代理取回的主机白名单。
 *
 * 这是**给 Minecraft 皮肤用的图片中转**，不是公开的任意 URL 代理：没有白名单，
 * 任何人都能拿它刷流量、绕地域限制、甚至当跳板探内网，成本与风险都落在这个站上。
 *
 * `mc-heads.net` 故意不在名单里：它对云端来源的请求一律回 403（Cloudflare），
 * 经这里转发只会把"浏览器能直连"的链路变成死路。
 */
export const ALLOWED_HOSTS: readonly string[] = [
  'skin.mualliance.ltd', // MUA 联合认证：不发 CORS 头 —— 本端点存在的首要原因
  'textures.minecraft.net', // Mojang 皮肤贴图（正版 ID 查询返回的直链）
  'minotar.net', // 正版 ID 的备用镜像
]

/** 上游必须在这个时间内给出响应，否则 504。皮肤贴图正常 1 秒内返回。 */
export const TIMEOUT_MS = 8000

/** 单张图片的体积上限。皮肤贴图最大 64×64 几 KB，超过这个数的肯定不是皮肤。 */
export const MAX_BYTES = 4 * 1024 * 1024

/**
 * 所有响应都带上的跨域头。
 *
 * 只写一次、只在一个地方写。同一个响应头出现两遍会变成 `*, *`，
 * 浏览器按"允许多个值"的语义直接拒收——那比不写还糟。
 */
const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'X-Content-Type-Options': 'nosniff',
}

function jsonError(error: string, status: number, extra?: Record<string, string>): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json; charset=utf-8', ...extra },
  })
}

/** 预检响应：正常取图不会触发（不带自定义头），但别让它落到 405 上。 */
export function optionsResponse(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      ...CORS_HEADERS,
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Max-Age': '86400',
    },
  })
}

/** 非 GET 方法一律 405，并带上 Allow。 */
export function methodNotAllowed(method: string): Response {
  return jsonError(`不支持 ${method}：这个端点只读`, 405, { Allow: 'GET, OPTIONS' })
}

/**
 * 校验 `url` 参数，决定"能不能代取"。
 *
 * 单独抽出来是为了让拒绝的理由可测：每一条 rule 都对应一个能被人滥用的口子。
 */
export function resolveTarget(
  raw: string | null,
): { ok: true; target: URL } | { ok: false; status: number; error: string } {
  if (!raw) return { ok: false, status: 400, error: '缺少 url 参数' }

  let target: URL
  try {
    target = new URL(raw)
  } catch {
    return { ok: false, status: 400, error: 'url 参数不是合法地址' }
  }

  // 只放 https：http 会被混合内容拦掉，也容易被拿来打内网的明文服务
  if (target.protocol !== 'https:') {
    return { ok: false, status: 400, error: '只支持 https 地址' }
  }
  if (target.username || target.password) {
    // 带账号密码的 URL 会把凭据写进日志，也让"代理了谁"变得不可读
    return { ok: false, status: 400, error: '地址里不能带账号密码' }
  }
  if (!ALLOWED_HOSTS.includes(target.hostname.toLowerCase())) {
    return { ok: false, status: 403, error: `不允许代理这个主机：${target.hostname}` }
  }
  return { ok: true, target }
}

/**
 * 代取一张图，把字节与 `Content-Type` 原样返回。
 *
 * @param rawUrl `url` 查询参数（已经过 URL 解码的原文）
 */
export async function proxyImage(rawUrl: string | null): Promise<Response> {
  const resolved = resolveTarget(rawUrl)
  if (!resolved.ok) return jsonError(resolved.error, resolved.status)
  const { target } = resolved

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  let upstream: Response
  try {
    upstream = await fetch(target.href, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { Accept: 'image/*' },
    })
  } catch (error) {
    const aborted = (error as Error)?.name === 'AbortError'
    return jsonError(
      aborted ? `上游 ${TIMEOUT_MS}ms 内没有响应` : '连不上上游',
      aborted ? 504 : 502,
    )
  } finally {
    clearTimeout(timer)
  }

  // 跟随重定向后可能已经落到白名单外（上游把我们指向别处），落到外面就不要往回转
  let finalUrl: URL | null = null
  try {
    finalUrl = new URL(upstream.url)
  } catch {
    // upstream.url 为空时当作没换过地址
  }
  if (finalUrl && !ALLOWED_HOSTS.includes(finalUrl.hostname.toLowerCase())) {
    return jsonError('上游重定向到了不允许的主机', 403)
  }

  if (!upstream.ok) {
    return jsonError(`上游返回 ${upstream.status}`, 502)
  }

  const contentType = (upstream.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
  if (!contentType.startsWith('image/')) {
    // 上游挂了时常常回一张 HTML 错误页；原样转回去会让浏览器把它当图片解，报错更难懂
    return jsonError('上游返回的不是图片', 502)
  }

  let bytes: ArrayBuffer
  try {
    bytes = await upstream.arrayBuffer()
  } catch {
    return jsonError('读取上游响应体失败', 502)
  }
  if (bytes.byteLength === 0) return jsonError('上游返回了空响应体', 502)
  if (bytes.byteLength > MAX_BYTES) return jsonError('图片超过体积上限', 502)

  return new Response(bytes, {
    status: 200,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': contentType,
      // 皮肤贴图基本不变：浏览器与 CDN 各缓存一段，省掉重复转发
      'Cache-Control': 'public, max-age=86400, s-maxage=604800',
    },
  })
}