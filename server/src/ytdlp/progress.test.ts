import { describe, expect, it } from 'vitest';
import { parseProgressLine } from './progress.js';
describe('parseProgressLine', () => {
  it('解析 percent|downloaded|total', () => {
    expect(parseProgressLine('42.3%|12345|67890')).toEqual({ percent: 42.3, downloadedBytes: 12345, totalBytes: 67890 });
  });
  it('total 缺失(下载中未知大小)', () => {
    expect(parseProgressLine('12.5%|999|')).toEqual({ percent: 12.5, downloadedBytes: 999, totalBytes: undefined });
  });
  it('非进度行返回 null', () => {
    expect(parseProgressLine('[download] Destination: x.mp3')).toBeNull();
    expect(parseProgressLine('')).toBeNull();
  });
});
