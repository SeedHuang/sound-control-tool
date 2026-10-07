import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AUDIO_WAVE_TARGET_POINTS,
  DERIVED_FILM_H, DERIVED_FILM_TILES, DERIVED_FILM_W,
  FILM_CELL_H, FILM_CELL_PATTERN, FILM_CELL_W, FILM_LEVEL_SPAN_SEC, FILM_LEVEL_TILES, FILM_META_V, FILM_SHEET_W, FILM_TOTAL_TILES, LEVEL2_MIN_DURATION_SEC,
  WAVE_NSAMPLES, WAVE_POINTS_PER_SEG,
  audioWaveNsamples, buildFilmstripArgs, buildWaveformArgs, filmCellName, filmstripShapeSig, filmstripVfFor,
  filmCellArgs, filmShapeSig, filmTileArgs, levelSpanSec, sampleTimes, segmentCount, segmentSpan, tilesFor,
  wavePeakArgs, waveShapeSig, waveaudioShapeSig,
} from './derived-args.js';

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

// —— 跨包常量护栏（2026-10-03 OCR 审查第 2 轮 medium）——
// web 包**不能 import server 的代码**（两个独立 tsconfig / 依赖图不通），所以窗长、成品宽、档位门槛
// 在 `web/src/components/TimelineWave.tsx` 里各有一份副本。副本漂移**没有任何编译或测试信号**：
// 服务端改格数/格宽/窗长后，前端会算出错的显示高（轨道留空白）与错的档位门槛。
// 下面这组断言把两个文件**对着读**：从 web 源文件里正则抓出实际字面量，与本文件的导出逐一比对。
// 漂移时它们会红 —— 这是「同一口径只此一份」这条硬约束在跨包场景下唯一的自动化信号。
describe('跨包常量护栏：web 副本必须与服务端一致', () => {
  // vitest 的 cwd = server 包根，所以 web 副本在 ../web（不是 ../../web —— 那是 D:\Seed\web）
  const webPath = resolve(process.cwd(), '../web/src/components/TimelineWave.tsx');
  const webSrc = readFileSync(webPath, 'utf8');

  const num = (name: string): number => {
    const m = new RegExp(`${name}[^=]*=\\s*(\\d+)`).exec(webSrc);
    if (m === null) throw new Error(`web/src/components/TimelineWave.tsx 里找不到 ${name} 的字面量 —— 改名/重构后请同步本护栏`);
    return Number(m[1]);
  };

  /** 从 web 的对象字面量里取第 lv 档的值（值可能是算式如 `36 * 160`，eval 的是**我们自己写的**文件内容，非外部输入） */
  const webLevelValue = (name: string, lv: 0 | 1 | 2): number => {
    const m = new RegExp(`${name}:[^=]*=\\s*\\{([^}]*)\\}`).exec(webSrc);
    if (m === null) throw new Error(`web 里找不到 ${name} 的对象字面量 —— 改名/重构后请同步本护栏`);
    const entry = m[1]!.split(',').find((s) => s.trim().startsWith(`${lv}:`));
    if (entry === undefined) throw new Error(`web 的 ${name} 里没有第 ${lv} 档`);
    // eslint-disable-next-line no-new-func
    return Function(`"use strict";return (${entry.trim().split(':')[1]!.trim()});`)() as number;
  };

  it('窗长：web 的 LEVEL_SPAN_SEC 与服务端 FILM_LEVEL_SPAN_SEC 逐档相等', () => {
    expect(webLevelValue('LEVEL_SPAN_SEC', 1)).toBe(FILM_LEVEL_SPAN_SEC[1]);
    expect(webLevelValue('LEVEL_SPAN_SEC', 2)).toBe(FILM_LEVEL_SPAN_SEC[2]);
  });

  it('成品宽：web 的 FILM_SHEET_W 与服务端一致（改格数/格宽时两处必须同步）', () => {
    expect(webLevelValue('FILM_SHEET_W', 0)).toBe(FILM_SHEET_W[0]);
    expect(webLevelValue('FILM_SHEET_W', 1)).toBe(FILM_SHEET_W[1]);
    expect(webLevelValue('FILM_SHEET_W', 2)).toBe(FILM_SHEET_W[2]);
  });

  it('L2 门槛：web 的 LEVEL2_MIN_DURATION_SEC 必须等于服务端导出的常量（不是硬编码 300）', () => {
    // ⚠️ 这条护栏在第 3 轮之前是 `toBe(300)` —— 硬编码字面量，改服务端而不改 web 时它不会红，
    //   护栏形同虚设。现在 import 服务端常量比对（2026-10-03 OCR 审查第 4 轮 medium）。
    expect(num('LEVEL2_MIN_DURATION_SEC')).toBe(LEVEL2_MIN_DURATION_SEC);
  });
});

