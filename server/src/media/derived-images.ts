// 派生图（波形/胶片条，spec D6/D14/§0.3）：服务端 ffmpeg 生成固定尺寸 PNG → <数据目录>/derived/，
// 命中判定 = 文件存在且 size>0（零字节残留不算命中）；胶片条另需 .meta 旁路文件，
// 里面记着**决定产物形状的参数**（schema 版本、格数、宽高、fps 公式标识、实测滤镜串），
// 命中时逐项与「当前代码算出来的值」比对，任何一项对不上就判失效重生成（见 checkDerivedCache）。
// 落盘走「临时名 → rename」：图与 meta 都先落临时名，再连着 rename，中间失败整体回滚，不留半成品。
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DB } from '../db/index.js';
import { pushLog } from '../logs.js';
import { probeDuration } from '../ytdlp/ffprobe.js';
import { FILM_LEVEL_TILES, FILM_META_V, buildWaveformArgs, filmCellArgs, filmCellName, filmShapeSig, filmTileArgs, sampleTimes, tilesFor, type FilmLevel } from '../ffmpeg/derived-args.js';
import { resolveFfmpegPath } from './ffmpeg-path.js';

export type DerivedKind = 'wave' | 'film' | 'filmSeg' | 'wavePeak';
export type ExecLike = typeof execFile;

/** 分段引用（Spec B）：level 只可能 1/2 —— L0 是整片一张，不需要段号。 */
export type FilmSegRef = { level: 1 | 2; seg: number };

/**
 * 派生图文件名的**词根与前缀**（命名契约的单一来源）。
 * `derivedFileName` 拼名、`invalidateDerived` 判名，两边都从这里取 ——
 * 改前缀/扩展名时不会出现「生成改了、清理没改」的漂移（那会让旧图在换源后继续命中缓存）。
 * ⚠️ 2026-10-03 OCR 审查第 10 轮 medium：此前 `invalidateDerived` 里是手写字面量，与本文件不一致。
 */
export const DERIVED_STEMS = {
  film: 'film',
  wave: 'wave',
  filmSeg: 'film',
  wavePeak: 'wavepeak',
  ext: '.png',
  jsonExt: '.json',
  metaExt: '.meta',
  /** 段级标记：段图名里 level 之前必须有它（`film-<id>-L<lv>-<seg>.png`）。
   *  清理时前缀写成 `film-<id>-L`（**带这个 L**）—— 少它就会误伤 `film-11-*`（importId=11 的段图）。 */
  segMarker: '-L',
} as const;

/**
 * 派生图文件名（**单一来源**：命中判定 / 生成 / 清理三处共用 —— 各写一份必然漂移）。
 * **L0 沿用 legacy 名 `film-<id>.png`**：URL 与文件名都不变，老前端与老缓存引用继续有效（spec D1「接管现有路由」）。
 * 分段图加 `-L<lv>-<seg>`，峰值 JSON 用 `wavepeak-` 前缀（与 PNG 混在同一目录里靠扩展名区分）。
 * ⚠️ 清理侧的前缀匹配必须精确段（`film-1-` 会误伤 `film-11-`）—— 见 invalidateDerived。
 */
export function derivedFileName(kind: DerivedKind, importId: number, seg?: FilmSegRef): string {
  const S = DERIVED_STEMS;
  if (kind === 'film' || kind === 'wave') return `${S[kind]}-${importId}${S.ext}`;
  // ⚠️ `filmSeg` 缺 seg 必须在这里就拒（2026-10-03 OCR 审查第 1 轮 medium）：
  //   下面第 54 行对 `seg === undefined` 会取 `lv = 0` → 返回 **`film-<id>-L0.png`** ——
  //   那正是 L0 总览图的合法文件名。于是 `generateDerivedImage`（第 312 行直接调本函数算 dest）
  //   在入参错误（kind=filmSeg 却没给段引用）时会把**段图写到总览图的名字上**，把总览覆盖掉。
  //   原来只有 `checkDerivedCache` 与 `ensureDerivedImage` 的 L0 分支**间接**挡着（靠分支顺序），
  //   那是两处隐式约定、不是一处显式校验 —— 改动顺序就会炸。在命名入口拒绝，本函数自己守住契约。
  if (kind === 'filmSeg' && seg === undefined) {
    throw new Error(`derivedFileName: filmSeg 必须给段引用（level 与 seg），importId=${importId} —— 缺它会算出 L0 总览的文件名并覆盖总览图`);
  }
  const lv = seg?.level ?? 0;
  // 档位标记**恒出现**：L0 形如 `-L0`、L1/L2 形如 `-L1-3`（后者多一个段号）。
  // ⚠️ L0 也带 `-L0`（`wavepeak-1-L0.json`）：level 是这个文件名的**寻址维度**，
  //   少了它就无法与 L1/L2 区分（那是同一素材同一档位的不同产物）。
  const segPart = lv === 0 ? `${S.segMarker}0` : `${S.segMarker}${lv}-${seg!.seg}`;
  if (kind === 'filmSeg') return `${S.filmSeg}-${importId}${segPart}${S.ext}`;
  return `${S.wavePeak}-${importId}${segPart}${S.jsonExt}`;
}

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

