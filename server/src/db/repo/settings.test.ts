import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type DB } from '../index.js';
import { initSchema } from '../schema.js';
import { createSettingsRepo } from './settings.js';

describe('settings repo(内存 SQLite,真 SQL)', () => {
  let db: DB;
  beforeEach(() => {
    db = openDatabase(':memory:');
    initSchema(db);
  });
  afterEach(() => {
    db.close();
  });

  it('set 后 get 取回;覆盖写生效', () => {
    const repo = createSettingsRepo(db);
    repo.set('k', 'v1');
    expect(repo.get('k')).toBe('v1');
    repo.set('k', 'v2');
    expect(repo.get('k')).toBe('v2');
  });

  it('get 不存在的键返回 null;all() 返回全部', () => {
    const repo = createSettingsRepo(db);
    expect(repo.get('nope')).toBeNull();
    repo.set('a', '1');
    repo.set('b', '2');
    expect(repo.all()).toEqual({ a: '1', b: '2' });
  });
});
