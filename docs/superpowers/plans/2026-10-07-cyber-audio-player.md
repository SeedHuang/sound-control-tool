# CP2077 音频播放器 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 自研 CP2077 风格音频播放器组件（曲线波形兼任进度条），替换项目全部 3 处原生 `<audio>` 播放面。

**Architecture:** 前端「单例播放引擎（模块级唯一媒体元素 + 订阅）」+「Canvas 曲线波形子组件」+「播放器外壳组件」；服务端新增「按成品寻址的波形峰值」链路（复用素材链路的三条纯函数）。

**Tech Stack:** Umi 4 (`@umijs/max`) + antd 5.21 + React 18 + TypeScript；Fastify 5 + node:sqlite（服务端）；样式为**纯 CSS/内联 style**（不引入 less / styled-components）。

**Spec:** `docs/superpowers/specs/2026-10-07-cyber-audio-player-design.md`

## Global Constraints

- **禁止任何 git 写操作**（改动留工作树，由用户提交）
- 服务端测试**必须用 `npm test`**（不是 `npx vitest run` —— 后者缺 `--experimental-sqlite`，会让 23 个文件加载失败）
- 每步编辑后立即 `pnpm -r run typecheck`（web 无单测，typecheck + build 是第一道关）
- 失败路径必须 `pushLog`（否则用户看到的「失败：」是空的）
- `execFile` 用**三参回调**，stderr 永远记下来（仓库铁律）
- 删除/写入接口的 IO 语义：删文件失败**不让接口失败**（DB 行删了即达「删了」语义）
- 色值只用既有令牌：`cyberColors`（`@/setup/theme`）；切角只用 `var(--cyber-clip)`
- **不引入新依赖**（引擎用 React 18 内建 `useSyncExternalStore`；图标用已有 `@ant-design/icons`）
- 严禁改动：视频行（`<video controls>`）、`WorkPreview` 的三条既有纪律（单实例/移开即卸载/起播被拒回退静音 —— **只改互斥一处**）

---

### Task 1: 服务端 · 成品波形纯函数与生成器

**Files:**
- Modify: `server/src/ffmpeg/derived-args.ts`（追加 3 个导出）
- Modify: `server/src/media/wave-peaks.ts`（`buildWavePeakJson` 加可选 `sig`；追加 `ensureAudioWavePeaks` 与局部文件名助手）
- Test: `server/src/media/wave-peaks.test.ts`（追加）；`server/src/ffmpeg/derived-args.test.ts`（追加）

**Interfaces:**
- Consumes: 既有 `wavePeakArgs` / `parseRmsStderr` / `tail` / `probeDurationFor` / `srcIdentityOf` / `resolveFfmpegPath` / `WavePeakResult`
- Produces:
  - `AUDIO_WAVE_TARGET_POINTS: number`（=1200）
  - `waveaudioShapeSig(): string`
  - `audioWaveNsamples(durationSec: number): number`
  - `ensureAudioWavePeaks(o: { audioId: number; audioPath: string; derivedDir: string; tempDir: string; db: DB; durationSec?: number; probe?: typeof probeDuration; doExec?: ExecLike; resolveFfmpeg?: (db: DB) => Promise<string | null> }): Promise<WavePeakResult>`
  - 产物文件名：`waveaudio-<audioId>.json`

- [ ] **Step 1: 写失败测试（`derived-args.test.ts` 追加）**

```ts
describe('成品波形参数（音频播放器用）', () => {
  it('audioWaveNsamples：按时长反推窗口，恒落在 [1,48000]', () => {
    expect(audioWaveNsamples(30)).toBe(1200);   // 30*48000/1200
    expect(audioWaveNsamples(10)).toBe(400);
    expect(audioWaveNsamples(3600)).toBe(48000); // 超长夹到上界
    expect(audioWaveNsamples(0.1)).toBe(4);      // 极短仍有窗口
  });
  it('audioWaveNsamples：非正/非法时长抛错（不得静默退化）', () => {
    expect(() => audioWaveNsamples(0)).toThrow();
    expect(() => audioWaveNsamples(Number.NaN)).toThrow();
  });
  it('waveaudioShapeSig：含 schema 版本与目标点数（改点数 → 签名变 → 老缓存失效）', () => {
    expect(waveaudioShapeSig()).toContain(`v${FILM_META_V}`);
    expect(waveaudioShapeSig()).toContain(`points=${AUDIO_WAVE_TARGET_POINTS}`);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server; npm test -- src/ffmpeg/derived-args.test.ts`
Expected: FAIL —— `audioWaveNsamples is not a function`

- [ ] **Step 3: 实现（`derived-args.ts` 追加）**

