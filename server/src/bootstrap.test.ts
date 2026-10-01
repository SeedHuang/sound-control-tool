import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bootstrap, cleanOrphans } from './bootstrap.js';
import { openDatabase } from './db/index.js';

const dirs: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(path.join(tmpdir(), 'sct-boot-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('bootstrap(启动恢复 + 孤儿清理)', () => {
  it('running 任务被置为 error;再次运行幂等', async () => {
    const data = tmpDir();
    const dbPath = path.join(data, 'sct.db');
    await bootstrap({ dbPath, tempDir: path.join(data, 'tmp') });
    // 模拟上次崩溃残留:手工塞一行 running
    const db = openDatabase(dbPath);
    db.prepare("INSERT INTO jobs (kind, payload, status) VALUES ('ytdlp_download', '{}', 'running')").run();
    db.close();

    await bootstrap({ dbPath, tempDir: path.join(data, 'tmp') }); // 第二次启动
    const db2 = openDatabase(dbPath);
    const row = db2.prepare('SELECT status, message FROM jobs').get() as
      | { status: string; message: string }
      | undefined;
    db2.close();
    expect(row?.status).toBe('error');
    expect(row?.message).toContain('应用中断');
  });

  it('孤儿清理:keep 之外的文件被删,keep 之内的保留;dbPath 父目录自动创建', async () => {
    const data = tmpDir();
    const tempDir = path.join(data, 'tmp');
    mkdirSync(tempDir, { recursive: true }); // 先建目录才能写测试文件
    writeFileSync(path.join(tempDir, 'a.tmp'), 'x');
    writeFileSync(path.join(tempDir, 'b.tmp'), 'y');
    cleanOrphans(tempDir, new Set([path.join(tempDir, 'b.tmp')]));
    expect(existsSync(path.join(tempDir, 'a.tmp'))).toBe(false);
    expect(existsSync(path.join(tempDir, 'b.tmp'))).toBe(true);

    const nested = path.join(data, 'deep', 'sct.db'); // 父目录不存在
    await bootstrap({ dbPath: nested, tempDir });
    expect(existsSync(nested)).toBe(true);
  });

  it('F1:真实启动路径也会备份 —— 老库形态下 bootstrap 触发的重建必须生成 .bak', async () => {
    const data = tmpDir();
    const dbPath = path.join(data, 'sct.db');
    // 造成"老库形态":clip_projects 带 import_id UNIQUE(autoindex → 触发重建)
    const db = openDatabase(dbPath);
    db.exec("CREATE TABLE clip_projects (id INTEGER PRIMARY KEY AUTOINCREMENT, import_id INTEGER NOT NULL UNIQUE, name TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))");
    db.close();

    await bootstrap({ dbPath, tempDir: path.join(data, 'tmp') }); // 真实启动路径:bootstrap 先调 initSchema

    const baks = readdirSync(data).filter((f) => f.startsWith('sct.db.bak-'));
    expect(baks).toHaveLength(1);
  });
});
