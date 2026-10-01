import { copyFileSync, existsSync, rmSync } from 'node:fs';
import type { DB } from './index.js';
import { pushLog } from '../logs.js';
import { inTransaction } from './tx.js';

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
-- 剪辑作品(2026-10-01 spec clip-works D1/D2):一行 = 一次剪辑(名字 + 剪辑点 + 成品)。
-- import_id **不再 UNIQUE**:同一个资料可以有多个作品(1:N)。老库靠 initSchema 里的重建迁移去掉旧约束。
-- 不写 REFERENCES:库没开外键,级联不生效(与 source_videos 同款处理)
CREATE TABLE IF NOT EXISTS clip_projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  import_id INTEGER NOT NULL,
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

/** 备份数据库文件(2026-10-01 spec clip-works §0.3⓪)。
 *  只在"确实要重建"时调用一次;失败**继续迁移**,只记 error —— 不能因为备份失败把用户挡在门外。
 *  内存库/路径未知 → 记一行 info 跳过(测试大量用 :memory:)。 */
function backupDbFile(dbPath: string | undefined): void {
  if (dbPath === undefined || dbPath === ':memory:' || !existsSync(dbPath)) {
    pushLog('info', 'server', '迁移备份:非磁盘库(内存库或路径未知),跳过');
    return;
  }
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15); // YYYYMMDDHHMMSS 级
  const target = `${dbPath}.bak-${stamp}`;
  try {
    copyFileSync(dbPath, target);
    pushLog('info', 'server', `迁移备份:${target}`); // 用户唯一的退路,必须留痕
  } catch (e) {
    pushLog('error', 'server', `迁移备份失败:${e instanceof Error ? e.message : String(e)}(继续迁移)`);
  }
}

/** 判据:老库形态(clip_projects 还带 import_id UNIQUE)才需要重建。
 *  表不存在(全新库)→ false:SCHEMA_SQL 已按新结构建好,无事可做。
 *  ③ 挂回 / ④ 清理 都以此为准——它们只在"本次真的重建了表"时执行(见 runLegacyProductMigration 注释)。 */
function needsWorkTableRebuild(db: DB): boolean {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'clip_projects'").get() as
    | { sql: string | null } | undefined;
  if (row === undefined || row.sql === null) return false; // 表不存在:全新库,无需重建
  return /UNIQUE/i.test(row.sql);                          // SQLite 删不掉列上的 UNIQUE,只在老库形态下动手
}

/** 重建作品表(去掉 UNIQUE)。**不含事务**——由调用方保证原子性(与挂回/清行同进同出,见 runLegacyProductMigration)。
 *  SQLite 删不掉列上的 UNIQUE,只能建新表 → 搬数据 → 换名。保留 id:clip_segments.project_id 必须继续指得对。
 *  开头先 DROP TABLE IF EXISTS clip_projects_new:收拾上次崩溃可能留下的残表(幂等前提)。 */
function rebuildWorkTable(db: DB): void {
  db.exec('DROP TABLE IF EXISTS clip_projects_new'); // 收拾上次崩溃可能留下的残表(幂等前提)
  db.exec(
    'CREATE TABLE clip_projects_new (id INTEGER PRIMARY KEY AUTOINCREMENT, import_id INTEGER NOT NULL, name TEXT, ' +
    "created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))",
  );
  // 显式带 id:clip_segments.project_id 必须继续指得对
  db.exec('INSERT INTO clip_projects_new (id, import_id, name, created_at, updated_at) SELECT id, import_id, name, created_at, updated_at FROM clip_projects');
  db.exec('DROP TABLE clip_projects');
  db.exec('ALTER TABLE clip_projects_new RENAME TO clip_projects');
  // AUTOINCREMENT 序号对齐(RENAME 已把 sqlite_sequence.name 改成新名)
  db.exec("UPDATE sqlite_sequence SET seq = (SELECT COALESCE(MAX(id), 0) FROM clip_projects) WHERE name = 'clip_projects'");
  pushLog('info', 'server', '作品表重建:clip_projects 去掉 import_id UNIQUE(1:1 → 1:N)');
}

/** 把老成品挂回它所属的唯一作品(2026-10-01 spec clip-works §0.3③)。
 *  不做这步:老库里由剪辑路径产出的成品(有 source_import_id、无作品)既不会被清理、也没有作品可挂
 *  → 在新作品墙里彻底看不见。迁移那一刻 1:1 仍是事实,故"该资料恰好 1 个作品"时映射唯一。 */
