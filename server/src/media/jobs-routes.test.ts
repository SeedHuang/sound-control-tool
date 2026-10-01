// server/src/media/jobs-routes.test.ts
// Task 4（spec D9/D16）：GET /api/jobs?active=1 与下载批次 createJobBatch 的行为固化。
// 直接在裸 Fastify 上注册（不挂 token 守卫）——token 校验属 index.ts 的 onRequest 钩子职责，不在这层。
import { describe, expect, it, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { openDatabase } from '../db/index.js';
import { initSchema } from '../db/schema.js';
import { createJobsRepo } from '../db/repo/jobs.js';
import { createJobBatch, registerJobsRoutes } from './jobs-routes.js';

let app: FastifyInstance;
let db: ReturnType<typeof openDatabase>;
let batch: ReturnType<typeof createJobBatch>;

const addJob = (kind: string, status: string, payload: unknown): number =>
  Number(db.prepare('INSERT INTO jobs (kind, payload, status) VALUES (?,?,?)').run(kind, JSON.stringify(payload), status).lastInsertRowid);

beforeEach(async () => {
  db = openDatabase(':memory:'); initSchema(db);
  batch = createJobBatch();
  app = Fastify(); registerJobsRoutes(app, { db, batch }); await app.ready();
});

describe('GET /api/jobs（spec D9/D16）', () => {
  it('active 不是 1 → 400（本切片只支持这一种查询）', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/jobs' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/jobs?active=0' })).statusCode).toBe(400);
  });
  it('只回在途（pending/running），按 id 升序；done/error 不出现', async () => {
    addJob('ytdlp_video', 'done', { url: 'https://a/1' });
    const p = addJob('ytdlp_video', 'pending', { url: 'https://a/2' });
    const r = addJob('ffmpeg_export', 'running', { importId: 1 });
    addJob('ytdlp_download', 'error', { url: 'https://a/3' });
    const body = (await app.inject({ method: 'GET', url: '/api/jobs?active=1' })).json();
    expect(body.jobs.map((j: { id: number }) => j.id)).toEqual([p, r]); // 升序
  });
  it('title 三种来源：payload.title / payload.url / 按 importId join imported_sources', async () => {
    db.prepare('INSERT INTO imported_sources (url,title,site,kind) VALUES (?,?,?,?)').run('https://a/s', '来源标题', 'bilibili', 'single');
    addJob('ytdlp_video', 'running', { url: 'https://a/u', title: '有标题' });
    addJob('ytdlp_video', 'running', { url: 'https://a/only-url' });
    addJob('ffmpeg_export', 'running', { importId: 1 });
    const titles = (await app.inject({ method: 'GET', url: '/api/jobs?active=1' })).json().jobs.map((j: { title: string }) => j.title);
    expect(titles).toEqual(['有标题', 'https://a/only-url', '来源标题']);
  });
  // 2026-10-01 spec clip-works D19:导出任务优先显示作品名(payload.workName),取不到才回退现有三级
  it('title 优先用 payload.workName;空作品名回退 payload.title', async () => {
    db.prepare('INSERT INTO imported_sources (url,title,site,kind) VALUES (?,?,?,?)').run('https://a/w', '资料标题', 'bilibili', 'single');
    addJob('ffmpeg_export', 'running', { importId: 1, workName: '我的作品', title: '资料标题' });
    addJob('ffmpeg_export', 'running', { importId: 1, workName: '', title: '回退标题' }); // 空串/空白应回退
    const titles = (await app.inject({ method: 'GET', url: '/api/jobs?active=1' })).json().jobs.map((j: { title: string }) => j.title);
    expect(titles).toEqual(['我的作品', '回退标题']);
  });
  // 2026-10-01 挂账项:job payload 是 `null`(合法 JSON)时 JSON.parse 返回 null,旧实现直接解引用 → GET /api/jobs 500
  // → 拖垮任务抽屉与托盘。解析失败/非对象一律按空载荷处理 + 一行 error 日志(不得静默)。
  it("payload 是 'null' → 不 500,按空载荷处理(标题回退 #id)", async () => {
    const id = Number(db.prepare('INSERT INTO jobs (kind, payload, status) VALUES (?,?,?)').run('ffmpeg_export', 'null', 'running').lastInsertRowid);
    const res = await app.inject({ method: 'GET', url: '/api/jobs?active=1' });
    expect(res.statusCode).toBe(200);
    const job = (res.json().jobs as Array<{ id: number; title: string; subtitle: string | null }>).find((j) => j.id === id)!;
    expect(job.title).toBe(`#${id}`);
    expect(job.subtitle).toBeNull();
  });
  it('subtitle：payload.entryIndex 有值 → 「第 N 集」，否则 null', async () => {
    addJob('ytdlp_video', 'running', { url: 'https://a/e', entryIndex: 3 });
    addJob('ytdlp_video', 'running', { url: 'https://a/n' });
    const subs = (await app.inject({ method: 'GET', url: '/api/jobs?active=1' })).json().jobs.map((j: { subtitle: string | null }) => j.subtitle);
    expect(subs).toEqual(['第 3 集', null]);
  });
  it('downloads 只统计下载类：ffmpeg_export 不计入 total', async () => {
    batch.note('ytdlp_video', 'pending');
    batch.note('ffmpeg_export', 'pending');   // 非下载类，不该进批次
    const d = (await app.inject({ method: 'GET', url: '/api/jobs?active=1' })).json().downloads;
    expect(d.total).toBe(1);
  });
  // 修复轮 1：running/queued 改为从 DB 现数（不再依赖批次内部计数，后者会因漏打点永久漂移）
  it('downloads 的 running/queued 从 DB 现数，且非下载类不计入', async () => {
    addJob('ytdlp_download', 'running', { url: 'https://a/r' });
    addJob('ytdlp_video', 'pending', { url: 'https://a/p' });
    addJob('ffmpeg_export', 'running', { importId: 1 }); // 非下载类：不该计入 running
    const d = (await app.inject({ method: 'GET', url: '/api/jobs?active=1' })).json().downloads;
    expect(d.running).toBe(1);
    expect(d.queued).toBe(1);
  });
});

