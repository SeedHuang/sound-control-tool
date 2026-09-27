import type { DB } from '../index.js';

export interface SettingsRepo {
  get(key: string): string | null;
  set(key: string, value: string): void;
  all(): Record<string, string>;
}

export function createSettingsRepo(db: DB): SettingsRepo {
  return {
    get: (key) =>
      (db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null,
    set: (key, value) =>
      db
        .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run(key, value),
    all: () =>
      Object.fromEntries(
        (db.prepare('SELECT key, value FROM settings').all() as Array<{ key: string; value: string }>).map(
          (r) => [r.key, r.value],
        ),
      ),
  };
}
