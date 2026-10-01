// server/src/db/repo/clip-projects.test.ts
// P2 只落 clear/count 两个方法(spec D19 换集清工程);工程/段的"建"在 P4——用例用原生 SQL 造数据
import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type DB } from '../index.js';
import { initSchema } from '../schema.js';
import { createImportsRepo } from './imports.js';
import { createClipProjectsRepo } from './clip-projects.js';

let db: DB;
let importId: number;
beforeEach(() => {
  db = openDatabase(':memory:');
  initSchema(db);
  importId = createImportsRepo(db).upsertByUrl({
    url: 'https://a/pl', title: '凡人修仙传', site: 'bilibili', kind: 'playlist', duration_sec: null, entries: null,
  });
});

const makeProject = (): number =>
  Number(db.prepare('INSERT INTO clip_projects (import_id) VALUES (?)').run(importId).lastInsertRowid);
const insertSegment = (projectId: number, startSec: number, endSec: number): void => {
  db.prepare('INSERT INTO clip_segments (project_id, start_sec, end_sec) VALUES (?, ?, ?)').run(projectId, startSec, endSec);
};
const projectCount = (impId: number): number =>
  Number((db.prepare('SELECT COUNT(*) AS n FROM clip_projects WHERE import_id = ?').get(impId) as { n: number }).n);

describe('clip_projects repo', () => {
  it('clearByImportId:删段 + 删工程行,返回删除的段数;再清一次幂等返 0', () => {
    const repo = createClipProjectsRepo(db);
    const pid = makeProject();
    insertSegment(pid, 0, 10); insertSegment(pid, 10, 20); insertSegment(pid, 20, 30);
    expect(repo.countSegmentsByImportId(importId)).toBe(3);
    expect(repo.clearByImportId(importId)).toBe(3);
    expect(repo.countSegmentsByImportId(importId)).toBe(0);
    expect(projectCount(importId)).toBe(0);
    expect(repo.clearByImportId(importId)).toBe(0); // 已清过 → 幂等,不抛
  });
  it('clearByImportId:工程不存在 → 返回 0,不抛(幂等)', () => {
    expect(projectCount(importId)).toBe(0); // 没建过工程
    expect(createClipProjectsRepo(db).clearByImportId(importId)).toBe(0);
  });
  it('countSegmentsByImportId:无工程 → 0;有工程无段 → 0;有段 → 段数', () => {
    const repo = createClipProjectsRepo(db);
    expect(repo.countSegmentsByImportId(importId)).toBe(0); // 无工程
    const pid = makeProject();
    expect(repo.countSegmentsByImportId(importId)).toBe(0); // 有工程无段
    insertSegment(pid, 5, 15);
    insertSegment(pid, 15, 25);
    expect(repo.countSegmentsByImportId(importId)).toBe(2);
  });
  it('clear/count 只作用于本来源:别的来源的工程与段不受影响', () => {
    const otherImport = createImportsRepo(db).upsertByUrl({
      url: 'https://a/other', title: '别的来源', site: 'other', kind: 'single', duration_sec: null, entries: null,
    });
    const pid = makeProject();
    insertSegment(pid, 0, 10);
    const otherPid = Number(db.prepare('INSERT INTO clip_projects (import_id) VALUES (?)').run(otherImport).lastInsertRowid);
    db.prepare('INSERT INTO clip_segments (project_id, start_sec, end_sec) VALUES (?, ?, ?)').run(otherPid, 0, 99);
    const repo = createClipProjectsRepo(db);
    expect(repo.clearByImportId(importId)).toBe(1);
    expect(repo.countSegmentsByImportId(otherImport)).toBe(1); // 别家的段还在
    expect(projectCount(otherImport)).toBe(1); // 别家的工程行还在
  });
});