describe('createJobBatch（D16 批次语义）', () => {
  it('在途 0→1 开新批，total 从 0 起；同批内再次提交累加 total', () => {
    batch.note('ytdlp_video', 'pending');           // 上一轮在途为 0 → 开批，total=1
    batch.note('ytdlp_video', 'pending');           // 同批：total=2
    expect(batch.snapshot(2)).toMatchObject({ total: 2, done: 0 });
  });
  it('任务终结 → done+1；在途归 0 后再提交 → 开新批（total/done 归零）', () => {
    batch.note('ytdlp_video', 'pending');
    batch.note('ytdlp_video', 'done');               // 终态：done=1
    expect(batch.snapshot(0)).toMatchObject({ total: 1, done: 1 });
    batch.note('ytdlp_video', 'pending');            // 上一轮在途 0 → 新批
    expect(batch.snapshot(1)).toMatchObject({ total: 1, done: 0 });
  });
  it('在途归 0 后快照保留（托盘还能显示 3/3 一会儿）', () => {
    batch.note('ytdlp_video', 'pending');
    batch.note('ytdlp_video', 'done');
    expect(batch.snapshot(0)).toMatchObject({ total: 1, done: 1 });
  });
  it('running 不再由批次维护（Minor 5）：只回 total/done，snapshot 不含 running/queued', () => {
    batch.note('ytdlp_video', 'running'); // 忽略：不参与开批、不计 total/done
    expect(batch.snapshot(0)).toEqual({ total: 0, done: 0 });
  });
  // 修复轮 1（审查 Critical 1）：排队中任务被取消 → 该单计入 done，且新一批必须能重开。
  // 旧实现里 markCancelled 漏打点 → queued 卡在 ≥1 → 开新批判据永不成立 → 托盘分数永久冻结。
  it('排队中任务被取消 → 计入 done，且新一批能重开（Critical 1）', () => {
    batch.note('ytdlp_video', 'pending');            // 提交 → total=1（在途 0→1 开批）
    expect(batch.snapshot(0)).toMatchObject({ total: 1, done: 0 }); // 此刻在途已归 0（DB 里它已 cancelled）
    batch.note('ytdlp_video', 'cancelled');          // 取消 = 终态 → done=1
    expect(batch.snapshot(0)).toMatchObject({ total: 1, done: 1 });
    batch.note('ytdlp_video', 'pending');            // 上一轮在途 0 → 新一批必须能重开
    expect(batch.snapshot(1)).toMatchObject({ total: 1, done: 0 });
  });
  // 修复轮 1（审查 Critical 2）：startDownload 在终态前 reject、由队列层兜底置 error → 也必须计入 done。
  it('队列层兜底置 error → 计入 done（Critical 2）', () => {
    batch.note('ytdlp_video', 'pending');            // 创建时已 total+1
    batch.note('ytdlp_video', 'error');              // .catch 兜底打点 → done=1
    expect(batch.snapshot(0)).toMatchObject({ total: 1, done: 1 });
  });
});
