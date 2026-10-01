// server/src/media/project-routes.ts
// 剪辑**作品**路由（2026-10-01 spec clip-works D3/D6/D15）：
//   POST 新建作品 · GET 列表/详情 · PUT 全量替换段 · DELETE（连带成品）· POST 导出（job）。
// ⚠️ 路由参数 `:projectId` 是**作品 id**（clip_projects.id），不再是 import_id —— 两者都是 number，
//    TypeScript 抓不到这种「含义漂移」；改动/审查时必须逐处核对实参来源（见各 handler 注释）。
import type { FastifyInstance } from 'fastify';
import { existsSync, unlinkSync } from 'node:fs';
import type { DB } from '../db/index.js';
import { createImportsRepo } from '../db/repo/imports.js';
import { createClipProjectsRepo } from '../db/repo/clip-projects.js';
import { createJobsRepo } from '../db/repo/jobs.js';
import { createSourceVideosRepo } from '../db/repo/source-videos.js';
import { inTransaction } from '../db/tx.js';
import { pushLog } from '../logs.js';
import { startExportJob, type ExportJobPayload } from './ffmpeg-export.js';

const MAX_SEGMENTS = 50;
const MAX_LABEL_LEN = 100;

interface SegmentBody { start_sec?: unknown; end_sec?: unknown; label?: unknown }
type ParsedSegments = { ok: true; segments: { start_sec: number; end_sec: number; label: string | null }[] }
  | { ok: false; message: string; next: string };

/** segments 校验（PUT 与 export 共用；spec §0.3）：数组；0 ≤ start_sec；end_sec > start_sec；段数 ≤ 50；label 可空且 ≤ 100。
 *  注意：end_sec 允许超素材时长（剪辑室允许先划超长段，导出时 ffmpeg 自然截断），故此处只校验「相对关系」不校验绝对上限。 */
function parseSegments(raw: unknown): ParsedSegments {
  if (!Array.isArray(raw)) return { ok: false, message: 'segments 必须是数组', next: '重新提交剪辑段' };
  if (raw.length > MAX_SEGMENTS) return { ok: false, message: `剪辑段不能超过 ${MAX_SEGMENTS} 个`, next: '减少剪辑段后重试' };
  const out: { start_sec: number; end_sec: number; label: string | null }[] = [];
  for (const item of raw as SegmentBody[]) {
    const s = typeof item?.start_sec === 'number' ? item.start_sec : NaN;
    const e = typeof item?.end_sec === 'number' ? item.end_sec : NaN;
    if (!Number.isFinite(s) || !Number.isFinite(e) || s < 0 || e <= s) {
      return { ok: false, message: '剪辑段起止无效', next: '需满足 0 ≤ start_sec < end_sec' };
    }
    const rawLabel = item.label;
    if (rawLabel !== undefined && rawLabel !== null && typeof rawLabel !== 'string') {
      return { ok: false, message: 'label 必须是字符串', next: '去掉标签或改为文本' };
    }
    const label = typeof rawLabel === 'string' ? rawLabel : null;
    if (label !== null && label.length > MAX_LABEL_LEN) return { ok: false, message: `label 不能超过 ${MAX_LABEL_LEN} 字`, next: '缩短标签' };
    out.push({ start_sec: s, end_sec: e, label });
  }
  return { ok: true, segments: out };
}

