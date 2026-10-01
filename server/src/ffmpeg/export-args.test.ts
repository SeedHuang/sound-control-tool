// server/src/ffmpeg/export-args.test.ts
// P4 T4：merge 导出参数（spec D9）——纯参数快照断言，不碰 IO。
import { describe, expect, it } from 'vitest';
import { buildMergeArgs } from './export-args.js';

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
