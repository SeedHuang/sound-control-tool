// server/src/covers.ts(2026-09-29 新增:作品封面抓取与落盘)
// 用途:剪辑室「剧集分组」视图要显示作品封面(B 站/YouTube 的番剧封面)。
// 设计:
// 1. 封面属于「作品」(imported_sources 一行),一个作品一张图,落盘到 <数据目录>/covers/cover-<来源id>.<ext>
// 2. 抓取是 best-effort:任何失败只记日志,返回 false——解析/看图都不因为它失败(前端回退纯色卡片)
// 3. 两条抓法,按可靠性排序:
//    ① fetchAndStoreCover:自己用 fetch 抓(带 Referer 过 B 站防盗链)。国内图床 0.3s 就下来,最快
//    ② writeCoverViaYtdlp:让 yt-dlp 自己写(--write-thumbnail)。
//       **外网图床只能走这条**——Node 内置 fetch 不读 Windows 系统代理,直连 i.ytimg.com 会 10s 超时;
//       yt-dlp(Python)走系统代理,同一张图 130ms 拿到(2026-09-29 实测)
// 4. 触发时机两处:解析成功后台预热一次(不 await,不拖慢解析);看分组视图时本地还没有就现拿(兜底自愈)
import { execFile } from 'node:child_process';
import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pushLog } from './logs.js';
import { buildWriteThumbnailArgs } from './ytdlp/args.js';

/** 可注入的 execFile(默认真跑 yt-dlp;单测注入桩,避免真拉进程) */
export type ExecLike = typeof execFile;

/** 可注入的 fetch(默认全局 fetch)——单测注入桩,避免真发网络(同 parse.ts 的 doExec 套路) */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** 封面文件名前缀:按来源 id 定位,扩展名由实际图片格式决定 */
function prefixOf(importId: number): string { return `cover-${importId}.`; }

// 抓图的上限与超时(原先散在代码里的魔法数字,提到一处便于对照)
const COVER_FETCH_TIMEOUT_MS = 10_000;   // 自己 fetch:抓张图不该拖住任何调用方
const COVER_YTDLP_TIMEOUT_MS = 30_000;   // yt-dlp 要起进程 + 走系统代理,给宽一点
const COVER_YTDLP_MAX_BUFFER = 4 * 1024 * 1024;
const MAX_COVER_BYTES = 8 * 1024 * 1024; // 封面图远小于此;超了就是异常响应(反爬页/错误页),整块读进内存会把主进程撑爆

/** 已落盘的封面文件绝对路径;没有(或目录不存在)→ null */
export function findCoverFile(coversDir: string, importId: number): string | null {
  try {
    const hit = readdirSync(coversDir).find((f) => f.startsWith(prefixOf(importId)));
    return hit === undefined ? null : join(coversDir, hit);
  } catch {
    return null; // 目录还没建过(没抓过任何封面)——不算错
  }
}

/**
 * 一次读目录,返回「哪些来源已经有本地封面」的集合。
 * 列表接口(/api/imports)要为每个来源判一次有没有图——逐个调 findCoverFile 就是 O(来源数 × 封面文件数) 的重复扫描。
 */
export function listCoverImportIds(coversDir: string): Set<number> {
  const ids = new Set<number>();
  let names: string[];
  try {
    names = readdirSync(coversDir);
  } catch {
    return ids; // 目录不存在 = 一张都没有
  }
  for (const f of names) {
    const m = /^cover-(\d+)\./.exec(f);
    if (m !== null) ids.add(Number(m[1]));
  }
  return ids;
}

/** 清掉某来源的**其它扩展名**封面,只留 keep 这个(换图/换格式后避免 findCoverFile 随机命中旧图) */
function removeOtherCovers(coversDir: string, importId: number, keep: string): void {
  let names: string[];
  try {
    names = readdirSync(coversDir);
  } catch {
    return; // 目录读不到:没有旧图要清
  }
  for (const f of names) {
    const full = join(coversDir, f);
    if (f.startsWith(prefixOf(importId)) && full !== keep) {
      try { unlinkSync(full); } catch { /* 清旧图失败不影响本次结果 */ }
    }
  }
}

