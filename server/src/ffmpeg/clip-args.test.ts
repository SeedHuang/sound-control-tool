import { describe, expect, it } from 'vitest';
import { buildClipArgs } from './clip-args.js';

describe('buildClipArgs(抽音轨参数)', () => {
  it('mp3 + 码率:输出侧定位(实测 B:输入侧 -ss 会提前到前一个关键帧,起点不准)、-vn 丢视频、libmp3lame、带 -y', () => {
    expect(buildClipArgs({ inputPath: 'v.mp4', outPath: 'o.mp3', start: 90, end: 210, format: 'mp3', quality: '192k' }))
      .toEqual(['-i', 'v.mp4', '-ss', '90', '-to', '210', '-vn', '-c:a', 'libmp3lame', '-b:a', '192k', '-y', 'o.mp3']);
  });
  it('wav:码率被忽略(wav 无损,码率无意义)、编码器用 pcm', () => {
    expect(buildClipArgs({ inputPath: 'v.mp4', outPath: 'o.wav', start: 0, end: 5, format: 'wav', quality: '320k' }))
      .toEqual(['-i', 'v.mp4', '-ss', '0', '-to', '5', '-vn', '-c:a', 'pcm_s16le', '-y', 'o.wav']);
  });
  it('m4a + 无码率:不带 -b:a', () => {
    expect(buildClipArgs({ inputPath: 'v.mp4', outPath: 'o.m4a', start: 1, end: 2, format: 'm4a' }))
      .toEqual(['-i', 'v.mp4', '-ss', '1', '-to', '2', '-vn', '-c:a', 'aac', '-y', 'o.m4a']);
  });
  it('小数秒原样透传(前端精度到 0.1s)', () => {
    const args = buildClipArgs({ inputPath: 'v.mp4', outPath: 'o.mp3', start: 12.5, end: 30.25, format: 'mp3' });
    // brief 原文写 slice(2, 4) 只取到 ['-ss', '12.5'](-i/input 占 0-1,-ss/12.5 占 2-3),下标错位;按意图取 -ss/-to 两对共 4 个元素
    expect(args.slice(2, 6)).toEqual(['-ss', '12.5', '-to', '30.25']);
  });
});
