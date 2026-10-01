# 剪辑作品（1:N）+ 剪辑室作品墙 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development 逐任务实现；**禁止 commit**（见 Global Constraints）。

**Goal:** 把"资料 ↔ 剪辑"从 1:1 改成 1:N（一个视频可以剪出多个作品），把剪辑室从"资料卡片墙 + 下钻列表"重构成**作品墙**（卡片直达编辑页、无限下拉、hover 快速预览），删除随作品走。

**Architecture:** 服务端把 `clip_projects` 重建成作品表（去掉 `import_id` 的 UNIQUE）、成品加 `source_work_id`、路由按作品 id 操作；前端把 `studio.tsx` 从"三类卡 + 两个视图 + 下钻 + 分页"重写成"单一作品墙 + 无限下拉 + hover 预览"，`studio-detail.tsx` 增加作品名与成品明细。

**Tech Stack:** Fastify 5 + node:sqlite（server，脚本需 `--experimental-sqlite`）｜UmiJS Max 4 + antd 5（web）

**Spec:** `docs/superpowers/specs/2026-10-01-clip-works.md`（决定 D1–D23、§0.3 迁移、§0.4 契约、§0.5 UI、§0.8 验收 20 条）

## Global Constraints

- **禁止 commit**：提交授权制——子代理一律不 commit。每个任务最后一步是「停在此处」。
- **每任务第一步 Read 目标文件磁盘实况**（不信记忆、不信本计划的行号——行号只是导航）；每次编辑后**读回核对**；同一文件**禁止并行** `SearchReplace`。
- **不引入任何新依赖**——尤其是**不许引入虚拟滚动库**（`react-window` / `rc-virtual-list`），见 D21。
- **不要用 `GetDiagnostics`**（TS Server 有缓存）；用 `pnpm typecheck` / `pnpm --filter @sct/server test`。
- `pushLog(level, source, message)` 的 source 只能用 `server/src/logs.ts:15` 联合类型里的既有值（本计划用 `'server'` / `'job'` / `'project'` / `'media'`）；level 只有 `'debug' | 'info' | 'error'`。
- **不加外键约束、不加索引**（库没开外键，本仓一贯靠代码显式维护）。
- **迁移三条纪律**（§0.3）：① 备份失败要**继续**迁移（只记 error）；② 重建**整段包事务**（DDL 可回滚），且开头 `DROP TABLE IF EXISTS clip_projects_new`；③ **备份/重建/清理三步各自包 try/catch，任何异常都不许从 `initSchema` 抛出去**（启动路径不能被迁移拖垮）——这条只管本 spec 新增的三步，**既有的 D8 纠偏与 Spec A 回填维持原样**。
- **权威关系**：成品归属以 `source_work_id` 为准，`source_import_id` 是由作品推出的冗余（D5）。
- **删除语义**：删作品 = 连它的段与全部成品（D6）；删资料 = 作品与成品**保留**（D7）；换集重下 = 只清空该资料下所有作品的段（D8）。删文件失败不阻断接口。
- **web 包没有测试设施**（`web/src/**/*.test.*` 零文件）→ 前端任务验收 = `pnpm typecheck` + `pnpm --filter @sct/web build` + **人工目验清单**（标「未执行，交用户目验」）。不新建测试框架。
- 验证基线（2026-10-01，Spec A 落地后实测）：`pnpm typecheck` 三包 0 错；`pnpm --filter @sct/server test` **42 文件 / 407 用例**；`pnpm --filter @sct/web build` 成功；`pnpm --filter @sct/desktop build` exit 0。
- 中文注释，说明「为什么」；失败路径要有日志，**不得静默 catch**。
- **`studio.tsx` 沿用内联 style**（既有风格），不引入 styled-components、不新建 sc 文件。

---

## Task 1: 服务端 · 迁移三件套（备份 / 重建作品表 / 成品挂回 + 清理）

**Files:**
- Modify: `server/src/db/schema.ts`（建表语句改 1:N；新增三个迁移函数；`initSchema` 接受 `opts.dbPath` 并串起它们）
- Modify: `server/src/index.ts`（找到 `initSchema(db)` 调用点，传入数据库文件路径）
- Test: `server/src/db/schema.test.ts`

**Interfaces:**
- Produces: `initSchema(db: DB, opts?: { dbPath?: string }): void`（第二参可选：不传 = 内存库/未知路径 → 跳过备份并记一行 info）；`clip_projects` 表**不再有 UNIQUE**；`audio_items.source_work_id` 列存在。

- [ ] **Step 1: 读磁盘实况**

Read `server/src/db/schema.ts` 全文、`server/src/db/tx.ts`（`inTransaction` 的签名）、`server/src/db/schema.test.ts` 全文（既有 4 例 D8 纠偏 + Spec A 加的 4 例回填，**都不能改坏**）、`server/src/index.ts` 里 `initSchema` 的调用点。记下三处实际行号进报告。

- [ ] **Step 2: 写失败测试**

在 `server/src/db/schema.test.ts` 末尾追加（沿用文件既有的 `insertAudio` / `initSchema` 用法；新开一个 describe）：

```ts
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
    db.prepare('INSERT INTO clip_projects (import_id, name) VALUES (?, ?)').run(imp, '唯一作品');
    const wid = (db.prepare('SELECT id FROM clip_projects WHERE import_id = ?').get(imp) as { id: number }).id;
    db.prepare('INSERT INTO audio_items (title, source_type, source_url, file_path, format) VALUES (?, ?, ?, ?, ?)')
      .run('老剪辑产物', 'edit', 'https://a/back', 'bk-1.mp3', 'mp3'); // source_url 命中 → Spec A 回填会给 source_import_id

    initSchema(db);

    expect(workOf('老剪辑产物')).toBe(wid);
  });

  it('清理：只清"edit + 无作品 + 无来源 + source_url 空"的行；有来源线索的一律保留', () => {
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
});
```

在文件顶部 import 区补（与既有 `initSchema` 同一批）：

```ts
import { createImportsRepo } from './repo/imports.js';
```

同时补一条**备份行为**的测试（用真实文件库，不用 `:memory:`——内存库没有文件可备份）：

```ts
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
```

（该用例需 import `mkdtempSync/readdirSync/rmSync` from `node:fs`、`tmpdir` from `node:os`、`join` from `node:path`。）

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm --filter @sct/server test -- src/db/schema.test.ts`
Expected: 新用例失败——`initSchema` 还不收第二参；重建逻辑不存在 → 老结构下"建第二个作品"抛 UNIQUE 约束错；`.bak` 不存在。

- [ ] **Step 4: 实现 —— 建表语句改 1:N**

Read 后在 `SCHEMA_SQL` 里把 `clip_projects` 的建表改为（**删掉 `import_id` 上的 UNIQUE，并把注释改成作品语义**）：

```sql
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
```

- [ ] **Step 5: 实现 —— 三个迁移函数**

在 `schema.ts` 里加（放在 `ensureColumns` 之后、`initSchema` 之前），并在文件顶部补 `import { copyFileSync, existsSync, rmSync } from 'node:fs';`：

```ts
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

/** clip_projects 1:1 → 1:N 重建(2026-10-01 spec clip-works D2)。
 *  SQLite 删不掉列上的 UNIQUE,只能建新表 → 搬数据 → 换名;**整段包事务**(DDL 可回滚):
 *  否则崩在 DROP 与 RENAME 之间会只剩 clip_projects_new,下次启动重建出空表又撞上残表 → 应用永久起不来。
 *  幂等:读 sqlite_master 的建表 SQL,含 UNIQUE 才动手。返回是否真重建过(供"要不要备份"判断)。 */