```ts
/**
 * 成品波形（音频播放器用）的目标点数：不论成品多长都画这么多点，保证波形密度稳定。
 * 为什么不能用素材链路的 WAVE_NSAMPLES[0]=48000：那是「约 1 点/秒」，
 * 21 分钟的片子合适，但一条 10 秒的成品只能得到 10 个点 —— 画不出波形。
 */
export const AUDIO_WAVE_TARGET_POINTS = 1200;

/** 成品波形形状签名：schema 版本 + 目标点数。改点数即自动判老缓存失效。 */
export function waveaudioShapeSig(): string {
  return `v${FILM_META_V}|points=${AUDIO_WAVE_TARGET_POINTS}`;
}

/**
 * 成品波形的 asetnsamples 窗口：按目标点数反推（时长越短窗口越小）。
 * 夹在 [1, 48000]：极小片段不至窗口 0（除零/空产物），超长片段不超过素材链路的窗口上界。
 * 时长非法 → 抛错（与 filmstripVfFor 同口径：宁可明确失败，不可静默出一张骗人的图）。
 */
export function audioWaveNsamples(durationSec: number): number {
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    throw new RangeError(`audioWaveNsamples 需要已知的正时长（收到 ${String(durationSec)}）`);
  }
  const n = Math.round((durationSec * 48000) / AUDIO_WAVE_TARGET_POINTS);
  return Math.min(48000, Math.max(1, n));
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd server; npm test -- src/ffmpeg/derived-args.test.ts`
Expected: PASS

- [ ] **Step 5: 写失败测试（`wave-peaks.test.ts` 追加）**

```ts
describe('ensureAudioWavePeaks（成品波形）', () => {
  it('生成：产物名 waveaudio-<id>.json，points 来自 stderr，stepSec 用实际点数反推', async () => {
    const fn = execStderrStub(rmsStderr([-20, -30, -25]));
    const r = await ensureAudioWavePeaks({
      audioId: 7, audioPath: 'a.mp3', derivedDir, tempDir, db, durationSec: 30,
      doExec: fn.fn, resolveFfmpeg: resolveOk,
    });
    expect(r.ok).toBe(true);
    expect(existsSync(join(derivedDir, 'waveaudio-7.json'))).toBe(true);
    if (r.ok) {
      expect(r.data.points).toEqual([-20, -30, -25]);
      expect(r.data.stepSec).toBeCloseTo(30 / 3);
    }
  });
  it('命中缓存：第二次不调 ffmpeg', async () => {
    const first = execStderrStub(rmsStderr([-20, -30]));
    await ensureAudioWavePeaks({ audioId: 8, audioPath: 'a.mp3', derivedDir, tempDir, db, durationSec: 30, doExec: first.fn, resolveFfmpeg: resolveOk });
    const second = execStderrStub(rmsStderr([-20, -30]));
    const r = await ensureAudioWavePeaks({ audioId: 8, audioPath: 'a.mp3', derivedDir, tempDir, db, durationSec: 30, doExec: second.fn, resolveFfmpeg: resolveOk });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.cached).toBe(true);
    expect(second.calls).toHaveLength(0); // 命中缓存一次 ffmpeg 都不跑
  });
  it('没有 RMS 行 → 明确失败，不落空 JSON（诚实原则）', async () => {
    const fn = execStderrStub('frame:0 pts:0\n'); // 无 RMS 行
    const r = await ensureAudioWavePeaks({ audioId: 9, audioPath: 'a.mp3', derivedDir, tempDir, db, durationSec: 30, doExec: fn.fn, resolveFfmpeg: resolveOk });
    expect(r.ok).toBe(false);
    expect(existsSync(join(derivedDir, 'waveaudio-9.json'))).toBe(false);
  });
  it('时长非法 → PROBE_FAIL，不出产物', async () => {
    const fn = execStderrStub(rmsStderr([-20]));
    const r = await ensureAudioWavePeaks({ audioId: 10, audioPath: 'a.mp3', derivedDir, tempDir, db, durationSec: 0, doExec: fn.fn, resolveFfmpeg: resolveOk });
    expect(r.ok).toBe(false);
    expect(existsSync(join(derivedDir, 'waveaudio-10.json'))).toBe(false);
  });
  it('ffmpeg 未找到 → NO_FFMPEG（该去设置页，不误导）', async () => {
    const fn = execStderrStub(rmsStderr([-20]));
    const r = await ensureAudioWavePeaks({ audioId: 11, audioPath: 'a.mp3', derivedDir, tempDir, db, durationSec: 30, doExec: fn.fn, resolveFfmpeg: async () => null });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('NO_FFMPEG');
  });
});
```

> **落地提示**：`execStderrStub` / `rmsStderr` / `resolveOk` 是本测试文件**已有的**助手（`wave-peaks.test.ts` 顶部，素材链路用例在用），直接用。同时要在文件顶部的 import 行里把 `ensureAudioWavePeaks` 加进 `./wave-peaks.js` 的导入。**不要改动既有用例。**

- [ ] **Step 6: 跑测试确认失败**

Run: `cd server; npm test -- src/media/wave-peaks.test.ts`
Expected: FAIL —— `ensureAudioWavePeaks is not a function`

- [ ] **Step 7: 实现（`wave-peaks.ts`）**

先给 `buildWavePeakJson` 加可选 `sig`（**向后兼容**，素材链路调用处一字不改）：

```ts
/** 拼凭据 JSON。v 由本函数填；sig 缺省按 level 推（素材链路），成品链路显式传 waveaudioShapeSig()。 */
export function buildWavePeakJson(d: { level: FilmLevel; seg: number; t0: number; stepSec: number; points: number[]; sig?: string }): string {
  return JSON.stringify({
    v: FILM_META_V,
    sig: d.sig ?? waveShapeSig(d.level),
    level: d.level, seg: d.seg, t0: d.t0, stepSec: d.stepSec, points: d.points,
  });
}
```

