// 纯函数：派生图 ffmpeg 参数（实测模板见 task-p4-1-report.md §F/§G）。不碰 IO，便于参数快照断言。
import { join } from 'node:path';

export const DERIVED_WAVE_W = 1600;
export const DERIVED_WAVE_H = 120;
export const DERIVED_FILM_W = 1600;
export const DERIVED_FILM_H = 90;
export const DERIVED_FILM_TILES = 12;

/** fps 上界（只夹上界、不夹下界，理由见 buildFilmstripArgs 注释）。抽成常量：它参与形状签名。 */
const FILM_FPS_UPPER = 30;

/**
 * 胶片条滤镜的「后半段」：不含 fps（fps 依赖素材时长，没法进零成本签名）。
 * 格数与宽高全部从这里派生 —— 改产物形状只改这一处，别在字符串里各写一份。
 */
const FILM_TAIL_VF = `scale=-1:${DERIVED_FILM_H},tile=${DERIVED_FILM_TILES}x1,scale=${DERIVED_FILM_W}:${DERIVED_FILM_H}`;

/**
 * 胶片条「形状签名」：只含**纯代码常量**决定的那部分参数（schema 版本 / 格数 / 宽高 / fps 公式与上界），
 * 命中缓存时逐项比对（纯读 meta 文件，零 IO 往返、零 ffprobe）。
 * - 改 tile 数 / 宽 / 高 / fps 上界 / 滤镜后半段 → 签名自动跟着变（都由上面的常量派生），老图自动判失效。
 * - **改 fps 的计算方式本身**（例如除数从 T 改成 11T/12）→ 签名不变，此时必须手动把 FILMSTAMP_SIG_V 加 1。
 *   这一条靠注释规约 + derived-args.test.ts 的断言守着；它是所有「缓存版本号」机制的共同弱点，
 *   不是本仓独有。兜底还有 invalidateDerived（素材变化时删图删 meta）。
 */
export const FILMSTAMP_SIG_V = 1;

export function filmstripShapeSig(): string {
  return `v${FILMSTAMP_SIG_V}|tiles=${DERIVED_FILM_TILES}|size=${DERIVED_FILM_W}x${DERIVED_FILM_H}|fps=min(${DERIVED_FILM_TILES}/T,${FILM_FPS_UPPER})`;
}

/**
 * 胶片条滤镜串（fps 由时长算）。抽成独立纯函数有两个用途：
 * 1) buildFilmstripArgs 拼参数；
 * 2) **命中缓存时拿 meta 里记的时长重算一遍、逐字与 meta 里的 vf 比对** ——
 *    这样「改了 fps 公式」也会让老图判失效，而**不需要在命中时探时长**（那会拖慢每一次开页，见 derived-images.ts）。
 *
 * fps 只夹上界、**不再夹下界**（2026-10-02 修正，真实缺陷：长视频胶片条只覆盖开头）：
 * - 旧下界 0.05 的理由写的是「过小 → 0 帧空产物」。这个顾虑经核实**不成立**：ffmpeg 的 fps 滤镜是
 *   「每隔 1/fps 秒取一帧」，fps 是允许小于 1 的小数，不存在「取不满整数帧就空产物」的机制。
 *   本仓 2026-10-01 实测样本：21:30 / 2.1GB 的片子用 fps=0.009302 正常出图 1600×90、12 格内容各不相同。
 * - 旧下界的真实后果：12 / 0.05 = 240 秒 —— 任何超过 4 分钟的片子，12 格只覆盖前 4 分钟，后面全丢；
 *   叠加「探测超时 → fps 退化成 1」（12 格 = 前 12 秒）就是用户今天看到的「21:30 的片子只有开头 12 秒有画」。
 * - 上界 30 保留：极短视频（< 0.4 秒）按 12/T 算会得到几十上百的 fps，为凑 12 格去无谓解码不划算。
 *
 * **采样点约定（别被「12 格正好覆盖全片」这句话误导）**：fps = tiles/T ⇒ 每格代表 1/12 时长、
 * 采样点取**区间起点**，所以末格落在 11T/12（1290 秒片子 → 1182.8 秒，距片尾 107 秒 = 8.3%）。
 * 覆盖率是完整的（12 个区间首尾相接铺满 [0, T)），但末格**不是**片尾那一帧。
 * 若哪天要让末格对齐片尾，除数应改成 tiles-1 = 11 —— 那时形状签名里的公式串也必须同步改。
 *
 * 时长必须是**已知的正数**。旧实现在 durationSec 为 null/0 时退化成 fps=1，那会画出一张
 * 「尺寸标准、看起来对、实际只覆盖开头 12 秒」的图误导用户（用户据此以为整片长那样）。
 * 现在改为直接抛错，由调用方（derived-images.ts）在探测失败时明确失败、不出图。
 */
