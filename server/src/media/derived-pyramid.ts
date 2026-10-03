// server/src/media/derived-pyramid.ts
// Spec B T3 · L1/L2 分段雪碧图：**复用** derived-images.ts 的缓存自愈 / 在途合并 / 原子落盘 / 变局分类
// （那些是 N0 + OCR 12 轮沉淀的地基，本文件不复制第二份 —— 复制即漂移）。
// 本文件只负责「段」这层概念：门槛判定、段 meta、单段生成。
import type { DB } from '../db/index.js';
import { pushLog } from '../logs.js';
import type { probeDuration } from '../ytdlp/ffprobe.js';
import { FILM_META_V, checkLevelAvailable, filmShapeSig, sampleTimes, segmentCount, tilesFor } from '../ffmpeg/derived-args.js';
import { checkDerivedCache, ensureDerivedImage, probeDurationFor, type DerivedResult, type ExecLike, type FilmMeta, type FilmSegRef } from './derived-images.js';

// 档位门槛（checkLevelAvailable）与 L2 门槛常量的**单一来源在 derived-args.ts**（2026-10-03 OCR 审查第 5 轮 medium）：
// 波形峰值链路（wave-peaks.ts）也要用同一份判定 —— 否则同一档位两个产物会给出相反结论
// （素材放不下该档时 /filmseg 返 404 而 /wavepeak 仍 200 返回数据）。这里只做转出，本文件不持有实现。
export { LEVEL2_MIN_DURATION_SEC, checkLevelAvailable } from '../ffmpeg/derived-args.js';
export type { LevelAvailability } from '../ffmpeg/derived-args.js';

/**
 * 段 meta：L1/L2 每段 12 格（**末段按实际跨度少拼几格**，见 `tilesFor`），sig 带 level 与格数 ——
 * 命中判定逐字比对（沿用 N0 的自愈机制）。
 * **不收 seg**：段号只由文件名承载（`film-<id>-L<lv>-<seg>.png`），不进 meta ——
 * meta 是「这张图怎么画的」的凭据；格数由 (时长, 档位, 段号) 推导得出，`checkDerivedCache` 用 `tilesFor` 现算比对。
 * generatedAt 是纯记录字段，同样不参与任何比对。
 */
export function segmentFileMeta(durationSec: number, level: 1 | 2, seg: number): FilmMeta {
  const tiles = tilesFor(durationSec, level, seg);
  return {
    v: FILM_META_V,
    level,
    sig: filmShapeSig(level, tiles),
    durationSec,
    tiles,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * 单段生成。**所有缓存 / 并发 / 落盘 / 变局逻辑都委托给 ensureDerivedImage** —— 本函数只做四件事：
 *   ① 先试命中（命中是常见路径：用户反复开页面 —— 这时必须零 ffmpeg **且零 ffprobe**）；
 *   ② 未命中才探时长（门槛判定要用它）；
 *   ③ 门槛不够就说清哪一档不够（LEVEL_UNAVAILABLE，与 PROBE_FAIL 分开 —— 两种成因两条出路）；
 *   ④ 算采样点并转调（times 传下去，`ensureDerivedImage` 内部不再探第二遍时长）。
 * 采样点由 derived-args 的 sampleTimes 统一算（每格取区间起点，末段按实际 span 收窄），这里不重写公式。
 */
export async function ensureFilmSegment(o: {
  level: 1 | 2; seg: number; importId: number; videoPath: string;
  derivedDir: string; tempDir: string; db: DB;
  doExec?: ExecLike; probe?: typeof probeDuration; resolveFfmpeg?: (db: DB) => Promise<string | null>;
  sourceState?: (p: string) => 'current' | 'replaced' | 'gone';
}): Promise<DerivedResult> {
  const segRef: FilmSegRef = { level: o.level, seg: o.seg };
  // ① 命中先试：命中就不探时长、不起 ffmpeg（开页快慢全看这条路径）
  const hit = checkDerivedCache(o.derivedDir, 'filmSeg', o.importId, segRef);
  if (hit.path !== null) {
    pushLog('debug', 'media', `分段雪碧图命中缓存 import=${o.importId} L${o.level}-${o.seg}`);
    return { ok: true, path: hit.path, cached: true };
  }
  // ② 未命中 → 探时长（门槛判定要用）
  const pr = await probeDurationFor({ db: o.db, videoPath: o.videoPath, resolveFfmpeg: o.resolveFfmpeg, probe: o.probe });
  if (!pr.ok) {
    pushLog('error', 'media', `分段雪碧图失败：${pr.code} import=${o.importId} L${o.level}-${o.seg} msg=${pr.message}`);
    return { ok: false, code: pr.code, message: pr.message };
  }
  // ③ 门槛判定：不够就说清哪一档不够（D5 诚实原则）—— 不复用 PROBE_FAIL，那是「读不出素材」，成因不同
  const avail = checkLevelAvailable(pr.durationSec, o.level);
  if (!avail.ok) {
    pushLog('info', 'media', `分段雪碧图跳过：档位不可用 import=${o.importId} L${o.level} duration=${pr.durationSec.toFixed(2)}s`);
    return { ok: false, code: 'LEVEL_UNAVAILABLE', message: avail.message };
  }
  // ④ 段号越界 → 明确失败。**不夹到最后一段**：那样图和 URL 说的不是同一段；而且 segmentSpan 对越界 seg
  //    会给出 span=0 → sampleTimes 算出 12 个相同的点 → 生成一张「12 格全一样」的图（用户看不出来的静默错误）。
  //    判定必须在生成层：只有它知道时长，而路由为了校验去探时长会毁掉「命中缓存零 ffprobe」（T3 的核心特性）。
  const segCount = segmentCount(pr.durationSec, o.level);
  if (o.seg >= segCount) {
    pushLog('info', 'media', `分段雪碧图跳过：段号越界 import=${o.importId} L${o.level} seg=${o.seg} 共${segCount}段`);
    return { ok: false, code: 'SEGMENT_NOT_FOUND', message: `段号 ${o.seg} 超出范围（本档共 ${segCount} 段，编号 0–${segCount - 1}）` };
  }
  // ⑤ 算格数与采样点 → 转调（times 传下去，内部不再探第二遍时长）
  // ⚠️ 格数用 `tilesFor` 而不是 `FILM_LEVEL_TILES`（2026-10-03 OCR 审查第 6 轮 medium）：
  //   **末段按实际跨度少拼几格**，否则前端那个按实际跨度收窄的显示框会把整张 12 格图压成竖条。
  const tiles = tilesFor(pr.durationSec, o.level, o.seg);
  const times = sampleTimes(pr.durationSec, o.level, o.seg);
  return ensureDerivedImage({
    kind: 'filmSeg', importId: o.importId, videoPath: o.videoPath,
    derivedDir: o.derivedDir, tempDir: o.tempDir, db: o.db,
    doExec: o.doExec, probe: o.probe, resolveFfmpeg: o.resolveFfmpeg, sourceState: o.sourceState,
    seg: segRef, tiles, times,
    metaFor: () => segmentFileMeta(pr.durationSec, o.level, o.seg),
  });
}
