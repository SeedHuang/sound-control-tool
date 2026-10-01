// server/src/db/tx.test.ts
// 事务 helper 的单测：提交落库、回滚不留痕（D18 的底座）。
import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type DB } from './index.js';
import { inTransaction } from './tx.js';

let db: DB;
beforeEach(() => {
  db = openDatabase(':memory:');
  db.exec('CREATE TABLE t (v TEXT)');
});
const count = (): number => Number((db.prepare('SELECT COUNT(*) AS n FROM t').get() as { n: number }).n);

describe('inTransaction', () => {
  it('回调无异常 → COMMIT，写入可见', () => {
    inTransaction(db, () => {
      db.exec("INSERT INTO t(v) VALUES ('a')");
    });
    expect(count()).toBe(1);
  });
  it('回调抛异常 → ROLLBACK，写入不留痕且原异常照抛', () => {
    expect(() =>
      inTransaction(db, () => {
        db.exec("INSERT INTO t(v) VALUES ('b')");
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(count()).toBe(0); // 回滚后那行不存在
  });
});
