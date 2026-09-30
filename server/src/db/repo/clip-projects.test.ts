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
