import type { DB } from './index.js';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS audio_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('download','recording','edit')),
  source_url TEXT,
  entry_index INTEGER,
  collection_title TEXT,
  parent_id INTEGER,
  file_path TEXT NOT NULL UNIQUE,
  format TEXT NOT NULL,
  duration_sec REAL,
  file_size INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','error','cancelled')),
  progress REAL NOT NULL DEFAULT 0,
  message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);
CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS audio_item_tags (
  audio_id INTEGER NOT NULL REFERENCES audio_items(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (audio_id, tag_id)
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS imported_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  site TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('single','playlist')),
  duration_sec REAL,
  entries_json TEXT,
  thumbnail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

/** 补列(幂等):CREATE TABLE IF NOT EXISTS 只对"表不存在"生效,已存在的老库不会拿到新列 → 必须 ALTER TABLE */
function ensureColumns(db: DB, table: string, columns: Array<{ name: string; ddl: string }>): void {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: unknown }>;
  const have = new Set(rows.map((r) => String(r.name)));
  for (const c of columns) {
    if (!have.has(c.name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${c.ddl}`);
  }
}

/** 幂等:IF NOT EXISTS,重复调用安全 */
export function initSchema(db: DB): void {
  db.exec(SCHEMA_SQL);
  // 幂等索引:jobs.status 被启动恢复/孤儿清理扫描,audio_item_tags.tag_id 会被连接过滤
  db.exec('CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_audio_item_tags_tag ON audio_item_tags(tag_id)');
  // 2026-09-29 用户拍板:音频库要显示「第几集 / 所属合集」——老库(表已存在)靠这里补列,不会因缺列报错
  ensureColumns(db, 'audio_items', [
    { name: 'entry_index', ddl: 'entry_index INTEGER' },
    { name: 'collection_title', ddl: 'collection_title TEXT' },
  ]);
  // 2026-09-29 用户拍板:分组视图要作品封面 → imported_sources 存封面原始地址(图片本体落盘在 covers/)
  ensureColumns(db, 'imported_sources', [
    { name: 'thumbnail', ddl: 'thumbnail TEXT' },
  ]);
}
