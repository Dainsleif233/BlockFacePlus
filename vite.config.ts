import vue from '@vitejs/plugin-vue'
import { defineConfig, loadEnv, type Plugin, type PreviewServer, type ViteDevServer } from 'vite'
// 显式写 .ts：本仓库走 nodenext 解析，扩展名不能省。这份 core 也被边缘函数与单测引用
import { proxyImage, optionsResponse, methodNotAllowed } from './edge-functions/_lib/imgproxy-core.ts'

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
function cspOrigin(value: string, variable: string): string {
  try {
    return new URL(value).origin
  } catch {
    throw new Error(`[blockface+] ${variable} 不是合法 URL：${value}`)
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
   *  - skin.mualliance.ltd 是 MUA 联合认证的皮肤源：**不发 CORS 头**。MUA 入口本身
   *    只走代理（loadImage 的 proxyOnly），压根不会直接加载这个域名；列进 img-src 是给
   *    「网络地址」入口的 —— 用户把 MUA 地址粘在那里时走的是通用三级降级，
   *    第 3 级兜底需要它才能加载
   *  - playerdb.co 是正版 ID 查询接口（fetch）
   *  - VITE_API_BASE_URL 的 origin 是协同后端；同源部署（变量为空）时不需要它，
   *    跨域部署少了这一条，浏览器会把请求当作被 CSP 拦掉的脚本
   *  - data: / blob: 给内置皮肤内联图与本地导入的图片
   * style 需要 'unsafe-inline'：Vue 的 :style 绑定会落到行内 style 属性上。
   */
  const apiCspOrigin = apiBase ? cspOrigin(apiBase, 'VITE_API_BASE_URL') : ''

  /**
   * 取图代理模板，以及它要不要在 img-src 里单列。
   *
   * 默认是**同源相对路径** `/imgproxy?url={url}`（edge-functions/imgproxy.ts，本项目自己的
   * 边缘函数）。同源图片按定义不污染画布，CSP 里 'self' 本来就放行，所以默认情况下
   * 这里不往 img-src 加任何东西 —— 少一条能配错的规则，就少一种"改了模板忘了改 CSP"。
   *
   * 只有显式用 VITE_IMG_PROXY_TEMPLATE 换成绝对 URL（把代理独立部署）时才需要放行它的
   * origin，而且那块必须回 Access-Control-Allow-Origin，否则画布又被污染。
   * dev 不注入 CSP，这类不一致本地永远复现不出来，只能靠这里两边读同一个变量来兜。
   */
  const proxyTemplate = (env.VITE_IMG_PROXY_TEMPLATE ?? '').trim() || '/imgproxy?url={url}'
  const proxyCspOrigin = proxyTemplate.startsWith('/')
    ? ''
    : ' ' + cspOrigin(proxyTemplate.replace('{url}', ''), 'VITE_IMG_PROXY_TEMPLATE')
  const CSP = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https://textures.minecraft.net https://mc-heads.net https://minotar.net" +
      // 取图代理：仅当模板被换成绝对 URL 时才有内容（同源时 'self' 已经够了）。
      // MUA 入口的必经之路，也是其他入口的第 2 级兜底。
      proxyCspOrigin +
      // MUA 联合认证（skin.mualliance.ltd）：MUA 入口只走上面那级代理，不需要这一条；
      // 留着是为了「网络地址」入口粘贴 MUA 地址时的第 3 级非 CORS 兜底 —— 不写这一条，
      // 那条路径在代理不可用时就只剩"什么都没发生"。
      " https://skin.mualliance.ltd",
    "connect-src 'self'" + (apiCspOrigin ? ' ' + apiCspOrigin : '') + ' https://playerdb.co',
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; ')

  /**
   * 本地把边缘函数挂到 vite 上（dev 与 preview 都挂）。
   *
   * 代理端点默认是**同源相对路径** `/imgproxy?url=`，线上它由 edge-functions/imgproxy.ts
   * 提供。可是 `vite dev` 不认识 edge-functions/，光有相对路径本地只会拿到 index.html ——
   * 于是本地跑 MUA 取图必然失败，而线上是好的，这类"只有本地坏"的坑最难查。
   *
   * 所以这里用**同一份** imgproxy-core 顶上一个中间件，dev/preview 的行为与线上逐字一致：
   * 同一套白名单、同一条超时、同一个错误 JSON。三处各写一份必然走散。
   *
   * 唯一对不齐的是 OPTIONS：vite 自带的 CORS 中间件排在前面，预检请求会被它先答掉
   * （它给的是 HMR 用的 `GET,HEAD,PUT,PATCH,POST,DELETE`），线上答的是 `GET, OPTIONS`。
   * 这条端点永远不触发预检 —— 取图是简单 GET，不带自定义头 —— 所以这点差异碰不到真实请求；
   * 真去把 vite 的 CORS 关掉或抢在它前面，代价比收益大。
   */
  function imgProxy(): Plugin {
    const handle = async (
      req: { url?: string; method?: string },
      res: {
        statusCode: number
        setHeader(name: string, value: string): void
        end(body?: unknown): void
      },
      next: () => void,
    ): Promise<void> => {
      // 只接管本站的 /imgproxy；其余请求（页面、HMR、/api 代理）原样放过
      const raw = req.url ?? ''
      if (!raw.split('?')[0].endsWith('/imgproxy')) {
        next()
        return
      }

      let response: Response
      if (req.method === 'OPTIONS') response = optionsResponse()
      else if (req.method !== 'GET' && req.method !== 'HEAD') response = methodNotAllowed(req.method ?? 'GET')
      else {
        const url = new URL(raw, 'http://localhost')
        response = await proxyImage(url.searchParams.get('url'))
      }

      // 逐条写回，不用 res.writeHead：中间件之后 vite 还要复用这个 res
      response.headers.forEach((value, name) => res.setHeader(name, value))
      res.statusCode = response.status
      res.end(Buffer.from(await response.arrayBuffer()))
    }

    return {
      name: 'bf-imgproxy',
      configureServer(server: ViteDevServer) {
        server.middlewares.use((req, res, next) => void handle(req, res, next))
      },
      configurePreviewServer(server: PreviewServer) {
        server.middlewares.use((req, res, next) => void handle(req, res, next))
      },
    }
  }

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
    plugins: [vue(), imgProxy(), securityHeaders()],
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