再追加成品链路（放在 `ensureWavePeaks` 之后；导入需补 `AUDIO_WAVE_TARGET_POINTS`/`audioWaveNsamples` 的 `waveaudioShapeSig`）：

```ts
/** 成品波形的产物名（局部助手）：不与 derivedFileName 的派生图 kind 体系混编 ——
 *  它是 JSON 且寻址键是 audioId（素材链路用 importId），混进去会让 DerivedKind 长出无用的分支。 */
const audioWaveFileName = (audioId: number): string => `waveaudio-${audioId}.json`;

/** 命中判定：口径照抄 readPeakIfFresh（文件存在 + 非空 + v 对 + sig 逐字同 + points 非空）。 */
function readAudioPeakIfFresh(path: string): WavePeakData | null {
  try {
    if (statSync(path).size <= 0) return null;
    const o = JSON.parse(readFileSync(path, 'utf8')) as Partial<WavePeakData>;
    if (o === null || typeof o !== 'object') return null;
    if (o.v !== FILM_META_V) return null;
    if (o.sig !== waveaudioShapeSig()) return null;
    if (typeof o.t0 !== 'number' || typeof o.stepSec !== 'number') return null;
    if (!Array.isArray(o.points) || o.points.length === 0) return null;
    if (!o.points.every((p) => typeof p === 'number')) return null;
    return o as WavePeakData;
  } catch { return null; }
}

/**
 * 生成（或命中）**成品**的波形峰值（音频播放器用，整条不分档）。
 *
 * 与素材链路 `ensureWavePeaks` 的两处根本差异（见 spec §6.1）：
 *   ① 寻址键是 audioId（产物 `waveaudio-<id>.json`），不共用 `wavepeak-<importId>` 命名空间（会撞名）；
 *   ② 取样窗口按时长反推（`audioWaveNsamples`），保证短成品也有 ~1200 点。
 *
 * **不做落盘前素材身份复核**：成品内容不可变（重导出会得到新的 audioId），
 * 不存在「同一 key 指向新内容」的换源场景，故无需 classifySrcChange —— 不是漏做。
 */
export async function ensureAudioWavePeaks(o: {
  audioId: number; audioPath: string; derivedDir: string; tempDir: string; db: DB;
  /** 成品时长（来自 audio_items.duration_sec）；不传则内部 `probeDurationFor`（原样透传 code） */
  durationSec?: number;
  probe?: typeof probeDuration;
  doExec?: ExecLike; resolveFfmpeg?: (db: DB) => Promise<string | null>;
}): Promise<WavePeakResult> {
  const dest = join(o.derivedDir, audioWaveFileName(o.audioId));
  const hit = readAudioPeakIfFresh(dest);
  if (hit !== null) {
    pushLog('debug', 'media', `成品波形命中缓存 audio=${o.audioId} points=${hit.points.length}`);
    return { ok: true, data: hit, cached: true };
  }
  const resolve = o.resolveFfmpeg ?? resolveFfmpegPath;
  const bin = await resolve(o.db);
  if (bin === null) {
    pushLog('error', 'media', `成品波形失败：ffmpeg 未找到 audio=${o.audioId}`);
    return { ok: false, code: 'NO_FFMPEG', message: 'ffmpeg 未找到或未配置：请到设置页配置 ffmpeg 路径' };
  }
  let durationSec: number;
  if (o.durationSec !== undefined) {
    if (!Number.isFinite(o.durationSec) || o.durationSec <= 0) {
      pushLog('error', 'media', `成品波形失败：调用方传入的时长非法 audio=${o.audioId} duration=${String(o.durationSec)}`);
      return { ok: false, code: 'PROBE_FAIL', message: '成品信息读取失败，无法生成波形：时长非法' };
    }
    durationSec = o.durationSec;
  } else {
    const pr = await probeDurationFor({ db: o.db, videoPath: o.audioPath, ffmpegPath: bin, probe: o.probe });
    if (!pr.ok) {
      pushLog('error', 'media', `成品波形失败：${pr.code} audio=${o.audioId} msg=${pr.message}`);
      return { ok: false, code: pr.code, message: pr.message };
    }
    durationSec = pr.durationSec;
  }
  const n = audioWaveNsamples(durationSec);
  const args = wavePeakArgs(o.audioPath, null, n); // null = 整条，不加 -ss/-t
  pushLog('info', 'media', `成品波形生成开始 audio=${o.audioId} dur=${durationSec.toFixed(2)}s n=${n}`);
  const doExec = o.doExec ?? execFile;
  const run = await new Promise<{ ok: boolean; stderr: string }>((resolveRun) => {
    doExec(bin, args, { timeout: 120_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, _stdout, stderr) => {
      if (err) {
        const e = err as NodeJS.ErrnoException;
        pushLog('error', 'media', `成品波形 ffmpeg 失败 audio=${o.audioId} code=${e.code ?? '?'} stderr=${tail(stderr ?? '')}`);
        resolveRun({ ok: false, stderr: stderr ?? '' });
        return;
      }
      resolveRun({ ok: true, stderr: stderr ?? '' });
    });
  });
  if (!run.ok) return { ok: false, code: 'FFMPEG_FAIL', message: `波形提取失败：${tail(run.stderr)}` };
  const points = parseRmsStderr(run.stderr);
  if (points.length === 0) {
    pushLog('error', 'media', `成品波形失败：stderr 无 RMS 行 audio=${o.audioId} stderr=${tail(run.stderr)}`);
    return { ok: false, code: 'FFMPEG_FAIL', message: '波形提取失败：ffmpeg 未输出音频统计（成品可能没有音轨）' };
  }
  const stepSec = durationSec / points.length; // 用实际点数反推（同素材链路口径）
  const json = buildWavePeakJson({ level: 0, seg: 0, t0: 0, stepSec, points, sig: waveaudioShapeSig() });
  const uniq = `${Date.now()}-${randomBytes(4).toString('hex')}`;
  const tmp = join(o.tempDir, `waveaudio-${o.audioId}-${uniq}.json`);
  try {
    mkdirSync(o.derivedDir, { recursive: true });
    writeFileSync(tmp, json, 'utf8');
    renameSync(tmp, dest);
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch { /* 尽力清理 */ }
    const msg = e instanceof Error ? e.message : String(e);
    pushLog('error', 'media', `成品波形落盘失败 audio=${o.audioId}: ${msg}`);
    return { ok: false, code: 'FFMPEG_FAIL', message: `波形落盘失败：${msg}` };
  }
  pushLog('info', 'media', `成品波形生成完成 audio=${o.audioId} points=${points.length} stepSec=${stepSec.toFixed(5)}`);
  return { ok: true, data: JSON.parse(json) as WavePeakData, cached: false };
}
```

