// server/src/db/schema.test.ts
// P4 T4：D8 历史纠偏（spec §0.4）。老库里错标成 'download' 的剪辑产物，在下次 initSchema 时被改成 'edit'。
// 手法：先建库并插入"老数据"，再跑一次 initSchema（模拟升级启动）触发纠偏，然后断言四例。
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type DB } from './index.js';
import { initSchema } from './schema.js';
import { createImportsRepo } from './repo/imports.js';

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
