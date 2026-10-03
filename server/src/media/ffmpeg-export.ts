// 导出任务(spec D9/D15/D8):separate 每段一条成品入库;merge concat 成一条。
// 2026-10-02 spec video-export:mediaKind 分流——audio(mp3/m4a/wav,重编码)/video(mp4/H.264,separate 逐段编码、
//   merge 两阶段=逐段同参编码→concat demuxer -c copy),取消守卫 cancelGuard 两分支都走,视频编码 timeoutMs=1h。
// 与 clip-job.ts 同族:产物走 ingestDownloadedFile + sourceType='edit'(D8),标题由后端强制拼(前端传的 label/title 不作前缀)。
// 2026-10-01 spec clip-works:成品挂作品(D4)、payload 带作品名(D19)、入库前校验作品仍在(D22)。
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DB } from '../db/index.js';
import { createAudioItemsRepo } from '../db/repo/audio-items.js';
import { createClipProjectsRepo } from '../db/repo/clip-projects.js';
import { createJobsRepo } from '../db/repo/jobs.js';
import { runClip, runFfmpegArgs } from '../ffmpeg/clip.js';
import { buildMergeArgs, buildVideoClipArgs, buildVideoConcatArgs, crfOf } from '../ffmpeg/export-args.js';
import { pushLog } from '../logs.js';
import { resolveOutputDir } from '../output-dir.js';
import { emit } from '../ytdlp/job-events.js';
import { probeDuration, probeVideoMeta } from '../ytdlp/ffprobe.js';
import { ingestDownloadedFile } from '../ytdlp/ingest.js';
import { formatClipTitle } from './clip-job.js';
import { resolveFfmpegPath } from './ffmpeg-path.js';

export interface ExportSegment { start_sec: number; end_sec: number; label?: string | null }
export interface ExportJobPayload {
  importId: number; videoPath: string; mode: 'separate' | 'merge';
  // F9③(2026-10-04):联合补 'mp4' —— 视频导出运行时 format 就是 'mp4',旧声明是「类型说谎」,
  // 代价是调用处 3 处强转(测试里 as unknown as 彻底绕过类型检查);音频合法性仍由路由白名单保证(runClip/buildMergeArgs 只收音频联合)。
  format: 'mp3' | 'm4a' | 'wav' | 'mp4'; quality?: string; prefix: string; segments: ExportSegment[];
  /** 2026-10-01 spec clip-works D4：成品归属的作品 id（写入 audio_items.source_work_id） */
  projectId: number;
  /** 2026-10-01 spec clip-works D19：任务抽屉优先显示的作品名；无命名 → null */
  workName: string | null;
  /** 2026-10-02 spec video-export D2：导出内容类型；缺省 'audio'（老 payload 重试兼容，读取处一律 ==='video' 判断） */
  mediaKind?: 'audio' | 'video';
  /** 2026-10-02 spec video-export D3：纯视频（-an，不带音轨）；仅 mediaKind='video' 有意义 */
  videoAn?: boolean;
}
/** merge 的标题:前缀 [共N段](spec §0.3) */
export function formatMergeTitle(prefix: string, count: number): string { return `${prefix} [共${count}段]`; }
// 取 stderr 最后一行截 200 字符:ffmpeg 的报错常在末行,缺则显式标"无 stderr"(仓库铁律:退出码 0 ≠ 有产物,失败要能解释)
const tail = (s: string): string => s.trim().split('\n').slice(-1)[0]?.slice(0, 200) || '(ffmpeg 无 stderr 输出)';
// 由 ffmpeg 路径推 ffprobe 路径(同 fpath 命名:ffmpeg(.exe) → ffprobe(.exe))
const ffprobePathFrom = (ffmpegPath: string): string => ffmpegPath.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1');
// 尽力删除:清理是收尾动作,文件不存在(成功入库已被 ingest rename 走)或被占用都不该让导出失败——
// 与仓库「删除/写入接口的 IO 失败不让接口失败」同口径。全文件清理点统一走它,避免十几处 try/catch 各自漂移。
const rmQuiet = (p: string): void => { try { rmSync(p, { force: true }); } catch { /* 尽力清理 */ } };