function attachLegacyProductsToWorks(db: DB): number {
  const n = Number(
    db.prepare(
      'UPDATE audio_items SET source_work_id = (SELECT p.id FROM clip_projects p WHERE p.import_id = audio_items.source_import_id) ' +
      "WHERE source_type = 'edit' AND source_work_id IS NULL AND source_import_id IS NOT NULL " +
      'AND (SELECT COUNT(*) FROM clip_projects p WHERE p.import_id = audio_items.source_import_id) = 1',
    ).run().changes,
  );
  if (n > 0) pushLog('info', 'server', `作品迁移:老成品挂回作品 ${n} 行`);
  return n;
}

/** 逐个删文件:失败只记日志绝不抛。
 *  逐个路径按 info 级打印(删的是用户的文件,事后要能查;info 会落盘,debug 只进内存环形缓冲)。 */
function deleteFilesBestEffort(paths: string[]): void {
  for (const p of paths) {
    pushLog('info', 'server', `旧成品清理:删除文件 ${p}`);
    try { rmSync(p, { force: true }); }
    catch (e) { pushLog('error', 'server', `旧成品清理:文件删除失败 ${p}: ${e instanceof Error ? e.message : String(e)}`); }
  }
}

/** 老库一次性作品迁移:重建 → 挂回 → 清行,三件事**同一个事务**(原子);返回待删文件路径清单。文件删除在提交之后。
 *
 *  为什么"③ 挂回 + ④ 清理 只在本次真重建时执行"(由 initSchema 用 needsWorkTableRebuild 守卫):
 *   1. 它们是**老库一次性数据整理**,与重建同生命周期 —— 行删除与重建放同一个事务(原子,任一失败整体回滚);
 *      磁盘文件删除放在提交之后(IO 不可回滚,删不掉只记日志,不能让异常打挂启动路径)。
 *   2. 更重要的是:**新库里出现"无归属成品"是 bug 信号,不该被自动删** —— 那些行交给剪辑室的「无作品」安全网
 *      展示给用户看(可见 = 可管理)。若每次启动都清,形态相同的合法数据(如空串 url 的 edit 行)会被静默误删。
 *
 *  清理条件刻意收窄:只有"edit + 无作品 + 无来源 + source_url 空"才清 —— 有网址线索的一律保留。 */
function runLegacyProductMigration(db: DB): string[] {
  const files = inTransaction(db, (): string[] => {
    rebuildWorkTable(db);
    attachLegacyProductsToWorks(db);
    const rows = db.prepare(
      "SELECT id, file_path FROM audio_items WHERE source_type = 'edit' AND source_work_id IS NULL " +
      "AND source_import_id IS NULL AND (source_url IS NULL OR source_url = '')",
    ).all() as Array<{ id: number; file_path: string }>;
    const del = db.prepare('DELETE FROM audio_items WHERE id = ?');
    for (const r of rows) del.run(r.id);
    if (rows.length > 0) pushLog('info', 'server', `旧成品清理:删除 ${rows.length} 行`);
    return rows.map((r) => r.file_path);
  });
  // 文件删除在提交之后:IO 不可回滚,失败只记日志(见 deleteFilesBestEffort)
  deleteFilesBestEffort(files);
  return files;
}

/** 幂等:IF NOT EXISTS,重复调用安全 */
export function initSchema(db: DB, opts?: { dbPath?: string }): void {
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

  // 2026-10-01 spec clip-works §0.3:① 先补列(③ 的挂回要用 source_work_id) → ② 重建作品表(1:N)
  //   → ③ 老成品挂回作品 → ④ 清理彻底无归属的。
  // ③④ 只在"本次真的重建了表"(老库形态)时执行 —— 详见 runLegacyProductMigration 头部两条理由:
  //   它是老库一次性整理(与重建同生命周期),且新库里的"无归属成品"是 bug 信号、应由安全网展示而非自动删。
  ensureColumns(db, 'audio_items', [
    { name: 'source_work_id', ddl: 'source_work_id INTEGER' }, // 指向 clip_projects.id;成品才有
  ]);
  if (needsWorkTableRebuild(db)) {
    backupDbFile(opts?.dbPath);            // 备份失败也继续(失败策略不变:只记日志,不阻断启动)
    try { runLegacyProductMigration(db); } // 重建+挂回+清行同一事务;文件删除在提交后
    catch (e) { pushLog('error', 'server', `作品迁移失败(不阻断启动): ${e instanceof Error ? e.message : String(e)}`); }
  }
}