function rebuildClipProjectsForOneToMany(db: DB): boolean {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'clip_projects'").get() as
    | { sql: string | null } | undefined;
  // 表不存在(全新库):SCHEMA_SQL 已按新结构建好,无需重建
  if (row === undefined || row.sql === null) return false;
  if (!/UNIQUE/i.test(row.sql)) return false;
  inTransaction(db, () => {
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
  });
  pushLog('info', 'server', '作品表重建:clip_projects 去掉 import_id UNIQUE(1:1 → 1:N)');
  return true;
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

/** 清理彻底无归属的老成品(2026-10-01 spec clip-works §0.3④ / 用户裁决 12)。
 *  条件刻意收窄:只有"edit + 无作品 + 无来源 + source_url 空"才清 —— 有网址线索的一律保留。
 *  纪律:单个文件删不掉只记日志;整段包 try/catch,**任何异常都不许抛给 initSchema**(启动路径不能被打挂)。 */
function cleanOrphanProducts(db: DB): void {
  try {
    const rows = db.prepare(
      "SELECT id, file_path FROM audio_items WHERE source_type = 'edit' AND source_work_id IS NULL " +
      "AND source_import_id IS NULL AND (source_url IS NULL OR source_url = '')",
    ).all() as Array<{ id: number; file_path: string }>;
    if (rows.length === 0) {
      pushLog('info', 'server', '旧成品清理:无无归属成品,删除 0 行');
      return;
    }
    let deletedFiles = 0;
    for (const r of rows) {
      // 逐条按 info 级打印:删掉的是用户的文件,事后必须查得到(info 会落盘,debug 只进内存环形缓冲)
      pushLog('info', 'server', `旧成品清理:删除文件 ${r.file_path}`);
      try { rmSync(r.file_path, { force: true }); deletedFiles += 1; }
      catch (e) { pushLog('error', 'server', `旧成品清理:文件删除失败 ${r.file_path}: ${e instanceof Error ? e.message : String(e)}`); }
    }
    const del = db.prepare('DELETE FROM audio_items WHERE id = ?');
    inTransaction(db, () => { for (const r of rows) del.run(r.id); });
    pushLog('info', 'server', `旧成品清理:删除 ${rows.length} 行,文件删除 ${deletedFiles} 个`);
  } catch (e) {
    pushLog('error', 'server', `旧成品清理失败(不阻断启动): ${e instanceof Error ? e.message : String(e)}`);
  }
}
```

- [ ] **Step 6: 实现 —— `initSchema` 串起来**

`initSchema` 签名改为 `export function initSchema(db: DB, opts?: { dbPath?: string }): void`，并在**现有内容末尾**（D8 纠偏与 Spec A 回填之后）追加：

```ts
  // 2026-10-01 spec clip-works §0.3:① 先补列(③ 的挂回要用 source_work_id) → ② 重建作品表(1:N)
  //   → ③ 老成品挂回作品 → ④ 清理彻底无归属的。备份只在"真要重建"时做一次。
  ensureColumns(db, 'audio_items', [
    { name: 'source_work_id', ddl: 'source_work_id INTEGER' }, // 指向 clip_projects.id;成品才有
  ]);
  const needRebuild = (() => {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'clip_projects'").get() as
      | { sql: string | null } | undefined;
    return row?.sql != null && /UNIQUE/i.test(row.sql);
  })();
  if (needRebuild) backupDbFile(opts?.dbPath);           // 备份失败也继续
  if (needRebuild) {
    // ★ ③④ 只在"本次真的重建了表"时执行(2026-10-01 实现期裁决,见 spec §0.3):
    //   它们是老库一次性整理;更关键的是——新库里出现"无归属成品"是 bug 信号,不该被自动删
    //   (那些行交给剪辑室的「无作品」安全网展示)。且既有测试(D8 纠偏 / Spec A 空串)造出的行
    //   与"该删的老数据"形态完全相同,每次启动都清会误删它们。
    try { runLegacyProductMigration(db); }
    catch (e) { pushLog('error', 'server', `作品迁移失败(不阻断启动): ${e instanceof Error ? e.message : String(e)}`); }
  }
```

配套的三个函数（**行删除与重建同事务；文件删除在提交之后**）：

```ts
/** 判据：老库形态(clip_projects 还带 import_id UNIQUE)才需要重建。表不存在(全新库)→ false */
function needsWorkTableRebuild(db: DB): boolean {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'clip_projects'").get() as
    | { sql: string | null } | undefined;
  return row?.sql != null && /UNIQUE/i.test(row.sql);
}

/** 重建作品表(去掉 import_id 的 UNIQUE)。**不含事务**——由调用方保证原子性。
 *  保留 id:clip_segments.project_id 必须继续指得对。开头 DROP IF EXISTS 收拾上次崩溃的残表。 */
function rebuildWorkTable(db: DB): void { /* Step 5 里那段 SQL，去掉 BEGIN/COMMIT */ }

/** 老库一次性作品迁移:重建 → 挂回 → 清行,三件事**同一个事务**;返回待删的文件路径清单。
 *  磁盘文件删除**不在这里**——IO 不可回滚,必须等提交之后单独做(失败只记日志)。 */
function runLegacyProductMigration(db: DB): string[] {
  const doomedFiles = inTransaction(db, () => {
    rebuildWorkTable(db);
    attachLegacyProductsToWorks(db);
    const rows = db.prepare(
      "SELECT id, file_path FROM audio_items WHERE source_type = 'edit' AND source_work_id IS NULL " +
      "AND source_import_id IS NULL AND (source_url IS NULL OR source_url = '')",
    ).all() as Array<{ id: number; file_path: string }>;
    const del = db.prepare('DELETE FROM audio_items WHERE id = ?');
    for (const r of rows) del.run(r.id);
    return rows.map((r) => r.file_path);
  });
  deleteFilesBestEffort(doomedFiles);   // 提交之后
  pushLog('info', 'server', `旧成品清理:删除 ${doomedFiles.length} 行,文件 ${doomedFiles.length} 个(逐个路径见下方 info 行)`);
  return doomedFiles;
}

/** 逐个删文件:失败只记日志,绝不抛。**逐个路径按 info 级打印**(删的是用户的文件,事后要能查) */
function deleteFilesBestEffort(paths: string[]): void {
  for (const p of paths) {
    pushLog('info', 'server', `旧成品清理:删除文件 ${p}`);
    try { rmSync(p, { force: true }); }
    catch (e) { pushLog('error', 'server', `旧成品清理:文件删除失败 ${p}: ${e instanceof Error ? e.message : String(e)}`); }
  }
}
```

⚠️ **两条测试必须按新规则重写**（实现期已实测会红）：`清理：只清…` 与 `老成品挂回…` 这两条用例，**必须先调用 `makeLegacy()` 造出"带 UNIQUE 的老表"**（否则不会触发重建 → ③④ 不执行 → 断言全落空）。`彻底无归属` 那条也必须插在 `makeLegacy()` 之后。

- [ ] **Step 7: 实现 —— `index.ts` 传 dbPath**

Read `server/src/index.ts`，找到 `initSchema(db)`（或 `initSchema(this.db)` 之类）的调用点，改成传入该库的文件路径（就是用来 `openDatabase(...)` 的那个变量；若路径在更上层，则把 `dbPath` 一层层传到能拿到的地方——**只传路径，不改装配结构**）。若确实拿不到路径，就在调用点旁写一行注释说明并保持 `initSchema(db)`（此时备份会记"路径未知,跳过"）——**这种情况必须写进报告**。

- [ ] **Step 8: 跑测试确认通过**

Run: `pnpm --filter @sct/server test -- src/db/schema.test.ts`
Expected: 全绿（含既有 D8 4 例、Spec A 回填 4 例、本任务新增 6 例）。

- [ ] **Step 9: 全量验证**

Run: `pnpm typecheck` → 三包 0 错。
Run: `pnpm --filter @sct/server test` → 全绿；把**实际**文件数/用例数写进报告（基线 407）。
Run: `pnpm --filter @sct/web build` → 成功（本任务没动 web，跑它是确认后端改动没波及）。

- [ ] **Step 10: 停在此处**

**不 commit。** 报告须含：Step 1 记下的四处行号、迁移三个函数的真实落点、`initSchema` 的实际签名与新调用点、全量测试实际数字、以及"dbPath 是否真的传到了"。

---

## Task 2: 服务端 · clip-projects repo 改成作品语义

**Files:**
- Modify: `server/src/db/repo/clip-projects.ts`（整文件按作品语义重写方法集）
- Test: `server/src/db/repo/clip-projects.test.ts`（既有用例按新签名改写 + 新增）

**Interfaces:**
- Produces（后续任务全部按这套签名调用）：
  ```ts
  export interface ClipSegmentRow { id: number; start_sec: number; end_sec: number; label: string | null; sort_order: number }
  /** 列表项 = 作品墙的一张卡的数据来源 */
  export interface WorkSummaryRow {
    id: number; import_id: number; name: string | null; updated_at: string;
    segment_count: number; product_count: number; total_sec: number;
    first_segment: { start_sec: number; end_sec: number } | null;
    /** 最新一条成品的 id（hover 预览"只有音频的卡"要播它）；没有成品 → null */
    latest_product_id: number | null;
    source: { title: string; site: string; kind: string; has_video: boolean } | null; // null = 资料已删
  }
  export interface WorkDetailRow { id: number; import_id: number; name: string | null; updated_at: string; segments: ClipSegmentRow[] }
  export interface SegmentInput { start_sec: number; end_sec: number; label?: string | null }
  export function createClipProjectsRepo(db: DB): {
    create(importId: number, name: string | null): WorkDetailRow;      // 新建作品(名字由调用方算好)
    get(projectId: number): WorkDetailRow | null;
    update(projectId: number, name: string | null, segments: SegmentInput[]): WorkDetailRow; // 全量替换段
    delete(projectId: number): number;                                  // 删作品 + 它的段(不含成品,成品由路由层连带)
    list(): WorkSummaryRow[];                                           // 作品墙用
    clearSegmentsByImportId(importId: number): { works: number; segments: number }; // 换集重下:清该资料下所有作品的段,保留作品行
    countByImportId(importId: number): number;                          // 该资料的作品数(替换确认文案用)
    countSegmentsByImportId(importId: number): number;                  // 该资料下全部作品的段数之和
    nextName(importId: number, sourceTitle: string): string;            // 默认名(序号取 max+1,D23)
  };
  ```
- Consumes: Task 1 的 1:N 表 + `audio_items.source_work_id`。

- [ ] **Step 1: 读磁盘实况**

Read `server/src/db/repo/clip-projects.ts` 全文、`server/src/db/repo/clip-projects.test.ts` 全文、`server/src/db/tx.ts`。记下：哪些方法被别处调用（`grep -rn "clip-projects\|projectsRepo" server/src --include=*.ts`），**逐个列出调用点**——它们都要在 Task 3/4 跟着改，这份清单是给后续任务的地图。

- [ ] **Step 2: 写失败测试**

把 `clip-projects.test.ts` 里针对旧签名（按 import_id 的 `get/upsert/delete/clearByImportId`）的用例**改写**成新签名，并新增：

```ts
it('同一资料可建两个作品，互不干扰', () => {
  const repo = createClipProjectsRepo(db);
  const a = repo.create(1, '甲');
  const b = repo.create(1, '乙');
  repo.update(a.id, '甲', [{ start_sec: 0, end_sec: 5 }]);
  repo.update(b.id, '乙', [{ start_sec: 10, end_sec: 20 }, { start_sec: 30, end_sec: 40 }]);
  expect(repo.get(a.id)!.segments).toHaveLength(1);
  expect(repo.get(b.id)!.segments).toHaveLength(2);
  expect(repo.list()).toHaveLength(2);
});
it('list 的形状:段数/成品数/总时长/首段/资料(null = 资料已删)', () => {
  const imp = createImportsRepo(db).upsertByUrl({ url: 'https://a/w', title: '资料甲', site: 'bilibili', kind: 'single', duration_sec: null, entries: null });
  const repo = createClipProjectsRepo(db);
  const w = repo.create(imp, '作品甲');
  repo.update(w.id, '作品甲', [{ start_sec: 0, end_sec: 5 }, { start_sec: 10, end_sec: 22 }]);
  const audioRepo = createAudioItemsRepo(db);
  audioRepo.create({ title: '成品1', source_type: 'edit', source_url: '', source_work_id: w.id, file_path: 'C:/t/p1.mp3', format: 'mp3', duration_sec: null, file_size: 1 });
  audioRepo.create({ title: '成品2', source_type: 'edit', source_url: '', source_work_id: w.id, file_path: 'C:/t/p2.mp3', format: 'mp3', duration_sec: null, file_size: 1 });
  audioRepo.create({ title: '别的作品的', source_type: 'edit', source_url: '', source_work_id: 999, file_path: 'C:/t/p3.mp3', format: 'mp3', duration_sec: null, file_size: 1 });
  const row = repo.list()[0]!;
  expect(row.segment_count).toBe(2);
  expect(row.product_count).toBe(2);          // 只数自己的成品
  expect(row.total_sec).toBeCloseTo(17);
  expect(row.first_segment).toEqual({ start_sec: 0, end_sec: 5 });
  expect(row.source).toMatchObject({ title: '资料甲', has_video: false });
  db.prepare('DELETE FROM imported_sources WHERE id = ?').run(imp);
  expect(repo.list()[0]!.source).toBeNull();  // 资料删了 → 作品还在,source 变 null
});
it('clearSegmentsByImportId 只清段、保留作品行', () => {
  const repo = createClipProjectsRepo(db);
  const a = repo.create(1, '甲'); const b = repo.create(1, '乙');
  repo.update(a.id, '甲', [{ start_sec: 0, end_sec: 5 }]);
  repo.update(b.id, '乙', [{ start_sec: 0, end_sec: 5 }]);
  expect(repo.clearSegmentsByImportId(1)).toEqual({ works: 1, segments: 2 }); // 语义:保留 1 个作品行? -> 见下
  ...
});
it('nextName 取 max+1(删掉 2 号再建得 3,不回收到 2)', () => {
  const repo = createClipProjectsRepo(db);
  expect(repo.nextName(1, '资料甲')).toBe('《资料甲》 的剪辑');
  repo.create(1, repo.nextName(1, '资料甲'));
  expect(repo.nextName(1, '资料甲')).toBe('《资料甲》 的剪辑 2');
  ... // 删掉名字带 2 的那个后再取 → 仍是 3(用 max+1 的语义,具体见 Step 4 的实现)
});
```

⚠️ **`clearSegmentsByImportId` 的返回形状以 Step 4 的实现为准**：本计划定为 `{ works, segments }` = "被清空段的**作品数** + 被删掉的**段数**"（`works` 只数"确实有段被清掉"的作品，供替换确认文案说"N 个作品、M 个剪辑点"）。测试按这个语义写。

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm --filter @sct/server test -- src/db/repo/clip-projects.test.ts`
Expected: 编译/类型失败（新签名不存在）与断言失败。

- [ ] **Step 4: 实现**

按 `Interfaces` 重写整个 repo（**保留头部注释并更新为先说清"它就是作品表"**）。要点：

- `create`：`INSERT INTO clip_projects (import_id, name) VALUES (?, ?)` → 读回详情（`updated_at` 用列默认值即可）。
- `get`：按 `id`（不再是 import_id）。
- `update`：**事务内** 先 `UPDATE clip_projects SET name = ?, updated_at = datetime('now') WHERE id = ?`（**`updated_at` 必须显式写**：SQLite 列默认值只对 INSERT 生效），再 `DELETE FROM clip_segments WHERE project_id = ?` + 逐条 `INSERT`（全量替换，沿用旧实现的形状）。
- `delete`：事务内删段 + 删作品行，返回删除的**作品行数**（0/1，幂等不抛）。**不动成品**——成品由路由层负责（D6）。
- `list`：一条 SQL 带出全部派生列：
  ```sql
  SELECT p.id, p.import_id, p.name, p.updated_at,
         (SELECT COUNT(*) FROM clip_segments s WHERE s.project_id = p.id) AS segment_count,
         (SELECT COALESCE(SUM(s.end_sec - s.start_sec), 0) FROM clip_segments s WHERE s.project_id = p.id) AS total_sec,
         (SELECT COUNT(*) FROM audio_items a WHERE a.source_work_id = p.id) AS product_count,
         (SELECT a.id FROM audio_items a WHERE a.source_work_id = p.id ORDER BY a.created_at DESC, a.id DESC LIMIT 1) AS latest_product_id
  FROM clip_projects p ORDER BY p.updated_at DESC, p.id DESC
  ```
  再对每行补 `first_segment`（`SELECT start_sec, end_sec FROM clip_segments WHERE project_id = ? ORDER BY sort_order ASC, id ASC LIMIT 1`）与 `source`（`importsRepo.get(import_id)`，查不到 → `null`，`has_video` 取该行的 `has_video`）。
  ⚠️ 作品数量小（个人工具），逐行补两次查询可以接受；**不要**为了少两次查询把 SQL 写成难读的大 JOIN。
- `clearSegmentsByImportId`：事务内
  ```sql
  DELETE FROM clip_segments WHERE project_id IN (SELECT id FROM clip_projects WHERE import_id = ?)
  ```
  先 `SELECT COUNT(DISTINCT project_id)`（有段的作品数）与 `changes`（被删段数）后返回，**不删作品行**。
- `countByImportId` / `countSegmentsByImportId`：直接 `COUNT(*)`。
- `nextName`：查该资料下所有 `name`，按正则 `^《<源标题>》 的剪辑(?: (\d+))?$` 匹配，取出现的最大序号（无则 1），返回 `《${title}》 的剪辑${n > 1 ? ` ${n}` : ''}`。
  ⚠️ 源标题里可能有正则元字符 → **用 `escapeRegExp` 或改用字符串前缀解析**（推荐后者：`startsWith(\`《${title}》 的剪辑\`)` 后取尾段数字）。**不要**把标题直接塞进 `new RegExp`。

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm --filter @sct/server test -- src/db/repo/clip-projects.test.ts`
Expected: 全绿。

- [ ] **Step 6: 全量验证**

Run: `pnpm typecheck` → 0 错（**此步起会连带报出 Task 3/4 要改的调用点**——把报错清单抄进报告，别去改它们）。
Run: `pnpm --filter @sct/server test` → 把实际数字写进报告（预期：`clip-projects.test.ts` 通过；`project-routes.test.ts` 等可能因签名变化失败——**这是预期的红色，留给 Task 3**，请在报告里列清楚"哪些文件红、为什么"）。

- [ ] **Step 7: 停在此处**

**不 commit。**

---

## Task 3: 服务端 · 作品路由（新建/读/改/删 + 连带删成品）+ 导出链

**Files:**
- Modify: `server/src/media/project-routes.ts`（路由参数语义换成作品 id；新增 POST；DELETE 连带删成品；export 的 payload 与校验）
- Modify: `server/src/db/repo/audio-items.ts`（**`AudioItemCreate` 加 `source_work_id?: number | null`、INSERT 的列清单与参数位同步**——成品仓库现在还不支持这一列，不补上这条链就走不通）
- Modify: `server/src/ytdlp/ingest.ts`（`ingestDownloadedFile` 加 `sourceWorkId?: number | null` 入参并透传）
- Modify: `server/src/media/ffmpeg-export.ts`（payload 加 `projectId`/`workName`；入库写 `source_work_id`；**入库前校验作品是否还在 = D22**）
- Test: `server/src/media/project-routes.test.ts`、`server/src/db/repo/audio-items.test.ts`、`server/src/ytdlp/ingest.test.ts`、`server/src/media/ffmpeg-export.test.ts`

**Interfaces:**
- Consumes: Task 2 的 repo 全部方法；`audio_items.source_work_id`（Task 1）；`deleteAudioFile`（既有 `server/src/audio-files.ts`）。
- Produces:
  - `POST /api/projects {importId}` → `201 {ok, project}`（默认名走 `repo.nextName`）
  - `GET|PUT|DELETE /api/projects/:projectId`
  - `DELETE` 返回 `{ ok, deleted, deleted_products }`
  - `ExportJobPayload` 增 `projectId: number; workName: string | null`

- [ ] **Step 1: 读磁盘实况**

Read `server/src/media/project-routes.ts`、`server/src/media/project-routes.test.ts`、`server/src/media/ffmpeg-export.ts`、`server/src/media/ffmpeg-export.test.ts`、`server/src/audio-files.ts`（`deleteAudioFile` 的签名与失败语义）。记下：`parseSegments` / `MAX_SEGMENTS` 的现有约束、export 路由里取 `video.file_path` 与 `prefix` 的几行、`buildMergeArgs` 的入参。

- [ ] **Step 2: 写失败测试**（`project-routes.test.ts`）

```ts
it('POST /api/projects 新建作品:默认名带序号,同一资料可建两个', async () => {
  const imp = seedImportWithVideo();          // 造 1 个资料 + 1 份视频素材文件（沿用既有 helper 的写法）
  const r1 = await app.inject({ method: 'POST', url: '/api/projects', payload: { importId: imp } });
  expect(r1.statusCode).toBe(201);
  expect(r1.json().project.name).toBe('《资料甲》 的剪辑');
  const r2 = await app.inject({ method: 'POST', url: '/api/projects', payload: { importId: imp } });
  expect(r2.json().project.name).toBe('《资料甲》 的剪辑 2');
  expect(r2.json().project.id).not.toBe(r1.json().project.id);
});
it('POST 无视频素材 / 素材文件丢失 → 404(后者 FILE_MISSING 且带 next)', async () => {
  const imp = seedImportWithoutVideo();
  const r = await app.inject({ method: 'POST', url: '/api/projects', payload: { importId: imp } });
  expect(r.statusCode).toBe(404);
  const imp2 = seedImportWithVideo({ deleteFile: true });
  const r2 = await app.inject({ method: 'POST', url: '/api/projects', payload: { importId: imp2 } });
  expect(r2.statusCode).toBe(404);
  expect(r2.json().error.code).toBe('FILE_MISSING');
  expect(r2.json().error.next).not.toBe('');   // 错误必须带可执行的下一步
});
it('DELETE 作品 → 连它的成品一起删(DB 行 + 磁盘文件),不影响别的作品', async () => {
  // 造：1 资料 2 作品;作品 A 有 2 条成品(文件真实落盘),作品 B 有 1 条
  // 断言：A 的作品行/段/成品行都没了、A 的 2 个文件也没了;B 原样保留
  expect(res.json().deleted_products).toBe(2);
});
it('DELETE 作品的文件删不掉(文件不存在) → 接口仍 200(不阻断)', async () => { /* 先 rmSync 掉文件再删作品 */ });
it('导出 payload 带 projectId/workName;作品不存在 → 404', async () => {
  const r = await app.inject({ method: 'POST', url: `/api/projects/${wid}/export`, payload: { mode: 'merge', format: 'mp3', segments: [{ start_sec: 0, end_sec: 1 }] } });
  expect(r.statusCode).toBe(201);
  const job = createJobsRepo(db).get(r.json().jobId as number)!;
  const saved = JSON.parse(job.payload) as { projectId: number; workName: string | null; importId: number };
  expect(saved.projectId).toBe(wid);
  expect(saved.workName).toBe('作品甲');
  expect(saved.importId).toBe(imp);          // 视频路径仍靠 importId
});
```

（`seedImportWithVideo` 等 helper 要真造 `imported_sources` + `source_videos` 行 + 一个真实存在的临时视频文件——**不要 mock 掉 `existsSync`**，文件丢失那条正是靠真实文件系统验的。）

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm --filter @sct/server test -- src/media/project-routes.test.ts`
Expected: 编译失败（`/api/projects` 还是按 importId 的旧签名、没有 POST）→ 逐条修不动就对了。

- [ ] **Step 4: 实现 —— 路由**

按 `Interfaces` 重写 `project-routes.ts` 的五个 handler。要点（**每条都要有依据，照写**）：

- **`POST /api/projects`**：校验 `importId`（非正整数 → 404）→ `importsRepo.get(importId) === null` → 404 `NOT_FOUND`（`next: '资料不存在，可能已被删除'`）→ `sourceVideosRepo.get(importId) === null` → 404（`next: '先到资料库下载视频素材'`）→ `!existsSync(video.file_path)` → 404 `FILE_MISSING`（`next: '回到资料库重新下视频'`）→ `repo.create(importId, repo.nextName(importId, importRow.title))` → `201`。日志：`pushLog('info', 'project', \`作品已创建 id=${w.id} import=${importId} name=${w.name}\`)`。
- **`GET /api/projects/:projectId`**：非法 id 或查不到 → 404；返回详情。
- **`PUT /api/projects/:projectId`**：`parseSegments` 校验照旧（**0 段合法**）；`name` 空白串 → `null`；作品不存在 → 404；保存成功日志。
- **`DELETE /api/projects/:projectId`**：
  ```ts
  // 1) 先取该作品的成品清单（DB 行还在时读得到 file_path）
  const products = audioRepo.listBySourceWork(projectId);   // ← 若 repo 没这个方法，就在 project-routes 里用 db 直接查（见下）
  // 2) 删作品 + 它的段（repo.delete 已包事务）
  const deleted = projectsRepo.delete(projectId);
  // 3) 删成品行（事务）——DB 行删掉就算"删了"（仓库语义）
  // 4) 再逐个删磁盘文件：失败只记日志，接口仍 200
  ```
  顺序说明写进注释：**先读路径 → 再删行 → 最后删文件**（反了就读不到路径）；文件删除放在事务外，失败不影响已提交的删除。成品行删除也包一个 `inTransaction`。
  就地查询用（避免为一次删除给 repo 加方法）：
  ```ts
  const products = db.prepare('SELECT id, file_path FROM audio_items WHERE source_work_id = ?').all(projectId) as Array<{ id: number; file_path: string }>;
  ```
- **`POST /api/projects/:projectId/export`**：参数换成作品；作品不存在 → 404；取该作品的 `import_id` 找视频素材与 `prefix`（`project.name ?? importRow.title ?? '剪辑音频'`）；payload 加 `projectId` 与 `workName: project.name`。

- [ ] **Step 5: 实现 —— 导出链（`ffmpeg-export.ts`）**

1) `ExportJobPayload` 加两个字段并在 `project-routes` 里填上（Step 4 已做）。
2) `ingest` 闭包里的 `ingestDownloadedFile({...})` 增加：
   ```ts
   sourceImportId: payload.importId,   // Spec A 的冗余列,继续写(权威是作品)
   sourceWorkId: payload.projectId,    // 2026-10-01 spec clip-works D4:成品挂作品
   ```
   ⚠️ `ingestDownloadedFile` 的入参名以 Spec A 落地后的实际签名为准（Read 确认；Spec A 加的是 `sourceImportId`），本任务再加 `sourceWorkId` 一项，并透传到 `audio_items.source_work_id`。