- [ ] **Step 8: 跑测试确认通过**

Run: `cd server; npm test`
Expected: 全绿（既有 615 + 本任务新增）

---

### Task 2: 服务端 · 路由与删除清理

**Files:**
- Modify: `server/src/ytdlp/ytdlp-routes.ts`（新增路由；`DELETE /api/audio/:id` 追加清缓存）
- Test: `server/src/ytdlp/ytdlp-routes.test.ts`（追加）

**Interfaces:**
- Consumes: Task 1 的 `ensureAudioWavePeaks`；既有 `isAllowedOrigin` / `isAllowedLocalOrigin` / `isLocalPageReferer`（`../http/cors.js`）、`createAudioItemsRepo`、`derivedDirFor`
- Produces: `GET /api/audio/:id/wavepeak` → 200 JSON / 400 / 401 / 404

- [ ] **Step 1: 写失败测试（`ytdlp-routes.test.ts` 追加）**

```ts
describe('GET /api/audio/:id/wavepeak（成品波形）', () => {
  it('非正整数 id → 404', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/audio/abc/wavepeak?token=tok2' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/audio/0/wavepeak?token=tok2' })).statusCode).toBe(404);
  });
  it('成品不存在 → 404', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/audio/999/wavepeak?token=tok2' })).statusCode).toBe(404);
  });
  it('外站来源 + 无合法 token → 401（鉴权三件套与素材峰值一致）', async () => {
    const id = seedAudio(); // 见下方说明
    const res = await app.inject({ method: 'GET', url: `/api/audio/${id}/wavepeak`, headers: { origin: 'https://evil.example' } });
    expect(res.statusCode).toBe(401);
  });
  it('本机 referer 放行且成功 → 200 application/json', async () => {
    const id = seedAudio();
    const res = await app.inject({ method: 'GET', url: `/api/audio/${id}/wavepeak`, headers: { referer: 'http://localhost:8000/' } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
  });
  it('删除成品 → 波形缓存文件一并清掉', async () => {
    const id = seedAudio();
    await app.inject({ method: 'GET', url: `/api/audio/${id}/wavepeak?token=tok2` });
    await app.inject({ method: 'DELETE', url: `/api/audio/${id}?token=tok2` });
    expect(existsSync(join(derivedDir, `waveaudio-${id}.json`))).toBe(false);
  });
});
```

