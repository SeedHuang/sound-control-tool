import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from './index.js';
import { openDatabase } from './db/index.js';
import { initSchema } from './db/schema.js';
import { createImportsRepo } from './db/repo/imports.js';
import { createSettingsRepo } from './db/repo/settings.js';
import { SETTINGS_KEYS } from './settings-keys.js';

const cleanup: Array<() => void> = [];
function tmp(): string {
  const d = mkdtempSync(path.join(tmpdir(), 'sct-cs-'));
  cleanup.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}
afterEach(() => {
  for (const f of cleanup.splice(0)) f();
});

describe('createServer(正式版)', () => {
  it('health 返回 ok 且包含实际端口', async () => {
    const s = await createServer({ port: 7350, dbPath: ':memory:', tempDir: path.join(tmp(), 'tmp') });
    const res = await fetch(`http://127.0.0.1:${s.port}/api/health`);
    const body = (await res.json()) as { ok: boolean; port: number; sqlite: string | null };
    expect(body.ok).toBe(true);
    expect(body.port).toBe(s.port);
    expect(typeof body.sqlite).toBe('string');
    await s.close();
  });

  it('端口被占时自动递增', async () => {
    const s1 = await createServer({ port: 7351, dbPath: ':memory:', tempDir: path.join(tmp(), 't1') });
    const s2 = await createServer({ port: 7351, dbPath: ':memory:', tempDir: path.join(tmp(), 't2') });
    expect(s2.port).toBeGreaterThan(s1.port);
    await s1.close();
    await s2.close();
  });

  it('CORS:带 Origin 的请求被反射;preflight 返回 204', async () => {
    const s = await createServer({ port: 7352, dbPath: ':memory:', tempDir: path.join(tmp(), 't3') });
    const res = await fetch(`http://127.0.0.1:${s.port}/api/health`, {
      headers: { origin: 'http://localhost:8000' },
    });
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:8000');

    const pre = await fetch(`http://127.0.0.1:${s.port}/api/health`, {
      method: 'OPTIONS',
      headers: { origin: 'http://localhost:8000', 'access-control-request-method': 'GET' },
    });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe('http://localhost:8000');
    await s.close();
  });

  it('portFile 写入 {port, pid, token}', async () => {
    const data = tmp();
    const file = path.join(data, 'dev-port');
    const s = await createServer({ port: 7353, dbPath: ':memory:', tempDir: path.join(data, 't4'), portFile: file });
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { port: number; pid: number; token: string };
    expect(parsed.port).toBe(s.port);
    expect(parsed.pid).toBe(process.pid);
    expect(parsed.token).toBe(s.token);
    expect(typeof parsed.token).toBe('string');
    await s.close();
  });

  it('close 后端口释放(可复用)', async () => {
    const s = await createServer({ port: 7354, dbPath: ':memory:', tempDir: path.join(tmp(), 't5') });
    await s.close();
    const s2 = await createServer({ port: 7354, dbPath: ':memory:', tempDir: path.join(tmp(), 't6') });
    expect(s2.port).toBe(7354);
    await s2.close();
  });
});