export async function startExportJob(jobId: number, payload: ExportJobPayload, deps: { db: DB; audioDir: string; tempDir: string }): Promise<void> {
  const jobsRepo = createJobsRepo(deps.db);
  const projectsRepo = createClipProjectsRepo(deps.db);
  jobsRepo.update(jobId, { status: 'running' });
  // 失败收敛:置 error + 日志 + SSE 终态(一次写完,避免逐处漂移)——source 用 'job'(导出是 job 语义)。
  // H2(2026-10-01 OCR 审查):已取消的任务不得被后续失败覆写成 error——取消是用户的终态意图,
  // ffmpeg 失败只留日志;否则记录里「用户取消了」会变成「任务失败」,误导排障。
  const fail = (msg: string): void => {
    if (jobsRepo.get(jobId)?.status === 'cancelled') {
      pushLog('info', 'job', `export job ${jobId} 已取消，忽略后续失败: ${msg}`);
      return;
    }
    jobsRepo.fail(jobId, msg);
    pushLog('error', 'job', `export job ${jobId} 失败: ${msg}`);
    emit(jobId, { type: 'status', state: 'error', message: msg });
  };
  // H2:取消收敛守卫——取消路由杀不了正在跑的 ffmpeg(它不在任何进程登记表里),跑完后若照旧入库 + finish(),
  // cancelled 会被覆写成 done、用户明确不要的产物还会进库。故每个 await 之后、入库之前查一次:
  // 已取消 → 丢弃临时产物 + 留痕,返回 true 让调用方收尾(维持 cancelled 终态,不再 emit——终态事件取消路由已发过)。
  // 修复轮 1(2026-10-02 独立审查 Important):separate 逐段 ingest,取消落在第 k 段时前 k-1 段已成品入库,
  // 且 cancelled 不可重试——这些段永久保留。处置取「保留 + 诚实」:不回滚(回滚=白扔已花的编码时间,
  // 且引入取消路径上删行删文件的新风险),把保留事实写进 job message。
  // OCR R3(2026-10-03) 勘误:这条 message 目前**没有 UI 出口**——GET /api/jobs 只回 pending/running
  // (cancelled 不在内),SSE 终态事件由取消路由先发(发的时候还不知道 kept 数)。保留事实当前可见渠道:
  // 日志页(pushLog)与作品成品列表本身。message 仍写入 DB:语义正确、无害,供未来任务历史 UI 使用。
  // kept=当时已入库段数:separate 传 produced.length;merge(或首段前取消)传 0 → 不改 message,
  // 维持取消路由写的「用户取消」,不打「已保留 0 段」这种没信息量的话。
  const cancelGuard = (tmp: string, kept: number): boolean => {
    if (jobsRepo.get(jobId)?.status !== 'cancelled') return false;
    rmQuiet(tmp);
    if (kept > 0) {
      // 只改 message 不动 status:repo.update 只传 message 时不碰 status/finished_at;
      // 不得用 finish/fail——它们会覆写 status(正是 H2 修掉的坑)
      const msg = `已取消：前 ${kept} 段成品已保留，可在作品成品列表查看或删除`;
      jobsRepo.update(jobId, { message: msg });
      pushLog('info', 'job', `取消导出 job=${jobId} 保留段数=${kept}`);
    } else {
      pushLog('info', 'job', `export job ${jobId} 用户已取消 → 丢弃产物,维持 cancelled`);
    }
    return true;
  };
  // D22:导出是异步长任务(几十秒到几分钟),用户完全可能中途删掉作品 → 入库前必须重查,
  // 否则会写出一条指向已删作品的成品(悬空行 + 白占一份文件)。丢弃产物 + 置 error + 记日志。
  const discardIfWorkGone = (tmp: string): boolean => {
    if (projectsRepo.get(payload.projectId) !== null) return false;
    rmQuiet(tmp);
    fail('作品已被删除，产物已丢弃');
    return true;
  };
  try {
    // 素材绝对路径已不在 → 明确失败(不静默;retry 路径也据此拦,见 ytdlp-routes)
    if (!existsSync(payload.videoPath)) { fail('素材已不存在，请重新下载视频'); return; }
    if (payload.segments.length === 0) { fail('没有可导出的剪辑段'); return; }
    const ffmpegPath = await resolveFfmpegPath(deps.db);
    if (ffmpegPath === null) { fail('ffmpeg 未找到或未配置：请到设置页配置 ffmpeg 路径'); return; }
    const ffprobePath = ffprobePathFrom(ffmpegPath);
    // 目标目录**每次运行时现读设置**（spec D1/D3/D11）：payload 是「重试用」的，
    // 用户改了目录再重试就该用新目录——把目录塞进 payload 会把旧目录钉死在任务里。
    const outputDir = resolveOutputDir(deps.db, deps.audioDir);
    try {
      mkdirSync(outputDir, { recursive: true }); // 运行时自愈：手删了文件夹不必回设置页改
    } catch (e) {
      fail(`导出目录不可用：${outputDir}（${e instanceof Error ? e.message : String(e)}）`);
      return;
    }
    pushLog('info', 'job', `export job ${jobId} 目标目录 ${outputDir}`);
    const audioRepo = createAudioItemsRepo(deps.db);
    // 音频分支的 format 收敛(F9③):payload.format 联合含 'mp4'(视频专用),音频侧收敛回三选一。
    // 依据:mediaKind!=='video' 时路由白名单只放行 mp3/m4a/wav(project-routes 校验,否则 400)。
    // 必须在 ingest 之前算好——ingest 的入库 format/落盘扩展名(ingest.ts)与编码 format 必须是同一个值,
    // 否则脏 payload(mediaKind!=video 且 format=mp4)会「按 mp3 编码、按 mp4 入库」产生错配产物。
    const audioFormat: 'mp3' | 'm4a' | 'wav' = payload.format === 'mp4' ? 'mp3' : payload.format;
    // 统一的入库入口:sourceType='edit'(D8)——导出产物是「剪辑」而非「下载」。
    // N1 Task 3(spec video-export):kind=video 时 format 固定 'mp4'(payload.format 由路由层保证,
    // 防御性忽略其它值——分支入口记日志不中断),media_kind/width/height 随视频元数据透传;
    // 音频调用处签名不变(第四参不传 → 'audio'/null/null,老路径零回归)。
    const ingest = (tmp: string, title: string, durationSec: number | null, videoMeta?: { width: number | null; height: number | null }): number => {
      const isVideo = payload.mediaKind === 'video';
      const audioId = ingestDownloadedFile({
        tmpPath: tmp, title, format: isVideo ? 'mp4' : audioFormat, durationSec,
        fileSize: statSync(tmp).size, sourceUrl: '', entryIndex: null, collectionTitle: null,
        sourceType: 'edit',
        sourceImportId: payload.importId, // Spec A 的冗余列,继续写(权威是作品 D5)
        sourceWorkId: payload.projectId,   // 2026-10-01 spec clip-works D4:成品挂作品
        mediaKind: isVideo ? 'video' : 'audio',
        width: videoMeta?.width ?? null, height: videoMeta?.height ?? null,
        audioDir: outputDir, exists: existsSync, audioRepo,
      }).audioId;
      pushLog('info', 'job', `export job ${jobId} 入库 audio=${audioId} source_import_id=${payload.importId} source_work_id=${payload.projectId}`);
      return audioId;
    };

    // ===== 2026-10-02 spec video-export(N1 Task 3):视频分支 =====
    // 位置:必须在音频分支之前——视频 payload 的 mode 也是 'separate'/'merge',若排在音频判断后面会先掉进音频分支。
    // kind=video:format 固定按 'mp4'(payload.format 由路由层保证,防御性忽略其它值——记日志不中断);
    // 编码参数/超时/拼接方式全部按 plan 实测参数表(A1-A5),不自由发挥。
    if (payload.mediaKind === 'video') {
      // 防御检查按运行时值(payload 是 DB JSON 反序列化产物,类型窄不等于运行时值受保证)
      if (payload.format !== 'mp4') pushLog('info', 'job', `export job ${jobId} kind=video format=${payload.format} 非 mp4 → 防御性按 mp4 处理`);
      const crf = crfOf(payload.quality);       // high→20、mid/缺省→23、low→28(实测 A4)
      const an = payload.videoAn === true;      // 缺省 false(带音轨),只有显式 true 才 -an(实测 A3)
      pushLog('info', 'job', `export job ${jobId} kind=video mode=${payload.mode} crf=${crf} an=${an} 段数=${payload.segments.length}`);
      if (payload.mode === 'separate') {
        const produced: number[] = [];
        // F9①(2026-10-04):逐段临时产物登记进 tmpPaths,统一由 finally 清理——与视频 merge 分支(下方)对齐。
        // 入库(rename EBUSY 等)/DB 抛错会绕过下面各显式失败分支直达外层 catch,残留 mp4 段在 temp 躺到下次重启;
        // 成功入库的段已被 ingest rename 走,rmQuiet 是无害空操作。
        const tmpPaths: string[] = [];
        try {
          for (let i = 0; i < payload.segments.length; i++) {
            const seg = payload.segments[i]!;
            // 临时产物名唯一(spec D14 同族):固定名字会被并发任务互相覆盖
            const tmp = join(deps.tempDir, `export-${jobId}-${i}-${Date.now()}.mp4`);
            tmpPaths.push(tmp);
            const r = await runFfmpegArgs({ ffmpegPath, args: buildVideoClipArgs({ inputPath: payload.videoPath, outPath: tmp, start: seg.start_sec, end: seg.end_sec, crf, an }), outPath: tmp, timeoutMs: 3_600_000, jobId }); // 4K 实测:默认 120s 不够
            if (!r.ok) { rmQuiet(tmp); fail(`导出第 ${i + 1} 段失败：${tail(r.stderr)}`); return; }
            const title = formatClipTitle(payload.prefix, seg.start_sec, seg.end_sec); // 前端传的 label/title 不作前缀（后端强制拼）
            const dur = await probeDuration(ffprobePath, tmp);
            const meta = await probeVideoMeta(ffprobePath, tmp); // 宽高入库(探测失败 → null,按未知处理不失败)
            pushLog('info', 'job', `export job ${jobId} 第 ${i + 1}/${payload.segments.length} 段请求 ${seg.start_sec}-${seg.end_sec}s，实测 ${dur ?? '?'}s ${meta.width ?? '?'}x${meta.height ?? '?'}`);
            if (cancelGuard(tmp, produced.length)) return; // H2:已取消 → 丢弃本段,维持 cancelled;kept=已入库段数,message 写明保留事实
            if (discardIfWorkGone(tmp)) return; // D22:逐段入库前校验(作品没了就丢弃这一段)
            produced.push(ingest(tmp, title, dur, meta));
            emit(jobId, { type: 'progress', percent: Math.round(((i + 1) / payload.segments.length) * 100) });
          }
          jobsRepo.finish(jobId);
          pushLog('info', 'job', `export job ${jobId} done mode=separate kind=video → ${produced.length} 条`);
          emit(jobId, { type: 'done', kind: 'video', audioId: produced[0]!, title: `${payload.prefix}（共 ${produced.length} 段）`, format: 'mp4', replaced: false, count: produced.length });
        } finally {
          for (const p of tmpPaths) rmQuiet(p);
        }
        return;
      }

      // merge 视频两阶段(实测 A5:逐段同参编码 → concat demuxer -c copy 0.46s,vs 重编码 42.89s,93 倍):
      // 阶段一逐段编码 export-<jobId>-m<i>-<ts>.mp4(同 crf/an);全部成功后写 concat 列表文件
      // (每行 file 'C:/xxx/seg.mp4',路径统一正斜杠——Windows 反斜杠在 concat demuxer 里是转义符),
      // 阶段二 -f concat -safe 0 -c copy 拼一条。每阶段之间都过 cancelGuard;任一段失败 → fail + 已产段清理。
      // 列表文件与中间段用后删(成功/失败/取消路径统一走 finally——成功时最终产物已被 ingest rename 走)。
      const segPaths: string[] = [];
      let listPath: string | null = null;
      // OCR R1(2026-10-03) medium:合并成品也要进 finally 清理——ingest(rename EBUSY 等)/DB 抛错会绕过
      // 下面各显式失败分支直达外层 catch,多 GB 中间成品不能在 temp 躺到下次重启 cleanOrphans;
      // 成功路径产物已被 ingest rename 走,rmQuiet 是无害空操作。
      let mergedTmp: string | null = null;
      try {
        for (let i = 0; i < payload.segments.length; i++) {
          const seg = payload.segments[i]!;
          const tmp = join(deps.tempDir, `export-${jobId}-m${i}-${Date.now()}.mp4`);
          const r = await runFfmpegArgs({ ffmpegPath, args: buildVideoClipArgs({ inputPath: payload.videoPath, outPath: tmp, start: seg.start_sec, end: seg.end_sec, crf, an }), outPath: tmp, timeoutMs: 3_600_000, jobId });
          if (!r.ok) { rmQuiet(tmp); fail(`导出第 ${i + 1} 段失败：${tail(r.stderr)}`); return; }
          if (cancelGuard(tmp, 0)) return; // H2:merge 无已入库段,kept=0 不写保留话术
          pushLog('info', 'job', `export job ${jobId} 第 ${i + 1}/${payload.segments.length} 段编码完成 crf=${crf} an=${an}`);
          segPaths.push(tmp);
        }
        listPath = join(deps.tempDir, `export-${jobId}-concat-${Date.now()}.txt`);
        // OCR 43c032a 复审 F4:列表条目按 concat demuxer 引号规则转义内嵌单引号(Windows 用户名如 O'Brien
        // 会让 tempDir 带撇号,不转义会把 file '...' 条目截断成畸形);正斜杠 + 单引号包裹;utf8 无 BOM
        const concatQuote = (p: string): string => p.replace(/\\/g, '/').replace(/'/g, "'\\''");
        writeFileSync(listPath, segPaths.map((p) => `file '${concatQuote(p)}'`).join('\n') + '\n', 'utf8');
        pushLog('info', 'job', `export job ${jobId} concat 列表就绪 ${listPath}(${segPaths.length} 段)`);
        const tmpOut = join(deps.tempDir, `export-${jobId}-merge-${Date.now()}.mp4`);
        mergedTmp = tmpOut;
        // OCR 43c032a 复审 F5:concat -c copy 也要读写整段体量,慢盘上默认 120s 不够 —— 与逐段编码同为 1h
        const r = await runFfmpegArgs({ ffmpegPath, args: buildVideoConcatArgs({ listPath, outPath: tmpOut }), outPath: tmpOut, timeoutMs: 3_600_000, jobId });
        if (!r.ok) { rmQuiet(tmpOut); fail(`合并导出失败：${tail(r.stderr)}`); return; }
        const title = formatMergeTitle(payload.prefix, payload.segments.length);
        const dur = await probeDuration(ffprobePath, tmpOut);
        const meta = await probeVideoMeta(ffprobePath, tmpOut);
        pushLog('info', 'job', `export job ${jobId} concat 完成 实测 ${dur ?? '?'}s ${meta.width ?? '?'}x${meta.height ?? '?'}`);
        if (cancelGuard(tmpOut, 0)) return; // H2:已取消 → 丢弃产物,维持 cancelled
        if (discardIfWorkGone(tmpOut)) return; // D22:合并产物入库前校验一次
        const audioId = ingest(tmpOut, title, dur, meta);
        jobsRepo.finish(jobId);
        pushLog('info', 'job', `export job ${jobId} done mode=merge kind=video → audio ${audioId} @ ${title}`);
        emit(jobId, { type: 'done', kind: 'video', audioId, title, format: 'mp4', replaced: false, count: 1 });
      } finally {
        // 过程文件清理:中间段(finally 里只清已编码成功的段;失败段自身在其分支已删)+ concat 列表文件
        // + 合并成品(OCR R1:仅异常路径残留;成功时已被 ingest rename 走,rmQuiet 为无害空操作)。
        for (const p of segPaths) rmQuiet(p);
        if (listPath !== null) rmQuiet(listPath);
        if (mergedTmp !== null) rmQuiet(mergedTmp);
      }
      return;
    }

    // ===== 音频分支 =====
    // 音频 format 已在上面(ingest 之前)收敛为 audioFormat;这里只补一条运行时防御日志。
    // 运行时若真见 'mp4'(脏 payload,路由白名单本应挡住)→ 记日志并按 mp3 兜底,与视频分支「格式不符只记日志不中断」同口径。
    if (payload.format === 'mp4') pushLog('info', 'job', `export job ${jobId} kind=audio format=mp4 非法 → 防御性按 mp3 处理`);

    if (payload.mode === 'separate') {
      const produced: number[] = [];
      // F9①:逐段临时产物登记,统一 finally 清理(理由同视频 separate 分支)
      const tmpPaths: string[] = [];
      try {
        for (let i = 0; i < payload.segments.length; i++) {
          const seg = payload.segments[i]!;
          // 临时产物名唯一(spec D14 同族):固定名字会被并发任务互相覆盖
          const tmp = join(deps.tempDir, `export-${jobId}-${i}-${Date.now()}.${audioFormat}`);
          tmpPaths.push(tmp);
          const r = await runClip({ ffmpegPath, inputPath: payload.videoPath, outPath: tmp, start: seg.start_sec, end: seg.end_sec, format: audioFormat, quality: payload.quality, jobId });
          if (!r.ok) { rmQuiet(tmp); fail(`导出第 ${i + 1} 段失败：${tail(r.stderr)}`); return; }
          const title = formatClipTitle(payload.prefix, seg.start_sec, seg.end_sec); // 前端传的 label/title 不作前缀（后端强制拼）
          const dur = await probeDuration(ffprobePath, tmp);
          pushLog('info', 'job', `export job ${jobId} 第 ${i + 1}/${payload.segments.length} 段请求 ${seg.start_sec}-${seg.end_sec}s，实测 ${dur ?? '?'}s`);
          if (cancelGuard(tmp, produced.length)) return; // H2:已取消 → 丢弃本段,维持 cancelled;kept=已入库段数,message 写明保留事实
          if (discardIfWorkGone(tmp)) return; // D22:逐段入库前校验(作品没了就丢弃这一段)
          produced.push(ingest(tmp, title, dur));
          emit(jobId, { type: 'progress', percent: Math.round(((i + 1) / payload.segments.length) * 100) });
        }
        jobsRepo.finish(jobId);
        pushLog('info', 'job', `export job ${jobId} done mode=separate → ${produced.length} 条音频`);
        // C-2:emit 在 done 后断连,故只发一次终态,用 count 带出总段数(前端提示「已导出 N 段」)
        emit(jobId, { type: 'done', kind: 'audio', audioId: produced[0]!, title: `${payload.prefix}（共 ${produced.length} 段）`, format: audioFormat, replaced: false, count: produced.length });
      } finally {
        for (const p of tmpPaths) rmQuiet(p);
      }
      return;
    }

    // merge
    const tmp = join(deps.tempDir, `export-${jobId}-merge-${Date.now()}.${audioFormat}`);
    try {
      const args = buildMergeArgs({ inputPath: payload.videoPath, outPath: tmp, format: audioFormat, quality: payload.quality, segments: payload.segments });
      const r = await runFfmpegArgs({ ffmpegPath, args, outPath: tmp, jobId });
      if (!r.ok) { rmQuiet(tmp); fail(`合并导出失败：${tail(r.stderr)}`); return; }
      const title = formatMergeTitle(payload.prefix, payload.segments.length);
      const dur = await probeDuration(ffprobePath, tmp);
      if (cancelGuard(tmp, 0)) return; // H2:已取消 → 丢弃产物,维持 cancelled;merge 无已入库段,kept=0 不写保留话术
      if (discardIfWorkGone(tmp)) return; // D22:合并产物入库前校验一次
      const audioId = ingest(tmp, title, dur);
      jobsRepo.finish(jobId);
      pushLog('info', 'job', `export job ${jobId} done mode=merge → audio ${audioId} @ ${title}`);
      emit(jobId, { type: 'done', kind: 'audio', audioId, title, format: audioFormat, replaced: false, count: 1 });
    } finally {
      // F9①(2026-10-04):合并成品入库(rename EBUSY 等)/DB 抛错会绕过上面的显式失败分支直达外层 catch,
      // 残留文件不能在 temp 躺到下次重启;成功时已被 ingest rename 走,rmQuiet 是无害空操作
      rmQuiet(tmp);
    }
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}