> **落地提示**：`seedAudio()` 用本文件既有方式造一条 `audio_items`（写入真实临时文件）并返回 id；`deriveDir` 从测试的 deps 推导（本文件已有 mediaDir/tempDir 的构造）。`ensureAudioWavePeaks` 需按本文件既有做法 **vi.mock** 或注入成功桩，避免真跑 ffmpeg。**不要改动既有用例。**

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server; npm test -- src/ytdlp/ytdlp-routes.test.ts`
Expected: FAIL —— 404/路由不存在

- [ ] **Step 3: 实现路由（`ytdlp-routes.ts`，紧邻 `GET /api/audio/:id/file` 之后）**

```ts
  // 成品波形峰值（音频播放器用）：整条、不分档。鉴权照抄同文件 `/api/audio/:id/file` 的三件套写法。
  app.get('/api/audio/:id/wavepeak', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const q = (req.query ?? {}) as { token?: string };
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
    if (q.token !== token && !isAllowedLocalOrigin(origin) && !isLocalPageReferer(req.headers.referer)) {
      pushLog('info', 'audio.wave', `成品波形 401 id=${id} origin=${origin || '(none)'} token=${q.token ? 'present' : 'missing'}`);
      return reply.code(401).send({ ok: false, error: { code: 'UNAUTHORIZED', message: 'token 无效', next: '' } });
    }
    if (!Number.isInteger(id) || id <= 0) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: '音频不存在', next: '' } });
    const item = audioRepo.get(id);
    if (!item) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: '音频不存在', next: '' } });
    if (!existsSync(item.file_path)) return reply.code(404).send({ ok: false, error: { code: 'FILE_MISSING', message: '文件已丢失', next: '' } });
    const r = await ensureAudioWavePeaks({
      audioId: id, audioPath: item.file_path,
      derivedDir: derivedDirFor(deps.mediaDir), tempDir: deps.tempDir, db,
      durationSec: item.duration_sec ?? undefined,
    });
    if (!r.ok) {
      pushLog('error', 'audio.wave', `成品波形失败 id=${id} code=${r.code} msg=${r.message}`);
      return reply.code(r.code === 'NO_FFMPEG' ? 500 : 404).send({ ok: false, error: { code: r.code, message: r.message, next: '' } });
    }
    reply.header('content-type', 'application/json; charset=utf-8').header('cache-control', 'no-store');
    return reply.send(r.data);
  });
```

> **落地提示**：`token` / `audioRepo` / `isAllowedLocalOrigin` / `isLocalPageReferer` / `existsSync` / `pushLog` / `derivedDirFor` 都已在**同一文件同一作用域**里（`/api/audio/:id/file` 与 `DELETE /api/audio/:id` 正在用它们），无需新增 import。位置：紧邻 `GET /api/audio/:id/file` 之后、`DELETE /api/audio/:id` 之前。

- [ ] **Step 4: 实现删除清理（同一文件 `DELETE /api/audio/:id` 内追加）**

```ts
    // 波形缓存随成品一起清：删失败不让接口失败（DB 行删了即达「删了」语义）
    try {
      rmSync(join(derivedDirFor(deps.mediaDir), `waveaudio-${id}.json`), { force: true });
    } catch (e) {
      pushLog('info', 'audio.delete', `清成品波形缓存失败 id=${id}: ${(e as Error).message}`);
    }
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd server; npm test`
Expected: 全绿

---

### Task 3: 前端 · 播放引擎与互斥注册表

**Files:**
- Create: `web/src/silence.ts`
- Create: `web/src/audio-player.ts`

**Interfaces:**
- Produces（`@/silence`）：`registerSource(pause: () => void): () => void`、`silenceOthers(self: () => void): void`
- Produces（`@/audio-player`）：
  ```ts
  type PlayerState = { audioId: number|null; playing: boolean; loading: boolean; duration: number;
                       volume: number; muted: boolean; rate: number; error: string|null };
  toggle(audioId: number, src: string): void
  stop(): void
  seek(sec: number): void
  setVolume(v: number): void
  toggleMute(): void
  setRate(r: number): void
  subscribe(cb: () => void): () => void
  getSnapshot(): PlayerState
  getTime(): number
  onTime(cb: (t: number) => void): () => void   // 高频：播放位置（刻意不进 store，防全列表重渲染）
  initFromSettings(): void                      // 启动时读持久化的总开关与音量（页面挂载时调一次）
  ```

- [ ] **Step 1: 创建 `web/src/silence.ts`**

```ts
// 「谁在出声」注册表 —— 保证同一时刻只有一路音频在响。
// 存在理由：单例播放引擎只覆盖「播放器自己」，而 WorkPreview 的 hover 预览会另起媒体元素。
// 两者若各播各的会重叠出声（听感混乱 + 双份解码）。
const sources = new Set<() => void>();

/** 注册一个"能出声的源"，返回注销函数（组件卸载时调用）。 */
export function registerSource(pause: () => void): () => void {
  sources.add(pause);
  return () => { sources.delete(pause); };
}

/** 停掉除 self 外的所有源（self = 即将出声的那个 pause 函数）。 */
export function silenceOthers(self: () => void): void {
  for (const p of sources) {
    if (p !== self) { try { p(); } catch { /* 单个源出错不影响其它 */ } }
  }
}
```

- [ ] **Step 2: 创建 `web/src/audio-player.ts`**

```ts
// 单例播放引擎：全应用**唯一**的音频媒体元素 + 一份播放状态。
// 为什么单例（spec D4）：① 全局单实例纪律需要跨页面互斥；② 顶栏「预览音频」按钮要复用同一实例——
//   「谁在播」必须只有一个真相，否则按钮与列表行会各持一份、必然漂移。
// 订阅走 React 18 内建 useSyncExternalStore，不引状态管理库。
import { audioFileUrl, getPreviewMuted, getSettings, logFe, putSettings } from '@/api';
import { silenceOthers } from '@/silence';

export type PlayerState = {
  audioId: number | null;
  playing: boolean;
  loading: boolean;
  duration: number;
  volume: number;
  muted: boolean;
  rate: number;
  error: string | null;
};

const INITIAL: PlayerState = {
  audioId: null, playing: false, loading: false, duration: 0,
  volume: 0.8, muted: true, rate: 1, error: null,
};

