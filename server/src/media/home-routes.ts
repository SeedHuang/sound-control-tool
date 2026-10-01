// server/src/media/home-routes.ts
// 首页仪表盘路由(P5-T1,spec §0.3「其它」):GET /api/home 返回两块 Top3(editing / recent)。
// 注意:首页走普通 fetch(带 header)→ 不加 onRequest 守卫豁免(豁免只给 <img>/<video> 这类带不了 header 的端点);
// HTTP 摘要由 index.ts 的 onResponse 钩子自动落 → 这里不手写 pushLog(仓库铁律:有钩子就不重复写)。
import type { FastifyInstance } from 'fastify';
import type { DB } from '../db/index.js';
import { createHomeRepo } from '../db/repo/home.js';

export function registerHomeRoutes(app: FastifyInstance, deps: { db: DB }): void {
  const homeRepo = createHomeRepo(deps.db);
  app.get('/api/home', async () => ({ ok: true, editing: homeRepo.editing(), recent: homeRepo.recent() }));
}
