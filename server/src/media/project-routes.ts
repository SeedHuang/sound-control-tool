// server/src/media/project-routes.ts
// 剪辑工程路由（P4，spec §0.3 剪辑工程）：GET 列表/详情、PUT 全量替换、DELETE 幂等、POST 导出（job）。
import type { FastifyInstance } from 'fastify';
import { existsSync } from 'node:fs';
import type { DB } from '../db/index.js';
import { createImportsRepo } from '../db/repo/imports.js';
import { createClipProjectsRepo } from '../db/repo/clip-projects.js';
import { createJobsRepo } from '../db/repo/jobs.js';
import { createSourceVideosRepo } from '../db/repo/source-videos.js';
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
  const badId = (importId: number): boolean => !Number.isInteger(importId) || importId <= 0;

  app.get('/api/projects', async () => ({ ok: true, projects: projectsRepo.list() }));

  app.get('/api/projects/:importId', async (req, reply) => {
    const importId = Number((req.params as { importId: string }).importId);
    if (badId(importId)) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: '来源不存在', next: '' } });
    if (importsRepo.get(importId) === null) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: '来源不存在', next: '' } });
    return { ok: true, project: projectsRepo.get(importId) }; // 来源在、没工程 → project:null（正常）
  });

  app.put('/api/projects/:importId', async (req, reply) => {
    const importId = Number((req.params as { importId: string }).importId);
    if (badId(importId)) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: '来源不存在', next: '' } });
    if (importsRepo.get(importId) === null) {
      // 评审盲点 P1-11：来源被删后不能只给裸 404——要告诉前端「这条来源已没了」，否则用户反复点保存不知为何失败
      return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: '来源不存在', next: '该来源已被删除，无法保存' } });
    }
    const body = (req.body ?? {}) as { name?: unknown; segments?: unknown };
    const parsed = parseSegments(body.segments);
    if (!parsed.ok) return reply.code(400).send({ ok: false, error: { code: 'BAD_REQUEST', message: parsed.message, next: parsed.next } });
    const existing = projectsRepo.get(importId);
    const name = typeof body.name === 'string'
      ? (body.name.trim() === '' ? null : body.name.trim())
      : (existing?.name ?? null); // 不传 → 更新时保留旧名；首次创建 → null
    const saved = projectsRepo.upsert(importId, name, parsed.segments);
    pushLog('info', 'project', `工程已保存 import=${importId} 段数=${saved.segments.length} name=${name ?? '(无)'}`);
    return { ok: true, project: saved };
  });

  app.delete('/api/projects/:importId', async (req, reply) => {
    const importId = Number((req.params as { importId: string }).importId);
    if (badId(importId)) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: '来源不存在', next: '' } });
    const deleted = projectsRepo.delete(importId); // 不删素材、不删已导出音频
    pushLog('info', 'project', `工程已删除 import=${importId} deleted=${deleted}`);
    return { ok: true, deleted }; // 幂等：不存在 → deleted:0，仍 200
  });

  // 导出（spec D9/D15/D8）：POST 起 job，201 带 jobId；产物由 job 异步入库（sourceType='edit'）。
  // segments 必传（D15：以请求体为准，不读 DB 工程、不自动保存）；mode/format 非法 → 400。
  app.post('/api/projects/:importId/export', async (req, reply) => {
    const importId = Number((req.params as { importId: string }).importId);
    if (badId(importId)) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: '素材不存在', next: '' } });
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
    const video = createSourceVideosRepo(db).get(importId);
    if (!video) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: '素材不存在', next: '先下载视频' } });
    if (!existsSync(video.file_path)) return reply.code(404).send({ ok: false, error: { code: 'FILE_MISSING', message: '素材文件已丢失，请重新下载视频', next: '' } });
    const importRow = importsRepo.get(importId);
    const project = projectsRepo.get(importId);
    const prefix = project?.name ?? importRow?.title ?? '剪辑音频'; // 前缀由服务端定（D9）：工程名 → 无则来源标题
    const payload: ExportJobPayload = {
      importId, videoPath: video.file_path, mode: body.mode, format,
      quality: typeof body.quality === 'string' ? body.quality : undefined, prefix, segments: parsed.segments,
    };
    const jobId = createJobsRepo(db).create('ffmpeg_export', payload);
    pushLog('info', 'job', `export job ${jobId} created import=${importId} mode=${body.mode} 段数=${parsed.segments.length}`);
    // 不 await（同 clip 路由）：201 先回，前端拿 jobId 建 SSE 订阅；异步完成后事件才有人收
    void startExportJob(jobId, payload, { db, audioDir: deps.audioDir, tempDir: deps.tempDir });
    return reply.code(201).send({ ok: true, jobId });
  });
}
