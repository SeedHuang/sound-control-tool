# P4 · 剪辑详情页 Implementation Plan（T2–T8）

> **For agentic workers:** 逐任务派实现子代理；每任务先 Read 目标文件磁盘实况（本会话有工具回执污染史）→ 改 → 读回核对 → 跑本节 `Verify`。同文件任务**必须串行**。子代理一律**不 commit**（用户授权制）。
>
> 来源：总计划 `docs/superpowers/plans/2026-09-30-m2-remaining-execution.md` Phase P4 的 T2–T8 细化（T1 开工前实测已完成）。
> 权威 spec：`docs/superpowers/specs/2026-09-30-m2-remaining-p3-p4-p5.md` §2（P4 范围与增补裁决）+ `docs/superpowers/specs/m2-workspace.md` §0.2 D1–D20（尤其 D6/D8/D9/D10/D13/D14/D15/D16/D17/D18/D20）、§0.3 接口契约、§0.4 数据模型、§0.5 P4、§0.7 测试边界、§0.8 验收、§0.9 YAGNI。
> 实测报告（可直接抄的参数模板）：`.superpowers/sdd/2026-09-30-m2-remaining-execution/task-p4-1-report.md`。
> 依赖：P3 已交付（`/api/imports` 带 `has_video/has_project/segment_count/material_entry_index`；`studio.tsx` 媒体卡含编辑入口 `/studio/:importId`）；P1 已建占位页与 `PageHeader`；`clip_projects/clip_segments` 两张空表 + `createClipProjectsRepo`（`clearByImportId/countSegmentsByImportId`）已就位。

## Global Constraints

- 提交：用户授权制——子代理**不 commit**；任务完成即停。
- 每任务第一步 Read 目标文件磁盘实况；每次编辑后**读回核对**；同一文件**禁止并行** `SearchReplace`（并行会互相覆盖，silent-fail）。
- 验证基线：三包 `pnpm typecheck` 0 错 + `pnpm --filter @sct/server test`（基线 **242** 用例，逐任务增量）+ `pnpm --filter @sct/web build`；**web 无测试框架**，前端任务用 typecheck + build + 自查清单。
- 日志（仓库铁律，`.trae/rules/electron-dev-must-log.md`）：本阶段每个新端点/长流程都要有日志，且能在日志页看到。`pushLog` 的 `source` 只能取 `logs.ts:14` 联合类型里的既有值（本阶段新增 **`'project'`**）。
- `execFile` 一律**三参回调** `(err, _stdout, stderr)`，失败必取 stderr 摘要（缺则标 `(无 stderr 输出)`）；**退出码 0 ≠ 有产物**，一律「文件存在且 size>0」判定。
- 删除/写文件语义（`.trae/rules/trae-project-rules.md`）：删磁盘文件失败**不让接口失败**（只记日志，接口仍 200）；写失败（导出产物落库 rename 失败）走 ingest 的回滚链。
- 破坏性按钮（清空剪辑点、清空工程）必须 `Modal.confirm` + `okType:'danger'` + 说清「删什么/连带删什么」。
- 页面标题不得与导航 Tab 重名（T8 裁决）。
- **不做（YAGNI，spec §0.9）**：effects 层、多层多轨、视频画面剪辑/导出、cut 模式、波形缩放、标签、录制、素材自动清理。本阶段只有「一条画轨 + 一条音轨」「只导出音频」。

## 关键决定与本阶段特有约束（brief 第 1–11 条，不重新选型）

1. **派生图目录 = `<数据目录>/derived/`**，文件名 `wave-<importId>.png` / `film-<importId>.png`（固定尺寸，不带尺寸后缀）。
   - ⚠️ **冲突（已在计划内按 brief 第 1 条裁决）**：实测报告 `task-p4-1-report.md` 里举的落盘目录是 `<数据目录>/timeline/`（实测者自拟名），与 spec §0.3/§0.4/D14 的 `derived/` 冲突 → **以 spec 为准，用 `derived/`**。本计划所有代码块已写 `derived`。
2. **日志 source**：`logs.ts` 联合类型**新增 `'project'`**（工程 保存/删除）；派生图用既有 `'media'`；导出 job 用既有 `'job'`。
3. **`onRequest` 守卫豁免**：`/api/media/\d+/(waveform|filmstrip)` 像 `/api/imports/\d+/cover` 那样豁免（`<img>` 带不了 header）；写法照抄 `server/src/index.ts:104`。
4. **素材一变派生图作废（R3-2）**：换集/换清晰度重下、删除素材/删除来源时，一并删 `wave-<id>.png`/`film-<id>.png`；删失败只记日志、不阻断。
5. **PUT 全量替换必须包事务（D18）**；`updated_at` 代码显式写（D13）；段校验 `0 ≤ start_sec`、`end_sec > start_sec`、段数 ≤ 50、label 可空且 ≤ 100；`end_sec` 允许超素材时长；`segments: []` 合法（清空）；来源不存在 → 404 且 `error.next` = 「该来源已被删除，无法保存」。
6. **删除工程幂等**：不存在 → 200 `{ok:true,deleted:0}`；**不删**素材、**不删**已导出音频。
7. **导出（D9/D15/D8）**：`POST /api/projects/:importId/export`，body `{mode:'separate'|'merge', format, quality?, segments:[...]}`；`segments` 必传（不读 DB 工程、不自动保存）；`separate` 每段一条、标题后端拼 `前缀 [mm:ss-mm:ss]`；`merge` concat 成一条、标题 `前缀 [共N段]`；前缀取工程 `name`、无则来源标题；产物走 `ingestDownloadedFile` 且 `sourceType='edit'`（`ingest.ts` 加可选参数，默认 `'download'` 不变）；job kind `ffmpeg_export`；retry 校验素材绝对路径仍在、不在则明确失败；不加判重。
8. **D8 历史纠偏**：`initSchema` 里执行一次 spec §0.4 的 SQL（照抄 SQL 与括号，`LIKE` + 三位分钟 `GLOB`），配单测四例。
9. **前端时间轴**：图宽固定 1600 ↔ `[0, duration]`；`duration` 以 `<video>` 元素的 `duration` 为**唯一真相**（不引入服务端 ffprobe 时长当第二份真相）；预览版本串**拼上 `file_size`**（收口 P2 遗留的 mediaRev 陈旧缓存窗口）；无素材走 D17 空态；「清空所有剪辑点」必须二次确认。
10. **P4-T7 backlog 逐项**（全部落成可执行条目）：`clearByImportId` 包事务、NULL→NULL 保留路径用例、D20 卡片 `aria-pressed`、video 进度尾缀措辞、`source-videos.ts` upsert 注释校正（缺省=清 NULL 非保留）、`imports.ts` 派生列 SQL 去重（`list()` 复用 `derivedJoin`）、「删来源级联」回归用例显式化、`studio.tsx` 默认导出函数名 `LibraryPage` 改名、平铺视图空 query 文案「没有匹配「」的音频」。
11. **不做（YAGNI，spec §0.9）**：effect 层、多层多轨、视频画面剪辑/导出、cut 模式、波形缩放、标签、录制、自动清理。

## 待确认 / 需控制器裁决项（写进计划，避免沉默处理）

> ✅ **2026-09-30 全部已裁决**（Ruling P4-1…P4-5，见 P4 台账 `.superpowers/sdd/2026-09-30-m2-remaining-execution/progress.md`）：C-1 派生图 `cache-control: no-store`；C-2 导出 `separate` 只发一次 `done` 并加可选 `count`；C-3 `deleted` = 删除的工程行数（0/1）；C-4 无残留（现文案「正在登记视频素材,稍等」）；C-5「清空所有剪辑点」= `PUT` 带 `segments: []`。下列条目保留为当时的裁决请求记录。

- **C-1 派生图 Cache-Control**：spec 未定。封面用 `public, max-age=86400`；但派生图**素材一变就作废**、URL 不变 → 若沿用 1 天浏览器缓存，换集后会显示上一集的波形。**建议 `cache-control: no-store`** + 前端拼版本串（`&rev=`）双保险。计划按 `no-store` 落，标 ⚠️。
- **C-2 导出 `separate` 的 SSE 终态**：当前 `emit()` 在 `done` 后**断开连接**，故 N 段无法逐条 emit `done`。**建议**：导出期发 `progress`（第 i/N 段），终态只发**一次** `done`，并给 `DoneEvent` 加可选 `count`（前端提示「已导出 N 段」）。这是对 `web/src/api.ts` 的 `DoneEvent` 的小扩展，标 ⚠️。
- **C-3 `DELETE /api/projects/:importId` 的 `deleted` 语义**：spec 只给 `{ok:true,deleted:0}`。**定为「删除的工程行数（0 或 1）」**（段数另记日志）。计划按此落。
- **C-4 「video 进度尾缀『正在写进剪辑室』」措辞**：`web/src` 全量 grep **未找到**该字符串（现文案 `library.tsx:412` 已是「正在登记视频素材,稍等」）。**✅ 已核查（T7-5）：无残留，不改代码**（Ruling P4-4）。
- **C-5 「清空所有剪辑点」的实现方式**：定为 **`PUT` 带 `segments: []`**（只清点、保留工程与名字，契合 spec「只删本工程的剪辑时间点」）；`DELETE` 路由仍按 spec 提供（幂等），UI 不调用。

---

## Task 2：服务端派生图（waveform / filmstrip）

**Files**
- Create `server/src/ffmpeg/derived-args.ts`（纯参数 builder，可快照断言）
- Create `server/src/media/derived-images.ts`（生成 + 缓存命中 + 原子落盘 + 作废）
- Modify `server/src/media/media-routes.ts`（加两条 GET 路由 + 删素材时作废派生图）
- Modify `server/src/ytdlp/ytdlp-routes.ts`（`finalizeVideoDownload` 落素材后作废派生图；`DELETE /api/imports/:id` 也作废）
- Modify `server/src/index.ts`（`onRequest` 守卫豁免 + 启动时 `mkdirSync(derivedDir)`）
- Test：Create `server/src/ffmpeg/derived-args.test.ts`、`server/src/media/derived-images.test.ts`；Modify `server/src/media/media-routes.test.ts`、`server/src/index.test.ts`

**Interfaces**
```ts
// ffmpeg/derived-args.ts —— 固定尺寸（D14）
export const DERIVED_WAVE_W = 1600;  export const DERIVED_WAVE_H = 120;
export const DERIVED_FILM_W = 1600;  export const DERIVED_FILM_H = 90;
export const DERIVED_FILM_TILES = 12;
export function buildWaveformArgs(videoPath: string, outPath: string): string[];
export function buildFilmstripArgs(videoPath: string, outPath: string, durationSec: number | null): string[];

// media/derived-images.ts
export type DerivedKind = 'wave' | 'film';
export type ExecLike = typeof execFile;
export function derivedDirFor(mediaDir: string): string;            // = join(dirname(mediaDir), 'derived')
export function cachedDerivedPath(derivedDir: string, kind: DerivedKind, importId: number): string | null;
export type DerivedResult =
  | { ok: true; path: string; cached: boolean }
  | { ok: false; code: 'NO_FFMPEG' | 'FFMPEG_FAIL'; message: string };
export async function ensureDerivedImage(o: {
  kind: DerivedKind; importId: number; videoPath: string;
  derivedDir: string; tempDir: string; db: DB;
  doExec?: ExecLike; probe?: typeof probeDuration; resolveFfmpeg?: (db: DB) => Promise<string | null>;
}): Promise<DerivedResult>;
export function invalidateDerived(derivedDir: string, importId: number): void;  // 删两张图，失败只记日志

// media/media-routes.ts 新增路由（都在路由内做 query token / 本机 Origin / 本机 Referer 鉴权，同 /cover）
GET /api/media/:importId/waveform   → 200 image/png（裸流）| 401 | 404 NOT_FOUND | 404 FILE_MISSING | 500
GET /api/media/:importId/filmstrip  → 同上
```

**Steps**

1) `server/src/ffmpeg/derived-args.ts`（参数直接抄实测报告 §「给 P4-T2 的参数建议」，模板 F2/G2 已实测）：

