// server/src/db/tx.ts
// 事务 helper（D18）：全量替换型写操作必须原子——删旧段 + 写新段 + 更新 updated_at 同进同出，
// 任一失败整体回滚、旧数据一条不少。node:sqlite 是同步 API，回调即写完，
// 故用「同步函数 + try/catch」而非 Promise 包装。本库无嵌套事务需求，不缺嵌套检测。
import type { DB } from './index.js';

export function inTransaction<T>(db: DB, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* 回滚失败：保留原异常，别把真因吞掉 */
    }
    throw e;
  }
}