export function filmstripVfFor(durationSec: number): string {
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    throw new RangeError(`filmstripVfFor 需要已知的正时长（收到 ${String(durationSec)}）：时长未知时不得退化出图`);
  }
  const fps = Math.min(DERIVED_FILM_TILES / durationSec, FILM_FPS_UPPER);
  return `fps=${fps.toFixed(6)},${FILM_TAIL_VF}`;
}

/**
 * 波形底图（实测 F2）：必须显式 s=1600x120 —— 不给尺寸默认 600×240；用输出侧 -s 是「先画后放大」会糊。
 * colors=<波形色>|<背景色>（0xRRGGBB 或具名色）。源无音轨时 ffmpeg 报 -22，由调用方记 stderr。
 */
export function buildWaveformArgs(videoPath: string, outPath: string): string[] {
  return [
    '-y', '-i', videoPath,
    '-filter_complex', 'showwavespic=s=1600x120:colors=0x22d3ee|0x1e293b',
    '-frames:v', '1',
    outPath,
  ];
}

/**
 * 胶片条（实测 G2）：fps=12/T 恰好出 12 帧；每格先按高 90 缩放；tile 12x1 拼一行；末段整体 scale=1600:90 定死宽。
 * **必须 -frames:v 1**：多出来的帧会变成「第二张图」（无 %d 定名直接报错），只取首格。
 * 参数计算与形状约定见 filmstripVfFor 的注释（唯一口径，别在这里另写一份公式）。
 *
 * ⚠️ **Spec B（2026-10-03）起本函数在生产代码里已无调用者**：L0 总览改成「36 格逐格 seek + tile 拼接」
 * （实测快 4.4–5.1 倍），走 filmCellArgs / filmTileArgs。这里连同 filmstripVfFor / filmstripShapeSig
 * 一起**保留**，是因为它们锁着 N0 那段「为什么不能用 fps 滤镜」的推理与实测（含「末格差一格」的采样约定），
 * 测试仍在断言它们 —— 删掉等于把踩过的坑的说明书一起扔了。要清理就单独开一次专项（F9 批那种重构）。
 */
export function buildFilmstripArgs(videoPath: string, outPath: string, durationSec: number): string[] {
  return ['-y', '-i', videoPath, '-an', '-vf', filmstripVfFor(durationSec), '-frames:v', '1', outPath];
}

// —— Spec B 时间轴分级（2026-10-03）——
// 形状签名机制沿用 N0：能由纯代码常量派生的参数全进 sig，改常量 → sig 变 → 老图自动判失效。
// 但「改采样算法本身」这类要手动加版本号的弱点，本批由 FILM_META_V 2→3 一次性兜住（老 v2 全部作废）。

/** 档位：0=总览（整片一张）、1=中景（128s 窗）、2=近景（24s 窗）。离散三档，不做无级（spec D3）。 */
export type FilmLevel = 0 | 1 | 2;

/** L0 铺满全片的格数。实测 B1：36 格逐格 seek 共 10.29s，替代 fps 滤镜整解码的 45–52s（快 4.4–5.1 倍）。 */
export const FILM_TOTAL_TILES = 36;