```ts
// 纯函数：派生图 ffmpeg 参数（实测模板见 task-p4-1-report.md §F/§G）。不碰 IO，便于快照断言。
export const DERIVED_WAVE_W = 1600;
export const DERIVED_WAVE_H = 120;
export const DERIVED_FILM_W = 1600;
export const DERIVED_FILM_H = 90;
export const DERIVED_FILM_TILES = 12;

/** 波形底图（实测 F2）：必须显式 s=1600x120 —— 不给尺寸默认 600×240；用输出侧 -s 是「先画后放大」会糊。
 *  colors=<波形色>|<背景色>（0xRRGGBB 或具名色）。源无音轨时 ffmpeg 报 -22，由调用方记 stderr。 */
export function buildWaveformArgs(videoPath: string, outPath: string): string[] {
  return [
    '-y', '-i', videoPath,
    '-filter_complex', 'showwavespic=s=1600x120:colors=0x22d3ee|0x1e293b',
    '-frames:v', '1',
    outPath,
  ];
}

/** 胶片条（实测 G2）：fps=12/T 恰好出 12 帧；每格先按高 90 缩放；tile 12x1 拼一行；末段整体 scale=1600:90 定死宽。
 *  **必须 -frames:v 1**：多出来的帧会变成「第二张图」（无 %d 定名直接报错），只取首格。 */
export function buildFilmstripArgs(videoPath: string, outPath: string, durationSec: number | null): string[] {
  const rawFps = durationSec !== null && durationSec > 0 ? DERIVED_FILM_TILES / durationSec : 1; // 时长未知 → fps=1（只覆盖前 12s）
  const fps = Math.min(Math.max(rawFps, 0.05), 30); // 夹逼：过小→0 帧空产物；过大→无谓解码
  const vf = `fps=${fps.toFixed(6)},scale=-1:90,tile=${DERIVED_FILM_TILES}x1,scale=1600:90`;
  return ['-y', '-i', videoPath, '-an', '-vf', vf, '-frames:v', '1', outPath];
}
```

2) `server/src/media/derived-images.ts`：

```ts
// 派生图（波形/胶片条，spec D6/D14/§0.3）：服务端 ffmpeg 生成固定尺寸 PNG → <数据目录>/derived/，
// 命中判定 = 文件存在且 size>0（零字节残留不算命中）；生成走「临时名 → rename」原子落盘。
import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs'; // 仅在路由用，这里不 import；如 lint 报未用则删
import { mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DB } from '../db/index.js';
import { pushLog } from '../logs.js';
import { probeDuration } from '../ytdlp/ffprobe.js';
import { buildFilmstripArgs, buildWaveformArgs } from '../ffmpeg/derived-args.js';
import { resolveFfmpegPath } from './ffmpeg-path.js';

export type DerivedKind = 'wave' | 'film';
export type ExecLike = typeof execFile;

/** 派生图目录 = <数据目录>/derived（与 media/、covers/ 同父目录）。单一来源：mediaDir=<数据>/media，
 *  父目录即数据目录 —— 路径拼法只此一处，别再各处各写一份。 */
export function derivedDirFor(mediaDir: string): string {
  return join(dirname(mediaDir), 'derived');
}

/** 命中判定：存在且 size>0（D14：中断残留的零字节不算命中） */
export function cachedDerivedPath(derivedDir: string, kind: DerivedKind, importId: number): string | null {
  const p = join(derivedDir, `${kind}-${importId}.png`);
  try { return statSync(p).size > 0 ? p : null; } catch { return null; }
}

export type DerivedResult =
  | { ok: true; path: string; cached: boolean }
  | { ok: false; code: 'NO_FFMPEG' | 'FFMPEG_FAIL'; message: string };

const tail = (s: string | undefined): string => (s ?? '').trim().split('\n').slice(-1)[0]?.slice(0, 200) || '(无 stderr 输出)';
const msgOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export async function ensureDerivedImage(o: {
  kind: DerivedKind; importId: number; videoPath: string;
  derivedDir: string; tempDir: string; db: DB;
  doExec?: ExecLike; probe?: typeof probeDuration; resolveFfmpeg?: (db: DB) => Promise<string | null>;
}): Promise<DerivedResult> {
  const dest = join(o.derivedDir, `${o.kind}-${o.importId}.png`);
  const hit = cachedDerivedPath(o.derivedDir, o.kind, o.importId);
  if (hit !== null) {
    pushLog('debug', 'media', `派生图命中缓存 kind=${o.kind} import=${o.importId}`);
    return { ok: true, path: hit, cached: true };
  }
  const resolve = o.resolveFfmpeg ?? resolveFfmpegPath;
  const ffmpegPath = await resolve(o.db);
  if (ffmpegPath === null) {
    // 与 clip-job 同款：拿不到 ffmpeg 必须明确失败，不得静默（spec D16）
    pushLog('error', 'media', `派生图失败：ffmpeg 未找到 kind=${o.kind} import=${o.importId}`);
    return { ok: false, code: 'NO_FFMPEG', message: 'ffmpeg 未找到或未配置：请到设置页配置 ffmpeg 路径' };
  }
  // 唯一临时名（同 clip-job 的 clip-<jobId>-<ts> 家族）：并发/重入不会互相写坏，前端也不会读到写了一半的图
  const tmp = join(o.tempDir, `${o.kind}-${o.importId}-${Date.now()}.png`);
  let args: string[];
  if (o.kind === 'wave') {
    args = buildWaveformArgs(o.videoPath, tmp);
  } else {
    const probe = o.probe ?? probeDuration;
    const ffprobePath = ffmpegPath.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1'); // 同 clip-job.ts:33/ytdlp getFfprobe 的一行口径
    const durationSec = await probe(ffprobePath, o.videoPath);
    args = buildFilmstripArgs(o.videoPath, tmp, durationSec);
  }
  pushLog('info', 'media', `派生图生成开始 kind=${o.kind} import=${o.importId} bin=${ffmpegPath}`);
  const doExec = o.doExec ?? execFile;
  const run = await new Promise<{ ok: boolean; reason: string }>((resolveRun) => {
    doExec(ffmpegPath, args, { timeout: 120_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, _stdout, stderr) => {
      if (err) {
        const e = err as NodeJS.ErrnoException;
        const t = tail(stderr);
        pushLog('error', 'media', `派生图 ffmpeg 失败 kind=${o.kind} import=${o.importId} code=${e.code ?? '?'} signal=${(e as { signal?: string }).signal ?? '-'} stderr=${t}`);
        resolveRun({ ok: false, reason: `ffmpeg 失败（${e.code ?? '?'}）：${t}` });
        return;
      }
      resolveRun({ ok: true, reason: '' });
    });
  });
  if (!run.ok) { try { rmSync(tmp, { force: true }); } catch { /* 尽力清理 */ } return { ok: false, code: 'FFMPEG_FAIL', message: run.reason }; }
  // 退出码 0 ≠ 有产物（实测 G9）：必须再查文件存在且 size>0
  let size = 0;
  try { size = statSync(tmp).size; } catch { size = 0; }
  if (size <= 0) {
    pushLog('error', 'media', `派生图退出码 0 但无产物 kind=${o.kind} import=${o.importId} out=${tmp}`);
    try { rmSync(tmp, { force: true }); } catch { /* 尽力清理 */ }
    return { ok: false, code: 'FFMPEG_FAIL', message: 'ffmpeg 退出码 0 但未写出产物' };
  }
  try {
    mkdirSync(o.derivedDir, { recursive: true });
    renameSync(tmp, dest); // 同盘 rename 原子
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch { /* 尽力清理 */ }
    pushLog('error', 'media', `派生图落盘失败 kind=${o.kind} import=${o.importId}: ${msgOf(e)}`);
    return { ok: false, code: 'FFMPEG_FAIL', message: `派生图落盘失败：${msgOf(e)}` };
  }
  pushLog('info', 'media', `派生图生成完成 kind=${o.kind} import=${o.importId} path=${dest} bytes=${size}`);
  return { ok: true, path: dest, cached: false };
}

/** 素材一变（换集/换清晰度重下、删素材/删来源）→ 派生图作废（R3-2）。删失败只记日志，不阻断主流程。 */
export function invalidateDerived(derivedDir: string, importId: number): void {
  for (const kind of ['wave', 'film'] as const) {
    try { rmSync(join(derivedDir, `${kind}-${importId}.png`), { force: true }); }
    catch (e) { pushLog('info', 'media', `清派生图失败(忽略) kind=${kind} import=${importId}: ${msgOf(e)}`); }
  }
}
```
> 注：`createReadStream` 若在 derived-images.ts 未使用则**不要** import —— 路由（media-routes.ts）才用它发送裸流。

3) `server/src/media/media-routes.ts`（在 `registerMediaRoutes` 内、`const videosRepo = ...` 之后加派生图路由；`deps` 已在 `const { db, mediaDir, token } = deps;` 解构）：

```ts
// 顶部 import 追加：createReadStream；derived-images
import { createReadStream, existsSync, statSync } from 'node:fs';
import { derivedDirFor, ensureDerivedImage, invalidateDerived, type DerivedKind } from './derived-images.js';

  // —— P4 派生图（波形/胶片条，spec D6/D14/§0.3）——
  const serveDerived = (kind: DerivedKind) => async (req: FastifyRequest, reply: FastifyReply) => {
    const importId = Number((req.params as { importId: string }).importId);
    const q = (req.query ?? {}) as { token?: string };
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
    // 鉴权口径同 /api/media/:id/file 与 /cover：<img> 不带 Origin、加不了 header → 认 query token / 本机 Origin / 本机 Referer
    if (q.token !== token && !isAllowedLocalOrigin(origin) && !isLocalPageReferer(req.headers.referer)) {
      pushLog('error', 'media', `派生图 401 kind=${kind} import=${importId} origin=${origin || '(none)'} token=${q.token ? 'present' : 'missing'} referer=${req.headers.referer ?? '(none)'}`);
      return reply.code(401).send({ ok: false, error: { code: 'UNAUTHORIZED', message: 'token 无效', next: '' } });
    }
    if (!Number.isInteger(importId) || importId <= 0) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: '素材不存在', next: '' } });
    const row = videosRepo.get(importId);
    if (!row) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: '素材不存在', next: '' } });
    if (!existsSync(row.file_path)) {
      // 素材行在但文件被外部删了（同 /file 的两种 404 文案）
      return reply.code(404).send({ ok: false, error: { code: 'FILE_MISSING', message: '素材文件已丢失，请重新下载视频', next: '回到资料库重新下视频' } });
    }
    const r = await ensureDerivedImage({ kind, importId, videoPath: row.file_path, derivedDir: derivedDirFor(mediaDir), tempDir: deps.tempDir, db });
    if (!r.ok) return reply.code(500).send({ ok: false, error: { code: r.code, message: r.message, next: '到设置页检查 ffmpeg 配置' } });
    // 静态派生图走「封面式裸流」，不用 sendFileWithRange（实测 H：<img> 不发 Range，PNG 无 seek 语义）。
    // cache-control no-store：素材一变派生图即作废、URL 不变，长缓存会显示上一集的波形（见 C-1）
    reply.header('content-type', 'image/png').header('cache-control', 'no-store');
    return reply.send(createReadStream(r.path));
  };
  app.get('/api/media/:importId/waveform', serveDerived('wave'));
  app.get('/api/media/:importId/filmstrip', serveDerived('film'));
```
> `FastifyRequest/FastifyReply` 需在顶部 `import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';`（现文件只 import 了 `FastifyInstance`，按实况补）。

并修改 `DELETE /api/media/:importId`，在 `videosRepo.delete(importId);` 之后加：
```ts
    invalidateDerived(derivedDirFor(mediaDir), importId); // R3-2：素材没了 → 派生图一并作废（失败只记日志）
```

4) `server/src/ytdlp/ytdlp-routes.ts`：
- 顶部 import 追加：`import { derivedDirFor, invalidateDerived } from '../media/derived-images.js';`
- `finalizeVideoDownload`：`videosRepo.upsert({...})` 之后、`pushLog(... entry_index ...)` 之前插入：
```ts
      // R3-2：素材变了（换集/换清晰度重下）→ 该来源的派生图作废，下次访问重新生成（别拿上一集的波形冒充）
      invalidateDerived(derivedDirFor(mediaDir), row.id);
```
- `DELETE /api/imports/:id`：在素材删除那一段（`createSourceVideosRepo(db).delete(id);` 之后）加：
```ts
      invalidateDerived(derivedDirFor(mediaDir), id); // 删来源连带删素材 → 派生图作废
```
（若来源无素材行 `v === null`，也补一次 `invalidateDerived(derivedDirFor(mediaDir), id);`，防「素材行已删但派生图残留」。）

5) `server/src/index.ts`：
- 顶部 import：`import { derivedDirFor } from './media/derived-images.js';`
- `mediaDir` 创建之后（`index.ts:66-67`）加：
```ts
    // 派生图目录（spec §0.10）：与 media/、covers/ 同数据目录；启动时确保存在
    mkdirSync(derivedDirFor(mediaDir), { recursive: true });
```
- `onRequest` 守卫（照抄 cover 那条 `index.ts:104`）加：
```ts
      // 派生图同属这一类(<img> 加不了 header)：与 /cover 同款豁免，由路由内 query token/Referer 判定接管（spec D14）
      if (/^\/api\/media\/\d+\/(waveform|filmstrip)$/.test(pathname)) return;
```

**Tests**

