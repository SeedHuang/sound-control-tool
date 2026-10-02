// 导出参数(D9):separate 复用 buildClipArgs(每段就是一次抽音轨);merge 用 atrim + concat 拼一条。
// 纯函数、不碰 IO —— 与 clip-args.ts 同族,便于参数快照断言。
// N1 Task 2 新增视频导出参数(crfOf / buildVideoClipArgs / buildVideoConcatArgs),实测依据
// .superpowers/sdd/2026-10-01-clip-works/ffmpeg-measure-report.md 的 A1-A5 组。
import { CODEC_BY_FORMAT } from './clip-args.js';

/** merge:把 N 段按数组顺序 atrim 出、各自重置 PTS、再 concat 成一条音轨(v=0 只处理音频)。 */
export function buildMergeArgs(o: {
  inputPath: string; outPath: string; format: 'mp3' | 'm4a' | 'wav'; quality?: string;
  segments: { start_sec: number; end_sec: number }[];
}): string[] {
  const n = o.segments.length;
  // 每段独立 atrim 后接 asetpts=PTS-STARTPTS:各段从 0 起算,concat 才能无缝相接(否则第 2 段起时间戳错位)
  const trim = o.segments.map((s, i) => `[0:a]atrim=start=${s.start_sec}:end=${s.end_sec},asetpts=PTS-STARTPTS[a${i}]`).join(';');
  const labels = o.segments.map((_s, i) => `[a${i}]`).join('');
  const filter = `${trim};${labels}concat=n=${n}:v=0:a=1[out]`;
  const args = ['-i', o.inputPath, '-filter_complex', filter, '-map', '[out]', '-vn'];
  args.push(...CODEC_BY_FORMAT[o.format]);
  // 与 buildClipArgs 同口径:wav 是无损裸流,忽略码率参数
  if (o.quality !== undefined && o.format !== 'wav') args.push('-b:a', o.quality);
  args.push('-y', o.outPath);
  return args;
}

/**
 * quality 档位 → CRF(实测 A4:crf 20/23/28 三档耗时几乎相同 3.2-3.4s,差异全在体积 41.5/32.2/21.0 MB per 10s 4K)。
 * 键名磁盘实况:音频侧 quality 是码率字符串('192k' 直传 -b:a),全仓并无档位键;
 * 视频侧按 plan Task 2 接口新定档位键 high/mid/medium/low。
 * 未知值(含乱传)→ 23 且不报错:未知档位落中档,宁欠勿过 —— 不静默升级到最贵档(crf20 体积最大)。
 */
export function crfOf(quality?: string): number {
  if (quality === 'high') return 20;
  if (quality === 'low') return 28;
  return 23; // mid / medium / 缺省 / 未知 → 中档
}

/**
 * 切一段视频。an=false 带音轨(aac 192k 重编码,实测 A2:copy 仅省 0.07s,重编码时长才精确 10.000s 整);
 * an=true 纯视频(-an,实测 A3)。
 * 输入侧 -ss/-to:实测 A 组先决发现,ffmpeg 9.0.2 下 `-ss 600 -to 610` 输入选项产物 v/a 双流均 10.000s 整,
 * 精确成立(plan 实测定死:输入侧 `-ss T -to T+D`)。
 * 精度处理照抄 buildClipArgs:String 原样透传,无取整无 clamp。
 * -movflags +faststart:moov 前置,浏览器 <video> 可边下边播(web 预览按 preload="metadata" 起播依赖此);
 * 实测报告未覆盖,属通用无害项(代价是编码收尾重排一次文件,相对 3.3s 级编码耗时可忽略)。
 */
export function buildVideoClipArgs(o: {
  inputPath: string; outPath: string; start: number; end: number; crf: number; an: boolean;
}): string[] {
  const args = ['-y', '-ss', String(o.start), '-to', String(o.end), '-i', o.inputPath,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(o.crf)];
  if (o.an) args.push('-an');
  else args.push('-c:a', 'aac', '-b:a', '192k');
  args.push('-movflags', '+faststart', o.outPath);
  return args;
}

/**
 * 逐段编码后的 concat 拼接(实测 A5:0.46s vs filter_complex 重编码 42.89s,93 倍;
 * 各段同参独立编码,段首必为 x264 IDR 关键帧,-c copy 拼接点落干净 GOP 起点,机理上不花屏)。
 * list 文件由调用方(Task 3)写好,每行形如:
 *   file 'C:/Users/.../export-1-m0-123.mp4'   ← 正斜杠 + UTF-8 无 BOM;-safe 0 放行该路径
 */
export function buildVideoConcatArgs(o: { listPath: string; outPath: string }): string[] {
  return ['-y', '-f', 'concat', '-safe', '0', '-i', o.listPath, '-c', 'copy', o.outPath];
}
