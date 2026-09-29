// server/src/ytdlp/cookies.test.ts(B 站 Cookie:粘贴内容归一化 + 物化 + 登录有效期,TDD 先行)
import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { countCookies, getSessdataExpiry, materializeCookieFile, normalizeCookieContent, toCookieHeader } from './cookies.js';

const HEADER = '# Netscape HTTP Cookie File';

describe('normalizeCookieContent', () => {
  it('空输入/全空白 → TypeError(Cookie 内容为空)', () => {
    expect(() => normalizeCookieContent('')).toThrow('Cookie 内容为空');
    expect(() => normalizeCookieContent('   \n\t ')).toThrow('Cookie 内容为空');
  });

  it('cookie-editor JSON 数组 → Netscape 7 列 tab 行 + 固定头', () => {
    const json = JSON.stringify([
      { domain: '.bilibili.com', path: '/', secure: true, httpOnly: true, name: 'SESSDATA', value: 'abc', expirationDate: 1790000000.9 },
      { domain: 'www.bilibili.com', path: '/x', secure: false, name: 'foo', value: 'bar' },
    ]);
    const out = normalizeCookieContent(json);
    expect(out.startsWith(`${HEADER}\n`)).toBe(true);
    const lines = out.split('\n');
    // domain 带前缀点 → includeSubdomains=TRUE;secure:true → TRUE;expirationDate 取整
    expect(lines[1]).toBe('.bilibili.com\tTRUE\t/\tTRUE\t1790000000\tSESSDATA\tabc');
    // domain 无点 → FALSE;secure 缺省 → FALSE;expiration 缺失 → 0
    expect(lines[2]).toBe('www.bilibili.com\tFALSE\t/x\tFALSE\t0\tfoo\tbar');
  });

  it('expiration 字段名兼容(expirationDate 优先,expiration 兜底,都缺用 0)', () => {
    const out = normalizeCookieContent(JSON.stringify([{ domain: '.b.com', name: 'n', value: 'v', expiration: 123 }]));
    expect(out).toContain('.b.com\tTRUE\t/\tFALSE\t123\tn\tv');
    const out2 = normalizeCookieContent(JSON.stringify([{ domain: '.b.com', name: 'n', value: 'v' }]));
    expect(out2).toContain('.b.com\tTRUE\t/\tFALSE\t0\tn\tv');
  });

  it('单对象(有 name)也接受 → 单条 Netscape 行', () => {
    const out = normalizeCookieContent(JSON.stringify({ domain: '.b.com', name: 'n', value: 'v' }));
    expect(out.split('\n')).toHaveLength(2);
    expect(out).toContain('.b.com\tTRUE\t/\tFALSE\t0\tn\tv');
  });

  it('以 [ 开头但 JSON 非法 → 原样 trim 返回(假定已是 Netscape) + 补头', () => {
    const out = normalizeCookieContent('  [oops not json');
    expect(out.startsWith(`${HEADER}\n`)).toBe(true);
    expect(out.endsWith('[oops not json')).toBe(true);
  });

  it('JSON 合法但不是 cookie 数组(如 [1,2,3]) → 原样 trim + 补头', () => {
    expect(normalizeCookieContent('[1,2,3]')).toBe(`${HEADER}\n[1,2,3]`);
  });

  it('已是 Netscape(带头) → 原样 trim 返回,不重复补头', () => {
    const text = `${HEADER}\n.bilibili.com\tTRUE\t/\tTRUE\t1790000000\tSESSDATA\tx`;
    expect(normalizeCookieContent(`  ${text}  `)).toBe(text);
  });

  it('无头的 Netscape 文本 → 补头', () => {
    const out = normalizeCookieContent('.bilibili.com\tTRUE\t/\tTRUE\t1790000000\tSESSDATA\tx');
    expect(out.startsWith(`${HEADER}\n`)).toBe(true);
    expect(out.split('\n')).toHaveLength(2);
  });
});

