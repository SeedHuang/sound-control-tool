// server/src/db/repo/imports.ts(导入来源表:parse 成功自动落库,左列表持久化——2026-09-29 用户拍板)
// 职责:只管「来源」;下载完成的音频仍写 audio_items,两表互不干扰
import type { DB } from '../index.js';

export interface ImportEntry { index: number; title: string }
export interface ImportUpsert { url: string; title: string; site: string; kind: 'single' | 'playlist'; duration_sec: number | null; entries: ImportEntry[] | null; thumbnail?: string | null }
export interface ImportSummaryRow {
  id: number; url: string; title: string; site: string; kind: 'single' | 'playlist'; entry_count: number; thumbnail: string | null; created_at: string;
  /** P2 派生列(2026-09-30,LEFT JOIN 派生):该来源有没有视频素材 / 有没有剪辑工程 / 工程段数(无工程 0) */
  has_video: boolean; has_project: boolean; segment_count: number;
}
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
      'INSERT INTO imported_sources (url, title, site, kind, duration_sec, entries_json, thumbnail) VALUES (?, ?, ?, ?, ?, ?, ?) ' +
      // thumbnail 用 COALESCE:这次解析没带封面地址时,保留上一次存的那个(否则一次抓不到图就把已有封面地址抹了)
      'ON CONFLICT(url) DO UPDATE SET title=excluded.title, site=excluded.site, kind=excluded.kind, duration_sec=excluded.duration_sec, ' +
      'entries_json=excluded.entries_json, thumbnail=COALESCE(excluded.thumbnail, imported_sources.thumbnail)',
    ).run(s.url, s.title, s.site, s.kind, s.duration_sec, entriesJson, s.thumbnail ?? null);
    const row = db.prepare('SELECT id FROM imported_sources WHERE url = ?').get(s.url) as { id: number } | undefined;
    if (!row) throw new Error('imported_sources upsert 后查不到行');
    return row.id;
  };

  /** 左列表(新→旧);entries_json 不整包返回,只算条数(列表轻量)。
   *  P2(2026-09-30):LEFT JOIN 派生 has_video/has_project/segment_count——素材/工程与来源一对一
   *  (UNIQUE),JOIN 不会复制行;无素材/无工程 → false/0,不是缺字段(前端资料库页三态标识要靠它) */
  const list = (): ImportSummaryRow[] =>
    (db.prepare(
      'SELECT s.id, s.url, s.title, s.site, s.kind, s.entries_json, s.thumbnail, s.created_at, ' +
      'CASE WHEN v.import_id IS NULL THEN 0 ELSE 1 END AS has_video, ' +
      'CASE WHEN p.id IS NULL THEN 0 ELSE 1 END AS has_project, ' +
      '(SELECT COUNT(*) FROM clip_segments seg WHERE seg.project_id = p.id) AS segment_count ' +
      'FROM imported_sources s ' +
      'LEFT JOIN source_videos v ON v.import_id = s.id ' +
      'LEFT JOIN clip_projects p ON p.import_id = s.id ' +
      'ORDER BY s.created_at DESC, s.id DESC',
    ).all() as Array<Record<string, unknown>>).map((r) => ({
      id: r.id as number,
      url: r.url as string,
      title: r.title as string,
      site: r.site as string,
      kind: r.kind as 'single' | 'playlist',
      entry_count: r.entries_json !== null ? (JSON.parse(r.entries_json as string) as ImportEntry[]).length : 1,
      thumbnail: r.thumbnail === null || r.thumbnail === undefined ? null : String(r.thumbnail),
      created_at: r.created_at as string,
      has_video: Number(r.has_video) === 1,
      has_project: Number(r.has_project) === 1,
      segment_count: Number(r.segment_count ?? 0),
    }));

  // 详情查询与 list 同款派生列(ImportDetailRow extends ImportSummaryRow,缺了这三个字段编译不过)
  const derivedJoin =
    'SELECT s.*, ' +
    'CASE WHEN v.import_id IS NULL THEN 0 ELSE 1 END AS has_video, ' +
    'CASE WHEN p.id IS NULL THEN 0 ELSE 1 END AS has_project, ' +
    '(SELECT COUNT(*) FROM clip_segments seg WHERE seg.project_id = p.id) AS segment_count ' +
    'FROM imported_sources s ' +
    'LEFT JOIN source_videos v ON v.import_id = s.id ' +
    'LEFT JOIN clip_projects p ON p.import_id = s.id ';

  const mapDetail = (r: Record<string, unknown>): ImportDetailRow => {
    const entries = parseEntries((r.entries_json as string | null) ?? null);
    return {
      id: r.id as number,
      url: r.url as string,
      title: r.title as string,
      site: r.site as string,
      kind: r.kind as 'single' | 'playlist',
      entry_count: entries?.length ?? 1,
      thumbnail: r.thumbnail === null || r.thumbnail === undefined ? null : String(r.thumbnail),
      duration_sec: (r.duration_sec as number | null) ?? null,
      entries,
      created_at: r.created_at as string,
      has_video: Number(r.has_video) === 1,
      has_project: Number(r.has_project) === 1,
      segment_count: Number(r.segment_count ?? 0),
    };
  };

  const get = (id: number): ImportDetailRow | null => {
    const r = db.prepare(derivedJoin + 'WHERE s.id = ?').get(id) as Record<string, unknown> | undefined;
    return r ? mapDetail(r) : null;
  };

  /** 按 URL 取(2026-09-29 用户拍板:剪辑室补齐老记录——旧音频没记合集名,拿它的 source_url 反查这张表) */
  const getByUrl = (url: string): ImportDetailRow | null => {
    const r = db.prepare(derivedJoin + 'WHERE s.url = ?').get(url) as Record<string, unknown> | undefined;
    return r ? mapDetail(r) : null;
  };

  const del = (id: number): boolean => db.prepare('DELETE FROM imported_sources WHERE id = ?').run(id).changes > 0;

  return { upsertByUrl, list, get, getByUrl, delete: del };
}
