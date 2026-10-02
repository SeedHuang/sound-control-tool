// server/src/db/schema.test.ts
// P4 T4：D8 历史纠偏（spec §0.4）。老库里错标成 'download' 的剪辑产物，在下次 initSchema 时被改成 'edit'。
// 手法：先建库并插入"老数据"，再跑一次 initSchema（模拟升级启动）触发纠偏，然后断言四例。
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type DB } from './index.js';
import { initSchema } from './schema.js';
import { createImportsRepo } from './repo/imports.js';
import { createAudioItemsRepo } from './repo/audio-items.js'; // 2026-10-02 spec video-export D1:视频列透传用例(惯例在 repo/audio-items.test.ts,受本任务文件白名单约束暂放此处)

let db: DB;
beforeEach(() => { db = openDatabase(':memory:'); initSchema(db); });
afterEach(() => { db.close(); });

type Row = { title: string; source_type: string };
const insertAudio = (title: string, sourceType: string, file: string): void => {
  db.prepare('INSERT INTO audio_items (title, source_type, file_path, format) VALUES (?, ?, ?, ?)')
    .run(title, sourceType, file, 'mp3');
};
const typeOf = (title: string): string =>
  (db.prepare('SELECT source_type FROM audio_items WHERE title = ?').get(title) as Row).source_type;

describe('initSchema D8 历史纠偏', () => {
  it('两位分钟标题 [05:12-06:03] → 纠偏为 edit', () => {
    insertAudio('第 3 集 [05:12-06:03]', 'download', 'a.mp3');
    initSchema(db); // 升级启动：再跑一次 initSchema 触发纠偏
    expect(typeOf('第 3 集 [05:12-06:03]')).toBe('edit');
  });
  it('三位分钟标题 [120:00-121:30]（GLOB 段）→ 纠偏为 edit', () => {
    insertAudio('长片 [120:00-121:30]', 'download', 'b.mp3');
    initSchema(db);
    expect(typeOf('长片 [120:00-121:30]')).toBe('edit');
  });
  it('普通标题「第三集」→ 仍是 download（不误伤）', () => {
    insertAudio('第三集', 'download', 'c.mp3');
    initSchema(db);
    expect(typeOf('第三集')).toBe('download');
  });
  it('已是 edit 的行 → 仍是 edit（不重复改/不误伤）', () => {
    insertAudio('已纠偏 [01:00-02:00]', 'edit', 'd.mp3');
    initSchema(db);
    expect(typeOf('已纠偏 [01:00-02:00]')).toBe('edit');
  });
});

// 2026-10-01 spec audio-lineage D5：老音频按 source_url 精确匹配补出 source_import_id（幂等回填）
type IdRow = { source_import_id: number | null };
const insertAudioWithUrl = (title: string, sourceType: string, url: string | null, file: string): void => {
  db.prepare('INSERT INTO audio_items (title, source_type, source_url, file_path, format) VALUES (?, ?, ?, ?, ?)')
    .run(title, sourceType, url, file, 'mp3');
};
const importIdOf = (title: string): number | null =>
  (db.prepare('SELECT source_import_id FROM audio_items WHERE title = ?').get(title) as IdRow).source_import_id;

describe('initSchema 血缘回填（spec audio-lineage D5）', () => {
  it('source_url 能匹配上来源 → 补出 source_import_id', () => {
    const importId = createImportsRepo(db).upsertByUrl({
      url: 'https://a/pl', title: '某合集', site: 'bilibili', kind: 'single', duration_sec: null, entries: null,
    });
    insertAudioWithUrl('老下载', 'download', 'https://a/pl', 'bf-1.mp3');
    initSchema(db); // 模拟升级启动
    expect(importIdOf('老下载')).toBe(importId);
  });
  it('source_url 匹配不上任何来源 → 仍为 NULL（不瞎猜）', () => {
    insertAudioWithUrl('野音频', 'download', 'https://nowhere/x', 'bf-2.mp3');
    initSchema(db);
    expect(importIdOf('野音频')).toBeNull();
  });
  it('source_url 为空串 / NULL → 仍为 NULL（dev 库那 8 条导出片段就是这一类）', () => {
    insertAudioWithUrl('空串', 'edit', '', 'bf-3.mp3');
    insertAudioWithUrl('真 NULL', 'recording', null, 'bf-4.wav');
    initSchema(db);
    expect(importIdOf('空串')).toBeNull();
    expect(importIdOf('真 NULL')).toBeNull();
  });
  it('已填过的行不被改写（幂等 + 不覆盖）', () => {
    createImportsRepo(db).upsertByUrl({ url: 'https://a/pl', title: '某合集', site: 'bilibili', kind: 'single', duration_sec: null, entries: null });
    db.prepare('INSERT INTO audio_items (title, source_type, source_url, source_import_id, file_path, format) VALUES (?, ?, ?, ?, ?, ?)')
      .run('已填', 'edit', 'https://a/pl', 999, 'bf-5.mp3', 'mp3'); // 999 故意不存在：证明回填不"纠偏"已有值
    initSchema(db);
    initSchema(db); // 再跑一次，仍不应变
    expect(importIdOf('已填')).toBe(999);
  });
});