/** 每格终宽 160（实测 B2：12 格拼成 1920 宽）。高恒为 90（16:9 正好，2.1GB 素材实测）。 */
export const FILM_CELL_W = 160;
export const FILM_CELL_H = 90;

/** 各档格数：L0 铺满，L1/L2 每段 12 格。 */
export const FILM_LEVEL_TILES: Record<FilmLevel, number> = { 0: FILM_TOTAL_TILES, 1: 12, 2: 12 };

/**
 * 各档**成品图**的宽（= 格数 × 每格宽）。
 *
 * ⚠️ 2026-10-03（Spec B T2 落地后补记，OCR 审查发现）：tile 拼接**不再做「整体 scale 到 1600×90」**，
 * 所以成品宽度随档位变（L0 = 36×160 = 5760，L1/L2 = 12×160 = 1920），而消费方
 * （`web/src/pages/studio-detail.tsx` 的 `filmH = trackW * 90 / <成品宽>`）必须按本表的数换算 ——
 * 继续按旧口径「固定 1600 宽」算，会让 L0 的图以 1/3.6 的高度塞进框里、轨道下半留大片空白。
 * **改格数或格宽时，这里与消费方的宽度口径必须一起改**（消费方引用本函数，不另写数字）。
 */
export const FILM_SHEET_W: Record<FilmLevel, number> = {
  0: FILM_LEVEL_TILES[0] * FILM_CELL_W,
  1: FILM_LEVEL_TILES[1] * FILM_CELL_W,
  2: FILM_LEVEL_TILES[2] * FILM_CELL_W,
};

/** 各档窗长（秒）。L0 的 0 是哨兵「不切段、窗=整片」——真实窗长由 durationSec 决定。 */
export const FILM_LEVEL_SPAN_SEC: Record<FilmLevel, number> = { 0: 0, 1: 128, 2: 24 };

/**
 * 波形每段目标点数：128s 窗与 24s 窗都给 1600 点（实测 B3c 的 3840/1600 口径按比例缩到 720）。
 * 为什么要「每段点数恒定」而不是「点数随窗长变」：前端 Canvas 按可视宽度取点，恒定点数让
 * 缩放时列宽稳定，不会因为窗长不同而忽粗忽细。
 *
 * ⚠️ 2026-10-03（OCR 审查）：本常量**只被 derived-args.test.ts 引用**，生产代码不读它
 * （真正的取点数由 `wavePeakArgs` 的 N + `parseRmsStderr` 的实际行数决定）。
 * 它是「为什么 N 取 48000/3840/720」的**规格凭据** —— 改 N 时靠它对账
 * （见上面 WAVE_NSAMPLES 注释里的恒等式）。**别把它当活代码去引用**，也**别删**（删了那条恒等式就没人守了）。
 */
export const WAVE_POINTS_PER_SEG = 1600;

/**
 * astats 窗口采样数 N（48kHz 素材口径，实测 B3b/B3c）：
 * L0=48000 → 1 点/秒（1290s 片 ≈ 1290 点）；L1=3840 → 128s 窗 1600 点；L2=720 → 24s 窗 1600 点。
 * ⚠️ 素材采样率不是 48kHz 时点数会按比例偏移（44.1kHz → 约 0.92 倍），这在可接受范围内：
 *   前端按返回的 points.length 画，不硬编码点数。
 * ⚠️ 换素材前先核这条恒等式：span×48000÷N 必须恒等于 1600，改一档而不改另一档会让点密度突变。
 */
export const WAVE_NSAMPLES: Record<FilmLevel, number> = { 0: 48000, 1: 3840, 2: 720 };

/**
 * .meta 的 schema 版本。**2→3**：老 v2 的 L0 图与 meta 全部判失效重生成（spec D4）。
 * 为什么必须升：L0 的生成方式从「fps 滤镜整解码」换成「逐格 seek」，参数形态完全不同
 * （旧的 vf 字段已无意义），不升版本号老图会被当成对的继续用。
 */