`server/src/ffmpeg/derived-args.test.ts`：
- `buildWaveformArgs` 断言等价于 `['-y','-i','v.mp4','-filter_complex','showwavespic=s=1600x120:colors=0x22d3ee|0x1e293b','-frames:v','1','o.png']`。
- `buildFilmstripArgs(v,o,20)` → `-vf` 含 `fps=0.600000`、`tile=12x1`、`scale=1600:90`、`-an`、`-frames:v 1`。
- `buildFilmstripArgs(v,o,0)` 与 `(v,o,null)` → `fps=1.000000`（时长未知退化）。
- `buildFilmstripArgs(v,o,0.3)` → `fps=30.000000`（夹逼上限）；`(v,o,1000)` → `fps≥0.05`（夹逼下限）。

`server/src/media/derived-images.test.ts`（用 `mkdtemp` 真实临时目录 + 注入 `doExec`/`resolveFfmpeg`/`probe`）：
- 命中缓存：先写 `wave-1.png`（内容非空）→ `ensureDerivedImage` 返回 `cached:true`，且**注入的 doExec 未被调用**（`vi.fn()` 断言）。
- 零字节不算命中：写 0 字节 `wave-1.png` → 会真的调 doExec（桩写产物）→ 返回 `cached:false`、`ok:true`。
- `resolveFfmpeg` 返 null → `{ok:false, code:'NO_FFMPEG'}`，不调 doExec。
- doExec 回调 `err`（带 stderr `'Cannot find an unused audio input stream...'`）→ `{ok:false, code:'FFMPEG_FAIL'}`，message 含该 stderr 尾行。
- doExec 回调无 err 但**不写文件** → `{ok:false, code:'FFMPEG_FAIL'}`，message 含「未写出产物」。
- 成功：doExec 桩 `writeFileSync(outPath,'PNG')` → `{ok:true}`，`dest` 存在且 size>0，tmp 已被 rename（临时名不残留）。
- filmstrip：注入 `probe` 返 20 → 断言传给 doExec 的 `args` 里 `-vf` 含 `fps=0.600000`（把 duration 接进参数的链路）。
- `invalidateDerived`：两张图存在 → 删后都不存在；不存在时调用不抛。

`server/src/media/media-routes.test.ts`（追加，注意本文件已在顶部 `vi.mock` —— 需新增 `./derived-images.js` 桩，并把生成的 PNG 写进临时目录）：
```ts
// 追加 mock（与既有 ffmpegStub 同法，用 vi.hoisted 持有目录）
const derivedStub = vi.hoisted(() => ({ dir: '' }));
vi.mock('./derived-images.js', () => ({
  derivedDirFor: (mediaDir: string) => mediaDir,     // 测试里图写哪都行，路由只读回 path
  invalidateDerived: vi.fn(),
  ensureDerivedImage: vi.fn(async (o: { kind: string; importId: number }) => {
    const { writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const p = join(derivedStub.dir, `${o.kind}-${o.importId}.png`);
    writeFileSync(p, 'PNG');
    return { ok: true, path: p, cached: false };
  }),
}));
// beforeEach 里：derivedStub.dir = join(root, 'derived'); mkdirSync(derivedStub.dir, { recursive: true });
```
- `GET /api/media/:id/waveform?token=tok`（有素材 + 文件在）→ 200 且 `content-type` 为 `image/png`；`filmstrip` 同理。
- 有素材行但文件被删 → 404 `FILE_MISSING`。
- 无素材行 → 404 `NOT_FOUND`。
- token 错（`?token=wrong`，无 Origin/Referer）→ 401 `UNAUTHORIZED`（是路由内返回，不是守卫文案）。
- `DELETE /api/media/:id` → 断言 `invalidateDerived` 被调一次（用 mock 的 `vi.mocked(invalidateDerived)`）。

`server/src/index.test.ts`（追加到 `describe('createServer(D12 API token)')`，与 cover 用例同款）：
- `/api/media/1/waveform?token=wrong` 与 `/api/media/1/filmstrip?token=wrong` → 401 且 `error.code === 'UNAUTHORIZED'`、`error.message !== '缺少或无效的 API token'`（证明守卫豁免、路由接管）。
- `/api/media/1/waveform`（无 token、无 Origin）→ 401 `UNAUTHORIZED`（同上，证明不是守卫先拦）。
- 「豁免不扩散」：`/api/media`（列表）无 token、无 Origin → 守卫 401 且 `error === '缺少或无效的 API token'`。

**Verify**
- `pnpm --filter @sct/server test`（用例数应 > 242）
- `pnpm --filter @sct/server typecheck`

**Serial**：本任务独占 `media-routes.ts` / `derived-*.ts`；对 `index.ts` / `ytdlp-routes.ts` 的改动与 T3/T4 冲突 → **T2 → T3 → T4 串行**。

---

## Task 3：剪辑工程 CRUD

**Files**
- Create `server/src/db/tx.ts`（事务 helper）
- Modify `server/src/db/repo/clip-projects.ts`（`list/get/upsert/delete`；D18 事务 + D13 显式 `updated_at`）
- Create `server/src/media/project-routes.ts`（`GET /api/projects`、`GET/PUT/DELETE /api/projects/:importId`）
- Modify `server/src/logs.ts:14`（联合类型加 `'project'`）
- Modify `server/src/index.ts`（注册 `registerProjectRoutes`）
- Test：Create `server/src/db/tx.test.ts`、`server/src/media/project-routes.test.ts`；Modify `server/src/db/repo/clip-projects.test.ts`

**Interfaces**
```ts
// db/tx.ts
export function inTransaction<T>(db: DB, fn: () => T): T;   // BEGIN/COMMIT/ROLLBACK

// db/repo/clip-projects.ts（在既有 clearByImportId/countSegmentsByImportId 基础上追加）
export interface ClipSegmentRow { id: number; start_sec: number; end_sec: number; label: string | null; sort_order: number }
export interface ClipProjectSummary { import_id: number; name: string | null; updated_at: string; segment_count: number }
export interface ClipProjectDetail { import_id: number; name: string | null; updated_at: string; segments: ClipSegmentRow[] }
export interface SegmentInput { start_sec: number; end_sec: number; label?: string | null }
// 追加方法：
list(): ClipProjectSummary[];                                   // updated_at DESC
get(importId: number): ClipProjectDetail | null;                // 无工程 → null；segments 按 sort_order ASC
upsert(importId: number, name: string | null, segments: SegmentInput[]): ClipProjectDetail; // 事务全量替换
delete(importId: number): number;                               // 事务；返回删除的**工程行数**（0/1）

// 路由（错误形状沿用 {ok:false,error:{code,message,next}}）
GET    /api/projects                     → { ok, projects: ClipProjectSummary[] }
GET    /api/projects/:importId           → { ok, project: ClipProjectDetail | null }（来源不存在 → 404）
PUT    /api/projects/:importId           → { ok, project: ClipProjectDetail }（校验/事务见下）
DELETE /api/projects/:importId           → { ok, deleted: number }（幂等）
```

**Steps**

1) `server/src/db/tx.ts`：
```ts
// 事务 helper（D18）：全量替换型写操作必须原子——删旧段 + 写新段 + 更新 updated_at 同进同出。
// node:sqlite 同步 API；本库无嵌套事务需求，故不做嵌套检测。
import type { DB } from './index.js';

export function inTransaction<T>(db: DB, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* 回滚失败：保留原异常，别把真因吞掉 */ }
    throw e;
  }
}
```

2) `server/src/db/repo/clip-projects.ts`（保留两个既有方法；新增下列）：
```ts
import { inTransaction } from '../tx.js';

export interface ClipSegmentRow { id: number; start_sec: number; end_sec: number; label: string | null; sort_order: number }
export interface ClipProjectSummary { import_id: number; name: string | null; updated_at: string; segment_count: number }
export interface ClipProjectDetail { import_id: number; name: string | null; updated_at: string; segments: ClipSegmentRow[] }
export interface SegmentInput { start_sec: number; end_sec: number; label?: string | null }

  /** 工程列表（首页/剪辑室用）：updated_at 新→旧 */
  const list = (): ClipProjectSummary[] =>
    (db.prepare(
      'SELECT p.import_id, p.name, p.updated_at, ' +
      '(SELECT COUNT(*) FROM clip_segments seg WHERE seg.project_id = p.id) AS segment_count ' +
      'FROM clip_projects p ORDER BY p.updated_at DESC, p.import_id DESC',
    ).all() as Array<Record<string, unknown>>).map((r) => ({
      import_id: Number(r.import_id),
      name: r.name === null || r.name === undefined ? null : String(r.name),
      updated_at: String(r.updated_at),
      segment_count: Number(r.segment_count ?? 0),
    }));

  /** 工程详情（含段，按 sort_order）；无工程 → null（正常，不算错） */
  const get = (importId: number): ClipProjectDetail | null => {
    const p = db.prepare('SELECT id, import_id, name, updated_at FROM clip_projects WHERE import_id = ?').get(importId) as Record<string, unknown> | undefined;
    if (!p) return null;
    const segments = (db.prepare(
      'SELECT id, start_sec, end_sec, label, sort_order FROM clip_segments WHERE project_id = ? ORDER BY sort_order ASC, id ASC',
    ).all(Number(p.id)) as Array<Record<string, unknown>>).map((s) => ({
      id: Number(s.id), start_sec: Number(s.start_sec), end_sec: Number(s.end_sec),
      label: s.label === null || s.label === undefined ? null : String(s.label),
      sort_order: Number(s.sort_order),
    }));
    return { import_id: Number(p.import_id), name: p.name === null || p.name === undefined ? null : String(p.name), updated_at: String(p.updated_at), segments };
  };

  /** 全量替换（D18：整段换包在一个事务里——删旧段 + 写新段 + 更新 updated_at 同进同出，任一失败整体回滚、旧段一条不少）。
   *  updated_at 由代码显式写（D13：SQLite 列默认值只对 INSERT 生效，UPDATE 不会自动刷新）。 */
  const upsert = (importId: number, name: string | null, segments: SegmentInput[]): ClipProjectDetail =>
    inTransaction(db, () => {
      db.prepare(
        "INSERT INTO clip_projects (import_id, name, updated_at) VALUES (?, ?, datetime('now')) " +
        "ON CONFLICT(import_id) DO UPDATE SET name=excluded.name, updated_at=datetime('now')",
      ).run(importId, name);
      const pid = Number((db.prepare('SELECT id FROM clip_projects WHERE import_id = ?').get(importId) as { id: number }).id);
      db.prepare('DELETE FROM clip_segments WHERE project_id = ?').run(pid); // 先删后插 = 全量替换
      const ins = db.prepare('INSERT INTO clip_segments (project_id, start_sec, end_sec, label, sort_order) VALUES (?, ?, ?, ?, ?)');
      segments.forEach((s, i) => ins.run(pid, s.start_sec, s.end_sec, s.label ?? null, i));
      const detail = get(importId); // 同连接事务内可读到未提交的新段
      if (detail === null) throw new Error('clip_projects upsert 后查不到工程');
      return detail;
    });

  /** 删工程与其段（D18 事务），返回删除的工程行数（0/1）。幂等：不存在 → 0，不抛。 */
  const del = (importId: number): number =>
    inTransaction(db, () => {
      db.prepare('DELETE FROM clip_segments WHERE project_id IN (SELECT id FROM clip_projects WHERE import_id = ?)').run(importId);
      return Number(db.prepare('DELETE FROM clip_projects WHERE import_id = ?').run(importId).changes);
    });
```
`return { clearByImportId, countSegmentsByImportId, list, get, upsert, delete: del };`

3) `server/src/logs.ts:14`：`source` 联合类型末尾加 `'project'`：
```ts
  source: 'server' | 'job' | 'http' | 'audio.file' | 'audio.delete' | 'audio.replace' | 'cover' | 'media' | 'clip' | 'project' | 'web';
```