// —— Spec B 时间轴分级（2026-10-03）——
// 下面四个块锁的是「定死项」：数值来自 ffmpeg-measure-report §B 组实测（见 plan 的 Global Constraints 参数表）。
// 改这些数字 = 改 spec，必须先改 spec 再改这里。

describe('档位常量（定死项，改这里等于改 spec）', () => {
  it('L0=36 格铺满全片，L1/L2 各 12 格；窗长 128s / 24s', () => {
    expect(FILM_TOTAL_TILES).toBe(36);
    expect(FILM_LEVEL_TILES[0]).toBe(36);
    expect(FILM_LEVEL_TILES[1]).toBe(12);
    expect(FILM_LEVEL_TILES[2]).toBe(12);
    expect(FILM_LEVEL_SPAN_SEC[1]).toBe(128);
    expect(FILM_LEVEL_SPAN_SEC[2]).toBe(24);
  });

  it('格子 160×90；波形段目标 1600 点；三档 N=48000/3840/720', () => {
    expect(FILM_CELL_W).toBe(160);
    expect(FILM_CELL_H).toBe(90);
    expect(WAVE_POINTS_PER_SEG).toBe(1600);
    expect(WAVE_NSAMPLES[0]).toBe(48000);
    expect(WAVE_NSAMPLES[1]).toBe(3840);
    expect(WAVE_NSAMPLES[2]).toBe(720);
  });

  // 这条是「N 的选取不是随手拍的」的全部依据：span×48000÷N 必须恒等于 1600 点/段。
  // 改任一档的 N 而不改另一个，会让两档的点密度不一致（前端画出的疏密会突变）。
  it('L1 段 128s → 1600 点，L2 段 24s → 1600 点（48kHz 口径：span×48000÷N = 1600）', () => {
    expect((128 * 48000) / WAVE_NSAMPLES[1]).toBe(1600);
    expect((24 * 48000) / WAVE_NSAMPLES[2]).toBe(1600);
  });

  it('FILM_META_V 升到 3：老 v2 的图与 meta 全部判失效（spec D4）', () => {
    expect(FILM_META_V).toBe(3);
  });
});

