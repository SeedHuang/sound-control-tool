// 2026-09-29 抽出:音频与视频两条路由共用一套 Range 语义。
// 为什么必须共用:浏览器拖进度条发 Range 期待 206,声明了 accept-ranges 却永远回 200 全量会把进度条锁死
// (音频那边实测踩过)。复制第二份 = 下次只改一处。
import { createReadStream } from 'node:fs';
import type { FastifyReply, FastifyRequest } from 'fastify';

export function sendFileWithRange(
  req: FastifyRequest,
  reply: FastifyReply,
  opts: { filePath: string; size: number; contentType: string },
): FastifyReply {
  reply
    .header('content-type', opts.contentType)
    .header('content-disposition', 'inline')
    .header('accept-ranges', 'bytes');
  const range = req.headers.range;
  const m = typeof range === 'string' ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
  if (m !== null && ((m[1] ?? '') !== '' || (m[2] ?? '') !== '')) {
    const size = opts.size;
    const startRaw = m[1] ?? '';
    const endRaw = m[2] ?? '';
    const start = startRaw !== '' ? parseInt(startRaw, 10) : 0;
    const end = endRaw !== '' ? Math.min(parseInt(endRaw, 10), size - 1) : size - 1;
    if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= size) {
      reply.header('content-range', `bytes */${size}`);
      return reply.code(416).send();
    }
    reply.code(206).header('content-range', `bytes ${start}-${end}/${size}`).header('content-length', end - start + 1);
    return reply.send(createReadStream(opts.filePath, { start, end }));
  }
  reply.header('content-length', opts.size);
  return reply.send(createReadStream(opts.filePath));
}
