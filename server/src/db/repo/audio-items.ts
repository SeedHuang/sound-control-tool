import type { DB } from '../index.js';

export interface AudioItemRow {
  id: number; title: string; source_type: string; source_url: string | null;
  entry_index: number | null;      // 剧集第几集(1 起);单视频/录制 → null
  collection_title: string | null; // 所属合集标题;非合集 → null
  file_path: string; format: string; duration_sec: number | null;
  file_size: number | null; created_at: string;
}
/** create 入参:剧集两列可选——录制/单视频/旧调用不传即落 NULL */
export interface AudioItemCreate {
  title: string; source_type: string; source_url: string | null;
  file_path: string; format: string; duration_sec: number | null; file_size: number | null;
  entry_index?: number | null; collection_title?: string | null;
}
export interface AudioItemsRepo {
  create(item: AudioItemCreate): number;
  list(): AudioItemRow[];
  get(id: number): AudioItemRow | null;
  findBySourceUrl(url: string): AudioItemRow | null;
  updateFilePath(id: number, file_path: string): void;
  delete(id: number): void; // P1-2:入库失败回滚
}
export function createAudioItemsRepo(db: DB): AudioItemsRepo {
  const insert = db.prepare(
    'INSERT INTO audio_items (title, source_type, source_url, entry_index, collection_title, file_path, format, duration_sec, file_size) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const select = db.prepare(
    'SELECT id, title, source_type, source_url, entry_index, collection_title, file_path, format, duration_sec, file_size, created_at FROM audio_items ORDER BY created_at DESC, id DESC',
  );
  return {
    create: (item) =>
      Number(
        insert.run(
          item.title, item.source_type, item.source_url,
          item.entry_index ?? null, item.collection_title ?? null,
          item.file_path, item.format, item.duration_sec, item.file_size,
        ).lastInsertRowid,
      ),
    list: () => select.all().filter(isRow).map(normalize),
    get: (id) => {
      const row = db.prepare(`${SELECT_COLS} WHERE id = ?`).get(id);
      return row && isRow(row) ? normalize(row) : null;
    },
    findBySourceUrl: (url) => {
      const row = db.prepare(`${SELECT_COLS} WHERE source_type = 'download' AND source_url = ?`).get(url);
      return row && isRow(row) ? normalize(row) : null;
    },
    updateFilePath: (id, file_path) => db.prepare('UPDATE audio_items SET file_path = ? WHERE id = ?').run(file_path, id),
    delete: (id) => db.prepare('DELETE FROM audio_items WHERE id = ?').run(id),
  };
}
const SELECT_COLS =
  'SELECT id, title, source_type, source_url, entry_index, collection_title, file_path, format, duration_sec, file_size, created_at FROM audio_items';
function isRow(r: unknown): r is Record<string, unknown> { return typeof r === 'object' && r !== null; }
function normalize(r: Record<string, unknown>): AudioItemRow {
  return {
    id: Number(r.id), title: String(r.title), source_type: String(r.source_type),
    source_url: r.source_url === null ? null : String(r.source_url),
    entry_index: r.entry_index === null || r.entry_index === undefined ? null : Number(r.entry_index),
    collection_title: r.collection_title === null || r.collection_title === undefined ? null : String(r.collection_title),
    file_path: String(r.file_path), format: String(r.format),
    duration_sec: r.duration_sec === null ? null : Number(r.duration_sec),
    file_size: r.file_size === null ? null : Number(r.file_size),
    created_at: String(r.created_at),
  };
}
