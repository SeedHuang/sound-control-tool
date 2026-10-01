// server/src/db/repo/clip-projects.ts
// 剪辑**作品**仓库(2026-10-01 spec clip-works D1/D2):clip_projects 一行 = 一件作品(名字 + 剪辑段 + 成品)。
// 关键语义变化:import_id **不再唯一** —— 同一个资料可以有多件作品(1:N),老库的 UNIQUE 由 schema 迁移去掉。
// 成品的归属走 audio_items.source_work_id(指向本表 id);成品本身**不归本 repo 管**,由路由层连带处理(D6)。
import type { DB } from '../index.js';
import { inTransaction } from '../tx.js';
import { createImportsRepo } from './imports.js';

export interface ClipSegmentRow { id: number; start_sec: number; end_sec: number; label: string | null; sort_order: number }
/** 列表项 = 作品墙的一张卡的数据来源 */
export interface WorkSummaryRow {
  id: number; import_id: number; name: string | null; updated_at: string;
  segment_count: number; product_count: number; total_sec: number;
  first_segment: { start_sec: number; end_sec: number } | null;
  /** 最新一条成品的 id(hover 预览"只有音频的卡"要播它);没有成品 → null */
  latest_product_id: number | null;
  source: { title: string; site: string; kind: string; has_video: boolean } | null; // null = 资料已删
}
export interface WorkDetailRow { id: number; import_id: number; name: string | null; updated_at: string; segments: ClipSegmentRow[] }
export interface SegmentInput { start_sec: number; end_sec: number; label?: string | null }