/** 扩展名 ↔ MIME(落盘与回传 Content-Type 共用一张表,避免两处各写一份) */
const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
};
const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
};

/** 按落盘文件名给 Content-Type;认不出回退 image/jpeg */
export function coverMime(filePath: string): string {
  const ext = filePath.slice(filePath.lastIndexOf('.') + 1).toLowerCase();
  return MIME_BY_EXT[ext] ?? 'image/jpeg';
}

/** 只允许 http/https:元数据里的封面地址正常都是 https,挡掉 file:/data: 之类的意外值 */
function parseHttpUrl(url: string): URL | null {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null;
  } catch {
    return null;
  }
}

/**
 * 该主机是否属于「本机/内网」——命中就别去请求(SSRF 防护)。
 * 为什么必须挡:封面地址来自远端元数据(yt-dlp 解析出的 thumbnail),**源页面自己可以指定它**。
 * 不挡的话,一个恶意来源把缩略图指向 http://127.0.0.1:7310/api/logs,服务端就会替它去取本机接口,
 * 再把响应存成封面、经由 /api/imports/:id/cover 交回——等于拿这台机器当跳板探内网。
 */
function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, ''); // IPv6 字面量在 URL 里带方括号
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h === '::1' || h === '0.0.0.0') return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m !== null) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    return a === 0 || a === 127 // 本机
      || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) // RFC1918 内网
      || (a === 169 && b === 254); // 链路本地(含云厂商元数据 169.254.169.254)
  }
  return /^f[cd][0-9a-f]{2}:/i.test(h) // IPv6 fc00::/7 唯一本地
    || /^fe[89ab][0-9a-f]?:/i.test(h); // IPv6 fe80::/10 链路本地
}

/**
 * 抓一张封面并落盘。返回是否成功;失败只记日志,不抛。
 * @param opts.doFetch 注入用(默认全局 fetch);超时 10s——抓张图不该拖住任何调用方
 */