// —— P4-T3:CRUD(list/get/upsert/delete)——全量替换走 D18 事务、updated_at 走 D13 显式写 ——
describe('clip_projects repo CRUD(P4-T3)', () => {
  it('upsert 首次创建:段按 sort_order=0..n-1 落库,get 按 sort_order 升序返回', () => {
    const repo = createClipProjectsRepo(db);
    const saved = repo.upsert(importId, '我的工程', [
      { start_sec: 0, end_sec: 10, label: '开场' },
      { start_sec: 30, end_sec: 45 },
    ]);
    expect(saved).toMatchObject({ import_id: importId, name: '我的工程' });
    expect(saved.segments.map((s) => s.sort_order)).toEqual([0, 1]);
    expect(saved.segments.map((s) => s.start_sec)).toEqual([0, 30]);
    expect(saved.segments[0]!.label).toBe('开场');
    expect(saved.segments[1]!.label).toBeNull(); // 不传 label → null(不是缺字段)
    const got = repo.get(importId)!;
    expect(got.segments.map((s) => s.end_sec)).toEqual([10, 45]);
  });
  it('upsert 二次 = 全量替换:旧段消失、新段在、段数正确', () => {
    const repo = createClipProjectsRepo(db);
    repo.upsert(importId, 'n', [{ start_sec: 0, end_sec: 1 }, { start_sec: 1, end_sec: 2 }, { start_sec: 2, end_sec: 3 }]);
    const after = repo.upsert(importId, 'n', [{ start_sec: 100, end_sec: 200 }]);
    expect(after.segments).toHaveLength(1);
    expect(after.segments[0]!.start_sec).toBe(100);
    expect(repo.countSegmentsByImportId(importId)).toBe(1);
    // 段表里只剩 1 行(旧 3 行真被删,不是标记)
    const left = db.prepare('SELECT COUNT(*) AS n FROM clip_segments').get() as { n: number };
    expect(Number(left.n)).toBe(1);
  });
  it('D13:updated_at 由代码显式写——UPDATE 分支不靠列默认值(默认值只对 INSERT 生效)', () => {
    const repo = createClipProjectsRepo(db);
    repo.upsert(importId, 'n', [{ start_sec: 0, end_sec: 5 }]);
    // 手工把时间戳改到 2000 年,再 upsert;若 UPDATE 分支没写 updated_at,就还是 2000(注:不能靠连比两次 datetime('now')——秒级精度会相等导致 flake)
    db.prepare("UPDATE clip_projects SET updated_at='2000-01-01 00:00:00' WHERE import_id=?").run(importId);
    repo.upsert(importId, 'n', [{ start_sec: 0, end_sec: 5 }]);
    expect(repo.get(importId)!.updated_at).not.toBe('2000-01-01 00:00:00');
  });
  it('D18:写新段中途失败 → 整体回滚,旧段一条不少', () => {
    const repo = createClipProjectsRepo(db);
    repo.upsert(importId, 'n', [{ start_sec: 0, end_sec: 10 }, { start_sec: 20, end_sec: 30 }]);
    // 第 2 段的 label 给「不可绑定值」({} 不是 node:sqlite 接受的类型)→ 写段抛 TypeError,
    // 此时旧段已被 DELETE,若没事务这 2 段就永久没了
    expect(() =>
      repo.upsert(importId, 'n', [{ start_sec: 0, end_sec: 5 }, { start_sec: 0, end_sec: 10, label: {} as never }]),
    ).toThrow();
    const after = repo.get(importId)!;
    expect(after.segments.map((s) => s.start_sec)).toEqual([0, 20]); // 旧段完好
    expect(after.segments.map((s) => s.end_sec)).toEqual([10, 30]);
  });
  it('delete:删工程与段,返回 1;再删返回 0(幂等);get 变 null', () => {
    const repo = createClipProjectsRepo(db);
    repo.upsert(importId, 'n', [{ start_sec: 0, end_sec: 5 }]);
    expect(repo.countSegmentsByImportId(importId)).toBe(1);
    expect(repo.delete(importId)).toBe(1);
    expect(repo.get(importId)).toBeNull();
    expect(repo.countSegmentsByImportId(importId)).toBe(0);
    expect(repo.delete(importId)).toBe(0); // 不存在 → 0,不抛
  });
  it('list:按 updated_at 新→旧;segment_count 正确', () => {
    const other = createImportsRepo(db).upsertByUrl({
      url: 'https://a/list-other', title: '别的来源', site: 'other', kind: 'single', duration_sec: null, entries: null,
    });
    const repo = createClipProjectsRepo(db);
    repo.upsert(importId, '甲', [{ start_sec: 0, end_sec: 5 }, { start_sec: 5, end_sec: 9 }]);
    repo.upsert(other, '乙', [{ start_sec: 0, end_sec: 5 }]);
    db.prepare("UPDATE clip_projects SET updated_at='2000-01-01 00:00:00' WHERE import_id=?").run(importId); // 甲变「很旧」
    const rows = repo.list();
    expect(rows.map((r) => r.import_id)).toEqual([other, importId]); // 乙(now)在前
    expect(rows[0]).toMatchObject({ import_id: other, name: '乙', segment_count: 1 });
    expect(rows[1]).toMatchObject({ import_id: importId, name: '甲', segment_count: 2 });
  });
});
