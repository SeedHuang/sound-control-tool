// 派生图（波形/胶片条，spec D6/D14/§0.3）：服务端 ffmpeg 生成固定尺寸 PNG → <数据目录>/derived/，
// 命中判定 = 文件存在且 size>0（零字节残留不算命中）；胶片条另需 .meta 旁路文件，
// 里面记着**决定产物形状的参数**（schema 版本、格数、宽高、fps 公式标识、实测滤镜串），
// 命中时逐项与「当前代码算出来的值」比对，任何一项对不上就判失效重生成（见 checkDerivedCache）。
// 落盘走「临时名 → rename」：图与 meta 都先落临时名，再连着 rename，中间失败整体回滚，不留半成品。
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DB } from '../db/index.js';
import { pushLog } from '../logs.js';
import { probeDuration } from '../ytdlp/ffprobe.js';
import { buildFilmstripArgs, buildWaveformArgs, filmstripShapeSig, filmstripVfFor } from '../ffmpeg/derived-args.js';
import { resolveFfmpegPath } from './ffmpeg-path.js';

export type DerivedKind = 'wave' | 'film';
export type ExecLike = typeof execFile;

/**
 * 胶片条探测时长的超时：60s。probeDuration 签名默认值 10s **不改**（clip-job / ffmpeg-export / ytdlp-routes 仍在用），
 * 这里显式放宽的理由：2026-10-01 实测 2.1GB 的视频 10s 内读不完 format=duration → 回调 err → resolve(null)，
 * 而 null 一路退化成 fps=1，画出「只覆盖前 12 秒」的胶片条。ffprobe 读时长本身很轻（只读文件尾的 moov/索引），
 * 会超时的是别的大文件全量分析。口径同 web/src/api.ts 的 getFormats：**客户端/上游超时必须大于下游**，
 * 否则「明明服务端探得到、用户却只看到降级结果」。
 */
const PROBE_TIMEOUT_MS = 60_000;

/**
 * 派生图目录 = <数据目录>/derived（与 media/、covers/ 同父目录）。单一来源：mediaDir=<数据>/media，
 * 父目录即数据目录 —— 路径拼法只此一处，别再各处各写一份。
 */
export function derivedDirFor(mediaDir: string): string {
  return join(dirname(mediaDir), 'derived');
}

/** .meta 的 schema 版本。**任何改动「读它的人怎么解释它」的地方都要 +1**，老 meta 自动判失效（v 对不上直接不认）。 */
const FILM_META_V = 2;

/**
 * 胶片条旁路文件 <kind>-<importId>.png.meta 的内容（2026-10-02 审查修复轮 1：从「只写不读的死字段」变成真参与比对）：
 * - v：schema 版本，不等于 FILM_META_V 直接判失效（旧版本的 meta 一律不认）。
 * - sig：形状签名（纯代码常量派生，见 derived-args.ts 的 filmstripShapeSig）—— tile 数/宽高/fps 公式标识都在里面。
 * - durationSec：生成时探到的时长。**它同时是「公式有没有变」的判据**：拿它按当前公式重算 vf，
 *   与下面记录的 vf 逐字比 —— 公式改了就对不上，老图自动失效，而**不需要为了比对再探一次时长**。
 * - vf：当时实际用的滤镜串（人可读，排查时一眼看出 fps/格数/宽高）。
 * - generatedAt：生成时间，纯记录。
 * 不记 waveform：波形参数与素材无关，没有算错的可能，让它重画只是白跑一次 ffmpeg。
 */
export type FilmMeta = { v: number; sig: string; durationSec: number; vf: string; generatedAt: string };

function readFilmMeta(pngPath: string): FilmMeta | null {
  try {
    const mp = `${pngPath}.meta`;
    if (statSync(mp).size <= 0) return null;
    const parsed = JSON.parse(readFileSync(mp, 'utf8')) as unknown;
    // JSON.parse('123') 合法且 !== null —— 不做形状校验就会把一个数字当凭据放行（审查 Important 1）
    if (parsed === null || typeof parsed !== 'object') return null;
    const m = parsed as Partial<FilmMeta>;
    if (m.v !== FILM_META_V) return null;
    if (typeof m.sig !== 'string' || typeof m.vf !== 'string' || typeof m.durationSec !== 'number') return null;
    return { v: FILM_META_V, sig: m.sig, durationSec: m.durationSec, vf: m.vf, generatedAt: typeof m.generatedAt === 'string' ? m.generatedAt : '' };
  } catch { return null; }
}