4) `server/src/media/project-routes.ts`：
```ts
// 剪辑工程路由（P4，spec §0.3 剪辑工程）：GET 列表/详情、PUT 全量替换、DELETE 幂等。
// T4 会往本文件追加 POST .../export（同文件 → T3 → T4 串行）。
import { existsSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import type { DB } from '../db/index.js';
import { createImportsRepo } from '../db/repo/imports.js';
import { createClipProjectsRepo } from '../db/repo/clip-projects.js';
import { pushLog } from '../logs.js';

const MAX_SEGMENTS = 50;
const MAX_LABEL_LEN = 100;

interface SegmentBody { start_sec?: unknown; end_sec?: unknown; label?: unknown }
type ParsedSegments = { ok: true; segments: { start_sec: number; end_sec: number; label: string | null }[] }
  | { ok: false; message: string; next: string };

/** segments 校验（PUT 与 export 共用；spec §0.3）：数组；0 ≤ start_sec；end_sec > start_sec；段数 ≤ 50；label 可空且 ≤ 100。 */
function parseSegments(raw: unknown): ParsedSegments {
  if (!Array.isArray(raw)) return { ok: false, message: 'segments 必须是数组', next: '重新提交剪辑段' };
  if (raw.length > MAX_SEGMENTS) return { ok: false, message: `剪辑段不能超过 ${MAX_SEGMENTS} 个`, next: '减少剪辑段后重试' };
  const out: { start_sec: number; end_sec: number; label: string | null }[] = [];
  for (const item of raw as SegmentBody[]) {
    const s = typeof item?.start_sec === 'number' ? item.start_sec : NaN;
    const e = typeof item?.end_sec === 'number' ? item.end_sec : NaN;
    if (!Number.isFinite(s) || !Number.isFinite(e) || s < 0 || e <= s) {
      return { ok: false, message: '剪辑段起止无效', next: '需满足 0 ≤ start_sec < end_sec' };
    }
    const rawLabel = item.label;
    if (rawLabel !== undefined && rawLabel !== null && typeof rawLabel !== 'string') {
      return { ok: false, message: 'label 必须是字符串', next: '去掉标签或改为文本' };
    }
    const label = typeof rawLabel === 'string' ? rawLabel : null;
    if (label !== null && label.length > MAX_LABEL_LEN) return { ok: false, message: `label 不能超过 ${MAX_LABEL_LEN} 字`, next: '缩短标签' };
    out.push({ start_sec: s, end_sec: e, label });
  }
  return { ok: true, segments: out };
}

export function registerProjectRoutes(
  app: FastifyInstance,
  deps: { db: DB; audioDir: string; tempDir: string; token: string },
): void {
  const { db } = deps;
  const projectsRepo = createClipProjectsRepo(db);
  const importsRepo = createImportsRepo(db);
  const badId = (importId: number): boolean => !Number.isInteger(importId) || importId <= 0;

  app.get('/api/projects', async () => ({ ok: true, projects: projectsRepo.list() }));

  app.get('/api/projects/:importId', async (req, reply) => {
    const importId = Number((req.params as { importId: string }).importId);
    if (badId(importId)) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: '来源不存在', next: '' } });
    if (importsRepo.get(importId) === null) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: '来源不存在', next: '' } });
    return { ok: true, project: projectsRepo.get(importId) }; // 来源在、没工程 → project:null（正常）
  });

  app.put('/api/projects/:importId', async (req, reply) => {
    const importId = Number((req.params as { importId: string }).importId);
    if (badId(importId)) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: '来源不存在', next: '' } });
    if (importsRepo.get(importId) === null) {
      // 评审盲点 P1-11：来源被删后不能只给裸 404
      return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: '来源不存在', next: '该来源已被删除，无法保存' } });
    }
    const body = (req.body ?? {}) as { name?: unknown; segments?: unknown };
    const parsed = parseSegments(body.segments);
    if (!parsed.ok) return reply.code(400).send({ ok: false, error: { code: 'BAD_REQUEST', message: parsed.message, next: parsed.next } });
    const existing = projectsRepo.get(importId);
    const name = typeof body.name === 'string'
      ? (body.name.trim() === '' ? null : body.name.trim())
      : (existing?.name ?? null); // 不传 → 更新时保留旧名；首次创建 → null
    const saved = projectsRepo.upsert(importId, name, parsed.segments);
    pushLog('info', 'project', `工程已保存 import=${importId} 段数=${saved.segments.length} name=${name ?? '(无)'}`);
    return { ok: true, project: saved };
  });

  app.delete('/api/projects/:importId', async (req, reply) => {
    const importId = Number((req.params as { importId: string }).importId);
    if (badId(importId)) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: '来源不存在', next: '' } });
    const deleted = projectsRepo.delete(importId); // 不删素材、不删已导出音频
    pushLog('info', 'project', `工程已删除 import=${importId} deleted=${deleted}`);
    return { ok: true, deleted }; // 幂等：不存在 → deleted:0，仍 200
  });
}
```

5) `server/src/index.ts`：
- 顶部 import：`import { registerProjectRoutes } from './media/project-routes.js';`
- `registerMediaRoutes(...)` 之后加：
```ts
    // 剪辑工程 CRUD（P4，spec §0.3）：放在媒体路由之后，onRequest 守卫统一保护（无豁免）
    registerProjectRoutes(app, { db, audioDir, tempDir: opts.tempDir, token });
```

**Tests**

`server/src/db/tx.test.ts`：
- 提交：`inTransaction(db, () => { insert; })` → 行存在。
- 回滚：`inTransaction(db, () => { insert; throw new Error('boom'); })` → 抛异常且**行不存在**（`COUNT=0`）。

`server/src/db/repo/clip-projects.test.ts`（追加，保留既有用例）：
- `upsert` 建工程 + 段带 `sort_order=0..n-1`；`get` 返回段按 `sort_order` 升序。
- `upsert` 二次调用 = 全量替换（旧段 gone、新段在、段数正确）。
- **D13 `updated_at` 变新**：先 `db.prepare("UPDATE clip_projects SET updated_at='2000-01-01 00:00:00' WHERE import_id=?").run(importId)`，再 `upsert` → `get(importId)!.updated_at !== '2000-01-01 00:00:00'`（**不要**靠两次快速调用比 `datetime('now')`——秒级精度会相等导致 flake）。
- **D18 事务回滚旧段完好**：先 `upsert(importId,'n',[2 段])`，再 `upsert(importId,'n',[{合法}, {start_sec: 0, end_sec: 10, label: {} as never}])`（第 2 段给**不可绑定值**触发写段异常）→ 期望 `toThrow()`，且 `get(importId)!.segments` 仍是**原来的 2 段**（事务回滚生效）。
  > 兜底：若 node:sqlite 对某类型宽容未抛，改用 `label: Symbol() as never` 或 `start_sec: (() => {}) as never` 触发 `TypeError`（`DatabaseSync` 对不可绑定值一律抛）。
- `delete` 幂等：删两次，第一次返回 1、第二次 0；段行一并消失。
- `list` 按 `updated_at` DESC；`segment_count` 正确。

`server/src/media/project-routes.test.ts`（Fastify + `app.inject`，仿 `media-routes.test.ts`；`importId` 用 `createImportsRepo(db).upsertByUrl` 造）：
- `GET /api/projects/:id` 无工程 → 200 `project: null`；来源不存在 → 404。
- `PUT` 合法 → 200 且返回保存后的工程；再 `GET` 读到同内容。
- `PUT` 校验：`start_sec=-1` → 400；`end_sec<=start_sec` → 400；`segments` 非数组 → 400；51 段 → 400；`label` 101 字 → 400。
- `PUT` `end_sec` 超素材时长（如 99999）→ **200**（允许）。
- `PUT` `segments: []` → 200，段数 0（清空）。
- `PUT` 来源不存在 → 404 且 `error.next === '该来源已被删除，无法保存'`。
- `DELETE` 幂等：删两次都 200；第二次 `deleted === 0`。
- **D18 接口级**：先 PUT 2 段；再 PUT 令第 2 段写失败（同 repo 用例的不可绑定值）→ 接口 500，且 `GET` 读到的仍是原 2 段。

**Verify**
- `pnpm --filter @sct/server test`
- `pnpm --filter @sct/server typecheck`

**Serial**：改 `index.ts`（与 T2 串行）、`clip-projects.ts`（与 T7 串行）、`project-routes.ts`（与 T4 串行）。

---

## Task 4：导出 job + D8 历史纠偏

**Files**
- Modify `server/src/ytdlp/ingest.ts`（加可选 `sourceType`）
- Modify `server/src/db/schema.ts`（`initSchema` 里加历史纠偏 UPDATE）
- Modify `server/src/ffmpeg/clip-args.ts`（导出 `CODEC_BY_FORMAT` 供复用）
- Modify `server/src/ffmpeg/clip.ts`（抽 `runFfmpegArgs`，`runClip` 改为委托；行为不变）
- Create `server/src/ffmpeg/export-args.ts`（`buildMergeArgs`）
- Create `server/src/media/ffmpeg-export.ts`（job runner，`startExportJob`）
- Modify `server/src/media/project-routes.ts`（加 `POST /api/projects/:importId/export`）
- Modify `server/src/ytdlp/ytdlp-routes.ts`（`YtdlpDeps` 加 `exportStarter`；retry 分支支持 `ffmpeg_export`）
- Modify `server/src/index.ts`（给 `registerYtdlpRoutes` 注入 `exportStarter`）
- Test：Create `server/src/ffmpeg/export-args.test.ts`、`server/src/media/ffmpeg-export.test.ts`；Modify `server/src/ytdlp/ingest.test.ts`、`server/src/db/schema.test.ts`（若不存在则 Create）、`server/src/ffmpeg/clip.test.ts`

**Interfaces**
```ts
// ytdlp/ingest.ts
ingestDownloadedFile(opts: {
  ...existing...
  sourceType?: 'download' | 'edit';   // 默认 'download'（老路径不变）
}): { audioId: number; finalPath: string };

// ffmpeg/clip-args.ts
export const CODEC_BY_FORMAT: Record<'mp3' | 'm4a' | 'wav', string[]>;

// ffmpeg/clip.ts
export interface RunFfmpegArgsOpts {
  ffmpegPath: string; args: string[]; outPath: string;
  timeoutMs?: number; doExec?: ExecLike; fileSize?: (p: string) => number | null;
}
export function runFfmpegArgs(o: RunFfmpegArgsOpts): Promise<{ ok: boolean; stderr: string }>;

// ffmpeg/export-args.ts
export function buildMergeArgs(o: {
  inputPath: string; outPath: string; format: 'mp3' | 'm4a' | 'wav'; quality?: string;
  segments: { start_sec: number; end_sec: number }[];
}): string[];

// media/ffmpeg-export.ts
export interface ExportSegment { start_sec: number; end_sec: number; label?: string | null }
export interface ExportJobPayload {
  importId: number; videoPath: string; mode: 'separate' | 'merge';
  format: 'mp3' | 'm4a' | 'wav'; quality?: string; prefix: string; segments: ExportSegment[];
}
export async function startExportJob(jobId: number, payload: ExportJobPayload, deps: { db: DB; audioDir: string; tempDir: string }): Promise<void>;

// 路由
POST /api/projects/:importId/export → 201 { ok, jobId }
```

**Steps**

1) `server/src/ytdlp/ingest.ts`：给入参加 `sourceType?`，并让 create 用它：
```ts
export function ingestDownloadedFile(opts: {
  tmpPath: string; title: string; format: string; durationSec: number | null;
  fileSize: number; sourceUrl: string; audioDir: string;
  entryIndex?: number | null; collectionTitle?: string | null;
  /** D8：剪辑/导出产物传 'edit'；缺省 'download'（老下载路径不变） */
  sourceType?: 'download' | 'edit';
  exists: (p: string) => boolean; audioRepo: AudioItemsRepo;
}): { audioId: number; finalPath: string } {
  const audioId = opts.audioRepo.create({
    title: opts.title, source_type: opts.sourceType ?? 'download', source_url: opts.sourceUrl,
    ...rest 不变...
  });
  ...余下不变...
}
```

2) `server/src/db/schema.ts`：`initSchema` 里（在 `ensureColumns(...'source_videos'...)` 之后）加：
```ts
  // D8 历史纠偏（spec §0.4）：早期 ingest 把剪辑产物硬编码记成 'download'，但它们标题恒以 [mm:ss-mm:ss] 结尾。
  // LIKE 里 [ ] 是普通字符、_ 是通配 —— 正好匹配「[两位:两位-两位:两位]」；三位分钟（≥100 分钟）用 GLOB 的纯数字字符类补一段。
  // 幂等：已是 'edit' 的不会被再改（条件锁定 source_type='download'）。
  db.exec(
    "UPDATE audio_items SET source_type='edit' " +
    "WHERE source_type='download' " +
    "AND title LIKE '%[__:__-__:__]' " +                       // 形如 [05:12-06:03]
    "OR (source_type='download' AND title GLOB '*[0-9][0-9][0-9]:[0-9][0-9]-[0-9][0-9][0-9]:[0-9][0-9]');",
  );
```
（**照抄 spec §0.4 的 SQL 与括号**；AND/OR 优先级即 spec 原样。）

3) `server/src/ffmpeg/clip-args.ts`：把 `CODEC_BY_FORMAT` 改成 `export`：
```ts
export const CODEC_BY_FORMAT: Record<ClipArgsOpts['format'], string[]> = {
  mp3: ['-c:a', 'libmp3lame'], m4a: ['-c:a', 'aac'], wav: ['-c:a', 'pcm_s16le'],
};
```

