// server/src/media/derived-pyramid.test.ts
// Spec B T3 · L1/L2 分段雪碧图：真实临时目录 + 注入 doExec/probe，不真拉 ffmpeg。
// 这一层只负责「段」这层概念（门槛判定 / 段 meta / 单段生成），缓存与落盘复用 derived-images.ts 的地基。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type DB } from '../db/index.js';
import { FILM_LEVEL_TILES, tilesFor } from '../ffmpeg/derived-args.js';
import type { ExecLike } from './derived-images.js';
import { checkLevelAvailable, ensureFilmSegment, segmentFileMeta } from './derived-pyramid.js';

let root: string;
let derivedDir: string;
let tempDir: string;
let db: DB;
let stubBin: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sct-dp-'));
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

/** 造一个 execFile 桩：记录每次调用，按 behavior 决定写产物/回调错误（不真拉进程） */
function execStub(behavior: (outPath: string) => { err?: Error; stderr?: string; write?: string }) {
  const calls: Array<{ bin: string; args: string[] }> = [];
  const fn = ((bin: string, args: string[], _opts: unknown, cb: (e: Error | null, out: string, err: string) => void) => {
    calls.push({ bin, args });
    const outPath = args[args.length - 1]!;
    const b = behavior(outPath);
    if (b.write !== undefined) writeFileSync(outPath, b.write);
    if (b.err !== undefined) cb(b.err, '', b.stderr ?? '');
    else cb(null, '', b.stderr ?? '');
  }) as unknown as ExecLike;
  return { fn, calls };
}

// ffprobe 兄弟文件必须真实存在（F3 后生成路径会 existsSync 它）→ 指向 beforeEach 造的 bin 目录
const resolveOk = async (): Promise<string | null> => join(stubBin, 'ffmpeg.exe');
/** 实测素材 media-13 的真实时长（ffmpeg-measure-report 素材表） */
const LONG = 1290.325333;

describe('checkLevelAvailable（档位门槛，spec D5）', () => {
  it('L0 永远可用（它就是「整片一张」，任何长度都需要）', () => {
    expect(checkLevelAvailable(10, 0)).toEqual({ ok: true });
  });

  it('L2 需 duration > 300（D5 取整到 5 分钟）；300 整不可用，301 可用', () => {
    expect(checkLevelAvailable(300, 2).ok).toBe(false);
    expect(checkLevelAvailable(301, 2).ok).toBe(true);
  });

  it('L1 需至少一个整窗（128s）：128 整可用，127 不可用', () => {
    expect(checkLevelAvailable(128, 1).ok).toBe(true);
    expect(checkLevelAvailable(127, 1).ok).toBe(false);
  });

  // 「不可用」时文案必须说清「多长才能用」，否则用户只知道失败、不知道怎么办（D5 诚实原则）
  it('不可用时 message 说清需要多长，不是只说「失败」', () => {
    const r = checkLevelAvailable(100, 2);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('300');
    const r1 = checkLevelAvailable(100, 1);
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.message).toContain('128');
  });
});

