// server/src/db/repo/imports.ts(导入来源表:parse 成功自动落库,左列表持久化——2026-09-29 用户拍板)
// 职责:只管「来源」;下载完成的音频仍写 audio_items,两表互不干扰
import type { DB } from '../index.js';

export interface ImportEntry { index: number; title: string }
export interface ImportUpsert { url: string; title: string; site: string; kind: 'single' | 'playlist'; duration_sec: number | null; entries: ImportEntry[] | null }
export interface ImportSummaryRow { id: number; url: string; title: string; site: string; kind: 'single' | 'playlist'; entry_count: number; created_at: string }
export interface ImportDetailRow extends ImportSummaryRow { duration_sec: number | null; entries: ImportEntry[] | null }

/** 从 URL 识别来源站点(域名匹配,用于左列表 logo;非 URL → other) */
export function detectSite(url: string): 'bilibili' | 'youtube' | 'other' {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host.includes('bilibili')) return 'bilibili';
    if (host.includes('youtube') || host === 'youtu.be') return 'youtube';
  } catch { /* fallthrough */ }
  return 'other';
}

export function createImportsRepo(db: DB) {
  const parseEntries = (json: string | null): ImportEntry[] | null => {
    if (json === null) return null;
    try { return JSON.parse(json) as ImportEntry[]; } catch { return null; }
  };

  /** 同 URL upsert(重复解析更新标题/集数缓存),返回行 id——parse 响应带 import_id 供前端直接选中 */
  const upsertByUrl = (s: ImportUpsert): number => {
    const entriesJson = s.entries ? JSON.stringify(s.entries) : null;
    db.prepare(
      'INSERT INTO imported_sources (url, title, site, kind, duration_sec, entries_json) VALUES (?, ?, ?, ?, ?, ?) ' +
      'ON CONFLICT(url) DO UPDATE SET title=excluded.title, site=excluded.site, kind=excluded.kind, duration_sec=excluded.duration_sec, entries_json=excluded.entries_json',
    ).run(s.url, s.title, s.site, s.kind, s.duration_sec, entriesJson);
    const row = db.prepare('SELECT id FROM imported_sources WHERE url = ?').get(s.url) as { id: number } | undefined;
    if (!row) throw new Error('imported_sources upsert 后查不到行');
    return row.id;
  };

  /** 左列表(新→旧);entries_json 不整包返回,只算条数(列表轻量) */
  const list = (): ImportSummaryRow[] =>
    (db.prepare('SELECT id, url, title, site, kind, entries_json, created_at FROM imported_sources ORDER BY created_at DESC, id DESC').all() as Array<Record<string, unknown>>).map((r) => ({
      id: r.id as number,
      url: r.url as string,
      title: r.title as string,
      site: r.site as string,
      kind: r.kind as 'single' | 'playlist',
      entry_count: r.entries_json !== null ? (JSON.parse(r.entries_json as string) as ImportEntry[]).length : 1,
      created_at: r.created_at as string,
    }));

  const mapDetail = (r: Record<string, unknown>): ImportDetailRow => {
    const entries = parseEntries((r.entries_json as string | null) ?? null);
    return {
      id: r.id as number,
      url: r.url as string,
      title: r.title as string,
      site: r.site as string,
      kind: r.kind as 'single' | 'playlist',
      entry_count: entries?.length ?? 1,
      duration_sec: (r.duration_sec as number | null) ?? null,
      entries,
      created_at: r.created_at as string,
    };
  };

  const get = (id: number): ImportDetailRow | null => {
    const r = db.prepare('SELECT * FROM imported_sources WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return r ? mapDetail(r) : null;
  };

  /** 按 URL 取(2026-09-29 用户拍板:音频库补齐老记录——旧音频没记合集名,拿它的 source_url 反查这张表) */
  const getByUrl = (url: string): ImportDetailRow | null => {
    const r = db.prepare('SELECT * FROM imported_sources WHERE url = ?').get(url) as Record<string, unknown> | undefined;
    return r ? mapDetail(r) : null;
  };

  const del = (id: number): boolean => db.prepare('DELETE FROM imported_sources WHERE id = ?').run(id).changes > 0;

  return { upsertByUrl, list, get, getByUrl, delete: del };
}
