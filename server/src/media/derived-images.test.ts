// server/src/media/derived-images.test.ts
// 派生图生成（spec D6/D14）：用真实临时目录 + 注入 doExec/resolveFfmpeg/probe，不真拉 ffmpeg。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type DB } from '../db/index.js';
import { filmstripShapeSig, filmstripVfFor } from '../ffmpeg/derived-args.js';
import { checkDerivedCache, ensureDerivedImage, invalidateDerived, type ExecLike } from './derived-images.js';

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

  it('filmstrip：probe 返 20 → 传进 doExec 的 -vf 含 fps=0.600000（把 duration 接进参数链）', async () => {
    const { fn, calls } = execStub(() => ({ write: 'PNG' }));
    const r = await ensureDerivedImage({ kind: 'film', importId: 2, videoPath: 'v.mp4', derivedDir, tempDir, db, doExec: fn, probe: async () => 20, resolveFfmpeg: resolveOk });
    expect(r).toMatchObject({ ok: true });
    const args = calls[0]!.args;
    expect(args[args.indexOf('-vf') + 1]).toContain('fps=0.600000');
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
    if (!r.ok) expect(r.message).toContain('无法生成画轨');
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
    expect(calls).toHaveLength(1); // 没被旧图糊弄过去，真重画了
    const meta = JSON.parse(readFileSync(join(derivedDir, 'film-3.png.meta'), 'utf8')) as { v: number; sig: string; durationSec: number; vf: string };
    expect(meta.v).toBe(2);
    expect(meta.sig).toBe(filmstripShapeSig()); // 形状凭据：格数/宽高/schema/fps 公式都在里面
    expect(meta.durationSec).toBe(1290);
    expect(meta.vf).toContain('fps=0.009302'); // 记的是实际用的 fps
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
    expect(calls).toHaveLength(1);
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
  // 手写一份「按别的参数画的老图」的 meta（改 tile 数 / 改宽高 / 改 schema / 改 fps 公式），
  // 每一种都必须被判失效重画。这正是「下一次改公式时老图照样命中」那个 bug 的同一形状。
  const staleMeta = (over: Record<string, unknown>): string => JSON.stringify({ v: 2, sig: filmstripShapeSig(), durationSec: 1290, vf: filmstripVfFor(1290), generatedAt: '2026-10-01T00:00:00.000Z', ...over });
  const withStaleFilm = (id: number, meta: string): void => {
    mkdirSync(derivedDir, { recursive: true });
    writeFileSync(join(derivedDir, `film-${id}.png`), 'PNG');
    writeFileSync(join(derivedDir, `film-${id}.png.meta`), meta);
  };

  it('改了 tile 数（sig 12→8）→ 老图判失效重画（不靠人记得清缓存）', async () => {
    withStaleFilm(7, staleMeta({ sig: filmstripShapeSig().replace('tiles=12', 'tiles=8') }));
    const { fn, calls } = execStub(() => ({ write: 'PNG' }));
    const r = await ensureDerivedImage({ kind: 'film', importId: 7, videoPath: 'v.mp4', derivedDir, tempDir, db, doExec: fn, probe: async () => 1290, resolveFfmpeg: resolveOk });
    expect(r).toMatchObject({ ok: true, cached: false });
    expect(calls).toHaveLength(1);
  });
  it('改了宽高（sig 1600x90→800x45）→ 老图判失效重画', async () => {
    withStaleFilm(8, staleMeta({ sig: filmstripShapeSig().replace('size=1600x90', 'size=800x45') }));
    const { fn, calls } = execStub(() => ({ write: 'PNG' }));
    const r = await ensureDerivedImage({ kind: 'film', importId: 8, videoPath: 'v.mp4', derivedDir, tempDir, db, doExec: fn, probe: async () => 1290, resolveFfmpeg: resolveOk });
    expect(r).toMatchObject({ ok: true, cached: false });
    expect(calls).toHaveLength(1);
  });
  it('改了 schema 版本（v 2→1）→ 老 meta 一律不认（连同上一轮写的那批 v=1 老 meta）', async () => {
    withStaleFilm(9, staleMeta({ v: 1 }));
    const { fn, calls } = execStub(() => ({ write: 'PNG' }));
    const r = await ensureDerivedImage({ kind: 'film', importId: 9, videoPath: 'v.mp4', derivedDir, tempDir, db, doExec: fn, probe: async () => 1290, resolveFfmpeg: resolveOk });
    expect(r).toMatchObject({ ok: true, cached: false });
    expect(calls).toHaveLength(1);
  });
  it('改了 fps 公式（老图 vf 是 12/T 算的、当前公式算出来的不一样）→ 判失效重画，且比对不额外探时长', async () => {
    // 老 vf 假装是「除数 11」那套公式的产物（末格对齐片尾那个约定）；当前公式按 12/T 算 → 逐字对不上
    withStaleFilm(10, staleMeta({ vf: 'fps=0.008527,scale=-1:90,tile=12x1,scale=1600:90' }));
    let probeCalls = 0;
    const { fn, calls } = execStub(() => ({ write: 'PNG' }));
    const r = await ensureDerivedImage({ kind: 'film', importId: 10, videoPath: 'v.mp4', derivedDir, tempDir, db, doExec: fn, probe: async () => { probeCalls += 1; return 1290; }, resolveFfmpeg: resolveOk });
    expect(r).toMatchObject({ ok: true, cached: false });
    expect(calls).toHaveLength(1);
    expect(probeCalls).toBe(1); // 探一次就够：比对用的是 meta 里记着的时长，不是重新 ffprobe
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
    expect(calls).toHaveLength(1); // 关键断言：没有第二个 ffmpeg
    expect(a).toEqual(b);
    expect(a).toMatchObject({ ok: true, cached: false });
    // 跑完之后 in-flight 表要清空，否则下一次正常请求会拿到上次的旧结果
    const { fn: fn2, calls: calls2 } = execStub(() => ({ write: 'PNG' }));
    const c = await ensureDerivedImage({ ...args, doExec: fn2 });
    expect(c).toMatchObject({ ok: true, cached: true });
    expect(calls2).toHaveLength(0);
  });
  it('临时名带随机段：同毫秒连发两次不同 importId → 两个 ffmpeg 输出名不相同（不会 -y 抢同一个文件）', async () => {
    const { fn, calls } = execStub(() => ({ write: 'PNG' }));
    await Promise.all([
      ensureDerivedImage({ kind: 'film', importId: 21, videoPath: 'v.mp4', derivedDir, tempDir, db, doExec: fn, probe: async () => 1290, resolveFfmpeg: resolveOk }),
      ensureDerivedImage({ kind: 'film', importId: 22, videoPath: 'v.mp4', derivedDir, tempDir, db, doExec: fn, probe: async () => 1290, resolveFfmpeg: resolveOk }),
    ]);
    const outs = calls.map((c) => c.args[c.args.length - 1]!);
    expect(new Set(outs).size).toBe(2);
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
});
