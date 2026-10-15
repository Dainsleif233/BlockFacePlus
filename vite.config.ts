import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  base: './',
  plugins: [vue()],
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
})
