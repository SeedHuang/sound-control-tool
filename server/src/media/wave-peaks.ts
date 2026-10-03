// server/src/media/wave-peaks.ts
// Spec B D2 · 多级波形峰值：服务端提取**峰值数组**（JSON），前端 Canvas 按当前缩放档位自绘。
// 数据源 = astats 修正链路（实测 B3b/B3c），**解析 stderr** —— `-f null -` 不产出文件。
//
// ⚠️ 三条铁律（都是实测踩出来的，别"优化"回去）：
//   ① `reset=1` 固定。字面 `reset=44100` 实测 **480s 超时 + 334MB 日志**（B3a）—— 根因是它把 reset
//      参数当成了采样数，且不带 key 时 ametadata 把 ~170 个指标/帧全打出来。
//   ② 只 `print:key=...RMS_level` 一个键。同上：日志爆炸才是慢的根因（不是解码）。
//   ③ 拿不到 RMS 行 → **明确失败**，绝不落一个空 points 的 JSON —— 前端会把它画成一条平线，
//      用户以为"这段没声音"，那是撒谎。
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DB } from '../db/index.js';
import { pushLog } from '../logs.js';
import type { probeDuration } from '../ytdlp/ffprobe.js';
import { FILM_META_V, RMS_METADATA_KEY, WAVE_NSAMPLES, checkLevelAvailable, segmentCount, segmentSpan, wavePeakArgs, waveShapeSig, type FilmLevel } from '../ffmpeg/derived-args.js';
import { classifySrcChange, derivedFileName, probeDurationFor, srcIdentityOf, tail, type ExecLike, type FilmSegRef } from './derived-images.js';
import { resolveFfmpegPath } from './ffmpeg-path.js';

/** 峰值凭据：七项字段（spec D4 定的契约）。points 是 RMS（dB，-99 = 静音/无效）。 */
export type WavePeakData = {
  v: number; sig: string; level: FilmLevel; seg: number; t0: number; stepSec: number; points: number[];
};

/** stderr 里 RMS 行的键：`=` 拼在常量后（键名本身是 derived-args 的单一来源，两边共用）。 */
const RMS_KEY = `${RMS_METADATA_KEY}=`;

/** stderr 尾行摘要走 derived-images 的 `tail`（唯一一份，见那里的注释）。 */

/**
 * 从 stderr 里抽 RMS 序列（**顺序即时间顺序**，ametadata=print 按窗打印）。
 * - 只认带 RMS_KEY 的行 —— ffmpeg 的进度行、统计行混在 stderr 里，不能误当数据。
 * - `-inf` / `inf` / `nan` 一律折成 **-99**：JSON 没有 Infinity/NaN 字面量，
 *   `JSON.stringify` 会把它们写成 `null`，前端 JSON.parse 后画不出东西还会报 NaN 错。
 *   -99 = 「这一窗没有有效电平」，前端按静音画（一条基线），语义诚实。
 */
export function parseRmsStderr(stderr: string): number[] {
  const out: number[] = [];
  for (const raw of stderr.split(/\r?\n/)) {
    const line = raw.trim();
    const i = line.indexOf(RMS_KEY);
    if (i < 0) continue;
    const v = Number.parseFloat(line.slice(i + RMS_KEY.length).trim());
    out.push(Number.isFinite(v) ? v : -99);
  }
  return out;
}

/** 拼凭据 JSON。v 与 sig 由本函数填（调用方只给"这张图是什么"的部分）。 */
export function buildWavePeakJson(d: { level: FilmLevel; seg: number; t0: number; stepSec: number; points: number[] }): string {
  return JSON.stringify({
    v: FILM_META_V,
    sig: waveShapeSig(d.level),
    level: d.level,
    seg: d.seg,
    t0: d.t0,
    stepSec: d.stepSec,
    points: d.points,
  });
}

/**
 * 命中判定：文件存在 + size>0 + v 对得上 + sig 逐字相同 + 至少有一个点。
 * **不走 `checkDerivedCache`**：那个函数只懂 PNG（它比的是图片的 meta 字段），
 * 把 JSON 的校验塞进去只会让两边都难读。
 */
