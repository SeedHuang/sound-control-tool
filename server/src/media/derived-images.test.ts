// server/src/media/derived-images.test.ts
// 派生图生成（spec D6/D14）：用真实临时目录 + 注入 doExec/resolveFfmpeg/probe，不真拉 ffmpeg。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type DB } from '../db/index.js';
import { FILM_META_V, filmShapeSig } from '../ffmpeg/derived-args.js';
import { checkDerivedCache, derivedFileName, ensureDerivedImage, invalidateDerived, type ExecLike, type FilmMeta } from './derived-images.js';

let root: string;
let derivedDir: string;
let tempDir: string;
let db: DB;
let stubBin: string; // 桩 ffmpeg/ffprobe 所在目录 —— F3(OCR 复审)后 film 分支会 existsSync(ffprobePath),桩必须是**真文件**

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sct-di-'));
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

// F3(OCR 复审)后 film 分支会 existsSync(ffprobe 兄弟文件),桩路径必须是真文件 —— 指向 beforeEach 造的 bin 目录
const resolveOk = async (): Promise<string | null> => join(stubBin, 'ffmpeg.exe');

describe('ensureDerivedImage', () => {
  it('命中缓存：文件存在且 size>0 → cached:true，且不调 doExec', async () => {
    mkdirSync(derivedDir, { recursive: true });
    writeFileSync(join(derivedDir, 'wave-1.png'), 'PNG');
    const { fn, calls } = execStub(() => ({}));
    const r = await ensureDerivedImage({ kind: 'wave', importId: 1, videoPath: 'v.mp4', derivedDir, tempDir, db, doExec: fn, resolveFfmpeg: resolveOk });
    expect(r).toMatchObject({ ok: true, cached: true });
    expect(calls).toHaveLength(0); // 缓存命中 → 不该起 ffmpeg
  });

  it('零字节不算命中：0 字节 wave-1.png → 真调 doExec（桩写产物）→ cached:false,ok:true', async () => {
    mkdirSync(derivedDir, { recursive: true });
    writeFileSync(join(derivedDir, 'wave-1.png'), ''); // 中断残留的零字节
    const { fn, calls } = execStub(() => ({ write: 'PNG' }));
    const r = await ensureDerivedImage({ kind: 'wave', importId: 1, videoPath: 'v.mp4', derivedDir, tempDir, db, doExec: fn, resolveFfmpeg: resolveOk });
    expect(r).toMatchObject({ ok: true, cached: false });
    expect(calls).toHaveLength(1);
  });

  it('ffmpeg 拿不到 → NO_FFMPEG，不调 doExec（spec D16 不得静默）', async () => {
    const { fn, calls } = execStub(() => ({}));
    const r = await ensureDerivedImage({ kind: 'wave', importId: 1, videoPath: 'v.mp4', derivedDir, tempDir, db, doExec: fn, resolveFfmpeg: async () => null });
    expect(r).toMatchObject({ ok: false, code: 'NO_FFMPEG' });
    expect(calls).toHaveLength(0);
  });

  it('doExec 回调 err（带 stderr）→ FFMPEG_FAIL，message 含 stderr 尾行', async () => {
    const err = Object.assign(new Error('boom'), { code: 1 });
    const { fn } = execStub(() => ({ err, stderr: 'noise line\nCannot find an unused audio input stream' }));
    const r = await ensureDerivedImage({ kind: 'wave', importId: 1, videoPath: 'v.mp4', derivedDir, tempDir, db, doExec: fn, resolveFfmpeg: resolveOk });
    expect(r).toMatchObject({ ok: false, code: 'FFMPEG_FAIL' });
    if (!r.ok) expect(r.message).toContain('Cannot find an unused audio input stream');
  });

  it('doExec 无 err 但不写文件 → FFMPEG_FAIL，message 含「未写出产物」（退出码 0 ≠ 有产物）', async () => {
    const { fn } = execStub(() => ({})); // 回调成功但不产生文件
    const r = await ensureDerivedImage({ kind: 'wave', importId: 1, videoPath: 'v.mp4', derivedDir, tempDir, db, doExec: fn, resolveFfmpeg: resolveOk });
    expect(r).toMatchObject({ ok: false, code: 'FFMPEG_FAIL' });
    if (!r.ok) expect(r.message).toContain('未写出产物');
  });

  it('成功：桩写 PNG → ok:true，dest 存在且 size>0，临时名已被 rename（temp 无残留）', async () => {
    const { fn, calls } = execStub(() => ({ write: 'PNG' }));
    const r = await ensureDerivedImage({ kind: 'wave', importId: 1, videoPath: 'v.mp4', derivedDir, tempDir, db, doExec: fn, resolveFfmpeg: resolveOk });
    expect(r).toMatchObject({ ok: true, cached: false });
    const dest = join(derivedDir, 'wave-1.png');
    expect(existsSync(dest)).toBe(true);
    const tmp = calls[0]!.args[calls[0]!.args.length - 1]!;
    expect(existsSync(tmp)).toBe(false); // 临时名下已无残留
  });

  // Spec B (T2)：L0 的生成方式从「一次 fps 滤镜整解码」改成「36 格逐格 seek + 1 次 tile 拼接」。
  // 旧断言查的是 -vf 里的 fps=0.600000 —— 那条路径已经不存在了（实测 B1：逐格 seek 10.29s vs 整解码 45–52s）。
  it('filmstrip：probe 只用来算采样点，实际执行是 36 次逐格 seek（不再是单次 fps 滤镜）', async () => {
    const { fn, calls } = execStub(() => ({ write: 'PNG' }));
    const r = await ensureDerivedImage({ kind: 'film', importId: 2, videoPath: 'v.mp4', derivedDir, tempDir, db, doExec: fn, probe: async () => 20, resolveFfmpeg: resolveOk });
    expect(r).toMatchObject({ ok: true });
    const cellCalls = calls.filter((c) => c.args.includes('-ss'));
    expect(cellCalls).toHaveLength(36);
    // 每格的 -vf 是固定 160:90（2026-10-03 OCR 审查后：宽度固定，签名/成品宽/消费方才对得上）
    expect(cellCalls[0]!.args[cellCalls[0]!.args.indexOf('-vf') + 1]).toBe('scale=160:90');
    expect(cellCalls.some((c) => c.args.join(' ').includes('fps='))).toBe(false);
  });

  it('filmstrip：探测显式放宽到 60s（2.1GB 大文件 10s 探不完 → 退化成 fps=1 只覆盖前 12 秒）', async () => {
    const timeouts: Array<number | undefined> = [];
    const { fn } = execStub(() => ({ write: 'PNG' }));
    await ensureDerivedImage({ kind: 'film', importId: 2, videoPath: 'v.mp4', derivedDir, tempDir, db, doExec: fn, probe: async (_bin, _file, timeoutMs) => { timeouts.push(timeoutMs); return 1290; }, resolveFfmpeg: resolveOk });
    expect(timeouts).toEqual([60_000]);
  });

  it('filmstrip：探测失败(null)→ PROBE_FAIL，不调 doExec、不产出任何 png（不得出「只覆盖开头」的误导图）', async () => {
    const { fn, calls } = execStub(() => ({ write: 'PNG' }));
    const r = await ensureDerivedImage({ kind: 'film', importId: 2, videoPath: 'v.mp4', derivedDir, tempDir, db, doExec: fn, probe: async () => null, resolveFfmpeg: resolveOk });
    expect(r).toMatchObject({ ok: false, code: 'PROBE_FAIL' });
    // ⚠️ 断言「读不出素材」这个**语义**，不再钉具体措辞（2026-10-03 OCR 审查第 12 轮 medium）：
    //   probeDurationFor 也服务波形峰值链路，措辞已改为产物中性（原先写「无法生成画轨」会让
    //   波形失败时报出不相干的产物名）。这里要守住的是「用户被告知素材读不出」而不是「画轨」二字。
    if (!r.ok) expect(r.message).toContain('素材信息读取失败');
    expect(calls).toHaveLength(0); // 没起 ffmpeg
    expect(existsSync(join(derivedDir, 'film-2.png'))).toBe(false); // 也没落任何图
  });

  it('filmstrip：探测得到 0 秒（坏文件）同样按 PROBE_FAIL 处理，不出图', async () => {
    const { fn, calls } = execStub(() => ({ write: 'PNG' }));
    const r = await ensureDerivedImage({ kind: 'film', importId: 2, videoPath: 'v.mp4', derivedDir, tempDir, db, doExec: fn, probe: async () => 0, resolveFfmpeg: resolveOk });
    expect(r).toMatchObject({ ok: false, code: 'PROBE_FAIL' });
    expect(calls).toHaveLength(0);
  });

  // F3(OCR 43c032a 复审)：ffprobe 兄弟文件缺失是**环境问题**，必须 NO_FFMPEG 引去设置页，
  // 不许顺著 probe 失败被 PROBE_FAIL 冤判成「素材损坏请重下」
  it('filmstrip：ffprobe 兄弟文件缺失 → NO_FFMPEG（不冤判 PROBE_FAIL、不调 doExec）', async () => {
    const { fn, calls } = execStub(() => ({ write: 'PNG' }));
    const r = await ensureDerivedImage({ kind: 'film', importId: 9, videoPath: 'v.mp4', derivedDir, tempDir, db, doExec: fn, probe: async () => 20, resolveFfmpeg: async () => join(stubBin, 'orphan', 'ffmpeg.exe') });
    expect(r).toMatchObject({ ok: false, code: 'NO_FFMPEG' });
    if (!r.ok) expect(r.message).toContain('ffprobe');
    expect(calls).toHaveLength(0);
  });

  it('缓存自愈：film 图存在但没有 .meta（旧参数画的坏图）→ 判失效重画，并写下 meta', async () => {
    mkdirSync(derivedDir, { recursive: true });
    writeFileSync(join(derivedDir, 'film-3.png'), 'OLD-BAD-PNG'); // 无 meta = 旧实现的产物
    const { fn, calls } = execStub(() => ({ write: 'PNG' }));
    const r = await ensureDerivedImage({ kind: 'film', importId: 3, videoPath: 'v.mp4', derivedDir, tempDir, db, doExec: fn, probe: async () => 1290, resolveFfmpeg: resolveOk });
    expect(r).toMatchObject({ ok: true, cached: false });
    expect(calls).toHaveLength(37); // 36 格 + 1 次 tile；没被旧图糊弄过去，真重画了
    const meta = JSON.parse(readFileSync(join(derivedDir, 'film-3.png.meta'), 'utf8')) as FilmMeta;
    expect(meta.v).toBe(FILM_META_V);
    expect(meta.level).toBe(0);
    expect(meta.tiles).toBe(36);
    expect(meta.sig).toBe(filmShapeSig(0, 36)); // 形状凭据：schema/level/格数/格子尺寸都在里面
    expect(meta.durationSec).toBe(1290);
  });

  it('缓存自愈闭环：重画过一次后再请求 → 命中缓存，不再起 ffmpeg、也不再探时长', async () => {
    mkdirSync(derivedDir, { recursive: true });
    writeFileSync(join(derivedDir, 'film-4.png'), 'OLD-BAD-PNG');
    const first = execStub(() => ({ write: 'PNG' }));
    await ensureDerivedImage({ kind: 'film', importId: 4, videoPath: 'v.mp4', derivedDir, tempDir, db, doExec: first.fn, probe: async () => 1290, resolveFfmpeg: resolveOk });
    const second = execStub(() => ({ write: 'PNG' }));
    let probeCalls = 0;
    const r = await ensureDerivedImage({ kind: 'film', importId: 4, videoPath: 'v.mp4', derivedDir, tempDir, db, doExec: second.fn, probe: async () => { probeCalls += 1; return 1290; }, resolveFfmpeg: resolveOk });
    expect(r).toMatchObject({ ok: true, cached: true });
    expect(second.calls).toHaveLength(0);
    expect(probeCalls).toBe(0);
  });

  it('meta 是坏 JSON → 同样判失效重画（不信任半截状态）', async () => {
    mkdirSync(derivedDir, { recursive: true });
    writeFileSync(join(derivedDir, 'film-5.png'), 'PNG');
    writeFileSync(join(derivedDir, 'film-5.png.meta'), '{ 坏掉的');
    const { fn, calls } = execStub(() => ({ write: 'PNG' }));
    const r = await ensureDerivedImage({ kind: 'film', importId: 5, videoPath: 'v.mp4', derivedDir, tempDir, db, doExec: fn, probe: async () => 20, resolveFfmpeg: resolveOk });
    expect(r).toMatchObject({ ok: true, cached: false });
    expect(calls).toHaveLength(37);
  });

  it('wave 不需要 meta：老 wave 图（无 meta）仍直接命中，不白跑一次 ffmpeg', async () => {
    mkdirSync(derivedDir, { recursive: true });
    writeFileSync(join(derivedDir, 'wave-6.png'), 'PNG');
    const { fn, calls } = execStub(() => ({ write: 'PNG' }));
    const r = await ensureDerivedImage({ kind: 'wave', importId: 6, videoPath: 'v.mp4', derivedDir, tempDir, db, doExec: fn, resolveFfmpeg: resolveOk });
    expect(r).toMatchObject({ ok: true, cached: true });
    expect(calls).toHaveLength(0);
  });

  // —— 审查修复轮 1 important 1：参数比对必须「真的存在」，不是「meta 存在即算数」——
  // 手写一份「按别的参数画的老图」的 meta（改档位 / 改格数 / 改格子尺寸 / 改 schema 版本），
  // 每一种都必须被判失效重画。这正是「下一次改参数时老图照样命中」那个 bug 的同一形状。
  // Spec B (T2)：meta 形态升到 v3 —— 字段从 (v,sig,durationSec,vf) 变成 (v,level,sig,durationSec,tiles)。
  const staleMeta = (over: Record<string, unknown>): string => JSON.stringify({ v: FILM_META_V, level: 0, sig: filmShapeSig(0, 36), durationSec: 1290, tiles: 36, generatedAt: '2026-10-01T00:00:00.000Z', ...over });
  const withStaleFilm = (id: number, meta: string): void => {
    mkdirSync(derivedDir, { recursive: true });
    writeFileSync(join(derivedDir, `film-${id}.png`), 'PNG');
    writeFileSync(join(derivedDir, `film-${id}.png.meta`), meta);
  };

  it('改了格数（sig/tiles 36→12）→ 老图判失效重画（不靠人记得清缓存）', async () => {
    withStaleFilm(7, staleMeta({ sig: filmShapeSig(0, 12), tiles: 12 }));
    const { fn, calls } = execStub(() => ({ write: 'PNG' }));
    const r = await ensureDerivedImage({ kind: 'film', importId: 7, videoPath: 'v.mp4', derivedDir, tempDir, db, doExec: fn, probe: async () => 1290, resolveFfmpeg: resolveOk });
    expect(r).toMatchObject({ ok: true, cached: false });
    expect(calls).toHaveLength(37);
  });
  it('改了格子尺寸（sig cell 160x90→80x45）→ 老图判失效重画', async () => {
    withStaleFilm(8, staleMeta({ sig: filmShapeSig(0, 36).replace('cell=160x90', 'cell=80x45') }));
    const { fn, calls } = execStub(() => ({ write: 'PNG' }));
    const r = await ensureDerivedImage({ kind: 'film', importId: 8, videoPath: 'v.mp4', derivedDir, tempDir, db, doExec: fn, probe: async () => 1290, resolveFfmpeg: resolveOk });
    expect(r).toMatchObject({ ok: true, cached: false });
    expect(calls).toHaveLength(37);
  });
  it('改了 schema 版本（v 3→2）→ 老 meta 一律不认（连同上一轮写的那批 v=2 老 meta）', async () => {
    withStaleFilm(9, staleMeta({ v: 2 }));
    const { fn, calls } = execStub(() => ({ write: 'PNG' }));
    const r = await ensureDerivedImage({ kind: 'film', importId: 9, videoPath: 'v.mp4', derivedDir, tempDir, db, doExec: fn, probe: async () => 1290, resolveFfmpeg: resolveOk });
    expect(r).toMatchObject({ ok: true, cached: false });
    expect(calls).toHaveLength(37);
  });
  it('改了档位（meta 记 level=1，请求的是 L0）→ 判失效重画，且比对不额外探时长', async () => {
    // 老 meta 自称是按 L1（12 格）画的，但请求要的是 L0（36 格）→ 档位与格数都对不上
    withStaleFilm(10, staleMeta({ level: 1, sig: filmShapeSig(1, 12), tiles: 12 }));
    let probeCalls = 0;
    const { fn, calls } = execStub(() => ({ write: 'PNG' }));
    const r = await ensureDerivedImage({ kind: 'film', importId: 10, videoPath: 'v.mp4', derivedDir, tempDir, db, doExec: fn, probe: async () => { probeCalls += 1; return 1290; }, resolveFfmpeg: resolveOk });
    expect(r).toMatchObject({ ok: true, cached: false });
    expect(calls).toHaveLength(37);
    expect(probeCalls).toBe(1); // 探一次就够：比对用的是 meta 里记着的值，不是重新 ffprobe
  });
  it('比对通过的老 meta 仍然命中（别把比对写成「一律重画」——那等于缓存失效）', async () => {
    withStaleFilm(11, staleMeta({}));
    let probeCalls = 0;
    const { fn, calls } = execStub(() => ({ write: 'PNG' }));
    const r = await ensureDerivedImage({ kind: 'film', importId: 11, videoPath: 'v.mp4', derivedDir, tempDir, db, doExec: fn, probe: async () => { probeCalls += 1; return 1290; }, resolveFfmpeg: resolveOk });
    expect(r).toMatchObject({ ok: true, cached: true });
    expect(calls).toHaveLength(0);
    expect(probeCalls).toBe(0); // 命中时零 ffprobe —— 这是「开页不变慢」的全部依据
  });
  it('meta 是 JSON 数字/字符串/数组（JSON.parse 不抛但不是凭据对象）→ 判失效（旧实现会放行）', () => {
    mkdirSync(derivedDir, { recursive: true });
    writeFileSync(join(derivedDir, 'film-12.png'), 'PNG');
    for (const junk of ['123', '"abc"', 'null', '[]']) {
      writeFileSync(join(derivedDir, 'film-12.png.meta'), junk);
      const c = checkDerivedCache(derivedDir, 'film', 12);
      expect(c.path).toBeNull();
      expect(c.reason).toContain('meta');
    }
  });

  // —— 审查修复轮 1 important 2：并发去重 + 临时名唯一 + 落盘自洽 ——
  it('同一 (kind,importId) 并发两个请求 → 只起一个 ffmpeg，第二个等同一个结果（2.1GB 跑 52 秒不能跑两遍）', async () => {
    const { fn, calls } = execStub(() => ({ write: 'PNG' }));
    const args = { kind: 'film' as const, importId: 20, videoPath: 'v.mp4', derivedDir, tempDir, db, doExec: fn, probe: async () => 1290, resolveFfmpeg: resolveOk };
    const [a, b] = await Promise.all([ensureDerivedImage(args), ensureDerivedImage(args)]);
    expect(calls).toHaveLength(37); // 关键断言：完整跑了一轮（36 格 + tile），没有第二轮
    expect(a).toEqual(b);
    expect(a).toMatchObject({ ok: true, cached: false });
    // 跑完之后 in-flight 表要清空，否则下一次正常请求会拿到上次的旧结果
    const { fn: fn2, calls: calls2 } = execStub(() => ({ write: 'PNG' }));
    const c = await ensureDerivedImage({ ...args, doExec: fn2 });
    expect(c).toMatchObject({ ok: true, cached: true });
    expect(calls2).toHaveLength(0);
  });
  it('并发同 importId 但 videoPath 不同（换源竞态）→ 不并入在途任务（OCR R3：并入会拿到旧文件内容的图，且 meta 记旧时长自洽 → 错图常驻）', async () => {
    // 用 wave（一次生成恰一次 exec）：并入 → calls=1；不并入 → calls=2。断言才能一击区分两种行为。
    const { fn, calls } = execStub(() => ({ write: 'PNG' }));
    const base = { kind: 'wave' as const, importId: 25, derivedDir, tempDir, db, doExec: fn, resolveFfmpeg: resolveOk };
    const [a, b] = await Promise.all([
      ensureDerivedImage({ ...base, videoPath: 'old.mp4' }),
      ensureDerivedImage({ ...base, videoPath: 'new.mp4' }),
    ]);
    expect(calls).toHaveLength(2); // 各起各的 ffmpeg —— 新内容的请求绝不复用旧内容任务的（未来）结果
    expect(a).toMatchObject({ ok: true });
    expect(b).toMatchObject({ ok: true });
  });
  it('临时名带随机段：同毫秒连发两次不同 importId → 两个 ffmpeg 输出名不相同（不会 -y 抢同一个文件）', async () => {
    const { fn, calls } = execStub(() => ({ write: 'PNG' }));
    await Promise.all([
      ensureDerivedImage({ kind: 'film', importId: 21, videoPath: 'v.mp4', derivedDir, tempDir, db, doExec: fn, probe: async () => 1290, resolveFfmpeg: resolveOk }),
      ensureDerivedImage({ kind: 'film', importId: 22, videoPath: 'v.mp4', derivedDir, tempDir, db, doExec: fn, probe: async () => 1290, resolveFfmpeg: resolveOk }),
    ]);
    // 只看 tile 拼接产物（每个 importId 恰好一次）：两者必须不同名，否则两个 ffmpeg -y 抢同一个文件
    const tileOuts = calls.filter((c) => c.args.includes('-start_number')).map((c) => c.args[c.args.length - 1]!);
    expect(tileOuts).toHaveLength(2);
    expect(new Set(tileOuts).size).toBe(2);
    // 逐格的输出路径也两两不同（cellDir 含 importId 与唯一随机段）
    const cellOuts = calls.filter((c) => c.args.includes('-ss')).map((c) => c.args[c.args.length - 1]!);
    expect(new Set(cellOuts).size).toBe(cellOuts.length);
  });
  it('落盘自洽：图与 meta 一起到位，temp 里不留残留（否则每次请求都判失效、用户反复白等 52 秒）', async () => {
    const { fn } = execStub(() => ({ write: 'PNG' }));
    await ensureDerivedImage({ kind: 'film', importId: 23, videoPath: 'v.mp4', derivedDir, tempDir, db, doExec: fn, probe: async () => 1290, resolveFfmpeg: resolveOk });
    expect(existsSync(join(derivedDir, 'film-23.png'))).toBe(true);
    expect(existsSync(join(derivedDir, 'film-23.png.meta'))).toBe(true);
    expect(readdirSync(derivedDir).filter((f) => f.endsWith('.tmp'))).toHaveLength(0);
    expect(readdirSync(tempDir)).toHaveLength(0);
    // 且这份落盘结果立刻可命中（自愈闭环：第二个人来看不用再等一次 52 秒）
    expect(checkDerivedCache(derivedDir, 'film', 23).path).not.toBeNull();
  });
  it('生成期间素材被替换 → SRC_CHANGED，产物丢弃不落盘（OCR R4：旧内容图凭 meta 自洽会永久命中，必须在 rename 前拦住）', async () => {
    // 源必须是真文件（守卫前后都要 statSync 它）；exec 桩在生成期间确定性改它的 mtime（模拟换源重下）
    const src = join(root, 'src-race.mp4');
    writeFileSync(src, 'old-content');
    const { fn } = execStub(() => {
      const st = statSync(src);
      utimesSync(src, st.atime, new Date(st.mtimeMs + 5000)); // 显式 +5s：同毫秒两次写 mtime 可能相等，必须确定性地变
      return { write: 'PNG' };
    });
    const r = await ensureDerivedImage({ kind: 'wave', importId: 26, videoPath: src, derivedDir, tempDir, db, doExec: fn, resolveFfmpeg: resolveOk });
    expect(r).toMatchObject({ ok: false, code: 'SRC_CHANGED' });
    expect(existsSync(join(derivedDir, 'wave-26.png'))).toBe(false); // 旧内容绝不落盘
    expect(readdirSync(tempDir)).toHaveLength(0); // 临时产物一并清干净
  });
  it('真实源文件、生成期间未被替换 → 正常落盘（mtime 守卫不误伤）', async () => {
    const src = join(root, 'src-stable.mp4');
    writeFileSync(src, 'stable-content');
    const { fn } = execStub(() => ({ write: 'PNG' }));
    const r = await ensureDerivedImage({ kind: 'wave', importId: 27, videoPath: src, derivedDir, tempDir, db, doExec: fn, resolveFfmpeg: resolveOk });
    expect(r).toMatchObject({ ok: true, cached: false });
    expect(existsSync(join(derivedDir, 'wave-27.png'))).toBe(true);
  });
  it('sourceState 判 replaced / gone → SRC_CHANGED 不落盘（OCR R5/R9：文件没变 ≠ 登记没变；row 换人与 row 没了分流两种出路）', async () => {
    const src = join(root, 'src-orphan.mp4');
    writeFileSync(src, 'orphan-content'); // 文件健在且身份不变 → 能过 mtime/size 守卫，卡在第二重校验
    const { fn } = execStub(() => ({ write: 'PNG' }));
    const base = { kind: 'wave' as const, importId: 28, videoPath: src, derivedDir, tempDir, db, doExec: fn, resolveFfmpeg: resolveOk };
    const r1 = await ensureDerivedImage({ ...base, sourceState: () => 'replaced' as const });
    expect(r1).toMatchObject({ ok: false, code: 'SRC_CHANGED' });
    if (!r1.ok) expect(r1.message).toContain('被替换'); // 登记换人 → 引导刷新
    expect(existsSync(join(derivedDir, 'wave-28.png'))).toBe(false);
    const r2 = await ensureDerivedImage({ ...base, importId: 29, sourceState: () => 'gone' as const });
    expect(r2).toMatchObject({ ok: false, code: 'SRC_CHANGED' });
    if (!r2.ok) expect(r2.message).toContain('被删除'); // 登记没了 → 引导重下（刷新只会 404）
    expect(existsSync(join(derivedDir, 'wave-29.png'))).toBe(false);
    expect(readdirSync(tempDir)).toHaveLength(0);
  });
  it('meta 临时名写不进去 → 直接失败，不起 ffmpeg（图没有凭据，下次还得重画，不如别跑）', async () => {
    // 把 tempDir 指向一个不存在的深层路径 → writeFileSync 必失败（不 mock fs，保持真实 IO 语义）
    const { fn, calls } = execStub(() => ({ write: 'PNG' }));
    const r = await ensureDerivedImage({ kind: 'film', importId: 24, videoPath: 'v.mp4', derivedDir, tempDir: join(root, 'no', 'such', 'dir'), db, doExec: fn, probe: async () => 1290, resolveFfmpeg: resolveOk });
    expect(r).toMatchObject({ ok: false, code: 'FFMPEG_FAIL' });
    if (!r.ok) expect(r.message).toContain('参数凭据');
    expect(calls).toHaveLength(0); // 没白跑一次 52 秒的 ffmpeg
    expect(existsSync(join(derivedDir, 'film-24.png'))).toBe(false);
  });
  it('ffmpeg 失败 → 临时图与临时 meta 一起清掉（不留半成品让下次误判）', async () => {
    const err = Object.assign(new Error('boom'), { code: 1 });
    const { fn } = execStub(() => ({ err, stderr: 'x\nbad' }));
    const r = await ensureDerivedImage({ kind: 'film', importId: 25, videoPath: 'v.mp4', derivedDir, tempDir, db, doExec: fn, probe: async () => 1290, resolveFfmpeg: resolveOk });
    expect(r).toMatchObject({ ok: false, code: 'FFMPEG_FAIL' });
    expect(readdirSync(tempDir)).toHaveLength(0);
    expect(existsSync(join(derivedDir, 'film-25.png'))).toBe(false);
    expect(existsSync(join(derivedDir, 'film-25.png.meta'))).toBe(false);
  });
});

