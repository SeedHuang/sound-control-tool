// server/src/media/wave-peaks.test.ts
// Spec B T4 · 波形峰值：**数据从 stderr 解析**（实测 B3b/B3c），不是从文件读。
// 这条链路的三道疤都在这组测试里钉着：reset=1（B3a 480s 超时）、只打一个 key、空数据必须明确失败。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type DB } from '../db/index.js';
import { WAVE_NSAMPLES } from '../ffmpeg/derived-args.js';
import type { ExecLike } from './derived-images.js';
import { buildWavePeakJson, ensureWavePeaks, parseRmsStderr } from './wave-peaks.js';

let root: string;
let derivedDir: string;
let tempDir: string;
let db: DB;
let stubBin: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sct-wp-'));
  derivedDir = join(root, 'derived');
  tempDir = join(root, 'tmp');
  mkdirSync(tempDir, { recursive: true });
  stubBin = join(root, 'bin');
  mkdirSync(stubBin, { recursive: true });
  writeFileSync(join(stubBin, 'ffmpeg.exe'), '');
  writeFileSync(join(stubBin, 'ffprobe.exe'), '');
  db = openDatabase(':memory:');
});
afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

/** 造 astats 的 stderr：B3b 的真实输出形态 —— 每窗一行 `lavfi.astats.Overall.RMS_level=<值>` */
function rmsStderr(values: (number | string)[]): string {
  const lines = ['frame:0    pts:0       pts_time:0'];
  values.forEach((v, i) => {
    lines.push(`frame:${i} pts:${i * 3840} pts_time:${(i * 3840) / 48000}`);
    lines.push(`lavfi.astats.Overall.RMS_level=${v}`);
  });
  return lines.join('\n');
}
function execStderrStub(stderr: string, onCall?: (args: string[]) => void) {
  const calls: string[][] = [];
  const fn = ((_bin: string, args: string[], _o: unknown, cb: (e: Error | null, out: string, err: string) => void) => {
    calls.push(args);
    onCall?.(args);
    cb(null, '', stderr);
  }) as unknown as ExecLike;
  return { fn, calls };
}
const resolveOk = async (): Promise<string | null> => join(stubBin, 'ffmpeg.exe');
/** 实测素材 media-13 的真实时长（ffmpeg-measure-report 素材表） */
const LONG = 1290.325333;

describe('parseRmsStderr（从 stderr 提 RMS，实测 B3b 的输出形态）', () => {
  it('1600 个有限值 → 解析出 1600 个点，顺序不乱', () => {
    const vals = Array.from({ length: 1600 }, (_, i) => -20 + (i % 7));
    expect(parseRmsStderr(rmsStderr(vals))).toEqual(vals);
  });

  // -inf 在 JSON 里是非法字面量（JSON.stringify 会写成 null，前端 parse 后画不出还报 NaN 错）→ 折成 -99
  it('-inf → -99', () => {
    expect(parseRmsStderr(rmsStderr([-20, '-inf', -30]))).toEqual([-20, -99, -30]);
  });

  it('inf / -inf / nan 一律归 -99（宁可信「静音」也不给前端 NaN）', () => {
    expect(parseRmsStderr(rmsStderr(['inf', '-inf', 'nan']))).toEqual([-99, -99, -99]);
  });

  // ffmpeg 的进度行/统计行混在 stderr 里，不能误当数据
  it('非 RMS 行忽略', () => {
    const s = `size=N/A time=00:00:24.00 bitrate=N/A speed=1.0x\n${rmsStderr([-21])}`;
    expect(parseRmsStderr(s)).toEqual([-21]);
  });

  // 由调用方明确失败，不落空 JSON（诚实原则：宁可报错也不给「一条平线」）
  it('一个 RMS 行都没有 → 返回空数组', () => {
    expect(parseRmsStderr('size=N/A time=00:00:24.00')).toEqual([]);
  });
});