describe('segmentFileMeta（段 meta 凭据）', () => {
  it('L1 整窗段：v=3、level=1、tiles=12、sig 带 level=1', () => {
    const m = segmentFileMeta(LONG, 1, 0);
    expect(m.v).toBe(3);
    expect(m.level).toBe(1);
    expect(m.tiles).toBe(FILM_LEVEL_TILES[1]);
    expect(m.sig).toContain('level=1');
    expect(m.sig).toContain('tiles=12');
    expect(m.durationSec).toBe(LONG);
  });

  // ⚠️ 末段必须**少拼几格**（2026-10-03 OCR 审查第 6 轮 medium）：前端显示框按实际跨度收窄，
  //   图若仍恒 12 格（1920 宽）就会被 fill 压成竖条、画面不可辨认。1290.33s 的 L1 末段只剩 10.33s。
  it('L1 末段：tiles 按实际跨度收窄（不再恒 12），sig 里的 tiles 同步', () => {
    const m = segmentFileMeta(LONG, 1, 10);
    expect(m.tiles).toBeLessThan(FILM_LEVEL_TILES[1]);
    expect(m.tiles).toBeGreaterThanOrEqual(1);
    expect(m.sig).toContain(`tiles=${m.tiles}`);
  });

  it('L2 整窗段：level=2、tiles 仍 12（两档都是 12 格，差别在窗长）', () => {
    const m = segmentFileMeta(LONG, 2, 0);
    expect(m.level).toBe(2);
    expect(m.tiles).toBe(12);
    expect(m.sig).toContain('level=2');
  });

  // 签名里不许有时间/随机成分 —— 否则「同一段算两次」判不出来（命中比对是逐字相等）。
  // generatedAt 是纯记录字段，明确排除在比对之外。
  it('同段重复算出的 meta 逐字相同（只排除 generatedAt 这个纯记录字段）', () => {
    const a = segmentFileMeta(600, 2, 5);
    const b = segmentFileMeta(600, 2, 5);
    expect({ ...a, generatedAt: '' }).toEqual({ ...b, generatedAt: '' });
  });

  // 边界文案不能自相矛盾（2026-10-03 OCR 审查第 3 轮 low）：299.6s 被拒时若四舍五入成「300s」，
  // 用户会看到「素材时长 300s，放不下 300s 的时间窗」—— 展示值必须用 floor。
  it('门槛文案不矛盾：299.6s 显示 299s 而不是 300s（L2 严格大于 300）', () => {
    const r = checkLevelAvailable(299.6, 2);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain('299s');
      expect(r.message).not.toContain('300s，放不下');
      expect(r.message).toContain('需超过 300s'); // L2 是严格大于，不能说「以上」
    }
  });
});

