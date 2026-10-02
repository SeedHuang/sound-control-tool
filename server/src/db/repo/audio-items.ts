import type { DB } from '../index.js';

export interface AudioItemRow {
  id: number; title: string; source_type: string; source_url: string | null;
  entry_index: number | null;      // 剧集第几集(1 起);单视频/录制 → null
  collection_title: string | null; // 所属合集标题;非合集 → null
  source_import_id: number | null; // 2026-10-01 spec audio-lineage D1:来源 id(无来源/录制/历史遗留 → null)
  source_work_id: number | null;   // 2026-10-01 spec clip-works D4:成品归属的作品 id(指向 clip_projects.id);非成品 → null
  media_kind: 'audio' | 'video';   // 2026-10-02 spec video-export D1:成品类型,展示层分流的唯一依据
  width: number | null;            // 视频宽(像素);音频/未知 → null
  height: number | null;           // 视频高(像素);分辨率徽标(如 2160p)用
  file_path: string; format: string; duration_sec: number | null;
  file_size: number | null; created_at: string;
}
/** create 入参:剧集两列可选——录制/单视频/旧调用不传即落 NULL */
export interface AudioItemCreate {
  title: string; source_type: string; source_url: string | null;
  file_path: string; format: string; duration_sec: number | null; file_size: number | null;
  entry_index?: number | null; collection_title?: string | null;
  source_import_id?: number | null; // 2026-10-01 spec audio-lineage D1;不传即 NULL
  source_work_id?: number | null;   // 2026-10-01 spec clip-works D4:成品挂作品;不传即 NULL
  media_kind?: 'audio' | 'video';   // 2026-10-02 spec video-export D1;不传即 'audio'(与列默认一致,老调用零回归)
  width?: number | null;            // 视频分辨率;不传即 NULL
  height?: number | null;
}
export interface AudioItemsRepo {
  create(item: AudioItemCreate): number;
  list(): AudioItemRow[];
  get(id: number): AudioItemRow | null;
  findBySourceUrl(url: string): AudioItemRow | null;
  findSameItem(url: string, entryIndex: number | null, title: string): AudioItemRow[]; // 覆盖下载判重(2026-09-29)
  updateFilePath(id: number, file_path: string): void;
  delete(id: number): void; // P1-2:入库失败回滚
}
export function createAudioItemsRepo(db: DB): AudioItemsRepo {
  const insert = db.prepare(
    'INSERT INTO audio_items (title, source_type, source_url, entry_index, collection_title, source_import_id, source_work_id, media_kind, width, height, file_path, format, duration_sec, file_size) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const select = db.prepare(
    'SELECT id, title, source_type, source_url, entry_index, collection_title, source_import_id, source_work_id, media_kind, width, height, file_path, format, duration_sec, file_size, created_at FROM audio_items ORDER BY created_at DESC, id DESC',
  );
  return {
    create: (item) =>
      Number(
        insert.run(
          item.title, item.source_type, item.source_url,
          item.entry_index ?? null, item.collection_title ?? null,
          item.source_import_id ?? null, item.source_work_id ?? null,
          item.media_kind ?? 'audio', // 2026-10-02 spec video-export D1:NOT NULL 列必须显式落 'audio'(显式插 NULL 会违反约束)
          item.width ?? null, item.height ?? null,
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
    // 覆盖下载判重(2026-09-29 用户拍板):找出「同一个视频/同一集」在库里的其它行。
    // 规则:先在同一网址下的行里按 entry_index 精确匹配(2026-09-29 起下载会记集数);
    // 老记录没集数(entry_index IS NULL)时,退一步按标题认(同一集解析出的条目标题是一样的)。
    // 单视频(entryIndex=null)则按「没集数 + 标题相同」认——不能只按网址,否则会误伤同网址下的合集分集。
    findSameItem: (url, entryIndex, title) => {
      const rows = (db.prepare(`${SELECT_COLS} WHERE source_type = 'download' AND source_url = ?`).all(url) as unknown[])
        .filter(isRow).map(normalize);
      if (entryIndex !== null) {
        const exact = rows.filter((r) => r.entry_index === entryIndex);
        if (exact.length > 0) return exact;
        return rows.filter((r) => r.entry_index === null && r.title === title);
      }
      return rows.filter((r) => r.entry_index === null && r.title === title);
    },
    updateFilePath: (id, file_path) => db.prepare('UPDATE audio_items SET file_path = ? WHERE id = ?').run(file_path, id),
    delete: (id) => db.prepare('DELETE FROM audio_items WHERE id = ?').run(id),
  };
}
const SELECT_COLS =
  'SELECT id, title, source_type, source_url, entry_index, collection_title, source_import_id, source_work_id, media_kind, width, height, file_path, format, duration_sec, file_size, created_at FROM audio_items';
function isRow(r: unknown): r is Record<string, unknown> { return typeof r === 'object' && r !== null; }
function normalize(r: Record<string, unknown>): AudioItemRow {
  return {
    id: Number(r.id), title: String(r.title), source_type: String(r.source_type),
    source_url: r.source_url === null ? null : String(r.source_url),
    entry_index: r.entry_index === null || r.entry_index === undefined ? null : Number(r.entry_index),
    collection_title: r.collection_title === null || r.collection_title === undefined ? null : String(r.collection_title),
    source_import_id: r.source_import_id === null || r.source_import_id === undefined ? null : Number(r.source_import_id),
    source_work_id: r.source_work_id === null || r.source_work_id === undefined ? null : Number(r.source_work_id),
    // 2026-10-02 spec video-export D1:只认 'video',其余(含 NULL/未知)归 'audio'——与列 CHECK 取值域一致
    media_kind: r.media_kind === 'video' ? 'video' : 'audio',
    width: r.width === null || r.width === undefined ? null : Number(r.width),
    height: r.height === null || r.height === undefined ? null : Number(r.height),
    file_path: String(r.file_path), format: String(r.format),
    duration_sec: r.duration_sec === null ? null : Number(r.duration_sec),
    file_size: r.file_size === null ? null : Number(r.file_size),
    created_at: String(r.created_at),
  };
}
