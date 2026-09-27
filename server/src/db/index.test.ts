import { describe, expect, it } from 'vitest';
import { openDatabase } from './index.js';

describe('openDatabase(node:sqlite 驱动入口)', () => {
  it('内存库建表/写入/读出往返', () => {
    const db = openDatabase(':memory:');
    db.exec('CREATE TABLE t (v TEXT NOT NULL)');
    db.prepare('INSERT INTO t (v) VALUES (?)').run('x');
    const row = db.prepare('SELECT v FROM t').get() as { v: string } | undefined;
    expect(row?.v).toBe('x');
    db.close();
  });
});