3) **D22 在途校验**：在**每一段/每次 ingest 之前**加：
   ```ts
   // D22:导出是异步的(几十秒到几分钟),用户完全可能中途删掉作品 → 入库前必须校验,
   // 否则会写出一条指向已删作品的成品(悬空行 + 白占一份文件)
   if (createClipProjectsRepo(deps.db).get(payload.projectId) === null) {
     try { rmSync(tmp, { force: true }); } catch { /* 尽力清理 */ }
     fail('作品已被删除，产物已丢弃');
     return;
   }
   ```
   （`separate` 模式在循环内逐段校验，`merge` 模式在 ingest 前校验一次。）

- [ ] **Step 6: 跑测试确认通过**

Run: `pnpm --filter @sct/server test -- src/media/project-routes.test.ts src/media/ffmpeg-export.test.ts`
Expected: 全绿（含新增的 D22 用例：起 job → 删作品 → job 结束无成品行且 status=error）。

- [ ] **Step 7: 全量验证**

Run: `pnpm typecheck`（把仍报红的调用点抄进报告——那是 Task 4 的活）；Run: `pnpm --filter @sct/server test`（把实际数字与"哪些文件仍红"写进报告）。

- [ ] **Step 8: 停在此处**

**不 commit。**

---

## Task 4: 服务端 · 跨模块联动（音频过滤 / 删资料 / 换集 / 首页 / 抽屉标题 / 设置键）