export async function fetchAndStoreCover(opts: {
  url: string; coversDir: string; importId: number; doFetch?: FetchLike;
}): Promise<boolean> {
  const doFetch = opts.doFetch ?? fetch;
  const target = parseHttpUrl(opts.url);
  if (target === null) {
    pushLog('error', 'cover', `封面地址不是 http(s)，跳过 id=${opts.importId} url=${opts.url}`);
    return false;
  }
  if (isBlockedHost(target.hostname)) {
    pushLog('error', 'cover', `封面地址指向本机/内网，跳过 id=${opts.importId} url=${opts.url}`);
    return false;
  }
  try {
    const res = await doFetch(opts.url, {
      headers: {
        // B 站防盗链:不带 Referer 会拿到 403;UA 也带上(少数图床按 UA 拦)
        referer: 'https://www.bilibili.com/',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) sound-control-tool/0.0',
      },
      signal: AbortSignal.timeout(COVER_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      pushLog('error', 'cover', `抓封面失败 id=${opts.importId} status=${res.status} url=${opts.url}`);
      return false;
    }
    const mime = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    // 只收图片:反爬页/错误页常以 200 + text/html 回来,那种体存下来会变成一张**永久**坏图 ——
    // 一旦落盘,findCoverFile 第一步就命中,下面的重试/换 yt-dlp 路径再也不会跑。
    // content-type 缺失('')仍按 jpg 容错(少数图床不给这个头)。
    if (mime !== '' && !mime.startsWith('image/')) {
      pushLog('error', 'cover', `抓封面失败 id=${opts.importId} 响应不是图片 content-type=${mime} url=${opts.url}`);
      return false;
    }
    const declared = Number(res.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > MAX_COVER_BYTES) {
      pushLog('error', 'cover', `抓封面失败 id=${opts.importId} 声明体积过大 bytes=${declared} url=${opts.url}`);
      return false;
    }
    const ext = EXT_BY_MIME[mime] ?? 'jpg'; // 认不出的 MIME → 按 jpg 落盘(浏览器能容错识别)
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.byteLength === 0) {
      pushLog('error', 'cover', `抓封面失败 id=${opts.importId} 响应体为空 url=${opts.url}`);
      return false;
    }
    // 有些响应不给 content-length,只能读完再判一次(上面那次是提前拦,省内存)
    if (bytes.byteLength > MAX_COVER_BYTES) {
      pushLog('error', 'cover', `抓封面失败 id=${opts.importId} 响应过大 bytes=${bytes.byteLength} url=${opts.url}`);
      return false;
    }
    mkdirSync(opts.coversDir, { recursive: true });
    const dest = join(opts.coversDir, `${prefixOf(opts.importId)}${ext}`);
    writeFileSync(dest, bytes);
    removeOtherCovers(opts.coversDir, opts.importId, dest); // 换图/换格式后清旧扩展名,避免随机命中旧图
    pushLog('info', 'cover', `封面已落盘 id=${opts.importId} bytes=${bytes.byteLength} path=${dest}`);
    return true;
  } catch (e) {
    pushLog('error', 'cover', `抓封面异常 id=${opts.importId} url=${opts.url}: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

/**
 * 让 yt-dlp 把封面**直接写**到 coversDir(返回是否成功)。
 * 为什么需要它:Node 内置 fetch 不读 Windows 系统代理设置 → 直连外网图床(i.ytimg.com)会一直卡到超时;
 * yt-dlp 走系统代理,同一张图 130ms 就下来了(2026-09-29 实测)。它顺带还能带 Cookie,处理国内站点风控。
 * 成功判定以"文件真出现了"为准(yt-dlp 退出码 0 不代表写出了图,例如源站根本没有缩略图)。
 */
export function writeCoverViaYtdlp(opts: {
  binPath: string; url: string; coversDir: string; importId: number; cookiePath?: string; timeoutMs?: number; doExec?: ExecLike;
}): Promise<boolean> {
  const doExec = opts.doExec ?? execFile;
  // 前缀走 prefixOf(与 findCoverFile / fetchAndStoreCover 同一处定义):换前缀方案时不会漏改这一支
  const prefix = prefixOf(opts.importId);
  const outTemplate = join(opts.coversDir, `${prefix}%(ext)s`);
  try { mkdirSync(opts.coversDir, { recursive: true }); } catch { /* 建不出来就让 yt-dlp 自己报错 */ }
  // 开跑前先清掉这个来源的旧封面(2026-09-29 评审补):成功判据是"文件真出现了",而 findCoverFile 取的是
  // readdirSync 的**第一个**匹配 —— 若旧图是 jpg、新图写成 png,它可能命中旧那张,于是"报成功但其实还是旧图"。
  // 先清干净,跑完还能找到文件,那就必然是新写出来的。
  removeOtherCovers(opts.coversDir, opts.importId, '');
  return new Promise((resolve) => {
    doExec(opts.binPath, buildWriteThumbnailArgs(opts.url, outTemplate, opts.cookiePath), {
      timeout: opts.timeoutMs ?? COVER_YTDLP_TIMEOUT_MS, windowsHide: true, maxBuffer: COVER_YTDLP_MAX_BUFFER,
    }, (err, stdout, stderr) => {
      // yt-dlp 有时把原因打在 stdout(如 "[info] ... has no thumbnail"),失败时把两边各留一段
      const tail = (s: string | undefined): string => (s ?? '').trim().split('\n').slice(-1)[0]?.slice(0, 200) ?? '';
      if (err) {
        const e = err as NodeJS.ErrnoException;
        pushLog('error', 'cover', `yt-dlp 写封面失败 id=${opts.importId} code=${e.code ?? '?'} stderr=${tail(stderr) || '(空)'} stdout=${tail(stdout) || '(空)'}`);
        resolve(false);
        return;
      }
      // 旧图已清,这里找到的就是本次写出来的(退出码 0 不代表写出了图,以文件为准)
      const file = findCoverFile(opts.coversDir, opts.importId);
      if (file === null) {
        pushLog('error', 'cover', `yt-dlp 跑完但没写出封面文件 id=${opts.importId} url=${opts.url} stdout=${tail(stdout) || '(空)'}`);
        resolve(false);
        return;
      }
      pushLog('info', 'cover', `yt-dlp 已写封面 id=${opts.importId} path=${file}`);
      resolve(true);
    });
  });
}
