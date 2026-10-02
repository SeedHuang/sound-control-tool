// server/src/media/project-routes.test.ts
// 作品路由（2026-10-01 spec clip-works D3/D6/D15）：路由参数 `:projectId` 是**作品 id**（不再是 import_id）。
// 直接注册在裸 Fastify 上（不挂 token 守卫）——token 校验属 index.ts 的 onRequest 钩子职责，不在这层。
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase, type DB } from '../db/index.js';
import { initSchema } from '../db/schema.js';
import { createImportsRepo } from '../db/repo/imports.js';
import { createSourceVideosRepo } from '../db/repo/source-videos.js';
import { createAudioItemsRepo } from '../db/repo/audio-items.js';
import { createClipProjectsRepo } from '../db/repo/clip-projects.js';
import { createJobsRepo } from '../db/repo/jobs.js';
import { registerProjectRoutes } from './project-routes.js';
import { startExportJob, type ExportJobPayload } from './ffmpeg-export.js'; // 已被 vi.mock 换成 spy；S1 用例断言路由真的把任务交给了它（type 导入编译期擦除，不经过 mock）

// 导出 job 本体（含 D22 在途校验）在 ffmpeg-export.test.ts 覆盖；这里只验「路由把 payload 填对了」。
// 把 startExportJob 换成空实现，避免路由测试的 fire-and-forget 任务真去拉 ffmpeg（无法 await、会污染后续用例）。
vi.mock('./ffmpeg-export.js', () => ({ startExportJob: vi.fn(async () => {}) }));