**Files:**
- Modify: `server/src/ytdlp/ytdlp-routes.ts`（`/api/audio?project=` 过滤；删资料不再清作品；换集改为清段）
- Modify: `server/src/db/repo/imports.ts`（派生列加 `work_count`，`segment_count` 口径改为"该资料下全部作品的段数之和"）
- Modify: `server/src/db/repo/home.ts`（`editing` 改作品维度）
- Modify: `server/src/media/jobs-routes.ts`（标题优先 `workName`）
- Modify: `server/src/settings-keys.ts`（加 `studioPreviewMuted`）
- Test: `server/src/ytdlp/ytdlp-routes.test.ts`、`server/src/media/home-routes.test.ts`、`server/src/db/repo/imports.test.ts`（若存在）

**Interfaces:**
- Produces：`GET /api/audio?project=<id>` 过滤；`HomeEditingRow` 增 `project_id`；设置键 `studio_preview_muted`（默认 `'1'`）。

- [ ] **Step 1: 读磁盘实况**

Read `server/src/ytdlp/ytdlp-routes.ts` 里 `/api/audio` 的实现与 `DELETE /api/imports/:id`（约 `:661-684`）、换集分支（约 `:210-216`）、`server/src/db/repo/imports.ts` 的 `DERIVED_COLS`、`server/src/db/repo/home.ts` 的 `editing`、`server/src/media/jobs-routes.ts` 的 `resolveTitle`、`server/src/settings-keys.ts`。

