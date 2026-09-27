import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { openDatabase, type DB } from './db/index.js';
import { initSchema } from './db/schema.js';
import { createJobsRepo } from './db/repo/jobs.js';

/** 删除 tempDir 中 keep 之外的条目(S1 keep 恒为空集;S2 起由活跃任务 payload.tempFiles 提供) */
export function cleanOrphans(tempDir: string, keep: Set<string>): void {
  for (const entry of readdirSync(tempDir)) {
    const full = path.join(tempDir, entry);
    if (!keep.has(full) && !keep.has(entry)) rmSync(full, { recursive: true, force: true });
  }
}

function listActiveTempFiles(db: DB): Set<string> {
  const keep = new Set<string>();
  const rows = db
    .prepare("SELECT payload FROM jobs WHERE status IN ('pending','running')")
    .all() as Array<{ payload: string }>;
  for (const r of rows) {
    try {
      const p = JSON.parse(r.payload) as { tempFiles?: string[] };
      for (const f of p.tempFiles ?? []) keep.add(f);
    } catch {
      /* 坏 payload 不阻塞启动 */
    }
  }
  return keep;
}

/** spec 0.3:mkdir → 五表 → 启动恢复 → 孤儿清理。dev 由 dev.ts 调,生产由 electron main 调 */
export async function bootstrap(opts: { dbPath: string; tempDir: string }): Promise<void> {
  mkdirSync(path.dirname(opts.dbPath), { recursive: true });
  mkdirSync(opts.tempDir, { recursive: true });
  const db = openDatabase(opts.dbPath);
  try {
    initSchema(db);
    // 必须在 markAllInterrupted 之前取活跃临时文件:该调用会把 pending/running 全部改为 error,
    // 之后再查 status IN ('pending','running') 恒为空集(S2 起 payload.tempFiles 会被 S1 的空集顺序误删)
    const keep = listActiveTempFiles(db);
    createJobsRepo(db).markAllInterrupted('应用中断,可重试');
    cleanOrphans(opts.tempDir, keep);
  } finally {
    db.close();
  }
}
