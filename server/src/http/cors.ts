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

/**
 * 媒体类端点(<audio> / <img>)的补充豁免判据(2026-09-29 增补)。
 * 背景:这两类请求由浏览器自己发起,**没有 Origin 头**(no-cors 媒体请求不带),页面也没法给它们加
 * X-SCT-Token 头 → 本地开发裸开浏览器(URL 里没有 apiToken)时,音频播放与作品封面一律 401(实测)。
 * 但媒体请求**会带 Referer(发起它的页面地址)**:本机页面的 Referer 一定是 localhost/127.0.0.1。
 * 安全论证:外部站点无法把 Referer 伪造成 localhost(Referer 由浏览器按发起页面填,JS 改不了),
 * 恶意页面发起的跨源 <img>/<audio> 带的是它自己的地址 → 依旧被拦。故本判据只放行"确实由本机页面发起"的请求。
 */
export function isLocalPageReferer(referer: string | undefined): boolean {
  if (typeof referer !== 'string' || referer.length === 0) return false;
  return isAllowedLocalOrigin(referer.replace(/\/+$/, ''));
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