function readPeakIfFresh(path: string, level: FilmLevel): WavePeakData | null {
  try {
    if (statSync(path).size <= 0) return null;
    const o = JSON.parse(readFileSync(path, 'utf8')) as Partial<WavePeakData>;
    if (o === null || typeof o !== 'object') return null;
    if (o.v !== FILM_META_V) return null;
    if (o.sig !== waveShapeSig(level)) return null;
    if (typeof o.level !== 'number' || typeof o.seg !== 'number' || typeof o.t0 !== 'number' || typeof o.stepSec !== 'number') return null;
    if (!Array.isArray(o.points) || o.points.length === 0) return null;
    if (!o.points.every((p) => typeof p === 'number')) return null;
    return o as WavePeakData;
  } catch { return null; }
}

export type WavePeakResult =
  | { ok: true; data: WavePeakData; cached: boolean }
  | { ok: false; code: 'NO_FFMPEG' | 'FFMPEG_FAIL' | 'SRC_CHANGED' | 'PROBE_FAIL' | 'SEGMENT_NOT_FOUND' | 'LEVEL_UNAVAILABLE'; message: string };

/**
 * 生成（或命中）某档某段的波形峰值。
 *
 * **不做在途合并**：峰值生成是秒级（L0 实测 2.31s），而 PNG 雪碧图是十秒量级（L0 36 格 10.29s）；
 * 前端同一时刻只会要当前档位当前窗口的那些段，重复请求的概率低；真撞上最多各跑一次 ffmpeg，代价可接受 ——
 * 不为它引入第二份在途表（那是 PNG 那边因为要跑十秒才必须有的东西）。
 *
 * ⚠️ 2026-10-03（OCR 审查修复）：`durationSec` 改为**懒求值**（回调或直接给值）。
 * 原签名把它设成必填 `number`，导致调用方（`media-routes.ts`）**必须在调用前先探时长** ——
 * 于是**缓存命中路径也付了一次 ffprobe**（2.1GB 素材上可能十几秒），把 PNG 那边刻意保住的
 * 「命中缓存零 ffprobe」特性在波形链路上丢掉了。
 * 现在它只在**未命中**时才被求值（算末段窗口 + stepSec 都要用），命中直接返回。
 *
 * 末段窗长用 `segmentSpan` 收窄（不虚构超出片尾的时间）；`stepSec` 用**实际得到的点数**反推，
 * 这样非 48kHz 素材上波形也不会与时间轴错位。
 */