let el: HTMLAudioElement | null = null;
let state: PlayerState = INITIAL;
const listeners = new Set<() => void>();
const timeListeners = new Set<(t: number) => void>();

function emit(): void { for (const l of listeners) l(); }
function set(patch: Partial<PlayerState>): void { state = { ...state, ...patch }; emit(); }

/** 播放器侧的音量设置键（静音复用既有的 studio_preview_muted，不新建第二份状态）。 */
const VOLUME_KEY = 'studio_player_volume';

function ensureEl(): HTMLAudioElement {
  if (el !== null) return el;
  const a = new Audio();
  a.preload = 'metadata';
  a.addEventListener('loadedmetadata', () => set({ duration: Number.isFinite(a.duration) ? a.duration : 0 }));
  a.addEventListener('play', () => set({ playing: true, loading: false }));
  a.addEventListener('pause', () => set({ playing: false }));
  a.addEventListener('ended', () => { set({ playing: false }); seek(0); });
  a.addEventListener('timeupdate', () => { for (const cb of timeListeners) cb(a.currentTime); });
  a.addEventListener('error', () => {
    logFe('error', `播放器加载失败 id=${state.audioId ?? '(none)'}`);
    set({ playing: false, loading: false, error: '音频加载失败' });
  });
  el = a;
  return a;
}

/** 页面启动时读持久化的总开关与音量（失败不阻塞——用默认值继续）。 */
export function initFromSettings(): void {
  void getPreviewMuted().then((m) => set({ muted: m })).catch(() => { /* 用默认 */ });
  void getSettings()
    .then((s) => {
      const v = Number(s[VOLUME_KEY]);
      if (Number.isFinite(v) && v >= 0 && v <= 1) set({ volume: v });
      applyVolume();
    })
    .catch(() => { /* 用默认 */ });
}

function applyVolume(): void {
  if (el === null) return;
  el.volume = state.volume;
  el.muted = state.muted;
  el.playbackRate = state.rate;
}

/** 播/停切换：同一 id → 切；不同 id → 装载并播（先停旧的 → 全局单实例）。 */
export function toggle(audioId: number, src: string): void {
  const a = ensureEl();
  if (state.audioId === audioId && !a.paused) { a.pause(); return; }
  silenceOthers(() => a.pause()); // 让 hover 预览等其它源先停
  if (state.audioId !== audioId || a.src !== src) {
    a.src = src;
    set({ audioId, duration: 0, error: null });
  }
  applyVolume();
  set({ loading: true });
  logFe('info', `播放器起播 id=${audioId}`);
  void a.play().then(() => set({ loading: false })).catch((e: unknown) => {
    logFe('error', `播放器起播失败 id=${audioId}: ${(e as Error).message}`);
    set({ loading: false, playing: false, error: '起播失败' });
  });
}

export function stop(): void {
  if (el !== null) el.pause();
  set({ audioId: null, playing: false, loading: false, duration: 0, error: null });
}

export function seek(sec: number): void {
  if (el === null) return;
  const t = Math.max(0, Math.min(sec, Number.isFinite(el.duration) ? el.duration : sec));
  try { el.currentTime = t; } catch { /* 元数据未就绪时忽略 */ }
  for (const cb of timeListeners) cb(t);
}

export function setVolume(v: number): void {
  const nv = Math.max(0, Math.min(1, v));
  set({ volume: nv, muted: nv === 0 ? true : state.muted });
  applyVolume();
  void putSettings({ [VOLUME_KEY]: String(nv) }).catch((e: Error) => logFe('error', `保存播放器音量失败: ${e.message}`));
}

/** 静音开关 = 全局总开关（与工具栏那个同一份状态，spec D15）。 */
export function toggleMute(): void {
  const next = !state.muted;
  set({ muted: next });
  applyVolume();
  void setPreviewMutedImpl(next);
}

async function setPreviewMutedImpl(m: boolean): Promise<void> {
  try {
    const { setPreviewMuted } = await import('@/api');
    await setPreviewMuted(m);
  } catch (e) { logFe('error', `保存声音开关失败: ${(e as Error).message}`); }
}

export function setRate(r: number): void {
  set({ rate: r });
  applyVolume();
}

