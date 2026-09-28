// server/src/ytdlp/ingest.ts
import { renameSync } from 'node:fs';
import { join } from 'node:path';
import type { AudioItemsRepo } from '../db/repo/audio-items.js';
import { resolveUniquePath, slugify } from './slug.js';

export function ingestDownloadedFile(opts: {
  tmpPath: string; title: string; format: string; durationSec: number | null;
  fileSize: number; sourceUrl: string; audioDir: string;
  exists: (p: string) => boolean; audioRepo: AudioItemsRepo;
}): { audioId: number; finalPath: string } {
  const audioId = opts.audioRepo.create({
    title: opts.title, source_type: 'download', source_url: opts.sourceUrl,
    file_path: opts.tmpPath, format: opts.format, duration_sec: opts.durationSec, file_size: opts.fileSize,
  });
  const id8 = String(audioId).padStart(8, '0').slice(-8);
  const finalName = `${slugify(opts.title)}-${id8}.${opts.format}`;
  const finalPath = resolveUniquePath(opts.audioDir, finalName, opts.exists);
  renameSync(opts.tmpPath, finalPath);
  opts.audioRepo.updateFilePath(audioId, finalPath);
  return { audioId, finalPath };
}