export const FILM_META_V = 3;

/** 时长必须是**已知的正数**。Spec B 的每个入口都要过这一关 —— 与 filmstripVfFor 同一个理由：
 * 时长未知时退化成「看起来正常的图」是 N0 修掉的真实缺陷（21:30 的片子只画开头 12 秒）。 */
const assertPositiveDuration = (durationSec: number): void => {
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    throw new RangeError(`需要已知的正时长（收到 ${String(durationSec)}）：时长未知时不得退化出图`);
  }
};

/**
 * L2 的最低素材时长（秒，**严格大于**这个数才放行 —— spec D5「5 分钟」的取整）。
 *
 * 放这里而不是 `derived-pyramid.ts`（2026-10-03 OCR 审查第 4 轮 medium）：本文件是**纯常量模块**，
 * 而「跨包常量护栏」测试住在 `derived-args.test.ts`。门槛数若在 derived-pyramid 里，护栏就只能
 * 硬编码 `300` 去比对 —— 那等于把「两份要同步」这件事又变成人的责任。放这里，护栏可以 import 它。
 */
export const LEVEL2_MIN_DURATION_SEC = 300;

/** 档位可用性判定结果（spec D5）。 */
export type LevelAvailability = { ok: true } | { ok: false; message: string };

/**
 * 档位门槛（spec D5：短视频不建全套缓存）。**服务端是权威判定方**，前端按钮的 disabled 只是 UX 提示。
 * - L0 永远可用（它就是「整片一张」，任何长度都需要）。
 * - L1 至少要有一个整窗：`duration >= FILM_LEVEL_SPAN_SEC[1]`（引用常量而不是写 128 ——
 *   窗长改了门槛不跟着变的话，L1 门槛会和窗长脱钩）。
 * - L2：`duration > LEVEL2_MIN_DURATION_SEC`（**严格大于**；前端按钮的 `duration <= 300` 禁用与之对应）。
 *
 * ⚠️ 放这里而不是 `derived-pyramid.ts`（2026-10-03 OCR 审查第 4/5 轮）：**两条派生链路都要用** ——
 *   分段雪碧图（derived-pyramid）与波形峰值（wave-peaks）。放在 pyramid 里，wave-peaks 就得反向依赖它，
 *   或者（更糟）自己复制一份判定 —— 那正是第 5 轮查出的「同一档位两个产物给出相反结论」的根因：
 *   素材放不下该档时 /filmseg 返 404、而 /wavepeak 仍 200 返回数据。
 *
 * ⚠️ 边界语义（L1 是 `>=`、L2 是 `>`）**刻意不同**、与前端一一对应：改一处必须同改另一处
 *   （web 侧是 `LEVEL1_MIN_DURATION_SEC` / `LEVEL2_MIN_DURATION_SEC`，有跨包护栏测试盯着）。
 *
 * ⚠️ 这两个阈值是**推导值**而非实测项：L0 的 36 格与 L1 的 12 格/128s 的密度交叉点在 T≈384s，
 *   取 300 与 128 都是「宁可少给一档，也不要生成一张几乎全是空白段的图」。
 */
export function checkLevelAvailable(durationSec: number, level: FilmLevel): LevelAvailability {
  if (level === 0) return { ok: true };
  if (level === 1 && durationSec >= FILM_LEVEL_SPAN_SEC[1]) return { ok: true };
  if (level === 2 && durationSec > LEVEL2_MIN_DURATION_SEC) return { ok: true };
  // ⚠️ 展示值用 floor 不用 round（2026-10-03 OCR 审查第 3 轮 low）：门槛是精确比较，
  //   round 会让 299.6 显示成「300s」—— 与门槛数字撞脸。floor 只会偏小、不会假装够到门槛。
  // ⚠️ **L2 不能说「时间窗」**（2026-10-03 OCR 审查第 11 轮 medium）：L2 的窗长是 24s，而 300s 是
  //   **素材总长门槛**（spec D5 的密度取舍）。说「放不下 300s 的时间窗」是错的 —— 200s 的素材放得下 24s 窗，
  //   只是这一档不给。措辞必须与门槛的真实语义一致，否则用户照着 message 去理解会得到错的结论。
  const need = level === 1 ? String(FILM_LEVEL_SPAN_SEC[1]) : String(LEVEL2_MIN_DURATION_SEC);
  if (level === 2) return { ok: false, message: `素材时长 ${Math.floor(durationSec)}s，本档要求更长的素材（需超过 ${need}s）` };
  return { ok: false, message: `素材时长 ${Math.floor(durationSec)}s，放不下 ${need}s 的时间窗（本档要求 ${need}s）` };
}

