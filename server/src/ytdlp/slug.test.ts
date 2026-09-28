import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { slugify, resolveUniquePath } from './slug.js';
describe('slugify', () => {
  it('替换 Windows 非法字符为下划线', () => {
    expect(slugify('a/b:c*?"<>|')).toBe('a_b_c______');
  });
  it('去首尾空格并截断至 80 字符', () => {
    expect(slugify('  x  ')).toBe('x');
    expect(slugify('a'.repeat(100)).length).toBe(80);
  });
});
describe('resolveUniquePath', () => {
  // 期望值用 join 构造:node:path 在 Windows 会把 '/' 规范化为 '\'，直接写死分隔符会跨平台失败
  it('目标不存在时原样返回', () => {
    expect(resolveUniquePath('C:/dir', 'song-12345678.mp3', () => false)).toBe(join('C:/dir', 'song-12345678.mp3'));
  });
  it('存在时追加 -2 -3 序号', () => {
    const taken = new Set([join('C:/dir', 'song-12345678.mp3'), join('C:/dir', 'song-12345678-2.mp3')]);
    expect(resolveUniquePath('C:/dir', 'song-12345678.mp3', (p) => taken.has(p))).toBe(join('C:/dir', 'song-12345678-3.mp3'));
  });
});
