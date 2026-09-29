// server/src/covers.ts(2026-09-29 新增:作品封面抓取与落盘)
// 用途:音频库「剧集分组」视图要显示作品封面(B 站/YouTube 的番剧封面)。
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

/** 已落盘的封面文件绝对路径;没有(或目录不存在)→ null */
export function findCoverFile(coversDir: string, importId: number): string | null {
  try {
    const hit = readdirSync(coversDir).find((f) => f.startsWith(prefixOf(importId)));
    return hit === undefined ? null : join(coversDir, hit);
  } catch {
    return null; // 目录还没建过(没抓过任何封面)——不算错
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
function isHttpUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * 抓一张封面并落盘。返回是否成功;失败只记日志,不抛。
 * @param opts.doFetch 注入用(默认全局 fetch);超时 10s——抓张图不该拖住任何调用方
 */
export async function fetchAndStoreCover(opts: {
  url: string; coversDir: string; importId: number; doFetch?: FetchLike;
}): Promise<boolean> {
  const doFetch = opts.doFetch ?? fetch;
  if (!isHttpUrl(opts.url)) {
    pushLog('error', 'cover', `封面地址不是 http(s)，跳过 id=${opts.importId} url=${opts.url}`);
    return false;
  }
  try {
    const res = await doFetch(opts.url, {
      headers: {
        // B 站防盗链:不带 Referer 会拿到 403;UA 也带上(少数图床按 UA 拦)
        referer: 'https://www.bilibili.com/',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) sound-control-tool/0.0',
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      pushLog('error', 'cover', `抓封面失败 id=${opts.importId} status=${res.status} url=${opts.url}`);
      return false;
    }
    const mime = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    const ext = EXT_BY_MIME[mime] ?? 'jpg'; // 图床偶尔不给 content-type,按 jpg 落盘(浏览器能容错识别)
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.byteLength === 0) {
      pushLog('error', 'cover', `抓封面失败 id=${opts.importId} 响应体为空 url=${opts.url}`);
      return false;
    }
    mkdirSync(opts.coversDir, { recursive: true });
    const dest = join(opts.coversDir, `${prefixOf(opts.importId)}${ext}`);
    writeFileSync(dest, bytes);
    // 同一来源换过图/换过格式时,清掉旧的其它扩展名文件,避免 findCoverFile 随机命中旧图
    for (const f of readdirSync(opts.coversDir)) {
      if (f.startsWith(prefixOf(opts.importId)) && f !== `${prefixOf(opts.importId)}${ext}`) {
        try { unlinkSync(join(opts.coversDir, f)); } catch { /* 清旧图失败不影响本次结果 */ }
      }
    }
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
  const outTemplate = join(opts.coversDir, `cover-${opts.importId}.%(ext)s`);
  try { mkdirSync(opts.coversDir, { recursive: true }); } catch { /* 建不出来就让 yt-dlp 自己报错 */ }
  return new Promise((resolve) => {
    doExec(opts.binPath, buildWriteThumbnailArgs(opts.url, outTemplate, opts.cookiePath), {
      timeout: opts.timeoutMs ?? 30_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      // yt-dlp 有时把原因打在 stdout(如 "[info] ... has no thumbnail"),失败时把两边各留一段
      const tail = (s: string | undefined): string => (s ?? '').trim().split('\n').slice(-1)[0]?.slice(0, 200) ?? '';
      if (err) {
        const e = err as NodeJS.ErrnoException;
        pushLog('error', 'cover', `yt-dlp 写封面失败 id=${opts.importId} code=${e.code ?? '?'} stderr=${tail(stderr) || '(空)'} stdout=${tail(stdout) || '(空)'}`);
        resolve(false);
        return;
      }
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