let root: string; let db: DB; let app: FastifyInstance; let seq = 0;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sct-proutes-'));
  db = openDatabase(':memory:');
  initSchema(db);
  app = Fastify({ logger: false });
  registerProjectRoutes(app, { db, audioDir: join(root, 'audio'), tempDir: join(root, 'tmp'), token: 'tok' });
});
afterEach(async () => {
  await app.close();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

/** 造 1 个资料 + 1 份**真实存在**的视频素材文件（「文件丢失」分支靠真文件系统验，不 mock existsSync）。
 *  deleteFile=true → 素材行还在但文件删掉，专门制造 FILE_MISSING。 */
const seedImportWithVideo = (opts: { title?: string; deleteFile?: boolean } = {}): number => {
  const title = opts.title ?? '资料甲';
  const id = createImportsRepo(db).upsertByUrl({
    url: `https://a/v${++seq}`, title, site: 'bilibili', kind: 'single', duration_sec: null, entries: null,
  });
  const file = join(root, `video-${id}-${seq}.mp4`);
  writeFileSync(file, 'VIDEOBYTES');
  if (opts.deleteFile) rmSync(file, { force: true });
  createSourceVideosRepo(db).upsert({ importId: id, filePath: file, height: 480, fileSize: 10 });
  return id;
};
/** 造 1 个资料但**没有素材行**（POST 应 404） */
const seedImportWithoutVideo = (): number =>
  createImportsRepo(db).upsertByUrl({
    url: `https://a/nv${++seq}`, title: '无素材', site: 'bilibili', kind: 'single', duration_sec: null, entries: null,
  });
/** 直接造一件作品（路由按作品 id 操作，多数用例不必先有资料行；clip_projects.import_id 无外键约束） */
const makeWork = (name = '作品'): number => createClipProjectsRepo(db).create(1, name).id;
/** 造一条挂在某作品下的成品（真实落盘），返回文件路径。
 *  opts.mediaKind='video' → 造视频成品（N1 T4 summary 的 latest_product_kind 用），文件名/格式随类型。 */
const mkProduct = (workId: number, name: string, opts: { mediaKind?: 'audio' | 'video' } = {}): string => {
  const f = join(root, `${name}-${++seq}.${opts.mediaKind === 'video' ? 'mp4' : 'mp3'}`);
  writeFileSync(f, 'PRODUCTBYTES');
  createAudioItemsRepo(db).create({
    title: name, source_type: 'edit', source_url: '', file_path: f,
    format: opts.mediaKind === 'video' ? 'mp4' : 'mp3', duration_sec: 1, file_size: 5, source_work_id: workId,
    media_kind: opts.mediaKind, // 不传 → repo 缺省 'audio'（与列默认一致，老调用零回归）
  });
  return f;
};
const count = (sql: string, param: number): number => Number((db.prepare(sql).get(param) as { n: number }).n);

// 接口级 D18 注入器：包一层 DB，让「写段」语句在开关打开时抛错，模拟事务中途失败；
// 其余调用完全委托真实 db（GET 仍走真实读路径）。
// 为什么要包：路由层的 parseSegments 会先把 `label: {}` 这类不可绑定值挡成 400，
// 到不了 repo 的绑定异常——所以只能在这一层人为制造一次「事务中途失败」。
function wrapDbForFailInjection(real: DB): { db: DB; failSegmentInsert: { on: boolean }; failProductDelete: { on: boolean } } {
  const failSegmentInsert = { on: false };
  const failProductDelete = { on: false }; // F-b:让「删成品行」这一步失败,验证三次 DELETE 合并后的整体回滚
  const wrapper = {
    exec: (sql: string) => real.exec(sql),
    prepare: (sql: string) => {
      if (failSegmentInsert.on && sql.startsWith('INSERT INTO clip_segments')) {
        return { run: () => { throw new TypeError('测试注入：写段失败'); } };
      }
      if (failProductDelete.on && sql.startsWith('DELETE FROM audio_items')) {
        return { run: () => { throw new TypeError('测试注入：删成品行失败'); } };
      }
      return real.prepare(sql);
    },
  } as unknown as DB;
  return { db: wrapper, failSegmentInsert, failProductDelete };
}

describe('作品路由', () => {
  it('GET /api/projects：空库 → projects 为空数组', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/projects' });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { projects: unknown[] }).projects).toEqual([]);
  });

  // D15/D23：新建作品默认名带序号；同一资料可建多个（1:N）
  it('POST /api/projects 新建作品:默认名带序号,同一资料可建两个', async () => {
    const imp = seedImportWithVideo();
    const r1 = await app.inject({ method: 'POST', url: '/api/projects', payload: { importId: imp } });
    expect(r1.statusCode).toBe(201);
    expect((r1.json() as { project: { name: string } }).project.name).toBe('《资料甲》 的剪辑');
    const r2 = await app.inject({ method: 'POST', url: '/api/projects', payload: { importId: imp } });
    expect(r2.statusCode).toBe(201);
    expect((r2.json() as { project: { name: string } }).project.name).toBe('《资料甲》 的剪辑 2');
    expect((r2.json() as { project: { id: number } }).project.id).not.toBe((r1.json() as { project: { id: number } }).project.id);
  });

  it('POST 无视频素材 / 素材文件丢失 → 404(后者 FILE_MISSING 且带 next)', async () => {
    const imp = seedImportWithoutVideo();
    const r = await app.inject({ method: 'POST', url: '/api/projects', payload: { importId: imp } });
    expect(r.statusCode).toBe(404);
    const imp2 = seedImportWithVideo({ deleteFile: true });
    const r2 = await app.inject({ method: 'POST', url: '/api/projects', payload: { importId: imp2 } });
    expect(r2.statusCode).toBe(404);
    expect((r2.json() as { error: { code: string } }).error.code).toBe('FILE_MISSING');
    expect((r2.json() as { error: { next: string } }).error.next).not.toBe(''); // 错误必须带可执行的下一步
  });

  it('GET /api/projects/:projectId：作品不存在 → 404；存在 → 返回详情(含段)', async () => {
    const none = await app.inject({ method: 'GET', url: '/api/projects/999' });
    expect(none.statusCode).toBe(404);
    const wid = makeWork('作品甲');
    await app.inject({ method: 'PUT', url: `/api/projects/${wid}`, payload: { segments: [{ start_sec: 0, end_sec: 5 }] } });
    const got = await app.inject({ method: 'GET', url: `/api/projects/${wid}` });
    expect(got.statusCode).toBe(200);
    const p = (got.json() as { project: { id: number; segments: unknown[] } }).project;
    expect(p.id).toBe(wid);
    expect(p.segments).toHaveLength(1);
  });

  it('PUT 合法 → 200 返回保存后的作品；再 GET 读到同内容（含段）', async () => {
    const wid = makeWork('工作');
    const put = await app.inject({
      method: 'PUT', url: `/api/projects/${wid}`,
      payload: { name: '我的作品', segments: [{ start_sec: 0, end_sec: 10, label: '开场' }, { start_sec: 30, end_sec: 45 }] },
    });
    expect(put.statusCode).toBe(200);
    const saved = (put.json() as { project: { name: string; segments: Array<{ start_sec: number; sort_order: number }> } }).project;
    expect(saved.name).toBe('我的作品');
    expect(saved.segments.map((s) => s.start_sec)).toEqual([0, 30]);
    expect(saved.segments.map((s) => s.sort_order)).toEqual([0, 1]);

    const got = (await app.inject({ method: 'GET', url: `/api/projects/${wid}` })).json() as { project: { name: string; segments: unknown[] } };
    expect(got.project.name).toBe('我的作品');
    expect(got.project.segments).toHaveLength(2);
  });

  it('PUT 不传 name → 保留旧名', async () => {
    const wid = makeWork('工作');
    await app.inject({ method: 'PUT', url: `/api/projects/${wid}`, payload: { name: '旧名', segments: [{ start_sec: 0, end_sec: 1 }] } });
    const again = await app.inject({ method: 'PUT', url: `/api/projects/${wid}`, payload: { segments: [{ start_sec: 0, end_sec: 2 }] } });
    expect((again.json() as { project: { name: string | null } }).project.name).toBe('旧名');
  });

  it('PUT 校验：start_sec<0 / end_sec≤start_sec / segments 非数组 / 51 段 / label 超 100 字 → 400', async () => {
    const wid = makeWork('工作');
    const put = (payload: unknown) => app.inject({ method: 'PUT', url: `/api/projects/${wid}`, payload: payload as object });
    expect((await put({ segments: [{ start_sec: -1, end_sec: 5 }] })).statusCode).toBe(400);
    expect((await put({ segments: [{ start_sec: 5, end_sec: 5 }] })).statusCode).toBe(400);
    expect((await put({ segments: { start_sec: 0, end_sec: 5 } })).statusCode).toBe(400);
    expect((await put({ segments: Array.from({ length: 51 }, (_, i) => ({ start_sec: i, end_sec: i + 1 })) })).statusCode).toBe(400);
    expect((await put({ segments: [{ start_sec: 0, end_sec: 5, label: 'x'.repeat(101) }] })).statusCode).toBe(400);
  });

  it('PUT end_sec 超素材时长（99999）→ 200（允许超长段，导出时自然截断）', async () => {
    const wid = makeWork('工作');
    const res = await app.inject({ method: 'PUT', url: `/api/projects/${wid}`, payload: { segments: [{ start_sec: 0, end_sec: 99999 }] } });
    expect(res.statusCode).toBe(200);
  });

  it('PUT segments:[] → 200 且段数为 0（清空剪辑点，保留作品）', async () => {
    const wid = makeWork('留着');
    await app.inject({ method: 'PUT', url: `/api/projects/${wid}`, payload: { name: '留着', segments: [{ start_sec: 0, end_sec: 5 }] } });
    const cleared = await app.inject({ method: 'PUT', url: `/api/projects/${wid}`, payload: { segments: [] } });
    expect(cleared.statusCode).toBe(200);
    expect((cleared.json() as { project: { segments: unknown[]; name: string | null } }).project.segments).toHaveLength(0);
    expect((cleared.json() as { project: { name: string | null } }).project.name).toBe('留着'); // 作品与名字仍在
  });

  it('PUT 作品不存在 → 404 且带可执行的 next', async () => {
    const res = await app.inject({ method: 'PUT', url: '/api/projects/999', payload: { segments: [] } });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: { next: string } }).error.next).not.toBe('');
  });

  // D6：删作品连带删它的成品（DB 行 + 磁盘文件），不影响别的作品
  it('DELETE 作品 → 连它的成品一起删(DB 行 + 磁盘文件),不影响别的作品', async () => {
    const imp = seedImportWithVideo();
    const repo = createClipProjectsRepo(db);
    const a = repo.create(imp, '作品甲');
    repo.update(a.id, '作品甲', [{ start_sec: 0, end_sec: 1 }]);
    const b = repo.create(imp, '作品乙');
    const aFiles = [mkProduct(a.id, 'a1'), mkProduct(a.id, 'a2')];
    const bFile = mkProduct(b.id, 'b1');

    const res = await app.inject({ method: 'DELETE', url: `/api/projects/${a.id}` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { deleted: number; deleted_products: number };
    expect(body.deleted).toBe(1);
    expect(body.deleted_products).toBe(2);
    // A 的作品行 / 段 / 成品行 / 文件都没了
    expect(repo.get(a.id)).toBeNull();
    expect(count('SELECT COUNT(*) AS n FROM clip_segments WHERE project_id = ?', a.id)).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM audio_items WHERE source_work_id = ?', a.id)).toBe(0);
    expect(aFiles.every((f) => !existsSync(f))).toBe(true);
    // B 原样保留
    expect(repo.get(b.id)).not.toBeNull();
    expect(count('SELECT COUNT(*) AS n FROM audio_items WHERE source_work_id = ?', b.id)).toBe(1);
    expect(existsSync(bFile)).toBe(true);
  });

  // N1 D4（spec video-export，2026-10-02 审查 Minor①）：删除链按行删、kind 无关——上面的 D6 用例只造了音频成品，
  // 本用例把 media_kind='video' 的成品行喂进同一条 DELETE 链，锁住「视频成品同样被连带删干净」。
  // 运行时控制器已在真机用真实 API 删过两个带视频成品的测试作品；这条是把行为钉进测试。
  // RED 反证（不碰产品代码的推演）：删掉 project-routes.ts DELETE 链事务里的
  // `DELETE FROM audio_items WHERE source_work_id = ?`（:121）→ 成品行残留 + deleted_products=0 → 断言红；
  // 删掉事务提交后的 unlinkSync 循环（:125-137）→ 磁盘文件残留 → existsSync 断言红；
  // 删掉 `DELETE FROM clip_projects`（:120）→ deleted=0 且 repo.get 非 null → 断言红。
  it('DELETE 作品 → 视频成品也连带删干净(DB 行 + 磁盘文件 + 作品行),kind 无关', async () => {
    const repo = createClipProjectsRepo(db);
    const w = repo.create(1, '作品甲');
    const vf = mkProduct(w.id, 'pv', { mediaKind: 'video' }); // media_kind='video' 成品行,文件真实落盘
    // 前置自证:视频成品行确实入库、文件确实在
    expect(count("SELECT COUNT(*) AS n FROM audio_items WHERE source_work_id = ? AND media_kind = 'video'", w.id)).toBe(1);
    expect(existsSync(vf)).toBe(true);
    const res = await app.inject({ method: 'DELETE', url: `/api/projects/${w.id}` });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { deleted: number; deleted_products: number }).deleted).toBe(1);
    expect((res.json() as { deleted: number; deleted_products: number }).deleted_products).toBe(1);
    expect(repo.get(w.id)).toBeNull(); // 作品行没了
    expect(count('SELECT COUNT(*) AS n FROM audio_items WHERE source_work_id = ?', w.id)).toBe(0); // 成品行没了
    expect(existsSync(vf)).toBe(false); // 磁盘文件没了
  });

  it('DELETE 作品的文件删不掉(文件不存在) → 接口仍 200(不阻断)', async () => {
    const repo = createClipProjectsRepo(db);
    const w = repo.create(1, '作品');
    const f = mkProduct(w.id, 'gone');
    rmSync(f, { force: true }); // 先把文件删掉，再删作品
    const res = await app.inject({ method: 'DELETE', url: `/api/projects/${w.id}` });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { deleted_products: number }).deleted_products).toBe(1);
  });

  it('DELETE 幂等：删两次都 200；第二次 deleted:0；且不动素材与无归属音频', async () => {
    const repo = createClipProjectsRepo(db);
    const wid = repo.create(1, '工作').id;
    createSourceVideosRepo(db).upsert({ importId: 1, filePath: '/no/such/video.mp4', height: 480, fileSize: 1 });
    createAudioItemsRepo(db).create({ title: '无归属片段', source_type: 'edit', source_url: null, file_path: '/no/such/edit.mp3', format: 'mp3', duration_sec: 1, file_size: 1 });
    await app.inject({ method: 'PUT', url: `/api/projects/${wid}`, payload: { segments: [{ start_sec: 0, end_sec: 5 }] } });
    const first = await app.inject({ method: 'DELETE', url: `/api/projects/${wid}` });
    expect(first.statusCode).toBe(200);
    expect((first.json() as { deleted: number }).deleted).toBe(1);
    const second = await app.inject({ method: 'DELETE', url: `/api/projects/${wid}` });
    expect(second.statusCode).toBe(200);
    expect((second.json() as { deleted: number }).deleted).toBe(0); // 幂等
    // 只删作品 —— 素材行、无归属音频行原样还在
    expect(createSourceVideosRepo(db).get(1)).not.toBeNull();
    expect(createAudioItemsRepo(db).list()).toHaveLength(1);
  });

  it('D18 接口级：写段中途失败 → 接口 500，且 GET 读到的仍是原来的 2 段', async () => {
    const wid = makeWork('工作');
    await app.inject({ method: 'PUT', url: `/api/projects/${wid}`, payload: { segments: [{ start_sec: 0, end_sec: 10 }, { start_sec: 20, end_sec: 30 }] } });
    const { db: failingDb, failSegmentInsert } = wrapDbForFailInjection(db);
    const failingApp = Fastify({ logger: false });
    registerProjectRoutes(failingApp, { db: failingDb, audioDir: '/no/such/audio', tempDir: '/no/such/tmp', token: 'tok' });
    try {
      failSegmentInsert.on = true;
      const res = await failingApp.inject({ method: 'PUT', url: `/api/projects/${wid}`, payload: { segments: [{ start_sec: 0, end_sec: 1 }] } });
      expect(res.statusCode).toBe(500);
    } finally {
      failSegmentInsert.on = false;
      await failingApp.close();
    }
    const after = (await app.inject({ method: 'GET', url: `/api/projects/${wid}` })).json() as { project: { segments: Array<{ start_sec: number }> } };
    expect(after.project.segments.map((s) => s.start_sec)).toEqual([0, 20]); // 旧段一条不少
  });

  // F-b（2026-10-01 OCR 审查）：三条 DELETE 合并进同一事务后，任一步失败整体回滚——
  // 不允许出现「作品行没了、成品行还在」的半删态（悬空 source_work_id + 孤儿文件，正是 D6/D22 要避免的）。
  it('D6 接口级：删成品行失败 → 500 且作品行/段/成品行全部原样保留（整体回滚）', async () => {
    const repo = createClipProjectsRepo(db);
    const w = repo.create(1, '作品');
    repo.update(w.id, '作品', [{ start_sec: 0, end_sec: 1 }]);
    mkProduct(w.id, 'p1');
    const { db: failingDb, failProductDelete } = wrapDbForFailInjection(db);
    const failingApp = Fastify({ logger: false });
    registerProjectRoutes(failingApp, { db: failingDb, audioDir: '/no/such/audio', tempDir: '/no/such/tmp', token: 'tok' });
    try {
      failProductDelete.on = true;
      const res = await failingApp.inject({ method: 'DELETE', url: `/api/projects/${w.id}` });
      expect(res.statusCode).toBe(500);
    } finally {
      failProductDelete.on = false;
      await failingApp.close();
    }
    // 要么全删、要么都不动：作品行 / 段 / 成品行一条不少
    expect(repo.get(w.id)).not.toBeNull();
    expect(count('SELECT COUNT(*) AS n FROM clip_segments WHERE project_id = ?', w.id)).toBe(1);
    expect(count('SELECT COUNT(*) AS n FROM audio_items WHERE source_work_id = ?', w.id)).toBe(1);
  });

  // D19/D22：导出 payload 带 projectId/workName；作品不存在 → 404
  it('导出 payload 带 projectId/workName;作品不存在 → 404', async () => {
    const imp = seedImportWithVideo();
    const w = createClipProjectsRepo(db).create(imp, '作品甲');
    const bad = await app.inject({
      method: 'POST', url: '/api/projects/999/export',
      payload: { mode: 'merge', format: 'mp3', segments: [{ start_sec: 0, end_sec: 1 }] },
    });
    expect(bad.statusCode).toBe(404);
    const r = await app.inject({
      method: 'POST', url: `/api/projects/${w.id}/export`,
      payload: { mode: 'merge', format: 'mp3', segments: [{ start_sec: 0, end_sec: 1 }] },
    });
    expect(r.statusCode).toBe(201);
    const job = createJobsRepo(db).get((r.json() as { jobId: number }).jobId)!;
    const saved = JSON.parse(job.payload) as { projectId: number; workName: string | null; importId: number };
    expect(saved.projectId).toBe(w.id);
    expect(saved.workName).toBe('作品甲');
    expect(saved.importId).toBe(imp); // 视频路径仍靠 importId
  });

  // S1(2026-10-02 deferred 批,账本 T3):导出路由的 `void startExportJob(...)` 是 fire-and-forget——
  // 把这一行删掉,旧测试仍全绿(任务「真的跑起来」这件事零覆盖)。本用例锁住「路由确实把任务交给了 runner」:
  // mock 版 startExportJob 模拟真实现入口的第一件事(置 running,ffmpeg-export.ts:39 同款),再用 vi.waitFor
  // 轮询 jobs 表等状态推进,并核对传给 runner 的 jobId 与 deps。把 `void startExportJob(...)` 删掉 →
  // mock 不再被调 → 状态停在 pending → 本用例变红(RED 证据见 deferred-batch-report.md)。
  it('导出 201 后任务真的被启动:startExportJob 被调用且 job 状态推进到 running', async () => {
    const imp = seedImportWithVideo();
    const w = createClipProjectsRepo(db).create(imp, '作品甲');
    // spy 是文件级共享的(前一个导出用例已调用过一次):先清调用历史,只清 calls 不动实现
    vi.mocked(startExportJob).mockClear();
    // Once:只在本用例消费一次,后续用例回落到模块级空实现,互不污染
    vi.mocked(startExportJob).mockImplementationOnce(async (jobId) => {
      createJobsRepo(db).update(jobId, { status: 'running' }); // 与真实现入口同款:先置 running
    });
    const r = await app.inject({
      method: 'POST', url: `/api/projects/${w.id}/export`,
      payload: { mode: 'merge', format: 'mp3', segments: [{ start_sec: 0, end_sec: 1 }] },
    });
    expect(r.statusCode).toBe(201);
    const jobId = (r.json() as { jobId: number }).jobId;
    // fire-and-forget 不可 await:轮询 jobs 表,等任务入口把状态从 pending 推进到 running
    await vi.waitFor(() => {
      expect(createJobsRepo(db).get(jobId)!.status).toBe('running');
    });
    // 交给 runner 的参数:jobId 与 201 响应对得上;deps 三件套原样透传(真实现要靠它们写库/落盘)
    expect(startExportJob).toHaveBeenCalledTimes(1);
    const [calledJobId, , depsArg] = vi.mocked(startExportJob).mock.calls[0]!;
    expect(calledJobId).toBe(jobId);
    expect(depsArg.db).toBe(db);
    expect(depsArg.audioDir).toBe(join(root, 'audio'));
    expect(depsArg.tempDir).toBe(join(root, 'tmp'));
  });

  // ===== 2026-10-02 N1 Task 4(spec video-export):导出内容 mediaKind 校验矩阵 =====
  // ① video + format=mp3 → 400(视频导出仅支持 mp4)
  it('导出 mediaKind=video + format=mp3 → 400(文案含 mp4)', async () => {
    const imp = seedImportWithVideo();
    const w = createClipProjectsRepo(db).create(imp, '作品甲');
    const r = await app.inject({
      method: 'POST', url: `/api/projects/${w.id}/export`,
      payload: { mode: 'merge', format: 'mp3', mediaKind: 'video', segments: [{ start_sec: 0, end_sec: 1 }] },
    });
    expect(r.statusCode).toBe(400);
    expect((r.json() as { error: { message: string } }).error.message).toContain('mp4');
  });

  // ② 老客户端回归:body 不带 mediaKind + format=mp3 → 按 audio 处理(缺省 'audio'),payload 落 mediaKind='audio'
  it('导出 老客户端不传 mediaKind + format=mp3 → 仍成功(payload.mediaKind=audio)', async () => {
    const imp = seedImportWithVideo();
    const w = createClipProjectsRepo(db).create(imp, '作品甲');
    const r = await app.inject({
      method: 'POST', url: `/api/projects/${w.id}/export`,
      payload: { mode: 'merge', format: 'mp3', segments: [{ start_sec: 0, end_sec: 1 }] },
    });
    expect(r.statusCode).toBe(201);
    const job = createJobsRepo(db).get((r.json() as { jobId: number }).jobId)!;
    const saved = JSON.parse(job.payload) as { mediaKind?: string };
    expect(saved.mediaKind).toBe('audio');
  });

  // ③ video + format=mp4 → payload 带 mediaKind='video'/videoAn(照 S1 用 startExportJob mock 捕获 payload;
  //   ExportJobPayload.format 类型未含 'mp4',运行时值断言用 as string 宽化比较)
  it('导出 mediaKind=video + format=mp4 → payload.mediaKind=video、videoAn 透传(缺省 false)', async () => {
    const imp = seedImportWithVideo();
    const w = createClipProjectsRepo(db).create(imp, '作品甲');
    vi.mocked(startExportJob).mockClear(); // spy 文件级共享,先清调用历史(照 S1 做法)
    const send = (videoAn?: boolean) => app.inject({
      method: 'POST', url: `/api/projects/${w.id}/export`,
      payload: { mode: 'separate', format: 'mp4', mediaKind: 'video', ...(videoAn === undefined ? {} : { videoAn }), segments: [{ start_sec: 0, end_sec: 1 }] },
    });
    const withAn = await send(true);
    expect(withAn.statusCode).toBe(201);
    const deflt = await send(); // videoAn 缺省 → false(带音轨,实测 A3)
    expect(deflt.statusCode).toBe(201);
    expect(startExportJob).toHaveBeenCalledTimes(2);
    const first = vi.mocked(startExportJob).mock.calls[0]![1] as ExportJobPayload;
    expect(first.mediaKind).toBe('video');
    expect(first.videoAn).toBe(true);
    expect(first.format as string).toBe('mp4');
    const second = vi.mocked(startExportJob).mock.calls[1]![1] as ExportJobPayload;
    expect(second.videoAn).toBe(false);
  });

  // videoAn 仅 video 有意义且必须是 boolean 或缺省:乱传字符串 → 400
  it('导出 mediaKind=video + videoAn 非布尔 → 400(文案含 videoAn)', async () => {
    const imp = seedImportWithVideo();
    const w = createClipProjectsRepo(db).create(imp, '作品甲');
    const r = await app.inject({
      method: 'POST', url: `/api/projects/${w.id}/export`,
      payload: { mode: 'merge', format: 'mp4', mediaKind: 'video', videoAn: 'yes', segments: [{ start_sec: 0, end_sec: 1 }] },
    });
    expect(r.statusCode).toBe(400);
    expect((r.json() as { error: { message: string } }).error.message).toContain('videoAn');
  });

  // ④ mediaKind 传了别的值 → 400
  it('导出 mediaKind=bogus → 400(文案含 mediaKind)', async () => {
    const imp = seedImportWithVideo();
    const w = createClipProjectsRepo(db).create(imp, '作品甲');
    const r = await app.inject({
      method: 'POST', url: `/api/projects/${w.id}/export`,
      payload: { mode: 'merge', format: 'mp3', mediaKind: 'bogus', segments: [{ start_sec: 0, end_sec: 1 }] },
    });
    expect(r.statusCode).toBe(400);
    expect((r.json() as { error: { message: string } }).error.message).toContain('mediaKind');
  });

  // ⑤ audio 回归矩阵:三个合法格式各一次全过(显式 mediaKind='audio',前端 T5 会显式传)
  it('导出 audio 回归矩阵:mp3/m4a/wav 各一次全过', async () => {
    const imp = seedImportWithVideo();
    const w = createClipProjectsRepo(db).create(imp, '作品甲');
    for (const format of ['mp3', 'm4a', 'wav'] as const) {
      const r = await app.inject({
        method: 'POST', url: `/api/projects/${w.id}/export`,
        payload: { mode: 'merge', format, mediaKind: 'audio', segments: [{ start_sec: 0, end_sec: 1 }] },
      });
      expect(r.statusCode).toBe(201);
    }
  });

  // ⑥ summary:latest_product_kind 与 latest_product_id 同源(同一行)——
  //    无成品 → null;音频成品 → 'audio';再插视频成品(后插 = 最新)→ 'video'
  it('GET /api/projects summary:latest_product_kind 跟随最新成品(null/audio/video)', async () => {
    const wid = makeWork('作品甲');
    const rowOf = async () => {
      const res = await app.inject({ method: 'GET', url: '/api/projects' });
      const rows = (res.json() as { projects: Array<{ id: number; latest_product_kind: string | null }> }).projects;
      return rows.find((p) => p.id === wid)!;
    };
    expect((await rowOf()).latest_product_kind).toBeNull();   // 无成品 → null(与 latest_product_id 的 null 同步)
    mkProduct(wid, 'pa');
    expect((await rowOf()).latest_product_kind).toBe('audio'); // 音频成品
    mkProduct(wid, 'pv', { mediaKind: 'video' });              // 后插视频成品 → 成为最新
    expect((await rowOf()).latest_product_kind).toBe('video');
  });
});
