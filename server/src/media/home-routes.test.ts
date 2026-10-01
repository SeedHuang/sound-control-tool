// server/src/media/home-routes.test.ts
// 首页仪表盘路由(P5-T1,spec §0.3「其它」):GET /api/home 两块 Top3 —— editing(正在编辑)/ recent(按来源去重的最近下载)。
// 直接在裸 Fastify 上注册(不挂 token 守卫)——token 校验属 index.ts 的 onRequest 钩子职责,不在这层。
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type DB } from '../db/index.js';
import { initSchema } from '../db/schema.js';
import { createImportsRepo } from '../db/repo/imports.js';
import { createClipProjectsRepo } from '../db/repo/clip-projects.js';
import { createAudioItemsRepo } from '../db/repo/audio-items.js';
import { registerHomeRoutes } from './home-routes.js';

let app: FastifyInstance;
let db: DB;

beforeEach(() => {
  db = openDatabase(':memory:');
  initSchema(db);
  app = Fastify({ logger: false });
  registerHomeRoutes(app, { db });
});
afterEach(async () => {
  await app.close();
});

interface HomeBody {
  ok: boolean;
  editing: Array<{ import_id: number; name: string | null; site: string; updated_at: string; segment_count: number }>;
  recent: Array<{ import_id: number; title: string; site: string; latest_audio_id: number; created_at: string }>;
}
const getHome = async (): Promise<HomeBody> =>
  (await app.inject({ method: 'GET', url: '/api/home' })).json() as HomeBody;

/** 造一个来源行,返回它的 id(= 业务里的 import_id) */
function addImport(url: string, title: string, site = 'bilibili'): number {
  return createImportsRepo(db).upsertByUrl({ url, title, site, kind: 'playlist', duration_sec: null, entries: null });
}

/** 造一条音频并**显式指定 created_at**(默认 datetime('now') 只有秒级精度,同秒插入无法区分先后 → 测试必须能控序) */
function addAudio(opts: {
  title: string; sourceType: string; sourceUrl: string | null; createdAt: string;
  collectionTitle?: string | null; entryIndex?: number | null;
}): number {
  const id = createAudioItemsRepo(db).create({
    title: opts.title, source_type: opts.sourceType, source_url: opts.sourceUrl,
    file_path: `/no/such/${Math.random().toString(36).slice(2)}.mp3`, format: 'mp3', duration_sec: 1, file_size: 1,
    entry_index: opts.entryIndex ?? null, collection_title: opts.collectionTitle ?? null,
  });
  db.prepare('UPDATE audio_items SET created_at = ? WHERE id = ?').run(opts.createdAt, id);
  return id;
}

/** 造一个剪辑工程(带 segCount 段)并**显式指定 updated_at**(upsert 里写的是 now,测试要能控序) */
function addProject(importId: number, name: string | null, segCount: number, updatedAt: string): void {
  createClipProjectsRepo(db).upsert(importId, name, Array.from({ length: segCount }, (_, i) => ({ start_sec: i, end_sec: i + 1 })));
  db.prepare('UPDATE clip_projects SET updated_at = ? WHERE import_id = ?').run(updatedAt, importId);
}

describe('GET /api/home —— editing(正在编辑 Top3)', () => {
  it('空库 → ok:true,editing/recent 都是空数组', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/home' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, editing: [], recent: [] });
  });

  it('3 个工程按 updated_at 倒序;segment_count 正确;name 为 NULL 回 null', async () => {
    const a = addImport('https://b/1', '来源A', 'bilibili');
    const b = addImport('https://b/2', '来源B', 'youtube');
    const c = addImport('https://b/3', '来源C', 'other');
    addProject(a, '工程A', 2, '2026-09-01 10:00:00');
    addProject(b, null, 0, '2026-09-02 10:00:00'); // 没命名 + 没段
    addProject(c, '工程C', 5, '2026-09-03 10:00:00');

    const body = await getHome();
    expect(body.editing).toEqual([
      { import_id: c, name: '工程C', site: 'other', updated_at: '2026-09-03 10:00:00', segment_count: 5 },
      { import_id: b, name: null, site: 'youtube', updated_at: '2026-09-02 10:00:00', segment_count: 0 }, // name 为 NULL → null;无段 → 0
      { import_id: a, name: '工程A', site: 'bilibili', updated_at: '2026-09-01 10:00:00', segment_count: 2 },
    ]); // 整体断言:顺序(新→旧)+ 字段形状 + NULL 归一一次到位
  });

  it('超过 3 个工程只回 3 条', async () => {
    const ids: number[] = [];
    for (let i = 0; i < 4; i++) {
      const id = addImport(`https://b/m${i}`, `来源M${i}`);
      addProject(id, `工程M${i}`, 1, `2026-09-0${i + 1} 10:00:00`);
      ids.push(id);
    }
    const body = await getHome();
    expect(body.editing).toHaveLength(3);
    expect(body.editing.map((e) => e.import_id)).toEqual([ids[3], ids[2], ids[1]]); // 丢掉最旧的 ids[0]
  });

  it('来源已不存在的工程不出现在 editing(INNER JOIN 排除)', async () => {
    const id = addImport('https://b/x', '来源X');
    addProject(id, '工程X', 1, '2026-09-01 10:00:00');
    createImportsRepo(db).delete(id); // 删来源、留下工程行(模拟清理漏网)
    expect((await getHome()).editing).toEqual([]);
  });
});