/** 本档实际窗长：L0 返回 durationSec（整片），L1/L2 返回定长窗（末段余数由 segmentSpan 收窄）。
 *
 * ⚠️ 2026-10-03（OCR 审查）：**生产代码不调本函数**（实际用的是 `segmentSpan`，它顺带给出 t0）。
 * 它是 L0 语义的一句话表述（"整片就是窗长 = duration"），供测试与文档对账用 ——
 * **别把它当活代码去引用，也别删**（删了「L0 没有切段」这条约定就只剩注释里的说法了）。
 */
export function levelSpanSec(level: FilmLevel, durationSec: number): number {
  assertPositiveDuration(durationSec);
  return level === 0 ? durationSec : FILM_LEVEL_SPAN_SEC[level];
}

/** 段数：L0 恒 1；L1/L2 = ceil(时长 / 窗长)。 */
export function segmentCount(durationSec: number, level: FilmLevel): number {
  assertPositiveDuration(durationSec);
  if (level === 0) return 1;
  return Math.max(1, Math.ceil(durationSec / FILM_LEVEL_SPAN_SEC[level]));
}

/** 某段的实际覆盖区间。末段 span 按余数收窄，绝不虚构超出片尾的时间。 */
export function segmentSpan(durationSec: number, level: FilmLevel, seg: number): { t0: number; span: number } {
  assertPositiveDuration(durationSec);
  if (level === 0) return { t0: 0, span: durationSec };
  const span = FILM_LEVEL_SPAN_SEC[level];
  const t0 = seg * span;
  return { t0, span: Math.max(0, Math.min(span, durationSec - t0)) };
}

/** 秒数保留两位：采样点会拼进 ffmpeg 参数与 meta，位太多只会让「同一段算两次」对不上。 */
const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * 某段实际拼多少格（**格数口径的唯一来源**，2026-10-03 OCR 审查第 6/9 轮修复）。
 *
 * ⚠️ 为什么末段要少拼几格（原来恒 12 格）：
 *   末段的**实际跨度**可能只有整窗的一小截（1290s 素材的 L1 末段只剩 10.33s / 128s ≈ 8%），
 *   而前端的显示框是按**实际跨度**收窄的。若图仍恒 12 格（1920 宽），`objectFit:'fill'` 就会把
 *   整张图压进那个窄框 —— 末段画面被横向压成竖条，**完全不可辨认**（时间对齐没错，但画面废了）。
 *
 * ⚠️ **为什么是 floor 而不是 ceil**（2026-10-03 OCR 审查第 9 轮 medium）：
 *   ceil 会多拼一格，而那一格覆盖的是**段尾之外**的时间 —— 图名义时长 > 实际跨度，
 *   而显示框按实际跨度 → 图被压缩（10.7s 余数 → 2 格 = 320px 压进约 117px 的框，约 2 倍横扁；
 *   余数越小越夸张，0.5s 时能到 20 倍）。**ceil 只是把压扁「有界化」，没有根除。**
 *   floor 让「每格仍覆盖一个整窗格宽的时长」成立：格距恒为 cellSpan（与其它段一致），
 *   图名义时长 tiles×cellSpan ≤ 实际跨度 → 图基本等比地画进框里，**且格起点的时间位置全局一致**。
 *   代价：段尾不足一格的余数（最多 cellSpan−ε ≈ 10.6s）**不画** —— 这是 spec §5
 *   「末格差一格是 tile 数学约定，接受」同一精神的取舍：**宁可少画一点，也不要产出用户看不懂的图**。
 *
 * 至少 1 格（span < cellSpan 时）：段里总得有画面，否则是纯空白。极端情况下（span 远小于 cellSpan）
 * 仍会有轻微压扁，但最坏 2 倍而不是 20 倍。
 * 非末段恒等于 `FILM_LEVEL_TILES[level]`（跨度=整窗 → floor(整窗/格跨) = 总格数）。
 */