describe('分段与采样点（采样点取区间起点，沿用 N0 语义）', () => {
  const T = 1290.325333; // 实测素材 media-13 的真实时长（ffmpeg-measure-report 素材表）

  it('L0 段数为 1，窗长 = 整片（0 是哨兵「不切段」）', () => {
    expect(segmentCount(T, 0)).toBe(1);
    expect(levelSpanSec(0, T)).toBe(T);
  });

  it('L1：1290.33s / 128s → 11 段（最后一段是余数）', () => {
    expect(segmentCount(T, 1)).toBe(11);
  });

  it('L2：1290.33s / 24s → 54 段', () => {
    expect(segmentCount(T, 2)).toBe(54);
  });

  // 采样点约定沿用 N0：**每格取区间起点**（spec §5 明确保持）。
  // 后果：末格落在 35/36 处而不是片尾 —— 末格差一格是 tile 数学约定，spec 明确接受，不要"修"。
  it('L0 的 36 个采样点 = 区间起点（末格落在 35/36 处，不是片尾）', () => {
    const ts = sampleTimes(T, 0, 0);
    expect(ts).toHaveLength(36);
    expect(ts[0]).toBe(0);
    expect(ts[1]).toBeCloseTo((T * 1) / 36, 2);
    expect(ts[35]).toBeCloseTo((T * 35) / 36, 2);
    expect(ts[35]).toBeLessThan(T);
  });

  it('L1 段内 12 个采样点；末段不足整窗时按实际 span 取点（不越界）', () => {
    const ts = sampleTimes(T, 1, 0);
    expect(ts).toHaveLength(12);
    expect(ts[0]).toBeCloseTo(0, 2);
    expect(ts[11]).toBeCloseTo((128 * 11) / 12, 2);
    const last = sampleTimes(T, 1, 10); // 第 11 段 = 1280 → 1290.33，余 10.33s
    expect(last[0]).toBeCloseTo(1280, 2);
    expect(Math.max(...last)).toBeLessThan(T);
  });

  it('L2 段内 12 格、格距 2s（24s 窗）', () => {
    const ts = sampleTimes(T, 2, 3);
    expect(ts).toHaveLength(12);
    expect(ts[0]).toBeCloseTo(72, 2);
    expect(ts[1]).toBeCloseTo(74, 2);
  });

  it('segmentSpan：非末段 span=整窗；末段 span=余数（不虚构超出片尾的时间）', () => {
    expect(segmentSpan(T, 1, 0)).toEqual({ t0: 0, span: 128 });
    const tail = segmentSpan(T, 1, 10);
    expect(tail.t0).toBeCloseTo(1280, 2);
    expect(tail.span).toBeCloseTo(T - 1280, 2);
  });

  // 时长未知时退化出图是 N0 修掉的真实缺陷（21:30 的片子只画出开头 12 秒，PNG 却看着完全正常）。
  // Spec B 的每个入口函数都必须在这里拦住，**不能只在某一个函数里防**。
  it('时长非法（0/NaN/负）→ 抛 RangeError，绝不退化出图', () => {
    for (const bad of [0, Number.NaN, -1]) {
      expect(() => segmentCount(bad, 1)).toThrow(RangeError);
      expect(() => sampleTimes(bad, 0, 0)).toThrow(RangeError);
    }
  });
});