4) `server/src/ffmpeg/clip.ts`：抽出通用 runner，`runClip` 委托（**行为与签名不变**，`clip.test.ts` 现有断言应继续全绿）：
```ts
export interface RunFfmpegArgsOpts {
  ffmpegPath: string; args: string[]; outPath: string;
  timeoutMs?: number; doExec?: ExecLike; fileSize?: (p: string) => number | null;
}
/** 通用 runner：成功判定「产物存在且 size>0」，不信退出码；失败必带 stderr（仓库铁律）。 */
export function runFfmpegArgs(o: RunFfmpegArgsOpts): Promise<{ ok: boolean; stderr: string }> {
  const doExec = o.doExec ?? execFile;
  const sizeOf = o.fileSize ?? ((p: string) => { try { return statSync(p).size; } catch { return null; } });
  return new Promise((resolve) => {
    doExec(o.ffmpegPath, o.args, { timeout: o.timeoutMs ?? 120_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, _stdout, stderr) => {
      const out = stderr ?? '';
      if (err) {
        const e = err as NodeJS.ErrnoException;
        pushLog('error', 'media', `ffmpeg 失败 code=${e.code ?? '?'} signal=${(e as { signal?: string }).signal ?? '-'} stderr=${out.trim().slice(0, 300) || '(空)'}`);
        resolve({ ok: false, stderr: out }); return;
      }
      const size = sizeOf(o.outPath);
      if (size === null || size <= 0) { pushLog('error', 'media', `ffmpeg 退出码 0 但没写出产物 out=${o.outPath} stderr=${out.trim().slice(0, 300) || '(空)'}`); resolve({ ok: false, stderr: out }); return; }
      resolve({ ok: true, stderr: out });
    });
  });
}
/** 抽音轨（委托 runFfmpegArgs，行为不变） */
export function runClip(o: RunClipOpts): Promise<{ ok: boolean; stderr: string }> {
  return runFfmpegArgs({ ffmpegPath: o.ffmpegPath, args: buildClipArgs(o), outPath: o.outPath, timeoutMs: o.timeoutMs, doExec: o.doExec, fileSize: o.fileSize });
}
```

5) `server/src/ffmpeg/export-args.ts`：
```ts
// 导出参数（D9）：separate 复用 buildClipArgs（每段就是一次抽音轨）；merge 用 atrim + concat 拼一条。
import { CODEC_BY_FORMAT } from './clip-args.js';

/** merge：把 N 段按数组顺序 atrim 出、各自重置 PTS、再 concat 成一条音轨（v=0 只处理音频）。 */
export function buildMergeArgs(o: {
  inputPath: string; outPath: string; format: 'mp3' | 'm4a' | 'wav'; quality?: string;
  segments: { start_sec: number; end_sec: number }[];
}): string[] {
  const n = o.segments.length;
  const trim = o.segments.map((s, i) => `[0:a]atrim=start=${s.start_sec}:end=${s.end_sec},asetpts=PTS-STARTPTS[a${i}]`).join(';');
  const labels = o.segments.map((_s, i) => `[a${i}]`).join('');
  const filter = `${trim};${labels}concat=n=${n}:v=0:a=1[out]`;
  const args = ['-i', o.inputPath, '-filter_complex', filter, '-map', '[out]', '-vn'];
  args.push(...CODEC_BY_FORMAT[o.format]);
  if (o.quality !== undefined && o.format !== 'wav') args.push('-b:a', o.quality);
  args.push('-y', o.outPath);
  return args;
}
```

6) `server/src/media/ffmpeg-export.ts`：
```ts
// 导出任务（spec D9/D15/D8）：separate 每段一条音频入库；merge concat 成一条。
// 与 clip-job.ts 同族：产物走 ingestDownloadedFile + sourceType='edit'（D8），标题由后端强制拼。
import { existsSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { DB } from '../db/index.js';
import { createAudioItemsRepo } from '../db/repo/audio-items.js';
import { createJobsRepo } from '../db/repo/jobs.js';
import { runClip, runFfmpegArgs } from '../ffmpeg/clip.js';
import { buildClipArgs } from '../ffmpeg/clip-args.js';
import { buildMergeArgs } from '../ffmpeg/export-args.js';
import { pushLog } from '../logs.js';
import { emit } from '../ytdlp/job-events.js';
import { probeDuration } from '../ytdlp/ffprobe.js';
import { ingestDownloadedFile } from '../ytdlp/ingest.js';
import { formatClipTitle } from './clip-job.js';
import { resolveFfmpegPath } from './ffmpeg-path.js';

export interface ExportSegment { start_sec: number; end_sec: number; label?: string | null }
export interface ExportJobPayload {
  importId: number; videoPath: string; mode: 'separate' | 'merge';
  format: 'mp3' | 'm4a' | 'wav'; quality?: string; prefix: string; segments: ExportSegment[];
}
/** merge 的标题：前缀 [共N段]（spec §0.3） */
export function formatMergeTitle(prefix: string, count: number): string { return `${prefix} [共${count}段]`; }
const tail = (s: string): string => s.trim().split('\n').slice(-1)[0]?.slice(0, 200) || '(ffmpeg 无 stderr 输出)';
const ffprobePathFrom = (ffmpegPath: string): string => ffmpegPath.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1');

export async function startExportJob(jobId: number, payload: ExportJobPayload, deps: { db: DB; audioDir: string; tempDir: string }): Promise<void> {
  const jobsRepo = createJobsRepo(deps.db);
  jobsRepo.update(jobId, { status: 'running' });
  const fail = (msg: string): void => { jobsRepo.fail(jobId, msg); pushLog('error', 'job', `export job ${jobId} 失败: ${msg}`); emit(jobId, { type: 'status', state: 'error', message: msg }); };
  try {
    if (!existsSync(payload.videoPath)) { fail('素材已不存在，请重新下载视频'); return; }
    if (payload.segments.length === 0) { fail('没有可导出的剪辑段'); return; }
    const ffmpegPath = await resolveFfmpegPath(deps.db);
    if (ffmpegPath === null) { fail('ffmpeg 未找到或未配置：请到设置页配置 ffmpeg 路径'); return; }
    const ffprobePath = ffprobePathFrom(ffmpegPath);
    const audioRepo = createAudioItemsRepo(deps.db);
    const ingest = (tmp: string, title: string, durationSec: number | null): number =>
      ingestDownloadedFile({
        tmpPath: tmp, title, format: payload.format, durationSec,
        fileSize: statSync(tmp).size, sourceUrl: '', entryIndex: null, collectionTitle: null,
        sourceType: 'edit',   // D8：导出产物是「剪辑」而非「下载」
        audioDir: deps.audioDir, exists: existsSync, audioRepo,
      }).audioId;

    if (payload.mode === 'separate') {
      const produced: number[] = [];
      for (let i = 0; i < payload.segments.length; i++) {
        const seg = payload.segments[i]!;
        const tmp = join(deps.tempDir, `export-${jobId}-${i}-${Date.now()}.${payload.format}`);
        const r = await runClip({ ffmpegPath, inputPath: payload.videoPath, outPath: tmp, start: seg.start_sec, end: seg.end_sec, format: payload.format, quality: payload.quality });
        if (!r.ok) { try { rmSync(tmp, { force: true }); } catch { /* 尽力清理 */ } fail(`导出第 ${i + 1} 段失败：${tail(r.stderr)}`); return; }
        const title = formatClipTitle(payload.prefix, seg.start_sec, seg.end_sec); // 前端传的 label/title 不作前缀（后端强制拼）
        const dur = await probeDuration(ffprobePath, tmp);
        pushLog('info', 'job', `export job ${jobId} 第 ${i + 1}/${payload.segments.length} 段请求 ${seg.start_sec}-${seg.end_sec}s，实测 ${dur ?? '?'}s`);
        produced.push(ingest(tmp, title, dur));
        emit(jobId, { type: 'progress', percent: Math.round(((i + 1) / payload.segments.length) * 100) });
      }
      jobsRepo.finish(jobId);
      pushLog('info', 'job', `export job ${jobId} done mode=separate → ${produced.length} 条音频`);
      // C-2：emit 在 done 后断连，故只发一次终态，用 count 带出总段数
      emit(jobId, { type: 'done', kind: 'audio', audioId: produced[0]!, title: `${payload.prefix}（共 ${produced.length} 段）`, format: payload.format, replaced: false, count: produced.length });
      return;
    }

    // merge
    const tmp = join(deps.tempDir, `export-${jobId}-merge-${Date.now()}.${payload.format}`);
    const args = buildMergeArgs({ inputPath: payload.videoPath, outPath: tmp, format: payload.format, quality: payload.quality, segments: payload.segments });
    const r = await runFfmpegArgs({ ffmpegPath, args, outPath: tmp });
    if (!r.ok) { try { rmSync(tmp, { force: true }); } catch { /* 尽力清理 */ } fail(`合并导出失败：${tail(r.stderr)}`); return; }
    const title = formatMergeTitle(payload.prefix, payload.segments.length);
    const dur = await probeDuration(ffprobePath, tmp);
    const audioId = ingest(tmp, title, dur);
    jobsRepo.finish(jobId);
    pushLog('info', 'job', `export job ${jobId} done mode=merge → audio ${audioId} @ ${title}`);
    emit(jobId, { type: 'done', kind: 'audio', audioId, title, format: payload.format, replaced: false, count: 1 });
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}
```
> `buildClipArgs` 在 separate 分支未直接用（runClip 内部已用它）——若 import 未用则删该 import，避免 lint 噪音。

7) `server/src/media/project-routes.ts` 追加导出路由（顶部补 `existsSync`、`createSourceVideosRepo`、`createJobsRepo`、`startExportJob`/`ExportJobPayload` import）：
```ts
  app.post('/api/projects/:importId/export', async (req, reply) => {
    const importId = Number((req.params as { importId: string }).importId);
    if (badId(importId)) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: '素材不存在', next: '' } });
    const body = (req.body ?? {}) as { mode?: unknown; format?: unknown; quality?: unknown; segments?: unknown };
    if (body.mode !== 'separate' && body.mode !== 'merge') {
      return reply.code(400).send({ ok: false, error: { code: 'BAD_REQUEST', message: 'mode 只能是 separate 或 merge', next: '选择导出方式' } });
    }
    if (!['mp3', 'm4a', 'wav'].includes(String(body.format))) {
      return reply.code(400).send({ ok: false, error: { code: 'BAD_REQUEST', message: 'format 必须是 mp3|m4a|wav', next: '选择输出格式' } });
    }
    const parsed = parseSegments(body.segments); // D15：segments 必传，导出以请求体为准
    if (!parsed.ok) return reply.code(400).send({ ok: false, error: { code: 'BAD_REQUEST', message: parsed.message, next: parsed.next } });
    if (parsed.segments.length === 0) return reply.code(400).send({ ok: false, error: { code: 'BAD_REQUEST', message: '没有可导出的剪辑段', next: '先添加剪辑段' } });
    const video = createSourceVideosRepo(db).get(importId);
    if (!video) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: '素材不存在', next: '先下载视频' } });
    if (!existsSync(video.file_path)) return reply.code(404).send({ ok: false, error: { code: 'FILE_MISSING', message: '素材文件已丢失，请重新下载视频', next: '' } });
    const importRow = importsRepo.get(importId);
    const project = projectsRepo.get(importId);
    const prefix = project?.name ?? importRow?.title ?? '剪辑音频'; // 前缀由服务端定（D9）
    const payload: ExportJobPayload = {
      importId, videoPath: video.file_path, mode: body.mode, format: body.format,
      quality: typeof body.quality === 'string' ? body.quality : undefined, prefix, segments: parsed.segments,
    };
    const jobId = createJobsRepo(db).create('ffmpeg_export', payload);
    pushLog('info', 'job', `export job ${jobId} created import=${importId} mode=${body.mode} 段数=${parsed.segments.length}`);
    void startExportJob(jobId, payload, { db, audioDir: deps.audioDir, tempDir: deps.tempDir });
    return reply.code(201).send({ ok: true, jobId });
  });
```

8) `server/src/ytdlp/ytdlp-routes.ts`：
- `YtdlpDeps` 加：
```ts
  /** 导出启动器（P4）：retry 遇到 ffmpeg_export 任务时把新任务交给它；未接线 → 500 NOT_WIRED */
  exportStarter?: (jobId: number, payload: unknown) => Promise<void>;
```
- retry 分支：`kind` 判定加 `ffmpeg_export`，并把 ffmpeg_clip 的处理扩成两支：
```ts
    const kind = old.kind === 'ytdlp_video' ? 'ytdlp_video'
      : old.kind === 'ffmpeg_clip' ? 'ffmpeg_clip'
      : old.kind === 'ffmpeg_export' ? 'ffmpeg_export'
      : 'ytdlp_download';
    if (kind === 'ffmpeg_clip' || kind === 'ffmpeg_export') {
      const p = JSON.parse(old.payload) as { videoPath?: string };
      if (typeof p.videoPath !== 'string' || !existsSync(p.videoPath)) {
        return reply.code(409).send({ ok: false, error: { code: 'MEDIA_GONE', message: '素材已不存在，请重新下载视频', next: '回到资料库重新下视频' } });
      }
      if (kind === 'ffmpeg_export') {
        if (deps.exportStarter === undefined) return reply.code(500).send({ ok: false, error: { code: 'NOT_WIRED', message: '导出重试未接线', next: '' } });
        const newId = jobsRepo.create('ffmpeg_export', p);
        pushLog('info', 'job', `export job ${newId} created by retry of ${id}`);
        void deps.exportStarter(newId, p);
        return reply.code(201).send({ ok: true, jobId: newId });
      }
      if (deps.clipStarter === undefined) return reply.code(500).send({ ok: false, error: { code: 'NOT_WIRED', message: '剪辑重试未接线', next: '' } });
      const newId = jobsRepo.create('ffmpeg_clip', p);
      pushLog('info', 'clip', `job ${newId} created by retry of ${id}`);
      void deps.clipStarter(newId, p);
      return reply.code(201).send({ ok: true, jobId: newId });
    }
```