// 2026-10-01 spec clip-works §0.3：clip_projects 从 1:1 重建成 1:N（作品表），并把老成品挂回作品、清掉彻底无归属的
type PInfo = { id: number; import_id: number; name: string | null };
const tableSql = (t: string): string | null =>
  (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name = ?").get(t) as { sql: string | null } | undefined)?.sql ?? null;
const workOf = (title: string): number | null =>
  (db.prepare('SELECT source_work_id FROM audio_items WHERE title = ?').get(title) as { source_work_id: number | null }).source_work_id;

describe('initSchema 作品表迁移（spec clip-works §0.3）', () => {
  /** 造"老库"：先按旧结构建表（带 UNIQUE）插数据，再跑 initSchema —— 真正的升级路径 */
  const makeLegacy = (): void => {
    db.exec("DROP TABLE IF EXISTS clip_projects");
    db.exec("CREATE TABLE clip_projects (id INTEGER PRIMARY KEY AUTOINCREMENT, import_id INTEGER NOT NULL UNIQUE, name TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))");
    db.exec('CREATE TABLE IF NOT EXISTS clip_segments (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, start_sec REAL NOT NULL, end_sec REAL NOT NULL, label TEXT, sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime(\'now\')))');
  };
  const addImport = (url: string, title: string): number =>
    createImportsRepo(db).upsertByUrl({ url, title, site: 'bilibili', kind: 'single', duration_sec: null, entries: null });

  it('老库(带 UNIQUE)升级 → 表不再有 UNIQUE，作品 id 与段数都不变', () => {
    const imp = addImport('https://a/old', '老资料');
    makeLegacy();
    db.prepare('INSERT INTO clip_projects (id, import_id, name) VALUES (?, ?, ?)').run(77, imp, '老作品');
    db.prepare('INSERT INTO clip_segments (project_id, start_sec, end_sec, sort_order) VALUES (?, ?, ?, ?)').run(77, 1, 2, 0);
    db.prepare('INSERT INTO clip_segments (project_id, start_sec, end_sec, sort_order) VALUES (?, ?, ?, ?)').run(77, 3, 4, 1);

    initSchema(db); // 升级启动

    expect(tableSql('clip_projects')!.toUpperCase()).not.toContain('UNIQUE');
    const row = db.prepare('SELECT id, import_id, name FROM clip_projects WHERE id = 77').get() as PInfo;
    expect(row).toEqual({ id: 77, import_id: imp, name: '老作品' });
    expect((db.prepare('SELECT COUNT(*) AS c FROM clip_segments WHERE project_id = 77').get() as { c: number }).c).toBe(2);
    // 新建第二个作品不再被约束挡住
    expect(() => db.prepare('INSERT INTO clip_projects (import_id, name) VALUES (?, ?)').run(imp, '第二个')).not.toThrow();
  });

  it('同一个资料能建两个作品（旧结构会被 UNIQUE 挡下）', () => {
    const imp = addImport('https://a/two', '资料二');
    expect(() => {
      db.prepare('INSERT INTO clip_projects (import_id, name) VALUES (?, ?)').run(imp, '作品甲');
      db.prepare('INSERT INTO clip_projects (import_id, name) VALUES (?, ?)').run(imp, '作品乙');
    }).not.toThrow();
    expect((db.prepare('SELECT COUNT(*) AS c FROM clip_projects WHERE import_id = ?').get(imp) as { c: number }).c).toBe(2);
  });

  it('老成品挂回它所属的唯一作品（避免"有来源却无作品"→ 在新作品墙里看不见）', () => {
    const imp = addImport('https://a/back', '待挂回资料');
    makeLegacy(); // 必须先造成老库(带 UNIQUE):③④ 只在"本次真的重建了表"时执行,否则挂回不会跑、断言落空
    db.prepare('INSERT INTO clip_projects (import_id, name) VALUES (?, ?)').run(imp, '唯一作品');
    const wid = (db.prepare('SELECT id FROM clip_projects WHERE import_id = ?').get(imp) as { id: number }).id;
    db.prepare('INSERT INTO audio_items (title, source_type, source_url, file_path, format) VALUES (?, ?, ?, ?, ?)')
      .run('老剪辑产物', 'edit', 'https://a/back', 'bk-1.mp3', 'mp3'); // source_url 命中 → Spec A 回填会给 source_import_id

    initSchema(db);

    expect(workOf('老剪辑产物')).toBe(wid);
  });

  it('清理：只清"edit + 无作品 + 无来源 + source_url 空"的行；有来源线索的一律保留', () => {
    makeLegacy(); // 必须先造成老库(带 UNIQUE):③④ 只在"本次真的重建了表"时执行,否则清理不会跑、断言落空
    db.prepare('INSERT INTO audio_items (title, source_type, source_url, file_path, format) VALUES (?, ?, ?, ?, ?)')
      .run('彻底无归属', 'edit', '', 'bk-2.mp3', 'mp3');
    db.prepare('INSERT INTO audio_items (title, source_type, source_url, file_path, format) VALUES (?, ?, ?, ?, ?)')
      .run('有网址但来源已删', 'edit', 'https://nowhere/x', 'bk-3.mp3', 'mp3');
    db.prepare('INSERT INTO audio_items (title, source_type, source_url, file_path, format) VALUES (?, ?, ?, ?, ?)')
      .run('老下载音频', 'download', 'https://a/back', 'bk-4.mp3', 'mp3');

    initSchema(db);

    const left = (db.prepare('SELECT title FROM audio_items').all() as Array<{ title: string }>).map((r) => r.title);
    expect(left).not.toContain('彻底无归属');   // 被清
    expect(left).toContain('有网址但来源已删'); // 不在授权范围内 → 保留
    expect(left).toContain('老下载音频');       // 不是 edit → 保留
  });

  it('幂等 + 备份只做一次：连跑两次 initSchema，表结构不再变、不重复建 .bak', () => {
    const imp = addImport('https://a/idem', '幂等资料');
    db.prepare('INSERT INTO clip_projects (import_id, name) VALUES (?, ?)').run(imp, '作品');
    initSchema(db);
    const sql1 = tableSql('clip_projects');
    initSchema(db);
    expect(tableSql('clip_projects')).toBe(sql1);
  });

  it('真要重建时生成 .bak；第二次启动不再生成（幂等）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sct-mig-'));
    const dbPath = join(dir, 'sct.db');
    const d1 = openDatabase(dbPath);
    initSchema(d1);                       // 首次建库（新结构，不需要重建）
    d1.exec("DROP TABLE IF EXISTS clip_projects");
    d1.exec("CREATE TABLE clip_projects (id INTEGER PRIMARY KEY AUTOINCREMENT, import_id INTEGER NOT NULL UNIQUE, name TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))");
    initSchema(d1, { dbPath });            // 触发重建 → 备份
    const baks1 = readdirSync(dir).filter((f) => f.startsWith('sct.db.bak-'));
    expect(baks1).toHaveLength(1);
    initSchema(d1, { dbPath });            // 已重建 → 不再备份
    expect(readdirSync(dir).filter((f) => f.startsWith('sct.db.bak-'))).toHaveLength(1);
    d1.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

// 2026-10-01 OCR 审查 F2/F3:重建判据精确化(唯一索引覆盖单列 import_id) + 补回被 UNIQUE 顺带提供的索引
describe('initSchema 迁移判据与索引（F2/F3）', () => {
  const indexNames = (t: string): string[] =>
    (db.prepare(`PRAGMA index_list('${t}')`).all() as Array<{ name: string }>).map((r) => r.name);

  it('全新库:按 import_id 建的是非唯一索引,不会被误判为老库(再跑一次不重建)', () => {
    expect(indexNames('clip_projects')).toContain('idx_clip_projects_import');
    const sql1 = tableSql('clip_projects');
    initSchema(db); // 若判据把"非唯一索引"误当老库,这里会重建掉
    expect(tableSql('clip_projects')).toBe(sql1);
  });

  it('F2:其它列上的 UNIQUE 不触发破坏性重建(不是文本 grep「含 UNIQUE」)', () => {
    db.exec('DROP TABLE IF EXISTS clip_projects');
    db.exec("CREATE TABLE clip_projects (id INTEGER PRIMARY KEY AUTOINCREMENT, import_id INTEGER NOT NULL, name TEXT UNIQUE, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))");
    initSchema(db);
    // name 上有唯一索引、但 import_id 上没有单列唯一索引 → 不重建 → 表 SQL 仍带 UNIQUE
    expect(tableSql('clip_projects')!.toUpperCase()).toContain('UNIQUE');
  });

  it('F3:老库(import_id UNIQUE)升级后,按 import_id 的索引被补回', () => {
    db.exec('DROP TABLE IF EXISTS clip_projects');
    db.exec("CREATE TABLE clip_projects (id INTEGER PRIMARY KEY AUTOINCREMENT, import_id INTEGER NOT NULL UNIQUE, name TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))");
    initSchema(db); // 触发重建
    expect(tableSql('clip_projects')!.toUpperCase()).not.toContain('UNIQUE'); // 约束已去掉
    expect(indexNames('clip_projects')).toContain('idx_clip_projects_import'); // 索引补回
  });
});

// 2026-10-02 spec video-export D1:audio_items 加 media_kind/width/height 3 列 —— 视频成品入库复用整条成品链。
// 表名沿用 audio_items 不改(spec D1,clip_projects 同款先例);迁移照 Spec C T1 模式(幂等 ALTER 补列),
// 但**不重建表、不备份**——加列是无破坏性操作(不删行不改行,备份语义只挂"重建表 + 删文件"的破坏性迁移)。
type ColInfo = { name: string; type: string; notnull: number; dflt_value: unknown };
const audioCols = (): ColInfo[] => db.prepare('PRAGMA table_info(audio_items)').all() as ColInfo[];

describe('initSchema 视频列迁移(spec video-export D1)', () => {
  /** 造"老库":audio_items 降级回 2026-10-02 前的形态(已有 source_work_id 等列,唯独没有这 3 新列),其余表保持新结构 */
  const makeLegacyAudio = (): void => {
    db.exec('DROP TABLE IF EXISTS audio_items');
    db.exec(
      "CREATE TABLE audio_items (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, " +
      "source_type TEXT NOT NULL CHECK (source_type IN ('download','recording','edit')), source_url TEXT, " +
      'entry_index INTEGER, collection_title TEXT, parent_id INTEGER, source_import_id INTEGER, source_work_id INTEGER, ' +
      "file_path TEXT NOT NULL UNIQUE, format TEXT NOT NULL, duration_sec REAL, file_size INTEGER, " +
      "created_at TEXT NOT NULL DEFAULT (datetime('now')))",
    );
  };
  const insertLegacyRow = (): void => {
    db.prepare('INSERT INTO audio_items (title, source_type, source_url, source_work_id, file_path, format) VALUES (?, ?, ?, ?, ?, ?)')
      .run('老音频成品', 'edit', 'https://a/legacy', 9, 'leg-1.mp3', 'mp3');
  };

  it('新库:audio_items 含 media_kind/width/height;media_kind NOT NULL 默认 audio 且带 CHECK(spec D1 逐字)', () => {
    const cols = audioCols();
    expect(cols.find((c) => c.name === 'media_kind')).toMatchObject({ type: 'TEXT', notnull: 1, dflt_value: "'audio'" });
    expect(cols.find((c) => c.name === 'width')).toMatchObject({ type: 'INTEGER', notnull: 0, dflt_value: null });
    expect(cols.find((c) => c.name === 'height')).toMatchObject({ type: 'INTEGER', notnull: 0, dflt_value: null });
    // CHECK 在新库与 legacy(ALTER) 两条路径都生效——2026-10-02 审查用 node:sqlite 实证：
    // ALTER ADD COLUMN 的 CHECK 同样写进 sqlite_master 的建表文本（老注释说"不改"是错的），且插 'xxx'/NULL 都被拒。
    expect(tableSql('audio_items')).toContain("CHECK (media_kind IN ('audio','video'))");
  });

  it('老库(缺 3 列)升级 → 3 列出现;旧行 media_kind=audio、宽高 NULL;既有数据(挂作品的 source_work_id)不丢', () => {
    makeLegacyAudio();
    insertLegacyRow();
    initSchema(db); // 升级启动
    const names = audioCols().map((c) => c.name);
    expect(names).toContain('media_kind');
    expect(names).toContain('width');
    expect(names).toContain('height');
    const row = db.prepare('SELECT media_kind, width, height, source_work_id FROM audio_items WHERE title = ?')
      .get('老音频成品') as { media_kind: string; width: number | null; height: number | null; source_work_id: number };
    expect(row.media_kind).toBe('audio');     // NOT NULL DEFAULT 'audio' 回填旧行
    expect(row.width).toBeNull();
    expect(row.height).toBeNull();
    expect(row.source_work_id).toBe(9);       // 升级不动既有数据
  });

  it('迁移幂等:连跑两遍不炸、列不重复、结构不再变', () => {
    makeLegacyAudio();
    insertLegacyRow();
    initSchema(db);
    const cols1 = audioCols();
    expect(() => initSchema(db)).not.toThrow();
    expect(audioCols()).toEqual(cols1); // 列数与顺序分毫不变(不重复 ALTER)
    expect(cols1.filter((c) => c.name === 'media_kind')).toHaveLength(1);
  });

  it('备份语义:加列迁移不产生 .bak;与破坏性重建共存于同一次启动时,备份仍只做一次', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sct-n1-'));
    const dbPath = join(dir, 'sct.db');
    const d1 = openDatabase(dbPath);
    initSchema(d1); // 首次建库:新结构(含 3 列),无迁移
    // 降级成"老库":audio_items 缺 3 列(走 ensureColumns 加列) + clip_projects 带 UNIQUE(走重建 → 备份)
    d1.exec('DROP TABLE IF EXISTS audio_items');
    d1.exec(
      "CREATE TABLE audio_items (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, " +
      "source_type TEXT NOT NULL CHECK (source_type IN ('download','recording','edit')), source_url TEXT, " +
      'entry_index INTEGER, collection_title TEXT, parent_id INTEGER, source_import_id INTEGER, source_work_id INTEGER, ' +
      "file_path TEXT NOT NULL UNIQUE, format TEXT NOT NULL, duration_sec REAL, file_size INTEGER, " +
      "created_at TEXT NOT NULL DEFAULT (datetime('now')))",
    );
    d1.exec('DROP TABLE IF EXISTS clip_projects');
    d1.exec("CREATE TABLE clip_projects (id INTEGER PRIMARY KEY AUTOINCREMENT, import_id INTEGER NOT NULL UNIQUE, name TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))");
    initSchema(d1, { dbPath }); // 加列 + 重建同一次启动
    const names = (d1.prepare('PRAGMA table_info(audio_items)').all() as Array<{ name: string }>).map((r) => r.name);
    expect(names).toContain('media_kind'); // 3 列照常补上
    expect(readdirSync(dir).filter((f) => f.startsWith('sct.db.bak-'))).toHaveLength(1); // 备份恰 1 个(重建产生,加列不重复)
    initSchema(d1, { dbPath }); // 第二次启动:全幂等
    expect(readdirSync(dir).filter((f) => f.startsWith('sct.db.bak-'))).toHaveLength(1); // 不再备份
    d1.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

// 2026-10-02 spec video-export D1:repo 对 3 新列全链路透传。
// 注:repo 用例的惯例位置是 repo/audio-items.test.ts(同款先例「source_work_id 落库并回读」),
// 受本任务"只动 schema.test.ts"白名单约束暂放此处,后续批次可挪回。
describe('audioRepo 视频列透传(spec video-export D1)', () => {
  it('create 传 media_kind/width/height → get/list 回读一致', () => {
    const repo = createAudioItemsRepo(db);
    const id = repo.create({ title: '视频成品', source_type: 'edit', source_url: '', file_path: 'C:/tmp/v.mp4', format: 'mp4', duration_sec: 10, file_size: 1, media_kind: 'video', width: 3840, height: 2160 });
    const row = repo.get(id)!;
    expect(row.media_kind).toBe('video');
    expect(row.width).toBe(3840);
    expect(row.height).toBe(2160);
    const listed = repo.list()[0]!;
    expect(listed.media_kind).toBe('video');
    expect(listed.width).toBe(3840);
    expect(listed.height).toBe(2160);
  });
  it('create 不传 → media_kind=audio、width/height=null(老调用零回归)', () => {
    const repo = createAudioItemsRepo(db);
    const id = repo.create({ title: '音频成品', source_type: 'download', source_url: 'u', file_path: 'C:/tmp/a.mp3', format: 'mp3', duration_sec: null, file_size: 1 });
    const row = repo.get(id)!;
    expect(row.media_kind).toBe('audio');
    expect(row.width).toBeNull();
    expect(row.height).toBeNull();
  });
});