/**
 * ffprobe 的兄弟路径（同 clip-job.ts 的 ffprobePathFrom 一行口径）。
 * **推导口径只此一份**：L0 生成（本文件）与 L1/L2 分段生成（derived-pyramid.ts）都调它 ——
 * 各写一份字符串替换必然漂移，而漂移的后果正是 OCR F3 那桩冤案（ffprobe 缺失被当成「素材损坏」）。
 */
export function derivedProbePath(ffmpegPath: string): string {
  return ffmpegPath.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1');
}

export type ProbeResult = { ok: true; durationSec: number } | { ok: false; code: 'NO_FFMPEG' | 'PROBE_FAIL'; message: string };

/**
 * 探素材时长（含 ffprobe 路径推导与存在性检查）。**时长探测口径只此一份**：
 * L0 生成、L1/L2 分段生成（门槛判定要先知道时长）都走它。
 *
 * 为什么 ffprobe 缺失必须报 NO_FFMPEG 而不是 PROBE_FAIL：那是**环境没配好**，用户该去设置页；
 * 报成 PROBE_FAIL 会把人引去重下素材（OCR F3 的原话：「把人引去错的地方」）。
 *
 * ffmpegPath 若调用方已经解析过就传进来，省一次 DB/PATH 解析（L0 路径已经解析过，分段路径没有）。
 */
export async function probeDurationFor(o: {
  db: DB; videoPath: string; ffmpegPath?: string;
  resolveFfmpeg?: (db: DB) => Promise<string | null>; probe?: typeof probeDuration;
}): Promise<ProbeResult> {
  let ff = o.ffmpegPath;
  if (ff === undefined) {
    const resolve = o.resolveFfmpeg ?? resolveFfmpegPath;
    const r = await resolve(o.db);
    if (r === null) return { ok: false, code: 'NO_FFMPEG', message: 'ffmpeg 未找到或未配置：请到设置页配置 ffmpeg 路径' };
    ff = r;
  }
  const ffprobePath = derivedProbePath(ff);
  if (!existsSync(ffprobePath)) {
    pushLog('error', 'media', `派生图失败：ffprobe 未找到 ffprobe=${ffprobePath}`);
    return { ok: false, code: 'NO_FFMPEG', message: 'ffprobe 未找到（需与 ffmpeg 同目录）：请到设置页检查 ffmpeg 路径' };
  }
  const probe = o.probe ?? probeDuration;
  const durationSec = await probe(ffprobePath, o.videoPath, PROBE_TIMEOUT_MS);
  if (durationSec === null || !(durationSec > 0)) {
    pushLog('error', 'media', `派生图失败：探测不到素材时长 path=${o.videoPath} probeTimeoutMs=${PROBE_TIMEOUT_MS}`);
    // ⚠️ 文案**不提具体产物**（2026-10-03 OCR 审查第 12 轮 medium）：本函数也服务波形峰值链路，
    //   原先写「无法生成画轨」→ 波形请求失败时会给用户报「画轨」这个不相干的产物名。
    //   `DERIVED_FAIL.next` 刻意保持产物中性，这里同理。
    return { ok: false, code: 'PROBE_FAIL', message: '素材信息读取失败：视频文件可能未下载完整或已损坏' };
  }
  return { ok: true, durationSec };
}

/**
 * 胶片条旁路文件 <kind>-<importId>.png.meta（或分段图 `<名>.meta`）的内容。
 * Spec B (T2) 起形态升到 v3 —— 字段从 (v,sig,durationSec,vf) 变成 (v,level,sig,durationSec,tiles)：
 * - v：schema 版本（常量在 derived-args.ts，**本文件不再自己定一份** —— 两处各留一个必然漂移），
 *   不等于 FILM_META_V 直接判失效（旧版本的 meta 一律不认）。
 * - level：档位 0/1/2。命中时与请求的档位比对 —— 同一 importId 的 L0 与 L1 段图是不同的产物。
 * - sig：形状签名（derived-args.ts 的 filmShapeSig 派生）—— schema/level/格数/格子尺寸都在里面。
 * - durationSec：生成时探到的时长（纯记录，也是采样点的依据）。Spec B 起**不再靠它"重算公式"**：
 *   逐格 seek 的采样点由 sampleTimes 按 (level, seg) 算，时长不参与签名 —— 少一重比对，也少一重漂移。
 * - tiles：本图实际拼了多少格，与 FILM_LEVEL_TILES[level] 比对。
 * - generatedAt：生成时间，纯记录。
 * **旧 vf 字段已删**：L0 从「一次 fps 滤镜整解码」换成「逐格 seek」，不再有单一滤镜串可言。
 * 不记 waveform：波形参数与素材无关，没有算错的可能，让它重画只是白跑一次 ffmpeg。
 */
