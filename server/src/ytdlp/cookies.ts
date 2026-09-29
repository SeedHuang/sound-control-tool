// server/src/ytdlp/cookies.ts(B 站 Cookie:粘贴内容归一化为 Netscape 格式 + 物化 cookies.txt)
// 支持三种粘贴(2026-09-29 用户实测后补齐 cURL 支持——用户主流姿势是 F12 Copy as cURL):
// 1. cookie-editor JSON 2. cURL bash 命令(-b '...' 或 -H 'cookie: ...')3. 原始 cookie 头串(k=v; k=v)
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const NETSCAPE_HEADER = '# Netscape HTTP Cookie File';
// 从 cURL/头串转 Netscape 时的统一域名(B 站场景:www/api/m 全是 .bilibili.com 子域,includeSubdomains=TRUE 一网打尽)
const FALLBACK_DOMAIN = '.bilibili.com';
// 头串转出来的 cookie 没有过期时间,给 2030-01-01(避免 expiry=0 被当会话 Cookie 挑丢)
const FAR_FUTURE = '1893456000';

// cookie-editor 导出的单条 cookie(只取 yt-dlp 需要的字段;httpOnly 在 Netscape 7 列里无对应位,接受但忽略)
interface CookieEntry {
  domain?: unknown;
  path?: unknown;
  secure?: unknown;
  httpOnly?: unknown;
  name?: unknown;
  value?: unknown;
  expirationDate?: unknown;
  expiration?: unknown;
}

// 单条 cookie-editor JSON → Netscape 行(tab 分隔 7 列:domain, includeSubdomains, path, secure, expiry, name, value);无 name 视为脏数据跳过
function entryToNetscapeLine(c: CookieEntry): string | null {
  if (typeof c.name !== 'string' || c.name.length === 0) return null;
  const domain = typeof c.domain === 'string' ? c.domain : '';
  // Netscape 约定:domain 以点开头 = 含子域(includeSubdomains=TRUE)
  const includeSubdomains = domain.startsWith('.') ? 'TRUE' : 'FALSE';
  const path = typeof c.path === 'string' && c.path.length > 0 ? c.path : '/';
  const secure = c.secure === true ? 'TRUE' : 'FALSE';
  const expiryRaw = typeof c.expirationDate === 'number' ? c.expirationDate : typeof c.expiration === 'number' ? c.expiration : 0;
  const expiry = Number.isFinite(expiryRaw) && expiryRaw > 0 ? String(Math.floor(expiryRaw)) : '0';
  const value = typeof c.value === 'string' ? c.value : '';
  return [domain, includeSubdomains, path, secure, expiry, c.name, value].join('\t');
}

// JSON(cookie-editor)→ Netscape 文本;不是数组/带 name 的单对象或无有效条目 → null(调用方按原样保留)
function jsonToNetscape(parsed: unknown): string | null {
  const entries: unknown[] = Array.isArray(parsed)
    ? parsed
    : typeof parsed === 'object' && parsed !== null && 'name' in parsed
      ? [parsed]
      : [];
  const lines = entries
    .filter((e): e is CookieEntry => typeof e === 'object' && e !== null)
    .map(entryToNetscapeLine)
    .filter((l): l is string => l !== null);
  return lines.length > 0 ? [NETSCAPE_HEADER, ...lines].join('\n') : null;
}

// 首行恒为 # Netscape HTTP Cookie File(没有就补上)
function ensureNetscapeHeader(text: string): string {
  return text.startsWith(NETSCAPE_HEADER) ? text : `${NETSCAPE_HEADER}\n${text}`;
}

// cookie 头串(k=v; k=v; ...)→ Netscape 文本;一条都解析不出 → null
// 值里的分号不存在(分号就是分隔符),按 ; 切分安全;域名信息头串里没有,统一挂 FALLBACK_DOMAIN
function cookieHeaderToNetscape(header: string): string | null {
  const pairs = header.split(';').map((s) => s.trim()).filter(Boolean);
  const lines: string[] = [];
  for (const p of pairs) {
    const eq = p.indexOf('=');
    if (eq <= 0) continue; // 无名条目跳过(如行尾分号残留)
    const name = p.slice(0, eq).trim();
    const value = p.slice(eq + 1).trim();
    if (name.length === 0) continue;
    lines.push([FALLBACK_DOMAIN, 'TRUE', '/', 'TRUE', FAR_FUTURE, name, value].join('\t'));
  }
  return lines.length > 0 ? [NETSCAPE_HEADER, ...lines].join('\n') : null;
}

// 从 cURL bash 命令提取 cookie 串:优先 -H 'cookie: ...'(DevTools Copy as cURL 标准姿势),其次 -b / --cookie
// 处理 bash 续行符(\ + 换行 → 空格);单/双引号两种包裹都认;捕获组判空(noUncheckedIndexedAccess)
function extractCookieFromCurl(cmd: string): string | null {
  const flat = cmd.replace(/\\\r?\n/g, ' ');
  for (const m of flat.matchAll(/-H\s+\$?'([^']*)'/gi)) {
    const h = m[1];
    if (h !== undefined && /^cookie\s*:/i.test(h.trim())) return h.slice(h.indexOf(':') + 1).trim();
  }
  for (const m of flat.matchAll(/-H\s+"([^"]*)"/gi)) {
    const h = m[1];
    if (h !== undefined && /^cookie\s*:/i.test(h.trim())) return h.slice(h.indexOf(':') + 1).trim();
  }
  const b = flat.match(/(?:^|\s)(?:-b|--cookie)\s+\$?'([^']*)'/) ?? flat.match(/(?:^|\s)(?:-b|--cookie)\s+"([^"]*)"/);
  const value = b?.[1];
  return value !== undefined ? value.trim() : null;
}