describe('逐格 seek 与 tile 拼接参数（实测 B1/B2）', () => {
  const T = 1290.325333; // 实测素材 media-13 的真实时长（与「分段与采样点」块同源）
  // ⚠️ 2026-10-03（OCR 审查）：`-vf` 从 `scale=-1:90` 改成固定 `scale=160:90` ——
  // 逐格 + tile 下「宽度随素材比例浮动」会让 filmShapeSig 的 cell / FILM_SHEET_W / 消费方显示高三处口径对不上。
  it('filmCellArgs：-ss 在 -i 前（快速 seek）+ -frames:v 1 + 固定 160:90（签名要如实反映产物）', () => {
    const args = filmCellArgs('v.mp4', 'c0.png', 512);
    expect(args.slice(0, 2)).toEqual(['-y', '-ss']);
    expect(args).toContain('512');
    expect(args[args.indexOf('-i') + 1]).toBe('v.mp4');
    expect(args[args.indexOf('-vf') + 1]).toBe('scale=160:90');
    expect(args[args.indexOf('-frames:v') + 1]).toBe('1');
    expect(args[args.length - 1]).toBe('c0.png');
  });

  it('filmTileArgs：-start_number 0 + 序列模式 + tile=Nx1；路径用 join 拼（不硬编码反斜杠）', () => {
    const args = filmTileArgs('sheet.png', 'D:\\tmp', 12);
    expect(args[args.indexOf('-start_number') + 1]).toBe('0');
    expect(args[args.indexOf('-i') + 1]).toBe(join('D:\\tmp', FILM_CELL_PATTERN));
    expect(args[args.indexOf('-i') + 1]).toContain('cell-%02d.png'); // 位宽 2 与生成端一致
    expect(args[args.indexOf('-vf') + 1]).toBe('tile=12x1');
    expect(args[args.length - 1]).toBe('sheet.png');
  });

  // 序列契约只有这一份（OCR 审查发现：生成端与消费端曾各写一份 padStart(2) / %02d）
  it('序列契约单一来源：filmCellName 与 FILM_CELL_PATTERN 位宽一致（生成端与 tile 端必须对得上）', () => {
    expect(FILM_CELL_PATTERN).toBe('cell-%02d.png');
    expect(filmCellName(0)).toBe('cell-00.png');
    expect(filmCellName(11)).toBe('cell-11.png');
    // 位宽 2 的上限：一次最多 99 格
    expect(filmCellName(99)).toBe('cell-99.png');
  });

  // 成品图宽 = 格数 × 格宽（消费方 studio-detail.tsx 按它换算显示高）
  it('FILM_SHEET_W：L0=36×160=5760，L1/L2=12×160=1920（消费方按它算显示高）', () => {
    expect(FILM_SHEET_W[0]).toBe(5760);
    expect(FILM_SHEET_W[1]).toBe(1920);
    expect(FILM_SHEET_W[2]).toBe(1920);
    expect(FILM_SHEET_W[0]).toBe(FILM_LEVEL_TILES[0] * FILM_CELL_W);
  });

  // 窗长必须在 sig 里（2026-10-03 OCR 审查第 7 轮 medium）：它决定图覆盖哪段时间，
  // 而 tiles/cell 与它独立 —— 改窗长时若 sig 不变，老段图继续命中 → 时间轴静默错位。
  it('filmShapeSig 带窗长（L0=full、L1=128、L2=24），改窗长签名必变', () => {
    expect(filmShapeSig(0, 36)).toContain('span=full');
    expect(filmShapeSig(1, 12)).toContain(`span=${FILM_LEVEL_SPAN_SEC[1]}`);
    expect(filmShapeSig(2, 12)).toContain(`span=${FILM_LEVEL_SPAN_SEC[2]}`);
    // 窗长不同 → 签名必不同（这正是「改了窗长老图自动判失效」的机制）
    expect(filmShapeSig(1, 12)).not.toBe(filmShapeSig(2, 12));
  });

  // ⚠️ 末段格数与格距的契约（2026-10-03 OCR 审查第 9 轮 medium）：
  //   图名义时长（tiles×cellSpan）不能**超出太多** —— 超出部分会被前端按跨度收窄的框压缩（压扁）。
  //   floor 保证「不因取整而多出一格」；兜底的 1 格允许**至多一格**的超出（末段连一格都装不下时）。
  it('末段：floor 取格 → 多余的格跨度至多一格，且格距恒为整窗格宽（格位置全局一致）', () => {
    const cellSpan = FILM_LEVEL_SPAN_SEC[1] / FILM_LEVEL_TILES[1]; // 128/12 ≈ 10.667
    for (const seg of [0, 5, 10]) { // 整窗段 / 中间段 / 末段
      const tiles = tilesFor(T, 1, seg);
      const span = segmentSpan(T, 1, seg).span;
      // 超出的格跨度 < 1 格（floor 的语义），而不是「超出任意多格」
      expect(tiles * cellSpan - span).toBeLessThan(cellSpan + 1e-6);
      // 格距恒定（不随 span 浮动）→ 同一根像素竖线在所有段对应的时刻相同
      const ts = sampleTimes(T, 1, seg);
      if (tiles >= 2) expect((ts[1] ?? 0) - (ts[0] ?? 0)).toBeCloseTo(cellSpan, 2);
    }
    // 末段至少 1 格（否则纯空白）；且不超过整窗格数
    const last = tilesFor(T, 1, 10);
    expect(last).toBeGreaterThanOrEqual(1);
    expect(last).toBeLessThanOrEqual(FILM_LEVEL_TILES[1]);
  });

  // L0 的格距必须仍按「全片 1/36」（N0 起的采样约定：末格落在 35/36 处，不是片尾）
  it('L0 格距 = duration/36（不因统一格距而变成 0）', () => {
    const ts = sampleTimes(1290.325333, 0, 0);
    expect(ts).toHaveLength(36);
    expect(ts[1]).toBeCloseTo(1290.325333 / 36, 2);
    expect(ts[35]).toBeCloseTo((1290.325333 * 35) / 36, 2);
  });

  // sig 是「改常量 → 老图自动判失效」的唯一机制：签名必须真的由这些常量派生。
  it('filmShapeSig / waveShapeSig：带 level 与关键参数，改常量签名自动跟着变', () => {
    expect(filmShapeSig(0, 36)).toContain('level=0');
    expect(filmShapeSig(1, 12)).toContain('level=1');
    expect(filmShapeSig(1, 12)).toContain('tiles=12');
    expect(filmShapeSig(1, 12)).toContain(`cell=${FILM_CELL_W}x${FILM_CELL_H}`);
    expect(filmShapeSig(0, 36)).toContain(`v${FILM_META_V}`);
    expect(waveShapeSig(2)).toContain('level=2');
    expect(waveShapeSig(2)).toContain(`n=${WAVE_NSAMPLES[2]}`);
  });
});

