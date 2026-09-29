import { defineConfig } from '@umijs/max';

export default defineConfig({
  // spec 0.1 事实 3:Electron file:// 下必须 hash 路由 + 相对 publicPath,否则白屏
  history: { type: 'hash' },
  hash: true,
  publicPath: process.env.NODE_ENV === 'production' ? './' : '/',
  // MFSU 关闭(2026-09-29):dev 页面路由(React.lazy)经 MFSU 缓存导入会静默卡死——无报错、chunk 请求都不发出,
  // 菜单渲染但内容永远空白(用户实测"点 tab 没反应/内容不出现")。本项目仅 4 页,MFSU 提速无意义,
  // 缓存过期/损坏(node_modules/.cache/mfsu)却引入整类故障 → 永久关闭,webpack 全量构建(首次 dev 慢几秒可接受)。
  mfsu: false,
  routes: [
    { path: '/', component: 'index' },
    { path: '/settings', component: 'settings' },
    { path: '/acquire', component: 'acquire' },
    { path: '/library', component: 'library' },
  ],
});