describe('GET /api/home —— recent(按来源去重的最近下载 Top3)', () => {
  it('同一来源下 3 条音频只算 1 条,且取最新那条(latest_audio_id / created_at)', async () => {
    const s = addImport('https://b/pl', '凡人修仙传');
    addAudio({ title: '第1集', sourceType: 'download', sourceUrl: 'https://b/pl', createdAt: '2026-09-01 10:00:00', collectionTitle: '凡人修仙传', entryIndex: 1 });
    const mid = addAudio({ title: '第2集', sourceType: 'download', sourceUrl: 'https://b/pl', createdAt: '2026-09-02 10:00:00', collectionTitle: '凡人修仙传', entryIndex: 2 });
    const latest = addAudio({ title: '第3集', sourceType: 'download', sourceUrl: 'https://b/pl', createdAt: '2026-09-03 10:00:00', collectionTitle: '凡人修仙传', entryIndex: 3 });

    const body = await getHome();
    expect(body.recent).toEqual([
      { import_id: s, title: '凡人修仙传', site: 'bilibili', latest_audio_id: latest, created_at: '2026-09-03 10:00:00' },
    ]); // 只 1 条(去重生效)+ 取的是最新那条(latest_audio_id/created_at 来自第3集,不是 mid)
    expect(body.recent.map((r) => r.latest_audio_id)).not.toContain(mid); // 裸列取的是 MAX 那一行,不是任意行
  });

  it('title 口径:无合集名时退回音频自身标题(collection_title ?? title)', async () => {
    const s = addImport('https://b/single', '单集视频');
    const id = addAudio({ title: '单集视频', sourceType: 'download', sourceUrl: 'https://b/single', createdAt: '2026-09-05 10:00:00', collectionTitle: null });
    const body = await getHome();
    expect(body.recent).toEqual([{ import_id: s, title: '单集视频', site: 'bilibili', latest_audio_id: id, created_at: '2026-09-05 10:00:00' }]);
  });

  it("source_type='edit'/'recording' 不出现;source_url 匹配不上来源的不出现", async () => {
    const s = addImport('https://b/pl2', '合集2');
    const downloadId = addAudio({ title: '下载集', sourceType: 'download', sourceUrl: 'https://b/pl2', createdAt: '2026-09-01 10:00:00' });
    // 这三条时间都更新,但都不该出现 —— 若 WHERE 漏了它们就会顶掉「下载集」成为最新
    addAudio({ title: '剪辑产物', sourceType: 'edit', sourceUrl: 'https://b/pl2', createdAt: '2026-09-09 10:00:00' });
    addAudio({ title: '录制', sourceType: 'recording', sourceUrl: null, createdAt: '2026-09-09 10:00:00' });
    addAudio({ title: '无来源下载', sourceType: 'download', sourceUrl: 'https://nowhere/xx', createdAt: '2026-09-09 10:00:00' });

    const body = await getHome();
    expect(body.recent).toEqual([
      { import_id: s, title: '下载集', site: 'bilibili', latest_audio_id: downloadId, created_at: '2026-09-01 10:00:00' },
    ]); // 只有「下载集」一条;created_at 是 09-01,证明没被后三条更晚的时间顶掉
  });

  it('超过 3 个来源只回 3 条,按各自最新音频时间倒序', async () => {
    const ids: number[] = [];
    for (let i = 0; i < 4; i++) {
      const s = addImport(`https://b/p${i}`, `作品${i}`);
      addAudio({ title: `作品${i}`, sourceType: 'download', sourceUrl: `https://b/p${i}`, createdAt: `2026-09-0${i + 1} 10:00:00`, collectionTitle: `作品${i}` });
      ids.push(s);
    }
    const body = await getHome();
    expect(body.recent).toHaveLength(3);
    expect(body.recent.map((r) => r.import_id)).toEqual([ids[3], ids[2], ids[1]]); // 丢掉最旧的 ids[0]
  });
});
