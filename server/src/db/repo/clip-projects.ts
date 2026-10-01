// server/src/db/repo/clip-projects.ts
// 剪辑工程(2026-09-30,spec D7 提前落地):与 imported_sources 一对一(import_id UNIQUE)。
// P2 落"换集清工程"(spec D19)的两个方法;P4 补齐 CRUD(list/get/upsert/delete,剪辑室 UI 用)。
import type { DB } from '../index.js';
import { inTransaction } from '../tx.js';

export interface ClipSegmentRow { id: number; start_sec: number; end_sec: number; label: string | null; sort_order: number }
export interface ClipProjectSummary { import_id: number; name: string | null; updated_at: string; segment_count: number }
export interface ClipProjectDetail { import_id: number; name: string | null; updated_at: string; segments: ClipSegmentRow[] }
export interface SegmentInput { start_sec: number; end_sec: number; label?: string | null }

export function createClipProjectsRepo(db: DB) {
  /** 清空某来源的剪辑工程:先删该工程的段、再删工程行,返回删除的**段数**。
   *  两条 DELETE 包在一个事务里(T7-2):不允许"段删了、工程行没删"这种半截状态(否则会留下空壳工程)。
   *  失败策略:工程不存在(没建过/已清过)→ 删 0 行,返回 0,不抛(幂等——换集判定重复触发安全) */
  const clearByImportId = (importId: number): number =>
    inTransaction(db, () => {
      const segDeleted = db.prepare(
        'DELETE FROM clip_segments WHERE project_id IN (SELECT id FROM clip_projects WHERE import_id = ?)',
      ).run(importId).changes;
      db.prepare('DELETE FROM clip_projects WHERE import_id = ?').run(importId);
      return Number(segDeleted);
    });
  /** 该来源工程的段数;无工程(或工程存在但没段)→ 0 */
  const countSegmentsByImportId = (importId: number): number => {
    const r = db.prepare(
      'SELECT COUNT(*) AS n FROM clip_segments seg JOIN clip_projects p ON p.id = seg.project_id WHERE p.import_id = ?',
    ).get(importId) as { n: number } | undefined;
    return Number(r?.n ?? 0);
  };

  /** 工程列表(首页/剪辑室用):updated_at 新→旧;segment_count 是子查询算出的段数 */
  const list = (): ClipProjectSummary[] =>
    (db.prepare(
      'SELECT p.import_id, p.name, p.updated_at, ' +
      '(SELECT COUNT(*) FROM clip_segments seg WHERE seg.project_id = p.id) AS segment_count ' +
      'FROM clip_projects p ORDER BY p.updated_at DESC, p.import_id DESC',
    ).all() as Array<Record<string, unknown>>).map((r) => ({
      import_id: Number(r.import_id),
      name: r.name === null || r.name === undefined ? null : String(r.name),
      updated_at: String(r.updated_at),
      segment_count: Number(r.segment_count ?? 0),
    }));

  /** 工程详情(含段,按 sort_order);无工程 → null(这是正常态,不是错误——前端据此显示"尚未创建工程") */
  const get = (importId: number): ClipProjectDetail | null => {
    const p = db.prepare('SELECT id, import_id, name, updated_at FROM clip_projects WHERE import_id = ?').get(importId) as Record<string, unknown> | undefined;
    if (!p) return null;
    const segments = (db.prepare(
      'SELECT id, start_sec, end_sec, label, sort_order FROM clip_segments WHERE project_id = ? ORDER BY sort_order ASC, id ASC',
    ).all(Number(p.id)) as Array<Record<string, unknown>>).map((s) => ({
      id: Number(s.id), start_sec: Number(s.start_sec), end_sec: Number(s.end_sec),
      label: s.label === null || s.label === undefined ? null : String(s.label),
      sort_order: Number(s.sort_order),
    }));
    return { import_id: Number(p.import_id), name: p.name === null || p.name === undefined ? null : String(p.name), updated_at: String(p.updated_at), segments };
  };

  /** 全量替换(D18:整段换包在一个事务里——删旧段 + 写新段 + 更新 updated_at 同进同出,
   *  任一失败整体回滚、旧段一条不少)。
   *  updated_at 由代码显式写(D13:SQLite 列默认值只对 INSERT 生效,UPDATE 不会自动刷新)。 */
  const upsert = (importId: number, name: string | null, segments: SegmentInput[]): ClipProjectDetail =>
    inTransaction(db, () => {
      db.prepare(
        "INSERT INTO clip_projects (import_id, name, updated_at) VALUES (?, ?, datetime('now')) " +
        "ON CONFLICT(import_id) DO UPDATE SET name=excluded.name, updated_at=datetime('now')",
      ).run(importId, name);
      const pid = Number((db.prepare('SELECT id FROM clip_projects WHERE import_id = ?').get(importId) as { id: number }).id);
      db.prepare('DELETE FROM clip_segments WHERE project_id = ?').run(pid); // 先删后插 = 全量替换
      const ins = db.prepare('INSERT INTO clip_segments (project_id, start_sec, end_sec, label, sort_order) VALUES (?, ?, ?, ?, ?)');
      segments.forEach((s, i) => ins.run(pid, s.start_sec, s.end_sec, s.label ?? null, i));
      const detail = get(importId); // 同连接事务内可读到未提交的新段
      if (detail === null) throw new Error('clip_projects upsert 后查不到工程');
      return detail;
    });

  /** 删工程与其段(D18 事务),返回删除的工程行数(0/1)。幂等:不存在 → 0,不抛。
   *  只删本表两处数据——素材(source_videos)与已导出音频(audio_items)不动,由调用方各自负责 */
  const del = (importId: number): number =>
    inTransaction(db, () => {
      db.prepare('DELETE FROM clip_segments WHERE project_id IN (SELECT id FROM clip_projects WHERE import_id = ?)').run(importId);
      return Number(db.prepare('DELETE FROM clip_projects WHERE import_id = ?').run(importId).changes);
    });

  return { clearByImportId, countSegmentsByImportId, list, get, upsert, delete: del };
}
