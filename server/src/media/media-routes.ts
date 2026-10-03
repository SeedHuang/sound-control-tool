// server/src/media/media-routes.ts
// 媒体素材路由(2026-09-29 spec m1c-video-clip §0.3):列表 / 视频流(带 Range) / 删素材 / 剪音频。
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createImportsRepo } from '../db/repo/imports.js';
import { createJobsRepo } from '../db/repo/jobs.js';
import { createSourceVideosRepo } from '../db/repo/source-videos.js';
import type { DB } from '../db/index.js';
import { isAllowedLocalOrigin, isLocalPageReferer } from '../http/cors.js';
import { sendFileWithRange } from '../http/file-range.js';
import { pushLog } from '../logs.js';
import { deleteVideoFiles } from './media-files.js';
import { startClipJob, type ClipJobPayload } from './clip-job.js';
import { derivedDirFor, ensureDerivedImage, invalidateDerived, type DerivedKind } from './derived-images.js';
import { ensureFilmSegment } from './derived-pyramid.js';
import { ensureWavePeaks } from './wave-peaks.js';

export { formatClipTitle } from './clip-job.js';

// Task 9 同款:文件流 Content-Type 按扩展名映射——给 <video> 标签可识别的 MIME,未知格式回退 octet-stream
const MEDIA_MIME: Record<string, string> = { mp4: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska' };

/**
 * 派生图生成失败的「失败码 → HTTP 状态 + 下一步提示」映射（单一来源，路由里不再写 if/三元）。
 * 2026-10-02 审查修复轮 1 minor 4：原来只有 PROBE_FAIL 一种失败被单独分流，其余一律
 * 「到设置页检查 ffmpeg 配置」——把「素材本身的问题」与「环境没配好」混成一句话，把人引去错的地方。
 * 加新失败码只加一行。
 * ⚠️ 不要再往提示里加「素材太短（凑不满 12 帧）」这类说法：复核在 ffmpeg 9.0.2 上实测
 * 0.1/0.2/0.3/0.4/0.5/0.8/1.0/1.5 秒八档**全部正常出 PNG**（tile 在 EOF 会冲刷不满的 tile），
 * 写「不足 1 秒也会失败」是把用户引向一个不存在的病因。
 */
const DERIVED_FAIL: Record<'NO_FFMPEG' | 'FFMPEG_FAIL' | 'PROBE_FAIL' | 'SRC_CHANGED' | 'LEVEL_UNAVAILABLE' | 'SEGMENT_NOT_FOUND', { status: number; next: string }> = {
  NO_FFMPEG: { status: 500, next: '到设置页检查 ffmpeg 路径（ffprobe 需与 ffmpeg 同目录）' },
  FFMPEG_FAIL: { status: 500, next: '到设置页检查 ffmpeg 配置；素材已损坏或磁盘写入失败也会走到这里，详见日志页' },
  PROBE_FAIL: { status: 422, next: '删除该素材后重新下载完整视频；若重下后仍失败，见日志页排查环境原因' },
  // OCR R4(2026-10-03):生成期间素材被换源(重下/换清晰度)→ 旧内容产物按身份复核丢弃。瞬时冲突,刷新即自愈。
  // OCR R7:替换与删除两种成因都走到这里,出路不同,一句话都要说清
  SRC_CHANGED: { status: 409, next: '素材在生成期间被替换或删除：被替换则重新打开页面自动重画；被删除则需重新下载视频' },
  // Spec B D5(2026-10-03)：这个素材**没有这一档**（太短，放不下那档的时间窗）。与 PROBE_FAIL 分开 ——
  // 不是「读不出素材」（那要重下），而是「素材就这样，换更粗的档」。404 比 422 贴切：请求的那一档不存在。
  // ⚠️ next 里**不点名具体档位**（2026-10-03 OCR 审查第 2 轮）：原来的「用更粗的档位（全片 / 中景）」在
  // 失败的正是 L1（中景）时，会叫用户「切到刚刚 404 的那一档」。级别感知的 message 由 checkLevelAvailable 给。
  LEVEL_UNAVAILABLE: { status: 404, next: '素材太短，放不下这一档的时间窗；改用更粗的档位（如「全片」），或不看这一档' },
  // Spec B T5：段号越界（素材比 URL 说的短，比如页面还停在旧 duration 上）。不夹到最后一段 ——
  // 那样图和 URL 说的不是同一段，且会生成一张「12 格全一样」的图（用户看不出来的静默错误）。
  SEGMENT_NOT_FOUND: { status: 404, next: '这一段不存在；素材可能比页面显示的短，刷新页面重试' },
};

export function registerMediaRoutes(
  app: FastifyInstance,
  deps: { db: DB; audioDir: string; tempDir: string; mediaDir: string; token: string },
): void {
  const { db, mediaDir, token } = deps;
  const videosRepo = createSourceVideosRepo(db);

  // —— P4 派生图（波形/胶片条，spec D6/D14/§0.3）——
  /**
   * 派生图系列（PNG / 分段雪碧图 / 峰值 JSON）的鉴权：**三件套口径只此一份**。
   * <img>/<video> 加不了 header、也不发 Origin → 认 query token / 本机 Origin / 本机 Referer。
   * 抽出来是因为 Spec B 之后这个口径有**三个调用点** —— 复制三份的下一站必然是「改了两份、漏了一份」。
   * 返回 true = 已拒绝（调用方直接 `return`）。
   */
  const denyIfNotLocal = (req: FastifyRequest, reply: FastifyReply, tag: string): boolean => {
    const q = (req.query ?? {}) as { token?: string };
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
    if (q.token === token || isAllowedLocalOrigin(origin) || isLocalPageReferer(req.headers.referer)) return false;
    pushLog('error', 'media', `${tag} 401 origin=${origin || '(none)'} token=${q.token ? 'present' : 'missing'} referer=${req.headers.referer ?? '(none)'}`);
    void reply.code(401).send({ ok: false, error: { code: 'UNAUTHORIZED', message: 'token 无效', next: '' } });
    return true;
  };

  /**
   * 解析素材行（含 importId 合法性 / 行存在 / 文件在）**并已把 404 发回**。
   * 返回 `undefined` = 已拒绝，调用方直接 return。
   * 三个派生图路由（serveDerived / filmseg / wavepeak）共用 —— 2026-10-03 OCR 审查第 11 轮 medium：
   * 这三段守卫此前逐字复制三份，与本批已抽出的 `denyIfNotLocal` / `mkSourceState` / `sendDerivedFail`
   * 是同一类问题：将来改 404 状态码或文案（加 `next`、改 FILE_MISSING 话术）要改三处，必然漏一处。
   * 顺带把 FILE_MISSING 的**两种成因**（来源已删 / 文件被外部删）留在同一处判定。
   */
  const resolveSourceRow = (req: FastifyRequest, reply: FastifyReply, importIdRaw: unknown): NonNullable<ReturnType<typeof videosRepo.get>> | undefined => {
    const importId = Number(importIdRaw);
    if (!Number.isInteger(importId) || importId <= 0) {
      void reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: '素材不存在', next: '' } });
      return undefined;
    }
    const row = videosRepo.get(importId);
    if (row === null) {
      void reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: '素材不存在', next: '' } });
      return undefined;
    }
    if (!existsSync(row.file_path)) {
      // 素材行在但文件被外部删了（同 /file 的两种 404 文案）
      void reply.code(404).send({ ok: false, error: { code: 'FILE_MISSING', message: '素材文件已丢失，请重新下载视频', next: '回到资料库重新下视频' } });
      return undefined;
    }
    return row;
  };

  /**
   * 失败出口（**唯一一份**，2026-10-03 OCR 审查第 4 轮 low）：查 `DERIVED_FAIL` + 记日志 + 回响应。
   * 三个处理器（serveDerived / filmseg / wavepeak）此前各内联一份逐字相同的样板，只有日志 tag 不同 ——
   * 与本批已抽出的 `denyIfNotLocal` / `mkSourceState` 是同一类问题：加失败码或改截断长度时改了两份漏一份。
   */
  const sendDerivedFail = (reply: FastifyReply, tag: string, r: { code: keyof typeof DERIVED_FAIL; message: string }): FastifyReply => {
    const fail = DERIVED_FAIL[r.code];
    pushLog('error', 'media', `${tag} code=${r.code} status=${fail.status} msg=${r.message.slice(0, 200)}`);
    return reply.code(fail.status).send({ ok: false, error: { code: r.code, message: r.message, next: fail.next } });
  };

  /**
   * 落盘前的第二重身份校验（OCR R5/R9）：「文件没变」≠「登记没变」，要查 DB 现登记。
   * 三态各有各的出路，**不能压成布尔**（R9：布尔会把「素材被整个删除」误报成「被替换」，
   * 让用户去刷新一个注定 404 的页面）：row 没了 = 'gone'（引导重下）/ row 换人 = 'replaced'（刷新自愈）。
   *
   * 2026-10-03（OCR 审查）：本函数此前在 serveDerived / filmseg / wavepeak **三处各内联一份**，
   * 文本完全相同 —— 与同批抽出的 `denyIfNotLocal` 是同一类问题（复制三份的下一站必然是改了两份漏一份）。
   */
  const mkSourceState = (importId: number) => (p: string): 'current' | 'replaced' | 'gone' => {
    const cur = videosRepo.get(importId);
    if (cur === null) return 'gone';
    return cur.file_path === p ? 'current' : 'replaced';
  };

  const serveDerived = (kind: DerivedKind) => async (req: FastifyRequest, reply: FastifyReply) => {
    const importId = Number((req.params as { importId: string }).importId);
    if (denyIfNotLocal(req, reply, `派生图 kind=${kind} import=${importId}`)) return;
    const row = resolveSourceRow(req, reply, importId);
    if (row === undefined) return;
    const r = await ensureDerivedImage({
      kind, importId, videoPath: row.file_path, derivedDir: derivedDirFor(mediaDir), tempDir: deps.tempDir, db,
      sourceState: mkSourceState(importId),
    });
    if (!r.ok) {
      // 失败码 → (HTTP 状态, 下一步提示) 映射表（2026-10-02 审查修复轮 1 minor 4）：
      // 加新失败码只加一行，别再让 if/三元把两种原因混成一句话。
      // - PROBE_FAIL = 422：素材本身的问题（文件损坏/没下完），不是服务端故障。语义比 500 贴切
      //   （对前端 <img> 效果一样，都进 onError；差别只在日志/排查时看得出是谁的锅）。
      // - 其余 = 500：ffmpeg 装没装、跑没跑通，是服务端/环境问题。
      // - FFMPEG_FAIL 的提示不再只让人查设置页：素材损坏也会走到这里，
      //   只写「去设置页」会把人引到错误的地方。
      //   ⚠️ 不要再提「素材太短」——复核实测 0.1~1.5 秒八档全部正常出图，那不是真病因。
      return sendDerivedFail(reply, `派生图接口失败 kind=${kind} import=${importId}`, r);
    }
    // 静态派生图走「封面式裸流」，不用 sendFileWithRange（实测 H：<img> 不发 Range，PNG 无 seek 语义）。
    // cache-control no-store：素材一变派生图即作废、URL 不变，长缓存会显示上一集的波形（见计划 C-1）
    reply.header('content-type', 'image/png').header('cache-control', 'no-store');
    return reply.send(createReadStream(r.path));
  };
  app.get('/api/media/:importId/waveform', serveDerived('wave'));
  app.get('/api/media/:importId/filmstrip', serveDerived('film'));

  // —— Spec B：分段雪碧图（?level=1|2&seg=N）——
  // 鉴权 / 404 / 失败码映射与 serveDerived 同口径（共用 denyIfNotLocal 与 DERIVED_FAIL 表）。
  app.get('/api/media/:importId/filmseg', async (req, reply) => {
    const importId = Number((req.params as { importId: string }).importId);
    if (denyIfNotLocal(req, reply, `分段雪碧图 import=${importId}`)) return;
    const q = (req.query ?? {}) as { level?: string; seg?: string };
    const level = Number(q.level);
    const seg = Number(q.seg);
    // 参数错是**用法错**（400），不是素材不在（404）—— 前端拼错 URL 时能一眼看出是谁的锅。
    // ⚠️ 顺序：先校验参数（400）再查素材（404）—— 用法错优先于资源状态，排查时更直观。
    // 段号**越界**不在这里判（那需要时长）：由生成层返回 SEGMENT_NOT_FOUND —— 只有它知道时长，
    // 而路由为了校验去探时长会毁掉「命中缓存零 ffprobe」（T3 的核心特性）。
    if ((level !== 1 && level !== 2) || q.seg === undefined || !Number.isInteger(seg) || seg < 0) {
      pushLog('error', 'media', `分段雪碧图 400 import=${importId} level=${q.level ?? '(none)'} seg=${q.seg ?? '(none)'}`);
      return reply.code(400).send({ ok: false, error: { code: 'BAD_SEGMENT', message: '档位只接受 1 或 2，段号是从 0 起的整数', next: '检查请求参数 level 与 seg' } });
    }
    const row = resolveSourceRow(req, reply, importId);
    if (row === undefined) return;
    const r = await ensureFilmSegment({
      level: level as 1 | 2, seg, importId, videoPath: row.file_path, // 上面已校验过只可能是 1 或 2
      derivedDir: derivedDirFor(mediaDir), tempDir: deps.tempDir, db,
      sourceState: mkSourceState(importId), // 落盘前第二重身份校验（三态，口径与 serveDerived 一致）
    });
    if (!r.ok) {
      return sendDerivedFail(reply, `分段雪碧图接口失败 import=${importId} L${level}-${seg}`, r);
    }
    reply.header('content-type', 'image/png').header('cache-control', 'no-store');
    return reply.send(createReadStream(r.path));
  });

  // —— Spec B：波形峰值 JSON（?level=0|1|2[&seg=N]）——
  // level=0 是「整片一张」（不带段号）；1/2 是分段（必须带段号）。
  app.get('/api/media/:importId/wavepeak', async (req, reply) => {
    const importId = Number((req.params as { importId: string }).importId);
    if (denyIfNotLocal(req, reply, `波形峰值 import=${importId}`)) return;
    const q = (req.query ?? {}) as { level?: string; seg?: string };
    const level = Number(q.level);
    const needsSeg = level === 1 || level === 2;
    const seg = level === 0 ? 0 : Number(q.seg);
    if ((level !== 0 && level !== 1 && level !== 2) || (needsSeg && (q.seg === undefined || !Number.isInteger(seg) || seg < 0))) {
      pushLog('error', 'media', `波形峰值 400 import=${importId} level=${q.level ?? '(none)'} seg=${q.seg ?? '(none)'}`);
      return reply.code(400).send({ ok: false, error: { code: 'BAD_SEGMENT', message: '档位只接受 0/1/2；1 与 2 必须带段号（从 0 起的整数）', next: '检查请求参数 level 与 seg' } });
    }
    const row = resolveSourceRow(req, reply, importId);
    if (row === undefined) return;
    // 峰值生成要素材时长（算末段窗口 + stepSec），但**只在意料中的未命中路径要** ——
    // 所以**不传 durationSec**，由 ensureWavePeaks 内部在未命中时探（2026-10-03 OCR 审查两轮修复）：
    // ① 第一版是路由层无条件先探 → 命中缓存也付 ffprobe（2.1GB 素材上十几秒）；
    // ② 第二版改成传懒回调、回调里 throw → **丢了 pr.code**，ffprobe 缺失被报成 PROBE_FAIL，
    //    把用户从「设置页」引到「重下素材」。现在由被调方自己探并原样透传 code，两个问题一起消。
    const r = await ensureWavePeaks({
      level: level as 0 | 1 | 2, seg, importId, videoPath: row.file_path, // level 上面已校验
      derivedDir: derivedDirFor(mediaDir), tempDir: deps.tempDir, db,
      sourceState: mkSourceState(importId),
    });
    if (!r.ok) {
      return sendDerivedFail(reply, `波形峰值接口失败 import=${importId} L${level}-${seg}`, r);
    }
    // JSON 产物：cache-control 同 PNG 用 no-store（素材一变即作废、URL 不变，长缓存会显示上一集的波形）
    reply.header('content-type', 'application/json; charset=utf-8').header('cache-control', 'no-store');
    return reply.send(r.data);
  });

  app.get('/api/media', async () => ({ ok: true, media: videosRepo.list() }));

  app.get('/api/media/:importId/file', async (req, reply) => {
    const importId = Number((req.params as { importId: string }).importId);
    const q = (req.query ?? {}) as { token?: string };
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
    // 鉴权口径与 /api/audio/:id/file 完全一致:<video> 不带 Origin、页面加不了 header → 认本机 Referer
    if (q.token !== token && !isAllowedLocalOrigin(origin) && !isLocalPageReferer(req.headers.referer)) {
      pushLog('error', 'media', `media file 401 import=${importId} origin=${origin || '(none)'} token=${q.token ? 'present' : 'missing'} referer=${req.headers.referer ?? '(none)'}`);
      return reply.code(401).send({ ok: false, error: { code: 'UNAUTHORIZED', message: 'token 无效', next: '' } });
    }
    if (!Number.isInteger(importId) || importId <= 0) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: '素材不存在', next: '' } });
    const row = videosRepo.get(importId);
    if (!row) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: '素材不存在', next: '' } });
    if (!existsSync(row.file_path)) {
      // 两种成因文案不同(spec §0.3):来源已删 → 素材行也会被清,能走到这里说明是文件被外部删了
      return reply.code(404).send({ ok: false, error: { code: 'FILE_MISSING', message: '素材文件已丢失，请重新下载视频', next: '回到资料库重新下视频' } });
    }
    const stat = statSync(row.file_path);
    const ext = row.file_path.slice(row.file_path.lastIndexOf('.') + 1).toLowerCase();
    // Range 语义与音频同款(http/file-range.ts 共用):拖进度条期待 206,永远 200 会把进度条锁死
    return sendFileWithRange(req, reply, {
      filePath: row.file_path, size: stat.size,
      contentType: MEDIA_MIME[ext] ?? 'application/octet-stream',
    });
  });

  app.delete('/api/media/:importId', async (req, reply) => {
    const importId = Number((req.params as { importId: string }).importId);
    if (!Number.isInteger(importId) || importId <= 0) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: '素材不存在', next: '' } });
    if (videosRepo.get(importId) === null) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: '素材不存在', next: '' } });
    // 删文件失败不让接口失败(与 DELETE /api/audio/:id 同款语义:DB 行删了就算"删了")
    const r = deleteVideoFiles(mediaDir, importId);
    videosRepo.delete(importId);
    invalidateDerived(derivedDirFor(mediaDir), importId); // R3-2：素材没了 → 派生图一并作废（失败只记日志）
    pushLog('info', 'media', `素材已删 import=${importId} deleted=${r.deleted.length} failed=${r.failed.length}`);
    return { ok: true, deleted: r.deleted.length };
  });

  // 休眠路由(m1c 遗留;2026-10-01 spec clip-works D20 保留不删):web 侧无调用方(api.ts 的 clipMedia 已休眠)。
  // ⚠️ 它产出的成品只记 source_import_id、**没有作品归属**(source_work_id 为空)——启用前必须先定归属(clip-works D20/backlog)。
  app.post('/api/media/:importId/clip', async (req, reply) => {
    const importId = Number((req.params as { importId: string }).importId);
    if (!Number.isInteger(importId) || importId <= 0) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: '素材不存在', next: '' } });
    const body = (req.body ?? {}) as { start?: unknown; end?: unknown; format?: unknown; quality?: unknown; title?: unknown };
    if (!['mp3', 'm4a', 'wav'].includes(String(body.format))) {
      return reply.code(400).send({ ok: false, error: { code: 'BAD_REQUEST', message: 'format 必须是 mp3|m4a|wav', next: '选择输出格式' } });
    }
    if (typeof body.start !== 'number' || typeof body.end !== 'number' || body.start < 0 || body.end <= body.start) {
      return reply.code(400).send({ ok: false, error: { code: 'BAD_REQUEST', message: '起止时间无效', next: '需满足 0 ≤ start < end' } });
    }
    const video = videosRepo.get(importId);
    if (!video) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: '素材不存在', next: '先下载视频' } });
    if (!existsSync(video.file_path)) {
      return reply.code(404).send({ ok: false, error: { code: 'FILE_MISSING', message: '素材文件已丢失，请重新下载视频', next: '' } });
    }
    const importRow = createImportsRepo(db).get(importId);
    const payload: ClipJobPayload = {
      importId, videoPath: video.file_path, start: body.start, end: body.end,
      format: body.format as 'mp3' | 'm4a' | 'wav',
      quality: typeof body.quality === 'string' ? body.quality : undefined,
      // 前缀默认取来源标题;时间段由服务端拼(spec D8,前端 title 只作前缀)
      title: typeof body.title === 'string' && body.title.trim() !== '' ? body.title : (importRow?.title ?? '剪辑音频'),
      sourceUrl: importRow?.url,
    };
    const jobId = createJobsRepo(db).create('ffmpeg_clip', payload);
    pushLog('info', 'clip', `job ${jobId} created import=${importId} ${body.start}-${body.end}s format=${String(body.format)}`);
    // 不 await(R7,2026-09-30):与音频下载的 job 语义一致——POST 立即 201,前端拿到 jobId 先建 SSE 订阅,
    // 异步剪辑完成后事件才有人收;若 await,done 事件会在无订阅者时发出即丢(emit 找不到连接直接丢弃),前端进度条/完成回调全瞎。
    void startClipJob(jobId, payload, { db, audioDir: deps.audioDir, tempDir: deps.tempDir });
    return reply.code(201).send({ ok: true, jobId });
  });
}
