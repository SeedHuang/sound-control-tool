import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type DB } from '../index.js';
import { initSchema } from '../schema.js';
import { createAudioItemsRepo, type AudioItemRow } from './audio-items.js';

let db: DB;
beforeEach(() => {
  db = openDatabase(':memory:');
  initSchema(db);
});
afterEach(() => { db.close(); });

describe('audio-items repo', () => {
  it('create 返回 lastInsertRowid 且可 list 回读', () => {
    const repo = createAudioItemsRepo(db);
    const id = repo.create({ title: '课 01', source_type: 'download', source_url: 'https://a/1', file_path: 'C:/tmp/x.mp3', format: 'mp3', duration_sec: 61.5, file_size: 1024 });
    const rows = repo.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(id);
    expect(rows[0]!.title).toBe('课 01');
  });
  it('findBySourceUrl 只匹配 download 且同 URL', () => {
    const repo = createAudioItemsRepo(db);
    repo.create({ title: 'r', source_type: 'recording', source_url: 'https://a/1', file_path: 'C:/tmp/r.wav', format: 'wav', duration_sec: null, file_size: 1 });
    expect(repo.findBySourceUrl('https://a/1')).toBeNull();
    repo.create({ title: 'd', source_type: 'download', source_url: 'https://a/1', file_path: 'C:/tmp/d.mp3', format: 'mp3', duration_sec: null, file_size: 1 });
    expect(repo.findBySourceUrl('https://a/1')?.title).toBe('d');
  });
  it('updateFilePath 生效且 get 回读', () => {
    const repo = createAudioItemsRepo(db);
    const id = repo.create({ title: 't', source_type: 'download', source_url: 'u', file_path: 'C:/tmp/t.mp3', format: 'mp3', duration_sec: null, file_size: 1 });
    repo.updateFilePath(id, 'C:/audio/t-1a2b3c4d.mp3');
    expect(repo.get(id)?.file_path).toBe('C:/audio/t-1a2b3c4d.mp3');
    expect(repo.get(999)).toBeNull();
  });
  it('delete 移除行(P1-2 回滚)', () => {
    const repo = createAudioItemsRepo(db);
    const id = repo.create({ title: 't', source_type: 'download', source_url: 'u', file_path: 'C:/tmp/t.mp3', format: 'mp3', duration_sec: null, file_size: 1 });
    repo.delete(id);
    expect(repo.get(id)).toBeNull();
    expect(repo.list()).toHaveLength(0);
  });
});