- [ ] **Step 2: 写失败测试**

```ts
// ytdlp-routes.test.ts
it('GET /api/audio?project=<id> 只回该作品的成品;不传 = 全部;传不存在的 id = 空数组', async () => { ... });
it('DELETE /api/imports/:id 不再动剪辑作品与成品', async () => {
  // 造 1 资料 + 1 作品 + 1 成品 → DELETE /api/imports/:id → 作品行与成品行都还在
});
it('换集重下:清空该资料下所有作品的段,保留作品行与成品', async () => {
  // 造 1 资料 + 2 作品(各有段) + 1 成品 → 触发 finalizeVideoDownload 的换集分支(或直接调 repo.clearSegmentsByImportId 的那段逻辑)
  // 断言:两个作品的 segments 都空、作品行还在、成品行还在
});
// home-routes.test.ts
it('editing 按作品返回(同一资料两个作品 → 两条,project_id 不同)', async () => { ... });
it('editing 排除资料已删的作品(INNER JOIN 语义保持)', async () => { ... });
// jobs-routes.test.ts（若存在）
it('标题优先用 payload.workName,没有才回退 importId 反查资料标题', async () => { ... });
```

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm --filter @sct/server test -- src/ytdlp/ytdlp-routes.test.ts src/media/home-routes.test.ts`
Expected: 新用例失败。

- [ ] **Step 4: 实现**

1) **`/api/audio` 过滤**（`ytdlp-routes.ts`）：读 `req.query.project`；是正整数 → 只回 `source_work_id = ?` 的行；**其它情况（不传 / 乱传）→ 维持现状回全部**（契约见 §0.4：它不是资源寻址，不报 404）。
   ⚠️ 实现要落在 `audioRepo.list()` 之后的路由层（`audioRepo` 只有 `list()`）——在路由里 `filter` 即可，**不要**为它改 repo。
2) **删资料**：删掉 `createClipProjectsRepo(db).clearByImportId(id)` 那一行（连带它的日志/注释），**换成一条说明性注释** + 一行日志：`pushLog('info', 'project', \`来源 ${id} 删除 → 剪辑作品与成品保留(只读)\`)`。
3) **换集**：把 `clearByImportId(row.id)` 换成 `repo.clearSegmentsByImportId(row.id)`，日志写成 `换集 ${old} → ${new}: 清空该资料下作品的剪辑点 作品${r.works}个/段${r.segments}个 import=${row.id}`。
4) **`imports.ts` 派生列**：`segment_count` 改成该资料下**全部作品**的段数之和：
   ```sql
   (SELECT COUNT(*) FROM clip_segments seg JOIN clip_projects p2 ON p2.id = seg.project_id WHERE p2.import_id = s.id) AS segment_count
   ```
   并新增 `(SELECT COUNT(*) FROM clip_projects p3 WHERE p3.import_id = s.id) AS work_count`；`ImportSummaryRow` 加 `work_count: number`，`mapBase` 加映射（`Number(r.work_count ?? 0)`）。