export type DerivedCacheCheck = { path: string; reason: null } | { path: null; reason: string };

/**
 * 命中判定（D14：中断残留的零字节不算命中）。
 *
 * 胶片条额外做**真比对**（2026-10-02 审查修复轮 1 important 1）：不是「meta 存在即算数」，而是逐项对：
 * ① meta 能解析且 v 对得上；② sig 与当前代码常量算出的形状签名逐字相同（tile 数/宽高/schema/fps 公式标识）；
 * ③ 拿 meta 里记的 durationSec 按**当前**公式重算 vf，与 meta 里记的 vf 逐字相同。
 * ②③ 覆盖了「改 tile 数 / 改宽高 / 改 schema / 改 fps 公式」四类改动 —— 老图一律判失效重画。
 *
 * **为什么比对不需要 ffprobe**：② 只用代码常量，③ 用的是「meta 里已经记着的时长」重算公式，不是重新探素材。
 * 这就是「自愈」与「开页速度」之间的取舍结论：**每次命中都全量比对（零 ffprobe、零额外 IO，多读一个几百字节的 json）**，
 * 代价只是「素材文件被人在磁盘上换掉、但没走 invalidateDerived」这种极少见的情况发现不了 —— 那条路由
 * invalidateDerived（素材变化时删图删 meta）负责，是本次改动之前就有的机制。
 * 反过来「命中时探一次时长」会怎样：2.1GB 的文件每开一次编辑页都要付几秒到几十秒的 ffprobe，
 * 那是拿一个必然发生的慢操作换一个基本不发生的漏判，不划算。
 */
export function checkDerivedCache(derivedDir: string, kind: DerivedKind, importId: number): DerivedCacheCheck {
  const p = join(derivedDir, `${kind}-${importId}.png`);
  let size = 0;
  try { size = statSync(p).size; } catch { return { path: null, reason: '文件不存在' }; }
  if (size <= 0) return { path: null, reason: '零字节残留' };
  if (kind === 'film') {
    const m = readFilmMeta(p);
    if (m === null) return { path: null, reason: '缺 meta / meta 不可解析 / schema 版本对不上' };
    const sig = filmstripShapeSig();
    if (m.sig !== sig) return { path: null, reason: `参数签名不符 meta=${m.sig} 当前=${sig}` };
    if (!Number.isFinite(m.durationSec) || m.durationSec <= 0) return { path: null, reason: 'meta 里时长非法' };
    let expectVf = '';
    try { expectVf = filmstripVfFor(m.durationSec); } catch { return { path: null, reason: 'meta 里时长非法' }; }
    if (m.vf !== expectVf) return { path: null, reason: `滤镜串与当前公式不符 meta=${m.vf} 当前=${expectVf}` };
  }
  return { path: p, reason: null };
}

export type DerivedResult =
  | { ok: true; path: string; cached: boolean }
  | { ok: false; code: 'NO_FFMPEG' | 'FFMPEG_FAIL' | 'PROBE_FAIL'; message: string };

const tail = (s: string | undefined): string => (s ?? '').trim().split('\n').slice(-1)[0]?.slice(0, 200) || '(无 stderr 输出)';
const msgOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * 同一 (kind, importId) 正在生成时的在途合并表（2026-10-02 审查修复轮 1 important 2）。
 * 2.1GB 的胶片条要跑 52 秒，这期间缓存文件**还不存在**——用户刷新一下就会起第二个 ffmpeg 读同一个大文件，
 * CPU/IO 翻倍、两跑抢同一个 dest。这里让第二个请求**等第一个的结果**，不重复起进程。
 * 进程内即可：本仓是单机单进程 Fastify（desktop 也是一个 server 进程），派生图生成没有跨进程并发。
 * key 里带 derivedDir：不同数据目录（测试的临时目录、真机数据目录）互不串。
 */