export function registerProjectRoutes(
  app: FastifyInstance,
  deps: { db: DB; audioDir: string; tempDir: string; token: string },
): void {
  const { db } = deps;
  const projectsRepo = createClipProjectsRepo(db);
  const importsRepo = createImportsRepo(db);
  const videosRepo = createSourceVideosRepo(db);
  /** 参数是**作品 id**（不是 import_id）——名字刻意叫 projectId，防含义漂移 */
  const badId = (projectId: number): boolean => !Number.isInteger(projectId) || projectId <= 0;

  app.get('/api/projects', async () => ({ ok: true, projects: projectsRepo.list() }));

  // 新建作品（D15）：默认名走 repo.nextName（D23：现存最大序号 + 1）。三道前置校验，每道都带可执行的 next。
  app.post('/api/projects', async (req, reply) => {
    const body = (req.body ?? {}) as { importId?: unknown };
    const importId = typeof body.importId === 'number' ? body.importId : NaN; // 这里的 id 是**资料 id**
    if (badId(importId)) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: '资料不存在', next: '资料不存在，可能已被删除' } });
    const importRow = importsRepo.get(importId);
    if (importRow === null) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: '资料不存在', next: '资料不存在，可能已被删除' } });
    const video = videosRepo.get(importId);
    if (video === null) {
      // 前端只能凭 has_video 判断"可剪"，列不出"素材行在但文件丢了"的资料 → 报错必须自己把话说全（spec §0.4）
      return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: '该资料还没有视频素材', next: '先到资料库下载视频素材' } });
    }
    if (!existsSync(video.file_path)) {
      return reply.code(404).send({ ok: false, error: { code: 'FILE_MISSING', message: '素材文件已丢失，请重新下载视频', next: '回到资料库重新下视频' } });
    }
    const work = projectsRepo.create(importId, projectsRepo.nextName(importId, importRow.title));
    pushLog('info', 'project', `作品已创建 id=${work.id} import=${importId} name=${work.name}`);
    return reply.code(201).send({ ok: true, project: work });
  });

  app.get('/api/projects/:projectId', async (req, reply) => {
    const projectId = Number((req.params as { projectId: string }).projectId); // 作品 id
    if (badId(projectId)) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: '作品不存在', next: '' } });
    const project = projectsRepo.get(projectId);
    if (project === null) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: '作品不存在', next: '' } });
    return { ok: true, project };
  });

  app.put('/api/projects/:projectId', async (req, reply) => {
    const projectId = Number((req.params as { projectId: string }).projectId); // 作品 id
    if (badId(projectId)) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: '作品不存在', next: '' } });
    const existing = projectsRepo.get(projectId);
    if (existing === null) {
      // 作品被删后不能只给裸 404——要告诉前端「这件作品已没了」，否则用户反复点保存不知为何失败
      return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: '作品不存在', next: '该作品已被删除，无法保存' } });
    }
    const body = (req.body ?? {}) as { name?: unknown; segments?: unknown };
    const parsed = parseSegments(body.segments);
    if (!parsed.ok) return reply.code(400).send({ ok: false, error: { code: 'BAD_REQUEST', message: parsed.message, next: parsed.next } });
    const name = typeof body.name === 'string'
      ? (body.name.trim() === '' ? null : body.name.trim())
      : existing.name; // 不传 → 保留旧名（空白串 → null）
    const saved = projectsRepo.update(projectId, name, parsed.segments);
    pushLog('info', 'project', `作品已保存 id=${projectId} 段数=${saved.segments.length} name=${name ?? '(无)'}`);
    return { ok: true, project: saved };
  });

  // 删作品（D6）：连带删它的成品（DB 行 + 磁盘文件）。顺序 = 先读成品路径(行还在才读得到) → 删作品+段
  // → 删成品行 → 最后删磁盘文件。文件删除在事务外，失败只记日志、接口仍 200 —— DB 行删掉就达到用户"删了"的语义（仓库铁律）。
  app.delete('/api/projects/:projectId', async (req, reply) => {
    const projectId = Number((req.params as { projectId: string }).projectId); // 作品 id
    if (badId(projectId)) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: '作品不存在', next: '' } });
    // 1) 先取成品清单：file_path 必须先读出来，成品行一删就查不到了
    const products = db.prepare('SELECT id, file_path FROM audio_items WHERE source_work_id = ?').all(projectId) as Array<{ id: number; file_path: string }>;
    // 2) 作品 + 段 + 成品行三条 DELETE 必须在**同一个事务**里同进同出（D6/D22）：任一步失败整体回滚。
    //    否则会出现「作品行没了、成品行还在」——悬空的 source_work_id + 孤儿文件，正是 D6/D22 要避免的状态。
    //    ⚠️ 不能调用 projectsRepo.delete：它内部自带事务，再套一层就是 node:sqlite 不支持的嵌套事务
    //    （BEGIN 里再 BEGIN 会抛），故这里内联「删段 + 删作品」两条语句（与 repo.delete 逐字一致），与删成品行共用一个事务。
    const { deleted, deletedProducts } = inTransaction(db, () => {
      db.prepare('DELETE FROM clip_segments WHERE project_id = ?').run(projectId);
      const d = Number(db.prepare('DELETE FROM clip_projects WHERE id = ?').run(projectId).changes);
      const dp = Number(db.prepare('DELETE FROM audio_items WHERE source_work_id = ?').run(projectId).changes);
      return { deleted: d, deletedProducts: dp };
    });
    // 3) 磁盘文件删除留在事务**之外**（提交之后再删）：文件 IO 失败不阻断接口（仓库铁律）
    for (const p of products) {
      try {
        unlinkSync(p.file_path);
        pushLog('info', 'project', `作品 ${projectId} 连带删除成品文件 id=${p.id} path=${p.file_path}`);
      } catch (err) {
        // F-c(2026-10-01 OCR 审查):ENOENT = 文件本就不在,属正常态;其它 code(权限/占用等真 IO 失败)本仓也**不刷 error**——
        // 铁律「删磁盘文件失败不让接口失败」:DB 行删掉就达到用户"删了"的语义,单点磁盘抖动不该刷 error 级。
        // 本仓日志无 warn 级,故非 ENOENT 仍用 info,但加显眼前缀,便于在日志页里一眼区分真·IO 失败与"文件本就不在"。
        const code = (err as NodeJS.ErrnoException).code ?? '?';
        const prefix = code === 'ENOENT' ? '成品文件删除跳过' : '成品文件删除失败(非 ENOENT)';
        pushLog('info', 'project', `作品 ${projectId} ${prefix} id=${p.id} code=${code} path=${p.file_path} (DB 行已删)`);
      }
    }
    pushLog('info', 'project', `作品已删除 id=${projectId} deleted=${deleted} deleted_products=${deletedProducts}`);
    return { ok: true, deleted, deleted_products: deletedProducts }; // 幂等：不存在 → deleted:0 / deleted_products:0，仍 200
  });

  // 导出（spec D9/D15/D22）：POST 起 job，201 带 jobId；产物由 job 异步入库（sourceType='edit'，挂作品 D4）。
  // segments 必传（D15：以请求体为准，不读 DB 作品、不自动保存）；mode/format 非法 → 400。
  app.post('/api/projects/:projectId/export', async (req, reply) => {
    const projectId = Number((req.params as { projectId: string }).projectId); // 作品 id
    if (badId(projectId)) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: '作品不存在', next: '' } });
    const project = projectsRepo.get(projectId);
    if (project === null) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: '作品不存在', next: '' } });
    const body = (req.body ?? {}) as { mode?: unknown; format?: unknown; quality?: unknown; segments?: unknown };
    if (body.mode !== 'separate' && body.mode !== 'merge') {
      return reply.code(400).send({ ok: false, error: { code: 'BAD_REQUEST', message: 'mode 只能是 separate 或 merge', next: '选择导出方式' } });
    }
    if (!['mp3', 'm4a', 'wav'].includes(String(body.format))) {
      return reply.code(400).send({ ok: false, error: { code: 'BAD_REQUEST', message: 'format 必须是 mp3|m4a|wav', next: '选择输出格式' } });
    }
    // 注意：`String(body.format)` 校验不会收窄 body.format 的类型（仍是 unknown），显式收敛成白名单联合供 payload 使用
    const format = String(body.format) as 'mp3' | 'm4a' | 'wav';
    const parsed = parseSegments(body.segments); // D15：segments 必传，导出以请求体为准
    if (!parsed.ok) return reply.code(400).send({ ok: false, error: { code: 'BAD_REQUEST', message: parsed.message, next: parsed.next } });
    if (parsed.segments.length === 0) return reply.code(400).send({ ok: false, error: { code: 'BAD_REQUEST', message: '没有可导出的剪辑段', next: '先添加剪辑段' } });
    // 视频素材与标题回退都靠作品的 import_id（成品归属才是作品，见 D4/D5）
    const importId = project.import_id;
    const video = videosRepo.get(importId);
    if (!video) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: '素材不存在', next: '先下载视频' } });
    if (!existsSync(video.file_path)) return reply.code(404).send({ ok: false, error: { code: 'FILE_MISSING', message: '素材文件已丢失，请重新下载视频', next: '' } });
    const importRow = importsRepo.get(importId);
    const prefix = project.name ?? importRow?.title ?? '剪辑音频'; // 前缀由服务端定（D9）：作品名 → 无则资料标题
    const payload: ExportJobPayload = {
      importId, videoPath: video.file_path, mode: body.mode, format,
      quality: typeof body.quality === 'string' ? body.quality : undefined, prefix, segments: parsed.segments,
      projectId, workName: project.name, // D19：任务抽屉优先显示作品名
    };
    const jobId = createJobsRepo(db).create('ffmpeg_export', payload);
    pushLog('info', 'job', `export job ${jobId} created project=${projectId} import=${importId} mode=${body.mode} 段数=${parsed.segments.length}`);
    // 不 await（同 clip 路由）：201 先回，前端拿 jobId 建 SSE 订阅；异步完成后事件才有人收
    void startExportJob(jobId, payload, { db, audioDir: deps.audioDir, tempDir: deps.tempDir });
    return reply.code(201).send({ ok: true, jobId });
  });
}