export function createClipProjectsRepo(db: DB) {
  const importsRepo = createImportsRepo(db);

  /** 作品详情(含段,按 sort_order);无此 id → null(正常态,不是错误) */
  const get = (projectId: number): WorkDetailRow | null => {
    const p = db.prepare('SELECT id, import_id, name, updated_at FROM clip_projects WHERE id = ?').get(projectId) as Record<string, unknown> | undefined;
    if (!p) return null;
    const segments = (db.prepare(
      'SELECT id, start_sec, end_sec, label, sort_order FROM clip_segments WHERE project_id = ? ORDER BY sort_order ASC, id ASC',
    ).all(Number(p.id)) as Array<Record<string, unknown>>).map((s) => ({
      id: Number(s.id), start_sec: Number(s.start_sec), end_sec: Number(s.end_sec),
      label: s.label === null || s.label === undefined ? null : String(s.label),
      sort_order: Number(s.sort_order),
    }));
    return {
      id: Number(p.id), import_id: Number(p.import_id),
      name: p.name === null || p.name === undefined ? null : String(p.name),
      updated_at: String(p.updated_at), segments,
    };
  };

  /** 新建作品(名字由调用方算好,见 nextName);updated_at 交给列默认值(INSERT 才吃到默认值)。
   *  读回详情:同连接同语句后即可见刚插入的行。 */
  const create = (importId: number, name: string | null): WorkDetailRow => {
    const id = Number(db.prepare('INSERT INTO clip_projects (import_id, name) VALUES (?, ?)').run(importId, name).lastInsertRowid);
    const detail = get(id);
    if (detail === null) throw new Error('clip_projects create 后查不到作品');
    return detail;
  };

  /** 全量替换作品(D18:改名 + 删旧段 + 写新段同进同出,任一失败整体回滚、旧段一条不少)。
   *  updated_at **必须显式写**(D13:SQLite 列默认值只对 INSERT 生效,UPDATE 不会自动刷新)。 */
  const update = (projectId: number, name: string | null, segments: SegmentInput[]): WorkDetailRow =>
    inTransaction(db, () => {
      db.prepare("UPDATE clip_projects SET name = ?, updated_at = datetime('now') WHERE id = ?").run(name, projectId);
      db.prepare('DELETE FROM clip_segments WHERE project_id = ?').run(projectId); // 先删后插 = 全量替换
      const ins = db.prepare('INSERT INTO clip_segments (project_id, start_sec, end_sec, label, sort_order) VALUES (?, ?, ?, ?, ?)');
      segments.forEach((s, i) => ins.run(projectId, s.start_sec, s.end_sec, s.label ?? null, i));
      const detail = get(projectId);
      if (detail === null) throw new Error('clip_projects update 后查不到作品');
      return detail;
    });

  /** 删作品与其段(D18 事务),返回删除的**作品行数**(0/1)。幂等:不存在 → 0,不抛。
   *  只删本 repo 的两处数据 —— 成品(audio_items)不碰,由路由层连带删(D6)。 */
  const del = (projectId: number): number =>
    inTransaction(db, () => {
      db.prepare('DELETE FROM clip_segments WHERE project_id = ?').run(projectId);
      return Number(db.prepare('DELETE FROM clip_projects WHERE id = ?').run(projectId).changes);
    });

  /** 作品墙列表:一条 SQL 带出全部派生列(段数/总时长/成品数/最新成品),再逐行补首段与资料。
   *  ⚠️ 逐行补两次查询是刻意的:作品数量小(个人工具),换来 SQL 可读;**不要**为了省两次查询拼成难读的大 JOIN。 */
  const list = (): WorkSummaryRow[] => {
    const rows = db.prepare(
      'SELECT p.id, p.import_id, p.name, p.updated_at, ' +
      '(SELECT COUNT(*) FROM clip_segments s WHERE s.project_id = p.id) AS segment_count, ' +
      "(SELECT COALESCE(SUM(s.end_sec - s.start_sec), 0) FROM clip_segments s WHERE s.project_id = p.id) AS total_sec, " +
      '(SELECT COUNT(*) FROM audio_items a WHERE a.source_work_id = p.id) AS product_count, ' +
      '(SELECT a.id FROM audio_items a WHERE a.source_work_id = p.id ORDER BY a.created_at DESC, a.id DESC LIMIT 1) AS latest_product_id ' +
      'FROM clip_projects p ORDER BY p.updated_at DESC, p.id DESC',
    ).all() as Array<Record<string, unknown>>;
    const firstSeg = db.prepare(
      'SELECT start_sec, end_sec FROM clip_segments WHERE project_id = ? ORDER BY sort_order ASC, id ASC LIMIT 1',
    );
    return rows.map((r) => {
      const id = Number(r.id);
      const importId = Number(r.import_id);
      const fs = firstSeg.get(id) as { start_sec: number; end_sec: number } | undefined;
      const src = importsRepo.get(importId); // 资料已删 → null(前端据此显示"资料已删")
      return {
        id, import_id: importId,
        name: r.name === null || r.name === undefined ? null : String(r.name),
        updated_at: String(r.updated_at),
        segment_count: Number(r.segment_count ?? 0),
        product_count: Number(r.product_count ?? 0),
        total_sec: Number(r.total_sec ?? 0),
        first_segment: fs === undefined ? null : { start_sec: Number(fs.start_sec), end_sec: Number(fs.end_sec) },
        latest_product_id: r.latest_product_id === null || r.latest_product_id === undefined ? null : Number(r.latest_product_id),
        source: src === null ? null : { title: src.title, site: src.site, kind: src.kind, has_video: src.has_video },
      };
    });
  };

  /** 换集重下:清空该资料下**所有作品**的段,但保留作品行(作品是用户命名过的,不能悄悄删)。
   *  返回 { works, segments }:works = 确实有段被清掉的作品数(替换确认文案说"N 个作品"),segments = 被删的段数。
   *  先数后删(同一个事务):删完就数不到了。 */
  const clearSegmentsByImportId = (importId: number): { works: number; segments: number } =>
    inTransaction(db, () => {
      const works = Number((db.prepare(
        'SELECT COUNT(DISTINCT project_id) AS n FROM clip_segments WHERE project_id IN (SELECT id FROM clip_projects WHERE import_id = ?)',
      ).get(importId) as { n: number }).n);
      const segments = Number(db.prepare(
        'DELETE FROM clip_segments WHERE project_id IN (SELECT id FROM clip_projects WHERE import_id = ?)',
      ).run(importId).changes);
      return { works, segments };
    });

  /** 该资料的作品数(替换确认文案用) */
  const countByImportId = (importId: number): number => {
    const r = db.prepare('SELECT COUNT(*) AS n FROM clip_projects WHERE import_id = ?').get(importId) as { n: number } | undefined;
    return Number(r?.n ?? 0);
  };

  /** 该资料下全部作品的段数之和 */
  const countSegmentsByImportId = (importId: number): number => {
    const r = db.prepare(
      'SELECT COUNT(*) AS n FROM clip_segments seg JOIN clip_projects p ON p.id = seg.project_id WHERE p.import_id = ?',
    ).get(importId) as { n: number } | undefined;
    return Number(r?.n ?? 0);
  };

  /** 默认作品名(D23):`《标题》 的剪辑`,同名再来一个就 `《标题》 的剪辑 2`……
   *  序号取「已存在的最大序号 + 1」(删掉中间号也不回收,序号只增)。
   *  ⚠️ 用**字符串前缀解析**而不是 `new RegExp(源标题)` —— 标题里可能有正则元字符(`.` `*` `(` 等),
   *  直接拼进正则会把字面量当元字符,匹配全乱。 */
  const nextName = (importId: number, sourceTitle: string): string => {
    const base = `《${sourceTitle}》 的剪辑`;
    const rows = db.prepare('SELECT name FROM clip_projects WHERE import_id = ? AND name IS NOT NULL').all(importId) as Array<{ name: string }>;
    let max = 0;
    for (const { name } of rows) {
      if (name === base) { max = Math.max(max, 1); continue; }  // 不带序号的 = 第 1 个
      if (!name.startsWith(`${base} `)) continue;               // 前缀不符(用户自定义名)→ 不参与
      const tail = name.slice(base.length + 1);                 // 取前缀后的尾段
      if (!/^\d+$/.test(tail)) continue;                        // 尾段不是纯数字 → 不参与
      max = Math.max(max, Number(tail));
    }
    const n = max + 1;
    return n > 1 ? `${base} ${n}` : base;
  };

  return { create, get, update, delete: del, list, clearSegmentsByImportId, countByImportId, countSegmentsByImportId, nextName };
}