export function subscribe(cb: () => void): () => void { listeners.add(cb); return () => { listeners.delete(cb); }; }
export function getSnapshot(): PlayerState { return state; }
export function getTime(): number { return el?.currentTime ?? 0; }
export function onTime(cb: (t: number) => void): () => void { timeListeners.add(cb); return () => { timeListeners.delete(cb); }; }
```

> **落地注意**：若 `@/api` 里 `setPreviewMuted` 已是静态导入（非循环依赖），把上面的动态 `import` 改成顶部静态导入即可 —— 先试静态，报循环依赖再退回动态。`initFromSettings` 的调用点放 Task 5 的页面里。

- [ ] **Step 3: 验证**

Run: `pnpm -r run typecheck`
Expected: 0 错

---

### Task 4: 前端 · 曲线波形子组件

**Files:**
- Create: `web/src/components/PlayerWaveform.tsx`

**Interfaces:**
- Consumes（`@/audio-player`）：`getTime`、`onTime`
- Produces：`<PlayerWaveform points: number[] | null; duration: number; playing: boolean; progress: number; onSeek: (sec: number) => void; height?: number />`

- [ ] **Step 1: 创建组件**

要点（写进代码注释）：
1. **曲线而非柱状**：把峰值数组按画布宽度重采样，用 `quadraticCurveTo` 连成平滑线（相邻点取中点做控制点）。
2. **已播/未播分段**：以 `progress`（0..1）对应的 x 为界 —— 已播段 `#5EF6FF` 线宽 2.2 + 背景带 `rgba(94,246,255,.14)`；未播段 `rgba(94,246,255,.28)` 线宽 2。
3. **播放头**：`#F75049` 宽 1.6，贯穿全高。
4. **刻度**：底部主刻度（`rgba(255,255,255,.22)`）+ 次刻度（`.10`），中线 `rgba(255,255,255,.07)`。
5. **devicePixelRatio**：照抄 `TimelineWave.tsx` 的既有做法（`canvas.width = w*dpr` + `ctx.setTransform(dpr,0,0,dpr,0,0)`）。
6. **高频更新走 rAF，不走 store**：`playing` 时起 `requestAnimationFrame` 循环读 `getTime()` 重绘；暂停时订阅 `onTime` 重绘一次。**卸载时取消 rAF**。
7. **峰值未就绪/失败**：只画中线 + 刻度（静态基线），**不画假波形**。

```tsx
// 骨架（实现时补全绘制细节，遵守上面 7 条）
export default function PlayerWaveform(props: Props): JSX.Element { /* ... */ }
```

- [ ] **Step 2: 验证**

Run: `pnpm --filter @sct/web run typecheck`
Expected: 0 错

---

### Task 5: 前端 · 播放器外壳组件

**Files:**
- Create: `web/src/components/CyberAudioPlayer.tsx`
- Create: `web/src/components/CyberAudioPlayer.css`

**Interfaces:**
- Consumes: Task 3 引擎（`toggle`/`seek`/`setVolume`/`toggleMute`/`setRate`/`subscribe`/`getSnapshot`/`onTime`）、Task 4 `PlayerWaveform`、`@/api` 的 `audioWavepeakUrl`、`@/setup/theme` 的 `cyberColors`/`cyberFontStack`
- Produces：`<CyberAudioPlayer audioId: number; src: string; durationHint?: number | null />`

- [ ] **Step 1: 加 `audioWavepeakUrl`（`web/src/api.ts`）**

```ts
/** 成品波形峰值（整条、不分档、无 rev）：成品内容不可变（重导出得到新 id），无需 cache-buster；服务端回 no-store。 */
export function audioWavepeakUrl(audioId: number): string {
  const token = apiToken();
  return `${API_BASE}/api/audio/${audioId}/wavepeak?token=${encodeURIComponent(token ?? '')}`;
}
```

- [ ] **Step 2: 创建 `CyberAudioPlayer.css`**（照 spec §9 的视觉规格；播放键/时间码/音量/倍速样式）

- [ ] **Step 3: 创建 `CyberAudioPlayer.tsx`**

要点：
- `useSyncExternalStore(subscribe, getSnapshot)` 取状态；`state.audioId === audioId` 才算「当前行」
- 播放键：`<Button className="cyber-play-btn">`，图标按 `state.playing ? <PauseOutlined/> : <CaretRightFilled/>` —— **库已在，不引新依赖**（D14）
- 波形：`<PlayerWaveform points={pts} duration={dur} playing={isCurrent && state.playing} progress={p} onSeek={(s) => { if (!isCurrent) toggle(audioId, src); seek(s); }} />`
- 峰值：`useEffect` 里 `fetch(audioWavepeakUrl(audioId))` → `points`；失败只记 `logFe` + 保持静态基线（**不弹错**）
- 时间码：`durationHint ?? state.duration` 作总长；当前时间**只订阅 `onTime` 并在「整数秒变化时」才 setState**（≤1 次/秒重渲染，见账本 Ruling 3）——**不要**每帧读 `getTime()` 进 state
- 音量：喇叭图标 + 滑块；静音态划掉喇叭并降为 `textMuted`
- 倍速：`1x` 文本按钮，点击在 `[0.5,1,1.5,2]` 间循环
- 键盘：`useEffect` 挂 `keydown`，**焦点在 `input`/`textarea`/`[contenteditable]` 时直接 return**；空格→`toggle`，←/→→`seek(±5)`；卸载解绑
- **静音轻提示**：静音态点播放 → 组件内浮现一行「声音已关闭 · 点喇叭开启」（3s 后消失），**不自动改设置**

- [ ] **Step 4: 验证**

Run: `pnpm -r run typecheck; pnpm --filter @sct/web run build`
Expected: typecheck 0 错；build EXIT=0

---

### Task 6: 前端 · 落地 3 处播放面与总开关

**Files:**
- Modify: `web/src/pages/studio.tsx`
- Modify: `web/src/pages/studio-detail.tsx`
- Modify: `web/src/components/WorkPreview.tsx`（**仅互斥一处**）

- [ ] **Step 1: `studio.tsx` 孤儿成品行接入**

`<audio controls src={audioFileUrl(it.id)} style={{...}} />` → `<CyberAudioPlayer audioId={it.id} src={audioFileUrl(it.id)} durationHint={it.duration_sec} />`

