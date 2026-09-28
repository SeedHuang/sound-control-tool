import { describe, expect, it } from 'vitest';
import { buildDownloadArgs, buildParseArgs } from './args.js';
describe('buildParseArgs', () => {
  it('固定 -J --flat-playlist --no-warnings', () => {
    expect(buildParseArgs('https://b23.tv/abc')).toEqual(['-J', '--flat-playlist', '--no-warnings', 'https://b23.tv/abc']);
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