export type FilmMeta = { v: number; level: FilmLevel; sig: string; durationSec: number; tiles: number; generatedAt: string };

function readFilmMeta(pngPath: string): FilmMeta | null {
  try {
    const mp = `${pngPath}.meta`;
    if (statSync(mp).size <= 0) return null;
    const parsed = JSON.parse(readFileSync(mp, 'utf8')) as unknown;
    // JSON.parse('123') 合法且 !== null —— 不做形状校验就会把一个数字当凭据放行（审查 Important 1）
    if (parsed === null || typeof parsed !== 'object') return null;
    const m = parsed as Partial<FilmMeta>;
    if (m.v !== FILM_META_V) return null;
    if (typeof m.sig !== 'string' || typeof m.durationSec !== 'number' || typeof m.tiles !== 'number') return null;
    if (m.level !== 0 && m.level !== 1 && m.level !== 2) return null;
    return { v: FILM_META_V, level: m.level, sig: m.sig, durationSec: m.durationSec, tiles: m.tiles, generatedAt: typeof m.generatedAt === 'string' ? m.generatedAt : '' };
  } catch { return null; }
}

export type DerivedCacheCheck = { path: string; reason: null } | { path: null; reason: string };

/**
 * 命中判定（D14：中断残留的零字节不算命中）。
 *
 * 胶片条额外做**真比对**（2026-10-02 审查修复轮 1 important 1）：不是「meta 存在即算数」，而是逐项对：
 * ① meta 能解析且 v 对得上；② level 与请求的档位一致（同一 importId 的 L0 与 L1 段图是不同产物）；
 * ③ tiles 与 FILM_LEVEL_TILES[level] 一致；④ sig 与当前代码常量算出的形状签名逐字相同
 *   （schema/level/格数/格子尺寸都在里面）。
 * ②③④ 覆盖了「改档位 / 改格数 / 改格子尺寸 / 改 schema」四类改动 —— 老图一律判失效重画。
 *
 * **为什么比对不需要 ffprobe**：四条全部只用「代码常量」与「meta 里已经记着的值」，不重新探素材 ——
 * 这是「自愈」与「开页速度」之间的取舍结论：**每次命中都全量比对（零 ffprobe、零额外 IO，
 * 多读一个几百字节的 json）**，代价只是「素材文件被人在磁盘上换掉、但没走 invalidateDerived」
 * 这种极少见的情况发现不了 —— 那条由 invalidateDerived（素材变化时删图删 meta）负责，
 * 是本次改动之前就有的机制。反过来「命中时探一次时长」会怎样：2.1GB 的文件每开一次编辑页
 * 都要付几秒到几十秒的 ffprobe，那是拿一个必然发生的慢操作换一个基本不发生的漏判，不划算。
 * （Spec B 起 durationSec 不参与比对：采样点由 sampleTimes 按 level/seg 算，与时长无关。）
 */
export function checkDerivedCache(derivedDir: string, kind: DerivedKind, importId: number, seg?: FilmSegRef): DerivedCacheCheck {
  if (kind === 'filmSeg' && seg === undefined) return { path: null, reason: '缺少段引用（filmSeg 必须给 level 与 seg）' };
  const p = join(derivedDir, derivedFileName(kind, importId, seg));
  let size = 0;
  try { size = statSync(p).size; } catch { return { path: null, reason: '文件不存在' }; }
  if (size <= 0) return { path: null, reason: '零字节残留' };
  if (kind === 'film' || kind === 'filmSeg') {
    const lv: FilmLevel = kind === 'film' ? 0 : seg!.level;
    const m = readFilmMeta(p);
    if (m === null) return { path: null, reason: '缺 meta / meta 不可解析 / schema 版本对不上' };
    if (m.level !== lv) return { path: null, reason: `档位不符 meta=L${m.level} 请求=L${lv}` };
    if (!Number.isFinite(m.durationSec) || m.durationSec <= 0) return { path: null, reason: 'meta 里时长非法' };
    // ⚠️ 期望格数用 `tilesFor` 现算（2026-10-03 OCR 审查第 6 轮 medium）：**末段的格数比整窗少**
    //   （少拼几格才不把画面压扁，见 tilesFor 注释），所以不能再拿 `FILM_LEVEL_TILES[lv]` 当期望值 ——
    //   那样末段图每次都会被判「格数不符」而重生成，永远命中不了缓存。
    // ⚠️ 时长校验**必须在这一句之前**（2026-10-03 OCR 审查第 7 轮 medium）：tilesFor 内部会调
    //   assertPositiveDuration，meta 里时长非法（损坏 / 手改 / 溢出）时会**抛 RangeError**，
    //   整个命中判定炸掉 → 变成没有 next 提示的裸 500，而不是本该有的「判失效 → 重生成」。
    const expectTiles = lv === 0 ? FILM_LEVEL_TILES[lv] : tilesFor(m.durationSec, lv, seg!.seg);
    if (m.tiles !== expectTiles) return { path: null, reason: `格数不符 meta=${m.tiles} 当前=${expectTiles}` };
    const sig = filmShapeSig(lv, expectTiles);
    if (m.sig !== sig) return { path: null, reason: `参数签名不符 meta=${m.sig} 当前=${sig}` };
  }
  return { path: p, reason: null };
}

