// server/src/media/project-routes.test.ts
// 剪辑工程路由（P4-T3，spec §0.3）：列表 / 详情（无工程 → project:null）/ 全量替换 PUT / 幂等 DELETE。
// 直接注册在裸 Fastify 上（不挂 token 守卫）——token 校验属 index.ts 的 onRequest 钩子职责，不在这层。
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type DB } from '../db/index.js';
import { initSchema } from '../db/schema.js';
import { createImportsRepo } from '../db/repo/imports.js';
import { createSourceVideosRepo } from '../db/repo/source-videos.js';
import { createAudioItemsRepo } from '../db/repo/audio-items.js';
import { registerProjectRoutes } from './project-routes.js';

let app: FastifyInstance;
let db: DB;
let importId: number;

beforeEach(() => {
  db = openDatabase(':memory:');
  initSchema(db);
  importId = createImportsRepo(db).upsertByUrl({
    url: 'https://a/pl', title: '凡人修仙传', site: 'bilibili', kind: 'playlist', duration_sec: null, entries: null,
  });
  app = Fastify({ logger: false });
  registerProjectRoutes(app, { db, audioDir: '/no/such/audio', tempDir: '/no/such/tmp', token: 'tok' });
});
afterEach(async () => {
  await app.close();
});

// 接口级 D18 注入器：包一层 DB，让「写段」语句在开关打开时抛错，模拟事务中途失败；
// 其余调用完全委托真实 db（GET 仍走真实读路径）。
// 为什么要包：路由层的 parseSegments 会先把 `label: {}` 这类不可绑定值挡成 400，
// 到不了 repo 的绑定异常——所以只能在这一层人为制造一次「事务中途失败」。
function wrapDbForFailInjection(real: DB): { db: DB; failSegmentInsert: { on: boolean } } {
  const failSegmentInsert = { on: false };
  const wrapper = {
    exec: (sql: string) => real.exec(sql),
    prepare: (sql: string) =>
      failSegmentInsert.on && sql.startsWith('INSERT INTO clip_segments')
        ? { run: () => { throw new TypeError('测试注入：写段失败'); } }
        : real.prepare(sql),
  } as unknown as DB;
  return { db: wrapper, failSegmentInsert };
}