export async function ensureWavePeaks(o: {
  level: FilmLevel; seg: number; importId: number; videoPath: string;
  derivedDir: string; tempDir: string; db: DB;
  /**
   * 素材时长：**不传则本函数自己探**（懒 —— 只在未命中路径探，命中缓存一次 ffprobe 都不付）。
   * ⚠️ 2026-10-03（OCR 审查第 2 轮，high）：上一版把它做成「路由层传懒回调」，结果回调里
   * `throw new Error(pr.message)` **只带了 message、丢了 `pr.code`**，而这里的 catch 一律映射成 PROBE_FAIL ——
   * 于是 **ffprobe 缺失（NO_FFMPEG，该去设置页）被报成 PROBE_FAIL（去重下素材）**，把用户引去错的地方，
   * 正是本批反复要避免的那类误导。现在改成「不传就内部调 `probeDurationFor` 并**原样透传 code**」。
   * 传 number 的用法保留（测试与「调用方已探过」的场合）。
   */
  durationSec?: number;
  /** 探测注入点（测试用；生产走 probeDurationFor 的默认实现） */
  probe?: typeof probeDuration;
  doExec?: ExecLike; resolveFfmpeg?: (db: DB) => Promise<string | null>;
  sourceState?: (p: string) => 'current' | 'replaced' | 'gone';
}): Promise<WavePeakResult> {
  // 文件名：L0 不带段号（整片一张），L1/L2 带 —— 与 derivedFileName 的约定一致（单一来源）
  const segRef: FilmSegRef | undefined = o.level === 0 ? undefined : { level: o.level, seg: o.seg };
  const dest = join(o.derivedDir, derivedFileName('wavePeak', o.importId, segRef));
  const hit = readPeakIfFresh(dest, o.level);
  if (hit !== null) {
    pushLog('debug', 'media', `波形峰值命中缓存 import=${o.importId} L${o.level}-${o.seg} points=${hit.points.length}`);
    return { ok: true, data: hit, cached: true };
  }
  const resolve = o.resolveFfmpeg ?? resolveFfmpegPath;
  const bin = await resolve(o.db);
  if (bin === null) {
    pushLog('error', 'media', `波形峰值失败：ffmpeg 未找到 import=${o.importId} L${o.level}-${o.seg}`);
    return { ok: false, code: 'NO_FFMPEG', message: 'ffmpeg 未找到或未配置：请到设置页配置 ffmpeg 路径' };
  }
  const n = WAVE_NSAMPLES[o.level];
  // 未命中才求值时长（懒：命中路径在上面就 return 了，一次 ffprobe 都不付）
  let durationSec: number;
  if (o.durationSec !== undefined) {
    // ⚠️ 调用方直接给的时长也要校验（2026-10-03 OCR 审查第 11 轮 medium）：探测路径由 probeDurationFor
    //   保证是正数，但**直传路径没有** —— NaN/Infinity 会算出 `stepSec: null`（JSON 无 NaN 字面量）落进产物，
    //   前端时间轴错位；readPeakIfFresh 又会因 typeof 不符判不新鲜 → 该档每次请求都重跑 ffmpeg（无声黑洞）。
    if (!Number.isFinite(o.durationSec) || o.durationSec <= 0) {
      pushLog('error', 'media', `波形峰值失败：调用方传入的时长非法 import=${o.importId} L${o.level}-${o.seg} duration=${String(o.durationSec)}`);
      return { ok: false, code: 'PROBE_FAIL', message: '素材信息读取失败，无法生成波形：时长非法' };
    }
    durationSec = o.durationSec;
  } else {
    // 内部探（OCR 审查第 2 轮 high）：**原样透传 code** —— NO_FFMPEG（去设置页）与 PROBE_FAIL
    // （去重下素材）是两种出路，混成一个就把用户引去错的地方了。
    const pr = await probeDurationFor({ db: o.db, videoPath: o.videoPath, ffmpegPath: bin, probe: o.probe });
    if (!pr.ok) {
      pushLog('error', 'media', `波形峰值失败：${pr.code} import=${o.importId} L${o.level}-${o.seg} msg=${pr.message}`);
      return { ok: false, code: pr.code, message: pr.message };
    }
    durationSec = pr.durationSec;
  }
  // 档位门槛 + 段号越界（与分段雪碧图**同一份判定**，2026-10-03 OCR 审查第 5 轮 medium）。
  // 为什么要补门槛：原来这里只挡越界，素材放不下该档时 /filmseg 返 404 而 /wavepeak 仍 200 返回数据 ——
  // 同一档位两个产物给出相反结论（前端虽有 levelUsable 兜住，但 API 契约层面已分叉）。
  if (o.level !== 0) {
    const avail = checkLevelAvailable(durationSec, o.level);
    if (!avail.ok) {
      pushLog('info', 'media', `波形峰值跳过：档位不可用 import=${o.importId} L${o.level} duration=${durationSec.toFixed(2)}s`);
      return { ok: false, code: 'LEVEL_UNAVAILABLE', message: avail.message };
    }
    // 越界不给它兜住的话：segmentSpan 返回 span=0 → ffmpeg 拿到 `-t 0` → 没有 RMS 行 →
    // 报成「素材可能没有音轨」（**误导**：用户会以为片子没声音，其实只是段号不对）。
    const segCount = segmentCount(durationSec, o.level);
    if (o.seg >= segCount) {
      pushLog('info', 'media', `波形峰值跳过：段号越界 import=${o.importId} L${o.level} seg=${o.seg} 共${segCount}段`);
      return { ok: false, code: 'SEGMENT_NOT_FOUND', message: `段号 ${o.seg} 超出范围（本档共 ${segCount} 段，编号 0–${segCount - 1}）` };
    }
  }
  // L0 走全片（不加 -ss/-t）；L1/L2 用 segmentSpan 算窗口（末段按实际余数收窄）
  const seg = o.level === 0 ? null : segmentSpan(durationSec, o.level, o.seg);
  const args = wavePeakArgs(o.videoPath, seg, n);
  const srcId = srcIdentityOf(o.videoPath);
  pushLog('info', 'media', `波形峰值生成开始 import=${o.importId} L${o.level}-${o.seg} n=${n} args=${args.join(' ')}`);
  const doExec = o.doExec ?? execFile;
  const run = await new Promise<{ ok: boolean; stderr: string }>((resolveRun) => {
    // maxBuffer 给足：1600 行 RMS + ffmpeg 进度行实测 ~233KB，8MB 留余量
    doExec(bin, args, { timeout: 120_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, _stdout, stderr) => {
      if (err) {
        const e = err as NodeJS.ErrnoException;
        pushLog('error', 'media', `波形峰值 ffmpeg 失败 import=${o.importId} L${o.level}-${o.seg} code=${e.code ?? '?'} stderr=${tail(stderr)}`);
        resolveRun({ ok: false, stderr: stderr ?? '' });
        return;
      }
      resolveRun({ ok: true, stderr: stderr ?? '' });
    });
  });
  if (!run.ok) return { ok: false, code: 'FFMPEG_FAIL', message: `波形峰值提取失败：${tail(run.stderr)}` };
  const points = parseRmsStderr(run.stderr);
  if (points.length === 0) {
    // 诚实原则：没有数据就说没有，不落空 JSON 让前端画一条假平线
    pushLog('error', 'media', `波形峰值失败：stderr 里没有 RMS 行 import=${o.importId} L${o.level}-${o.seg} stderr=${tail(run.stderr)}`);
    return { ok: false, code: 'FFMPEG_FAIL', message: '波形峰值提取失败：ffmpeg 未输出音频统计（素材可能没有音轨）' };
  }
  // 落盘前复核素材身份（与 PNG 同款变局分类，口径共用 classifySrcChange —— 唯一一份）：
  // 旧内容的峰值 JSON 凭 sig 自洽会**永久命中**（sig 里只有 level/span/n，不含素材身份），
  // 必须在 rename 之前拦住 —— 过了这一关再没有任何机制能发现它是旧素材的。
  const srcChanged = classifySrcChange(o.videoPath, srcId, o.sourceState);
  if (srcChanged !== null) {
    pushLog('info', 'media', `波形峰值产物丢弃：素材在生成期间被${srcChanged === 'replaced' ? '替换' : '删除'} import=${o.importId} L${o.level}-${o.seg}`);
    return srcChanged === 'replaced'
      ? { ok: false, code: 'SRC_CHANGED', message: '素材在生成期间被替换，产物已丢弃；重新打开页面会按新素材重新生成' }
      : { ok: false, code: 'SRC_CHANGED', message: '素材已被删除，产物已丢弃；请重新下载视频后再查看' };
  }
  // stepSec 用**实际点数**反推：非 48kHz 素材的点数会按采样率比例偏移，而 span 是定值 ——
  // 硬算 n/48000 会让波形与时间轴错位（前端靠 t0 + stepSec 定位每个点）。
  const stepSec = (seg === null ? durationSec : seg.span) / points.length;
  const json = buildWavePeakJson({ level: o.level, seg: o.seg, t0: seg?.t0 ?? 0, stepSec, points });
  const uniq = `${Date.now()}-${randomBytes(4).toString('hex')}`;
  const tmp = join(o.tempDir, `wavepeak-${o.importId}-L${o.level}-${o.seg}-${uniq}.json`);
  try {
    mkdirSync(o.derivedDir, { recursive: true });
    writeFileSync(tmp, json, 'utf8');
    renameSync(tmp, dest); // 同盘原子：前端不会读到半截 JSON
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch { /* 尽力清理 */ }
    const msg = e instanceof Error ? e.message : String(e);
    pushLog('error', 'media', `波形峰值落盘失败 import=${o.importId} L${o.level}-${o.seg}: ${msg}`);
    return { ok: false, code: 'FFMPEG_FAIL', message: `波形峰值落盘失败：${msg}` };
  }
  pushLog('info', 'media', `波形峰值生成完成 import=${o.importId} L${o.level}-${o.seg} points=${points.length} stepSec=${stepSec.toFixed(5)} bytes=${statSync(dest).size}`);
  return { ok: true, data: JSON.parse(json) as WavePeakData, cached: false };
}
