// server/src/media/derived-images.test.ts
// 派生图生成（spec D6/D14）：用真实临时目录 + 注入 doExec/resolveFfmpeg/probe，不真拉 ffmpeg。
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type DB } from '../db/index.js';
import { ensureDerivedImage, invalidateDerived, type ExecLike } from './derived-images.js';

let root: string;
let derivedDir: string;
let tempDir: string;
let db: DB;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sct-di-'));
  derivedDir = join(root, 'derived');
  tempDir = join(root, 'tmp');
  mkdirSync(tempDir, { recursive: true });
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

const resolveOk = async (): Promise<string | null> => 'C:/stub/ffmpeg.exe';

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
});
