import { defineConfig } from '@umijs/max';

export default defineConfig({
  // spec 0.1 事实 3:Electron file:// 下必须 hash 路由 + 相对 publicPath,否则白屏
  history: { type: 'hash' },
  hash: true,
  publicPath: process.env.NODE_ENV === 'production' ? './' : '/',
  routes: [
    { path: '/', component: 'index' },
    { path: '/settings', component: 'settings' },
    { path: '/acquire', component: 'acquire' },
    { path: '/library', component: 'library' },
  ],
});
