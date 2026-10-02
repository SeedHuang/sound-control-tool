import { describe, expect, it } from 'vitest';
import { DERIVED_FILM_H, DERIVED_FILM_TILES, DERIVED_FILM_W, buildFilmstripArgs, buildWaveformArgs, filmstripShapeSig, filmstripVfFor } from './derived-args.js';

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

  it('duration=3(短视频)→ fps=4.000000（按 12/T 直算，不下夹）', () => {
    expect(vfOf(buildFilmstripArgs('v.mp4', 'o.png', 3))).toContain('fps=4.000000');
  });

  it('duration=30 → fps=0.400000', () => {
    expect(vfOf(buildFilmstripArgs('v.mp4', 'o.png', 30))).toContain('fps=0.400000');
  });

  it('duration=1290(21.5 分钟长片)→ fps=0.009302（2026-10-02 修：旧下界 0.05 会把它夹成只覆盖前 4 分钟）', () => {
    const vf = vfOf(buildFilmstripArgs('v.mp4', 'o.png', 1290));
    expect(vf).toContain('fps=0.009302');
    // 关键断言：不能再被夹到 0.05（0.05 × 12 格 = 240 秒 = 只覆盖前 4 分钟）
    expect(vf).not.toContain('fps=0.050000');
  });

  it('极短 duration=0.3 → fps 夹逼上限 30.000000（避免无谓解码），下界不再存在', () => {
    expect(vfOf(buildFilmstripArgs('v.mp4', 'o.png', 0.3))).toContain('fps=30.000000');
  });

  it('时长未知（0 / NaN / 负数）→ 抛错，不得退化成 fps=1 出图（那会只覆盖前 12 秒）', () => {
    expect(() => buildFilmstripArgs('v.mp4', 'o.png', 0)).toThrow(RangeError);
    expect(() => buildFilmstripArgs('v.mp4', 'o.png', Number.NaN)).toThrow(RangeError);
    expect(() => buildFilmstripArgs('v.mp4', 'o.png', -5)).toThrow(RangeError);
  });

  // 审查修复轮 1 important 1：命中缓存时要拿 meta 里记的时长**重算一遍** vf 再逐字比对，
  // 所以「重算」这个函数必须和实际下给 ffmpeg 的参数是同一个口径 —— 否则比对永远对不上（老图每次都重画）。
  it('filmstripVfFor 与 buildFilmstripArgs 的 -vf 逐字一致（比对口径与生成口径必须是同一份）', () => {
    for (const d of [3, 20, 30, 1290]) {
      expect(vfOf(buildFilmstripArgs('v.mp4', 'o.png', d))).toBe(filmstripVfFor(d));
    }
  });
  it('filmstripVfFor 时长非法同样抛 RangeError（比对路径也会调它，不能只在一处防）', () => {
    expect(() => filmstripVfFor(0)).toThrow(RangeError);
    expect(() => filmstripVfFor(Number.NaN)).toThrow(RangeError);
  });
});

describe('filmstripShapeSig(胶片条形状签名)', () => {
  // 这条是「改 tile 数/宽高 → 老图自动判失效」的全部机制所在：签名由这些常量拼出来，
  // 改动常量 → 签名变 → checkDerivedCache 逐字比对不过 → 判失效重画。测试锁住「签名确实跟着常量走」。
  it('签名里带着决定产物形状的四项：schema 版本、格数、宽高、fps 公式', () => {
    const sig = filmstripShapeSig();
    expect(sig).toContain('v1');
    expect(sig).toContain(`tiles=${DERIVED_FILM_TILES}`);
    expect(sig).toContain(`size=${DERIVED_FILM_W}x${DERIVED_FILM_H}`);
    expect(sig).toContain('fps=min(12/T,30)');
  });
  it('同一份代码常量算出的签名恒等（比对是逐字相等，不能有随机/时间成分）', () => {
    expect(filmstripShapeSig()).toBe(filmstripShapeSig());
  });
  // 「改 tile 数/宽高 → 老图判失效」不能只靠本文件断言（ESM 常量只读，改不了），
  // 真正的判据在 derived-images.test.ts：手写一份 tiles=8 / 800x45 的旧签名 meta，断言被拒。
});