const inflight = new Map<string, Promise<DerivedResult>>();

export async function ensureDerivedImage(o: {
  kind: DerivedKind; importId: number; videoPath: string;
  derivedDir: string; tempDir: string; db: DB;
  doExec?: ExecLike; probe?: typeof probeDuration; resolveFfmpeg?: (db: DB) => Promise<string | null>;
}): Promise<DerivedResult> {
  const hit = checkDerivedCache(o.derivedDir, o.kind, o.importId);
  if (hit.path !== null) {
    pushLog('debug', 'media', `派生图命中缓存 kind=${o.kind} import=${o.importId}`);
    return { ok: true, path: hit.path, cached: true };
  }
  const key = `${o.derivedDir}|${o.kind}|${o.importId}`;
  const running = inflight.get(key);
  if (running !== undefined) {
    pushLog('debug', 'media', `派生图并入在途任务（不重复起 ffmpeg）kind=${o.kind} import=${o.importId}`);
    return running;
  }
  pushLog('debug', 'media', `派生图判失效重画 kind=${o.kind} import=${o.importId} reason=${hit.reason}`);
  const task = generateDerivedImage(o).finally(() => { inflight.delete(key); });
  inflight.set(key, task);
  return task;
}

async function generateDerivedImage(o: Parameters<typeof ensureDerivedImage>[0]): Promise<DerivedResult> {
  const dest = join(o.derivedDir, `${o.kind}-${o.importId}.png`);
  const resolve = o.resolveFfmpeg ?? resolveFfmpegPath;
  const ffmpegPath = await resolve(o.db);
  if (ffmpegPath === null) {
    // 与 clip-job 同款：拿不到 ffmpeg 必须明确失败，不得静默（spec D16）
    pushLog('error', 'media', `派生图失败：ffmpeg 未找到 kind=${o.kind} import=${o.importId}`);
    return { ok: false, code: 'NO_FFMPEG', message: 'ffmpeg 未找到或未配置：请到设置页配置 ffmpeg 路径' };
  }
  // 唯一临时名（clip-job 的 clip-<jobId>-<ts> 同族，但这里**必须再加随机段**：in-flight 只在进程内去重，
  // 而两个 server 实例指向同一数据目录时仍可能同毫秒撞名 —— 同名就是两个 ffmpeg -y 抢同一个输出，
  // 出来半张图还会被 meta 盖章「这张是对的」，等于把本次要消灭的病又请回来）。
  const uniq = `${Date.now()}-${randomBytes(4).toString('hex')}`;
  const tmp = join(o.tempDir, `${o.kind}-${o.importId}-${uniq}.png`);
  // meta 临时名也放 tempDir（与 png 同盘才能 rename；derived/ 里只留成品，进程被 kill 时垃圾也集中在 temp/）
  const tmpMeta = join(o.tempDir, `${o.kind}-${o.importId}.png.meta.${uniq}.tmp`);
  const dropTmp = (): void => {
    try { rmSync(tmp, { force: true }); } catch { /* 尽力清理 */ }
    try { rmSync(tmpMeta, { force: true }); } catch { /* 尽力清理 */ }
  };
  let args: string[];
  let filmMeta: FilmMeta | null = null;
  if (o.kind === 'wave') {
    args = buildWaveformArgs(o.videoPath, tmp);
  } else {
    const probe = o.probe ?? probeDuration;
    const ffprobePath = ffmpegPath.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1'); // 同 clip-job.ts 的 ffprobePathFrom 一行口径
    const durationSec = await probe(ffprobePath, o.videoPath, PROBE_TIMEOUT_MS);
    // 探测失败 → 明确失败，**不出图**（2026-10-02 修「误导性胶片条」）。
    // 旧实现在这里让 buildFilmstripArgs 退化成 fps=1：12 格 × 1fps = 只覆盖前 12 秒，PNG 却是标准 1600×90，
    // 看起来完全正常 —— 用户会据此以为整片长那样（这正是本次缺陷被发现的经过）。
    if (durationSec === null || !(durationSec > 0)) {
      pushLog('error', 'media', `派生图失败：探测不到素材时长 kind=film import=${o.importId} path=${o.videoPath} probeTimeoutMs=${PROBE_TIMEOUT_MS}`);
      return { ok: false, code: 'PROBE_FAIL', message: '素材信息读取失败，无法生成画轨：视频文件可能未下载完整或已损坏' };
    }
    args = buildFilmstripArgs(o.videoPath, tmp, durationSec);
    filmMeta = { v: FILM_META_V, sig: filmstripShapeSig(), durationSec, vf: filmstripVfFor(durationSec), generatedAt: new Date().toISOString() };
  }
  // 落盘前的两道预检（都在 ffmpeg 之前）：derived/ 建不出来、meta 临时名写不进去，就别白跑 52 秒。
  // meta 是「这张图是按当前参数画的」的凭证，缺了它下次就会判失效重画 —— 与其那时才发现，不如现在就不跑。
  if (filmMeta !== null) {
    try {
      mkdirSync(o.derivedDir, { recursive: true });
      writeFileSync(tmpMeta, JSON.stringify(filmMeta), 'utf8');
    } catch (e) {
      dropTmp();
      pushLog('error', 'media', `派生图 meta 临时文件写入失败 kind=film import=${o.importId} path=${tmpMeta}: ${msgOf(e)}`);
      return { ok: false, code: 'FFMPEG_FAIL', message: `派生图参数凭据写入失败：${msgOf(e)}` };
    }
  }
  pushLog('info', 'media', `派生图生成开始 kind=${o.kind} import=${o.importId} bin=${ffmpegPath}${filmMeta === null ? '' : ` duration=${filmMeta.durationSec} vf=${filmMeta.vf}`}`);
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
  if (!run.ok) { dropTmp(); return { ok: false, code: 'FFMPEG_FAIL', message: run.reason }; }
  // 退出码 0 ≠ 有产物（实测 G9）：必须再查文件存在且 size>0
  let size = 0;
  try { size = statSync(tmp).size; } catch { size = 0; }
  if (size <= 0) {
    pushLog('error', 'media', `派生图退出码 0 但无产物 kind=${o.kind} import=${o.importId} out=${tmp}`);
    dropTmp();
    return { ok: false, code: 'FFMPEG_FAIL', message: 'ffmpeg 退出码 0 但未写出产物' };
  }
  // 图与 meta 连着 rename：中途失败把已经 rename 进去的图**撤掉**，不留「有图无凭据」的半成品
  // （那种状态的后果是：图在、meta 缺 → 每次请求都判失效 → 用户反复白等 52 秒）。
  let pngMoved = false;
  try {
    mkdirSync(o.derivedDir, { recursive: true });
    renameSync(tmp, dest); // 同盘 rename 原子
    pngMoved = true;
    if (filmMeta !== null) renameSync(tmpMeta, `${dest}.meta`);
  } catch (e) {
    dropTmp();
    if (pngMoved) try { rmSync(dest, { force: true }); } catch { /* 尽力清理 */ }
    pushLog('error', 'media', `派生图落盘失败 kind=${o.kind} import=${o.importId}: ${msgOf(e)}`);
    return { ok: false, code: 'FFMPEG_FAIL', message: `派生图落盘失败：${msgOf(e)}` };
  }
  pushLog('info', 'media', `派生图生成完成 kind=${o.kind} import=${o.importId} path=${dest} bytes=${size}`);
  return { ok: true, path: dest, cached: false };
}

/**
 * 素材一变（换集/换清晰度重下、删素材/删来源）→ 派生图作废（R3-2）。删失败只记日志，不阻断主流程。
 * .meta 一并删：素材内容变了，旧参数（时长）画出的图和它的 meta 都不再可信。
 */
export function invalidateDerived(derivedDir: string, importId: number): void {
  for (const kind of ['wave', 'film'] as const) {
    for (const p of [join(derivedDir, `${kind}-${importId}.png`), join(derivedDir, `${kind}-${importId}.png.meta`)]) {
      try { rmSync(p, { force: true }); }
      catch (e) { pushLog('info', 'media', `清派生图失败(忽略) path=${p}: ${msgOf(e)}`); }
    }
  }
}