9) `server/src/index.ts`：给 `registerYtdlpRoutes` 注入 `exportStarter`（在既有 `clipStarter` 之后）：
```ts
      exportStarter: async (jobId, payload) => {
        await startExportJob(jobId, payload as ExportJobPayload, { db, audioDir, tempDir: opts.tempDir });
      },
```
顶部 import：`import { startExportJob, type ExportJobPayload } from './media/ffmpeg-export.js';`

**Tests**

`server/src/ffmpeg/export-args.test.ts`：
- `buildMergeArgs`（2 段）→ `-filter_complex` 含 `atrim=start=0:end=10`、`atrim=start=20:end=30`、`concat=n=2:v=0:a=1[out]`、`-map [out]`、`-vn`、`-c:a libmp3lame`、`-y`。
- `wav` + `quality` → 不带 `-b:a`（与 buildClipArgs 同口径）。

`server/src/media/ffmpeg-export.test.ts`（仿 `media-routes.test.ts` 的 mock 手法）：
- `vi.mock('./ffmpeg-path.js')`（返桩路径）、`vi.mock('../ytdlp/ffprobe.js')`（时长固定）、`vi.mock('../ffmpeg/clip.js')`（`runClip` 写文件返回 ok；`runFfmpegArgs` 写文件返回 ok）。
- `separate` 2 段 → `audio_items` 两行；标题分别 = `formatClipTitle(prefix,a,b)`；两行 `source_type === 'edit'`；job 状态 `done`。
- `merge` 2 段 → `audio_items` 一行；标题 = `formatMergeTitle(prefix,2)`；`source_type === 'edit'`。
- 素材路径不存在 → job `error`，message 含「素材已不存在」，`audio_items` 0 行。
- ffmpeg 解析不到（`ffmpeg-path` mock 返 null）→ job `error`，message 含 ffmpeg，0 行。
- `formatMergeTitle('x',3) === 'x [共3段]'`。

`server/src/ytdlp/ingest.test.ts`（追加）：
- 传 `sourceType:'edit'` → 落库 `source_type === 'edit'`。
- 不传 → `source_type === 'download'`（回归保护）。

`server/src/db/schema.test.ts`（若不存在则 Create；`openDatabase(':memory:')` + `initSchema` + 直接 INSERT audio_items）：
- `[05:12-06:03]`（两位分钟）→ 纠偏后 `source_type === 'edit'`。
- `[120:00-121:30]`（三位分钟）→ 命中（GLOB 段）→ `edit`。
- 普通标题「第三集」→ 仍是 `download`。
- 已是 `edit` 的行 → 仍是 `edit`（不重复改/不误伤）。

`server/src/ffmpeg/clip.test.ts`（回归）：既有断言应全绿（`runClip` 委托后行为不变）；可补一条 `runFfmpegArgs` 直接测（success / exit0-无产物 / err-stderr）。

**Verify**
- `pnpm --filter @sct/server test`
- `pnpm --filter @sct/server typecheck`

**Serial**：改 `project-routes.ts`（T3 之后）、`ytdlp-routes.ts`（T2 之后）、`index.ts`（T2/T3 之后）、`clip.ts`/`clip-args.ts`（本任务首改）。

---

## Task 5：前端编辑器骨架（studio-detail.tsx 重写）

**Files**
- Modify `web/src/api.ts`（加 `waveformUrl`/`filmstripUrl`；`DoneEvent` 加可选 `count`）
- Modify `web/src/pages/studio-detail.tsx`（重写：页面头 + 预览 + 时间轴 + 多段 CRUD + 清空确认 + D17 空态）

**Interfaces**
```ts
// web/src/api.ts
export function waveformUrl(importId: number, rev: string | number): string;   // /api/media/:id/waveform?token=..&rev=..
export function filmstripUrl(importId: number, rev: string | number): string;  // /api/media/:id/filmstrip?token=..&rev=..
export type DoneEvent =
  | { kind?: 'audio'; audioId: number; title: string; format: string; replaced?: boolean; count?: number }  // count：一次导出多条时的条数（C-2）
  | { kind: 'video'; importId: number; title: string; filePath: string; height: number | null; fileSize: number };
```
本任务 `studio-detail.tsx` 只做**本地**多段编辑 + 预览 + 时间轴（保存/导出在 T6 接线）；预览版本串先只用本地 `rev`，`file_size` 收口在 T7。

**Steps**

1) `web/src/api.ts`（`mediaFileUrl` 附近追加；并在既有 `DoneEvent` 的 audio 支末尾加 `count?: number`）：
```ts
/** 派生图地址（P4）：固定 1600 宽的波形/胶片条，服务端 ffmpeg 生成并缓存（<数据目录>/derived/）。
 *  同 mediaFileUrl —— <img> 走 query token；rev 版本串由调用方拼，素材替换后强制重新拉图。 */
export function waveformUrl(importId: number, rev: string | number): string {
  const token = apiToken();
  return `${API_BASE}/api/media/${importId}/waveform?token=${encodeURIComponent(token ?? '')}&rev=${encodeURIComponent(String(rev))}`;
}
export function filmstripUrl(importId: number, rev: string | number): string {
  const token = apiToken();
  return `${API_BASE}/api/media/${importId}/filmstrip?token=${encodeURIComponent(token ?? '')}&rev=${encodeURIComponent(String(rev))}`;
}
```

2) `web/src/pages/studio-detail.tsx` 全量重写：

