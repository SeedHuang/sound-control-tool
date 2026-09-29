// server/src/ytdlp/cookies.test.ts(B 站 Cookie:粘贴内容归一化 + 物化,TDD 先行)
import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { materializeCookieFile, normalizeCookieContent } from './cookies.js';

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

describe('materializeCookieFile', () => {
  it('归一化后写入 dataDir/cookies.txt 并返回路径', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'sct-cookie-'));
    try {
      const p = materializeCookieFile(JSON.stringify([{ domain: '.bilibili.com', name: 'SESSDATA', value: 'x', expirationDate: 1790000000 }]), dataDir);
      expect(p).toBe(join(dataDir, 'cookies.txt'));
      expect(existsSync(p)).toBe(true);
      const written = readFileSync(p, 'utf8');
      expect(written.startsWith(`${HEADER}\n`)).toBe(true);
      expect(written).toContain('SESSDATA\tx');
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('空白内容 → 抛 TypeError 且不写文件', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'sct-cookie-'));
    try {
      expect(() => materializeCookieFile('  ', dataDir)).toThrow('Cookie 内容为空');
      expect(existsSync(join(dataDir, 'cookies.txt'))).toBe(false);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