// —— Spec B T2：L0 总览接管（逐格 seek 生成）——
// 实测 B1：36 格逐格 seek 共 10.29s，vs fps 滤镜整解码 45–52s（快 4.4–5.1 倍）。
// 这组测试锁住「逐格 seek 的形态」：36 次抽帧 + 1 次拼接、-ss 在 -i 前、任一格失败即整体失败。
describe('L0 总览：逐格 seek 生成（实测 B1）', () => {
  it('36 格 → 调 36 次 cell 抽帧 + 1 次 tile 拼接，共 37 次 doExec（不再是 1 次）', async () => {
    const { fn, calls } = execStub(() => ({ write: 'PNG' }));
    const r = await ensureDerivedImage({ kind: 'film', importId: 41, videoPath: 'v.mp4', derivedDir, tempDir, db, doExec: fn, probe: async () => 1290.325333, resolveFfmpeg: resolveOk });
    expect(r).toMatchObject({ ok: true, cached: false });
    const cellCalls = calls.filter((c) => c.args.includes('-ss'));
    const tileCalls = calls.filter((c) => c.args.includes('-start_number'));
    expect(cellCalls).toHaveLength(36);
    expect(tileCalls).toHaveLength(1);
    // -ss 必须在 -i 之前：这是 10.29s 与「整解码 45–52s」差距的全部来源
    for (const c of cellCalls) expect(c.args.indexOf('-ss')).toBeLessThan(c.args.indexOf('-i'));
    // 第 1 格是 0，第 2 格落在 1/36 处（1290.325333/36 = 35.8423… → 保留两位 35.84）
    expect(cellCalls[0]!.args[cellCalls[0]!.args.indexOf('-ss') + 1]).toBe('0');
    expect(cellCalls[1]!.args[cellCalls[1]!.args.indexOf('-ss') + 1]).toBe('35.84');
  });

  it('cell 临时文件全部清理（不留 36 个半成品在 temp/）', async () => {
    const { fn, calls } = execStub(() => ({ write: 'PNG' }));
    await ensureDerivedImage({ kind: 'film', importId: 42, videoPath: 'v.mp4', derivedDir, tempDir, db, doExec: fn, probe: async () => 1290.325333, resolveFfmpeg: resolveOk });
    const last = calls[calls.length - 1]!;
    const cellArg = last.args[last.args.indexOf('-i') + 1]!;
    const cellDir = cellArg.replace(/\\cell-%02d\.png$/, '');
    const leftovers = existsSync(cellDir) ? readdirSync(cellDir).filter((f) => f.startsWith('cell-')) : [];
    expect(leftovers).toHaveLength(0);
    expect(readdirSync(tempDir)).toHaveLength(0); // temp/ 里整个 cell 目录也没了
  });

  it('任一格失败 → 整体 FFMPEG_FAIL，不落半张图（不留「有图无凭据」）', async () => {
    let n = 0;
    const { fn } = execStub(() => {
      n += 1;
      return n === 5 ? { err: Object.assign(new Error('boom'), { code: 1 }), stderr: 'Invalid data found' } : { write: 'PNG' };
    });
    const r = await ensureDerivedImage({ kind: 'film', importId: 43, videoPath: 'v.mp4', derivedDir, tempDir, db, doExec: fn, probe: async () => 1290.325333, resolveFfmpeg: resolveOk });
    expect(r).toMatchObject({ ok: false, code: 'FFMPEG_FAIL' });
    expect(existsSync(join(derivedDir, 'film-43.png'))).toBe(false);
    expect(existsSync(join(derivedDir, 'film-43.png.meta'))).toBe(false);
    expect(readdirSync(tempDir)).toHaveLength(0);
  });

  it('meta 升到 v3 且带 level=0（老 v2 的图自动判失效）', async () => {
    const { fn } = execStub(() => ({ write: 'PNG' }));
    await ensureDerivedImage({ kind: 'film', importId: 44, videoPath: 'v.mp4', derivedDir, tempDir, db, doExec: fn, probe: async () => 200, resolveFfmpeg: resolveOk });
    const m = JSON.parse(readFileSync(join(derivedDir, 'film-44.png.meta'), 'utf8')) as Record<string, unknown>;
    expect(m.v).toBe(FILM_META_V);
    expect(m.level).toBe(0);
    expect(m.tiles).toBe(36);
    expect(String(m.sig)).toContain('level=0');
  });

  it('老 v2 的 meta → 判失效重生成（spec D4 的核心机制）', async () => {
    mkdirSync(derivedDir, { recursive: true });
    writeFileSync(join(derivedDir, 'film-45.png'), 'PNG');
    writeFileSync(join(derivedDir, 'film-45.png.meta'), JSON.stringify({ v: 2, sig: 'v2|tiles=12|size=1600x90|fps=min(12/T,30)', durationSec: 200, vf: 'fps=1.000000,scale=-1:90,tile=12x1,scale=1600:90', generatedAt: '' }));
    const { fn, calls } = execStub(() => ({ write: 'PNG' }));
    const r = await ensureDerivedImage({ kind: 'film', importId: 45, videoPath: 'v.mp4', derivedDir, tempDir, db, doExec: fn, probe: async () => 200, resolveFfmpeg: resolveOk });
    expect(r).toMatchObject({ ok: true, cached: false });
    expect(calls).toHaveLength(37);
  });
});

