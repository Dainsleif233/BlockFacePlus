import vue from '@vitejs/plugin-vue'
import { defineConfig, type Plugin } from 'vite'

/**
 * 生产构建注入的内容安全策略。开发期不注入：Vite 的 HMR 走 ws://，
 * 塞 CSP 会把它掐掉，得不偿失。
 *
 * 资源来源说明：
 *  - textures/mc-heads/minotar 是皮肤贴图（<img> + canvas 绘制，需 crossOrigin）
 *  - playerdb.co 是正版 ID 查询接口（fetch）
 *  - *.edgeone.site 是底图直传的预签名地址（发布房间时 PUT 到 Blob）
 *  - data: / blob: 给内置皮肤内联图与本地导入的图片
 * style 需要 'unsafe-inline'：Vue 的 :style 绑定会落到行内 style 属性上。
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://textures.minecraft.net https://mc-heads.net https://minotar.net",
  "connect-src 'self' https://*.edgeone.site https://playerdb.co",
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
      // 本地联调：前端跑 Vite（5173），后端跑 edgeone makers dev（8088），
      // 生产环境前后端同站部署，这个代理只在开发期生效。
      '/api': {
        target: 'http://127.0.0.1:8088',
        changeOrigin: true,
      },
    },
  },
  preview: {
    proxy: {
      // 预览生产构建（pnpm build && pnpm preview）时同样把 /api 交给本地后端，
      // 这样脱离开发服务器也能验证带上 CSP 后的真实行为。
      '/api': {
        target: 'http://127.0.0.1:8088',
        changeOrigin: true,
      },
    },
  },
})
