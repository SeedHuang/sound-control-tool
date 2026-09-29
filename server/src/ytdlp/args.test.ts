import { describe, expect, it } from 'vitest';
import { buildDownloadArgs, buildParseArgs, buildWriteThumbnailArgs } from './args.js';
describe('buildParseArgs', () => {
  it('固定 -J --flat-playlist --no-warnings', () => {
    expect(buildParseArgs('https://b23.tv/abc')).toEqual(['-J', '--flat-playlist', '--no-warnings', 'https://b23.tv/abc']);
  });
});
// 2026-09-29:封面改由 yt-dlp 自己写(--write-thumbnail)——Node fetch 不读系统代理,外网图床直连必超时
describe('buildWriteThumbnailArgs', () => {
  it('--skip-download + --write-thumbnail + 只取第 1 集 + -o 模板', () => {
    const a = buildWriteThumbnailArgs('https://b23.tv/abc', 'D:/covers/cover-5.%(ext)s');
    expect(a).toEqual(['--skip-download', '--write-thumbnail', '--playlist-items', '1', '--no-warnings', '-o', 'D:/covers/cover-5.%(ext)s', 'https://b23.tv/abc']);
    expect(a).not.toContain('--flat-playlist');
    expect(a).not.toContain('-J');
  });
});
describe('buildDownloadArgs', () => {
  it('单条强制 --no-playlist + 含 --windows-filenames', () => {
    const a = buildDownloadArgs({ url: 'u', options: { format: 'mp3' }, outDir: 'D:/tmp' });
    expect(a).toContain('--no-playlist');
    expect(a).toContain('--windows-filenames');
    expect(a).toContain('-o');
  });
  it('合集单元素换算 --playlist-items(D8:单产物模型,多选由前端逐条提交)', () => {
    const a = buildDownloadArgs({ url: 'u', options: { format: 'm4a', entryIndices: [3] }, outDir: 'D:/tmp' });
    expect(a).toContain('--playlist-items');
    expect(a[a.indexOf('--playlist-items') + 1]).toBe('3');
  });
  it('无 entryIndices 时强制 --no-playlist', () => {
    const a = buildDownloadArgs({ url: 'u', options: { format: 'mp3' }, outDir: 'D:/tmp' });
    expect(a).toContain('--no-playlist');
    expect(a).not.toContain('--playlist-items');
  });
  it('片段下载带 --download-sections', () => {
    const a = buildDownloadArgs({ url: 'u', options: { format: 'wav', section: { start: 61, end: 184.5 } }, outDir: 'D:/tmp' });
    expect(a).toContain('--download-sections');
    expect(a[a.indexOf('--download-sections') + 1]).toBe('*61-184.5');
  });
  it('quality 缺省时不出现 --audio-quality', () => {
    const a = buildDownloadArgs({ url: 'u', options: { format: 'mp3' }, outDir: 'D:/tmp' });
    expect(a).not.toContain('--audio-quality');
  });
});
describe('cookiePath 注入(--cookies,B 站风控)', () => {
  it('buildParseArgs 带 cookiePath → --cookies + 路径插在 url 之前', () => {
    expect(buildParseArgs('u', 'D:/sct-data/cookies.txt')).toEqual(['--cookies', 'D:/sct-data/cookies.txt', '-J', '--flat-playlist', '--no-warnings', 'u']);
  });
  it('buildParseArgs 无 cookiePath → 不含 --cookies(原形态不变)', () => {
    expect(buildParseArgs('u')).toEqual(['-J', '--flat-playlist', '--no-warnings', 'u']);
  });
  it('buildDownloadArgs 带 cookiePath → 含 --cookies 且位于 url 之前', () => {
    const a = buildDownloadArgs({ url: 'u', options: { format: 'mp3' }, outDir: 'D:/tmp', cookiePath: 'D:/sct-data/cookies.txt' });
    expect(a).toContain('--cookies');
    expect(a[a.indexOf('--cookies') + 1]).toBe('D:/sct-data/cookies.txt');
    expect(a.indexOf('--cookies')).toBeLessThan(a.lastIndexOf('u'));
  });
  it('buildDownloadArgs 无 cookiePath → 不含 --cookies', () => {
    const a = buildDownloadArgs({ url: 'u', options: { format: 'mp3' }, outDir: 'D:/tmp' });
    expect(a).not.toContain('--cookies');
  });
});