export type DerivedResult =
  | { ok: true; path: string; cached: boolean }
  // LEVEL_UNAVAILABLE（Spec B D5）：这个素材**没有这一档**（太短，放不下那档的时间窗）。
  // SEGMENT_NOT_FOUND（Spec B T5）：段号越界（素材比 URL 说的短）。两者都由生成层判（只有它知道时长）。
  // 与 PROBE_FAIL 是三种成因、三条出路：不是"读不出素材"，而是"素材就这样，换档位/改段号"。
  | { ok: false; code: 'NO_FFMPEG' | 'FFMPEG_FAIL' | 'PROBE_FAIL' | 'SRC_CHANGED' | 'LEVEL_UNAVAILABLE' | 'SEGMENT_NOT_FOUND'; message: string };

/** stderr 尾行摘要（**唯一一份**，2026-10-03 OCR 审查第 3 轮 low）：截 200 字符，空则标「(无 stderr 输出)」。
 *  两条派生链路（PNG / 波形峰值）都调它 —— 截断长度或文案一改，日志的横向可比性就没了。 */
export const tail = (s: string | undefined): string => (s ?? '').trim().split('\n').slice(-1)[0]?.slice(0, 200) || '(无 stderr 输出)';
const msgOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** 素材内容身份（OCR R3/R5/R6）：单次 statSync 取 mtime+size（纯 mtime 可被 cp -p/rsync -t 骗过）。
 *  取不到（文件没了/测试桩假路径）→ null = 身份未知，key 退化为路径级、守卫跳过。
 *  **身份规则只能有这一份**：在途 key 与落盘守卫共用，两处各写一份必然漂移（R6-3）。
 *  Spec B (T4) 起导出：波形峰值链路（wave-peaks.ts）也要做同样的落盘前变局复核 ——
 *  它不该自己再写一遍 statSync 比较（那就是第二份规则）。 */
export type SrcIdentity = { mtimeMs: number; size: number } | null;
export const srcIdentityOf = (p: string): SrcIdentity => {
  try { const st = statSync(p); return { mtimeMs: st.mtimeMs, size: st.size }; } catch { return null; }
};
/** 身份的字符串形态：在途 key 用它——身份的「表达」也只此一份，字段增删时 key 自动跟着变（OCR R8）。 */
const srcIdentityKey = (id: SrcIdentity): string => (id === null ? 'unknown' : `${id.mtimeMs}:${id.size}`);
/** 相等判断同样只此一份（OCR R7）：借 srcIdentityKey 比较，字段增删时 key 与守卫一起变，不会漂移。
 *  Spec B (T4) 起导出：波形峰值链路的落盘前复核复用（同一条规则，不是第二份）。 */
export const sameSrcIdentity = (a: SrcIdentity, b: SrcIdentity): boolean =>
  a !== null && b !== null && srcIdentityKey(a) === srcIdentityKey(b);

/**
 * 落盘前的「素材变了吗」分类（**唯一一份**，2026-10-03 OCR 审查第 2 轮 low：此前 PNG 与波形峰值
 * 两条链路各内联一份同样逻辑与同样措辞，加第四种状态或改文案时必漂移）。
 * 返回 null = 没变（可以落盘）；'replaced'/'deleted' = 变了，**两种成因两条用户出路**：
 *   被替换 → 刷新页面自愈；被删除 → 引导重下。压成布尔会把「素材被整个删除」误报成「被替换」，
 *   让用户去刷新一个注定 404 的页面（OCR R9 的原话）。
 * @param srcId 请求时采样的身份（调用方在开始生成前取一次，两条链路共用同一次采样）
 */
export function classifySrcChange(
  videoPath: string,
  srcId: SrcIdentity,
  sourceState?: (p: string) => 'current' | 'replaced' | 'gone',
): 'replaced' | 'deleted' | null {
  // srcId 取不到（测试桩假路径）→ 跳过①②，只看③④（与旧行为等价，不比它更差）
  if (srcId !== null) {
    const now = srcIdentityOf(videoPath);
    if (now === null) return sourceState?.(videoPath) === 'replaced' ? 'replaced' : 'deleted';
    if (!sameSrcIdentity(now, srcId)) return 'replaced';
  }
  // ③④ 登记侧复核：文件没变但登记换人/没了，也要拦住（源健在 ≠ 产物该留）
  const state = sourceState?.(videoPath);
  if (state === 'replaced') return 'replaced';
  if (state === 'gone') return 'deleted';
  return null;
}

