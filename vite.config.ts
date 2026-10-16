import vue from '@vitejs/plugin-vue'
import { defineConfig, type Plugin } from 'vite'

/**
 * 后端是独立部署在 VPS 上的 FastAPI，前端产物留在边缘 Pages：
 * 构建时用 VITE_API_BASE_URL 指出后端在哪里，空字符串表示同源（本地开发经下面的代理）。
 * 末尾斜杠在这里一次性去掉，拼接 '/api/...' 的事交给前端代码。
 */
const apiBase = (process.env.VITE_API_BASE_URL ?? '').trim().replace(/\/+$/, '')

/** 本地联调的代理目标：默认就是本机 FastAPI（package.json 的 dev:api） */
const devApiTarget = process.env.BF_DEV_API_TARGET || 'http://127.0.0.1:8088'

/** 只为 CSP 取个 origin；变量写错时宁可少加一条来源，也不要让构建挂在一句 URL 报错上 */
function apiOrigin(value: string): string {
  try {
    return new URL(value).origin
  } catch {
    console.warn(`[blockface+] VITE_API_BASE_URL 不是合法 URL，CSP 里不加入该来源：${value}`)
    return ''
  }
}

/**
 * 生产构建注入的内容安全策略。开发期不注入：Vite 的 HMR 走 ws://，
 * 塞 CSP 会把它掐掉，得不偿失。
 *
 * 资源来源说明：
 *  - textures/mc-heads/minotar 是皮肤贴图（<img> + canvas 绘制，需 crossOrigin）
 *  - playerdb.co 是正版 ID 查询接口（fetch）
 *  - VITE_API_BASE_URL 的 origin 是协同后端；同源部署（变量为空）时不需要它，
 *    跨域部署少了这一条，浏览器会把请求当作被 CSP 拦掉的脚本
 *  - data: / blob: 给内置皮肤内联图与本地导入的图片
 * style 需要 'unsafe-inline'：Vue 的 :style 绑定会落到行内 style 属性上。
 */
const apiCspOrigin = apiBase ? apiOrigin(apiBase) : ''
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://textures.minecraft.net https://mc-heads.net https://minotar.net",
  `connect-src 'self'${apiCspOrigin ? ' ' + apiCspOrigin : ''} https://playerdb.co`,
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ')

function securityHeaders(): Plugin {
  return {
    name: 'bf-security-headers',
    apply: 'build',
    transformIndexHtml() {
      return [
        {
          tag: 'meta',
          attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP },
          injectTo: 'head-prepend',
        },
      ]
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  base: './',
  plugins: [vue(), securityHeaders()],
  server: {
    proxy: {
      // 本地联调：前端跑 Vite（5173），后端跑本机 FastAPI（默认 8088），
      // 这样 VITE_API_BASE_URL 留空也能跑通同源路径；生产由 Pages 直连 VPS。
      '/api': {
        target: devApiTarget,
        changeOrigin: true,
      },
    },
  },
  preview: {
    proxy: {
      // 预览生产构建（pnpm build && pnpm preview）时同样把 /api 交给本地后端，
      // 这样脱离开发服务器也能验证带上 CSP 后的真实行为。
      '/api': {
        target: devApiTarget,
        changeOrigin: true,
      },
    },
  },
})
