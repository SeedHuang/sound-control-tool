// server/src/db/repo/source-videos.ts
// 视频素材(2026-09-29,spec m1c-video-clip):与 imported_sources 一对一。只管"我下过哪个视频素材在哪"。
import type { DB } from '../index.js';

export interface SourceVideoRow {
  import_id: number;
  file_path: string;
  height: number | null;
  file_size: number | null;
  created_at: string;
}

export function createSourceVideosRepo(db: DB) {
  /** 一个来源一份素材 → 冲突即覆盖(换清晰度重下就是这条路径) */
  const upsert = (v: { importId: number; filePath: string; height: number | null; fileSize: number | null }): void => {
    db.prepare(
      'INSERT INTO source_videos (import_id, file_path, height, file_size) VALUES (?, ?, ?, ?) ' +
      'ON CONFLICT(import_id) DO UPDATE SET file_path=excluded.file_path, height=excluded.height, file_size=excluded.file_size',
    ).run(v.importId, v.filePath, v.height, v.fileSize);
  };
  /** 素材列表(join 来源取标题/网址/站点);新→旧 */
  const list = (): Array<SourceVideoRow & { url: string; title: string; site: string }> =>
    (db.prepare(
      'SELECT v.import_id, v.file_path, v.height, v.file_size, v.created_at, s.url, s.title, s.site ' +
      'FROM source_videos v JOIN imported_sources s ON s.id = v.import_id ' +
      'ORDER BY v.created_at DESC, v.import_id DESC',
    ).all() as Array<Record<string, unknown>>).map((r) => ({
      import_id: r.import_id as number,
      file_path: r.file_path as string,
      height: r.height === null || r.height === undefined ? null : Number(r.height),
      file_size: r.file_size === null || r.file_size === undefined ? null : Number(r.file_size),
      created_at: r.created_at as string,
      url: r.url as string,
      title: r.title as string,
      site: r.site as string,
    }));
  const get = (importId: number): SourceVideoRow | null => {
    const r = db.prepare('SELECT import_id, file_path, height, file_size, created_at FROM source_videos WHERE import_id = ?')
      .get(importId) as Record<string, unknown> | undefined;
    if (!r) return null;
    return {
      import_id: r.import_id as number,
      file_path: r.file_path as string,
      height: r.height === null || r.height === undefined ? null : Number(r.height),
      file_size: r.file_size === null || r.file_size === undefined ? null : Number(r.file_size),
      created_at: r.created_at as string,
    };
  };
  const del = (importId: number): boolean =>
    db.prepare('DELETE FROM source_videos WHERE import_id = ?').run(importId).changes > 0;
  return { upsert, list, get, delete: del };
}
