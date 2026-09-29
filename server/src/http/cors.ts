import type { FastifyInstance } from 'fastify';

/**
 * origin 白名单:仅放行 file://(origin=null) 与 localhost/127.0.0.1/[::1](任意端口)。
 * 收紧理由:server 监听 127.0.0.1 且含 execFile 二进制探测链路,无条件反射任意站点
 * origin 会允许恶意网页读取/改写本地设置;非白名单不下发 access-control-allow-origin。
 * OPTIONS 必须用显式通配路由——Fastify 对无匹配路由的请求先 404,钩子拦不到 preflight(控制器裁决 2026-09-26)。
 */
export function isAllowedOrigin(origin: string): boolean {
  if (origin === 'null') return true; // file://
  return isAllowedLocalOrigin(origin);
}

/**
 * 仅 localhost/127.0.0.1/[::1](不含 null):供 D12 token 豁免判断。
 * file:// 页面(origin=null)必须带 token,故不豁免。
 * 注:new URL('http://[::1]:8000').hostname 返回带方括号的 '[::1]'。
 */
export function isAllowedLocalOrigin(origin: string): boolean {
  try {
    const h = new URL(origin).hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '[::1]';
  } catch {
    return false;
  }
}

export function registerCors(app: FastifyInstance): void {
  app.addHook('onSend', async (req, reply) => {
    const origin = req.headers.origin;
    if (origin) {
      reply.header('vary', 'Origin');
      if (isAllowedOrigin(origin)) {
        reply.header('access-control-allow-origin', origin);
      }
    }
  });
  app.route({
    method: 'OPTIONS',
    url: '/*',
    handler: async (req, reply) => {
      const origin = req.headers.origin;
      reply
        .header('access-control-allow-methods', 'GET,PUT,POST,DELETE,OPTIONS')
        .header('access-control-allow-headers', 'content-type, x-sct-token')
        .header('access-control-max-age', '86400');
      if (origin && isAllowedOrigin(origin)) {
        reply.header('access-control-allow-origin', origin);
      }
      reply.code(204).send();
    },
  });
}
