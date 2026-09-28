import type { DB } from '../index.js';

export interface AudioItemRow {
  id: number; title: string; source_type: string; source_url: string | null;
  file_path: string; format: string; duration_sec: number | null;
  file_size: number | null; created_at: string;
}
export interface AudioItemsRepo {
  create(item: Omit<AudioItemRow, 'id' | 'created_at'>): number;
  list(): AudioItemRow[];
  get(id: number): AudioItemRow | null;
  findBySourceUrl(url: string): AudioItemRow | null;
  updateFilePath(id: number, file_path: string): void;
  delete(id: number): void; // P1-2:入库失败回滚
}
export function createAudioItemsRepo(db: DB): AudioItemsRepo {
  const insert = db.prepare(
    'INSERT INTO audio_items (title, source_type, source_url, file_path, format, duration_sec, file_size) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  const select = db.prepare(
    'SELECT id, title, source_type, source_url, file_path, format, duration_sec, file_size, created_at FROM audio_items ORDER BY created_at DESC, id DESC',
  );
  return {
    create: (item) =>
      Number(
        insert.run(item.title, item.source_type, item.source_url, item.file_path, item.format, item.duration_sec, item.file_size).lastInsertRowid,
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
  'SELECT id, title, source_type, source_url, file_path, format, duration_sec, file_size, created_at FROM audio_items';
function isRow(r: unknown): r is Record<string, unknown> { return typeof r === 'object' && r !== null; }
function normalize(r: Record<string, unknown>): AudioItemRow {
  return {
    id: Number(r.id), title: String(r.title), source_type: String(r.source_type),
    source_url: r.source_url === null ? null : String(r.source_url),
    file_path: String(r.file_path), format: String(r.format),
    duration_sec: r.duration_sec === null ? null : Number(r.duration_sec),
    file_size: r.file_size === null ? null : Number(r.file_size),
    created_at: String(r.created_at),
  };
}
