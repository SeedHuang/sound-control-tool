// server/src/db/repo/clip-projects.ts
// 剪辑工程(2026-09-30,spec D7 提前落地):与 imported_sources 一对一(import_id UNIQUE)。
// P2 只落"换集清工程"(spec D19)需要的两个方法;增删改查 CRUD 在 P4 扩(剪辑室 UI 落地时)。
import type { DB } from '../index.js';

export function createClipProjectsRepo(db: DB) {
  /** 清空某来源的剪辑工程:先删该工程的段、再删工程行,返回删除的**段数**。
   *  失败策略:工程不存在(没建过/已清过)→ 删 0 行,返回 0,不抛(幂等——换集判定重复触发安全) */
  const clearByImportId = (importId: number): number => {
    const segDeleted = db.prepare(
      'DELETE FROM clip_segments WHERE project_id IN (SELECT id FROM clip_projects WHERE import_id = ?)',
    ).run(importId).changes;
    db.prepare('DELETE FROM clip_projects WHERE import_id = ?').run(importId);
    return Number(segDeleted);
  };
  /** 该来源工程的段数;无工程(或工程存在但没段)→ 0 */
  const countSegmentsByImportId = (importId: number): number => {
    const r = db.prepare(
      'SELECT COUNT(*) AS n FROM clip_segments seg JOIN clip_projects p ON p.id = seg.project_id WHERE p.import_id = ?',
    ).get(importId) as { n: number } | undefined;
    return Number(r?.n ?? 0);
  };
  return { clearByImportId, countSegmentsByImportId };
}
