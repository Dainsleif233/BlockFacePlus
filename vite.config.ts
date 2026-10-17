import vue from '@vitejs/plugin-vue'
import { defineConfig, loadEnv, type Plugin } from 'vite'

/**
 * 后端是独立部署在 VPS 上的 FastAPI，前端产物留在边缘 Pages：
 * 构建时用 VITE_API_BASE_URL 指出后端在哪里，空字符串表示同源（本地开发经下面的代理）。
 * 末尾斜杠在这里一次性去掉，拼接 '/api/...' 的事交给前端代码。
 */

/**
 * 构建期环境。**必须走 loadEnv，不能读 process.env。**
 *
 * Vite 只把 .env* 的内容读进 import.meta.env 交给客户端代码，**不会**写回 process.env。
 * 所以 VITE_API_BASE_URL=https://api... pnpm build（shell 变量）读得到，而把同一行写在 .env 里时
 * process.env 是空的 —— 那会造出最坏的一种半套配置：产物里的 API 地址生效了、CSP 里却没放行这个
 * origin，浏览器把每一个 /api 请求都按 CSP 拦掉，报错长得像网络故障，很难往构建配置上想。
 * （实测复现过：bundle 里能搜到新域名，index.html 的 connect-src 里没有。）
 *
 * 两个前缀分开取，是为了让 Vite 自己套用它那套「shell 变量优先于 .env 文件」的合并规则：
 * VITE_ 是要烧进产物的，BF_ 是本机联调用的（不进产物）。
 */
const buildEnv = (mode: string): Record<string, string> => ({
  ...loadEnv(mode, process.cwd(), 'BF_'),
  ...loadEnv(mode, process.cwd(), 'VITE_'),
})

/** 只为 CSP 取个 origin；变量写错时让构建直接失败，避免产物与 CSP 不一致 */
function apiOrigin(value: string): string {
  try {
    return new URL(value).origin
  } catch {
    throw new Error('[blockface+] VITE_API_BASE_URL 不是合法 URL：' + value)
  }
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = buildEnv(mode)
  const apiBase = (env.VITE_API_BASE_URL ?? '').trim().replace(/\/+$/, '')

  /** 本地联调的代理目标：默认就是本机 FastAPI（package.json 的 dev:api） */
  const devApiTarget = env.BF_DEV_API_TARGET || 'http://127.0.0.1:8088'

  /**
   * 生产构建注入的内容安全策略。开发期不注入：Vite 的 HMR 走 ws://，
   * 塞 CSP 会把它掐掉，得不偿失。
   *
   * 资源来源说明：
   *  - textures/mc-heads/minotar 是皮肤贴图（<img> + canvas 绘制，需 crossOrigin）
   *  - skin.mualliance.ltd 是 MUA 联合认证的皮肤源：**不发 CORS 头**，只能靠
   *    images.weserv.nl 那级代理拿到可导出的像素；列进 img-src 是为了让
   *    "代理也不可用"时还能退回非 CORS 加载（能看见，但导出前会提示）
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
    "img-src 'self' data: blob: https://textures.minecraft.net https://mc-heads.net https://minotar.net" +
      // 跨域图片的代理兜底（editor.ts 的 DEFAULT_PROXY_TEMPLATE）。少了这一条，
      // 生产构建里第 2 级兜底会被 CSP 直接拦死，而 dev 不注入 CSP，本地永远复现不出来。
      // 换了代理模板，这里要跟着换。
      " https://images.weserv.nl" +
      // MUA 联合认证（skin.mualliance.ltd）：它不发 Access-Control-Allow-Origin，
      // 所以第 1 级 CORS 直取必然失败、实际靠上面那级代理取图；但第 3 级非 CORS 兜底
      // 仍然要能加载它 —— 不写这一条，代理不可用时就只剩"什么都没发生"。
      " https://skin.mualliance.ltd",
    "connect-src 'self'" + (apiCspOrigin ? ' ' + apiCspOrigin : '') + ' https://playerdb.co',
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

  return {
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
  }
})