describe('剪辑工程路由', () => {
  it('GET /api/projects：空库 → projects 为空数组', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/projects' });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { projects: unknown[] }).projects).toEqual([]);
  });
  it('GET /api/projects/:id：来源在但没工程 → 200 project:null；来源不存在 → 404', async () => {
    const none = await app.inject({ method: 'GET', url: `/api/projects/${importId}` });
    expect(none.statusCode).toBe(200);
    expect((none.json() as { project: unknown }).project).toBeNull();
    const missing = await app.inject({ method: 'GET', url: '/api/projects/999' });
    expect(missing.statusCode).toBe(404);
  });
  it('PUT 合法 → 200 返回保存后的工程；再 GET 读到同内容（含段）', async () => {
    const put = await app.inject({
      method: 'PUT', url: `/api/projects/${importId}`,
      payload: { name: '我的工程', segments: [{ start_sec: 0, end_sec: 10, label: '开场' }, { start_sec: 30, end_sec: 45 }] },
    });
    expect(put.statusCode).toBe(200);
    const saved = (put.json() as { project: { name: string; segments: Array<{ start_sec: number; sort_order: number }> } }).project;
    expect(saved.name).toBe('我的工程');
    expect(saved.segments.map((s) => s.start_sec)).toEqual([0, 30]);
    expect(saved.segments.map((s) => s.sort_order)).toEqual([0, 1]);

    const got = (await app.inject({ method: 'GET', url: `/api/projects/${importId}` })).json() as { project: { name: string; segments: unknown[] } };
    expect(got.project.name).toBe('我的工程');
    expect(got.project.segments).toHaveLength(2);
  });
  it('PUT 不传 name → 保留旧名（首次创建则为 null）', async () => {
    await app.inject({ method: 'PUT', url: `/api/projects/${importId}`, payload: { name: '旧名', segments: [{ start_sec: 0, end_sec: 1 }] } });
    const again = await app.inject({ method: 'PUT', url: `/api/projects/${importId}`, payload: { segments: [{ start_sec: 0, end_sec: 2 }] } });
    expect((again.json() as { project: { name: string | null } }).project.name).toBe('旧名');
  });
  it('PUT 校验：start_sec<0 / end_sec≤start_sec / segments 非数组 / 51 段 / label 超 100 字 → 400', async () => {
    const put = (payload: unknown) => app.inject({ method: 'PUT', url: `/api/projects/${importId}`, payload: payload as object });
    expect((await put({ segments: [{ start_sec: -1, end_sec: 5 }] })).statusCode).toBe(400);
    expect((await put({ segments: [{ start_sec: 5, end_sec: 5 }] })).statusCode).toBe(400);
    expect((await put({ segments: { start_sec: 0, end_sec: 5 } })).statusCode).toBe(400);
    expect((await put({ segments: Array.from({ length: 51 }, (_, i) => ({ start_sec: i, end_sec: i + 1 })) })).statusCode).toBe(400);
    expect((await put({ segments: [{ start_sec: 0, end_sec: 5, label: 'x'.repeat(101) }] })).statusCode).toBe(400);
  });
  it('PUT end_sec 超素材时长（99999）→ 200（允许超长段，导出时自然截断）', async () => {
    const res = await app.inject({ method: 'PUT', url: `/api/projects/${importId}`, payload: { segments: [{ start_sec: 0, end_sec: 99999 }] } });
    expect(res.statusCode).toBe(200);
  });
  it('PUT segments:[] → 200 且段数为 0（清空剪辑点，保留工程）', async () => {
    await app.inject({ method: 'PUT', url: `/api/projects/${importId}`, payload: { name: '留着', segments: [{ start_sec: 0, end_sec: 5 }] } });
    const cleared = await app.inject({ method: 'PUT', url: `/api/projects/${importId}`, payload: { segments: [] } });
    expect(cleared.statusCode).toBe(200);
    expect((cleared.json() as { project: { segments: unknown[]; name: string | null } }).project.segments).toHaveLength(0);
    expect((cleared.json() as { project: { name: string | null } }).project.name).toBe('留着'); // 工程与名字仍在
  });
  it('PUT 来源不存在 → 404 且 error.next 明说「该来源已被删除，无法保存」', async () => {
    const res = await app.inject({ method: 'PUT', url: '/api/projects/999', payload: { segments: [] } });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: { next: string } }).error.next).toBe('该来源已被删除，无法保存');
  });
  it('DELETE 幂等：删两次都 200；第二次 deleted:0；且不动素材与已导出音频', async () => {
    createSourceVideosRepo(db).upsert({ importId, filePath: '/no/such/video.mp4', height: 480, fileSize: 1 });
    createAudioItemsRepo(db).create({ title: '已导出片段', source_type: 'edit', source_url: null, file_path: '/no/such/edit.mp3', format: 'mp3', duration_sec: 1, file_size: 1 });
    await app.inject({ method: 'PUT', url: `/api/projects/${importId}`, payload: { segments: [{ start_sec: 0, end_sec: 5 }] } });
    const first = await app.inject({ method: 'DELETE', url: `/api/projects/${importId}` });
    expect(first.statusCode).toBe(200);
    expect((first.json() as { deleted: number }).deleted).toBe(1);
    const second = await app.inject({ method: 'DELETE', url: `/api/projects/${importId}` });
    expect(second.statusCode).toBe(200);
    expect((second.json() as { deleted: number }).deleted).toBe(0); // 幂等
    // 只删工程 —— 素材行、已导出音频行原样还在
    expect(createSourceVideosRepo(db).get(importId)).not.toBeNull();
    expect(createAudioItemsRepo(db).list()).toHaveLength(1);
  });
  it('D18 接口级：写段中途失败 → 接口 500，且 GET 读到的仍是原来的 2 段', async () => {
    await app.inject({ method: 'PUT', url: `/api/projects/${importId}`, payload: { segments: [{ start_sec: 0, end_sec: 10 }, { start_sec: 20, end_sec: 30 }] } });
    const { db: failingDb, failSegmentInsert } = wrapDbForFailInjection(db);
    const failingApp = Fastify({ logger: false });
    registerProjectRoutes(failingApp, { db: failingDb, audioDir: '/no/such/audio', tempDir: '/no/such/tmp', token: 'tok' });
    try {
      failSegmentInsert.on = true;
      const res = await failingApp.inject({ method: 'PUT', url: `/api/projects/${importId}`, payload: { segments: [{ start_sec: 0, end_sec: 1 }] } });
      expect(res.statusCode).toBe(500);
    } finally {
      failSegmentInsert.on = false;
      await failingApp.close();
    }
    const after = (await app.inject({ method: 'GET', url: `/api/projects/${importId}` })).json() as { project: { segments: Array<{ start_sec: number }> } };
    expect(after.project.segments.map((s) => s.start_sec)).toEqual([0, 20]); // 旧段一条不少
  });
});
