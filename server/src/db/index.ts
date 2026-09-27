import { DatabaseSync } from 'node:sqlite';

export type DB = DatabaseSync;

/** D9(C1):唯一驱动入口,node:sqlite 内置零原生模块。同步 API,两运行时行为一致 */
export function openDatabase(dbPath: string): DB {
  return new DatabaseSync(dbPath);
}