export function tilesFor(durationSec: number, level: FilmLevel, seg: number): number {
  const { span } = segmentSpan(durationSec, level, seg);
  const full = FILM_LEVEL_TILES[level];
  if (level === 0) return full; // L0 只有一段，恒铺满
  if (span <= 0) return 1;
  const cellSpan = FILM_LEVEL_SPAN_SEC[level] / full; // 整窗时每格覆盖的秒数
  return Math.max(1, Math.min(full, Math.floor(span / cellSpan)));
}

/**
 * 某段的采样时刻（秒）。**每格取区间起点**（沿用 N0 语义，spec §5 明确保持）。
 * **格距恒为 `FILM_LEVEL_SPAN_SEC[level] / 格数`（即一个整窗格宽的时长）**——
 * 这一点对末段很关键（2026-10-03 OCR 审查第 9 轮 medium）：格距若随实际跨度浮动，
 * 末段各格的**时间位置**就会与其它段不一致（时间轴上同一根竖线在不同段对应的时刻不同）。
 * 固定格距 + `tilesFor` 取 floor → 图名义时长 ≤ 实际跨度，既不变形、格位置又全局一致。
 */
export function sampleTimes(durationSec: number, level: FilmLevel, seg: number): number[] {
  const { t0, span } = segmentSpan(durationSec, level, seg);
  const tiles = tilesFor(durationSec, level, seg);
  // ⚠️ L0 的窗长不由常量给定（它就是整片 duration），所以格距 = span/tiles = duration/36
  //   —— 「每格覆盖全片 1/36」正是 N0 起就有的采样约定（末格落在 35/36 处，不是片尾）。
  //   L1/L2 用固定格距（一个整窗格宽的时长），末段才不会因格距浮动而与其它段时间错位。
  const step = level === 0 ? span / tiles : FILM_LEVEL_SPAN_SEC[level] / FILM_LEVEL_TILES[level];
  return Array.from({ length: tiles }, (_, i) => round2(t0 + step * i));
}

/**
 * 胶片图形状签名：schema 版本 + level + **窗长** + 格数 + 格子尺寸。命中缓存时逐字比对。
 * ⚠️ 窗长必须在里面（2026-10-03 OCR 审查第 7 轮 medium）：它直接决定分段图覆盖哪段时间
 *   （`segmentSpan`/`tilesFor`/`sampleTimes` 全以它为准），而 `FILM_LEVEL_TILES` 是独立常量（L1/L2 恒 12）——
 *   单独改窗长（例如 L1 从 128 改成 100）时 tiles/cell 都不变 → sig 逐字相同 → **老段图继续命中**，
 *   而图上覆盖的时间已是旧窗长 → 时间轴静默错位。`waveShapeSig` 本来就带 span，这里原先漏了一份。
 * L0 的窗长写 'full'（它由素材时长决定，不进签名）。
 */
export function filmShapeSig(level: FilmLevel, tiles: number): string {
  const span = FILM_LEVEL_SPAN_SEC[level] === 0 ? 'full' : FILM_LEVEL_SPAN_SEC[level];
  return `v${FILM_META_V}|level=${level}|span=${span}|tiles=${tiles}|cell=${FILM_CELL_W}x${FILM_CELL_H}`;
}

