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
  // 2026-09-29 用户拍板:剪辑室要显示「第几集 / 所属合集」→ audio_items 增两列
  it('entry_index/collection_title 落库并回读;不传 → null', () => {
    const repo = createAudioItemsRepo(db);
    const ep = repo.create({ title: '第 3 集', source_type: 'download', source_url: 'https://a/pl', file_path: 'C:/tmp/3.mp3', format: 'mp3', duration_sec: null, file_size: 1, entry_index: 3, collection_title: '某合集' });
    expect(repo.get(ep)!.entry_index).toBe(3);
    expect(repo.get(ep)!.collection_title).toBe('某合集');
    const single = repo.create({ title: '单视频', source_type: 'download', source_url: 'https://a/s', file_path: 'C:/tmp/s.mp3', format: 'mp3', duration_sec: null, file_size: 1 });
    expect(repo.get(single)!.entry_index).toBeNull();
    expect(repo.get(single)!.collection_title).toBeNull();
  });
  it('老库(无剧集两列)initSchema 自动补列,repo 随即可用(升级路径)', () => {
    const old = openDatabase(':memory:');
    // 故意按改动前的旧结构建表:CREATE TABLE IF NOT EXISTS 不会补列,只能靠 initSchema 的 ALTER TABLE
    old.exec(
      'CREATE TABLE audio_items (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, source_type TEXT NOT NULL, ' +
      'source_url TEXT, parent_id INTEGER, file_path TEXT NOT NULL UNIQUE, format TEXT NOT NULL, duration_sec REAL, ' +
      'file_size INTEGER, created_at TEXT NOT NULL DEFAULT (datetime(\'now\')))',
    );
    initSchema(old);
    const repo = createAudioItemsRepo(old);
    const id = repo.create({ title: '第 2 集', source_type: 'download', source_url: 'https://a/pl', file_path: 'C:/tmp/2.mp3', format: 'mp3', duration_sec: null, file_size: 1, entry_index: 2, collection_title: '旧库合集' });
    expect(repo.get(id)!.entry_index).toBe(2);
    expect(repo.get(id)!.collection_title).toBe('旧库合集');
    old.close();
  });
  // 2026-10-01 spec audio-lineage D1：剪辑血缘列落库/回读，不传即 null
  it('source_import_id 落库并回读;不传 → null', () => {
    const repo = createAudioItemsRepo(db);
    const a = repo.create({ title: '带血缘', source_type: 'edit', source_url: '', source_import_id: 12, file_path: 'C:/tmp/blood.mp3', format: 'mp3', duration_sec: null, file_size: 1 });
    expect(repo.get(a)!.source_import_id).toBe(12);
    expect(repo.list()[0]!.source_import_id).toBe(12);
    const b = repo.create({ title: '无血缘', source_type: 'recording', source_url: null, file_path: 'C:/tmp/nb.wav', format: 'wav', duration_sec: null, file_size: 1 });
    expect(repo.get(b)!.source_import_id).toBeNull();
  });
  // 2026-10-01 spec clip-works D4：成品挂作品 —— source_work_id 落库/回读，不传即 null
  it('source_work_id 落库并回读;不传 → null', () => {
    const repo = createAudioItemsRepo(db);
    const a = repo.create({ title: '成品', source_type: 'edit', source_url: '', source_work_id: 5, file_path: 'C:/tmp/w.mp3', format: 'mp3', duration_sec: null, file_size: 1 });
    expect(repo.get(a)!.source_work_id).toBe(5);
    expect(repo.list()[0]!.source_work_id).toBe(5);
    const b = repo.create({ title: '无作品', source_type: 'download', source_url: 'u', file_path: 'C:/tmp/nw.mp3', format: 'mp3', duration_sec: null, file_size: 1 });
    expect(repo.get(b)!.source_work_id).toBeNull();
  });
});
