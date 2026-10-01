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
-- 视频素材(2026-09-29,spec m1c-video-clip):与 imported_sources 一对一,import_id 即来源 id。
-- 不写 REFERENCES:库没开外键,级联不生效,删除来源时靠代码显式删(spec §0.1 事实 6)
CREATE TABLE IF NOT EXISTS source_videos (
  import_id INTEGER PRIMARY KEY,
  file_path TEXT NOT NULL,
  height INTEGER,
  file_size INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- 剪辑工程(2026-09-30,spec D7 提前落地):一个来源一份工程(import_id UNIQUE),P4 再扩 CRUD。
-- 不写 REFERENCES:库没开外键,级联不生效(与 source_videos 同款处理,删除靠代码显式删,spec §0.1 事实 6)
CREATE TABLE IF NOT EXISTS clip_projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  import_id INTEGER NOT NULL UNIQUE,
  name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS clip_segments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  start_sec REAL NOT NULL,
  end_sec REAL NOT NULL,
  label TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_clip_segments_project ON clip_segments(project_id, sort_order);
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
  // 2026-09-29 用户拍板:剪辑室要显示「第几集 / 所属合集」——老库(表已存在)靠这里补列,不会因缺列报错
  ensureColumns(db, 'audio_items', [
    { name: 'entry_index', ddl: 'entry_index INTEGER' },
    { name: 'collection_title', ddl: 'collection_title TEXT' },
  ]);
  // 2026-09-29 用户拍板:分组视图要作品封面 → imported_sources 存封面原始地址(图片本体落盘在 covers/)
  ensureColumns(db, 'imported_sources', [
    { name: 'thumbnail', ddl: 'thumbnail TEXT' },
  ]);
  // 2026-09-30 方案A(P2):视频素材一次只留一集,记"这份素材是哪一集"(单视频为 NULL)
  ensureColumns(db, 'source_videos', [
    { name: 'entry_index', ddl: 'entry_index INTEGER' },
  ]);
  // D8 历史纠偏(spec §0.4):早期 ingest 把剪辑产物硬编码记成 'download',但它们标题恒以 [mm:ss-mm:ss] 结尾。
  // LIKE 里 [ ] 是普通字符、_ 是通配 —— 正好匹配「[两位:两位-两位:两位]」;两位分钟写死会漏掉 ≥100 分钟的三段分钟(如 [120:00-121:30]),
  // 故补一段 GLOB 的纯数字字符类显式匹配。AND/OR 优先级与括号照 spec 原样。
  // ⚠️ 偏离 spec 一处:spec §0.4 的 GLOB 模式漏了收尾的 `]`(标题恒以 `]` 结尾),照抄实测(node:sqlite)三位分钟**不命中**;
  //    在模式末尾补上字面量 `]` 后命中(见 task-p4-4-report.md「偏离 1」)。幂等:条件锁定 source_type='download',已是 'edit' 的不会再改。
  db.exec(
    "UPDATE audio_items SET source_type='edit' " +
    "WHERE source_type='download' " +
    "AND title LIKE '%[__:__-__:__]' " +                       // 形如 [05:12-06:03]
    "OR (source_type='download' AND title GLOB '*[0-9][0-9][0-9]:[0-9][0-9]-[0-9][0-9][0-9]:[0-9][0-9]]');", // 三位分钟:形如 [120:00-121:30]
  );
}
