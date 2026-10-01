// server/src/ytdlp/ytdlp-routes.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Fastify, { type FastifyInstance } from 'fastify';
import { openDatabase, type DB } from '../db/index.js';
import { initSchema } from '../db/schema.js';
import { registerYtdlpRoutes, type DownloadJobPayload, type YtdlpDeps } from './ytdlp-routes.js';
import { createDownloadQueue } from './download-queue.js';
import { createDownloadManager } from './download.js';
import { createJobsRepo } from '../db/repo/jobs.js';
import { createAudioItemsRepo } from '../db/repo/audio-items.js';
import { createSourceVideosRepo } from '../db/repo/source-videos.js';
import { createClipProjectsRepo } from '../db/repo/clip-projects.js';
import { getLogs, registerRequestLogging } from '../logs.js';
import { createSettingsRepo } from '../db/repo/settings.js';
import { createImportsRepo } from '../db/repo/imports.js';
import { BILI_COOKIE_KEY, SETTINGS_KEYS } from '../settings-keys.js';
import { registerSettingsRoutes } from '../http/settings-routes.js';

// parse success 用例:mock parseMetadata 返回成功,避免真实 execFile 拉 yt-dlp;
// YtdlpRunError 保留真身(importOriginal 展开),不影响既有 400/409 用例(它们不触达 parseMetadata)
vi.mock('./parse.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./parse.js')>();
  return {
    ...actual,
    parseMetadata: vi.fn(async () => ({ kind: 'single', title: '课', durationSec: 61.5, thumbnail: 'https://t/1.jpg' })),
  };
});

// bili-login 在线校验 mock(不发真网;cookie 校验逻辑本身在 bili-login 单测/真机验证覆盖)
vi.mock('./bili-login.js', () => ({
  validateBiliLogin: vi.fn(async () => ({ requestOk: true, isLogin: true, uname: '测试号' })),
}));

let db: DB;
let app: FastifyInstance;
let tempDir: string; // 每用例独立真实 tempDir(startDownload 会 mkdirSync 子目录;用 'C:/tmp' 会在机器上留残余)
let mediaDir: string; // 视频素材目录(批4 Task 9):produce=video 的 finalize 落这里
beforeEach(async () => {
  db = openDatabase(':memory:'); initSchema(db);
  app = Fastify({ logger: false });
  tempDir = mkdtempSync(join(tmpdir(), 'sct-ytdlp-tmp-'));
  mediaDir = join(tempDir, 'media');
});
afterEach(async () => {
  app.server.closeAllConnections?.(); // 强制关闭残留 SSE/keep-alive 连接,防 app.close() 悬挂
  await app.close(); db.close(); rmSync(tempDir, { recursive: true, force: true });
});

function makeApp(
  binPath: string | null,
  token = 'tok',
  dm?: ReturnType<typeof createDownloadManager>,
  coverFetcher?: YtdlpDeps['coverFetcher'],
  coverWriter?: YtdlpDeps['coverWriter'],
  clipStarter?: YtdlpDeps['clipStarter'],
  exportStarter?: YtdlpDeps['exportStarter'],
) {
  // audioDir 用临时子目录:Cookie 注入会把 cookies.txt 物化到 dirname(audioDir),不能写真机 C:/ 根
  const audioDir = join(tempDir, 'audio');
  mkdirSync(audioDir, { recursive: true });
  // 视频素材目录(批4 裁定 5:YtdlpDeps 加 mediaDir 后 makeApp 的必要连带)
  mkdirSync(mediaDir, { recursive: true });
  registerSettingsRoutes(app, db, audioDir); // 第三参=导出目录默认值（留空时用它）
  // Task 1:提交/重试改走并发受限队列——测试里装配一个「上限 1」的真队列(与 index.ts 同款接线),
  // 既有用例因此继续走「提交即 201 → job 转 running → dm.start 被调」这条路径。
  const jobsRepo = createJobsRepo(db);
  let handlers: {
    startDownload: (jobId: number, payload: DownloadJobPayload, onSettled?: () => void) => Promise<void>;
  } | null = null;
  const queue = createDownloadQueue({
    limit: () => 1,
    start: (jobId) =>
      new Promise<void>((resolve) => {
        const job = jobsRepo.get(jobId);
        if (job === null || handlers === null) { resolve(); return; }
        void handlers.startDownload(jobId, JSON.parse(job.payload) as DownloadJobPayload, resolve).catch(() => resolve());
      }),
    markCancelled: (jobId) => jobsRepo.update(jobId, { status: 'cancelled' }),
  });
  return registerYtdlpRoutes(app, {
    db,
    binProvider: async () => ({ path: binPath }),
    downloadManager: dm ?? createDownloadManager(),
    audioDir, mediaDir, tempDir, token,
    queue,
    onDownloadHandlers: (h) => { handlers = h; },
    // 默认注入桩:两条抓封面路径都失败。否则解析用例(带 mock 出来的封面地址)会真的发网络请求 / 真拉 yt-dlp(测试必须封闭)
    coverFetcher: coverFetcher ?? (async () => false),
    coverWriter: coverWriter ?? (async () => false),
    clipStarter,
    exportStarter,
  });
}

