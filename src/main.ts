/*! BlockFace+ · Copyright 2026 Dainsleif · Apache License 2.0  */
import { createApp } from 'vue';
import './styles/tokens.css';
import App from './App.vue';

createApp(App).mount('#app');

// 仅开发模式：把 store 挂到 window，供自动化冒烟测试（tools/e2e.js）读取真实状态。
// 生产构建下这段会被摇掉，不会出现在产物里。
if (import.meta.env.DEV) {
  void import('./stores/editor').then((store) => {
    (window as unknown as Record<string, unknown>).__blockface = store;
  });
  void import('./stores/collab').then((store) => {
    (window as unknown as Record<string, unknown>).__blockfaceplus = store;
  });
}