```tsx
// web/src/pages/studio-detail.tsx
// P4 剪辑详情页（spec m2-workspace §0.5 P4 / §0.3）：页面头（来源名 + 第 N 集 D20）+ 预览监视器 + 时间轴 + 多段 CRUD。
// 图↔时间映射（写死，spec §0.3）：图宽固定 1600 ↔ [0, duration]；容器内点击像素 X → t = X / containerW * duration
//（containerW===1600 时即 x/1600*duration）。duration 以 <video>.duration 为**唯一真相**，不引入服务端 ffprobe 时长。
// 布局锁内容区高度：头/工具栏固定，正文自己滚（body 不滚，spec D3）。
import { Button, Empty, Input, Modal, Tag, Typography } from 'antd';
import { useNavigate, useParams } from '@umijs/max';
import { useCallback, useEffect, useRef, useState } from 'react';
import PageHeader from '@/components/PageHeader';
import { filmstripUrl, getImport, logFe, mediaFileUrl, waveformUrl, type ImportDetail } from '@/api';

const IMG_W = 1600;   // 派生图固定宽（D14，注释写死映射口径）
const WAVE_H = 120;
const FILM_H = 90;

/** 编辑期段（未保存）：只有起止与标签，无 id/sort_order —— 保存时按数组顺序定 sort_order */
interface EditSeg { start_sec: number; end_sec: number; label: string | null }

const pad = (n: number): string => String(n).padStart(2, '0');
const fmtTime = (sec: number): string => `${pad(Math.floor(sec / 60))}:${pad(Math.floor(sec % 60))}`;
const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);

export default function StudioDetailPage() {
  const { importId: importIdRaw } = useParams<{ importId: string }>();
  const importId = Number(importIdRaw);
  const navigate = useNavigate();

  const [info, setInfo] = useState<ImportDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [duration, setDuration] = useState(0);        // <video>.duration —— 时间轴唯一真相
  const [current, setCurrent] = useState(0);          // 播放头（秒）
  const [segments, setSegments] = useState<EditSeg[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [rev] = useState(0);                          // 预览/派生图版本串（T7 起拼接 file_size）

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [trackW, setTrackW] = useState(IMG_W);

  const validId = Number.isInteger(importId) && importId > 0;

  // 来源详情（来源名 + 第 N 集 + has_video）
  useEffect(() => {
    if (!validId) { setErr('来源不存在'); return; }
    getImport(importId).then(setInfo).catch((e: Error) => setErr(e.message));
  }, [importId, validId]);

  // 时间轴容器宽度：图 CSS 拉伸到容器宽，点击换算用**容器**像素宽（不是写死 1600）
  useEffect(() => {
    const el = trackRef.current;
    if (el === null) return undefined;
    const ro = new ResizeObserver(() => setTrackW(el.clientWidth || IMG_W));
    ro.observe(el);
    setTrackW(el.clientWidth || IMG_W);
    return () => ro.disconnect();
  }, [info]);

  const seek = (t: number): void => { const v = videoRef.current; if (v !== null) v.currentTime = clamp(t, 0, duration || 0); };
  const xToTime = useCallback((clientX: number): number => {
    const el = trackRef.current;
    if (el === null || duration <= 0) return 0;
    const rect = el.getBoundingClientRect();
    return (clamp(clientX - rect.left, 0, rect.width) / rect.width) * duration;
  }, [duration]);

  const addSegment = (): void => {
    if (duration <= 0 || segments.length >= 50) return;
    const start = clamp(current, 0, duration);
    const end = clamp(start + 10, start + 0.1, duration); // 从播放头起、默认 10 秒，随后可拖边
    setSegments((prev) => [...prev, { start_sec: start, end_sec: end, label: null }]);
    setSelected(segments.length);
  };
  const removeSegment = (i: number): void => { setSegments((prev) => prev.filter((_, k) => k !== i)); setSelected(null); };
  const moveSegment = (i: number, dir: -1 | 1): void => {
    setSegments((prev) => {
      const j = i + dir;
      if (j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      const tmp = next[i]!; next[i] = next[j]!; next[j] = tmp;
      return next;
    });
  };
  const setLabel = (i: number, label: string): void => { setSegments((prev) => prev.map((s, k) => (k === i ? { ...s, label: label === '' ? null : label } : s))); };

  // 拖边微调：pointermove 期间只改被拖段的首/尾（clamp 到 [0,duration]、首尾至少差 0.1s）
  const dragEdge = (index: number, edge: 'start' | 'end') => (e: React.PointerEvent): void => {
    e.preventDefault(); e.stopPropagation();
    setSelected(index);
    const move = (ev: PointerEvent): void => {
      const t = xToTime(ev.clientX);
      setSegments((prev) => prev.map((s, i) => {
        if (i !== index) return s;
        return edge === 'start'
          ? { ...s, start_sec: clamp(t, 0, s.end_sec - 0.1) }
          : { ...s, end_sec: clamp(t, s.start_sec + 0.1, duration) };
      }));
    };
    const up = (): void => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // 「清空所有剪辑点」二次确认（仓库规则：破坏性操作必须确认；只删点、不动已导出音频）
  const clearAll = (): void => {
    if (segments.length === 0) return;
    Modal.confirm({
      title: '清空所有剪辑点？',
      content: '只清空本工程里的剪辑时间点，已导出的音频不受影响。',
      okText: '清空', okType: 'danger', cancelText: '取消',
      onOk: () => { setSegments([]); setSelected(null); },
    });
  };

  // —— 无素材空态（D17）：不进空编辑器 ——
  if (err !== null) return <Typography.Text type="danger" style={{ padding: 16 }}>{err}</Typography.Text>;
  if (info !== null && !info.has_video) {
    return (
      <div style={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <PageHeader title={info.title} toolbar={<Button onClick={() => navigate('/studio')}>返回剪辑室</Button>} />
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Empty description="这个来源还没有视频素材">
            <Button type="primary" onClick={() => navigate('/library')}>去资料库下视频</Button>
          </Empty>
        </div>
      </div>
    );
  }

  const pct = duration > 0 ? (current / duration) * 100 : 0;
  const ticks = duration > 0 ? Array.from({ length: 11 }, (_v, i) => (duration * i) / 10) : [];
  const previewSrc = validId ? `${mediaFileUrl(importId)}&v=${rev}` : '';

  return (
    <div style={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <PageHeader
        title={info?.title ?? `来源 #${importIdRaw ?? '?'}`}
        meta={info !== null && info.material_entry_index !== null ? `第 ${info.material_entry_index} 集` : undefined}
        toolbar={(
          <>
            <Button type="primary" onClick={addSegment} disabled={duration <= 0 || segments.length >= 50}>在当前播放头打点</Button>
            <Button danger onClick={clearAll} disabled={segments.length === 0}>清空所有剪辑点</Button>
            <Button onClick={() => navigate('/studio')}>返回剪辑室</Button>
          </>
        )}
      />
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {/* 预览监视器（走既有 Range 路由；版本串拼 &v= 收口缓存窗口） */}
        <video
          ref={videoRef}
          key={previewSrc}
          src={previewSrc}
          controls
          onLoadedMetadata={(e) => setDuration(e.currentTarget.duration || 0)}
          onTimeUpdate={(e) => setCurrent(e.currentTarget.currentTime)}
          style={{ width: '100%', maxWidth: 720, background: '#000', borderRadius: 8, alignSelf: 'center' }}
        />

        {/* 时间轴：时间尺 + 画轨（胶片条）+ 音轨（波形）+ 播放头 + 段区块（同屏，spec 需求 7） */}
        <div style={{ position: 'relative' }}>
          <div ref={trackRef} style={{ position: 'relative', width: '100%' }}>
            {/* 时间尺 */}
            <div style={{ position: 'relative', height: 20 }}>
              {ticks.map((t, i) => (
                <span key={i} style={{ position: 'absolute', left: `${(i / 10) * 100}%`, fontSize: 11, color: '#999', transform: 'translateX(-50%)' }}>{fmtTime(t)}</span>
              ))}
            </div>
            {/* 画轨（胶片条 PNG，固定 1600×90，CSS 拉伸）——加载失败仅记录，不阻断 */}
            <img src={filmstripUrl(importId, rev)} alt="画轨" onError={() => logFe('error', `胶片条加载失败 import=${importId}`)} style={{ display: 'block', width: '100%', height: FILM_H, objectFit: 'fill', background: '#111' }} />
            {/* 音轨（波形 PNG，固定 1600×120） */}
            <img src={waveformUrl(importId, rev)} alt="音轨" onError={() => logFe('error', `波形图加载失败 import=${importId}`)} style={{ display: 'block', width: '100%', height: WAVE_H, objectFit: 'fill', background: '#0b1220' }} />
            {/* 点击定位层（在图中空白处点 → seek；段区块在它之上，单独接事件） */}
            <div onClick={(e) => seek(xToTime(e.clientX))} style={{ position: 'absolute', inset: 0, cursor: 'crosshair' }} />
            {/* 段区块（绝对定位，按百分比） */}
            {duration > 0 && segments.map((s, i) => (
              <div
                key={i}
                onClick={(e) => { e.stopPropagation(); setSelected(i); }}
                style={{
                  position: 'absolute', top: 20, height: FILM_H + WAVE_H,
                  left: `${(s.start_sec / duration) * 100}%`, width: `${((s.end_sec - s.start_sec) / duration) * 100}%`,
                  background: 'rgba(22,119,255,0.20)', boxSizing: 'border-box',
                  border: selected === i ? '2px solid #1677ff' : '1px solid rgba(22,119,255,0.6)',
                }}
              >
                <div onPointerDown={dragEdge(i, 'start')} style={{ position: 'absolute', left: 0, top: 0, width: 8, height: '100%', cursor: 'ew-resize' }} />
                <div onPointerDown={dragEdge(i, 'end')} style={{ position: 'absolute', right: 0, top: 0, width: 8, height: '100%', cursor: 'ew-resize' }} />
              </div>
            ))}
            {/* 播放头 */}
            {duration > 0 && <div style={{ position: 'absolute', top: 0, left: `${pct}%`, width: 2, height: 20 + FILM_H + WAVE_H, background: '#ff4d4f', pointerEvents: 'none' }} />}
          </div>
        </div>

        {/* 段列表：起止 + 标签 + 该段时长 + 上移/下移/删除 */}
        {segments.length === 0
          ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有剪辑点：拖播放头到位置，点「在当前播放头打点」" />
          : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {segments.map((s, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', border: selected === i ? '1px solid #1677ff' : '1px solid #f0f0f0', borderRadius: 6 }} onClick={() => setSelected(i)}>
                  <Tag color="blue" style={{ marginInlineEnd: 0 }}>{i + 1}</Tag>
                  <Typography.Text>{fmtTime(s.start_sec)} - {fmtTime(s.end_sec)}</Typography.Text>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>时长 {fmtTime(s.end_sec - s.start_sec)}</Typography.Text>
                  <Input size="small" placeholder="标签（可空）" value={s.label ?? ''} maxLength={100} onChange={(e) => setLabel(i, e.target.value)} style={{ maxWidth: 200 }} />
                  <Button size="small" onClick={() => moveSegment(i, -1)} disabled={i === 0}>上移</Button>
                  <Button size="small" onClick={() => moveSegment(i, 1)} disabled={i === segments.length - 1}>下移</Button>
                  <Button size="small" danger onClick={() => removeSegment(i)}>删除</Button>
                </div>
              ))}
            </div>
          )}
        {/* trackW 参与点击换算的实况核对（宽度变化时 layout 重算）；仅用于调试面板可查 */}
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>时间轴宽度 {trackW}px · 图固定 1600 宽（点击位置按容器宽度换算时间）</Typography.Text>
      </div>
    </div>
  );
}
```

**Tests**
- 无自动测试（web 无测试框架）。
- **Verify**：`pnpm --filter @sct/web typecheck` + `pnpm --filter @sct/web build`。
- **自查清单**：
  - [ ] 页面头显示来源名；素材登记了集号时旁边显示「第 N 集」；单视频不显示（D20）。
  - [ ] 无素材来源 → 空态「这个来源还没有视频素材」+「去资料库下视频」（D17），不渲染时间轴。
  - [ ] 三轨同屏：时间尺 / 画轨（胶片条）/ 音轨（波形）；播放头随播放移动。
  - [ ] 拖播放头 → 点「在当前播放头打点」→ 出现段区块与列表行。
  - [ ] 拖段区块左右边缘可改起止；上移/下移改变顺序；删除移除该段。
  - [ ] 「清空所有剪辑点」弹 `Modal.confirm`（`okType:'danger'`），文案含「已导出的音频不受影响」。
  - [ ] 图谱加载失败（例如无 ffmpeg）时 `<img>` 触发 onError → 控制台/日志页有记录，页面不崩。

**Serial**：与 T6、T7 同改 `studio-detail.tsx` 与 `api.ts` → **T5 → T6 → T7 串行**。

---

## Task 6：保存 + 导出接线

**Files**
- Modify `web/src/api.ts`（projects/export 封装 + 类型）
- Modify `web/src/pages/studio-detail.tsx`（拉工程、保存、导出、离开未保存提示、脏标记）

**Interfaces**
```ts
// web/src/api.ts
export interface ClipSegmentDTO { id?: number; start_sec: number; end_sec: number; label?: string | null; sort_order?: number }
export interface ClipProjectDTO { import_id: number; name: string | null; updated_at: string; segments: ClipSegmentDTO[] }
export interface ClipProjectSummaryDTO { import_id: number; name: string | null; updated_at: string; segment_count: number }
export function getProject(importId: number): Promise<ClipProjectDTO | null>;
export function listProjects(): Promise<ClipProjectSummaryDTO[]>;
export function putProject(importId: number, body: { name: string | null; segments: { start_sec: number; end_sec: number; label?: string | null }[] }): Promise<{ ok: boolean; project: ClipProjectDTO }>;
export function deleteProject(importId: number): Promise<{ ok: boolean; deleted: number }>;
export function exportProject(importId: number, body: { mode: 'separate' | 'merge'; format: 'mp3' | 'm4a' | 'wav'; quality?: string; segments: { start_sec: number; end_sec: number; label?: string | null }[] }): Promise<{ ok: boolean; jobId: number }>;
```

**Steps**

1) `web/src/api.ts`（放在 `clipMedia` 附近；`listProjects` 供 P5 首页复用）：
```ts
// ---- 剪辑工程 / 导出（P4，spec §0.3）----
export interface ClipSegmentDTO { id?: number; start_sec: number; end_sec: number; label?: string | null; sort_order?: number }
export interface ClipProjectDTO { import_id: number; name: string | null; updated_at: string; segments: ClipSegmentDTO[] }
export interface ClipProjectSummaryDTO { import_id: number; name: string | null; updated_at: string; segment_count: number }