5) **`home.ts` 的 `editing`**：改成"作品 Top3"——`SELECT p.id AS project_id, p.import_id, p.name, s.site, p.updated_at, (段数子查询) FROM clip_projects p JOIN imported_sources s ON s.id = p.import_id ORDER BY p.updated_at DESC, p.id DESC LIMIT 3`；`HomeEditingRow` 把 `import_id` 保留、**新增 `project_id`**（前端要用它跳转）。
6) **`jobs-routes.ts`**：`JobPayloadShape` 加 `workName?: unknown`；`resolveTitle` 在 `payload.title` 之前插一级：`if (typeof payload.workName === 'string' && payload.workName.trim() !== '') return payload.workName;`。
7) **`settings-keys.ts`**：加
   ```ts
   // 剪辑室 hover 预览的默认开关（spec clip-works D12/D16）：'1' = 静音（默认）。加入白名单才能被 PUT。
   studioPreviewMuted: 'studio_preview_muted',
   ```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm --filter @sct/server test`
Expected: **全绿**（此时 Task 2/3 留下的红也应清掉）；把实际文件数/用例数写进报告；`pnpm typecheck` 三包 0 错。

- [ ] **Step 6: 停在此处**

**不 commit。**

---

## Task 5: 前端 · `api.ts` 契约改造

**Files:**
- Modify: `web/src/api.ts`

**Interfaces:**
- Produces（后续所有前端任务按这套调用）：
  ```ts
  export interface WorkSummaryDTO {
    id: number; import_id: number; name: string | null; updated_at: string;
    segment_count: number; product_count: number; total_sec: number;
    first_segment: { start_sec: number; end_sec: number } | null;
    source: { title: string; site: string; kind: string; has_video: boolean } | null;
  }
  export interface WorkDetailDTO { id: number; import_id: number; name: string | null; updated_at: string; segments: ClipSegmentDTO[] }
  export function listWorks(): Promise<WorkSummaryDTO[]>;
  export function createWork(importId: number): Promise<WorkDetailDTO>;
  export function getWork(projectId: number): Promise<WorkDetailDTO | null>;
  export function putWork(projectId: number, body: { name: string | null; segments: {...}[] }): Promise<WorkDetailDTO>;
  export function deleteWork(projectId: number): Promise<{ ok: boolean; deleted: number; deleted_products: number }>;
  export function exportWork(projectId: number, body: {...}): Promise<{ ok: boolean; jobId: number }>;
  export function listProducts(projectId: number): Promise<AudioRow[]>;   // /api/audio?project=
  export function getPreviewMuted(): Promise<boolean>;                     // 读设置
  export function setPreviewMuted(muted: boolean): Promise<void>;          // 写设置
  ```
  同时：`WorkSummaryDTO` 要带 `latest_product_id: number | null`（与 Task 2 的 `WorkSummaryRow` 逐字对齐）；**`AudioRow` 要加 `source_work_id: number | null`**（Task 6 的"无作品成品安全网"靠它筛，Task 4 的服务端已经会返回该列）。

- [ ] **Step 1: 读磁盘实况**

Read `web/src/api.ts` 的 `ClipProjectDTO` / `listProjects` / `getProject` / `putProject` / `deleteProject` / `exportProject` 区段，以及 `grep -rn "getProject\|listProjects\|putProject\|deleteProject\|exportProject" web/src` 列出全部调用点。

- [ ] **Step 2: 实现**（无 web 测试设施 → 本任务的验证是 typecheck + 逐调用点核对）

- 删掉旧的五个 project 函数，按 `Interfaces` 重写（**名字全部从 Project 改成 Work**，避免"project 到底是资料还是作品"的歧义留到后面）。
- `listProducts(projectId)`：`apiGet<AudioRow[]>(\`/api/audio?project=${projectId}\`)`。
- `getPreviewMuted`：`getSettings()` 后 `return (s['studio_preview_muted'] ?? '1') !== '0'`（**默认静音**）。
- `setPreviewMuted`：`putSettings({ studio_preview_muted: muted ? '1' : '0' })`。
- 每个函数都按文件既有风格加 `logFe('info', ...)`（写操作必须有；读操作不刷屏）。

- [ ] **Step 3: 验证**

Run: `pnpm typecheck` → **web 包会因为 Task 6–10 还没改的调用点报红**——把报错清单（文件:行）抄进报告，作为后续任务的清单；**不要**为了让 typecheck 变绿去改别的页面的行为（Task 9/10 会改）。

- [ ] **Step 4: 停在此处**

**不 commit。**

---

## Task 6: 前端 · 剪辑室重写为作品墙（卡片 / 无限下拉 / 删除 / 空态 / toolbar / 无作品安全网）

**Files:**
- Modify: `web/src/pages/studio.tsx`（**大幅重写**：删掉三类卡/两个视图/下钻/分页，改成单一作品墙）
- Test: 无（web 无测试设施）→ 验收 = `pnpm typecheck` + `pnpm --filter @sct/web build` + 人工目验清单

**Interfaces:**
- Consumes: Task 5 的 `listWorks / deleteWork / createWork / getPreviewMuted / setPreviewMuted`；Task 7 的 `<WorkPreview/>`（同一次任务内先写占位、Task 7 接入，或把 T7 并进本任务的 Step 里也可——见 §附）。
- Produces: 页面路由仍是 `/studio`；卡片点击 `navigate(\`/studio/${work.id}\`)`。

- [ ] **Step 1: 读磁盘实况**

Read `web/src/pages/studio.tsx` 全文（525 行）。**列出要被删掉的符号**：`ViewKind`、`WorkGroup`、`workCountText`、`GroupHeader`、`renderRow`、`mainTitle`/`episodeTag`/`episodeTitle`/`stripClipSuffix`/`formatDuration` 里哪些还会被用到（新页面只可能用到 `formatDuration`）。抄进报告。

- [ ] **Step 2: 实现 —— 新页面骨架**

把 `studio.tsx` 重写成（**保留文件顶部关于"锁死高度/三段结构/boxSizing"的历史注释**，那是布局铁律）：

```tsx
// web/src/pages/studio.tsx(剪辑室 = 作品墙)
// 2026-10-01 spec clip-works:一个资料可以有多个剪辑作品,卡片 = 一个作品,点整张卡进编辑页。
// 删掉了旧的三类卡(资料卡/源已删除/无来源)、平铺视图与下钻层、分页(改为无限下拉 + 分批渲染)。
// 布局铁律不变:整页锁死高度 —— 头(toolbar/搜索)固定、身(自己滚)、无脚(分页已删)。
import { Button, Empty, Input, Modal, Spin, Tag, Tooltip, Typography } from 'antd';
import { PlusOutlined, SoundOutlined, SearchOutlined } from '@ant-design/icons';
import { useNavigate } from '@umijs/max';
import { useEffect, useRef, useState } from 'react';
import { apiGet, audioFileUrl, coverUrl, deleteAudio, deleteWork, getPreviewMuted, listWorks, logFe, setPreviewMuted, type AudioRow, type WorkSummaryDTO } from '@/api';
import SiteLogo, { siteColor } from '@/components/SiteLogo';
// ⚠️ 本任务**不要** import WorkPreview / NewWorkModal —— 它们是 T7/T8 才创建的文件，
//    提前 import 会让 build 直接红。hover 预览与「新建作品」按钮分别由 T7、T8 接进来。

const BATCH = 20;               // 每批渲染 20 条(spec D13):服务端一次性返回全部,前端分批渲染
const CARD_MIN_WIDTH = 190;
const CARDS_MAX_WIDTH = 1160;

function formatDuration(sec: number): string { /* 原样搬过来 */ }

/** 作品卡:封面 + 作品名 + 资料名 + 摘要 + 最近编辑 + 删除;整张可点 = 进编辑页 */
function WorkCard({ work, previewOn, muted, onOpen, onDelete }: {...}) {
  const [coverBroken, setCoverBroken] = useState(false);
  const [hoverReady, setHoverReady] = useState(false);   // hover 停留 400ms 才起播
  const timer = useRef<number | null>(null);
  const tint = siteColor(work.source?.site ?? 'other');
  const summary = `成品 ${work.product_count} 条 · ${work.segment_count} 段 · 共 ${formatDuration(work.total_sec)}`;
  const enter = (): void => { timer.current = window.setTimeout(() => setHoverReady(true), 400); };
  const leave = (): void => { if (timer.current !== null) window.clearTimeout(timer.current); setHoverReady(false); };
  return (
    <div className="sct-card" role="button" tabIndex={0} aria-label={work.name ?? `作品 #${work.id}`}
      onClick={onOpen} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } }}
      onMouseEnter={enter} onMouseLeave={leave}
      style={{ border: '1px solid #f0f0f0', borderRadius: 10, background: '#fff', overflow: 'hidden', cursor: 'pointer', display: 'flex', flexDirection: 'column' }}>
      <div style={{ position: 'relative', aspectRatio: '16 / 9', background: tint.bg, overflow: 'hidden' }}>
        {work.source !== null && !coverBroken
          ? <img src={coverUrl(work.source.title ? work.import_id : work.import_id)} alt="" loading="lazy" onError={() => setCoverBroken(true)} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
          : <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><SiteLogo site={work.source?.site ?? 'other'} size={44} /></div>}
        {/* hover 快速预览在这里接入（T7 建好组件后回填这一行：<WorkPreview work={work} active={hoverReady} muted={muted} />） */}
        {work.source === null && <Tag color="default" style={{ position: 'absolute', right: 8, top: 8 }}>资料已删除</Tag>}
      </div>
      <div style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Typography.Text strong ellipsis={{ tooltip: work.name ?? '' }} style={{ minWidth: 0, flex: 1 }}>{work.name ?? `作品 #${work.id}`}</Typography.Text>
          {/* 删除:stopPropagation,否则会顺带进编辑页 */}
          <Tooltip title="删除这个作品（连同它的成品）">
            <Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={(e) => { e.stopPropagation(); onDelete(); }} />
          </Tooltip>
        </div>
        <Typography.Text type="secondary" ellipsis={{ tooltip: work.source?.title ?? '' }} style={{ fontSize: 12, minWidth: 0 }}>
          {work.source?.title ?? '（资料已删除）'}
        </Typography.Text>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>{summary}</Typography.Text>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>最近编辑 {work.updated_at}</Typography.Text>
      </div>
    </div>
  );
}
```

页面主体：

```tsx
export default function StudioPage() {
  const navigate = useNavigate();
  const [works, setWorks] = useState<WorkSummaryDTO[]>([]);
  const [orphans, setOrphans] = useState<AudioRow[]>([]);   // 无作品成品(安全网,通常为空)
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [shown, setShown] = useState(BATCH);                 // 已渲染条数
  const [muted, setMuted] = useState(true);
  const [newOpen, setNewOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const load = (): void => {
      // 主列表失败要显式报错;无作品成品只是安全网,失败只记日志(别把整页钉在错误态)
      listWorks().then((rows) => { setWorks(rows); setError(null); })
        .catch((e: Error) => { setError(e.message); logFe('error', `拉取作品列表失败: ${e.message}`); });
      void apiGet<AudioRow[]>('/api/audio')
        .then((rows) => setOrphans(rows.filter((r) => r.source_type === 'edit' && r.source_work_id == null)))
        .catch((e: Error) => logFe('error', `拉取无作品成品失败(不影响作品墙): ${e.message}`));
      void getPreviewMuted().then(setMuted).catch((e: Error) => logFe('error', `读取预览声音设置失败: ${e.message}`));
    };
    load();
    const off = onAudioChanged(load);                     // 既有:下载/导出完成后的进程内通知
    const onVisible = (): void => { if (document.visibilityState === 'visible') load(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', load);
    return () => { off(); document.removeEventListener('visibilitychange', onVisible); window.removeEventListener('focus', load); };
  }, []);

  // 无限下拉:哨兵元素进视口 → 多渲染一批。**重拉列表不重置 shown、不给容器加 key** →
  // 已渲染内容与滚动位置天然保住(spec D13 的"不跳回顶部"就是这么满足的)
  useEffect(() => {
    const el = sentinelRef.current;
    if (el === null) return undefined;
    const io = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) setShown((n) => Math.min(n + BATCH, works.length));
    }, { root: scrollRef.current, rootMargin: '200px' });
    io.observe(el);
    return () => io.disconnect();
  }, [works.length]);

  const onToggleMute = async (): Promise<void> => {
    const next = !muted; setMuted(next);
    if (!next) unlockAudio();                              // 见 WorkPreview 里的说明
    try { await setPreviewMuted(next); } catch (e) { logFe('error', `保存预览声音设置失败: ${(e as Error).message}`); }
  };

  const onDeleteWork = (w: WorkSummaryDTO): void => {
    Modal.confirm({
      title: `删除《${w.name ?? `作品 #${w.id}`}》?`,
      content: `将同时删除它的 ${w.product_count} 条成品（音频文件一并删除），不可恢复。`,
      okText: '删除', okType: 'danger', cancelText: '取消',
      onOk: async () => {
        try { await deleteWork(w.id); setWorks((prev) => prev.filter((x) => x.id !== w.id)); }
        catch (e) { logFe('error', `删除作品失败 id=${w.id}: ${(e as Error).message}`); throw e; }
      },
    });
  };
  // …渲染:头(toolbar + 搜索 + 共 N 个作品) / 身(卡片 grid + 哨兵) / 末尾无作品安全网分组
}
```

**约束（照做）**：
- **保留**：`onAudioChanged` / `visibilitychange` / `focus` 三个重拉时机（既有设计，别丢）。
- **保留搜索框**（spec 未提删除 → 不删功能）：过滤 `works`（作品名或资料名），过滤时 `setShown(BATCH)`。
- **删掉的**：`Pagination` / `Segmented` / `view` / `openKey` / `page` / `pageSize` / `GroupHeader` / `renderRow` / `WorkGroup` / 三类卡分支 / `workCountText` / `audioRefs`（播放器都搬去编辑页了）。
- 卡片网格：`display:grid; gridTemplateColumns: repeat(auto-fill, minmax(${CARD_MIN_WIDTH}px, 1fr)); gap:12; maxWidth: CARDS_MAX_WIDTH; margin:'0 auto'`。
- 无作品安全网分组：`orphans.length > 0` 时在列表末尾渲染一个 `Typography.Title level={5}`「无作品（N）」+ 这些成品行（每行：标题 + 播放器 + 删除，复用 `audioFileUrl` / `deleteAudio`）；`orphans.length === 0` 时**整块不渲染**。
- 空态：`Empty`「还没有剪辑作品」；**主按钮「新建作品」由 T8 接入**（本任务先只渲染 Empty 文案，不要放一个点了没反应的按钮）。
- 静音开关按钮：`<Button icon={muted ? <MutedOutlined/> : <SoundOutlined/>} onClick={() => void onToggleMute()} />` + Tooltip「预览声音：开/关」。

**验收要点（T6 重写时必须满足，替代本轮不修的另两条 OCR 问题；⚠️ T6 之后这一层会被整段重写成作品墙，所以这两条是"重写时不许再犯"的约束，不是要修现有代码）**：
- ① 卡内分组的**标题计数取全量**、不受分页/分批影响 —— 分组标题上的数字要来自**全部**成员，而不是"当前这一批/这一页"。
- ② `已下 N 集` 这类计数**只数素材（非 `edit` 行）**，不把成品算进去。

- [ ] **Step 3: 验证**

Run: `pnpm typecheck`（web 仍会因 Task 7/8 的组件未建而红——把清单抄进报告）
Run: `pnpm --filter @sct/web build` → 修到 `Compiled successfully`
**人工目验清单**（标「未执行，交用户目验」）：13/14/17/19 条（spec §0.8）。

- [ ] **Step 4: 停在此处**

**不 commit。**

---

## Task 7: 前端 · hover 快速预览（新组件）+ 声音开关

**Files:**
- Create: `web/src/components/WorkPreview.tsx`
- Modify: `web/src/pages/studio.tsx`（**两处接线**：① 在卡片封面区回填 `<WorkPreview work={work} active={hoverReady} muted={muted} />`（T6 已留了那行注释）；② 静音按钮切到"开"时调 `unlockAudio()`）

**Interfaces:**
- Produces: `export default function WorkPreview(props: { work: WorkSummaryDTO; active: boolean; muted: boolean }): JSX.Element | null`；`export function unlockAudio(): void`。

- [ ] **Step 1: 实现（新文件，**规格全部来自 spec §0.5 的 hover 表**）**

```tsx
// web/src/components/WorkPreview.tsx
// 剪辑室卡片的 hover 快速预览(spec clip-works D11 / §0.5)。
// 三条纪律,每条都有代价兜着:
//  ① 同一时刻只播 1 个 —— 鼠标划过一排卡时,每张都起播 = 十几个视频流同时解码(本地 CPU 直接跪)
//  ② 移开即卸载元素 —— 不只是 pause():留着元素就会留住解码器与 Range 连接
//  ③ 起播被拒要回退静音再试,最终失败也只记 debug —— hover 是个"随手"操作,不能弹错误框
let currentEl: HTMLMediaElement | null = null; // 模块级:全页面唯一在播的预览

