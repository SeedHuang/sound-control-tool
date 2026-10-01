// 纯函数:剪辑规格的极小版(只做"抽一段" + 格式/码率)。不碰 IO,便于参数快照断言。
// 未来 S4 的 EditSpec 编译器可以长在这旁边,共享"格式 → 编码器"这张表。
export interface ClipArgsOpts {
  inputPath: string;
  outPath: string;
  start: number;
  end: number;
  format: 'mp3' | 'm4a' | 'wav';
  quality?: string;
}

// 导出供复用(P4 导出):merge 拼接与"抽一段"共用同一张「格式 → 编码器」表,避免两处各写一份漂移
export const CODEC_BY_FORMAT: Record<ClipArgsOpts['format'], string[]> = {
  mp3: ['-c:a', 'libmp3lame'],
  m4a: ['-c:a', 'aac'],
  wav: ['-c:a', 'pcm_s16le'],
};

/**
 * 从视频里抽一段音频。
 * -ss/-to 放 `-i` **之后**(输出侧定位):实测 B(2026-09-30)证实输入侧 `-ss` 起点会提前落到前一个视频关键帧(约 1s 误差),
 * 输出侧逐样本精确(与整轨解码基准逐样本比对残差 0.0)。"画面上打的点"必须准,快那几秒没有意义。
 */
export function buildClipArgs(o: ClipArgsOpts): string[] {
  const args: string[] = ['-i', o.inputPath, '-ss', String(o.start), '-to', String(o.end), '-vn'];
  args.push(...CODEC_BY_FORMAT[o.format]);
  if (o.quality !== undefined && o.format !== 'wav') args.push('-b:a', o.quality);
  args.push('-y', o.outPath);
  return args;
}