/** GET /api/projects/:id：来源在但没工程 → null（正常） */
export async function getProject(importId: number): Promise<ClipProjectDTO | null> {
  const r = await apiGet<{ ok: boolean; project: ClipProjectDTO | null }>(`/api/projects/${importId}`);
  return r.project;
}
export function listProjects(): Promise<ClipProjectSummaryDTO[]> {
  return apiGet<{ ok: boolean; projects: ClipProjectSummaryDTO[] }>('/api/projects').then((r) => r.projects);
}
/** PUT 全量替换（服务端包事务 D18）；返回保存后的工程 */
export function putProject(importId: number, body: { name: string | null; segments: { start_sec: number; end_sec: number; label?: string | null }[] }): Promise<{ ok: boolean; project: ClipProjectDTO }> {
  logFe('info', `putProject import=${importId} 段数=${body.segments.length}`);
  return apiPut<{ ok: boolean; project: ClipProjectDTO }>(`/api/projects/${importId}`, body);
}
export function deleteProject(importId: number): Promise<{ ok: boolean; deleted: number }> {
  logFe('info', `deleteProject import=${importId}`);
  return apiDelete<{ ok: boolean; deleted: number }>(`/api/projects/${importId}`);
}
/** 导出：segments 必传（D15，以请求体为准）；走 job + SSE */
export function exportProject(importId: number, body: { mode: 'separate' | 'merge'; format: 'mp3' | 'm4a' | 'wav'; quality?: string; segments: { start_sec: number; end_sec: number; label?: string | null }[] }): Promise<{ ok: boolean; jobId: number }> {
  logFe('info', `exportProject import=${importId} mode=${body.mode} 段数=${body.segments.length}`);
  return apiPost<{ ok: boolean; jobId: number }>(`/api/projects/${importId}/export`, body);
}
```

2) `web/src/pages/studio-detail.tsx` 追加/接线：
- import 补：`Radio, Progress, Space, Alert`（antd）、`exportProject, getProject, putProject, subscribeJob`（@/api）。
- 新增状态 + 载入工程 + 保存 + 导出 + 脏标记：
```tsx
  const [dirty, setDirty] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [exportMode, setExportMode] = useState<'separate' | 'merge'>('separate');
  const [exportFormat, setExportFormat] = useState<'mp3' | 'm4a' | 'wav'>('mp3');
  const [exportPercent, setExportPercent] = useState(0);
  const [exportMsg, setExportMsg] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  // 载入已存工程（T5 的 setSegments 之后调用；来源无工程 → 空段）
  useEffect(() => {
    if (!validId) return;
    getProject(importId).then((p) => {
      setSegments(p ? p.segments.map((s) => ({ start_sec: s.start_sec, end_sec: s.end_sec, label: s.label ?? null })) : []);
      setDirty(false);
    }).catch((e: Error) => logFe('error', `拉取剪辑工程失败: ${e.message}`));
  }, [importId, validId]);

  // 任何段编辑 → 置脏（addSegment/removeSegment/moveSegment/setLabel/dragEdge/clearAll 的 setSegments 之后都要 setDirty(true)）
  // 实现建议：包一个 setSegs 帮助函数，所有改动走它 —— 避免逐个漏改
  const setSegs = useCallback((updater: (prev: EditSeg[]) => EditSeg[]): void => {
    setSegments((prev) => updater(prev));
    setDirty(true);
  }, []);

  const doSave = async (): Promise<void> => {
    setSaveMsg(null);
    try {
      const r = await putProject(importId, { name: info?.title ?? null, segments });
      setSegments(r.project.segments.map((s) => ({ start_sec: s.start_sec, end_sec: s.end_sec, label: s.label ?? null })));
      setDirty(false);
      setSaveMsg('已保存');
    } catch (e) {
      setSaveMsg(`保存失败：${(e as Error).message}`);
    }
  };

  const doExport = async (): Promise<void> => {
    if (segments.length === 0) { setExportMsg('先添加至少一个剪辑段'); return; }
    setExporting(true); setExportPercent(0); setExportMsg(null);
    try {
      const { jobId } = await exportProject(importId, { mode: exportMode, format: exportFormat, segments });
      const off = subscribeJob(jobId, {
        onProgress: (p) => setExportPercent(Math.round(p.percent)),
        onDone: (d) => { off(); setExporting(false); setExportMsg(d.kind === 'audio' && d.count && d.count > 1 ? `已导出 ${d.count} 段到剪辑室` : '已导出到剪辑室'); },
        onStatus: (s) => { if (s.state === 'error') { off(); setExporting(false); setExportMsg(`导出失败：${s.message ?? ''}`); } },
        onError: (m) => { off(); setExporting(false); setExportMsg(`导出失败：${m}`); },
      });
    } catch (e) { setExporting(false); setExportMsg(`导出失败：${(e as Error).message}`); }
  };

  // 离开未保存提示（SPA 内导航不走 beforeunload → 返回按钮也拦一次）
  useEffect(() => {
    if (!dirty) return undefined;
    const h = (e: BeforeUnloadEvent): void => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);
  const goBack = (): void => {
    if (!dirty) { navigate('/studio'); return; }
    Modal.confirm({ title: '有未保存的剪辑点', content: '离开将丢失未保存的改动。', okText: '离开', okButtonProps: { danger: true }, cancelText: '留下', onOk: () => navigate('/studio') });
  };
```
- 工具栏按钮替换为：`保存`（`onClick={doSave}`，`type="primary"`）、`导出`（`onClick={doExport}`，`loading={exporting}`）、`清空所有剪辑点`、`返回剪辑室`（`onClick={goBack}`）。
- 导出设置行（时间轴下方）：`Radio.Group`（模式 分多段/合并成一段）+ `Radio.Group`（格式 mp3/m4a/wav）+ `Progress`（`percent={exportPercent}`，`exporting` 时显示）+ `Alert`（`saveMsg` / `exportMsg`）。

**Tests**
- 无自动测试。
- **Verify**：`pnpm --filter @sct/web typecheck` + `pnpm --filter @sct/web build`。
- **自查清单**：
  - [ ] 加 3 段 → 保存 → 刷新页面 → 3 段仍在（`PUT` 全量替换 + `GET` 回读）。
  - [ ] 改了段不保存，点「返回剪辑室」→ 弹确认；点浏览器刷新/关闭 → 原生离开提示。
  - [ ] 分 3 段导出 → 剪辑室出现 3 条音频，标题形如 `前缀 [00:00-00:10]`；合并导出 → 1 条，标题 `前缀 [共3段]`。
  - [ ] 导出进度条随时间增长（`progress` 事件）；完成/失败有明确文字。
  - [ ] 未保存就导出 → 用**当前界面上的段**（不读 DB），导出后工程**不被自动保存**。
  - [ ] 「清空所有剪辑点」弹确认；确认后段全没，但**已导出音频不受影响**（剪辑室仍在）。

**Serial**：与 T5、T7 同改 `studio-detail.tsx`/`api.ts` → 串行。

---

## Task 7：P4 backlog 逐项收口

**Files**
- Modify `web/src/pages/studio-detail.tsx`（T7-1 file_size 拼版本串）
- Modify `web/src/pages/studio.tsx`（T7-9 改名 `StudioPage`；T7-10 平铺空 query 文案）
- Modify `web/src/pages/library.tsx`（T7-4 `aria-pressed`；T7-5 video 进度尾缀核查/校正）
- Modify `server/src/db/repo/clip-projects.ts`（T7-2 `clearByImportId` 包事务）
- Modify `server/src/db/repo/source-videos.ts`（T7-6 upsert 注释校正）
- Modify `server/src/db/repo/imports.ts`（T7-7 派生列 SQL 去重）
- Test：Modify `server/src/ytdlp/ytdlp-routes.test.ts`（T7-3 NULL→NULL；T7-8 级联显式化）、`server/src/db/repo/clip-projects.test.ts`（T7-2 回滚）

**Steps（逐项）**

**T7-1 file_size 拼版本串**（`studio-detail.tsx`）：从 `/api/media` 取该来源 `file_size`，与本地 `rev` 组成版本串：
```tsx
import { listMedia } from '@/api';
  const [fileSize, setFileSize] = useState<number | null>(null);
  useEffect(() => {
    if (!validId) return;
    listMedia().then((list) => setFileSize(list.find((m) => m.import_id === importId)?.file_size ?? null))
      .catch((e: unknown) => logFe('error', `拉素材列表失败: ${e instanceof Error ? e.message : String(e)}`));
  }, [importId, validId]);
  // 预览与派生图共用同一版本串：file_size 变化即素材被替换（服务端 upsert 不更新 created_at，故必须靠它）
  const version = `${fileSize ?? 'na'}-${rev}`;
  const previewSrc = validId ? `${mediaFileUrl(importId)}&v=${version}` : '';
  // <img> 与 <video> 都用 version；key 随之变化强制重建
```
（`waveformUrl(importId, version)`、`filmstripUrl(importId, version)`。）

**T7-2 `clearByImportId` 包事务**（`clip-projects.ts`）：
```ts
  const clearByImportId = (importId: number): number =>
    inTransaction(db, () => {
      const segDeleted = db.prepare(
        'DELETE FROM clip_segments WHERE project_id IN (SELECT id FROM clip_projects WHERE import_id = ?)',
      ).run(importId).changes;
      db.prepare('DELETE FROM clip_projects WHERE import_id = ?').run(importId);
      return Number(segDeleted);
    });
```

**T7-3 NULL→NULL 保留路径用例**（`ytdlp-routes.test.ts` 追加；仿既有「同集换清晰度保留工程」用例，line ~955-975）：
- 素材 `entry_index` 原为 NULL（单视频重下），工程有段 → 下载完成 → `entry_index` 仍 NULL → **工程与段原样保留**（`clip_projects` 行数 1、段数不变）。

**T7-4 D20 卡片 `aria-pressed`**（`library.tsx` 集数网格卡片，line ~346-364）：
```tsx
                          <div
                            key={e.index}
                            role="button"
                            aria-pressed={selected}   // 屏幕阅读器/自动化可读「当前素材/选中」态（D20）
                            tabIndex={0}
                            ...
```

**T7-5 video 进度尾缀措辞**（`library.tsx:400`）：
- 先核查：grep `正在写进剪辑室` 全仓 → **当前无命中**（现文案为「② 登记素材 中…(正在登记视频素材,稍等))」。若核查确认无残留 → **本项标记「已满足，无需改动」**（在 report 记结论）。若有残留 → 改为「正在登记视频素材到资料库」这类**不指向剪辑室**的措辞。

**T7-6 `source-videos.ts` upsert 注释校正**（line ~17）：
```ts
  /** 一个来源一份素材 → 冲突即覆盖（换清晰度重下就是这条路径）。
   *  P2：entryIndex 可选；**缺省即绑 NULL（= 清空该列），不是保留旧值** —— 不带该参的调用方会把集号写成 NULL。 */
```

**T7-7 `imports.ts` 派生列 SQL 去重**（`list()` 复用 `derivedJoin`）：
```ts
  // 抽出派生列与 JOIN（list 与详情唯一来源）：列名/别名改了只改一处
  const DERIVED_COLS =
    'CASE WHEN v.import_id IS NULL THEN 0 ELSE 1 END AS has_video, ' +
    'CASE WHEN p.id IS NULL THEN 0 ELSE 1 END AS has_project, ' +
    '(SELECT COUNT(*) FROM clip_segments seg WHERE seg.project_id = p.id) AS segment_count, ' +
    'v.entry_index AS material_entry_index';
  const DERIVED_JOINS = 'FROM imported_sources s LEFT JOIN source_videos v ON v.import_id = s.id LEFT JOIN clip_projects p ON p.import_id = s.id ';
  const derivedJoin = `SELECT s.*, ${DERIVED_COLS} ${DERIVED_JOINS}`;

  const mapBase = (r: Record<string, unknown>): ImportSummaryRow => {
    const entries = parseEntries((r.entries_json as string | null) ?? null);
    return {
      id: r.id as number, url: r.url as string, title: r.title as string, site: r.site as string,
      kind: r.kind as 'single' | 'playlist', entry_count: entries?.length ?? 1,
      thumbnail: r.thumbnail === null || r.thumbnail === undefined ? null : String(r.thumbnail),
      created_at: r.created_at as string,
      has_video: Number(r.has_video) === 1, has_project: Number(r.has_project) === 1,
      segment_count: Number(r.segment_count ?? 0),
      material_entry_index: r.material_entry_index === null || r.material_entry_index === undefined ? null : Number(r.material_entry_index),
    };
  };
  const list = (): ImportSummaryRow[] =>
    (db.prepare(derivedJoin + 'ORDER BY s.created_at DESC, s.id DESC').all() as Array<Record<string, unknown>>).map(mapBase);
  const mapDetail = (r: Record<string, unknown>): ImportDetailRow => ({
    ...mapBase(r),
    duration_sec: (r.duration_sec as number | null) ?? null,
    entries: parseEntries((r.entries_json as string | null) ?? null),
  });
```
（`list()` 返回的仍是 `ImportSummaryRow[]` → 路由响应字段**不变**；`mapBase` 内解析 `entries_json` 仅为算 `entry_count`，与旧行为等价。）

**T7-8 「删来源级联」回归用例显式化**（`ytdlp-routes.test.ts` line ~1035-1044）：
- 在既有断言基础上，**显式**断言 `clip_segments` 行也归零：造工程 + 2 段 → `DELETE /api/imports/:id` → `SELECT COUNT(*) FROM clip_segments WHERE project_id=?` 为 0（不只看 `clip_projects`）。

**T7-9 `studio.tsx` 默认导出函数名改名**（line ~152）：
```tsx
export default function StudioPage() {   // 原为 LibraryPage（从资料库页复制残留）
```

**T7-10 平铺视图空 query 文案**（`studio.tsx` line ~343）：
```tsx
    body = pageRows.length === 0
      ? <Empty description={query.trim() === '' ? '暂无音频' : `没有匹配「${query.trim()}」的音频`} style={{ marginTop: 64 }} />
      : ( ... )
```

**Tests**
- `clip-projects.test.ts` 追加：`clearByImportId` 用不可绑定值制造删段后失败？—— 不需要；改为直接验证事务已启用：`clearByImportId` 在两个 `DELETE` 之间注入异常不易，**故本项以 T7-8 的级联回归 + 现有 clear 用例覆盖**；如要强验证，可在 `tx.test.ts` 覆盖 `inTransaction` 回滚（已含）。
- `ytdlp-routes.test.ts`：T7-3、T7-8 两条。
- `imports.ts` 去重后跑全量 server test：既有 `/api/imports` 派生列用例（line ~1053-1087）必须继续全绿（回归保护）。

**Verify**
- `pnpm --filter @sct/server test` + `pnpm --filter @sct/server typecheck`
- `pnpm --filter @sct/web typecheck` + `pnpm --filter @sct/web build`

**Serial**：改 `studio-detail.tsx`（T5/T6 之后）、`studio.tsx`、`library.tsx`、`clip-projects.ts`（T3 之后）、`imports.ts`、`source-videos.ts`。

---

## Task 8：收尾验证

**Files**：无新增（纯验证 + 目验清单）。

**Steps**
- 全量跑：`pnpm typecheck`（三包 0 错）+ `pnpm --filter @sct/server test`（基线 242 + 本阶段增量，全绿）+ `pnpm --filter @sct/web build`（0 错）。
- `git status --short` 核对改动文件与计划「Files」一致，无意外产物（尤其不得有 `derived/`、临时 PNG 进仓库）。
- 汇编手工目验清单（见下），写入本阶段 report。

**手工目验清单（剪辑闭环，spec §0.8 #5）**
- [ ] 剪辑室媒体卡「编辑」→ 进 `/studio/:importId`；页面头显示来源名 + 「第 N 集」（单视频不显示）。
- [ ] 无素材来源进详情 → D17 空态 + 「去资料库下视频」；剪辑室里该来源「编辑」按钮禁用 + tooltip。
- [ ] 画面 + 画轨（胶片条）+ 音轨（波形）同屏；首帧派生图生成期间不白屏（图加载失败有 onError 日志）。
- [ ] 加 3 段 → 拖动改点 → 保存 → 刷新后仍在 → 分 3 段导出得 3 条（标题带 `[mm:ss-mm:ss]`）→ 合并导出得 1 条（标题带 `[共3段]`）。
- [ ] 换集（资料库重下另一集）→ 剪辑详情派生图**重新生成**（不是上一集的波形/画面）；已保存剪辑点按 D19 被清并提示。
- [ ] 「清空所有剪辑点」二次确认；确认后段清空，已导出音频仍在剪辑室。
- [ ] 日志页可见：派生图「生成开始/命中缓存/失败(stderr)」、工程「保存/删除」、导出 job「created/done/失败」。

**Verify**：同上三条命令。

**Serial**：最后执行（依赖全部前置）。

---

## 附：任务依赖与串行约束一览

| 共享文件 | 涉及任务 | 约束 |
|---|---|---|
| `server/src/index.ts` | T2 → T3 → T4 | **串行**（同一文件，禁并行编辑） |
| `server/src/ytdlp/ytdlp-routes.ts` | T2 → T4 →（T7 测试同文件） | **串行** |
| `server/src/media/media-routes.ts` | T2 | 独占 |
| `server/src/media/project-routes.ts` | T3 → T4 | **串行** |
| `server/src/db/repo/clip-projects.ts` | T3 → T7 | **串行** |
| `server/src/db/repo/imports.ts` | T7 | 独占 |
| `server/src/logs.ts` | T3 | 独占（加 `'project'`） |
| `web/src/api.ts` | T5 → T6 | **串行** |
| `web/src/pages/studio-detail.tsx` | T5 → T6 → T7 | **串行** |
| `web/src/pages/studio.tsx` | T7 | 独占 |
| `web/src/pages/library.tsx` | T7 | 独占 |

**门禁**：T1 实测已完成（报告在 `task-p4-1-report.md`）→ T2 可开工。其余任务按编号顺序串行推进（后一任务不得早于前一任务合并前开工同一共享文件）。