describe('ensureFilmSegment（单段生成，复用 derived-images 的缓存/落盘地基）', () => {
  it('L1 第 0 段 → 12 格 cell + 1 次 tile；第 1 格 -ss=0、第 2 格 -ss=10.67（128/12）', async () => {
    const { fn, calls } = execStub(() => ({ write: 'PNG' }));
    const r = await ensureFilmSegment({ level: 1, seg: 0, importId: 1, videoPath: 'v.mp4', derivedDir, tempDir, db, doExec: fn, probe: async () => LONG, resolveFfmpeg: resolveOk });
    expect(r).toMatchObject({ ok: true, cached: false });
    const cellCalls = calls.filter((c) => c.args.includes('-ss'));
    expect(cellCalls).toHaveLength(12);
    expect(cellCalls[0]!.args[cellCalls[0]!.args.indexOf('-ss') + 1]).toBe('0');
    expect(cellCalls[1]!.args[cellCalls[1]!.args.indexOf('-ss') + 1]).toBe('10.67');
    // -ss 在 -i 之前（与 L0 同一条铁律）
    for (const c of cellCalls) expect(c.args.indexOf('-ss')).toBeLessThan(c.args.indexOf('-i'));
    expect(existsSync(join(derivedDir, 'film-1-L1-0.png'))).toBe(true);
    expect(existsSync(join(derivedDir, 'film-1-L1-0.png.meta'))).toBe(true);
  });

  it('段号落在文件名与 meta 里：L2 第 7 段 → film-<id>-L2-7.png', async () => {
    const { fn } = execStub(() => ({ write: 'PNG' }));
    await ensureFilmSegment({ level: 2, seg: 7, importId: 2, videoPath: 'v.mp4', derivedDir, tempDir, db, doExec: fn, probe: async () => LONG, resolveFfmpeg: resolveOk });
    const m = JSON.parse(readFileSync(join(derivedDir, 'film-2-L2-7.png.meta'), 'utf8')) as { level: number; tiles: number };
    expect(m.level).toBe(2);
    expect(m.tiles).toBe(12);
  });

  // 末段不足整窗时按实际 span 取点，不虚构超出片尾的时间（1290.33s / 128s → 第 11 段 t0=1280，余 10.33s）
  // ⚠️ 2026-10-03 OCR 审查第 6 轮 medium 后修正：末段**不再恒 12 格**（少拼几格才不会被前端压扁），
  //   所以这里的格数断言从「12」改成「与 tilesFor 算出的格数一致」，且末点仍不越界。
  it('末段按实际 span 取点：第 11 段起点 1280、格数收窄、末点不越界', async () => {
    const { fn, calls } = execStub(() => ({ write: 'PNG' }));
    await ensureFilmSegment({ level: 1, seg: 10, importId: 3, videoPath: 'v.mp4', derivedDir, tempDir, db, doExec: fn, probe: async () => LONG, resolveFfmpeg: resolveOk });
    const cellCalls = calls.filter((c) => c.args.includes('-ss'));
    const times = cellCalls.map((c) => Number(c.args[c.args.indexOf('-ss') + 1]));
    expect(times[0]).toBe(1280);
    expect(cellCalls).toHaveLength(tilesFor(LONG, 1, 10)); // 格数按实际跨度收窄
    expect(cellCalls.length).toBeLessThan(12);
    expect(Math.max(...times)).toBeLessThan(LONG);
  });

  // 命中缓存是**常见路径**（用户反复开页面）—— 必须零 ffmpeg 且零 ffprobe（后者是「开页不变慢」的关键）
  it('命中缓存 → cached:true，零 doExec 且零 ffprobe', async () => {
    const first = execStub(() => ({ write: 'PNG' }));
    await ensureFilmSegment({ level: 1, seg: 0, importId: 4, videoPath: 'v.mp4', derivedDir, tempDir, db, doExec: first.fn, probe: async () => LONG, resolveFfmpeg: resolveOk });
    const second = execStub(() => ({ write: 'PNG' }));
    let probeCalls = 0;
    const r = await ensureFilmSegment({ level: 1, seg: 0, importId: 4, videoPath: 'v.mp4', derivedDir, tempDir, db, doExec: second.fn, probe: async () => { probeCalls += 1; return LONG; }, resolveFfmpeg: resolveOk });
    expect(r).toMatchObject({ ok: true, cached: true });
    expect(second.calls).toHaveLength(0);
    expect(probeCalls).toBe(0);
  });

  // 档位不可用：明确失败、不起 ffmpeg（2 秒的素材要 L2 = 画一张几乎全是空白段的图，不如不给）
  it('档位不可用（2s 素材要 L2）→ LEVEL_UNAVAILABLE，不起 ffmpeg', async () => {
    const { fn, calls } = execStub(() => ({ write: 'PNG' }));
    const r = await ensureFilmSegment({ level: 2, seg: 0, importId: 5, videoPath: 'v.mp4', derivedDir, tempDir, db, doExec: fn, probe: async () => 2, resolveFfmpeg: resolveOk });
    expect(r).toMatchObject({ ok: false, code: 'LEVEL_UNAVAILABLE' });
    if (!r.ok) expect(r.message).toContain('300');
    expect(calls).toHaveLength(0);
  });

  it('探测失败 → PROBE_FAIL（不冤判成档位不可用：两种成因、两条出路）', async () => {
    const { fn, calls } = execStub(() => ({ write: 'PNG' }));
    const r = await ensureFilmSegment({ level: 1, seg: 0, importId: 6, videoPath: 'v.mp4', derivedDir, tempDir, db, doExec: fn, probe: async () => null, resolveFfmpeg: resolveOk });
    expect(r).toMatchObject({ ok: false, code: 'PROBE_FAIL' });
    expect(calls).toHaveLength(0);
  });

  it('ffprobe 兄弟文件缺失 → NO_FFMPEG（环境问题，引去设置页；不许冤判 PROBE_FAIL）', async () => {
    const { fn, calls } = execStub(() => ({ write: 'PNG' }));
    const r = await ensureFilmSegment({ level: 1, seg: 0, importId: 7, videoPath: 'v.mp4', derivedDir, tempDir, db, doExec: fn, probe: async () => LONG, resolveFfmpeg: async () => join(stubBin, 'orphan', 'ffmpeg.exe') });
    expect(r).toMatchObject({ ok: false, code: 'NO_FFMPEG' });
    if (!r.ok) expect(r.message).toContain('ffprobe');
    expect(calls).toHaveLength(0);
  });

  it('素材在生成期间被删除 → SRC_CHANGED，产物丢弃（沿用 OCR 变局分类器）', async () => {
    const { fn } = execStub(() => ({ write: 'PNG' }));
    const r = await ensureFilmSegment({
      level: 1, seg: 0, importId: 8, videoPath: join(root, 'gone.mp4'), derivedDir, tempDir, db, doExec: fn,
      probe: async () => LONG, resolveFfmpeg: resolveOk,
      sourceState: () => 'gone', // 登记没了 = 素材被整个删除
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('SRC_CHANGED');
    expect(existsSync(join(derivedDir, 'film-8-L1-0.png'))).toBe(false);
  });

  // 在途 key 必须含段号：否则两段并发会被并成一个任务、两者拿到同一张段图（图是好的，只是不对 —— 用户看不出来）
  it('不同段并发 → 各起各的任务，两个段文件都落盘（key 含段号）', async () => {
    const { fn, calls } = execStub(() => ({ write: 'PNG' }));
    const [a, b] = await Promise.all([
      ensureFilmSegment({ level: 1, seg: 0, importId: 9, videoPath: 'v.mp4', derivedDir, tempDir, db, doExec: fn, probe: async () => LONG, resolveFfmpeg: resolveOk }),
      ensureFilmSegment({ level: 1, seg: 1, importId: 9, videoPath: 'v.mp4', derivedDir, tempDir, db, doExec: fn, probe: async () => LONG, resolveFfmpeg: resolveOk }),
    ]);
    expect(a).toMatchObject({ ok: true });
    expect(b).toMatchObject({ ok: true });
    expect(calls.filter((c) => c.args.includes('-ss'))).toHaveLength(24); // 两段各 12 格
    expect(existsSync(join(derivedDir, 'film-9-L1-0.png'))).toBe(true);
    expect(existsSync(join(derivedDir, 'film-9-L1-1.png'))).toBe(true);
  });

  it('temp/ 不留 cell 残留（13 次调用后临时目录必须干净）', async () => {
    const { fn } = execStub(() => ({ write: 'PNG' }));
    await ensureFilmSegment({ level: 1, seg: 1, importId: 10, videoPath: 'v.mp4', derivedDir, tempDir, db, doExec: fn, probe: async () => LONG, resolveFfmpeg: resolveOk });
    expect(readdirSync(tempDir)).toHaveLength(0);
  });

  // 越界必须明确失败，**不能"夹到最后一段"**：那样图和 URL 说的不是同一段，而且 segmentSpan 会给出
  // span=0 → sampleTimes 算出 12 个相同的点 → 生成一张「12 格全一样」的图 —— 用户看不出来的静默错误。
  // 判定放这里而不是路由层：只有生成层知道时长，而路由为了校验去探时长会毁掉「命中缓存零 ffprobe」。
  it('段号越界 → SEGMENT_NOT_FOUND，不起 ffmpeg', async () => {
    const { fn, calls } = execStub(() => ({ write: 'PNG' }));
    // 1290.33s / 128s → L1 共 11 段（seg 0..10）；seg=99 越界
    const r = await ensureFilmSegment({ level: 1, seg: 99, importId: 12, videoPath: 'v.mp4', derivedDir, tempDir, db, doExec: fn, probe: async () => LONG, resolveFfmpeg: resolveOk });
    expect(r).toMatchObject({ ok: false, code: 'SEGMENT_NOT_FOUND' });
    expect(calls).toHaveLength(0);
  });

  it('末段（最后一段）不算越界：seg = 段数-1 正常生成', async () => {
    const { fn } = execStub(() => ({ write: 'PNG' }));
    const r = await ensureFilmSegment({ level: 1, seg: 10, importId: 13, videoPath: 'v.mp4', derivedDir, tempDir, db, doExec: fn, probe: async () => LONG, resolveFfmpeg: resolveOk });
    expect(r).toMatchObject({ ok: true });
    expect(existsSync(join(derivedDir, 'film-13-L1-10.png'))).toBe(true);
  });
});