- [ ] **Step 2: `studio.tsx` 总开关升级**

- Tooltip `预览声音：${muted ? '关' : '开'}` → `声音：${muted ? '关' : '开'}`
- 页面挂载时调一次引擎的 `initFromSettings()`
- `onToggleMute` 改为同时写引擎：`setMuted(next)`（本地 state 保留给 `WorkPreview` 的 `muted` prop）+ `engineToggleMuteIfNeeded(next)`；**两处必须同源**，实现上以「引擎为权威、页面 state 订阅引擎」为准（避免两份真相）

- [ ] **Step 3: `studio-detail.tsx` 成品行接入（音频分支）**

```tsx
) : (
  <CyberAudioPlayer audioId={it.id} src={productSrcs.get(it.id)!} durationHint={it.duration_sec} />
)}
```
视频分支（`(it.media_kind ?? 'audio') === 'video'`）**保持原生 `<video controls>` 一字不动**。

- [ ] **Step 4: `studio-detail.tsx` 顶栏预览按钮改走引擎**

- 删除隐藏 `<audio ref={previewAudioRef}>` 与 `previewAudioRef`
- `onPreviewAudio` → `toggle(latestProduct.id, audioFileUrl(latestProduct.id))`
- `previewingId` 派生自引擎：`state.audioId === latestProduct?.id && state.playing`
- `stopPreview` → 引擎 `stop()`

- [ ] **Step 5: `WorkPreview.tsx` 接互斥（唯一改动）**

把模块级 `currentEl` 的互斥逻辑接到 `silence.ts`：起播前 `silenceOthers(() => el.pause())`，并把 `() => el.pause()` 注册进 `registerSource`（卸载注销）。**三条既有纪律（单实例/移开即卸载/起播被拒回退静音）一字不改。**

- [ ] **Step 6: 验证**

Run: `pnpm -r run typecheck; pnpm --filter @sct/web run build`
Expected: 0 错 / EXIT=0

---

### Task 7: 文档回扫与全量验证

**Files:**
- Modify: `docs/superpowers/specs/2026-10-07-cyber-audio-player-design.md`（状态行 → 已实施）
- Modify: `docs/after/cyberpunk-ui-visual-acceptance-open-decisions.md`（追加播放器待目验项）

- [ ] **Step 1: 全量验证**

```powershell
pnpm -r run typecheck
pnpm --filter @sct/web run build
pnpm --filter @sct/desktop run build
cd server; npm test
```
Expected: 三包 0 错；web/desktop EXIT=0；server 全绿

- [ ] **Step 2: 残留扫描**

```powershell
Select-String -Path "web/src/**/*.tsx" -Pattern "<audio controls|previewAudioRef"
```
Expected: 无命中（3 处原生音频播放面已全部替换）

- [ ] **Step 3: spec 状态行改「已实施」+ 写实施结果节**（新增/改动文件、验证数字与取数命令、偏差记录）

- [ ] **Step 4: 待人工目验项写入 `docs/after/`**（web 无单测，观感与交互只能人验）：
  单实例互斥（播 A 再播 B 应停 A；hover 预览与播放器互斥）、顶栏按钮与列表行联动、键盘快捷键不抢输入、倍速、拖动定位、波形与真实音频对得上、静音轻提示、视频行未回归

---

## Self-Review

**Spec coverage：**
- D1 三处播放面 → T6 ✓ ｜ D2 全局单实例 → T3（引擎）+ T6 ✓
- D3 顶栏按钮复用 → T6 Step 4 ✓ ｜ D4 单例架构 → T3 ✓
- D5 单行布局 → T5 ✓ ｜ D6 无标题 → T5 ✓
- D7 曲线兼任进度条 → T4 ✓ ｜ D8 青色已播带 → T4（§9 值）✓
- D9 真实峰值 → T1/T2（服务端）+ T5（fetch）✓ ｜ D10 播放键 → T5 ✓
- D11 键盘 → T5 ✓ ｜ D12 倍速 → T5 ✓ ｜ D13 刻度 → T4 ✓ ｜ D14 不引新库 → 全局约束 + T5 ✓
- D15 共享总开关 → T6 Step 2 ✓ ｜ D16 键复用 + 音量新键 → T3（`VOLUME_KEY`）+ T6 ✓
- spec §6.4 删除清缓存 → T2 Step 4 ✓ ｜ §4.3 互斥 → T3（silence）+ T6 Step 5 ✓
- §11 不做清单 → 无任务（正确）✓

**Placeholder scan：** 无 TBD/TODO。T4 的绘制细节以「7 条要点」给出（不是「照上面写」），T2/T1 的测试助手明确指向文件既有实现并禁止改动既有用例。

**Type consistency：** `PlayerState` 字段在 T3 定义、T5 消费一致；`toggle(audioId, src)` 在 T3 定义、T6 调用一致；`ensureAudioWavePeaks` 的入参名在 T1 定义、T2 调用一致；`waveaudioShapeSig` 在 T1 定义并同时用于生产与命中判定（**单一来源**）；`audioWavepeakUrl` 在 T5 Step 1 定义、T5 Step 3 消费。