describe('buildWavePeakJson（凭据字段固定，spec D4）', () => {
  it('含 v/sig/level/seg/t0/stepSec/points 七项，JSON 可被 JSON.parse', () => {
    const j = buildWavePeakJson({ level: 1, seg: 3, t0: 384, stepSec: 0.08, points: [-20, -99, -30] });
    const o = JSON.parse(j) as Record<string, unknown>;
    expect(Object.keys(o).sort()).toEqual(['level', 'points', 'seg', 'sig', 'stepSec', 't0', 'v']);
    expect(o.level).toBe(1);
    expect(o.seg).toBe(3);
    expect(o.t0).toBe(384);
    expect(o.points).toEqual([-20, -99, -30]);
  });

  it('sig 由 level 派生（改档位 → 老 JSON 判失效）', () => {
    const a = JSON.parse(buildWavePeakJson({ level: 0, seg: 0, t0: 0, stepSec: 1, points: [-1] })) as { sig: string };
    const b = JSON.parse(buildWavePeakJson({ level: 2, seg: 0, t0: 0, stepSec: 0.015, points: [-1] })) as { sig: string };
    expect(a.sig).toContain('level=0');
    expect(b.sig).toContain('level=2');
    expect(a.sig).not.toBe(b.sig);
  });
});

describe('ensureWavePeaks（生成 + 缓存）', () => {
  it('L1 第 3 段 → 调一次 ffmpeg（-f null -），产物 wavepeak-<id>-L1-3.json，t0=384', async () => {
    const { fn, calls } = execStderrStub(rmsStderr(Array.from({ length: 1600 }, () => -22)));
    const r = await ensureWavePeaks({ level: 1, seg: 3, importId: 1, videoPath: 'v.mp4', derivedDir, tempDir, db, durationSec: LONG, doExec: fn, resolveFfmpeg: resolveOk });
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]![calls[0]!.indexOf('-f') + 1]).toBe('null');
    const p = join(derivedDir, 'wavepeak-1-L1-3.json');
    expect(existsSync(p)).toBe(true);
    const o = JSON.parse(readFileSync(p, 'utf8')) as { points: number[]; seg: number; t0: number; stepSec: number };
    expect(o.points).toHaveLength(1600);
    expect(o.seg).toBe(3);
    expect(o.t0).toBeCloseTo(384, 2);
    expect(o.stepSec).toBeCloseTo(128 / 1600, 5); // span / points.length = 0.08
  });

  it('L0 走全片：-ss/-t 都不带，N=48000，文件名不带段号', async () => {
    const { fn, calls } = execStderrStub(rmsStderr(Array.from({ length: 1290 }, () => -20)));
    const r = await ensureWavePeaks({ level: 0, seg: 0, importId: 2, videoPath: 'v.mp4', derivedDir, tempDir, db, durationSec: LONG, doExec: fn, resolveFfmpeg: resolveOk });
    expect(r.ok).toBe(true);
    expect(calls[0]).not.toContain('-ss');
    expect(calls[0]).not.toContain('-t');
    expect(calls[0]![calls[0]!.indexOf('-af') + 1]).toContain(`asetnsamples=${WAVE_NSAMPLES[0]}`);
    expect(existsSync(join(derivedDir, 'wavepeak-2-L0.json'))).toBe(true);
  });

  // 末段按实际余数收窄窗口（不虚构超出片尾的时间）——1290.33s / 128s 的第 11 段只有 10.33s
  it('末段窗长按 segmentSpan 收窄：第 11 段 -t 不是 128 而是余数', async () => {
    const { fn, calls } = execStderrStub(rmsStderr(Array.from({ length: 129 }, () => -20)));
    await ensureWavePeaks({ level: 1, seg: 10, importId: 3, videoPath: 'v.mp4', derivedDir, tempDir, db, durationSec: LONG, doExec: fn, resolveFfmpeg: resolveOk });
    const af = calls[0]!;
    expect(af[af.indexOf('-ss') + 1]).toBe('1280');
    const t = Number(af[af.indexOf('-t') + 1]);
    expect(t).toBeCloseTo(LONG - 1280, 2);
    expect(t).toBeLessThan(128);
  });

  it('命中缓存 → 零 ffmpeg（第二遍 cached:true）', async () => {
    const first = execStderrStub(rmsStderr(Array.from({ length: 1600 }, () => -22)));
    await ensureWavePeaks({ level: 1, seg: 0, importId: 4, videoPath: 'v.mp4', derivedDir, tempDir, db, durationSec: LONG, doExec: first.fn, resolveFfmpeg: resolveOk });
    const second = execStderrStub(rmsStderr(Array.from({ length: 1600 }, () => -22)));
    const r = await ensureWavePeaks({ level: 1, seg: 0, importId: 4, videoPath: 'v.mp4', derivedDir, tempDir, db, durationSec: LONG, doExec: second.fn, resolveFfmpeg: resolveOk });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.cached).toBe(true);
    expect(second.calls).toHaveLength(0);
  });

  // 诚实原则：没有数据就说没有，不落空 JSON 让前端画一条假平线
  it('stderr 没有 RMS 行 → FFMPEG_FAIL，不落空 JSON', async () => {
    const { fn } = execStderrStub('size=N/A time=00:00:24.00 bitrate=N/A');
    const r = await ensureWavePeaks({ level: 1, seg: 0, importId: 5, videoPath: 'v.mp4', derivedDir, tempDir, db, durationSec: LONG, doExec: fn, resolveFfmpeg: resolveOk });
    expect(r).toMatchObject({ ok: false, code: 'FFMPEG_FAIL' });
    expect(existsSync(join(derivedDir, 'wavepeak-5-L1-0.json'))).toBe(false);
  });

  it('ffmpeg 报错（带 stderr）→ FFMPEG_FAIL 且 message 含 stderr 尾行（三参回调，仓库规则）', async () => {
    const err = Object.assign(new Error('boom'), { code: 1 });
    const fn = ((_b: string, _a: string[], _o: unknown, cb: (e: Error | null, o: string, er: string) => void) => {
      cb(err, '', 'noise\nOutput file does not contain any stream');
    }) as unknown as ExecLike;
    const r = await ensureWavePeaks({ level: 1, seg: 0, importId: 6, videoPath: 'v.mp4', derivedDir, tempDir, db, durationSec: LONG, doExec: fn, resolveFfmpeg: resolveOk });
    expect(r).toMatchObject({ ok: false, code: 'FFMPEG_FAIL' });
    if (!r.ok) expect(r.message).toContain('does not contain any stream');
    expect(existsSync(join(derivedDir, 'wavepeak-6-L1-0.json'))).toBe(false);
  });

  it('ffmpeg 拿不到 → NO_FFMPEG，不调 doExec', async () => {
    const { fn, calls } = execStderrStub(rmsStderr([-1]));
    const r = await ensureWavePeaks({ level: 0, seg: 0, importId: 7, videoPath: 'v.mp4', derivedDir, tempDir, db, durationSec: LONG, doExec: fn, resolveFfmpeg: async () => null });
    expect(r).toMatchObject({ ok: false, code: 'NO_FFMPEG' });
    expect(calls).toHaveLength(0);
  });

  // stepSec 若硬算 n/48000，非 48kHz 素材上波形会与时间轴错位（点数按采样率比例偏移，span 是定值）
  it('stepSec 用实际点数反推（span / points.length）：44.1kHz 源不按 48kHz 算', async () => {
    // 模拟 44.1kHz：128s 窗 / 3840 采样 → 128×44100/3840 ≈ 1470 个窗（而不是 1600）
    const { fn } = execStderrStub(rmsStderr(Array.from({ length: 1470 }, () => -22)));
    const r = await ensureWavePeaks({ level: 1, seg: 0, importId: 8, videoPath: 'v.mp4', derivedDir, tempDir, db, durationSec: LONG, doExec: fn, resolveFfmpeg: resolveOk });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.points).toHaveLength(1470);
      expect(r.data.stepSec).toBeCloseTo(128 / 1470, 6);
      expect(r.data.stepSec).not.toBeCloseTo(0.08, 3); // 硬算 3840/48000 的结果
    }
  });

  // 素材换源后旧峰值 JSON 凭 sig 自洽会永久命中 —— 必须在 rename 前拦住（与 PNG 同款变局分类器）
  it('素材在生成期间被替换 → SRC_CHANGED，产物丢弃不落盘', async () => {
    const src = join(root, 'wave-src.mp4');
    writeFileSync(src, 'old-content');
    const fn = ((_b: string, _a: string[], _o: unknown, cb: (e: Error | null, o: string, er: string) => void) => {
      const st = statSync(src);
      utimesSync(src, st.atime, new Date(st.mtimeMs + 5000)); // 显式 +5s：同毫秒写两次 mtime 可能相等
      cb(null, '', rmsStderr([-20, -21]));
    }) as unknown as ExecLike;
    const r = await ensureWavePeaks({ level: 0, seg: 0, importId: 9, videoPath: src, derivedDir, tempDir, db, durationSec: 60, doExec: fn, resolveFfmpeg: resolveOk });
    expect(r).toMatchObject({ ok: false, code: 'SRC_CHANGED' });
    expect(existsSync(join(derivedDir, 'wavepeak-9-L0.json'))).toBe(false);
  });

  it('sourceState 判 gone（素材被整个删除）→ SRC_CHANGED，文案引导重下（与 replaced 分开）', async () => {
    const src = join(root, 'wave-gone.mp4');
    writeFileSync(src, 'orphan');
    const { fn } = execStderrStub(rmsStderr([-20]));
    const r = await ensureWavePeaks({ level: 0, seg: 0, importId: 10, videoPath: src, derivedDir, tempDir, db, durationSec: 60, doExec: fn, resolveFfmpeg: resolveOk, sourceState: () => 'gone' });
    expect(r).toMatchObject({ ok: false, code: 'SRC_CHANGED' });
    if (!r.ok) expect(r.message).toContain('被删除');
    expect(existsSync(join(derivedDir, 'wavepeak-10-L0.json'))).toBe(false);
  });

  // 2026-10-03 OCR 审查第 5 轮 medium：原来这里只挡段号越界，**不挡档位门槛** ——
  // 于是素材放不下该档时 /filmseg 返 404 而 /wavepeak 仍 200 返回数据（同一档位两个产物结论相反）。
  // 这条锁住「与分段雪碧图同一份判定」：2 秒素材要 L1 → LEVEL_UNAVAILABLE，且**不起 ffmpeg**。
  it('档位不可用 → LEVEL_UNAVAILABLE，与分段雪碧图同一口径（不起 ffmpeg）', async () => {
    const { fn, calls } = execStderrStub(rmsStderr([-20]));
    const r = await ensureWavePeaks({ level: 1, seg: 0, importId: 12, videoPath: 'v.mp4', derivedDir, tempDir, db, durationSec: 2, doExec: fn, resolveFfmpeg: resolveOk });
    expect(r).toMatchObject({ ok: false, code: 'LEVEL_UNAVAILABLE' });
    if (!r.ok) expect(r.message).toContain('128');
    expect(calls).toHaveLength(0);
  });

  it('temp/ 不留临时 JSON 残留', async () => {
    const { fn } = execStderrStub(rmsStderr(Array.from({ length: 1600 }, () => -22)));
    await ensureWavePeaks({ level: 1, seg: 1, importId: 11, videoPath: 'v.mp4', derivedDir, tempDir, db, durationSec: LONG, doExec: fn, resolveFfmpeg: resolveOk });
    expect(existsSync(join(derivedDir, 'wavepeak-11-L1-1.json'))).toBe(true);
    expect(readdirSync(tempDir)).toHaveLength(0);
  });
});
