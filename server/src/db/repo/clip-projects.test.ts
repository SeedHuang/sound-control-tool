// server/src/db/repo/clip-projects.test.ts
// 作品语义(2026-10-01 spec clip-works D1/D2):一个资料可有多作品(1:N)。
// 覆盖:作品 CRUD、作品墙 list 的派生列、换集清段(保作品行)、默认名 nextName。
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

/** 造一条成品,挂在某个作品下。用 raw SQL 而非成品仓库 create:那条路径的入参尚未含 source_work_id
 *  (成品由路由层负责连带,见 spec clip-works D6),此处只需把行写进库供 list 的派生列统计。返回行 id。 */
const insertProduct = (workId: number, title: string, path: string): number =>
  Number(
    db.prepare(
      "INSERT INTO audio_items (title, source_type, source_url, source_work_id, file_path, format, duration_sec, file_size) " +
      "VALUES (?, 'edit', '', ?, ?, 'mp3', NULL, 1)",
    ).run(title, workId, path).lastInsertRowid,
  );
const productCount = (): number =>
  Number((db.prepare('SELECT COUNT(*) AS n FROM audio_items').get() as { n: number }).n);

describe('clip_projects repo · 作品语义', () => {
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

  it('list 的形状：段数/成品数/总时长/首段/资料(null = 资料已删)', () => {
    const imp = createImportsRepo(db).upsertByUrl({ url: 'https://a/w', title: '资料甲', site: 'bilibili', kind: 'single', duration_sec: null, entries: null });
    const repo = createClipProjectsRepo(db);
    const w = repo.create(imp, '作品甲');
    repo.update(w.id, '作品甲', [{ start_sec: 0, end_sec: 5 }, { start_sec: 10, end_sec: 22 }]);
    insertProduct(w.id, '成品1', 'C:/t/p1.mp3');
    insertProduct(w.id, '成品2', 'C:/t/p2.mp3');
    insertProduct(999, '别的作品的', 'C:/t/p3.mp3');
    const row = repo.list()[0]!;
    expect(row.segment_count).toBe(2);
    expect(row.product_count).toBe(2);          // 只数自己的成品
    expect(row.total_sec).toBeCloseTo(17);
    expect(row.first_segment).toEqual({ start_sec: 0, end_sec: 5 });
    expect(row.source).toMatchObject({ title: '资料甲', has_video: false });
    db.prepare('DELETE FROM imported_sources WHERE id = ?').run(imp);
    expect(repo.list()[0]!.source).toBeNull();  // 资料删了 → 作品还在,source 变 null
  });

  it('clearSegmentsByImportId 只清段、保留作品行(works=确实有段被清的作品数)', () => {
    const repo = createClipProjectsRepo(db);
    const a = repo.create(1, '甲');
    const b = repo.create(1, '乙');
    repo.create(1, '丙'); // 没段的空作品:不该计入 works
    repo.update(a.id, '甲', [{ start_sec: 0, end_sec: 5 }]);
    repo.update(b.id, '乙', [{ start_sec: 0, end_sec: 5 }, { start_sec: 10, end_sec: 12 }]);
    expect(repo.clearSegmentsByImportId(1)).toEqual({ works: 2, segments: 3 });
    expect(repo.countByImportId(1)).toBe(3);            // 作品行一个没删
    expect(repo.get(a.id)!.segments).toHaveLength(0);   // 段清空
    expect(repo.countSegmentsByImportId(1)).toBe(0);
    expect(repo.clearSegmentsByImportId(1)).toEqual({ works: 0, segments: 0 }); // 幂等:没段可清
  });

  it('nextName 取现存最大号+1;删掉最大号时该号被回收(D23)', () => {
    const repo = createClipProjectsRepo(db);
    expect(repo.nextName(1, '资料甲')).toBe('《资料甲》 的剪辑');           // 空资料 → 不带序号(即 1)
    repo.create(1, repo.nextName(1, '资料甲'));                            // 「《资料甲》 的剪辑」
    expect(repo.nextName(1, '资料甲')).toBe('《资料甲》 的剪辑 2');         // 现存 {1} → 2
    const w2 = repo.create(1, repo.nextName(1, '资料甲'));                 // 「《资料甲》 的剪辑 2」
    expect(repo.delete(w2.id)).toBe(1);                                   // 删掉最大号 2
    // 现存最大号是 1 → 2;被删掉的 2 会被重新发出去 —— 这就是 D23 的「序号回收」(有意接受)
    expect(repo.nextName(1, '资料甲')).toBe('《资料甲》 的剪辑 2');
  });

  it('nextName 删中间号时,仍有更大的号占着 → 取现存最大号+1', () => {
    const repo = createClipProjectsRepo(db);
    repo.create(1, repo.nextName(1, '资料甲'));                            // 「《资料甲》 的剪辑」
    const w2 = repo.create(1, repo.nextName(1, '资料甲'));                 // 「《资料甲》 的剪辑 2」
    repo.create(1, repo.nextName(1, '资料甲'));                            // 「《资料甲》 的剪辑 3」
    repo.delete(w2.id);                                                   // 删掉中间号 2
    // 现存 {1,3},最大号 3 仍占着 → 4;此时 2 收不回来,因为它不是最大号(与上一条互补)
    expect(repo.nextName(1, '资料甲')).toBe('《资料甲》 的剪辑 4');
  });

  it('nextName 只认本资料 + 只认「标题前缀 + 纯数字尾段」的名字(自定义名不干扰)', () => {
    const repo = createClipProjectsRepo(db);
    const other = createImportsRepo(db).upsertByUrl({ url: 'https://a/nn-other', title: '资料甲', site: 'other', kind: 'single', duration_sec: null, entries: null });
    repo.create(other, '《资料甲》 的剪辑 9'); // 同名标题的别的资料 → 不参与本次序号
    repo.create(1, '我自己起的名字');          // 自定义名 → 不参与序号
    expect(repo.nextName(1, '资料甲')).toBe('《资料甲》 的剪辑');
  });

  it('nextName 源标题含正则元字符也安全(不做正则拼接)', () => {
    const repo = createClipProjectsRepo(db);
    const weird = '《标题》.的剪辑 *+?^$()[]';
    expect(repo.nextName(1, weird)).toBe(`《${weird}》 的剪辑`);
    repo.create(1, repo.nextName(1, weird));
    expect(repo.nextName(1, weird)).toBe(`《${weird}》 的剪辑 2`);
  });

  it('countByImportId / countSegmentsByImportId:无作品 → 0;有作品无段 → 0;多作品段数求和', () => {
    const repo = createClipProjectsRepo(db);
    expect(repo.countByImportId(importId)).toBe(0);        // 无作品
    expect(repo.countSegmentsByImportId(importId)).toBe(0);
    const a = repo.create(importId, '甲');
    expect(repo.countByImportId(importId)).toBe(1);
    expect(repo.countSegmentsByImportId(importId)).toBe(0); // 有作品无段
    const b = repo.create(importId, '乙');
    repo.update(a.id, '甲', [{ start_sec: 0, end_sec: 1 }, { start_sec: 1, end_sec: 2 }]);
    repo.update(b.id, '乙', [{ start_sec: 0, end_sec: 1 }]);
    expect(repo.countByImportId(importId)).toBe(2);
    expect(repo.countSegmentsByImportId(importId)).toBe(3);
  });

  it('clear/count 只作用于本资料:别的资料的段与作品不受影响', () => {
    const otherImport = createImportsRepo(db).upsertByUrl({ url: 'https://a/other', title: '别的来源', site: 'other', kind: 'single', duration_sec: null, entries: null });
    const repo = createClipProjectsRepo(db);
    const a = repo.create(importId, '甲');
    repo.update(a.id, '甲', [{ start_sec: 0, end_sec: 10 }]);
    const b = repo.create(otherImport, '乙');
    repo.update(b.id, '乙', [{ start_sec: 0, end_sec: 99 }]);
    expect(repo.clearSegmentsByImportId(importId)).toEqual({ works: 1, segments: 1 });
    expect(repo.countSegmentsByImportId(otherImport)).toBe(1); // 别家的段还在
    expect(repo.countByImportId(otherImport)).toBe(1);         // 别家的作品行还在
  });
});

