// server/src/db/repo/home.ts
// 首页仪表盘数据(P5-T1,spec §0.3「其它」):两块 Top3 —— 正在编辑的工程(editing)、
// 按来源去重后最近下载的作品(recent)。与其它 repo 一致:工厂 createHomeRepo(db) + 显式 map
// (SQL 返回的裸列是 unknown,统一在这里归一成类型化行,避免形状漂到路由层)。
import type { DB } from '../index.js';

/** editing:正在编辑的工程(按 updated_at 倒序 Top3);形状与 GET /api/projects 对齐 → 前端复用同一渲染 */
export interface HomeEditingRow {
  import_id: number;
  name: string | null; // 用户没命名过 → null(前端显示「未命名工程」)
  site: string;        // 供前端画平台 logo
  updated_at: string;
  segment_count: number;
}

/** recent:按来源去重后最近下载的作品(Top3) */
export interface HomeRecentRow {
  import_id: number;
  title: string;        // 作品主名:该来源最新一条音频的 collection_title ?? title(Ruling P5-1)
  site: string;
  latest_audio_id: number; // 该来源最新那条音频的 id
  created_at: string;      // 该来源最新那条音频的时间
}

export function createHomeRepo(db: DB) {
  /** 正在编辑 Top3。JOIN imported_sources 是必须的:clip_projects 只存 import_id,site 在来源表里。
   *  用 INNER JOIN —— 工程指向的来源若已不存在(删来源的清理漏网),这条就不该出现在首页(与「排除裸 import_id」同义)。
   *  segment_count 用相关子查询算段数:一个工程段数极少(≤50),比 LEFT JOIN + GROUP BY 更直白、也不影响 Top3 的行数。 */
  const editing = (): HomeEditingRow[] =>
    (db.prepare(
      'SELECT p.import_id AS import_id, p.name AS name, s.site AS site, p.updated_at AS updated_at, ' +
      '(SELECT COUNT(*) FROM clip_segments seg WHERE seg.project_id = p.id) AS segment_count ' +
      'FROM clip_projects p ' +
      'JOIN imported_sources s ON s.id = p.import_id ' +
      'ORDER BY p.updated_at DESC, p.import_id DESC LIMIT 3',
    ).all() as Array<Record<string, unknown>>).map((r) => ({
      import_id: Number(r.import_id),
      name: r.name === null || r.name === undefined ? null : String(r.name), // NULL 归一(沿用 clip-projects repo 写法)
      site: String(r.site),
      updated_at: String(r.updated_at),
      segment_count: Number(r.segment_count ?? 0),
    }));

  /** 最近下载 Top3,**按来源去重**。为什么去重:一个合集刚下了 193 集,不去重的话 Top3 会全是同一部作品的三集,首页等于没信息。
   *  关联来源:audio_items 的 source_import_id 列**已存在**(2026-10-01 spec audio-lineage),但本查询**刻意仍按
   *  imported_sources.url = audio_items.source_url 关联**:对 source_type='download' 的旧行两者等价,换过来零收益、
   *  却要动一条已被 8 个用例固化的 SQL(spec audio-lineage D11)。
   *  INNER JOIN 匹配不上的音频自然被排除,等价于 spec 的「排除 import_id 为 null」——录制/无来源音频不算媒体作品)。
   *  WHERE source_type='download' 再排除剪辑产物('edit')与录制('recording'),这些不是「下载的作品」。
   *
   *  ⚠️ 这条 SQL 的正确性靠 SQLite 的一个特性(务必理解,否则会误以为裸列是「随便一行」):
   *   当 SELECT 里只有 MAX()/MIN() 这类聚合,SQLite 对同一 SELECT 中的**裸列**做特殊处理 ——
   *   裸列取「产生该极值的那一行」的值(官方称 bare columns in an aggregate query)。
   *   这里唯一聚合是 MAX(a.created_at),所以 a.id / a.title / a.collection_title 都来自**最新那条音频**:
   *   a.id 即 latest_audio_id,COALESCE(a.collection_title, a.title) 即这部作品的主名(有合集名用合集名,单集用自身标题,
   *   与前端 mainTitle() 同义 —— Ruling P5-1)。不加 GROUP BY 就无法去重,加了 GROUP BY 又不配这个特性就取不到对应行的裸列。
   *
   *  ORDER BY 用聚合别名 created_at(= MAX(a.created_at)):SQLite 允许 ORDER BY 引用 SELECT 别名。 */
  const recent = (): HomeRecentRow[] =>
    (db.prepare(
      'SELECT s.id AS import_id, COALESCE(a.collection_title, a.title) AS title, s.site AS site, ' +
      'a.id AS latest_audio_id, MAX(a.created_at) AS created_at ' +
      'FROM audio_items a ' +
      'JOIN imported_sources s ON s.url = a.source_url ' +
      "WHERE a.source_type = 'download' " +
      'GROUP BY s.id ' +
      'ORDER BY created_at DESC, s.id DESC LIMIT 3',
    ).all() as Array<Record<string, unknown>>).map((r) => ({
      import_id: Number(r.import_id),
      title: String(r.title),
      site: String(r.site),
      latest_audio_id: Number(r.latest_audio_id),
      created_at: String(r.created_at),
    }));

  return { editing, recent };
}