/** 波形峰值形状签名：schema 版本 + level + 窗长 + N。L0 的窗长写 full（它由素材时长决定，不进签名）。 */
export function waveShapeSig(level: FilmLevel): string {
  const span = FILM_LEVEL_SPAN_SEC[level] === 0 ? 'full' : FILM_LEVEL_SPAN_SEC[level];
  return `v${FILM_META_V}|level=${level}|span=${span}|n=${WAVE_NSAMPLES[level]}`;
}

/**
 * 单格抽帧（实测 B1/B2 的命令形态）。
 * **-ss 必须放在 -i 之前**（输入选项 = 快速 seek；放在 -i 之后会从 0 解码到该点，
 * 2.1GB 素材上就是几十秒 —— 实测 36 格 10.29s 与「整解码 45–52s」的差距全靠这个位置）。
 *
 * ⚠️ 2026-10-03（OCR 审查发现）：这里**从 `scale=-1:90`（只定高、宽度随素材比例浮动）改成固定 `160:90`**。
 * 原因：逐格 + tile 的组合下「每格宽度浮动」会让三处口径对不上 ——
 *   ① `filmShapeSig` 里写死的 `cell=160x90` 不再如实反映产物（非 16:9 素材每格不是 160 宽）；
 *   ② `FILM_SHEET_W` 算出的成品宽与实际不符；
 *   ③ 消费方按成品宽换算显示高，图会变形。
 * 固定 160×90 的代价：非 16:9 素材（手机竖屏等）每格有轻微形变 —— 换来的是**形状签名如实、
 * 成品宽可预测、tile 序列对得上**。实测素材全是 16:9（4K），形变不可见。
 */
export function filmCellArgs(videoPath: string, outPath: string, t: number): string[] {
  return ['-y', '-ss', String(t), '-i', videoPath, '-frames:v', '1', '-vf', `scale=${FILM_CELL_W}:${FILM_CELL_H}`, outPath];
}

/**
 * 逐格小图的文件名（**序列契约的唯一来源**，2026-10-03 OCR 审查发现）。
 * 生成端（`derived-images.ts` 的 `runFilmStrip`）与消费端（下面的 `filmTileArgs`）都调它 ——
 * 两处各写一份 `cell-${i}.png` / `cell-%02d.png` 的话，位宽或前缀一改，tile 就找不到输入序列，
 * 表现为「tile 拼接失败」而不是编译期错误。
 * 位宽 2 的上限：一次最多 99 格（当前最多 36 格）。**改这个函数时连带改 `FILM_CELL_PAD`**。
 */
export const FILM_CELL_PAD = 2;
/** 序列名的三段都收在这里：前缀/位宽/扩展名。**别在任何地方另写 `cell-` 或 `.png`** ——
 *  2026-10-03 OCR 审查第 2 轮：上一版只单源了位宽，前缀与扩展名仍各写一份，
 *  改前缀时 tile 会去找一个生成端从未写过的序列（表现为「拼接失败」，不是编译期错误）。 */
const FILM_CELL_STEM = 'cell-';
const FILM_CELL_EXT = '.png';
export const filmCellName = (i: number): string => `${FILM_CELL_STEM}${String(i).padStart(FILM_CELL_PAD, '0')}${FILM_CELL_EXT}`;
/** ffmpeg 序列模式（给 `-i` 用；`%0Nd` 的 N 必须与 FILM_CELL_PAD 一致）。 */
export const FILM_CELL_PATTERN = `${FILM_CELL_STEM}%0${FILM_CELL_PAD}d${FILM_CELL_EXT}`;

/**
 * tile 拼接：把逐格产出的小图按文件名序列拼成一行。
 * ⚠️ 2026-10-03（OCR 审查发现）：路径拼接从**硬编码反斜杠**改成 `join` —— 原来在非 Windows 上会拼出
 * `.../cells-xxx\cell-%02d.png` 这种混合分隔符，ffmpeg 认不出该输入序列、tile 直接失败
 * （本仓是 Windows-only，但纯函数层不该带平台假设；测试机/CI 可能是 Linux）。
 * 实测 B2：拼接只占 0.03s（总 3.38s 的 1%）。
 */
