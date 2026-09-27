import type { DB } from '../index.js';

export interface JobRow {
  id: number;
  kind: string;
  payload: string;
  status: string;
  progress: number;
  message: string | null;
}

export interface JobsRepo {
  markAllInterrupted(message: string): number;
  create(kind: string, payload: unknown): number;
  get(id: number): JobRow | null;
}

export function createJobsRepo(db: DB): JobsRepo {
  return {
    markAllInterrupted: (message) =>
      Number(
        db
          .prepare(
            "UPDATE jobs SET status='error', message=?, finished_at=datetime('now') WHERE status IN ('pending','running')",
          )
          .run(message).changes,
      ),
    create: (kind, payload) => {
      // JSON.stringify(undefined/函数/symbol) 返回字面量 undefined(非字符串),直接绑定会抛晦涩 TypeError
      const json = JSON.stringify(payload);
      if (json === undefined) throw new TypeError('jobs.create: payload 不可序列化(undefined/函数/symbol)');
      return Number(db.prepare('INSERT INTO jobs (kind, payload) VALUES (?, ?)').run(kind, json).lastInsertRowid);
    },
    get: (id) =>
      (db.prepare('SELECT id, kind, payload, status, progress, message FROM jobs WHERE id = ?').get(id) as
        | JobRow
        | undefined) ?? null,
  };
}
