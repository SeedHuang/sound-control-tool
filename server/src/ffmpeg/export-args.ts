// 导出参数(D9):separate 复用 buildClipArgs(每段就是一次抽音轨);merge 用 atrim + concat 拼一条。
// 纯函数、不碰 IO —— 与 clip-args.ts 同族,便于参数快照断言。
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
