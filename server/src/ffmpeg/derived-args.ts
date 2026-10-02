// 纯函数：派生图 ffmpeg 参数（实测模板见 task-p4-1-report.md §F/§G）。不碰 IO，便于参数快照断言。
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
 */
export function buildFilmstripArgs(videoPath: string, outPath: string, durationSec: number): string[] {
  return ['-y', '-i', videoPath, '-an', '-vf', filmstripVfFor(durationSec), '-frames:v', '1', outPath];
}
