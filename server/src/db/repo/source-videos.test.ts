// server/src/db/repo/source-videos.test.ts
import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type DB } from '../index.js';
import { initSchema } from '../schema.js';
import { createImportsRepo } from './imports.js';
import { createSourceVideosRepo } from './source-videos.js';

let db: DB;
let importId: number;
beforeEach(() => {
  db = openDatabase(':memory:');
  initSchema(db);
  importId = createImportsRepo(db).upsertByUrl({
    url: 'https://a/pl', title: '凡人修仙传', site: 'bilibili', kind: 'playlist', duration_sec: null, entries: null,
  });
});

describe('source_videos repo', () => {
  it('upsert 后能读回;同一来源再 upsert 是覆盖(不新增行)', () => {
    const repo = createSourceVideosRepo(db);
    repo.upsert({ importId, filePath: 'C:/m/media-1.webm', height: 480, fileSize: 100 });
    expect(repo.get(importId)?.file_path).toBe('C:/m/media-1.webm');
    repo.upsert({ importId, filePath: 'C:/m/media-1.mp4', height: 720, fileSize: 200 });
    expect(repo.get(importId)?.file_path).toBe('C:/m/media-1.mp4');
    expect(repo.get(importId)?.height).toBe(720);
    expect(repo.list()).toHaveLength(1);
  });
  it('list 带出来源的 url/title/site(前端素材列表要显示)', () => {
    createSourceVideosRepo(db).upsert({ importId, filePath: 'C:/m/media-1.mp4', height: 480, fileSize: 1 });
    expect(createSourceVideosRepo(db).list()[0]).toMatchObject({ url: 'https://a/pl', title: '凡人修仙传', site: 'bilibili' });
  });
  it('delete 删行;不存在返回 false', () => {
    const repo = createSourceVideosRepo(db);
    repo.upsert({ importId, filePath: 'C:/m/media-1.mp4', height: 480, fileSize: 1 });
    expect(repo.delete(importId)).toBe(true);
    expect(repo.get(importId)).toBeNull();
    expect(repo.delete(importId)).toBe(false);
  });
});