// —— 作品 CRUD:create/get/update/delete/list——全量替换走 D18 事务、updated_at 走 D13 显式写 ——
describe('clip_projects repo · CRUD', () => {
  it('create 返回空段详情;段按 sort_order=0..n-1 落库,label 缺省 null', () => {
    const repo = createClipProjectsRepo(db);
    const created = repo.create(importId, '我的作品');
    expect(created).toMatchObject({ import_id: importId, name: '我的作品' });
    expect(created.segments).toEqual([]); // 新建作品还没段

    const saved = repo.update(created.id, '我的作品', [
      { start_sec: 0, end_sec: 10, label: '开场' },
      { start_sec: 30, end_sec: 45 },
    ]);
    expect(saved.segments.map((s) => s.sort_order)).toEqual([0, 1]);
    expect(saved.segments.map((s) => s.start_sec)).toEqual([0, 30]);
    expect(saved.segments[0]!.label).toBe('开场');
    expect(saved.segments[1]!.label).toBeNull(); // 不传 label → null(不是缺字段)
    const got = repo.get(created.id)!;
    expect(got.segments.map((s) => s.end_sec)).toEqual([10, 45]);
  });

  it('create name=null 照写 null;get 无此 id → null', () => {
    const repo = createClipProjectsRepo(db);
    const w = repo.create(importId, null);
    expect(w.name).toBeNull();
    expect(repo.get(w.id)!.name).toBeNull();
    expect(repo.get(99999)).toBeNull();
  });

  it('update 二次 = 全量替换:旧段消失、新段在、段数正确', () => {
    const repo = createClipProjectsRepo(db);
    const w = repo.create(importId, 'n');
    repo.update(w.id, 'n', [{ start_sec: 0, end_sec: 1 }, { start_sec: 1, end_sec: 2 }, { start_sec: 2, end_sec: 3 }]);
    const after = repo.update(w.id, 'n', [{ start_sec: 100, end_sec: 200 }]);
    expect(after.segments).toHaveLength(1);
    expect(after.segments[0]!.start_sec).toBe(100);
    expect(repo.countSegmentsByImportId(importId)).toBe(1);
    // 段表里只剩 1 行(旧 3 行真被删,不是标记)
    const left = db.prepare('SELECT COUNT(*) AS n FROM clip_segments').get() as { n: number };
    expect(Number(left.n)).toBe(1);
  });

  it('D13:updated_at 由代码显式写——UPDATE 分支不靠列默认值(默认值只对 INSERT 生效)', () => {
    const repo = createClipProjectsRepo(db);
    const w = repo.create(importId, 'n');
    repo.update(w.id, 'n', [{ start_sec: 0, end_sec: 5 }]);
    // 手工把时间戳改到 2000 年,再 update;若 UPDATE 没写 updated_at,就还是 2000(不能靠连比两次 datetime('now')——秒级精度会相等导致 flake)
    db.prepare("UPDATE clip_projects SET updated_at='2000-01-01 00:00:00' WHERE id=?").run(w.id);
    repo.update(w.id, 'n', [{ start_sec: 0, end_sec: 5 }]);
    expect(repo.get(w.id)!.updated_at).not.toBe('2000-01-01 00:00:00');
  });

  it('D18:写新段中途失败 → 整体回滚,旧段一条不少', () => {
    const repo = createClipProjectsRepo(db);
    const w = repo.create(importId, 'n');
    repo.update(w.id, 'n', [{ start_sec: 0, end_sec: 10 }, { start_sec: 20, end_sec: 30 }]);
    // 第 2 段的 label 给「不可绑定值」({} 不是 node:sqlite 接受的类型)→ 写段抛 TypeError,
    // 此时旧段已被 DELETE,若没事务这 2 段就永久没了
    expect(() =>
      repo.update(w.id, 'n', [{ start_sec: 0, end_sec: 5 }, { start_sec: 0, end_sec: 10, label: {} as never }]),
    ).toThrow();
    const after = repo.get(w.id)!;
    expect(after.segments.map((s) => s.start_sec)).toEqual([0, 20]); // 旧段完好
    expect(after.segments.map((s) => s.end_sec)).toEqual([10, 30]);
  });

  it('delete:删作品与段,返回 1;再删返回 0(幂等);get 变 null;不碰成品', () => {
    const repo = createClipProjectsRepo(db);
    const w = repo.create(importId, 'n');
    repo.update(w.id, 'n', [{ start_sec: 0, end_sec: 5 }]);
    insertProduct(w.id, '成品', 'C:/t/keep.mp3');
    expect(repo.countSegmentsByImportId(importId)).toBe(1);
    expect(repo.delete(w.id)).toBe(1);
    expect(repo.get(w.id)).toBeNull();
    expect(repo.countSegmentsByImportId(importId)).toBe(0);
    expect(productCount()).toBe(1); // 成品由路由层连带删,repo 不碰(D6)
    expect(repo.delete(w.id)).toBe(0); // 不存在 → 0,不抛
  });

  it('list:按 updated_at 新→旧;latest_product_id 取自己最新的成品', () => {
    const other = createImportsRepo(db).upsertByUrl({ url: 'https://a/list-other', title: '别的来源', site: 'other', kind: 'single', duration_sec: null, entries: null });
    const repo = createClipProjectsRepo(db);
    const wa = repo.create(importId, '甲');
    repo.update(wa.id, '甲', [{ start_sec: 0, end_sec: 5 }, { start_sec: 5, end_sec: 9 }]);
    const wb = repo.create(other, '乙');
    repo.update(wb.id, '乙', [{ start_sec: 0, end_sec: 5 }]);
    insertProduct(wa.id, 'p1', 'C:/t/lp1.mp3');
    const p2 = insertProduct(wa.id, 'p2', 'C:/t/lp2.mp3'); // 同秒创建,靠 id DESC 取到较新那条
    db.prepare("UPDATE clip_projects SET updated_at='2000-01-01 00:00:00' WHERE id=?").run(wa.id); // 甲变「很旧」
    const rows = repo.list();
    expect(rows.map((r) => r.id)).toEqual([wb.id, wa.id]); // 乙(now)在前
    expect(rows[0]).toMatchObject({ id: wb.id, name: '乙', segment_count: 1, product_count: 0, latest_product_id: null });
    expect(rows[1]).toMatchObject({ id: wa.id, name: '甲', segment_count: 2, product_count: 2, latest_product_id: p2 });
  });
});