describe('cURL 粘贴(2026-09-29 用户主姿势:F12 Copy as cURL bash)', () => {
  // bash 续行:每行行尾反斜杠 + 换行
  const curlB = [
    "curl 'https://api.bilibili.com/x/web-interface/nav' \\",
    "  -H 'accept: application/json' \\",
    "  -b 'SESSDATA=abc%2C1790000000%2Cd*92; bili_jct=jct123; DedeUserID=27725036' \\",
    "  -H 'user-agent: Mozilla/5.0'",
  ].join('\n');

  it('-b 形式:提取 cookie 串转 Netscape(续行打平,条数正确)', () => {
    const out = normalizeCookieContent(curlB);
    expect(out.startsWith(`${HEADER}\n`)).toBe(true);
    expect(out).toContain('.bilibili.com\tTRUE\t/\tTRUE\t1893456000\tSESSDATA\tabc%2C1790000000%2Cd*92');
    expect(out).toContain('bili_jct\tjct123');
    expect(countCookies(curlB)).toBe(3);
  });

  it("-H 'cookie:' 形式同样支持(DevTools 标准姿势)", () => {
    const c = "curl 'https://www.bilibili.com/' \\\n  -H 'cookie: SESSDATA=abc%2C1790000000%2Cd*92; bili_jct=jct123'";
    expect(normalizeCookieContent(c)).toContain('SESSDATA\tabc%2C1790000000%2Cd*92');
  });

  it('cURL 里没有 Cookie → TypeError 带人话指引(用户复制到媒体/CDN 请求的真实场景)', () => {
    const c = "curl 'https://upos-sz-mirror08c.bilivideo.com/xxx.m4s' \\\n  -H 'user-agent: Mozilla/5.0' \\\n  -H 'referer: https://www.bilibili.com/'";
    expect(() => normalizeCookieContent(c)).toThrow('这条 cURL 里没有 Cookie');
  });

  it('原始 cookie 头串(k=v; k=v)→ Netscape', () => {
    const out = normalizeCookieContent('SESSDATA=abc%2C1790000000%2Cd*92; bili_jct=jct123');
    expect(out.startsWith(`${HEADER}\n`)).toBe(true);
    expect(out).toContain('SESSDATA\tabc%2C1790000000%2Cd*92');
    expect(countCookies('SESSDATA=a; bili_jct=x; foo=y')).toBe(3);
  });
});

describe('getSessdataExpiry 登录有效期(离线判定,支撑「已有未过期登录信息」提示)', () => {
  it('SESSDATA 值 URL 解码后第 2 段是过期 unix 秒', () => {
    expect(getSessdataExpiry('SESSDATA=abc%2C1790000000%2Cd*92; bili_jct=x')).toBe(1790000000);
  });

  it('cURL 粘贴同样解析出有效期', () => {
    expect(getSessdataExpiry("curl 'https://x' -b 'SESSDATA=a%2C1804299628%2Cb'")).toBe(1804299628);
  });

  it('没有 SESSDATA / 格式异常 / 空 → null', () => {
    expect(getSessdataExpiry('foo=bar; baz=qux')).toBeNull();
    expect(getSessdataExpiry('SESSDATA=nocomma')).toBeNull();
    expect(getSessdataExpiry('')).toBeNull();
  });
});

describe('toCookieHeader(在线校验用:归一化内容转回请求头串)', () => {
  it('头串 → k=v; k=v', () => {
    expect(toCookieHeader('SESSDATA=abc; bili_jct=x')).toBe('SESSDATA=abc; bili_jct=x');
  });

  it('空/垃圾 → null', () => {
    expect(toCookieHeader('  ')).toBeNull();
  });
});

describe('materializeCookieFile', () => {
  // 2026-09-29:文件名带唯一后缀——yt-dlp 退出会把 cookie jar 回写进 --cookies 指的文件,固定名字会被并发调用互相覆盖(实测被回写成 0 字节)
  it('归一化后写入 dataDir/cookies-<唯一后缀>.txt 并返回路径', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'sct-cookie-'));
    try {
      const p = materializeCookieFile(JSON.stringify([{ domain: '.bilibili.com', name: 'SESSDATA', value: 'x', expirationDate: 1790000000 }]), dataDir);
      expect(p.startsWith(join(dataDir, 'cookies-'))).toBe(true);
      expect(p.endsWith('.txt')).toBe(true);
      expect(existsSync(p)).toBe(true);
      const written = readFileSync(p, 'utf8');
      expect(written.startsWith(`${HEADER}\n`)).toBe(true);
      expect(written).toContain('SESSDATA\tx');
      // 连写两份 → 路径必须不同(否则并发时互相覆盖)
      const p2 = materializeCookieFile('.bilibili.com\tTRUE\t/\tTRUE\t1790000000\tSESSDATA\ty', dataDir);
      expect(p2).not.toBe(p);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('空白内容 → 抛 TypeError 且不写文件', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'sct-cookie-'));
    try {
      expect(() => materializeCookieFile('  ', dataDir)).toThrow('Cookie 内容为空');
      expect(readdirSync(dataDir).filter((f) => f.startsWith('cookies-'))).toHaveLength(0);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
