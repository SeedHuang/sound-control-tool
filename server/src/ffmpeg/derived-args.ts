// 纯函数：派生图 ffmpeg 参数（实测模板见 task-p4-1-report.md §F/§G）。不碰 IO，便于参数快照断言。
export const DERIVED_WAVE_W = 1600;
export const DERIVED_WAVE_H = 120;
export const DERIVED_FILM_W = 1600;
export const DERIVED_FILM_H = 90;
export const DERIVED_FILM_TILES = 12;

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
 */
export function buildFilmstripArgs(videoPath: string, outPath: string, durationSec: number | null): string[] {
  const rawFps = durationSec !== null && durationSec > 0 ? DERIVED_FILM_TILES / durationSec : 1; // 时长未知 → fps=1（只覆盖前 12s）
  const fps = Math.min(Math.max(rawFps, 0.05), 30); // 夹逼：过小→0 帧空产物；过大→无谓解码
  const vf = `fps=${fps.toFixed(6)},scale=-1:90,tile=${DERIVED_FILM_TILES}x1,scale=1600:90`;
  return ['-y', '-i', videoPath, '-an', '-vf', vf, '-frames:v', '1', outPath];
}