/**
 * 把用户粘贴的 Cookie 内容归一化为 Netscape 格式(yt-dlp --cookies 要求):
 * - 空输入/全空白 → TypeError('Cookie 内容为空')
 * - 以 [ 或 { 开头 → 按 cookie-editor JSON 解析转 Netscape;解析失败或形状不对 → 原样 trim(假定已是 Netscape)
 * - 含 curl 命令 → 提取 -b / -H 'cookie:' 的值转 Netscape;提取不到任何 Cookie → TypeError(常见:复制到媒体/CDN 请求,那类不带登录凭据)
 * - 原始 cookie 头串(k=v; k=v,无 tab)→ 转 Netscape
 * - 其他文本 → 原样 trim,缺头补头(假定已是 Netscape)
 */
export function normalizeCookieContent(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) throw new TypeError('Cookie 内容为空');
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const netscape = jsonToNetscape(JSON.parse(trimmed) as unknown);
      if (netscape !== null) return netscape;
    } catch {
      // JSON 非法 → 按原样 trim 返回(假定已是 Netscape),由 ensureNetscapeHeader 补头
    }
    return ensureNetscapeHeader(trimmed);
  }
  // cURL bash 命令(续行/反引号装饰不影响提取)
  if (/\bcurl\b/i.test(trimmed)) {
    const header = extractCookieFromCurl(trimmed);
    const netscape = header !== null ? cookieHeaderToNetscape(header) : null;
    if (netscape === null) {
      throw new TypeError('这条 cURL 里没有 Cookie——常见原因是复制到了视频流/CDN 请求(那类不带登录凭据)。请在 F12 网络面板选 www.bilibili.com 的文档请求重新 Copy as cURL');
    }
    return netscape;
  }
  // 原始 cookie 头串:无 tab(排除 Netscape 行)+ token= 开头 + 含分号
  if (!trimmed.includes('\t') && /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+\s*=/.test(trimmed) && trimmed.includes(';')) {
    const netscape = cookieHeaderToNetscape(trimmed.replace(/\r?\n+/g, ' '));
    if (netscape !== null) return netscape;
  }
  return ensureNetscapeHeader(trimmed);
}

/** 归一化后统计有效 cookie 条数(Netscape 数据行数;解析失败 → 0)——保存/状态接口给用户即时反馈 */
export function countCookies(content: string): number {
  try {
    return normalizeCookieContent(content).split('\n').filter((l) => l.length > 0 && !l.startsWith('#')).length;
  } catch {
    return 0;
  }
}

/**
 * SESSDATA 登录有效期(离线判定,支撑「已有未过期登录信息」提示,不用每次发在线请求):
 * SESSDATA 值形如 '97df5745%2C1804299628%2Cdbeca*92...' —— URL 解码后按逗号切,第 2 段是过期 unix 秒。
 * 无 SESSDATA / 格式解析不出 → null
 */
export function getSessdataExpiry(content: string): number | null {
  let netscape: string;
  try {
    netscape = normalizeCookieContent(content);
  } catch {
    return null;
  }
  for (const line of netscape.split('\n')) {
    if (line.startsWith('#') || line.length === 0) continue;
    const cols = line.split('\t');
    if (cols.length >= 7 && cols[5] === 'SESSDATA') {
      const raw = cols[6] ?? '';
      try {
        const segs = decodeURIComponent(raw).split(',');
        const exp = Number(segs[1]);
        return Number.isFinite(exp) && exp > 0 ? exp : null;
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** 归一化后的内容转回 Cookie 请求头串('k=v; k=v')——给 B 站 nav 接口在线校验用;无有效条目 → null */
export function toCookieHeader(content: string): string | null {
  let netscape: string;
  try {
    netscape = normalizeCookieContent(content);
  } catch {
    return null;
  }
  const pairs: string[] = [];
  for (const line of netscape.split('\n')) {
    if (line.startsWith('#') || line.length === 0) continue;
    const cols = line.split('\t');
    if (cols.length < 7) continue;
    const name = cols[5] ?? '';
    const value = cols[6] ?? '';
    if (name.length === 0) continue;
    pairs.push(`${name}=${value}`);
  }
  return pairs.length > 0 ? pairs.join('; ') : null;
}

/** 归一化后写入 dataDir/cookies.txt 并返回路径;内容为空时 normalizeCookieContent 抛错,调用方捕获后跳过注入 */
export function materializeCookieFile(content: string, dataDir: string): string {
  const normalized = normalizeCookieContent(content);
  const filePath = join(dataDir, 'cookies.txt');
  writeFileSync(filePath, normalized, 'utf8'); // node 的 'utf8' 不写 BOM(区别于 PowerShell 5.1 的 -Encoding UTF8)
  return filePath;
}
