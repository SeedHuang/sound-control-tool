import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { openDatabase } from './db/index.js';
import { initSchema } from './db/schema.js';
import { createSettingsRepo } from './db/repo/settings.js';
import { SETTINGS_KEYS } from './settings-keys.js';
import { resolveOutputDir } from './output-dir.js';

const freshDb = () => { const db = openDatabase(':memory:'); initSchema(db); return db; };

describe('resolveOutputDir(输出目录单一解析点)', () => {
  it('未配置 / 空串 → 回退到 fallback', () => {
    const db = freshDb();
    const fallback = join(tmpdir(), 'sct-fallback');
    expect(resolveOutputDir(db, fallback)).toBe(fallback);
    createSettingsRepo(db).set(SETTINGS_KEYS.outputDir, '');
    expect(resolveOutputDir(db, fallback)).toBe(fallback);
  });
  it('配了绝对路径 → 用配置值', () => {
    const db = freshDb();
    const custom = mkdtempSync(join(tmpdir(), 'sct-out-'));
    createSettingsRepo(db).set(SETTINGS_KEYS.outputDir, custom);
    expect(resolveOutputDir(db, join(tmpdir(), 'ignored'))).toBe(custom);
  });
});