describe('波形峰值参数（实测 B3b/B3c；严禁字面 reset=44100 全键打印）', () => {
  it('L0 全片：无 -ss/-t，N=48000', () => {
    const args = wavePeakArgs('v.mp4', null, 48000);
    expect(args).not.toContain('-ss');
    expect(args).not.toContain('-t');
    expect(args[args.indexOf('-af') + 1]).toBe(
      'asetnsamples=48000,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level',
    );
    expect(args[args.length - 1]).toBe('-');
  });

  it('L1/L2 段：-ss <seg起点> -t <span>，N 取对应档', () => {
    const args = wavePeakArgs('v.mp4', { t0: 512, span: 128 }, 3840);
    expect(args[args.indexOf('-ss') + 1]).toBe('512');
    expect(args[args.indexOf('-t') + 1]).toBe('128');
    expect(args[args.indexOf('-af') + 1]).toContain('asetnsamples=3840');
  });

  it('输出走 -f null -（只要 stderr 里的 RMS 行，不落图片）', () => {
    const args = wavePeakArgs('v.mp4', null, 48000);
    expect(args[args.indexOf('-f') + 1]).toBe('null');
  });

  // B3a 的实测代价：字面 `astats=metadata=1:reset=44100` + 不带 key 的 ametadata=print
  // → 480s 超时被杀 + 334.1MB 日志 + 163670 行 RMS。这条断言是那道疤的看守。
  it('防呆：astats 永远是 reset=1 —— 字面 reset=44100 实测 480s 超时 + 334MB 日志（B3a）', () => {
    for (const n of [48000, 3840, 720]) {
      const args = wavePeakArgs('v.mp4', null, n);
      expect(args[args.indexOf('-af') + 1]).toContain('reset=1');
      expect(args.join(' ')).not.toContain('reset=44100');
    }
  });
});

describe('成品波形参数（音频播放器用）', () => {
  it('audioWaveNsamples：按时长反推窗口，恒落在 [1,48000]', () => {
    expect(audioWaveNsamples(30)).toBe(1200);   // 30*48000/1200
    expect(audioWaveNsamples(10)).toBe(400);
    expect(audioWaveNsamples(3600)).toBe(48000); // 超长夹到上界
    expect(audioWaveNsamples(0.1)).toBe(4);      // 极短仍有窗口
  });
  it('audioWaveNsamples：非正/非法时长抛错（不得静默退化）', () => {
    expect(() => audioWaveNsamples(0)).toThrow();
    expect(() => audioWaveNsamples(Number.NaN)).toThrow();
  });
  it('waveaudioShapeSig：含 schema 版本与目标点数（改点数 → 签名变 → 老缓存失效）', () => {
    expect(waveaudioShapeSig()).toContain(`v${FILM_META_V}`);
    expect(waveaudioShapeSig()).toContain(`points=${AUDIO_WAVE_TARGET_POINTS}`);
  });
});
