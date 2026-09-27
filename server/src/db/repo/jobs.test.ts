import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type DB } from '../index.js';
import { initSchema } from '../schema.js';
import { createJobsRepo } from './jobs.js';

describe('jobs repo', () => {
  let db: DB;
  beforeEach(() => {
    db = openDatabase(':memory:');
    initSchema(db);
  });
  afterEach(() => {
    db.close();
  });

  it('markAllInterrupted 把 pending/running 置为 error 并返回行数', () => {
    const repo = createJobsRepo(db);
    const a = repo.create('ytdlp_download', { url: 'x' });
    const b = repo.create('ffmpeg_edit', { spec: {} });
    db.prepare("UPDATE jobs SET status='running' WHERE id=?").run(a);
    db.prepare("UPDATE jobs SET status='done' WHERE id=?").run(b); // done 不应被动

    const n = repo.markAllInterrupted('应用中断,可重试');
    expect(n).toBe(1);
    expect(repo.get(a)?.status).toBe('error');
    expect(repo.get(a)?.message).toBe('应用中断,可重试');
    expect(repo.get(b)?.status).toBe('done');
  });
});
