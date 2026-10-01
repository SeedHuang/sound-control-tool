import { describe, expect, it } from 'vitest';
import { buildFilmstripArgs, buildWaveformArgs } from './derived-args.js';

describe('buildWaveformArgs(波形底图参数)', () => {
  it('显式 s=1600x120、showwavespic、-frames:v 1(实测 F2)', () => {
    expect(buildWaveformArgs('v.mp4', 'o.png')).toEqual([
      '-y', '-i', 'v.mp4',
      '-filter_complex', 'showwavespic=s=1600x120:colors=0x22d3ee|0x1e293b',
      '-frames:v', '1', 'o.png',
    ]);
  });
});

describe('buildFilmstripArgs(胶片条参数)', () => {
  const vfOf = (args: string[]): string => args[args.indexOf('-vf') + 1] ?? '';

  it('duration=20 → fps=12/20=0.600000;tile=12x1;scale=1600:90;-an;-frames:v 1(实测 G2)', () => {
    const args = buildFilmstripArgs('v.mp4', 'o.png', 20);
    expect(vfOf(args)).toBe('fps=0.600000,scale=-1:90,tile=12x1,scale=1600:90');
    expect(args).toEqual(['-y', '-i', 'v.mp4', '-an', '-vf', vfOf(args), '-frames:v', '1', 'o.png']);
  });

  it('duration=0 与 null(时长未知)→ fps=1.000000 退化', () => {
    expect(vfOf(buildFilmstripArgs('v.mp4', 'o.png', 0))).toContain('fps=1.000000');
    expect(vfOf(buildFilmstripArgs('v.mp4', 'o.png', null))).toContain('fps=1.000000');
  });

  it('极短 duration=0.3 → fps 夹逼上限 30.000000(避免无谓解码)', () => {
    expect(vfOf(buildFilmstripArgs('v.mp4', 'o.png', 0.3))).toContain('fps=30.000000');
  });

  it('极长 duration=1000 → fps 夹逼下限 0.050000(避免 0 帧空产物)', () => {
    const fps = Number(/fps=([\d.]+)/.exec(vfOf(buildFilmstripArgs('v.mp4', 'o.png', 1000)))?.[1]);
    expect(fps).toBeGreaterThanOrEqual(0.05);
  });
});