export function unlockAudio(): void { /* 见下方实现 */ }
export default function WorkPreview({ work, active, muted }: {...}): JSX.Element | null { ... }
```

实现要点（**逐条落到代码**）：
1. `active === false` → `return null`（**卸载**，满足"移开立刻停 + 回到起点 + 不留元素"）。
2. 数据源二选一：`work.source !== null && work.source.has_video` → `<video muted={muted} playsInline preload="none" src={mediaFileUrl(work.import_id)} />`；否则若 `product_count > 0` → `<audio muted={muted} preload="none" src={audioFileUrl(最新成品 id)} />`（需要该作品最新成品的 id → **本任务给 `WorkSummaryDTO` 加一个字段 `latest_product_id: number | null`**，并在 Task 3 的列表接口里带上它：`(SELECT a.id FROM audio_items a WHERE a.source_work_id = p.id ORDER BY a.created_at DESC, a.id DESC LIMIT 1) AS latest_product_id`）；两者都没有 → `return null`（只剩封面）。
3. 起播：`el.currentTime = work.first_segment?.start_sec ?? 0`；有首段还要在 `timeupdate` 里到 `end_sec` 就 `pause()`（**播完那一段就停，不循环**）；没有首段则播开头 5 秒后停（用一个 `setTimeout` 或 timeupdate 判定）。
4. `currentEl?.pause(); currentEl = el;` 在 `play()` 之前执行（纪律①）。
5. `play()` 的 catch：先 `el.muted = true` 再 `play()` 一次；再失败 → `logFe('debug', ...)` + 回退封面（`setFailed(true)` → 组件返回 null）。
6. `onError`（加载失败）→ 同上回退。
7. `unlockAudio()`：
   ```ts
   /** 点"打开声音"那一下是本页唯一可靠的用户手势,拿它做一次"解锁"尝试(浏览器把"与本页有过交互"
    *  当作允许带声自动播放的依据之一)。失败无所谓 —— 真正的兜底是预览起播被拒时回退静音。 */
   export function unlockAudio(): void {
     try {
       const a = new Audio('data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=');
       a.volume = 0;
       void a.play().catch(() => { /* 忽略:解锁失败不影响静音预览 */ });
     } catch { /* 忽略 */ }
   }
   ```

- [ ] **Step 2: 验证**

Run: `pnpm typecheck` + `pnpm --filter @sct/web build` → 全绿。
**人工目验**（spec §0.8 第 15/16 条，标「未执行，交用户目验」）：停留 400ms 起播、快速划过不并发起播、移开立刻停并回起点、只有音频的卡显示封面+进度条、**打开声音后真的有声音**、关掉后静音、重启应用开关状态还在。

- [ ] **Step 3: 停在此处**

**不 commit。**

---

## Task 8: 前端 · 新建作品两条入口

**Files:**
- Create: `web/src/components/NewWorkModal.tsx`
- Modify: `web/src/pages/studio.tsx`（toolbar「新建作品」打开弹层）
- Modify: `web/src/pages/library.tsx`（工具栏加「剪辑」icon）

**Interfaces:**
- Consumes: `createWork(importId)`（Task 5）、`listImports()`（既有，返回含 `has_video`）。
- Produces: `<NewWorkModal open={boolean} onClose={() => void} onCreated={(projectId: number) => void} />`

- [ ] **Step 1: 读磁盘实况**

Read `web/src/pages/library.tsx` 的 `PageHeader` 那一块（约 `:320-360`）与它的"当前选中来源"状态（右栏渲染用的那个变量），记下变量名进报告。

- [ ] **Step 2: 实现 —— 弹层**

```tsx
// web/src/components/NewWorkModal.tsx
// 新建作品(spec clip-works D15):列"可剪的资料"(has_video=true)→ 选中 → POST /api/projects → 跳编辑页。
// 注意:has_video 只能保证"素材行在",保证不了"文件还在"(文件可能被外部删了)——挡在前端的是假闸门,
// 所以创建失败必须把服务端的 error.next 原样显示出来(apiPost 已经拼好)。
```
列表项：封面（`coverUrl(imp.id)`，onError 回退纯色）+ 标题 + `素材:第 N 集`（用 `material_entry_index`，`Number.isInteger` 判定）+ 「用这个剪辑」按钮。
空态：一个可剪资料都没有 → `Empty`「还没有可剪的视频素材」+「去资料库下载」。

- [ ] **Step 3: 实现 —— 两个入口**

1) `studio.tsx` toolbar：`<Button type="primary" icon={<PlusOutlined />} onClick={() => setNewOpen(true)}>新建作品</Button>`；`<NewWorkModal open={newOpen} onClose={() => setNewOpen(false)} onCreated={(id) => navigate(\`/studio/${id}\`)} />`。
2) `library.tsx` toolbar：加
   ```tsx
   <Tooltip title={canClip ? '用这份资料新建一个剪辑作品' : '先下载视频素材'}>
     <span>
       <Button icon={<ScissorOutlined />} disabled={!canClip} loading={creating} onClick={() => void onNewWork()} />
     </span>
   </Tooltip>
   ```
   `canClip = 当前选中来源 !== null && 当前选中来源.has_video`；`onNewWork` 调 `createWork(selected.id)` → `navigate(\`/studio/${w.id}\`)`；失败时 `message.error(err.message)`（带 `next`）。

- [ ] **Step 4: 验证**

Run: `pnpm typecheck` + `pnpm --filter @sct/web build` → 全绿。
**人工目验**（spec §0.8 第 13/17 条相关部分）：弹层里能看到资料；创建后直接进编辑页且时间轴是空的。

- [ ] **Step 5: 停在此处**

**不 commit。**

---

## Task 9: 前端 · 编辑页（作品名 / 成品明细 / 预览音频 / 只读态 / 路由参数）

**Files:**
- Modify: `web/src/pages/studio-detail.tsx`
- Modify: 路由配置（`web/.umirc.ts` 或 `web/config/routes.ts` —— 以磁盘实况为准）：`/studio/:importId` → `/studio/:projectId`

**Interfaces:**
- Consumes: Task 5 的 `getWork / putWork / exportWork / listProducts`；既有 `getImport / listMedia / getSettings / subscribeJob / deleteAudio / mediaFileUrl / waveformUrl / filmstripUrl`。

- [ ] **Step 1: 读磁盘实况**

Read `web/src/pages/studio-detail.tsx` 全文、路由配置文件、`web/src/api.ts` 的 `getWork/putWork/exportWork/listProducts`。记下：`useParams()` 的取法、`info` 的来源、`previewSrc` 怎么拼。

- [ ] **Step 2: 实现**

1) **路由参数**：`const { projectId } = useParams()`；`validId` 判定照旧。**视频与派生图仍按资料**：`const importId = work?.import_id ?? null`。
2) **加载**：
   ```tsx
   const [work, setWork] = useState<WorkDetailDTO | null>(null);
   const [nameDraft, setNameDraft] = useState('');
   useEffect(() => {
     if (!validId) return;
     getWork(projectIdNum)
       .then((w) => {
         if (w === null) { setError('作品不存在（可能已被删除）'); return; }
         setWork(w); setNameDraft(w.name ?? '');
         setSegments(w.segments.map((s) => ({ start_sec: s.start_sec, end_sec: s.end_sec, label: s.label ?? null })));
         setDirty(false);
       })
       .catch((e: Error) => logFe('error', `拉取作品失败 project=${projectId}: ${e.message}`));
   }, [projectIdNum, validId]);
   ```
