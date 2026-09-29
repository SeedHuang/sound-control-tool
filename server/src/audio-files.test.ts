// server/src/audio-files.test.ts
// 2026-09-29 新增:DELETE /api/audio/:id 的工具函数单元测试
// 三个用例覆盖核心契约:成功删、文件缺失不抛、行不存在不抛
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type DB } from './db/index.js';
import { initSchema } from './db/schema.js';
import { createAudioItemsRepo } from './db/repo/audio-items.js';
import { deleteAudioFile } from './audio-files.js';

let db: DB;
let tempDir: string;
beforeEach(() => {
  db = openDatabase(':memory:');
  initSchema(db);
  tempDir = mkdtempSync(join(tmpdir(), 'sct-audio-del-'));
});
afterEach(() => {
  db.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('deleteAudioFile', () => {
  it('成功:删磁盘文件 + 返回 deleted=true + 路径可回读', () => {
    const repo = createAudioItemsRepo(db);
    const filePath = join(tempDir, 'x.mp3');
    writeFileSync(filePath, 'fake-mp3');
    const id = repo.create({ title: 't', source_type: 'download', source_url: 'u', file_path: filePath, format: 'mp3', duration_sec: null, file_size: 1 });
    const r = deleteAudioFile(id, repo);
    expect(r.deleted).toBe(true);
    expect(r.path).toBe(filePath);
    // DB 行仍在(本函数只删文件,DB 删除由路由层做)——验证职责单一
    expect(repo.get(id)).not.toBeNull();
  });

  it('文件缺失:不抛错 + 返回 deleted=false + 路径仍报回', () => {
    const repo = createAudioItemsRepo(db);
    const filePath = join(tempDir, 'nope.mp3'); // 不写
    const id = repo.create({ title: 't', source_type: 'download', source_url: 'u', file_path: filePath, format: 'mp3', duration_sec: null, file_size: 1 });
    const r = deleteAudioFile(id, repo);
    expect(r.deleted).toBe(false);
    expect(r.path).toBe(filePath);
    expect(repo.get(id)).not.toBeNull();
  });

  it('行不存在:id 不存在 → 返回 deleted=false + path=null(给路由层判 404 用)', () => {
    const repo = createAudioItemsRepo(db);
    const r = deleteAudioFile(999, repo);
    expect(r.deleted).toBe(false);
    expect(r.path).toBeNull();
  });
});