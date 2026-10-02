// server/src/ffmpeg/export-args.test.ts
// P4 T4：merge 导出参数（spec D9）——纯参数快照断言，不碰 IO。
// N1 Task 2：视频导出参数快照（实测依据 .superpowers/sdd/2026-10-01-clip-works/ffmpeg-measure-report.md A 组）。
import { describe, expect, it } from 'vitest';
import { buildMergeArgs, buildVideoClipArgs, buildVideoConcatArgs, crfOf } from './export-args.js';

describe('buildMergeArgs', () => {
  it('2 段 → atrim 各自、asetpts 重置、concat、-map [out]、-vn、编码器、-y', () => {
    const args = buildMergeArgs({
      inputPath: 'v.mp4', outPath: 'o.mp3', format: 'mp3', quality: '192k',
      segments: [{ start_sec: 0, end_sec: 10 }, { start_sec: 20, end_sec: 30 }],
    });
    const filter = args[args.indexOf('-filter_complex') + 1]!;
    expect(filter).toContain('atrim=start=0:end=10');
    expect(filter).toContain('atrim=start=20:end=30');
    expect(filter).toContain('concat=n=2:v=0:a=1[out]');
    expect(args).toContain('-map'); expect(args).toContain('[out]');
    expect(args).toContain('-vn');
    expect(args).toContain('-c:a'); expect(args).toContain('libmp3lame');
    expect(args).toContain('-b:a'); expect(args).toContain('192k'); // mp3 带码率
    expect(args).toContain('-y');
    expect(args[args.length - 1]).toBe('o.mp3'); // 产物在最后
  });
  it('wav + quality → 不带 -b:a（与 buildClipArgs 同口径）', () => {
    const args = buildMergeArgs({
      inputPath: 'v.mp4', outPath: 'o.wav', format: 'wav', quality: '192k',
      segments: [{ start_sec: 0, end_sec: 10 }],
    });
    expect(args).not.toContain('-b:a');
    expect(args).toContain('pcm_s16le');
  });
});

describe('crfOf（quality → CRF，实测 A4）', () => {
  it('high → 20（4K 10s ≈ 41.5MB）', () => {
    expect(crfOf('high')).toBe(20);
  });
  it('mid / medium / 缺省 → 23（4K 10s ≈ 32.2MB）', () => {
    expect(crfOf('mid')).toBe(23);
    expect(crfOf('medium')).toBe(23);
    expect(crfOf()).toBe(23);
  });
  it('low → 28（4K 10s ≈ 21.0MB）', () => {
    expect(crfOf('low')).toBe(28);
  });
  it('未知值 → 23 且不报错（未知档位落中档，不静默升级到最贵档）', () => {
    expect(crfOf('ultra')).toBe(23);
    expect(crfOf('192k')).toBe(23); // 音频侧的码率字符串误传进来也安全
  });
});

describe('buildVideoClipArgs（视频切段参数，实测 A1/A3）', () => {
  it('带音轨：输入侧 -ss/-to 精确切（A1 产物 v/a 均 10.000s 整）、libx264/veryfast/crf、aac 192k 重编码（A2：copy 仅省 0.07s）', () => {
    expect(buildVideoClipArgs({ inputPath: 'v.mp4', outPath: 'o.mp4', start: 600, end: 610, crf: 23, an: false }))
      .toEqual(['-y', '-ss', '600', '-to', '610', '-i', 'v.mp4',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
        '-c:a', 'aac', '-b:a', '192k',
        '-movflags', '+faststart', 'o.mp4']);
  });
  it('纯视频：含 -an 且不含 -c:a/-b:a（A3），crf 透传', () => {
    const args = buildVideoClipArgs({ inputPath: 'v.mp4', outPath: 'o.mp4', start: 0, end: 5, crf: 28, an: true });
    expect(args).toContain('-an');
    expect(args).not.toContain('-c:a');
    expect(args).not.toContain('-b:a');
    expect(args[args.indexOf('-crf') + 1]).toBe('28');
    expect(args[args.length - 1]).toBe('o.mp4');
  });
  it('小数时间点：照抄 buildClipArgs 的精度处理——String 原样透传，无取整无 clamp', () => {
    const args = buildVideoClipArgs({ inputPath: 'v.mp4', outPath: 'o.mp4', start: 1.5, end: 10.25, crf: 23, an: false });
    expect(args).toContain('1.5');
    expect(args).toContain('10.25');
  });
});

describe('buildVideoConcatArgs（concat demuxer 拼接，实测 A5：0.46s vs 重编码 42.89s）', () => {
  // 列表文件写法归 Task 3 落实，每行形如：
  //   file 'C:/Users/.../export-1-m0-123.mp4'   ← 正斜杠 + -safe 0（T3 落实）
  it('精确数组：-y -f concat -safe 0 -i list -c copy out', () => {
    expect(buildVideoConcatArgs({ listPath: 'list.txt', outPath: 'merged.mp4' }))
      .toEqual(['-y', '-f', 'concat', '-safe', '0', '-i', 'list.txt', '-c', 'copy', 'merged.mp4']);
  });
});