3) **保存**：`putWork(projectIdNum, { name: nameDraft.trim() === '' ? null : nameDraft.trim(), segments })`（**不再拿资料标题当作品名**）。
4) **顶栏**：在现有 5 个图标按钮旁加——`<Input value={nameDraft} onChange={...} onBlur={() => setDirty(true)} style={{ width: 220 }} placeholder="作品名" />`（放 PageHeader 的 `title` 位或 toolbar 首位，二者取一，以视觉合理为准）；再加一个「预览音频」按钮（见 5）。
5) **预览音频**：`product_count > 0` 时可用 → 播放**该作品最新一条成品**（`listProducts` 里取第一条；用一个隐藏 `<audio controls autoPlay>` 或复用底部小播放条）；没有成品 → 禁用 + Tooltip「这个作品还没有导出过成品」。
6) **成品明细**（页面底部新块，spec D16/§0.5）：标题「已导出的成品」+ 列表（每条：标题 + `format/duration` + 播放按钮 + 删除按钮）；空态 `Empty`「这个作品还没有导出过成品」；**导出成功（`onStatus` done / `onDone`）后重新拉一次 `listProducts`**；单条删除走既有 `deleteAudio` + `Modal.confirm`（文案：`删除《标题》?` / `将同时删除音频文件，不可恢复。`）。
7) **只读态（资料已删 / 素材文件丢失）**：`work.import_id` 查不到资料，或 `<video>` 加载失败 → 顶部 `Alert type="warning"`「资料已删除，无法再编辑；已导出的成品仍可试听与删除」+ **禁用**保存/导出/打点/清空（`disabled`，Tooltip 说明原因），成品明细保持可用。

- [ ] **Step 3: 验证**

Run: `pnpm typecheck` + `pnpm --filter @sct/web build` → 全绿。
**人工目验**（spec §0.8 第 19 条）：资料已删的作品进编辑页只读、成品仍能试听/删除；正常作品能改名并保存。

- [ ] **Step 4: 停在此处**

**不 commit。**

---

## Task 10: 前端 · 首页「正在编辑」改作品维度

**Files:**
- Modify: `web/src/pages/index.tsx`

- [ ] **Step 1: 读磁盘实况**

Read `web/src/pages/index.tsx` 的 `HomeEditingRow` 用法（约 `:93-115`）与 `web/src/api.ts` 里的 `HomeEditingRow` 类型。

- [ ] **Step 2: 实现**

- `HomeEditingRow` 类型加 `project_id: number`（Task 4 的服务端已返回）。
- 点击跳转改成 `navigate(\`/studio/${row.project_id}\`)`，`logFe` 文案同步改成 `home editing → /studio/${row.project_id}`。
- 卡片正文显示作品名（`row.name ?? '未命名作品'`）+ 资料 `site`（既有）。

- [ ] **Step 3: 验证**

Run: `pnpm typecheck` + `pnpm --filter @sct/web build` → 全绿。
**人工目验**：首页列出的是作品、点卡进对应作品的编辑页。

- [ ] **Step 4: 停在此处**

**不 commit。**

---

## Task 11: 文档回扫 + 整支最终验证

**Files:**
- Modify: `server/src/db/schema.ts`（`clip_projects` 注释）、`server/src/db/repo/clip-projects.ts`（头部注释）、`web/src/pages/studio.tsx`（顶部历史注释）、`server/src/media/media-routes.ts`（休眠 clip 路由注释）
- Modify: `docs/superpowers/specs/m2-workspace.md`、`docs/prds/音频录制与剪辑-PRD初始篇.md`、`docs/superpowers/specs/2026-10-01-audio-lineage.md`（关系区指向本 spec）、`docs/superpowers/specs/2026-09-30-m2-remaining-p3-p4-p5.md`、`docs/superpowers/specs/m1c-video-clip.md`

- [ ] **Step 1: 按 spec §0.10 逐条扫**

Run（PowerShell）:
```powershell
Get-ChildItem d:\Seed\sound-control-tool\docs,d:\Seed\sound-control-tool\server\src,d:\Seed\sound-control-tool\web\src,d:\Seed\sound-control-tool\.trae\rules -Recurse -File -Include *.md,*.ts,*.tsx | Select-String -Pattern '一份工程|import_id UNIQUE|一对一|:importId|按来源网址|下钻|平铺|source_work_id|parent_id|血缘'
```
**再跑一版宽松扫描**（上一轮的教训：带反引号的关键词会被空格分隔的模式漏掉）：`Select-String -Pattern '归并|平铺|下钻|一对一|工程'`。
命中行**逐条对照现状**，改前/改后原文抄进报告。

- [ ] **Step 2: 逐处改**（spec §0.10 的 8 条 + 扫描新命中的行）

- [ ] **Step 3: 整支验证（实跑，数字取终态）**

```powershell
pnpm typecheck
pnpm --filter @sct/server test
pnpm --filter @sct/web build
pnpm --filter @sct/desktop build
```
把四项的**实际输出数字**写进报告；`git status --short` 的实际条数也要写（并核对：不得出现 `derived/`、`.sct/`、`.bak-*`、PNG 等产物进仓库）。

- [ ] **Step 4: 停在此处**

**不 commit。**

---

## 附：任务依赖与串行约束

- **严格串行**：T1 → T2 → T3 → T4（服务端，同一条链：表 → repo → 路由 → 联动）→ T5（前端契约）→ T6/T7/T8/T9/T10（前端页面）→ T11（文档 + 整支验证）。
- **T6 与 T7/T8 都改 `studio.tsx`**，且 T7 要新建 `WorkPreview.tsx`、T8 要新建 `NewWorkModal.tsx` —— **禁止并行**，按序做；每步之间 `pnpm --filter @sct/web build` 保证不半途崩。
- **T2/T3/T4 之间会有"预期红色"**（typecheck/测试报错指向下个任务要改的文件）——**这是切片的正常现象**，报告里写清"哪些红、为什么"，不要去提前改下一个任务的代码。
- **T9 会改路由配置**，改完必须手工点一次：剪辑室点卡 → 编辑页能正常加载（`/studio/:projectId` 生效）。
- 每个任务开工第一步 Read 磁盘实况；改完读回核对；`pnpm typecheck` 在每次编辑后跑。

## 附：交付切片建议（供用户提交时切分，子代理不 commit）

| 切片 | 内容 | 独立可验证 |
|---|---|---|
| ① 迁移 | T1 | server test 全绿（含老库升级用例） |
| ② 作品数据层 | T2 | repo 测试全绿 |
| ③ 路由与导出链 | T3 | 路由/导出测试全绿 |
| ④ 服务端联动 | T4 | server test 全绿 + typecheck 0 错（**后端到此可独立交付**） |
| ⑤ 前端契约 | T5 | typecheck 报错清单 = 后续任务的清单 |
| ⑥ 作品墙 | T6 + T7 | build 通过 + 目验 13/14/15/16 |
| ⑦ 新入口 | T8 | 目验：两条入口都能建作品并进编辑页 |
| ⑧ 编辑页与首页 | T9 + T10 | 目验 18/19 |
| ⑨ 文档回扫 | T11 | 四项验证 + git status 核对 |