describe('createServer(D12 API token)', () => {
  it('无 Origin、无 token 访问 /api/settings → 401', async () => {
    const s = await createServer({ port: 7360, dbPath: ':memory:', tempDir: path.join(tmp(), 't10') });
    const res = await fetch(`http://127.0.0.1:${s.port}/api/settings`);
    expect(res.status).toBe(401);
    await s.close();
  });

  it('无 Origin、带正确 x-sct-token 访问 /api/settings → 200', async () => {
    const s = await createServer({ port: 7361, dbPath: ':memory:', tempDir: path.join(tmp(), 't11') });
    const res = await fetch(`http://127.0.0.1:${s.port}/api/settings`, {
      headers: { 'x-sct-token': s.token },
    });
    expect(res.status).toBe(200);
    await s.close();
  });

  it('GET /api/health 无需 token → 200', async () => {
    const s = await createServer({ port: 7362, dbPath: ':memory:', tempDir: path.join(tmp(), 't12') });
    const res = await fetch(`http://127.0.0.1:${s.port}/api/health`);
    expect(res.status).toBe(200);
    await s.close();
  });

  it('Origin 属 localhost 白名单时豁免 token → 200', async () => {
    const s = await createServer({ port: 7363, dbPath: ':memory:', tempDir: path.join(tmp(), 't13') });
    const res = await fetch(`http://127.0.0.1:${s.port}/api/settings`, {
      headers: { origin: 'http://localhost:8000' },
    });
    expect(res.status).toBe(200);
    await s.close();
  });

  it('Origin 非白名单时 401 且不下发 allow-origin', async () => {
    const s = await createServer({ port: 7364, dbPath: ':memory:', tempDir: path.join(tmp(), 't14') });
    const res = await fetch(`http://127.0.0.1:${s.port}/api/settings`, {
      headers: { origin: 'http://evil.example' },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    await s.close();
  });

  it('GET /api/settings 不泄露内部键 health_stamp', async () => {
    const s = await createServer({ port: 7365, dbPath: ':memory:', tempDir: path.join(tmp(), 't15') });
    const res = await fetch(`http://127.0.0.1:${s.port}/api/settings`, {
      headers: { 'x-sct-token': s.token },
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['health_stamp']).toBeUndefined();
    await s.close();
  });

  it('close 幂等:二次调用不抛', async () => {
    const s = await createServer({ port: 7366, dbPath: ':memory:', tempDir: path.join(tmp(), 't16') });
    await s.close();
    await expect(s.close()).resolves.toBeUndefined();
  });

  it('D3:GET /api/jobs/1/events 无 header token、无 Origin、query token 正确 → 到路由(404 job 不存在,非守卫 401)', async () => {
    const s = await createServer({ port: 7367, dbPath: ':memory:', tempDir: path.join(tmp(), 't17') });
    const res = await fetch(`http://127.0.0.1:${s.port}/api/jobs/1/events?token=${s.token}`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('NOT_FOUND');
    await s.close();
  });

  it('D3:GET /api/audio/1/file 无 header token、无 Origin、query token 正确 → 到路由(404 音频不存在,非守卫 401)', async () => {
    const s = await createServer({ port: 7368, dbPath: ':memory:', tempDir: path.join(tmp(), 't18') });
    const res = await fetch(`http://127.0.0.1:${s.port}/api/audio/1/file?token=${s.token}`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('NOT_FOUND');
    await s.close();
  });

  it('D3:query token 错误时 events/audio 由路由返回 401 UNAUTHORIZED(非守卫"缺少或无效的 API token")', async () => {
    const s = await createServer({ port: 7369, dbPath: ':memory:', tempDir: path.join(tmp(), 't19') });
    // 封面(2026-09-29 加):<img> 同样加不了 header —— 守卫必须豁免它,由路由内的 query token/Referer 判定接管。
    // 这条断言就是浏览器实测踩到的那个 401(守卫先拦,路由根本没跑)。
    for (const p of ['/api/jobs/1/events?token=wrong', '/api/audio/1/file?token=wrong', '/api/imports/1/cover?token=wrong']) {
      const res = await fetch(`http://127.0.0.1:${s.port}${p}`);
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error?: { code?: string; message?: string } };
      expect(body.error?.code).toBe('UNAUTHORIZED');
      expect(body.error?.message).not.toBe('缺少或无效的 API token');
    }
    await s.close();
  });

  it('D3:豁免不扩散——/api/audio 列表无 header token、无 Origin 仍被守卫 401', async () => {
    const s = await createServer({ port: 7370, dbPath: ':memory:', tempDir: path.join(tmp(), 't20') });
    const res = await fetch(`http://127.0.0.1:${s.port}/api/audio`);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe('缺少或无效的 API token');
    await s.close();
  });

  // 2026-09-29 浏览器实测后补的端到端用例:<img> 既没有 Origin 也加不了 header,只有 Referer。
  // 它要同时穿过「守卫豁免」+「路由内 Referer 判定」两道关——只挂路由的单测照不出守卫那一段,
  // 而这个缺口正是实测踩到的(封面全 401 → 卡片退纯色)。
  it('封面:本机页面 Referer 能穿过守卫取到本地图;外站 Referer 仍 401', async () => {
    const dir = tmp();
    const dbPath = path.join(dir, 'sct.db');
    const db = openDatabase(dbPath);
    initSchema(db);
    const importId = createImportsRepo(db).upsertByUrl({
      url: 'https://www.bilibili.com/bangumi/play/ss1', title: '凡人修仙传', site: 'bilibili',
      kind: 'playlist', duration_sec: null, entries: null, thumbnail: 'https://t/1.jpg',
    });
    db.close();
    // 封面目录 = dirname(audioDir)/covers = dir/covers(与 createServer 内部算法一致)
    mkdirSync(path.join(dir, 'covers'), { recursive: true });
    writeFileSync(path.join(dir, 'covers', `cover-${importId}.png`), 'PNGDATA');
    const s = await createServer({ port: 7371, dbPath, tempDir: path.join(dir, 'tmp') });
    const ok = await fetch(`http://127.0.0.1:${s.port}/api/imports/${importId}/cover`, { headers: { referer: 'http://localhost:8000/' } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toBe('image/png');
    expect(await ok.text()).toBe('PNGDATA');
    const evil = await fetch(`http://127.0.0.1:${s.port}/api/imports/${importId}/cover`, { headers: { referer: 'https://evil.example/x' } });
    expect(evil.status).toBe(401);
    await s.close();
  });

  // P4-T2 派生图：<img> 同款加不了 header，守卫必须豁免它，由路由内判定接管。
  // 若守卫没豁免，这三种请求都会拿到「缺少或无效的 API token」这一守卫文案 —— 断言 code=UNAUTHORIZED 就证明是路由在答。
  // ⚠️ 名单必须覆盖**全部**派生图地址（2026-10-03 用户实测「切中景/近景胶片带生成失败」的修复）：
  //   漏一个，那个地址就会被守卫在路由之前 401 掉 —— 路由内的 query token 判定根本没机会跑，
  //   症状是「一直失败 + 磁盘零产物」，只看 http 摘要日志只会得到一串 401，定位不到真凶。
  //   所以这里用**四个地址逐一断言**，新增派生图地址时改了守卫就必须同步改这条用例，否则测试会红。
  it('派生图:守卫豁免——?token=wrong 与无 token 均由路由返回 401 UNAUTHORIZED；豁免不扩散到 /api/media 列表', async () => {
    const s = await createServer({ port: 7372, dbPath: ':memory:', tempDir: path.join(tmp(), 't21') });
    for (const p of [
      '/api/media/1/waveform?token=wrong',
      '/api/media/1/filmstrip?token=wrong',
      '/api/media/1/waveform',
      // Spec B 两个新地址（原来漏在名单外 → 全部 401）
      '/api/media/1/filmseg?level=1&seg=0&token=wrong',
      '/api/media/1/filmseg?level=2&seg=0&token=wrong',
      '/api/media/1/wavepeak?level=1&seg=0&token=wrong',
      '/api/media/1/wavepeak?level=0&token=wrong',
    ]) {
      const res = await fetch(`http://127.0.0.1:${s.port}${p}`);
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error?: { code?: string; message?: string } };
      expect(body.error?.code).toBe('UNAUTHORIZED');
      expect(body.error?.message).not.toBe('缺少或无效的 API token');
    }
    // 豁免不扩散：/api/media 列表无 token、无 Origin → 守卫 401（守卫文案，不是路由文案）
    const listed = await fetch(`http://127.0.0.1:${s.port}/api/media`);
    expect(listed.status).toBe(401);
    expect(((await listed.json()) as { error?: string }).error).toBe('缺少或无效的 API token');
    await s.close();
  });

  // ⚠️ 这条是 2026-10-03 真机 401 事故的**直接反面**（high）：
  //   守卫豁免只测了「错 token 仍由路由答 401」—— 那条在守卫**没**豁免时也一样会绿
  //   （守卫自己就回 401，只有文案不同才区分得出来，而断言只查了 code）。
  //   于是「守卫漏了某个地址」这种错**测不出来**：真机上 <img> 请求被守卫吞掉、路由压根没跑，
  //   而全部单测绿。本条正面断言「**带正确 token 时守卫必须放行到路由**」——
  //   素材 1 不存在 → 路由会答 404 NOT_FOUND（路由的文案），若守卫提前拦则是 401 守卫文案。
  //   覆盖全部四个派生图地址：新增地址忘了加进豁免名单，这条立刻红。
  it('派生图:守卫放行到路由——带正确 token 时得到路由的 404（素材不存在），不是守卫的 401', async () => {
    const s = await createServer({ port: 7374, dbPath: ':memory:', tempDir: path.join(tmp(), 't22') });
    for (const p of [
      '/api/media/999/waveform',
      '/api/media/999/filmstrip',
      '/api/media/999/filmseg?level=1&seg=0',
      '/api/media/999/filmseg?level=2&seg=3',
      '/api/media/999/wavepeak?level=0',
      '/api/media/999/wavepeak?level=1&seg=0',
      '/api/media/999/wavepeak?level=2&seg=7',
    ]) {
      // ⚠️ 分隔符必须按「有没有已有 query」选 `?` / `&`：拼成 `...seg=0?token=x` 时第二个 `?`
      //   不是 query 分隔符，token 会粘进 seg 的值里 → 路由收到空 token → 401（写这条用例时真踩到过）。
      const url = `http://127.0.0.1:${s.port}${p}${p.includes('?') ? '&' : '?'}token=${s.token}`;
      const res = await fetch(url);
      expect(`${p} → ${res.status}`).toBe(`${p} → 404`);
      const body = (await res.json()) as { error?: { code?: string } };
      expect(`${p} code=${body.error?.code}`).toBe(`${p} code=NOT_FOUND`);
    }
    await s.close();
  });

  // 成品波形（音频播放器 Task 2）:与新豁免名单同款正面护栏 —— 新地址忘了加进守卫豁免时这条立刻红。
  // 带正确 query token、无 header、无 Origin，守卫须放行到路由；音频 1 不存在 → 路由 404 NOT_FOUND，而非守卫 401。
  it('成品波形:守卫放行到路由——GET /api/audio/1/wavepeak 带正确 query token、无 header/无 Origin → 路由 404（音频不存在），非守卫 401', async () => {
    const s = await createServer({ port: 7375, dbPath: ':memory:', tempDir: path.join(tmp(), 't23') });
    const res = await fetch(`http://127.0.0.1:${s.port}/api/audio/1/wavepeak?token=${s.token}`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('NOT_FOUND');
    await s.close();
  });
});

describe('createServer(下载队列兜底)', () => {
  // 修复轮 1（审查 Important）：startDownload 在「进终态前」就 reject（binProvider / mkdirSync / buildArgs / spawn 同步抛错）时，
  // 队列的 .catch 必须兜底——补日志 + 把 job 置 error。否则 job 永久停在 running，前端 subscribeJob 等不到终态、进度条永久转圈，
  // 且事后无从排障。这里用「把 job1 的输出目录预置成文件」让 startDownload 里的 mkdirSync 抛 EEXIST，稳定复现这条 reject 路径。
  it('startDownload 提前 reject → job 被兜底置 error（不停在 running）且留下 error 日志', async () => {
    const dir = tmp();
    const dbPath = path.join(dir, 'sct.db');
    const tempDir = path.join(dir, 'tmp');
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(path.join(tempDir, 'job1'), 'x'); // 占位文件 → mkdirSync(tempDir/job1) 必抛 EEXIST
    const seed = openDatabase(dbPath);
    initSchema(seed);
    // 显式指定 yt-dlp 路径：probeBin 对显式路径不校验存在性、直接返回，路由才能越过「bin 缺失 → 409」建出 job
    createSettingsRepo(seed).set(SETTINGS_KEYS.binYtdlp, 'C:/nope/yt-dlp.exe');
    seed.close();

    const s = await createServer({ port: 7373, dbPath, tempDir });
    const res = await fetch(`http://127.0.0.1:${s.port}/api/ytdlp/download`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-sct-token': s.token },
      body: JSON.stringify({ url: 'https://a', options: { format: 'mp3' } }),
    });
    expect(res.status).toBe(201);

    // 队列在后台 settle，轮询等它落库（最多 1s）
    let status = '';
    for (let i = 0; i < 50; i++) {
      const poll = openDatabase(dbPath);
      status = ((poll.prepare('SELECT status FROM jobs WHERE id = 1').get() as { status?: string } | undefined)?.status) ?? '';
      poll.close();
      if (status === 'error') break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(status).toBe('error'); // 关键：不是 running（否则前端永久转圈）

    const logs = (await (await fetch(`http://127.0.0.1:${s.port}/api/logs`, { headers: { 'x-sct-token': s.token } })).json()) as {
      logs: Array<{ source: string; message: string }>;
    };
    expect(logs.logs.some((l) => l.source === 'job' && l.message.includes('启动失败(队列层兜底)'))).toBe(true);

    // 修复轮 1（审查 Critical 2）：队列层兜底置 error 必须补终态打点，否则 done 不涨、批次分数与实数对不上。
    // 该 job 创建时已 note('pending')（total=1），兜底置 error 后应为 done=1；它已非在途 → running/queued 从 DB 现数得 0。
    const jb = (await (await fetch(`http://127.0.0.1:${s.port}/api/jobs?active=1`, { headers: { 'x-sct-token': s.token } })).json()) as {
      downloads: { total: number; done: number; running: number; queued: number };
    };
    expect(jb.downloads).toEqual({ total: 1, done: 1, running: 0, queued: 0 });
    await s.close();
  });
});