/**
 * 同一 (kind, importId) 正在生成时的在途合并表（2026-10-02 审查修复轮 1 important 2）。
 * 大素材的胶片条要跑十秒量级（Spec B 实测：L0 36 格 10.29s、L1/L2 单段 3.38s；Spec B 之前是整解码 45–52s），
 * 这期间缓存文件**还不存在**——用户刷新一下就会起第二个 ffmpeg 读同一个大文件，
 * CPU/IO 翻倍、两跑抢同一个 dest。这里让第二个请求**等第一个的结果**，不重复起进程。
 * 进程内即可：本仓是单机单进程 Fastify（desktop 也是一个 server 进程），派生图生成没有跨进程并发。
 * key 里带 derivedDir：不同数据目录（测试的临时目录、真机数据目录）互不串。
 */
const inflight = new Map<string, Promise<DerivedResult>>();

export async function ensureDerivedImage(o: {
  kind: DerivedKind; importId: number; videoPath: string;
  derivedDir: string; tempDir: string; db: DB;
  doExec?: ExecLike; probe?: typeof probeDuration; resolveFfmpeg?: (db: DB) => Promise<string | null>;
  /** OCR R5/R9(2026-10-03):落盘前第二重身份校验——「videoPath 指向的文件没变」≠「它仍是该 importId
   *  登记的源」。**三态而非布尔**：row 没了('gone')与 row 换人('replaced')是两种成因、两条用户出路
   *  （R9：布尔会把「素材被整个删除」误报成「被替换」，让用户去刷新一个注定 404 的页面）。
   *  未注入（测试/其他调用方）→ 跳过该重校验，行为与旧版等价。 */
  sourceState?: (videoPath: string) => 'current' | 'replaced' | 'gone';
  /** Spec B (T3 用)：分段引用。kind='filmSeg' 时必传 —— 它同时决定文件名与在途 key。 */
  seg?: FilmSegRef;
  /** Spec B (T3 用)：本图要拼多少格。未传时由 L0 路径按 FILM_LEVEL_TILES 推。 */
  tiles?: number;
  /** Spec B (T3 用)：逐格抽帧的时刻表（秒）。传了它 → **跳过时长探测**（调用方已探过，避免探两遍）。 */
  times?: number[];
  /** Spec B (T3 用)：meta 构造器。未传时由 L0 路径内部构造。 */
  metaFor?: () => FilmMeta;
}): Promise<DerivedResult> {
  // 波形峰值的产物是 JSON、解析的是 stderr，与 PNG 管线形态差太远 —— 它有自己的入口 `ensureWavePeaks`
  // （wave-peaks.ts）。走到这里说明调用方接错了管线：明确失败 + 日志，不静默。
  if (o.kind === 'wavePeak') {
    pushLog('error', 'media', `派生图入口收到 wavePeak：该产物请走 ensureWavePeaks import=${o.importId}`);
    return { ok: false, code: 'FFMPEG_FAIL', message: '波形峰值不走图片管线（请调用 ensureWavePeaks）' };
  }
  const segTag = o.seg === undefined ? '' : ` L${o.seg.level}-${o.seg.seg}`;
  const hit = checkDerivedCache(o.derivedDir, o.kind, o.importId, o.seg);
  if (hit.path !== null) {
    pushLog('debug', 'media', `派生图命中缓存 kind=${o.kind} import=${o.importId}${segTag}`);
    return { ok: true, path: hit.path, cached: true };
  }
  // OCR R3/R5(2026-10-03):在途 key 必须带「内容身份」。仅 (dir,kind,importId) 会把换源后的新请求并进
  // 旧文件的任务(拿到旧内容图);仅加 videoPath 也不够——同容器重下时 placeVideo 原名改名,file_path 不变
  // (R5-1)。折进请求时采样的身份(mtime+size,R6-2:纯 mtime 可被 cp -p 骗过)后:同路径换内容 → key 变 →
  // 另起新任务;内容没变 → 照常并入去重。身份取不到(测试桩假路径)→ 退化回路径级(与旧行为等价)。
  // Spec B (T2):**key 还必须带 seg** —— 否则 L1-0 与 L1-1 并发会被并成一个任务，两者拿到同一张段图。
  const srcId = srcIdentityOf(o.videoPath);
  const key = `${o.derivedDir}|${o.kind}|${o.importId}${segTag}|${o.videoPath}|${srcIdentityKey(srcId)}`;
  const running = inflight.get(key);
  if (running !== undefined) {
    pushLog('debug', 'media', `派生图并入在途任务（不重复起 ffmpeg）kind=${o.kind} import=${o.importId}${segTag}`);
    return running;
  }
  pushLog('debug', 'media', `派生图判失效重画 kind=${o.kind} import=${o.importId}${segTag} reason=${hit.reason}`);
  const task = generateDerivedImage(o, srcId).finally(() => { inflight.delete(key); });
  inflight.set(key, task);
  return task;
}