describe('POST /api/ytdlp/parse', () => {
  it('url 缺失 → 400', async () => {
    makeApp('yt-dlp');
    const res = await app.inject({ method: 'POST', url: '/api/ytdlp/parse', payload: {} });
    expect(res.statusCode).toBe(400);
  });
  it('bin 缺失 → 409 YTDLP_NOT_FOUND', async () => {
    makeApp(null);
    const res = await app.inject({ method: 'POST', url: '/api/ytdlp/parse', payload: { url: 'https://a' } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('YTDLP_NOT_FOUND');
  });
  it('parse 成功 → ok:true 且 duration_sec 下划线契约(评审 Minor 补)', async () => {
    makeApp('yt-dlp');
    const res = await app.inject({ method: 'POST', url: '/api/ytdlp/parse', payload: { url: 'https://a' } });
    expect(res.statusCode).toBe(200);
    const j = res.json();
    expect(j.ok).toBe(true);
    expect(j.kind).toBe('single');
    expect(j.title).toBe('课');
    expect(j.duration_sec).toBe(61.5);
    expect(j.thumbnail).toBe('https://t/1.jpg');
  });
});

describe('POST /api/ytdlp/download', () => {
  it('download format 非法 → 400', async () => {
    makeApp('yt-dlp', 'tok2');
    const res = await app.inject({ method: 'POST', url: '/api/ytdlp/download', payload: { url: 'u', options: { format: 'flac' } } });
    expect(res.statusCode).toBe(400);
  });
  // 2026-09-29 用户拍板:判重不再只看网址——按「网址 + 第几集」认同一集;单视频按「网址 + 标题」。
  // 起因:条目下载曾经完全不判重,同一集重下会静默留两份(用户实测踩到,手动删过一次)。
  it('单视频重下(同网址 + 同标题)非 force → 409 DUPLICATE', async () => {
    createAudioItemsRepo(db).create({ title: '课', source_type: 'download', source_url: 'https://a/1', file_path: 'C:/x/a.mp3', format: 'mp3', duration_sec: null, file_size: 1 });
    makeApp('yt-dlp', 'tok2');
    const res = await app.inject({ method: 'POST', url: '/api/ytdlp/download', payload: { url: 'https://a/1', title: '课', options: { format: 'mp3' } } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('DUPLICATE');
  });
  it('合集条目重下(同网址 + 同 entry_index)非 force → 409 DUPLICATE', async () => {
    createAudioItemsRepo(db).create({ title: '条目 1', source_type: 'download', source_url: 'https://a/pl', file_path: 'C:/x/1.mp3', format: 'mp3', duration_sec: null, file_size: 1, entry_index: 1, collection_title: '某合集' });
    makeApp('yt-dlp', 'tok2');
    const res = await app.inject({ method: 'POST', url: '/api/ytdlp/download', payload: { url: 'https://a/pl', title: '条目 1', entryIndex: 1, options: { format: 'mp3', entryIndices: [1] } } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('DUPLICATE');
    expect(res.json().error.message).toContain('第 1 集');
  });
  it('老记录没记集数 → 按标题兜底认得出是同一集(条目 94 这种改动前入库的行)', async () => {
    createAudioItemsRepo(db).create({ title: '条目 94', source_type: 'download', source_url: 'https://a/pl', file_path: 'C:/x/94.mp3', format: 'mp3', duration_sec: null, file_size: 1 }); // entry_index 落 NULL
    makeApp('yt-dlp', 'tok2');
    const res = await app.inject({ method: 'POST', url: '/api/ytdlp/download', payload: { url: 'https://a/pl', title: '条目 94', entryIndex: 94, options: { format: 'mp3', entryIndices: [94] } } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('DUPLICATE');
  });
  it('确认覆盖(force)→ 新文件入库成功后才删掉旧行与旧文件,只留新的', async () => {
    const audioRepo = createAudioItemsRepo(db);
    const oldPath = join(tempDir, 'old-1.mp3'); writeFileSync(oldPath, 'old');
    const oldId = audioRepo.create({ title: '条目 1', source_type: 'download', source_url: 'https://a/pl', file_path: oldPath, format: 'mp3', duration_sec: null, file_size: 3, entry_index: 1, collection_title: '某合集' });
    const producedPath = join(tempDir, 'new-1.mp3'); writeFileSync(producedPath, 'new');
    let fire: (() => void) | undefined;
    const dm = {
      start: vi.fn((opts: { jobId: number; onEvent: (jid: number, ev: unknown) => void }) => {
        fire = () => opts.onEvent(opts.jobId, { type: 'status', state: 'done', producedPath });
      }),
      cancel: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    makeApp('yt-dlp', 'tok2', dm as unknown as ReturnType<typeof createDownloadManager>);
    const res = await app.inject({ method: 'POST', url: '/api/ytdlp/download', payload: { url: 'https://a/pl', title: '条目 1', entryIndex: 1, options: { format: 'mp3', entryIndices: [1], force: true } } });
    expect(res.statusCode).toBe(201);
    const jobId = res.json().jobId as number;
    fire!(); // 下载进程退出 → 真 finalize(入库 + 覆盖删旧)
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && createJobsRepo(db).get(jobId)!.status !== 'done') await new Promise((r) => setTimeout(r, 20));
    const rows = audioRepo.list();
    expect(rows).toHaveLength(1); // 只留新的一份
    expect(rows[0]!.id).not.toBe(oldId);
    expect(rows[0]!.entry_index).toBe(1);
    expect(existsSync(oldPath)).toBe(false); // 旧文件真的删了
  });
  // 2026-10-01 spec audio-lineage D3:音频下载入库也要写血缘(按 URL 反查来源 id)
  it('下载音频入库 → source_import_id = 该 URL 对应来源', async () => {
    const audioRepo = createAudioItemsRepo(db);
    const importId = createImportsRepo(db).upsertByUrl({
      url: 'https://a/pl', title: '条目 1', site: 'bilibili', kind: 'single', duration_sec: null, entries: null,
    });
    const producedPath = join(tempDir, 'blood-1.mp3'); writeFileSync(producedPath, 'new');
    let fire: (() => void) | undefined;
    const dm = {
      start: vi.fn((opts: { jobId: number; onEvent: (jid: number, ev: unknown) => void }) => {
        fire = () => opts.onEvent(opts.jobId, { type: 'status', state: 'done', producedPath });
      }),
      cancel: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    makeApp('yt-dlp', 'tok2', dm as unknown as ReturnType<typeof createDownloadManager>);
    const res = await app.inject({ method: 'POST', url: '/api/ytdlp/download', payload: { url: 'https://a/pl', title: '条目 1', options: { format: 'mp3', entryIndices: [1] } } });
    expect(res.statusCode).toBe(201);
    const jobId = res.json().jobId as number;
    fire!();
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && createJobsRepo(db).get(jobId)!.status !== 'done') await new Promise((r) => setTimeout(r, 20));
    const rows = audioRepo.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.source_import_id).toBe(importId);
  });
  it('同网址不同集(第 1 集已入库,请求第 2 集)→ 201,不误伤其它集', async () => {
    // 判重按「网址 + 第几集」:库里第 1 集(老记录,entry_index 落 NULL,标题「第1集已入库」),
    // 请求第 2 集(entryIndices [2] + 标题「第2集」)→ 集数与标题都对不上 → 必须放行,否则批量永远只能下出第 1 集。
    // 假 DM 只记录 start,不真 spawn。
    const dm = { start: vi.fn(), cancel: vi.fn(async () => {}), dispose: vi.fn(async () => {}) };
    createAudioItemsRepo(db).create({ title: '第1集已入库', source_type: 'download', source_url: 'https://a/1', file_path: 'C:/x/1.mp3', format: 'mp3', duration_sec: null, file_size: 1 });
    makeApp('yt-dlp', 'tok2', dm as unknown as ReturnType<typeof createDownloadManager>);
    const res = await app.inject({ method: 'POST', url: '/api/ytdlp/download', payload: { url: 'https://a/1', title: '第2集', options: { format: 'mp3', entryIndices: [2] } } });
    expect(res.statusCode).toBe(201);
    expect(typeof res.json().jobId).toBe('number');
  });
  // 2026-09-29 用户拍板:合集条目下载带上「第几集/所属合集」→ 存进 job payload(retry 复用),入库后才写 audio_items
  it('合集条目下载携带 entryIndex/collectionTitle → 存档进 job payload', async () => {
    const dm = { start: vi.fn(), cancel: vi.fn(async () => {}), dispose: vi.fn(async () => {}) };
    makeApp('yt-dlp', 'tok2', dm as unknown as ReturnType<typeof createDownloadManager>);
    const res = await app.inject({
      method: 'POST', url: '/api/ytdlp/download',
      payload: { url: 'https://www.bilibili.com/list/1', title: '第 3 集', entryIndex: 3, collectionTitle: '某合集', options: { format: 'mp3', entryIndices: [3] } },
    });
    expect(res.statusCode).toBe(201);
    const job = createJobsRepo(db).get(res.json().jobId as number)!;
    const saved = JSON.parse(job.payload) as { entryIndex: number; collectionTitle: string };
    expect(saved.entryIndex).toBe(3);
    expect(saved.collectionTitle).toBe('某合集');
  });
  it('download 同 URL 已有 running job → 409 BUSY(P1-1)', async () => {
    // 预置一个 running 的同 URL job
    const jobsRepo = createJobsRepo(db);
    const jid = jobsRepo.create('ytdlp_download', { url: 'https://a/1', options: { format: 'mp3' } });
    jobsRepo.update(jid, { status: 'running' });
    makeApp('yt-dlp', 'tok2');
    const res = await app.inject({ method: 'POST', url: '/api/ytdlp/download', payload: { url: 'https://a/1', options: { format: 'mp3', force: true } } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('BUSY');
  });
  // D8(2026-09-30 spec):引入队列后 pending 从「毫秒级窗口」变成「分钟级」——同 URL 去重必须把「排队中」也算在途。
  // 让上限 1 的队列把第 1 个卡在 running(dm 从不发终态)、第 2 个停在 pending,再提交同第 2 个 URL → 必须 409 BUSY。
  it('D8:同 URL 去重把「排队中(pending)」也算在途 → 409 BUSY', async () => {
    const dm = { start: vi.fn(), cancel: vi.fn(async () => {}), dispose: vi.fn(async () => {}) }; // 从不发终态:A 永久 running
    makeApp('yt-dlp', 'tok2', dm as unknown as ReturnType<typeof createDownloadManager>);
    // A 占住唯一槽位 → 转 running
    const a = await app.inject({ method: 'POST', url: '/api/ytdlp/download', payload: { url: 'https://a/A', options: { format: 'mp3' } } });
    expect(a.statusCode).toBe(201);
    expect(createJobsRepo(db).get(a.json().jobId as number)!.status).toBe('running');
    // B 不同 URL,队列无空槽 → 停在 pending(排队中)
    const b = await app.inject({ method: 'POST', url: '/api/ytdlp/download', payload: { url: 'https://a/B', options: { format: 'mp3' } } });
    expect(b.statusCode).toBe(201);
    expect(createJobsRepo(db).get(b.json().jobId as number)!.status).toBe('pending');
    // 再提交同 B 的 URL → 即使 B 只是 pending,也必须被挡(否则排队窗口里同一集会被重复入队)
    const dup = await app.inject({ method: 'POST', url: '/api/ytdlp/download', payload: { url: 'https://a/B', options: { format: 'mp3' } } });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe('BUSY');
  });
  it('download 合法 → 201 返回 jobId', async () => {
    // 注:注入假 DownloadManager(只记录 start,不真 spawn)——brief 原用 createDownloadManager(),
    // 会真实拉起本机 yt-dlp 访问 https://a/1 并写 C:/tmp,测试不封闭(本机 yt-dlp 在 PATH、C:/tmp 不存在);
    // 路由契约(201/jobId/running)与 start 接线不依赖真实子进程,故注入假件,偏离已记 plan 注记
    const dm = {
      start: vi.fn(),
      cancel: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    makeApp('yt-dlp', 'tok2', dm as unknown as ReturnType<typeof createDownloadManager>);
    const res = await app.inject({ method: 'POST', url: '/api/ytdlp/download', payload: { url: 'https://a/1', options: { format: 'mp3' }, title: '课' } });
    expect(res.statusCode).toBe(201);
    expect(typeof res.json().jobId).toBe('number');
    // job 已建且 running
    const job = createJobsRepo(db).get(res.json().jobId)!;
    expect(job.status).toBe('running');
    // startDownload 正确接线:jobId/outDir 传给 downloadManager.start(per-job 子目录)
    expect(dm.start).toHaveBeenCalledTimes(1);
    const startOpts = dm.start.mock.calls[0]?.[0] as { jobId: number; outDir: string } | undefined;
    expect(startOpts?.jobId).toBe(res.json().jobId);
    expect(startOpts?.outDir).toBe(join(tempDir, 'job' + res.json().jobId));
  });
});

// Task 6:SSE 实时流(真实 listen + fetch 读流)留作 Task 9 端到端手工验证;单测覆盖 401/404 静态分支 + cancel/retry
describe('GET /api/jobs/:id/events', () => {
  it('events token 错误 → 401', async () => {
    makeApp('yt-dlp', 'tok2');
    const res = await app.inject({ method: 'GET', url: '/api/jobs/1/events?token=bad' });
    expect(res.statusCode).toBe(401);
  });
  // D3 更新(2026-09-29):localhost 来源豁免 query token——浏览器直连 dev(无 apiToken)SSE 可连
  it('events localhost origin + 无 token → 守卫放行(不存在 job → 404,证明未 401)', async () => {
    makeApp('yt-dlp', 'tok2');
    const res = await app.inject({ method: 'GET', url: '/api/jobs/999/events', headers: { origin: 'http://localhost:8000' } });
    expect(res.statusCode).toBe(404);
  });
  it('events localhost origin + token 错误 → 守卫放行(404)', async () => {
    makeApp('yt-dlp', 'tok2');
    const res = await app.inject({ method: 'GET', url: '/api/jobs/999/events?token=bad', headers: { origin: 'http://127.0.0.1:8000' } });
    expect(res.statusCode).toBe(404);
  });
  it('events 非 localhost origin + 无 token → 401', async () => {
    makeApp('yt-dlp', 'tok2');
    const res = await app.inject({ method: 'GET', url: '/api/jobs/1/events', headers: { origin: 'http://evil.example' } });
    expect(res.statusCode).toBe(401);
  });
  it('events job 不存在 → 404', async () => {
    makeApp('yt-dlp', 'tok2');
    const res = await app.inject({ method: 'GET', url: '/api/jobs/999/events?token=tok2' });
    expect(res.statusCode).toBe(404);
  });
  it('events id 非正整数 → 404(M3)', async () => {
    makeApp('yt-dlp', 'tok2');
    const res = await app.inject({ method: 'GET', url: '/api/jobs/abc/events?token=tok2' });
    expect(res.statusCode).toBe(404);
  });
  // Critical 修复:progress 事件必须推送到 SSE 连接(此前只写 jobsRepo 不 emit,前端进度条恒 0%)
  // app.inject 会缓冲整个响应,SSE 永不断开无法用 inject 测 → 真实 listen + fetch 读流
  it('SSE 连接收到 progress 事件(emit 接线)', async () => {
    let fireProgress: (() => void) | undefined;
    let fireEnd: (() => void) | undefined;
    const dm = {
      start: vi.fn((opts: { jobId: number; onEvent: (jid: number, ev: unknown) => void }) => {
        // 捕获 onEvent,等 SSE 连接建立后再触发,模拟下载中途的进度行
        fireProgress = () => opts.onEvent(opts.jobId, { type: 'progress', percent: 42, downloadedBytes: 1024, totalBytes: 2048 });
        // 断言读完后触发终态,让服务端主动 end 连接——否则 app.close() 会等这条 SSE 连接悬挂
        fireEnd = () => opts.onEvent(opts.jobId, { type: 'status', state: 'cancelled', message: '测试收尾' });
      }),
      cancel: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    makeApp('yt-dlp', 'tok2', dm as unknown as ReturnType<typeof createDownloadManager>);
    const res = await app.inject({ method: 'POST', url: '/api/ytdlp/download', payload: { url: 'https://a/1', options: { format: 'mp3' } } });
    expect(res.statusCode).toBe(201);
    const jobId = res.json().jobId as number;
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as AddressInfo).port;
    const ac = new AbortController();
    const sse = await fetch(`http://127.0.0.1:${port}/api/jobs/${jobId}/events?token=tok2`, { signal: ac.signal });
    const reader = sse.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    try {
      // SSE 路由 handler 同步写完 writeHead/注册连接后 fetch 才 resolve,此时触发进度事件必达连接
      fireProgress!();
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline && !buf.includes('event: progress')) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
      }
      fireEnd!(); // 服务端 end 连接(终态事件),app.close() 不再悬挂
    } finally {
      await reader.cancel().catch(() => {});
      ac.abort();
    }
    expect(buf).toContain('event: progress');
    expect(buf).toContain('"percent":42');
  });
  // 2026-09-29 用户拍板(进度条分两段:① 下载 ② 入库):下载进程结束、开始入库前必须推一个阶段信号,
  // 前端才能把进度条从下载段切到入库段。否则进度条停在 100% 而剪辑室还是空,用户以为下好了就切走(真实踩坑)。
  it('SSE 连接收到 phase=ingest 事件,且早于 done(下载完成 → 入库 → 入库完成)', async () => {
    let fireDone: (() => void) | undefined;
    const producedPath = join(tempDir, 'produced.mp3');
    writeFileSync(producedPath, 'fake-audio'); // finalize 会 statSync + rename,必须是真文件
    const dm = {
      start: vi.fn((opts: { jobId: number; onEvent: (jid: number, ev: unknown) => void }) => {
        // 模拟下载进程退出:带 producedPath 的 status done → 路由应先 emit phase,再走真入库(rename + INSERT)
        fireDone = () => opts.onEvent(opts.jobId, { type: 'status', state: 'done', producedPath });
      }),
      cancel: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    makeApp('yt-dlp', 'tok2', dm as unknown as ReturnType<typeof createDownloadManager>);
    const res = await app.inject({ method: 'POST', url: '/api/ytdlp/download', payload: { url: 'https://a/1', options: { format: 'mp3' }, title: '课' } });
    const jobId = res.json().jobId as number;
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as AddressInfo).port;
    const ac = new AbortController();
    const sse = await fetch(`http://127.0.0.1:${port}/api/jobs/${jobId}/events?token=tok2`, { signal: ac.signal });
    const reader = sse.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    try {
      fireDone!();
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline && !buf.includes('event: done')) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
      }
    } finally {
      await reader.cancel().catch(() => {});
      ac.abort();
    }
    expect(buf).toContain('event: phase');
    expect(buf).toContain('"phase":"ingest"');
    expect(buf).toContain('event: done'); // 入库完成后照旧发终态
    expect(buf.indexOf('event: phase')).toBeLessThan(buf.indexOf('event: done')); // 顺序:先入库信号,后完成
  });
});

describe('POST /api/jobs/:id/cancel', () => {
  it('cancel 不存在 job → 404', async () => {
    makeApp('yt-dlp', 'tok2');
    const res = await app.inject({ method: 'POST', url: '/api/jobs/999/cancel' });
    expect(res.statusCode).toBe(404);
  });
  it('cancel id 非正整数 → 404(M3)', async () => {
    makeApp('yt-dlp', 'tok2');
    const res = await app.inject({ method: 'POST', url: '/api/jobs/abc/cancel' });
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /api/jobs/:id/retry', () => {
  it('retry id 非正整数 → 404(M3)', async () => {
    makeApp('yt-dlp', 'tok2');
    const res = await app.inject({ method: 'POST', url: '/api/jobs/abc/retry' });
    expect(res.statusCode).toBe(404);
  });
  it('retry 非 error job → 409 NOT_RETRYABLE(P1-4)', async () => {
    const jobsRepo = createJobsRepo(db);
    const jid = jobsRepo.create('ytdlp_download', { url: 'https://a/1', options: { format: 'mp3' } });
    jobsRepo.update(jid, { status: 'running' });
    makeApp('yt-dlp', 'tok2');
    const res = await app.inject({ method: 'POST', url: `/api/jobs/${jid}/retry` });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('NOT_RETRYABLE');
  });
  it('retry error job 但同 URL 有 running → 409 BUSY(P1-4)', async () => {
    const jobsRepo = createJobsRepo(db);
    const errJid = jobsRepo.create('ytdlp_download', { url: 'https://a/1', options: { format: 'mp3' } });
    jobsRepo.fail(errJid, '网络失败');
    const runJid = jobsRepo.create('ytdlp_download', { url: 'https://a/1', options: { format: 'mp3' } });
    jobsRepo.update(runJid, { status: 'running' });
    makeApp('yt-dlp', 'tok2');
    const res = await app.inject({ method: 'POST', url: `/api/jobs/${errJid}/retry` });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('BUSY');
  });
  it('retry error job 且无并发 → 201 新 jobId', async () => {
    const jobsRepo = createJobsRepo(db);
    const errJid = jobsRepo.create('ytdlp_download', { url: 'https://a/1', options: { format: 'mp3' } });
    jobsRepo.fail(errJid, '网络失败');
    // 注:偏离 brief 的 createDownloadManager()——同 Task 5,真 dm 会真实拉起本机 yt-dlp
    // 访问 https://a/1 并写 C:/tmp,测试不封闭;路由契约(201/新 jobId)不依赖真实子进程,故注入假件
    const dm = {
      start: vi.fn(),
      cancel: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    makeApp('yt-dlp', 'tok2', dm as unknown as ReturnType<typeof createDownloadManager>);
    const res = await app.inject({ method: 'POST', url: `/api/jobs/${errJid}/retry` });
    expect(res.statusCode).toBe(201);
    expect(typeof res.json().jobId).toBe('number');
    expect(res.json().jobId).not.toBe(errJid);
  });
});

// Task 7:audio 列表与文件流路由——文件流用真实临时文件(注入 mkdtemp 写真实 mp3),
// 断言 token 401/不存在 404/非正整数 id 404(P2-5)/200 + Content-Type + body
describe('GET /api/audio 与 GET /api/audio/:id/file', () => {
  it('audio 文件 token 错 → 401;不存在 → 404;非正整数 id → 404;存在 → 200 + Content-Type', async () => {
    const audioRepo = createAudioItemsRepo(db);
    const audioDir = mkdtempSync(join(tmpdir(), 'sct-audio-'));
    const id = audioRepo.create({ title: 't', source_type: 'download', source_url: 'u', file_path: join(audioDir, 't.mp3'), format: 'mp3', duration_sec: null, file_size: 3 });
    writeFileSync(join(audioDir, 't.mp3'), 'abc');
    makeApp('yt-dlp', 'tok2');
    expect((await app.inject({ method: 'GET', url: `/api/audio/${id}/file?token=bad` })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/audio/999/file?token=tok2' })).statusCode).toBe(404);
    // P2-5:非正整数 id → 404
    expect((await app.inject({ method: 'GET', url: '/api/audio/abc/file?token=tok2' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/audio/0/file?token=tok2' })).statusCode).toBe(404);
    const ok = await app.inject({ method: 'GET', url: `/api/audio/${id}/file?token=tok2` });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['content-type']).toBe('audio/mpeg');
    expect(ok.body).toBe('abc');
  });
  // D3 更新(2026-09-29):localhost 来源豁免 query token——<audio> 标签无法设 header,浏览器直连 dev 需免 token
  it('audio 文件 localhost origin + 无 token → 守卫放行(不存在 id → 404,证明未 401)', async () => {
    makeApp('yt-dlp', 'tok2');
    const res = await app.inject({ method: 'GET', url: '/api/audio/999/file', headers: { origin: 'http://localhost:8000' } });
    expect(res.statusCode).toBe(404);
  });
  it('audio 文件非 localhost origin + 无 token → 401', async () => {
    makeApp('yt-dlp', 'tok2');
    const res = await app.inject({ method: 'GET', url: '/api/audio/999/file', headers: { origin: 'http://evil.example' } });
    expect(res.statusCode).toBe(401);
  });
  it('audio 列表返回全部', async () => {
    createAudioItemsRepo(db).create({ title: 'a', source_type: 'download', source_url: 'u', file_path: 'C:/x/a.mp3', format: 'mp3', duration_sec: null, file_size: 1 });
    makeApp('yt-dlp', 'tok2');
    const res = await app.inject({ method: 'GET', url: '/api/audio' });
    expect(res.json()).toHaveLength(1);
    expect(res.json()[0].title).toBe('a');
  });
  // 2026-09-29 用户拍板:剪辑室要显示平台 logo / 第几集 / 所属合集 → 列表附带 site + 剧集两列
  it('audio 列表带 site(由 source_url 反查平台)与剧集字段', async () => {
    const audioRepo = createAudioItemsRepo(db);
    audioRepo.create({ title: '第 3 集', source_type: 'download', source_url: 'https://www.bilibili.com/list/1', file_path: 'C:/x/3.mp3', format: 'mp3', duration_sec: null, file_size: 1, entry_index: 3, collection_title: '某合集', source_import_id: 42 });
    makeApp('yt-dlp', 'tok2');
    const row = (await app.inject({ method: 'GET', url: '/api/audio' })).json()[0] as { site: string; entry_index: number; collection_title: string; source_import_id: number | null };
    expect(row.site).toBe('bilibili');
    expect(row.entry_index).toBe(3);
    expect(row.collection_title).toBe('某合集');
    // 2026-10-01 spec audio-lineage D3/验收 6:列表回读必须带 source_import_id —— 此前只靠路由里 `...row` 展开这个
    // 实现细节保证,将来重构路由可能静默丢字段,故在此对它下契约断言(有值原样带回)。
    expect(row.source_import_id).toBe(42);
  });
  // 2026-10-01 spec audio-lineage 验收 6 的另一半:没写血源的条目,列表回读该字段必须是 null(不是缺失/undefined)
  it('audio 列表:未写血源的条目 source_import_id 为 null', async () => {
    createAudioItemsRepo(db).create({ title: '无血缘', source_type: 'recording', source_url: null, file_path: 'C:/x/rec.wav', format: 'wav', duration_sec: null, file_size: 1 });
    makeApp('yt-dlp', 'tok2');
    const row = (await app.inject({ method: 'GET', url: '/api/audio' })).json()[0] as { source_import_id: number | null };
    expect(row.source_import_id).toBeNull();
  });
  // 2026-09-29 补:<audio> 由浏览器自己发,既没有 Origin 也加不了 header → 额外认「Referer 是本机页面」。
  // 实测日志里 /api/audio/:id/file 大量 401 就是这个坑(本地开发裸开浏览器时播放器拿不到文件)。
  it('audio 文件:无 token + 非本机 origin,但 Referer 是本机页面 → 200', async () => {
    const audioRepo = createAudioItemsRepo(db);
    const audioDir = mkdtempSync(join(tmpdir(), 'sct-audio-'));
    const id = audioRepo.create({ title: 't', source_type: 'download', source_url: 'u', file_path: join(audioDir, 't.mp3'), format: 'mp3', duration_sec: null, file_size: 3 });
    writeFileSync(join(audioDir, 't.mp3'), 'abc');
    makeApp('yt-dlp', 'tok2');
    expect((await app.inject({ method: 'GET', url: `/api/audio/${id}/file`, headers: { referer: 'http://localhost:8000/' } })).statusCode).toBe(200);
    // 外站 Referer 依旧拦(恶意页面无法把 Referer 伪造成 localhost)
    expect((await app.inject({ method: 'GET', url: `/api/audio/${id}/file`, headers: { referer: 'https://evil.example/x' } })).statusCode).toBe(401);
  });
  // 2026-09-29 用户拍板(补齐老记录):改动前入库的音频只记了标题+来源网址,合集名/集数两列是空的 →
  // 拿 source_url 反查 imported_sources 把番剧名补回来(集数只在分集清单唯一命中同名条目时才判定)
  it('老音频(未记合集/集数)→ 按 source_url 反查导入来源,补出番剧名与集数', async () => {
    const srcUrl = 'https://www.bilibili.com/bangumi/play/ss28747';
    createImportsRepo(db).upsertByUrl({
      url: srcUrl, title: '凡人修仙传', site: 'bilibili', kind: 'playlist', duration_sec: null,
      entries: [{ index: 93, title: '条目 93' }, { index: 94, title: '条目 94' }],
    });
    createAudioItemsRepo(db).create({ title: '条目 94', source_type: 'download', source_url: srcUrl, file_path: 'C:/x/94.mp3', format: 'mp3', duration_sec: null, file_size: 1 });
    makeApp('yt-dlp', 'tok2');
    const row = (await app.inject({ method: 'GET', url: '/api/audio' })).json()[0] as { collection_title: string; entry_index: number; site: string };
    expect(row.collection_title).toBe('凡人修仙传');
    expect(row.entry_index).toBe(94);
    expect(row.site).toBe('bilibili');
  });
  it('分集清单里有多条同名条目 → 补合集名但不猜集数(宁缺勿错)', async () => {
    const srcUrl = 'https://www.bilibili.com/bangumi/play/ss9';
    createImportsRepo(db).upsertByUrl({
      url: srcUrl, title: '某合集', site: 'bilibili', kind: 'playlist', duration_sec: null,
      entries: [{ index: 1, title: '同名' }, { index: 2, title: '同名' }],
    });
    createAudioItemsRepo(db).create({ title: '同名', source_type: 'download', source_url: srcUrl, file_path: 'C:/x/dup.mp3', format: 'mp3', duration_sec: null, file_size: 1 });
    makeApp('yt-dlp', 'tok2');
    const row = (await app.inject({ method: 'GET', url: '/api/audio' })).json()[0] as { collection_title: string; entry_index: number | null };
    expect(row.collection_title).toBe('某合集');
    expect(row.entry_index).toBeNull();
  });
  it('单视频来源(kind=single)不补集数;下载时已记的值不被覆盖', async () => {
    const singleUrl = 'https://www.youtube.com/watch?v=1';
    createImportsRepo(db).upsertByUrl({ url: singleUrl, title: '某单曲', site: 'youtube', kind: 'single', duration_sec: null, entries: null });
    const audioRepo = createAudioItemsRepo(db);
    audioRepo.create({ title: '某单曲', source_type: 'download', source_url: singleUrl, file_path: 'C:/x/s.mp3', format: 'mp3', duration_sec: null, file_size: 1 });
    audioRepo.create({ title: '条目 5', source_type: 'download', source_url: 'https://www.bilibili.com/list/9', file_path: 'C:/x/5.mp3', format: 'mp3', duration_sec: null, file_size: 1, entry_index: 5, collection_title: '入库时记的合集' });
    makeApp('yt-dlp', 'tok2');
    const rows = (await app.inject({ method: 'GET', url: '/api/audio' })).json() as Array<{ title: string; collection_title: string | null; entry_index: number | null }>;
    const single = rows.find((r) => r.title === '某单曲')!;
    expect(single.collection_title).toBeNull();
    expect(single.entry_index).toBeNull();
    const recorded = rows.find((r) => r.title === '条目 5')!;
    expect(recorded.collection_title).toBe('入库时记的合集');
    expect(recorded.entry_index).toBe(5);
  });
  // 2026-10-01 spec clip-works D17:?project=<作品id> 只回该作品的成品;不传 = 维持现状(全部);
  // 不存在的 id = 空数组(过滤语义,不是资源寻址,不 404 —— §0.4 契约)
  it('GET /api/audio?project=<作品id>:只回该作品成品;不传=全部;不存在的 id=空数组', async () => {
    const audioRepo = createAudioItemsRepo(db);
    const clipRepo = createClipProjectsRepo(db);
    const w1 = clipRepo.create(1, '作品甲').id;
    const w2 = clipRepo.create(1, '作品乙').id;
    audioRepo.create({ title: '成品A', source_type: 'edit', source_url: '', file_path: 'C:/x/a.mp3', format: 'mp3', duration_sec: 1, file_size: 1, source_work_id: w1 });
    audioRepo.create({ title: '成品B', source_type: 'edit', source_url: '', file_path: 'C:/x/b.mp3', format: 'mp3', duration_sec: 1, file_size: 1, source_work_id: w2 });
    audioRepo.create({ title: '无作品', source_type: 'edit', source_url: '', file_path: 'C:/x/c.mp3', format: 'mp3', duration_sec: 1, file_size: 1 });
    makeApp('yt-dlp', 'tok2');
    // 不传 → 维持现状:全部(3 条,含无作品的那条)
    expect(((await app.inject({ method: 'GET', url: '/api/audio' })).json() as unknown[]).length).toBe(3);
    // 传作品 id → 只回该作品成品
    const onlyW1 = (await app.inject({ method: 'GET', url: `/api/audio?project=${w1}` })).json() as Array<{ title: string }>;
    expect(onlyW1.map((r) => r.title)).toEqual(['成品A']);
    // 不存在 / 非法 id → 回全部、不报错(过滤语义,不是资源寻址)
    expect((await app.inject({ method: 'GET', url: '/api/audio?project=99999' })).json()).toEqual([]); // 合法正整数但不存在 → 空数组
    expect(((await app.inject({ method: 'GET', url: '/api/audio?project=abc' })).json() as unknown[]).length).toBe(3); // 乱传 → 全部
  });
});

// CORS 修复(2026-09-29 用户反馈):SSE 路由 hijack reply 后,Fastify 的 onSend 钩子不会运行,
// cors.ts 依赖 onSend 下发的 access-control-allow-origin 因此缺失 → 浏览器拦截跨源 EventSource,进度事件全丢。
// 修复后 hijack 的 writeHead 必须自带同款 CORS 头;用终态 job 让路由走 hijack 分支并立即 end(inject 可返回)。
describe('GET /api/jobs/:id/events SSE CORS 头(hijack 路径)', () => {
  it('白名单 origin → 反射 access-control-allow-origin + vary: Origin,终态补发不受影响', async () => {
    const jobsRepo = createJobsRepo(db);
    const jid = jobsRepo.create('ytdlp_download', { url: 'https://a/1', options: { format: 'mp3' } });
    jobsRepo.finish(jid); // done:路由走 hijack + 终态补发 + end
    makeApp('yt-dlp', 'tok2');
    const res = await app.inject({
      method: 'GET', url: `/api/jobs/${jid}/events?token=tok2`,
      headers: { origin: 'http://localhost:8000' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:8000');
    expect(res.headers['vary']).toBe('Origin');
    expect(res.body).toContain('event: status'); // 终态补发仍在(CORS 头不改变 SSE 行为)
  });
  it('file:// origin(null) → 反射 access-control-allow-origin: null(isAllowedOrigin 放行 file://)', async () => {
    const jobsRepo = createJobsRepo(db);
    const jid = jobsRepo.create('ytdlp_download', { url: 'https://a/1', options: { format: 'mp3' } });
    jobsRepo.finish(jid);
    makeApp('yt-dlp', 'tok2');
    const res = await app.inject({
      method: 'GET', url: `/api/jobs/${jid}/events?token=tok2`,
      headers: { origin: 'null' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('null');
  });
  it('非白名单 origin → 不下发 access-control-allow-origin(vary: Origin 仍在)', async () => {
    const jobsRepo = createJobsRepo(db);
    const jid = jobsRepo.create('ytdlp_download', { url: 'https://a/1', options: { format: 'mp3' } });
    jobsRepo.finish(jid);
    makeApp('yt-dlp', 'tok2');
    const res = await app.inject({
      method: 'GET', url: `/api/jobs/${jid}/events?token=tok2`,
      headers: { origin: 'http://evil.example' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers['vary']).toBe('Origin');
  });
});

// 诊断日志(2026-09-29 用户反馈):GET /api/logs 返回环形缓冲;/api/* 请求留痕(http 行)+ job 生命周期留痕
describe('GET /api/logs', () => {
  it('返回 ok:true + logs 数组;400 parse 请求留下一行 http 日志(路径剥离 query,不泄 token)', async () => {
    makeApp('yt-dlp');
    registerRequestLogging(app); // 与 index.ts createServer 同款请求日志钩子
    await app.inject({ method: 'POST', url: '/api/ytdlp/parse', payload: {} }); // 400
    const res = await app.inject({ method: 'GET', url: '/api/logs?token=tok2' });
    expect(res.statusCode).toBe(200);
    const j = res.json() as { ok: boolean; logs: { level: string; source: string; message: string }[] };
    expect(j.ok).toBe(true);
    expect(Array.isArray(j.logs)).toBe(true);
    const httpLine = j.logs.find((l) => l.source === 'http' && l.message.includes('POST /api/ytdlp/parse'));
    expect(httpLine).toBeDefined();
    expect(httpLine?.message).toContain('400');
    expect(httpLine?.level).toBe('info'); // 4xx 不算 server 错误(≥500 才 error)
  });
  it('download 成功 → job created/spawn 两行 job 日志可在 /api/logs 查到', async () => {
    const dm = { start: vi.fn(), cancel: vi.fn(async () => {}), dispose: vi.fn(async () => {}) };
    makeApp('yt-dlp', 'tok2', dm as unknown as ReturnType<typeof createDownloadManager>);
    const res = await app.inject({ method: 'POST', url: '/api/ytdlp/download', payload: { url: 'https://a/9', options: { format: 'mp3' }, title: '课' } });
    expect(res.statusCode).toBe(201);
    const jobId = res.json().jobId as number;
    const logsRes = await app.inject({ method: 'GET', url: '/api/logs' });
    const logs = (logsRes.json() as { logs: { source: string; message: string }[] }).logs;
    expect(logs.some((l) => l.source === 'job' && l.message === `job ${jobId} created url=https://a/9 format=mp3`)).toBe(true);
    expect(logs.some((l) => l.source === 'job' && l.message.includes(`job ${jobId} spawn yt-dlp bin=`))).toBe(true);
  });
  // 2026-09-29 加 debug 级别:前端 logFe('debug', ...) 要把级别原样带上,否则被降级成 info,
  // 前端「显示调试日志」过滤就永远筛不出东西(这正是当初级别漂移踩到的坑)
  it('POST /api/logs 透传 level=debug(不降级成 info)', async () => {
    makeApp('yt-dlp');
    const post = await app.inject({ method: 'POST', url: '/api/logs', payload: { level: 'debug', message: '前端调试行' } });
    expect(post.statusCode).toBe(200);
    const logs = ((await app.inject({ method: 'GET', url: '/api/logs' })).json() as { logs: { level: string; source: string; message: string }[] }).logs;
    const line = logs.find((l) => l.message === '前端调试行');
    expect(line?.level).toBe('debug');
    expect(line?.source).toBe('web');
  });
});

// B 站 Cookie(2026-09-29 用户拍板):/api/cookie 元数据读写 + parse/download 的 --cookies 注入
describe('GET/PUT /api/cookie', () => {
  it('GET 未设置 → ok:true set:false length:0', async () => {
    makeApp('yt-dlp');
    const res = await app.inject({ method: 'GET', url: '/api/cookie' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, set: false, length: 0, count: 0, sessdataExpiry: null, expired: null });
  });
  it('PUT content 缺失/空白/非字符串 → 400', async () => {
    makeApp('yt-dlp');
    for (const payload of [{}, { content: '' }, { content: '   ' }, { content: 123 }]) {
      const res = await app.inject({ method: 'PUT', url: '/api/cookie', payload });
      expect(res.statusCode).toBe(400);
    }
  });
  it('PUT 成功 → ok:true;GET set:true length 一致;凭据不出 /api/settings 白名单', async () => {
    makeApp('yt-dlp');
    const content = '# Netscape HTTP Cookie File\n.bilibili.com\tTRUE\t/\tTRUE\t1790000000\tSESSDATA\tx';
    const put = await app.inject({ method: 'PUT', url: '/api/cookie', payload: { content } });
    expect(put.statusCode).toBe(200);
    expect(put.json().ok).toBe(true);
    const j = (await app.inject({ method: 'GET', url: '/api/cookie' })).json() as { set: boolean; length: number };
    expect(j.set).toBe(true);
    expect(j.length).toBe(content.length);
    // 凭据不出白名单:GET /api/settings 只回 SETTINGS_KEYS 内的键,绝无 bili_cookie
    const settings = (await app.inject({ method: 'GET', url: '/api/settings' })).json() as Record<string, string>;
    expect(Object.keys(settings)).not.toContain('bili_cookie');
    // 通用 settings PUT 对白名单外键拒绝(凭据无法经该通道写入)
    expect((await app.inject({ method: 'PUT', url: '/api/settings', payload: { bili_cookie: 'x' } })).statusCode).toBe(400);
    // 键常量本身也不在白名单数组里(双保险)
    expect(Object.values(SETTINGS_KEYS)).not.toContain(BILI_COOKIE_KEY);
  });
  it('PUT 游客 Cookie(无 SESSDATA)→ 400 NO_LOGIN_COOKIE', async () => {
    makeApp('yt-dlp');
    const res = await app.inject({ method: 'PUT', url: '/api/cookie', payload: { content: 'foo=bar; baz=qux' } });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('NO_LOGIN_COOKIE');
  });
  it('已有未过期登录信息 → PUT 409 CONFLICT;force=true 放行(用户拍板:提示已有登录信息而不是默默覆盖)', async () => {
    makeApp('yt-dlp');
    // 1804299628 = 2027-02 未来时间,保证「未过期」判定成立;值必须带 %2C 分段(SESSDATA 值格式)才能解析出过期时间
    const content = '# Netscape HTTP Cookie File\n.bilibili.com\tTRUE\t/\tTRUE\t1804299628\tSESSDATA\ta%2C1804299628%2Cb';
    const first = await app.inject({ method: 'PUT', url: '/api/cookie', payload: { content } });
    expect(first.statusCode).toBe(200);
    const dup = await app.inject({ method: 'PUT', url: '/api/cookie', payload: { content } });
    expect(dup.statusCode).toBe(409);
    expect((dup.json() as { error: { code: string } }).error.code).toBe('CONFLICT');
    const force = await app.inject({ method: 'PUT', url: '/api/cookie', payload: { content, force: true } });
    expect(force.statusCode).toBe(200);
  });
});

describe('Cookie 注入(parse/download)', () => {
  // 2026-09-29:物化文件名带唯一后缀(yt-dlp 会把 cookie jar 回写进 --cookies 指的文件,固定名字会被并发调用互相覆盖)
  it('已存 Cookie → parse 物化 cookies-<唯一后缀>.txt 于 dirname(audioDir)', async () => {
    makeApp('yt-dlp');
    await app.inject({ method: 'PUT', url: '/api/cookie', payload: { content: '.bilibili.com\tTRUE\t/\tTRUE\t1790000000\tSESSDATA\tx' } });
    const res = await app.inject({ method: 'POST', url: '/api/ytdlp/parse', payload: { url: 'https://www.bilibili.com/x' } });
    expect(res.statusCode).toBe(200);
    // audioDir=join(tempDir,'audio') → dirname=tempDir
    expect(readdirSync(tempDir).some((f) => f.startsWith('cookies-') && f.endsWith('.txt'))).toBe(true);
  });
  it('settings 存的是空白 Cookie → 不物化、parse 照常成功', async () => {
    makeApp('yt-dlp');
    createSettingsRepo(db).set(BILI_COOKIE_KEY, '   ');
    const res = await app.inject({ method: 'POST', url: '/api/ytdlp/parse', payload: { url: 'https://a' } });
    expect(res.statusCode).toBe(200);
    expect(readdirSync(tempDir).filter((f) => f.startsWith('cookies-'))).toHaveLength(0);
  });
  it('download 已存 Cookie → spawn args 含 --cookies + 物化出来的文件路径', async () => {
    const dm = { start: vi.fn(), cancel: vi.fn(async () => {}), dispose: vi.fn(async () => {}) };
    makeApp('yt-dlp', 'tok2', dm as unknown as ReturnType<typeof createDownloadManager>);
    await app.inject({ method: 'PUT', url: '/api/cookie', payload: { content: '.bilibili.com\tTRUE\t/\tTRUE\t1790000000\tSESSDATA\tx' } });
    const res = await app.inject({ method: 'POST', url: '/api/ytdlp/download', payload: { url: 'https://www.bilibili.com/x', options: { format: 'mp3' } } });
    expect(res.statusCode).toBe(201);
    const startOpts = dm.start.mock.calls[0]?.[0] as { args: string[] };
    const cookieArg = startOpts.args[startOpts.args.indexOf('--cookies') + 1];
    expect(cookieArg?.startsWith(tempDir)).toBe(true);
    expect(cookieArg?.includes('cookies-')).toBe(true);
  });
  it('download 未存 Cookie → args 不含 --cookies(原形态不变)', async () => {
    const dm = { start: vi.fn(), cancel: vi.fn(async () => {}), dispose: vi.fn(async () => {}) };
    makeApp('yt-dlp', 'tok2', dm as unknown as ReturnType<typeof createDownloadManager>);
    const res = await app.inject({ method: 'POST', url: '/api/ytdlp/download', payload: { url: 'https://a/1', options: { format: 'mp3' } } });
    expect(res.statusCode).toBe(201);
    const startOpts = dm.start.mock.calls[0]?.[0] as { args: string[] };
    expect(startOpts.args).not.toContain('--cookies');
  });
});

// 作品封面(2026-09-29 用户拍板:剪辑室分组视图显示作品封面)
// 抓取时机两处:解析成功后**后台**预热一次(不 await,不拖慢解析);看分组视图时本地还没有就兜底现抓(自愈)
describe('作品封面:解析预热 / has_cover / cover 路由', () => {
  const parseUrl = 'https://www.bilibili.com/bangumi/play/ss1';
  const upsertImport = (url: string, thumbnail: string | null): number =>
    createImportsRepo(db).upsertByUrl({ url, title: '凡人修仙传', site: 'bilibili', kind: 'playlist', duration_sec: null, entries: null, thumbnail });

  it('解析成功 → 存下封面地址,并后台触发一次抓图(解析响应不受影响)', async () => {
    const calls: Array<{ url: string; importId: number }> = [];
    makeApp('yt-dlp', 'tok2', undefined, async (o) => { calls.push({ url: o.url, importId: o.importId }); return true; });
    const res = await app.inject({ method: 'POST', url: '/api/ytdlp/parse', payload: { url: parseUrl } });
    expect(res.statusCode).toBe(200);
    expect(res.json().thumbnail).toBe('https://t/1.jpg'); // 解析出参照旧带封面地址
    await new Promise((r) => setTimeout(r, 20)); // 后台任务是 fire-and-forget,给它一拍
    expect(calls).toEqual([{ url: 'https://t/1.jpg', importId: 1 }]);
    expect(createImportsRepo(db).getByUrl(parseUrl)!.thumbnail).toBe('https://t/1.jpg');
  });

  it('重复解析但这次没带封面地址 → 保留上一次存的那个(不把已有封面地址抹掉)', () => {
    const repo = createImportsRepo(db);
    const id = upsertImport('https://a/pl', 'https://t/1.jpg');
    repo.upsertByUrl({ url: 'https://a/pl', title: '换了个标题', site: 'bilibili', kind: 'playlist', duration_sec: null, entries: null, thumbnail: null });
    expect(repo.get(id)!.thumbnail).toBe('https://t/1.jpg');
    expect(repo.get(id)!.title).toBe('换了个标题'); // 其它字段照常更新
  });

  it('/api/imports 出参带 has_cover:图没落盘 false,落盘后 true', async () => {
    const id = upsertImport('https://a/pl', 'https://t/1.jpg');
    makeApp('yt-dlp', 'tok2');
    const before = (await app.inject({ method: 'GET', url: '/api/imports' })).json() as { imports: Array<{ has_cover: boolean }> };
    expect(before.imports[0]!.has_cover).toBe(false);
    // 封面目录 = dirname(audioDir)/covers = tempDir/covers
    mkdirSync(join(tempDir, 'covers'), { recursive: true });
    writeFileSync(join(tempDir, 'covers', `cover-${id}.jpg`), 'IMG');
    const after = (await app.inject({ method: 'GET', url: '/api/imports' })).json() as { imports: Array<{ has_cover: boolean }> };
    expect(after.imports[0]!.has_cover).toBe(true);
  });

  it('cover 路由:本地有图 → 200 + 正确 Content-Type;没图且库里也没地址 → 404;来源不存在 → 404', async () => {
    const withCover = upsertImport('https://a/pl', 'https://t/1.jpg');
    const noCover = upsertImport('https://b/single', null);
    makeApp('yt-dlp', 'tok2');
    mkdirSync(join(tempDir, 'covers'), { recursive: true });
    writeFileSync(join(tempDir, 'covers', `cover-${withCover}.png`), 'PNGDATA');
    const ok = await app.inject({ method: 'GET', url: `/api/imports/${withCover}/cover?token=tok2` });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['content-type']).toBe('image/png');
    expect(ok.body).toBe('PNGDATA');
    expect((await app.inject({ method: 'GET', url: `/api/imports/${noCover}/cover?token=tok2` })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/imports/999/cover?token=tok2' })).statusCode).toBe(404);
  });

  it('cover 路由兜底自愈:本地没图但库里存了地址 → 现场抓一次再回图', async () => {
    const id = upsertImport('https://a/pl', 'https://t/1.jpg');
    const calls: string[] = [];
    makeApp('yt-dlp', 'tok2', undefined, async (o) => {
      calls.push(o.url);
      mkdirSync(o.coversDir, { recursive: true });
      writeFileSync(join(o.coversDir, `cover-${o.importId}.jpg`), 'HEALED');
      return true;
    });
    const res = await app.inject({ method: 'GET', url: `/api/imports/${id}/cover?token=tok2` });
    expect(calls).toEqual(['https://t/1.jpg']);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('HEALED');
  });

  // 2026-09-29 评审补:预热那发是 fire-and-forget(可能正卡在 10s 的 fetch),用户此时打开卡片墙会对
  // 同一个来源再来一次——不去重就会起两个 yt-dlp 写同一个输出路径,还可能把写了一半的图流回浏览器
  it('同一来源并发请求封面 → 只抓一次,两个请求拿到同一结果', async () => {
    const id = upsertImport('https://a/pl', 'https://t/1.jpg');
    let calls = 0;
    makeApp('yt-dlp', 'tok2', undefined, async (o) => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 30)); // 慢抓取:制造"第二个请求在抓取期间进来"的窗口
      mkdirSync(o.coversDir, { recursive: true });
      writeFileSync(join(o.coversDir, `cover-${o.importId}.jpg`), 'ONCE');
      return true;
    });
    const [a, b] = await Promise.all([
      app.inject({ method: 'GET', url: `/api/imports/${id}/cover?token=tok2` }),
      app.inject({ method: 'GET', url: `/api/imports/${id}/cover?token=tok2` }),
    ]);
    expect(calls).toBe(1);
    expect(a.body).toBe('ONCE');
    expect(b.body).toBe('ONCE');
  });

  // 2026-09-29 实测补的关键一条:自己 fetch 抓不到(外网图床——Node fetch 不读 Windows 系统代理,直连 i.ytimg.com
  // 10s 超时)或压根没地址(B 站番剧的 flat 解析不给封面字段)→ 兜底让 yt-dlp 自己写图。
  // 用户真实场景:YouTube 视频下载完了却一直没封面,就是这条兜底在修。
  it('自己抓不到封面 → 兜底让 yt-dlp 写图,写出即返回', async () => {
    const id = upsertImport('https://www.youtube.com/watch?v=x', 'https://i.ytimg.com/vi/x/maxresdefault.webp');
    const written: string[] = [];
    makeApp('yt-dlp', 'tok2', undefined, async () => false, async (o) => {
      written.push(o.url);
      mkdirSync(o.coversDir, { recursive: true });
      writeFileSync(join(o.coversDir, `cover-${o.importId}.webp`), 'BYTESBYDLP');
      return true;
    });
    const res = await app.inject({ method: 'GET', url: `/api/imports/${id}/cover?token=tok2` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/webp');
    expect(res.body).toBe('BYTESBYDLP');
    expect(written).toEqual(['https://www.youtube.com/watch?v=x']);
  });

  it('连 yt-dlp 也没写出来 → 404(前端回退纯色卡片),不抛', async () => {
    const id = upsertImport('https://a/pl', null);
    makeApp('yt-dlp', 'tok2'); // 默认桩:两条抓法都失败
    expect((await app.inject({ method: 'GET', url: `/api/imports/${id}/cover?token=tok2` })).statusCode).toBe(404);
  });

  // 2026-09-29:外网图床直连那次要白等 10s(Node fetch 不读系统代理)——按域名记一笔,同域名的第二张直接跳过去
  it('同一域名直连失败过一次 → 第二张同域封面不再空等,直接让 yt-dlp 写', async () => {
    const idA = upsertImport('https://www.youtube.com/watch?v=a', 'https://i.ytimg.com/vi/a/maxresdefault.webp');
    const idB = upsertImport('https://www.youtube.com/watch?v=b', 'https://i.ytimg.com/vi/b/maxresdefault.webp');
    let fetchCalls = 0;
    let writeCalls = 0;
    makeApp(
      'yt-dlp', 'tok2', undefined,
      async () => { fetchCalls += 1; return false; }, // 直连永远失败(外网图床的真实形态)
      async (o) => { writeCalls += 1; mkdirSync(o.coversDir, { recursive: true }); writeFileSync(join(o.coversDir, `cover-${o.importId}.webp`), 'B'); return true; },
    );
    expect((await app.inject({ method: 'GET', url: `/api/imports/${idA}/cover?token=tok2` })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/api/imports/${idB}/cover?token=tok2` })).statusCode).toBe(200);
    expect(fetchCalls).toBe(1); // 同域名第二次不再试 fetch(省掉那 10 秒)
    expect(writeCalls).toBe(2);
  });

  it('cover 路由鉴权:token 错 + 外站来源 → 401;Referer 是本机页面 → 放行(<img> 不带 Origin 的补丁)', async () => {
    makeApp('yt-dlp', 'tok2');
    expect((await app.inject({ method: 'GET', url: '/api/imports/1/cover?token=bad', headers: { origin: 'https://evil.example' } })).statusCode).toBe(401);
    // 本机页面的 Referer → 放行(来源不存在 → 404,证明没被 401 拦下)
    expect((await app.inject({ method: 'GET', url: '/api/imports/999/cover', headers: { referer: 'http://localhost:8000/' } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/imports/999/cover', headers: { referer: 'https://evil.example/x' } })).statusCode).toBe(401);
  });
});

// ---- 批4 Task 9:视频素材(2026-09-29 spec m1c-video-clip):下载进 <数据>/media/,不进 audio_items ----
describe('下载视频素材(produce=video)', () => {
  it('校验:produce 非法 → 400;videoHeight 非法 → 400;缺省 videoHeight 走 480', async () => {
    const dm = { start: vi.fn(), cancel: vi.fn(async () => {}), dispose: vi.fn(async () => {}) };
    makeApp('yt-dlp', 'tok2', dm as unknown as ReturnType<typeof createDownloadManager>);
    expect((await app.inject({ method: 'POST', url: '/api/ytdlp/download', payload: { url: 'https://a/v', options: { format: 'mp3' }, produce: 'movie' } })).statusCode).toBe(400);
    // Task 2(spec D10):档位放宽为整数 144..4320 后,999 已属**合法**;改用越界值 5000 验证仍然 400
    expect((await app.inject({ method: 'POST', url: '/api/ytdlp/download', payload: { url: 'https://a/v', options: { format: 'mp3', videoHeight: 5000 }, produce: 'video' } })).statusCode).toBe(400);
    // 缺省 videoHeight → 480 档:视频分支用 buildVideoDownloadArgs(不是 -x 抽音轨),job kind 是 ytdlp_video
    const res = await app.inject({ method: 'POST', url: '/api/ytdlp/download', payload: { url: 'https://a/v', options: { format: 'mp3' }, produce: 'video', title: 't' } });
    expect(res.statusCode).toBe(201);
    const startOpts = dm.start.mock.calls[0]?.[0] as { args: string[] };
    expect(startOpts.args.join(' ')).toContain('height<=480');
    expect(startOpts.args).not.toContain('-x');
    expect(createJobsRepo(db).get(res.json().jobId as number)!.kind).toBe('ytdlp_video');
  });
  it('produce 空串按 audio 处理(前端"没选"不是非法)', async () => {
    const dm = { start: vi.fn(), cancel: vi.fn(async () => {}), dispose: vi.fn(async () => {}) };
    makeApp('yt-dlp', 'tok2', dm as unknown as ReturnType<typeof createDownloadManager>);
    const res = await app.inject({ method: 'POST', url: '/api/ytdlp/download', payload: { url: 'https://a/v', options: { format: 'mp3' }, produce: '', title: 't' } });
    expect(res.statusCode).toBe(201);
    expect(createJobsRepo(db).get(res.json().jobId as number)!.kind).toBe('ytdlp_download');
  });
  it('视频下载不参与音频判重(换清晰度重下不该被 409 拦住)', async () => {
    const audioRepo = createAudioItemsRepo(db);
    audioRepo.create({ title: 't', source_type: 'download', source_url: 'https://a/v', file_path: 'C:/x.mp3', format: 'mp3', duration_sec: 1, file_size: 1 });
    const dm = { start: vi.fn(), cancel: vi.fn(async () => {}), dispose: vi.fn(async () => {}) };
    makeApp('yt-dlp', 'tok2', dm as unknown as ReturnType<typeof createDownloadManager>);
    const res = await app.inject({ method: 'POST', url: '/api/ytdlp/download', payload: { url: 'https://a/v', options: { format: 'mp3' }, produce: 'video', title: 't' } });
    expect(res.statusCode).toBe(201);
    expect(createJobsRepo(db).get(res.json().jobId as number)!.kind).toBe('ytdlp_video');
  });
  it('视频任务同 URL 并发 → 409 BUSY(按 ytdlp_video 查,与音频任务互不挡)', async () => {
    const jobsRepo = createJobsRepo(db);
    const jid = jobsRepo.create('ytdlp_video', { url: 'https://a/v', options: { format: 'mp3' }, produce: 'video' });
    jobsRepo.update(jid, { status: 'running' });
    makeApp('yt-dlp', 'tok2');
    const res = await app.inject({ method: 'POST', url: '/api/ytdlp/download', payload: { url: 'https://a/v', options: { format: 'mp3' }, produce: 'video', title: 't' } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('BUSY');
  });
  // 视频入库全链路(批4 裁定 R6 接线的直接验证):下载完成 → 落 media/ 记 source_videos,不进 audio_items
  it('produce=video 下载完成 → 落 media/ 记 source_videos,不进 audio_items', async () => {
    const producedPath = join(tempDir, 'vid.mp4');
    writeFileSync(producedPath, 'VIDEOBYTES');
    let fire: (() => void) | undefined;
    const dm = {
      start: vi.fn((opts: { jobId: number; onEvent: (jid: number, ev: unknown) => void }) => {
        fire = () => opts.onEvent(opts.jobId, { type: 'status', state: 'done', producedPath });
      }),
      cancel: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    makeApp('yt-dlp', 'tok2', dm as unknown as ReturnType<typeof createDownloadManager>);
    const res = await app.inject({ method: 'POST', url: '/api/ytdlp/download', payload: { url: 'https://a/v', options: { format: 'mp3' }, produce: 'video', title: '凡人' } });
    expect(res.statusCode).toBe(201);
    const jobId = res.json().jobId as number;
    fire!(); // 下载进程退出 → finalizeVideoDownload(rename + upsert source_videos)
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && createJobsRepo(db).get(jobId)!.status !== 'done') await new Promise((r) => setTimeout(r, 20));
    const rows = createSourceVideosRepo(db).list();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.import_id).toBe(1);
    expect(rows[0]!.height).toBe(480);
    expect(rows[0]!.entry_index).toBeNull(); // P2 方案A:不带 entryIndex 的视频素材,集号落 NULL
    expect(rows[0]!.file_path.startsWith(mediaDir)).toBe(true); // R6:placeVideo 返回的 placed.path 原样落库
    expect(existsSync(rows[0]!.file_path)).toBe(true);
    expect(existsSync(producedPath)).toBe(false); // rename 消耗掉临时产物
    expect(createAudioItemsRepo(db).list()).toHaveLength(0); // 不进剪辑室
    expect(createImportsRepo(db).getByUrl('https://a/v')).not.toBeNull(); // import 兜底 upsert
    expect(createJobsRepo(db).get(jobId)!.status).toBe('done');
  });
  // P2 方案A(Task 1,2026-09-30):视频单集下载——payload 顶层 entryIndex(与音频合集条目同口径)+
  // options.entryIndices(yt-dlp 选择参数,镜像音频侧);下载完成落库 source_videos.entry_index(D19 判定数据)
  it('video 下载带 entryIndex:3 + entryIndices:[3] → args 含 --playlist-items 3,落库 entry_index === 3', async () => {
    const producedPath = join(tempDir, 'vid3.mp4');
    writeFileSync(producedPath, 'VIDEOBYTES');
    let fire: (() => void) | undefined;
    const dm = {
      start: vi.fn((opts: { jobId: number; onEvent: (jid: number, ev: unknown) => void }) => {
        fire = () => opts.onEvent(opts.jobId, { type: 'status', state: 'done', producedPath });
      }),
      cancel: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    makeApp('yt-dlp', 'tok2', dm as unknown as ReturnType<typeof createDownloadManager>);
    const res = await app.inject({ method: 'POST', url: '/api/ytdlp/download', payload: { url: 'https://a/v', options: { format: 'mp3', entryIndices: [3] }, produce: 'video', title: '凡人', entryIndex: 3 } });
    expect(res.statusCode).toBe(201);
    // args 镜像音频侧:--playlist-items 3,且不再带 --no-playlist(dm.start 带强类型实现,须经 unknown 转)
    const startOpts = dm.start.mock.calls[0]?.[0] as unknown as { args: string[] };
    expect(startOpts.args).toContain('--playlist-items');
    expect(startOpts.args[startOpts.args.indexOf('--playlist-items') + 1]).toBe('3');
    expect(startOpts.args).not.toContain('--no-playlist');
    const jobId = res.json().jobId as number;
    fire!(); // 下载进程退出 → finalizeVideoDownload(记 entry_index + D19 留痕日志)
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && createJobsRepo(db).get(jobId)!.status !== 'done') await new Promise((r) => setTimeout(r, 20));
    const row = createSourceVideosRepo(db).get(1);
    expect(row).not.toBeNull();
    expect(row!.entry_index).toBe(3);
  });
  // 2026-10-01 spec clip-works D8(替换 D19 旧语义):换集重下 = 只清空该资料下**所有作品**的剪辑点,
  // 作品行与成品都保留(剪辑点指向旧视频而必须作废;作品名与成品是用户劳动成果,不该连坐)。
  it('换集重下:清空该资料下所有作品的段,保留作品行与成品', async () => {
    const importId = createImportsRepo(db).upsertByUrl({ url: 'https://a/v', title: '凡人', site: 'bilibili', kind: 'playlist', duration_sec: null, entries: null });
    const producedPath = join(tempDir, 'vid5.mp4');
    writeFileSync(producedPath, 'VIDEOBYTES');
    let fire: (() => void) | undefined;
    const dm = {
      start: vi.fn((opts: { jobId: number; onEvent: (jid: number, ev: unknown) => void }) => {
        fire = () => opts.onEvent(opts.jobId, { type: 'status', state: 'done', producedPath });
      }),
      cancel: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    makeApp('yt-dlp', 'tok2', dm as unknown as ReturnType<typeof createDownloadManager>); // mediaDir 在 makeApp 里才 mkdir,写旧素材文件必须在其后
    const oldVideo = join(mediaDir, `media-${importId}.webm`);
    writeFileSync(oldVideo, 'OLD');
    createSourceVideosRepo(db).upsert({ importId, filePath: oldVideo, height: 480, fileSize: 3, entryIndex: 2 });
    const clipRepo = createClipProjectsRepo(db);
    // 1 资料 + 2 作品(各有段) + 1 成品(T2 起用 repo.create 建多作品;成品挂第 1 个作品)
    const w1 = clipRepo.create(importId, '作品甲').id;
    const w2 = clipRepo.create(importId, '作品乙').id;
    db.prepare('INSERT INTO clip_segments (project_id, start_sec, end_sec) VALUES (?, ?, ?)').run(w1, 0, 10);
    db.prepare('INSERT INTO clip_segments (project_id, start_sec, end_sec) VALUES (?, ?, ?)').run(w2, 0, 10);
    db.prepare('INSERT INTO clip_segments (project_id, start_sec, end_sec) VALUES (?, ?, ?)').run(w2, 10, 20);
    createAudioItemsRepo(db).create({ title: '成品', source_type: 'edit', source_url: '', file_path: 'C:/x/p.mp3', format: 'mp3', duration_sec: 1, file_size: 1, source_work_id: w1 });
    const res = await app.inject({ method: 'POST', url: '/api/ytdlp/download', payload: { url: 'https://a/v', options: { format: 'mp3', entryIndices: [5] }, produce: 'video', title: '凡人', entryIndex: 5 } });
    expect(res.statusCode).toBe(201);
    const jobId = res.json().jobId as number;
    fire!(); // 下载进程退出 → finalizeVideoDownload(记 entry_index=5 + 换集清剪辑点)
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && createJobsRepo(db).get(jobId)!.status !== 'done') await new Promise((r) => setTimeout(r, 20));
    expect(createSourceVideosRepo(db).get(importId)!.entry_index).toBe(5); // 新集号已落库
    expect(clipRepo.countSegmentsByImportId(importId)).toBe(0); // 两个作品的段都被清
    expect((db.prepare('SELECT COUNT(*) AS n FROM clip_projects WHERE import_id = ?').get(importId) as { n: number }).n).toBe(2); // 作品行保留
    expect(createAudioItemsRepo(db).list()).toHaveLength(1); // 成品保留
    // 仓库铁律:关键步骤必须有日志,且按新文案说清影响面(作品数 / 段数)
    expect(getLogs().some((l) => l.source === 'job' && l.message.includes('清空该资料下作品的剪辑点') && l.message.includes('作品2个/段3个'))).toBe(true);
  });
  it('视频同集换清晰度(旧 2 → 新 2)下载完成 → 剪辑工程保留(用户剪辑点不丢)', async () => {
    const importId = createImportsRepo(db).upsertByUrl({ url: 'https://a/v', title: '凡人', site: 'bilibili', kind: 'playlist', duration_sec: null, entries: null });
    const producedPath = join(tempDir, 'vid720.mp4');
    writeFileSync(producedPath, 'VIDEOBYTES720');
    let fire: (() => void) | undefined;
    const dm = {
      start: vi.fn((opts: { jobId: number; onEvent: (jid: number, ev: unknown) => void }) => {
        fire = () => opts.onEvent(opts.jobId, { type: 'status', state: 'done', producedPath });
      }),
      cancel: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    makeApp('yt-dlp', 'tok2', dm as unknown as ReturnType<typeof createDownloadManager>); // mediaDir 在 makeApp 里才 mkdir,写旧素材文件必须在其后
    const oldVideo = join(mediaDir, `media-${importId}.mp4`);
    writeFileSync(oldVideo, 'OLD480');
    createSourceVideosRepo(db).upsert({ importId, filePath: oldVideo, height: 480, fileSize: 5, entryIndex: 2 });
    const clipRepo = createClipProjectsRepo(db);
    const pid = Number(db.prepare('INSERT INTO clip_projects (import_id) VALUES (?)').run(importId).lastInsertRowid);
    db.prepare('INSERT INTO clip_segments (project_id, start_sec, end_sec) VALUES (?, ?, ?)').run(pid, 0, 10);
    db.prepare('INSERT INTO clip_segments (project_id, start_sec, end_sec) VALUES (?, ?, ?)').run(pid, 10, 20);
    const res = await app.inject({ method: 'POST', url: '/api/ytdlp/download', payload: { url: 'https://a/v', options: { format: 'mp3', entryIndices: [2], videoHeight: 720 }, produce: 'video', title: '凡人', entryIndex: 2 } });
    expect(res.statusCode).toBe(201);
    const jobId = res.json().jobId as number;
    fire!(); // 下载进程退出 → finalizeVideoDownload(entry_index 未变 → 保留工程)
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && createJobsRepo(db).get(jobId)!.status !== 'done') await new Promise((r) => setTimeout(r, 20));
    expect(createSourceVideosRepo(db).get(importId)!.entry_index).toBe(2);
    expect(createSourceVideosRepo(db).get(importId)!.height).toBe(720); // 素材确实换了清晰度
    expect(clipRepo.countSegmentsByImportId(importId)).toBe(2); // 段还在
    expect((db.prepare('SELECT COUNT(*) AS n FROM clip_projects WHERE import_id = ?').get(importId) as { n: number }).n).toBe(1); // 工程行还在
    expect(getLogs().some((l) => l.source === 'job' && l.message.includes('保留剪辑工程'))).toBe(true);
  });
  // T7-3(2026-09-30,backlog 收口):单视频重下的 NULL→NULL 保留路径。
  // 旧素材 entry_index=NULL(单视频);新下载也没带 entryIndex(仍 NULL)——D19 两侧 ?? null 归一后相等,
  // 工程与段必须原样保留,别把「单视频重下」误判成「换集」而清掉用户的剪辑点。
  it('视频单视频重下(旧 NULL → 新 NULL)下载完成 → 剪辑工程保留(未误判为换集)', async () => {
    const importId = createImportsRepo(db).upsertByUrl({ url: 'https://a/v', title: '凡人', site: 'bilibili', kind: 'single', duration_sec: null, entries: null });
    const producedPath = join(tempDir, 'vidRedl.mp4');
    writeFileSync(producedPath, 'VIDEOBYTESREDL');
    let fire: (() => void) | undefined;
    const dm = {
      start: vi.fn((opts: { jobId: number; onEvent: (jid: number, ev: unknown) => void }) => {
        fire = () => opts.onEvent(opts.jobId, { type: 'status', state: 'done', producedPath });
      }),
      cancel: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    makeApp('yt-dlp', 'tok2', dm as unknown as ReturnType<typeof createDownloadManager>); // mediaDir 在 makeApp 里才 mkdir,写旧素材文件必须在其后
    const oldVideo = join(mediaDir, `media-${importId}.mp4`);
    writeFileSync(oldVideo, 'OLD480');
    createSourceVideosRepo(db).upsert({ importId, filePath: oldVideo, height: 480, fileSize: 5 }); // 不带 entryIndex → entry_index 落 NULL
    const clipRepo = createClipProjectsRepo(db);
    const pid = Number(db.prepare('INSERT INTO clip_projects (import_id) VALUES (?)').run(importId).lastInsertRowid);
    db.prepare('INSERT INTO clip_segments (project_id, start_sec, end_sec) VALUES (?, ?, ?)').run(pid, 0, 10);
    db.prepare('INSERT INTO clip_segments (project_id, start_sec, end_sec) VALUES (?, ?, ?)').run(pid, 10, 20);
    // 不带 entryIndex → 新集号仍为 NULL(单视频重下)
    const res = await app.inject({ method: 'POST', url: '/api/ytdlp/download', payload: { url: 'https://a/v', options: { format: 'mp3', videoHeight: 720 }, produce: 'video', title: '凡人' } });
    expect(res.statusCode).toBe(201);
    const jobId = res.json().jobId as number;
    fire!(); // 下载进程退出 → finalizeVideoDownload(NULL → NULL 视为同集 → 保留工程)
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && createJobsRepo(db).get(jobId)!.status !== 'done') await new Promise((r) => setTimeout(r, 20));
    expect(createSourceVideosRepo(db).get(importId)!.entry_index).toBeNull(); // 新集号仍 NULL
    expect(createSourceVideosRepo(db).get(importId)!.height).toBe(720); // 素材确实换了清晰度
    expect(clipRepo.countSegmentsByImportId(importId)).toBe(2); // 段原样保留
    expect((db.prepare('SELECT COUNT(*) AS n FROM clip_projects WHERE import_id = ?').get(importId) as { n: number }).n).toBe(1); // 工程行原样保留
    expect(getLogs().some((l) => l.source === 'job' && l.message.includes('保留剪辑工程'))).toBe(true);
  });
});

// ---- Task 2(2026-09-30 spec D10):videoHeight 类型放宽为整数 + 服务端校验(整数且 144..4320) ----
describe('POST /api/ytdlp/download videoHeight 放宽 + 校验(Task 2)', () => {
  // Task 1 起提交走并发受限队列(测试里上限 1):同一 dm 连发两单时,必须让前一单进终态释放槽位,
  // 否则第二个会永远停在 pending 不启动(既有用例假设"直接 start")。这里让 start 同步补发一个 error 终态,
  // 只为放行槽位——本 describe 的断言只关心状态码与 args,不关心任务成败。
  const mkDm = () => ({
    start: vi.fn((opts: { jobId: number; onEvent: (jid: number, ev: unknown) => void }) => {
      opts.onEvent(opts.jobId, { type: 'status', state: 'error', message: 'test: 立即终结以释放队列槽位' });
    }),
    cancel: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
  });
  const lastArgs = (dm: ReturnType<typeof mkDm>): string[] =>
    (dm.start.mock.calls[dm.start.mock.calls.length - 1]?.[0] as unknown as { args: string[] }).args;
  // 成功用例各自用**不同 URL**:路由有「同 URL 同 kind 并发 → 409 BUSY」,同址连发会被误判
  const post = (videoHeight: unknown, produce: string | undefined, url: string) =>
    app.inject({
      method: 'POST', url: '/api/ytdlp/download',
      payload: { url, options: { format: 'mp3', videoHeight }, ...(produce === undefined ? {} : { produce }), title: 't' },
    });

  it('实测档 1440 → 201 且 args 含 height<=1440', async () => {
    const dm = mkDm();
    makeApp('yt-dlp', 'tok2', dm as unknown as ReturnType<typeof createDownloadManager>);
    const res = await post(1440, 'video', 'https://a/v1');
    expect(res.statusCode).toBe(201);
    expect(lastArgs(dm).join(' ')).toContain('height<=1440');
  });

  it('边界 144(下界)/ 4320(上界)→ 201 且表达式用原值', async () => {
    const dm = mkDm();
    makeApp('yt-dlp', 'tok2', dm as unknown as ReturnType<typeof createDownloadManager>);
    expect((await post(144, 'video', 'https://a/v2')).statusCode).toBe(201);
    expect(lastArgs(dm).join(' ')).toContain('height<=144');
    expect((await post(4320, 'video', 'https://a/v3')).statusCode).toBe(201);
    expect(lastArgs(dm).join(' ')).toContain('height<=4320');
  });

  it.each([100, 143, 4321, 5000, 'abc', 720.5])('非法 videoHeight %s → 400 BAD_REQUEST', async (bad) => {
    makeApp('yt-dlp', 'tok2', mkDm() as unknown as ReturnType<typeof createDownloadManager>);
    const res = await post(bad, 'video', 'https://a/bad');
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('BAD_REQUEST');
  });

  // 缺省(不传)与显式 null 都退回 480:与磁盘既有 `Number(raw ?? 480)` 语义一致,也符合「没选档位不是非法」。
  // (计划 Step 1 的示例把 null 列入「非法 → 400」,与计划自带实现/磁盘现状矛盾——以磁盘为准,见报告偏离记录)
  it('缺省(不传)与 null → 退回 480,不报错(沿用既有缺省语义)', async () => {
    const dm = mkDm();
    makeApp('yt-dlp', 'tok2', dm as unknown as ReturnType<typeof createDownloadManager>);
    expect((await post(undefined, 'video', 'https://a/v4')).statusCode).toBe(201);
    expect(lastArgs(dm).join(' ')).toContain('height<=480');
    expect((await post(null, 'video', 'https://a/v5')).statusCode).toBe(201);
    expect(lastArgs(dm).join(' ')).toContain('height<=480');
  });

  it('音频支(produce 缺省)不受该校验影响:越界 videoHeight 也 201(不能让它把音频下载 400)', async () => {
    const dm = mkDm();
    makeApp('yt-dlp', 'tok2', dm as unknown as ReturnType<typeof createDownloadManager>);
    const res = await post(5000, undefined, 'https://a/v6');
    expect(res.statusCode).toBe(201);
    expect(lastArgs(dm)).toContain('-x'); // 音频支参数(抽音轨)
    expect(lastArgs(dm).join(' ')).not.toContain('height<='); // 不掺视频档位表达式
  });
});

// ---- 批4 R2 补测:retry 按 kind 分支 ----
describe('POST /api/jobs/:id/retry 按 kind 分支(批4)', () => {
  it('视频任务重试 → 新 job kind 仍为 ytdlp_video,且不参与音频判重(R2-a)', async () => {
    createAudioItemsRepo(db).create({ title: 't', source_type: 'download', source_url: 'https://a/v', file_path: 'C:/x.mp3', format: 'mp3', duration_sec: 1, file_size: 1 });
    const jobsRepo = createJobsRepo(db);
    const jid = jobsRepo.create('ytdlp_video', { url: 'https://a/v', options: { format: 'mp3' }, produce: 'video', title: 't' });
    jobsRepo.fail(jid, '网络失败');
    const dm = { start: vi.fn(), cancel: vi.fn(async () => {}), dispose: vi.fn(async () => {}) };
    makeApp('yt-dlp', 'tok2', dm as unknown as ReturnType<typeof createDownloadManager>);
    const res = await app.inject({ method: 'POST', url: `/api/jobs/${jid}/retry` });
    expect(res.statusCode).toBe(201);
    expect(createJobsRepo(db).get(res.json().jobId as number)!.kind).toBe('ytdlp_video');
  });
  it('剪辑任务重试但素材已删 → 409 MEDIA_GONE,文案含「素材已不存在」(R2-b)', async () => {
    const jobsRepo = createJobsRepo(db);
    const jid = jobsRepo.create('ffmpeg_clip', { importId: 1, videoPath: join(tempDir, 'gone.mp4'), start: 0, end: 5, format: 'mp3' });
    jobsRepo.fail(jid, 'ffmpeg 失败');
    makeApp('yt-dlp', 'tok2');
    const res = await app.inject({ method: 'POST', url: `/api/jobs/${jid}/retry` });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('MEDIA_GONE');
    expect(res.json().error.message).toContain('素材已不存在');
  });
  // M3(修复轮 1,2026-09-30):剪辑任务重试的**成功**路径此前无覆盖——注入 clipStarter 桩捕获调用参数,
  // videoPath 指向真实存在的临时文件(先过 MEDIA_GONE 拦截)→ 断言 201 + 桩被调且 payload 原样透传 + 新 job kind 仍为 ffmpeg_clip
  it('剪辑任务重试成功 → 201 + clipStarter 被调且 payload 正确 + 新 job kind 为 ffmpeg_clip(M3)', async () => {
    const videoPath = join(tempDir, 'media-clip-src.mp4');
    writeFileSync(videoPath, 'VIDEOBYTES'); // retry 分支 existsSync(videoPath) 要真文件
    const jobsRepo = createJobsRepo(db);
    const clipPayload = { importId: 1, videoPath, start: 10, end: 30, format: 'mp3', quality: '192k', title: '前缀', sourceUrl: 'https://a/v' };
    const oldId = jobsRepo.create('ffmpeg_clip', clipPayload);
    jobsRepo.fail(oldId, 'ffmpeg 失败'); // 仅 error 可重试(P1-4)
    const calls: Array<{ jobId: number; payload: unknown }> = [];
    makeApp('yt-dlp', 'tok2', undefined, undefined, undefined, async (jobId, payload) => { calls.push({ jobId, payload }); });
    const res = await app.inject({ method: 'POST', url: `/api/jobs/${oldId}/retry` });
    expect(res.statusCode).toBe(201);
    const newId = res.json().jobId as number;
    expect(calls).toEqual([{ jobId: newId, payload: clipPayload }]); // payload 原样透传(JSON 存取往返后深相等)
    expect(createJobsRepo(db).get(newId)!.kind).toBe('ffmpeg_clip');
  });
  // P4 T4:导出任务(ffmpeg_export)重试同族——素材已删拦截、成功交接 exportStarter、未接线 500
  it('导出任务重试但素材已删 → 409 MEDIA_GONE(P4-T4)', async () => {
    const jobsRepo = createJobsRepo(db);
    const jid = jobsRepo.create('ffmpeg_export', { importId: 1, videoPath: join(tempDir, 'gone.mp4'), mode: 'merge', format: 'mp3', segments: [] });
    jobsRepo.fail(jid, 'ffmpeg 失败');
    makeApp('yt-dlp', 'tok2');
    const res = await app.inject({ method: 'POST', url: `/api/jobs/${jid}/retry` });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('MEDIA_GONE');
    expect(res.json().error.message).toContain('素材已不存在');
  });
  it('导出任务重试成功 → 201 + exportStarter 被调且 payload 正确 + 新 job kind 为 ffmpeg_export(P4-T4)', async () => {
    const videoPath = join(tempDir, 'media-export-src.mp4');
    writeFileSync(videoPath, 'VIDEOBYTES'); // retry 分支 existsSync(videoPath) 要真文件
    const jobsRepo = createJobsRepo(db);
    const exportPayload = { importId: 1, projectId: 7, videoPath, mode: 'merge', format: 'mp3', quality: '192k', prefix: '凡人', segments: [{ start_sec: 0, end_sec: 10 }] };
    const oldId = jobsRepo.create('ffmpeg_export', exportPayload);
    jobsRepo.fail(oldId, 'ffmpeg 失败'); // 仅 error 可重试(P1-4)
    const calls: Array<{ jobId: number; payload: unknown }> = [];
    makeApp('yt-dlp', 'tok2', undefined, undefined, undefined, undefined, async (jobId, payload) => { calls.push({ jobId, payload }); });
    const res = await app.inject({ method: 'POST', url: `/api/jobs/${oldId}/retry` });
    expect(res.statusCode).toBe(201);
    const newId = res.json().jobId as number;
    expect(calls).toEqual([{ jobId: newId, payload: exportPayload }]); // payload 原样透传
    expect(createJobsRepo(db).get(newId)!.kind).toBe('ffmpeg_export');
  });
  it('导出任务重试但未接线 exportStarter → 500 NOT_WIRED(P4-T4)', async () => {
    const videoPath = join(tempDir, 'media-export-nowire.mp4');
    writeFileSync(videoPath, 'VIDEOBYTES');
    const jobsRepo = createJobsRepo(db);
    const jid = jobsRepo.create('ffmpeg_export', { importId: 1, projectId: 7, videoPath, mode: 'merge', format: 'mp3', segments: [] });
    jobsRepo.fail(jid, 'ffmpeg 失败');
    makeApp('yt-dlp', 'tok2'); // 不注入 exportStarter
    const res = await app.inject({ method: 'POST', url: `/api/jobs/${jid}/retry` });
    expect(res.statusCode).toBe(500);
    expect(res.json().error.code).toBe('NOT_WIRED');
  });
  // 2026-10-01 T3 跨任务项:升级前的旧导出 job payload **没有 projectId**。若照旧送进 startExportJob,
  // 会被 D22 判成"作品已删除"(假理由,违反本仓"日志必须诚实")。故重试时先查这一条,缺则跳过 + 诚实日志。
  it('重试旧导出任务(payload 无 projectId)→ 400 + 诚实日志,不送进导出器', async () => {
    const videoPath = join(tempDir, 'legacy-export.mp4');
    writeFileSync(videoPath, 'VIDEOBYTES'); // 需先过 retry 分支的 existsSync(videoPath)
    const jobsRepo = createJobsRepo(db);
    const jid = jobsRepo.create('ffmpeg_export', { importId: 1, videoPath, mode: 'merge', format: 'mp3', segments: [] }); // 老 payload:无 projectId
    jobsRepo.fail(jid, 'ffmpeg 失败');
    const calls: unknown[] = [];
    makeApp('yt-dlp', 'tok2', undefined, undefined, undefined, undefined, async (jobId, payload) => { calls.push({ jobId, payload }); });
    const res = await app.inject({ method: 'POST', url: `/api/jobs/${jid}/retry` });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('NO_WORK_INFO');
    expect(calls).toEqual([]); // 没交给 exportStarter
    expect(getLogs().some((l) => l.source === 'job' && l.message.includes('旧导出任务缺少作品信息'))).toBe(true);
  });
});

// ---- 批4 R2-c:DELETE /api/imports/:id 连带清素材 ----
describe('DELETE /api/imports/:id 连带清素材(批4)', () => {
  it('删来源 → source_videos 行、media 文件、imported_sources 行一并消失', async () => {
    makeApp('yt-dlp', 'tok2');
    const importId = createImportsRepo(db).upsertByUrl({ url: 'https://a/v', title: '凡人', site: 'bilibili', kind: 'single', duration_sec: null, entries: null });
    const p = join(mediaDir, `media-${importId}.mp4`);
    writeFileSync(p, 'VIDEOBYTES');
    createSourceVideosRepo(db).upsert({ importId, filePath: p, height: 480, fileSize: 10 });
    expect((await app.inject({ method: 'DELETE', url: `/api/imports/${importId}` })).statusCode).toBe(200);
    expect(createImportsRepo(db).get(importId)).toBeNull();
    expect(createSourceVideosRepo(db).get(importId)).toBeNull();
    expect(existsSync(p)).toBe(false);
  });
  // 2026-10-01 spec clip-works D7:删资料 = 现状减去"清剪辑数据" —— 作品与成品全部保留(资料没了,作品只读)。
  it('删来源 → 不再动剪辑作品与成品(作品行/段/成品都保留)', async () => {
    makeApp('yt-dlp', 'tok2');
    const importId = createImportsRepo(db).upsertByUrl({ url: 'https://a/clip', title: '凡人', site: 'bilibili', kind: 'single', duration_sec: null, entries: null });
    const pid = Number(db.prepare('INSERT INTO clip_projects (import_id) VALUES (?)').run(importId).lastInsertRowid);
    db.prepare('INSERT INTO clip_segments (project_id, start_sec, end_sec) VALUES (?, ?, ?)').run(pid, 0, 10);
    db.prepare('INSERT INTO clip_segments (project_id, start_sec, end_sec) VALUES (?, ?, ?)').run(pid, 10, 20);
    createAudioItemsRepo(db).create({ title: '成品', source_type: 'edit', source_url: '', file_path: 'C:/x/p.mp3', format: 'mp3', duration_sec: 1, file_size: 1, source_work_id: pid });
    expect((await app.inject({ method: 'DELETE', url: `/api/imports/${importId}` })).statusCode).toBe(200);
    expect(createImportsRepo(db).get(importId)).toBeNull(); // 资料本身删了
    expect((db.prepare('SELECT COUNT(*) AS n FROM clip_projects WHERE import_id = ?').get(importId) as { n: number }).n).toBe(1); // 作品行保留
    expect((db.prepare('SELECT COUNT(*) AS n FROM clip_segments WHERE project_id = ?').get(pid) as { n: number }).n).toBe(2); // 段保留
    expect(createAudioItemsRepo(db).list()).toHaveLength(1); // 成品保留
    // 仓库铁律:关键步骤留痕;新文案要说明"保留"而不是"连带清空"
    expect(getLogs().some((l) => l.source === 'project' && l.message.includes('剪辑作品与成品保留'))).toBe(true);
    expect((await app.inject({ method: 'DELETE', url: `/api/imports/${importId}` })).statusCode).toBe(200); // 幂等:已删来源再删不报错
  });
});

// ---- P2(2026-09-30):/api/imports 派生列 has_video/has_project/segment_count(spec D7 两表提前建后补出参) ----
// ---- P3-T1(2026-09-30):同组派生列再加 material_entry_index(素材集号;无素材/单视频 → null,剪辑室卡片「素材:第 N 集」) ----
describe('/api/imports 派生列(has_video/has_project/segment_count/material_entry_index)', () => {
  const seedProjectWithSegments = (impId: number, segCount: number): void => {
    const pid = Number(db.prepare('INSERT INTO clip_projects (import_id) VALUES (?)').run(impId).lastInsertRowid);
    for (let i = 0; i < segCount; i++) {
      db.prepare('INSERT INTO clip_segments (project_id, start_sec, end_sec) VALUES (?, ?, ?)').run(pid, i * 10, i * 10 + 5);
    }
  };
  it('三态:无素材无工程 false/false/0;有素材无工程 true/false/0;有素材有工程 true/true/段数', async () => {
    makeApp('yt-dlp', 'tok2');
    const bare = createImportsRepo(db).upsertByUrl({ url: 'https://a/bare', title: '裸来源', site: 'other', kind: 'single', duration_sec: null, entries: null });
    const withVideo = createImportsRepo(db).upsertByUrl({ url: 'https://a/vid', title: '有素材', site: 'bilibili', kind: 'single', duration_sec: null, entries: null });
    const full = createImportsRepo(db).upsertByUrl({ url: 'https://a/full', title: '全都有', site: 'bilibili', kind: 'single', duration_sec: null, entries: null });
    writeFileSync(join(mediaDir, `media-${withVideo}.mp4`), 'V');
    createSourceVideosRepo(db).upsert({ importId: withVideo, filePath: join(mediaDir, `media-${withVideo}.mp4`), height: 480, fileSize: 1, entryIndex: 1 });
    writeFileSync(join(mediaDir, `media-${full}.mp4`), 'V');
    createSourceVideosRepo(db).upsert({ importId: full, filePath: join(mediaDir, `media-${full}.mp4`), height: 720, fileSize: 1, entryIndex: 2 });
    seedProjectWithSegments(full, 2);
    const res = await app.inject({ method: 'GET', url: '/api/imports' });
    expect(res.statusCode).toBe(200);
    const rows = (res.json() as { imports: Array<{ id: number; has_video: boolean; has_project: boolean; segment_count: number; has_cover: boolean; material_entry_index: number | null }> }).imports;
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(bare)).toMatchObject({ has_video: false, has_project: false, segment_count: 0, material_entry_index: null }); // 无素材 → 集号 null(前端据此判「无素材」)
    expect(byId.get(withVideo)).toMatchObject({ has_video: true, has_project: false, segment_count: 0, material_entry_index: 1 }); // 有素材 entry_index=1 → 原样带出
    expect(byId.get(full)).toMatchObject({ has_video: true, has_project: true, segment_count: 2, material_entry_index: 2 }); // 有素材 entry_index=2 → 原样带出
  });
  it('GET /api/imports/:id 详情行同样带出派生列(ImportDetailRow 与列表同型)', async () => {
    makeApp('yt-dlp', 'tok2');
    const id = createImportsRepo(db).upsertByUrl({ url: 'https://a/full', title: '全都有', site: 'bilibili', kind: 'single', duration_sec: null, entries: null });
    writeFileSync(join(mediaDir, `media-${id}.mp4`), 'V');
    createSourceVideosRepo(db).upsert({ importId: id, filePath: join(mediaDir, `media-${id}.mp4`), height: 720, fileSize: 1, entryIndex: 4 }); // derivedJoin 走 SELECT s.*,素材集号需显式补出
    seedProjectWithSegments(id, 1);
    const res = await app.inject({ method: 'GET', url: `/api/imports/${id}` });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { import: { has_video: boolean; has_project: boolean; segment_count: number; material_entry_index: number | null } }).import)
      .toMatchObject({ has_video: true, has_project: true, segment_count: 1, material_entry_index: 4 });
  });
  // 2026-10-01 spec clip-works:1:N 之后——一个资料两件作品时,列表仍**恰好一行**(不能因 JOIN 作品表被复制成多行),
  // 且 work_count=2、segment_count=两件作品段数之和
  it('1:N:一个资料两件作品 → 列表仍一行;work_count=2;segment_count=两作品段数之和', async () => {
    makeApp('yt-dlp', 'tok2');
    const imp = createImportsRepo(db).upsertByUrl({ url: 'https://a/two', title: '两作品', site: 'bilibili', kind: 'single', duration_sec: null, entries: null });
    const clipRepo = createClipProjectsRepo(db);
    const w1 = clipRepo.create(imp, '甲').id;
    const w2 = clipRepo.create(imp, '乙').id;
    db.prepare('INSERT INTO clip_segments (project_id, start_sec, end_sec) VALUES (?, ?, ?)').run(w1, 0, 10);
    db.prepare('INSERT INTO clip_segments (project_id, start_sec, end_sec) VALUES (?, ?, ?)').run(w2, 0, 10);
    db.prepare('INSERT INTO clip_segments (project_id, start_sec, end_sec) VALUES (?, ?, ?)').run(w2, 10, 20);
    const body = (await app.inject({ method: 'GET', url: '/api/imports' })).json() as { imports: Array<{ id: number; has_project: boolean; segment_count: number; work_count: number }> };
    expect(body.imports.filter((r) => r.id === imp)).toHaveLength(1); // 不因多作品被复制成多行
    expect(body.imports.find((r) => r.id === imp)).toMatchObject({ has_project: true, segment_count: 3, work_count: 2 });
  });
});
