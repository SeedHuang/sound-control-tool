// server/src/ytdlp/progress.ts
export interface ProgressInfo { percent: number; downloadedBytes?: number; totalBytes?: number }
// 输入行来自 --progress-template: "42.3%|12345|67890";下载中无 total 时 total 为空串
export function parseProgressLine(line: string): ProgressInfo | null {
  const parts = line.trim().split('|');
  if (parts.length < 1 || !parts[0]!.endsWith('%')) return null;
  const p = Number.parseFloat(parts[0]!.replace('%', ''));
  if (Number.isNaN(p)) return null;
  const num = (s: string | undefined): number | undefined => (s && s.length > 0 && Number(s) >= 0 ? Number(s) : undefined);
  return { percent: p, downloadedBytes: num(parts[1]), totalBytes: num(parts[2]) };
}
