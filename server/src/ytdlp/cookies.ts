// server/src/ytdlp/cookies.ts(B 站 Cookie:粘贴内容归一化为 Netscape 格式 + 物化 cookies.txt)
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const NETSCAPE_HEADER = '# Netscape HTTP Cookie File';

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

/**
 * 把用户粘贴的 Cookie 内容归一化为 Netscape 格式(yt-dlp --cookies 要求):
 * - 空输入/全空白 → TypeError('Cookie 内容为空')
 * - 以 [ 或 { 开头 → 按 cookie-editor JSON 解析转 Netscape;解析失败或形状不对 → 原样 trim(假定已是 Netscape)
 * - 其他文本 → 原样 trim,缺头补头
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
  return ensureNetscapeHeader(trimmed);
}

/** 归一化后写入 dataDir/cookies.txt 并返回路径;内容为空时 normalizeCookieContent 抛错,调用方捕获后跳过注入 */
export function materializeCookieFile(content: string, dataDir: string): string {
  const normalized = normalizeCookieContent(content);
  const filePath = join(dataDir, 'cookies.txt');
  writeFileSync(filePath, normalized, 'utf8'); // node 的 'utf8' 不写 BOM(区别于 PowerShell 5.1 的 -Encoding UTF8)
  return filePath;
}