// 命名契约（spec D1/D4）：文件名是命中判定/生成/清理三处共用的单一来源，各写一份必然漂移。
describe('derivedFileName 命名契约', () => {
  it('L0 沿用 legacy 名（URL/文件名不变，向后兼容）', () => {
    expect(derivedFileName('film', 12)).toBe('film-12.png');
    expect(derivedFileName('wave', 12)).toBe('wave-12.png');
  });
  it('分段图名带 level 与段号', () => {
    expect(derivedFileName('filmSeg', 12, { level: 1, seg: 3 })).toBe('film-12-L1-3.png');
    expect(derivedFileName('filmSeg', 12, { level: 2, seg: 0 })).toBe('film-12-L2-0.png');
  });
  it('峰值 JSON：L0 不带段号，L1/L2 带段号', () => {
    expect(derivedFileName('wavePeak', 12, { level: 0 as 1 | 2, seg: 0 })).toBe('wavepeak-12-L0.json');
    expect(derivedFileName('wavePeak', 12, { level: 1, seg: 3 })).toBe('wavepeak-12-L1-3.json');
  });
});

describe('invalidateDerived', () => {
  it('两张图存在 → 删后都不存在；对不存在的调用不抛', () => {
    mkdirSync(derivedDir, { recursive: true });
    writeFileSync(join(derivedDir, 'wave-1.png'), 'PNG');
    writeFileSync(join(derivedDir, 'film-1.png'), 'PNG');
    invalidateDerived(derivedDir, 1);
    expect(existsSync(join(derivedDir, 'wave-1.png'))).toBe(false);
    expect(existsSync(join(derivedDir, 'film-1.png'))).toBe(false);
    expect(() => invalidateDerived(derivedDir, 999)).not.toThrow(); // 目录/文件不存在也不抛
  });

  it('连 .meta 一起删：素材换了内容 → 旧图和它的参数凭据都不能留', () => {
    mkdirSync(derivedDir, { recursive: true });
    writeFileSync(join(derivedDir, 'film-1.png'), 'PNG');
    writeFileSync(join(derivedDir, 'film-1.png.meta'), '{"v":1}');
    writeFileSync(join(derivedDir, 'wave-1.png.meta'), '{"v":1}');
    invalidateDerived(derivedDir, 1);
    expect(existsSync(join(derivedDir, 'film-1.png.meta'))).toBe(false);
    expect(existsSync(join(derivedDir, 'wave-1.png.meta'))).toBe(false);
  });

  // —— Spec B T3：分段图与峰值 JSON 也必须一起清（否则素材换源后，段图凭 meta 自洽会永久命中）——
  it('全级清扫：L0 + 所有 L1/L2 段 + 峰值 JSON + 各自 meta 一并删，返回清理条数', () => {
    mkdirSync(derivedDir, { recursive: true });
    const names = ['film-1.png', 'film-1.png.meta', 'film-1-L1-0.png', 'film-1-L1-0.png.meta', 'film-1-L2-7.png', 'film-1-L2-7.png.meta', 'wavepeak-1-L0.json', 'wavepeak-1-L1-3.json'];
    for (const n of names) writeFileSync(join(derivedDir, n), 'x');
    const r = invalidateDerived(derivedDir, 1);
    expect(r.removed).toBe(names.length);
    expect(readdirSync(derivedDir)).toHaveLength(0);
  });

  // ⚠️ spec D4 点名的坑：朴素前缀 `film-1-` 会误伤 `film-11-*` —— 11 号素材的段图被 1 号清掉，
  // 用户打开 11 号页面只能重新生成几十秒。所以段图前缀必须写成 `film-<id>-L`（带 L）。
  it('前缀碰撞：清 importId=1 不得误删 importId=11 的任何文件', () => {
    mkdirSync(derivedDir, { recursive: true });
    const keep = ['film-11.png', 'film-11.png.meta', 'film-11-L1-0.png', 'film-11-L2-7.png', 'film-11-L2-7.png.meta', 'wavepeak-11-L0.json', 'wavepeak-11-L1-3.json', 'wave-11.png'];
    for (const n of keep) writeFileSync(join(derivedDir, n), 'x');
    writeFileSync(join(derivedDir, 'film-1.png'), 'x');
    writeFileSync(join(derivedDir, 'film-1-L1-0.png'), 'x');
    const r = invalidateDerived(derivedDir, 1);
    expect(r.removed).toBe(2);
    for (const n of keep) expect(existsSync(join(derivedDir, n))).toBe(true);
  });

  it('同理不受 importId=10/12 影响（`film-1-L` 与 `film-12-L` 是不同前缀）', () => {
    mkdirSync(derivedDir, { recursive: true });
    for (const n of ['film-12-L1-0.png', 'film-10-L1-0.png', 'wavepeak-12-L0.json']) writeFileSync(join(derivedDir, n), 'x');
    invalidateDerived(derivedDir, 1);
    expect(readdirSync(derivedDir).sort()).toEqual(['film-10-L1-0.png', 'film-12-L1-0.png', 'wavepeak-12-L0.json']);
  });

  it('目录不存在 → 不抛，返回 removed:0（素材变化时清图不该让主流程挂掉，仓库规则）', () => {
    expect(() => invalidateDerived(join(root, 'no-such-dir'), 9)).not.toThrow();
    expect(invalidateDerived(join(root, 'no-such-dir'), 9).removed).toBe(0);
  });
});
