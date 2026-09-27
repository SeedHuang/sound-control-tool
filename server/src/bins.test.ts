import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { candidatesFromPath } from './bins.js';

describe('candidatesFromPath(纯函数)', () => {
  it('按分隔符切分并拼接可执行文件名;空段忽略', () => {
    const p = ['C:\\a', '', 'C:\\b'].join(path.delimiter);
    const name = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
    expect(candidatesFromPath(p, 'yt-dlp')).toEqual([
      path.join('C:\\a', name),
      path.join('C:\\b', name),
    ]);
  });

  it('仅拼接 PATH 候选,不做存在性判断', () => {
    const p = [path.join('C:\\definitely-not-exists-sct'), 'C:\\'].join(path.delimiter);
    // C:\ 下不会有 yt-dlp.exe(除非极端情况);断言结果不含不存在的目录项
    const out = candidatesFromPath(p, 'yt-dlp');
    expect(out.every((x) => x.startsWith('C:\\definitely-not-exists-sct'))).toBe(false);
  });
});
