import type { DB } from './index.js';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS audio_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('download','recording','edit')),
  source_url TEXT,
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
`;

/** 幂等:IF NOT EXISTS,重复调用安全 */
export function initSchema(db: DB): void {
  db.exec(SCHEMA_SQL);
  // 幂等索引:jobs.status 被启动恢复/孤儿清理扫描,audio_item_tags.tag_id 会被连接过滤
  db.exec('CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_audio_item_tags_tag ON audio_item_tags(tag_id)');
}
