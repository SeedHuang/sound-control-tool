import type { DB } from '../index.js';

export type JobStatus = 'pending' | 'running' | 'done' | 'error' | 'cancelled';

export interface JobRow {
  id: number;
  kind: string;
  payload: string;
  status: string;
  progress: number;
  message: string | null;
  finished_at: string | null;
}

export interface JobsRepo {
  markAllInterrupted(message: string): number;
  create(kind: string, payload: unknown): number;
  get(id: number): JobRow | null;
  update(id: number, patch: { status?: JobStatus; progress?: number; message?: string | null }): void;
  finish(id: number, progress?: number): void;
  fail(id: number, message: string): void;
  findActiveByUrl(url: string): { id: number } | null; // P1-1:防同 URL 并发下载
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
      (db
        .prepare('SELECT id, kind, payload, status, progress, message, finished_at FROM jobs WHERE id = ?')
        .get(id) as JobRow | undefined) ?? null,
    update: (id, patch) => {
      const status = patch.status ?? null;
      const finished = status === 'done' || status === 'error' || status === 'cancelled' ? `, finished_at=datetime('now')` : '';
      const cols: string[] = [];
      const vals: (string | number | null)[] = [];
      if (patch.status !== undefined) { cols.push('status=?'); vals.push(patch.status); }
      if (patch.progress !== undefined) { cols.push('progress=?'); vals.push(patch.progress); }
      if (patch.message !== undefined) { cols.push('message=?'); vals.push(patch.message); }
      if (cols.length === 0) return;
      db.prepare(`UPDATE jobs SET ${cols.join(',')}${finished} WHERE id=?`).run(...vals, id);
    },
    finish: (id, progress = 100) =>
      db.prepare("UPDATE jobs SET status='done', progress=?, finished_at=datetime('now') WHERE id=?").run(progress, id),
    fail: (id, message) =>
      db.prepare("UPDATE jobs SET status='error', message=?, finished_at=datetime('now') WHERE id=?").run(message, id),
    findActiveByUrl: (url) => {
      // payload 是 JSON 文本;LIKE 匹配 "url":"<escaped>" 子串,避免误配 URL 前缀相同者。
      // LIKE 通配符 %/_ 需转义(URL 可能含 %20、下划线),配合 ESCAPE '\'
      const needle = JSON.stringify({ url }).slice(1, -1); // "url":"<escaped>"
      const esc = needle.replace(/[\\%_]/g, (c) => `\\${c}`);
      const row = db
        .prepare("SELECT id FROM jobs WHERE kind='ytdlp_download' AND status IN ('pending','running') AND payload LIKE ? ESCAPE '\\'")
        .get(`%${esc}%`);
      return row && typeof (row as { id: unknown }).id === 'number' ? { id: (row as { id: number }).id } : null;
    },
  };
}