export function filmTileArgs(outPath: string, cellDir: string, tiles: number): string[] {
  return ['-y', '-start_number', '0', '-i', join(cellDir, FILM_CELL_PATTERN), '-vf', `tile=${tiles}x1`, '-frames:v', '1', outPath];
}

/**
 * astats 输出里 RMS 那一行的 metadata 键（**单一来源**，2026-10-03 OCR 审查第 12 轮 medium）。
 * `wavePeakArgs` 把它插进 `-af` 串、`wave-peaks.ts` 的解析器按它匹配 stderr ——
 * 两处若各写一份字面量而漂移，解析器会静默返回 `[]`，然后报成
 * 「ffmpeg 未输出音频统计（素材可能没有音轨）」→ **把用户引去重下一个好端端的文件**。
 */
export const RMS_METADATA_KEY = 'lavfi.astats.Overall.RMS_level';

/**
 * 波形峰值提取（实测 B3b/B3c 修正链路）。**数据从 stderr 解析**，输出 `-f null -` 不落文件。
 * ⚠️ 三个关键点，一个都不能改回去：
 *   ① `asetnsamples=N` 强制窗口 —— 没有它，astats 的 reset 按解码帧数（AAC 帧=1024 采样）走，
 *      根本不是「N 采样一窗」。
 *   ② `reset=1` —— 每窗重置累计量。B3a 的字面 `reset=44100` 实测 **480s 超时 + 334MB 日志**，
 *      根因是它把 reset 参数当成了采样数，且不带 key 时 ametadata 把 ~170 个指标/帧全打出来。
 *   ③ `ametadata=print:key=...` 只打 RMS 一个键 —— 同上，日志爆炸才是慢的根因（不是解码）。
 * seg 为 null 表示全片（L0），此时不加 -ss/-t。
 */
export function wavePeakArgs(videoPath: string, seg: { t0: number; span: number } | null, nsamples: number): string[] {
  const args = ['-y'];
  if (seg !== null) args.push('-ss', String(seg.t0), '-t', String(seg.span));
  args.push(
    '-i', videoPath, '-vn',
    '-af', `asetnsamples=${nsamples},astats=metadata=1:reset=1,ametadata=print:key=${RMS_METADATA_KEY}`,
    '-f', 'null', '-',
  );
  return args;
}

/**
 * 成品波形（音频播放器用）的目标点数：不论成品多长都画这么多点，保证波形密度稳定。
 * 为什么不能用素材链路的 WAVE_NSAMPLES[0]=48000：那是「约 1 点/秒」，
 * 21 分钟的片子合适，但一条 10 秒的成品只能得到 10 个点 —— 画不出波形。
 */
export const AUDIO_WAVE_TARGET_POINTS = 1200;

/**
 * `audioWaveNsamples` 的**取样规则版本号**（spec §6.2 签名形如 `...|n=<nsamples 推导规则版本>`，这里落到 `nf=`）。
 * ⚠️ 改 `audioWaveNsamples` 的反推公式（系数 48000 / 取整方式 / 夹取范围）时**必须把这个版本号 +1**：
 *    这类改动**不体现在 points**（点数恒为 1200），旧缓存的 sig 会与新 sig 逐字相同 → 被判新鲜继续用，
 *    而实际点密度与 `stepSec = durationSec / points.length` 已与新公式错位（波形与时长对不上）。
 *    这是与 FILMSTAMP_SIG_V 同类的「缓存版本号」弱点 —— 靠注释规约守住。
 */
export const AUDIO_WAVE_NSAMPLES_V = 1;

/** 成品波形形状签名：schema 版本 + 目标点数 + 取样规则版本。改点数或改取样公式即自动判老缓存失效。 */
export function waveaudioShapeSig(): string {
  return `v${FILM_META_V}|points=${AUDIO_WAVE_TARGET_POINTS}|nf=${AUDIO_WAVE_NSAMPLES_V}`;
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
