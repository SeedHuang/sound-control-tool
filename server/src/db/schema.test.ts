// server/src/db/schema.test.ts
// P4 T4：D8 历史纠偏（spec §0.4）。老库里错标成 'download' 的剪辑产物，在下次 initSchema 时被改成 'edit'。
// 手法：先建库并插入"老数据"，再跑一次 initSchema（模拟升级启动）触发纠偏，然后断言四例。
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type DB } from './index.js';
import { initSchema } from './schema.js';

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
