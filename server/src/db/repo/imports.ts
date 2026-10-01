// server/src/db/repo/imports.ts(导入来源表:parse 成功自动落库,左列表持久化——2026-09-29 用户拍板)
// 职责:只管「来源」;下载完成的音频仍写 audio_items,两表互不干扰
import type { DB } from '../index.js';

export interface ImportEntry { index: number; title: string }
export interface ImportUpsert { url: string; title: string; site: string; kind: 'single' | 'playlist'; duration_sec: number | null; entries: ImportEntry[] | null; thumbnail?: string | null }
export interface ImportSummaryRow {
  id: number; url: string; title: string; site: string; kind: 'single' | 'playlist'; entry_count: number; thumbnail: string | null; created_at: string;
  /** P2 派生列(2026-09-30,派生):该来源有没有视频素材 / 有没有剪辑作品 / 段数(无作品 0) */
  has_video: boolean; has_project: boolean; segment_count: number;
  /** clip-works(2026-10-01,1:N):该资料下的作品数(无作品 → 0) */
  work_count: number;
  /** P3-T1 派生列(2026-09-30,同 LEFT JOIN 带出):该素材是合集里的第几集(单视频/无素材 → null),剪辑室据此显示「素材:第 N 集」 */
  material_entry_index: number | null;
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

  // 派生列与 JOIN(2026-10-01 clip-works 改):
  //   s.* 带出 imported_sources 全部列;派生列补素材/作品/段数/素材集号。
  //   ⚠️ 1:N 之后**不能再** LEFT JOIN clip_projects(那会把有多件作品的资料复制成多行)——
  //   作品相关派生列全部走相关子查询,唯一 LEFT JOIN 只留一对一(UNIQUE)的 source_videos,保证"一行来源恒一行"。
  //   ⚠️ imported_sources 本身没有 has_video/has_project/segment_count/work_count/material_entry_index 同名列,不会遮蔽派生值。
  const DERIVED_COLS =
    'CASE WHEN v.import_id IS NULL THEN 0 ELSE 1 END AS has_video, ' +
    'CASE WHEN EXISTS(SELECT 1 FROM clip_projects p WHERE p.import_id = s.id) THEN 1 ELSE 0 END AS has_project, ' +
    // segment_count 口径(clip-works):该资料下**全部作品**的段数之和(不再是"唯一那个工程"的段数)
    '(SELECT COUNT(*) FROM clip_segments seg JOIN clip_projects p2 ON p2.id = seg.project_id WHERE p2.import_id = s.id) AS segment_count, ' +
    '(SELECT COUNT(*) FROM clip_projects p3 WHERE p3.import_id = s.id) AS work_count, ' +
    'v.entry_index AS material_entry_index';
  const DERIVED_JOINS = 'FROM imported_sources s LEFT JOIN source_videos v ON v.import_id = s.id ';
  const derivedJoin = `SELECT s.*, ${DERIVED_COLS} ${DERIVED_JOINS}`;

  /** 列表/详情共用的基础行映射(T7-7):只取 ImportSummaryRow 的字段,其余列忽略;
   *  entries_json 不整包返回,只算条数(列表轻量) */
  const mapBase = (r: Record<string, unknown>): ImportSummaryRow => {
    const entries = parseEntries((r.entries_json as string | null) ?? null);
    return {
      id: r.id as number,
      url: r.url as string,
      title: r.title as string,
      site: r.site as string,
      kind: r.kind as 'single' | 'playlist',
      entry_count: entries?.length ?? 1,
      thumbnail: r.thumbnail === null || r.thumbnail === undefined ? null : String(r.thumbnail),
      created_at: r.created_at as string,
      has_video: Number(r.has_video) === 1,
      has_project: Number(r.has_project) === 1,
      segment_count: Number(r.segment_count ?? 0),
      work_count: Number(r.work_count ?? 0),
      material_entry_index: r.material_entry_index === null || r.material_entry_index === undefined ? null : Number(r.material_entry_index),
    };
  };

  /** 左列表(新→旧);走共用派生表,保证响应字段与详情一致 */
  const list = (): ImportSummaryRow[] =>
    (db.prepare(derivedJoin + 'ORDER BY s.created_at DESC, s.id DESC').all() as Array<Record<string, unknown>>).map(mapBase);

  // 详情行 = 基础行 + duration_sec/entries(ImportDetailRow extends ImportSummaryRow)
  const mapDetail = (r: Record<string, unknown>): ImportDetailRow => ({
    ...mapBase(r),
    duration_sec: (r.duration_sec as number | null) ?? null,
    entries: parseEntries((r.entries_json as string | null) ?? null),
  });

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
