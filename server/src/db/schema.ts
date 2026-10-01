import type { DB } from './index.js';
import { pushLog } from '../logs.js';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS audio_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('download','recording','edit')),
  source_url TEXT,
  entry_index INTEGER,
  collection_title TEXT,
  parent_id INTEGER, -- PRD FR-3.7 的原方案(关联"源音频"):今天的剪辑输入是视频、系统里没有"源音频"对象,实际血缘走 source_import_id;本列保留未用(spec audio-lineage D10)
  -- 2026-10-01 spec audio-lineage D1:剪辑血缘 —— 指向 imported_sources.id。
  -- 不用 parent_id:PRD FR-3.7 原话是"关联源音频",但今天的剪辑输入是视频(source_videos),
  -- 系统里没有"源音频"这个对象,parent_id 指不动;它留给未来"从音频剪音频"(列本就在,非新增,D10)
  source_import_id INTEGER,
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
    { name: 'source_import_id', ddl: 'source_import_id INTEGER' }, // 2026-10-01 spec audio-lineage D1
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
  // 2026-10-01 spec audio-lineage D5:血缘回填(幂等)。
  // 不做这一步的后果:老的下载音频(有 url、无外键)与新导出的音频(有外键)会各建一张卡——同一个来源两张卡,
  // 比改造前还差。回填让前端只需认外键一条口径。
  // 只认"精确等于"导不进来的行(空串/NULL/来源早已删除)保持 NULL,由前端收进「无来源」卡(D7)。
  // 计数口径(2026-10-01 终审 I-2):SQLite 的 changes 是"WHERE 命中行数",不是"值真的变了的行数"——
  // 匹配不到来源的行(子查询给 NULL=实际没变)会被计入,导致"补 K 行"虚高,还盖住了"非空但查不到来源"这个有诊断价值的信号。
  // 故自己数"回填前候选"与"回填后残留"的差,并把这个残留量单独暴露出来。
  const countUnresolved = (): number => {
    const row = db.prepare(
      "SELECT COUNT(*) AS c FROM audio_items WHERE source_import_id IS NULL AND source_url IS NOT NULL AND source_url <> ''",
    ).get() as { c: number | bigint };
    return Number(row.c);
  };
  const before = countUnresolved();
  db.prepare(
    'UPDATE audio_items SET source_import_id = (SELECT id FROM imported_sources WHERE url = audio_items.source_url) ' +
    "WHERE source_import_id IS NULL AND source_url IS NOT NULL AND source_url <> ''",
  ).run();
  const residual = countUnresolved();
  pushLog('info', 'server', `血缘回填:补上 source_import_id ${before - residual} 行;仍有 ${residual} 行 source_url 非空但查不到来源(进「无来源」卡)`);
}
