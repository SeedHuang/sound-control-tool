// server/src/ytdlp/ingest.ts
import { copyFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { AudioItemsRepo } from '../db/repo/audio-items.js';
import { resolveUniquePath, slugify } from './slug.js';

/** 把临时产物搬到最终位置。默认走同盘 `renameSync`（原子、最快）；
 *  **跨盘时 Windows 会抛 EXDEV**（spec D6）——那时退化为「复制 + 删源」。
 *  其它错误（EBUSY/EPERM/ENOENT 等）原样抛出，保持 ingest 既有的「删 DB 行 + 抛」回滚语义。
 *  io 参数可注入，便于单测覆盖 EXDEV 分支（不必真造跨盘环境）。 */
export function moveIntoPlace(
  from: string, to: string,
  io?: { rename?: typeof renameSync; copyFile?: typeof copyFileSync; unlink?: typeof unlinkSync },
): void {
  const rename = io?.rename ?? renameSync;
  try { rename(from, to); return; }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    (io?.copyFile ?? copyFileSync)(from, to);
    (io?.unlink ?? unlinkSync)(from);
  }
}

export function ingestDownloadedFile(opts: {
  tmpPath: string; title: string; format: string; durationSec: number | null;
  fileSize: number; sourceUrl: string; audioDir: string;
  entryIndex?: number | null; collectionTitle?: string | null; // 剧集信息:第几集 / 所属合集(单视频不传)
  /** D8：剪辑/导出产物传 'edit'；缺省 'download'（老下载路径不变——回归保护） */
  sourceType?: 'download' | 'edit';
  exists: (p: string) => boolean; audioRepo: AudioItemsRepo;
}): { audioId: number; finalPath: string } {
  const audioId = opts.audioRepo.create({
    title: opts.title, source_type: opts.sourceType ?? 'download', source_url: opts.sourceUrl,
    entry_index: opts.entryIndex ?? null, collection_title: opts.collectionTitle ?? null,
    file_path: opts.tmpPath, format: opts.format, duration_sec: opts.durationSec, file_size: opts.fileSize,
  });
  const id8 = String(audioId).padStart(8, '0').slice(-8);
  const finalName = `${slugify(opts.title)}-${id8}.${opts.format}`;
  const finalPath = resolveUniquePath(opts.audioDir, finalName, opts.exists);
  try {
    moveIntoPlace(opts.tmpPath, finalPath);
  } catch (err) {
    // P1-2 回滚补洞:rename 失败(被占/权限/IO)时,已 INSERT 的行必须在这里删除——
    // 路由层 catch 里 audioId 仍是 null(ingest 未返回),不会补删,否则 DB 残留指向 temp 的悬空行
    opts.audioRepo.delete(audioId);
    throw err;
  }
  opts.audioRepo.updateFilePath(audioId, finalPath);
  return { audioId, finalPath };
}
