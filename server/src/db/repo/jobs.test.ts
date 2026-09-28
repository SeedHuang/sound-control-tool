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

  it('update/finish/fail 联动状态与 finished_at', () => {
    const repo = createJobsRepo(db);
    const id = repo.create('ytdlp_download', { url: 'u' });
    repo.update(id, { status: 'running', progress: 10 });
    let j = repo.get(id)!;
    expect(j.status).toBe('running'); expect(j.progress).toBe(10); expect(j.finished_at).toBeNull();
    repo.finish(id);
    j = repo.get(id)!;
    expect(j.status).toBe('done'); expect(j.progress).toBe(100); expect(j.finished_at).not.toBeNull();
  });

  it('fail 置 error + message', () => {
    const repo = createJobsRepo(db);
    const id = repo.create('ytdlp_download', { url: 'u' });
    repo.fail(id, '网络失败');
    const j = repo.get(id)!;
    expect(j.status).toBe('error'); expect(j.message).toBe('网络失败');
  });

  it('findActiveByUrl 命中 running/pending 的同 URL job,finished 不命中', () => {
    const repo = createJobsRepo(db);
    const id = repo.create('ytdlp_download', { url: 'https://a/1' });
    repo.update(id, { status: 'running' });
    expect(repo.findActiveByUrl('https://a/1')?.id).toBe(id);
    // 不同 URL 不命中
    expect(repo.findActiveByUrl('https://b/2')).toBeNull();
    // URL 前缀相同不误配("https://a/1x" 不应命中 "https://a/1")
    repo.create('ytdlp_download', { url: 'https://a/1x' });
    expect(repo.findActiveByUrl('https://a/1')?.id).toBe(id);
    // 含 LIKE 通配符的 URL(%20/下划线)不被误配
    repo.create('ytdlp_download', { url: 'https://a/under_score%20x' });
    expect(repo.findActiveByUrl('https://a/1')?.id).toBe(id);
    expect(repo.findActiveByUrl('https://a/under_score%20x')?.id).not.toBeUndefined();
    // finish 后不再命中
    repo.finish(id);
    expect(repo.findActiveByUrl('https://a/1')).toBeNull();
  });
});
