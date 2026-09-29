// server/src/ytdlp/ingest.ts
import { renameSync } from 'node:fs';
import { join } from 'node:path';
import type { AudioItemsRepo } from '../db/repo/audio-items.js';
import { resolveUniquePath, slugify } from './slug.js';

export function ingestDownloadedFile(opts: {
  tmpPath: string; title: string; format: string; durationSec: number | null;
  fileSize: number; sourceUrl: string; audioDir: string;
  entryIndex?: number | null; collectionTitle?: string | null; // 剧集信息:第几集 / 所属合集(单视频不传)
  exists: (p: string) => boolean; audioRepo: AudioItemsRepo;
}): { audioId: number; finalPath: string } {
  const audioId = opts.audioRepo.create({
    title: opts.title, source_type: 'download', source_url: opts.sourceUrl,
    entry_index: opts.entryIndex ?? null, collection_title: opts.collectionTitle ?? null,
    file_path: opts.tmpPath, format: opts.format, duration_sec: opts.durationSec, file_size: opts.fileSize,
  });
  const id8 = String(audioId).padStart(8, '0').slice(-8);
  const finalName = `${slugify(opts.title)}-${id8}.${opts.format}`;
  const finalPath = resolveUniquePath(opts.audioDir, finalName, opts.exists);
  try {
    renameSync(opts.tmpPath, finalPath);
  } catch (err) {
    // P1-2 回滚补洞:rename 失败(被占/权限/IO)时,已 INSERT 的行必须在这里删除——
    // 路由层 catch 里 audioId 仍是 null(ingest 未返回),不会补删,否则 DB 残留指向 temp 的悬空行
    opts.audioRepo.delete(audioId);
    throw err;
  }
  opts.audioRepo.updateFilePath(audioId, finalPath);
  return { audioId, finalPath };
}