async function generateDerivedImage(o: Parameters<typeof ensureDerivedImage>[0], srcId: SrcIdentity): Promise<DerivedResult> {
  const dest = join(o.derivedDir, derivedFileName(o.kind, o.importId, o.seg));
  // OCR R4/R6(2026-10-03):素材内容身份由调用方在**请求时**采样后传入（R6-3：key 与守卫共用同一份采样,
  // 不存在「两处各采一次、语义漂移」）。生成期间素材被换源/删除的产物是「旧内容的图」,且 meta 记旧
  // 时长自洽会让它**永久命中**——落盘前必须复核身份,变了就丢弃(下次请求按新素材重画)。
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
  const segTag = o.seg === undefined ? '' : ` L${o.seg.level}-${o.seg.seg}`;
  const doExec = o.doExec ?? execFile;
  // 单次 exec（波形走一次；逐格 seek 走 N 次）。失败路径必记 stderr（仓库规则：三参回调 + stderr 永远记下来）
  const runOnce = (args: string[]): Promise<{ ok: boolean; reason: string }> =>
    new Promise((resolveRun) => {
      doExec(ffmpegPath, args, { timeout: 120_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, _stdout, stderr) => {
        if (err) {
          const e = err as NodeJS.ErrnoException;
          const t = tail(stderr);
          pushLog('error', 'media', `派生图 ffmpeg 失败 kind=${o.kind} import=${o.importId}${segTag} code=${e.code ?? '?'} signal=${(e as { signal?: string }).signal ?? '-'} stderr=${t}`);
          resolveRun({ ok: false, reason: `ffmpeg 失败（${e.code ?? '?'}）：${t}` });
          return;
        }
        resolveRun({ ok: true, reason: '' });
      });
    });
  /**
   * 逐格 seek + tile 拼接（实测 B1/B2：36 格 10.29s、单段 12 格 3.38s）。
   * **任一格失败即整体失败**：半张雪碧图（36 格里 5 格空）比报错更糟 —— 用户看不出少了内容。
   * cell 临时目录放 temp/（与 png 同盘才能 rename），无论成败都在 finally 里删掉。
   */
  const runFilmStrip = async (tiles: number, times: number[]): Promise<{ ok: boolean; reason: string }> => {
    const cellDir = join(o.tempDir, `cells-${o.kind}-${o.importId}${o.seg === undefined ? '' : `-L${o.seg.level}-${o.seg.seg}`}-${uniq}`);
    // ⚠️ mkdir 也要兜住（2026-10-03 OCR 审查第 4 轮 low）：它原先在 try 之外，抛出会让整个
    //   generateDerivedImage reject 掉 → 路由只看到一个没有 next 提示的裸 500（其它失败路径都有结构化码）。
    //   磁盘满 / 权限问题正是这里会发生的场景。
    try { mkdirSync(cellDir, { recursive: true }); }
    catch (e) { return { ok: false, reason: `抽帧临时目录创建失败：${msgOf(e)}` }; }
    try {
      // ⚠️ **刻意串行**（2026-10-03 OCR 审查第 11 轮 medium 的建议已评估后否决）：
      //   每次 `-ss` 抽帧都要把 2.1GB 输入重新打开 + seek，随并发上升的是**同一文件上的随机读争抢**
      //   （实测单机 HDD/SSD 上并发 3~4 次 seek 的总耗时往往高于串行，NVMe 差别不大）。
      //   本仓是单机桌面工具、瓶颈在磁盘不在 CPU，并发只会让 36 次 seek 互相拖慢。
      //   真要提速应走「一次解码 + select 多帧」而不是并发（那是另一套参数与实测，见 spec D1）。
      for (let i = 0; i < times.length; i += 1) {
        // 文件名走 filmCellName（序列契约的唯一来源）：这里与 filmTileArgs 的 %02d 各写一份的话，
        // 位宽/前缀一改 tile 就找不到输入序列，表现为「拼接失败」而非编译期错误（OCR 审查发现）。
        const cellPath = join(cellDir, filmCellName(i));
        const r = await runOnce(filmCellArgs(o.videoPath, cellPath, times[i]!));
        if (!r.ok) return { ok: false, reason: `第 ${i + 1}/${times.length} 格抽帧失败：${r.reason}` };
        // 退出码 0 ≠ 有产物（实测 G9 的教训，逐格也要查）
        let cellSize = 0;
        try { cellSize = statSync(cellPath).size; } catch { cellSize = 0; }
        if (cellSize <= 0) return { ok: false, reason: `第 ${i + 1}/${times.length} 格抽帧退出码 0 但无产物` };
      }
      const r = await runOnce(filmTileArgs(tmp, cellDir, tiles));
      if (!r.ok) return { ok: false, reason: `tile 拼接失败：${r.reason}` };
      return { ok: true, reason: '' };
    } finally {
      try { rmSync(cellDir, { recursive: true, force: true }); } catch { /* 尽力清理 */ }
    }
  };

  let filmMeta: FilmMeta | null = null;
  let runTask: () => Promise<{ ok: boolean; reason: string }>;
  if (o.kind === 'wave') {
    runTask = () => runOnce(buildWaveformArgs(o.videoPath, tmp));
  } else if (o.times !== undefined && o.tiles !== undefined && o.metaFor !== undefined) {
    // T3 路径（分段）：段信息由调用方算好 —— 它已探过时长（门槛判定要用），这里不探第二遍。
    // ⚠️ `metaFor` 与 times/tiles **捆绑校验**（2026-10-03 OCR 审查修复）：三者缺一就走下面那条
    // 「自己探时长」的分支。若只判 times/tiles 而放过 metaFor 缺失，filmMeta 会是 null → 不写 .meta
    // → 下次 checkDerivedCache 判「缺 meta」→ **每次请求都重跑整段**（L1/L2 各 12 次 seek + tile，
    // L0 达 36 次），那是个不报错的性能黑洞。所以缺 metaFor 时明确失败（见下）。
    filmMeta = o.metaFor();
    const tiles = o.tiles;
    const times = o.times;
    runTask = () => runFilmStrip(tiles, times);
  } else {
    // L0 路径：本层自己探时长、算采样点。
    // OCR 43c032a 复审 F3 的「ffprobe 缺失 → NO_FFMPEG」与「探测失败 → 明确失败不出图」
    // （2026-10-02 修「误导性胶片条」：旧实现让采样点退化成 fps=1，12 格只覆盖前 12 秒，
    //  PNG 却是标准尺寸，看起来完全正常）这两条口径现在都在 probeDurationFor 里 ——
    // L0 与 L1/L2 分段共用一份（各写一份必然漂移）。
    // ⚠️ kind='filmSeg' 却落到这里 = 调用方没给 times/tiles/metaFor（入参错误）。原来这里写的是
    // `o.seg!.level` —— 编译期断言，**运行时炸 TypeError**、请求以未捕获异常结束（2026-10-03 OCR 审查）。
    // checkDerivedCache 已把「缺 seg」判成未命中，说明这种入参是被预期的 → 显式拦住并给出可读失败。
    if (o.kind === 'filmSeg') {
      pushLog('error', 'media', `派生图入参错误：kind=filmSeg 缺 times/tiles/metaFor import=${o.importId}`);
      return { ok: false, code: 'FFMPEG_FAIL', message: '分段生成缺少 times/tiles/metaFor，请走 ensureFilmSegment' };
    }
    const pr = await probeDurationFor({ db: o.db, videoPath: o.videoPath, ffmpegPath, probe: o.probe });
    if (!pr.ok) return { ok: false, code: pr.code, message: pr.message };
    const durationSec = pr.durationSec;
    // 到这里 kind 既不是 wave 也不是 wavePeak（wavePeak 在函数开头已被拒），也不是走 T3 分支的 filmSeg
    //（上面已 return）—— 只剩 L0。写死 0 而不是 `o.kind === 'film' ? 0 : o.seg!.level`：
    // 那个非空断言的分支已不可达，留着等于把 TypeError 风险重新引回来（若将来重构挪了 guard 就会炸）。
    const lv: FilmLevel = 0;
    const tiles = FILM_LEVEL_TILES[lv];
    const times = sampleTimes(durationSec, lv, 0); // L0 只有一段（seg 恒 0）
    filmMeta = { v: FILM_META_V, level: lv, sig: filmShapeSig(lv, tiles), durationSec, tiles, generatedAt: new Date().toISOString() };
    runTask = () => runFilmStrip(tiles, times);
  }
  // 落盘前的两道预检（都在 ffmpeg 之前）：derived/ 建不出来、meta 临时名写不进去，就别白跑几十秒。
  // meta 是「这张图是按当前参数画的」的凭证，缺了它下次就会判失效重画 —— 与其那时才发现，不如现在就不跑。
  if (filmMeta !== null) {
    try {
      mkdirSync(o.derivedDir, { recursive: true });
      writeFileSync(tmpMeta, JSON.stringify(filmMeta), 'utf8');
    } catch (e) {
      dropTmp();
      pushLog('error', 'media', `派生图 meta 临时文件写入失败 kind=${o.kind} import=${o.importId}${segTag} path=${tmpMeta}: ${msgOf(e)}`);
      return { ok: false, code: 'FFMPEG_FAIL', message: `派生图参数凭据写入失败：${msgOf(e)}` };
    }
  }
  pushLog('info', 'media', `派生图生成开始 kind=${o.kind} import=${o.importId}${segTag} bin=${ffmpegPath}${filmMeta === null ? '' : ` level=L${filmMeta.level} tiles=${filmMeta.tiles} duration=${filmMeta.durationSec}`}`);
  const run = await runTask();
  if (!run.ok) { dropTmp(); return { ok: false, code: 'FFMPEG_FAIL', message: run.reason }; }
  // 退出码 0 ≠ 有产物（实测 G9）：必须再查文件存在且 size>0
  let size = 0;
  try { size = statSync(tmp).size; } catch { size = 0; }
  if (size <= 0) {
    pushLog('error', 'media', `派生图退出码 0 但无产物 kind=${o.kind} import=${o.importId} out=${tmp}`);
    dropTmp();
    return { ok: false, code: 'FFMPEG_FAIL', message: 'ffmpeg 退出码 0 但未写出产物' };
  }
  // OCR R4~R10(2026-10-03):落盘前对素材做**一次性变局分类**——分类口径与文案只此一行(R10),两道
  // 检查合一个出口,不漂移。这关必须卡在 rename 之前:旧内容的图一旦写进共享 dest,凭 meta 自洽没有
  // 任何机制能再发现它;同时堵死「旧任务后落盘覆盖新内容」——过期任务永远到不了 rename。
  //   ① 身份变了(mtime/size 不符) = 文件还在但内容被换 → 'replaced'(刷新自愈)
  //   ② 文件没了:登记还认它 = 真被删 → 'deleted'(引导重下);登记换人 = 被替换 → 'replaced'
  //   ③ 文件没变但登记换人(sourceState='replaced',换容器重下旧文件 EPERM 幸存) → 'replaced'
  //   ④ 登记没了('gone',素材被整个删除) → 'deleted'
  // 口径与波形峰值链路共用 classifySrcChange（唯一一份，见它的注释）。
  const srcChanged = classifySrcChange(o.videoPath, srcId, o.sourceState);
  if (srcChanged !== null) {
    dropTmp();
    // 删除与替换是两种成因、两条出路,不混成一句话(同 DERIVED_FAIL 表头口径):被替换刷新自愈,被删除引导重下
    pushLog('info', 'media', `派生图产物丢弃：素材在生成期间被${srcChanged === 'replaced' ? '替换' : '删除'} kind=${o.kind} import=${o.importId} path=${o.videoPath}`);
    return srcChanged === 'replaced'
      ? { ok: false, code: 'SRC_CHANGED', message: '素材在生成期间被替换，产物已丢弃；重新打开页面会按新素材重新生成' }
      : { ok: false, code: 'SRC_CHANGED', message: '素材已被删除，产物已丢弃；请重新下载视频后再查看' };
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
 * 素材一变（换集/换清晰度重下、删素材/删来源）→ **所有档位所有段**的派生图作废（spec D4）。
 * .meta 一并删：素材内容变了，旧参数画出的图和它的凭据都不再可信。
 *
 * ⚠️ **前缀精确匹配是这里唯一的坑**（spec D4 点名的真事故形态）：
 *   朴素实现 `startsWith('film-1-')` 会把 `film-11-*.png`（11 号素材的段图）一起删掉 ——
 *   11 号用户打开页面只能重新生成几十秒。规则：段图名恒为 `film-<id>-L<lv>-<seg>.png`，
 *   所以段图前缀必须写成 `film-<id>-L`（**带那个 L**）；L0 与 wave 是**无后缀精确名**，用 === 判。
 *
 * 删失败只记日志不抛：素材变化时清派生图不该让主流程挂掉（仓库规则：删除接口文件 IO 失败不让接口失败）。
 * 返回值给调用方记日志用（「清了几张」是排查素材重画的第一手数字）。
 */
export function invalidateDerived(derivedDir: string, importId: number): { removed: number } {
  const S = DERIVED_STEMS;
  /** 无段号的确切名（用 derivedFileName 生成，不手写 —— 手写就会与生成侧漂移）。 */
  const l0Peak = derivedFileName('wavePeak', importId); // 无 seg → lv=0 → 形如 wavepeak-1-L0.json
  const exact = new Set<string>([
    derivedFileName('film', importId), `${derivedFileName('film', importId)}${S.metaExt}`,
    derivedFileName('wave', importId), `${derivedFileName('wave', importId)}${S.metaExt}`, // wave 的 .meta 也清：旧版本可能写过
    l0Peak,
  ]);
  // 段图/分段峰值的**带 L 前缀** —— 少那个 L 就会误伤 importId=11/12 这类（它们以同一位数字开头）
  const segPrefix = `${S.filmSeg}-${importId}${S.segMarker}`;
  const waveSegPrefix = `${S.wavePeak}-${importId}${S.segMarker}`;
  const pngOrMeta = new RegExp(`${S.ext.replace('.', '\\.')}(${S.metaExt.replace('.', '\\.')})?$`);
  const jsonOnly = new RegExp(`${S.jsonExt.replace('.', '\\.')}$`);
  let names: string[] = [];
  try { names = readdirSync(derivedDir); } catch { return { removed: 0 }; }
  let removed = 0;
  for (const name of names) {
    const isTarget = exact.has(name)
      || (name.startsWith(segPrefix) && pngOrMeta.test(name))
      || (name.startsWith(waveSegPrefix) && jsonOnly.test(name));
    if (!isTarget) continue;
    try { rmSync(join(derivedDir, name), { force: true }); removed += 1; }
    catch (e) { pushLog('info', 'media', `清派生图失败(忽略) name=${name}: ${msgOf(e)}`); }
  }
  pushLog('debug', 'media', `清派生图 import=${importId} removed=${removed}`);
  return { removed };
}
