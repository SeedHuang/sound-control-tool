// server/src/ytdlp/ingest.test.ts
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type DB } from '../db/index.js';
import { initSchema } from '../db/schema.js';
import { createAudioItemsRepo } from '../db/repo/audio-items.js';
import { ingestDownloadedFile, moveIntoPlace } from './ingest.js';

let dir: string; let db: DB;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sct-ingest-'));
  db = openDatabase(':memory:'); initSchema(db);
});
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

describe('ingestDownloadedFile', () => {
  it('两段式入库:最终文件名为 slug-id8.ext', () => {
    const audioRepo = createAudioItemsRepo(db);
    const tmpPath = join(dir, 'tmp.mp3'); writeFileSync(tmpPath, 'fake');
    const { audioId, finalPath } = ingestDownloadedFile({
      tmpPath, title: '课/01: 导入', format: 'mp3', durationSec: 61.5, fileSize: 4,
      sourceUrl: 'https://a', audioDir: dir, exists: existsSync, audioRepo,
    });
    expect(audioId).toBeGreaterThan(0);
    expect(finalPath).toBe(join(dir, `课_01_ 导入-${String(audioId).padStart(8, '0').slice(-8)}.mp3`));
    expect(existsSync(finalPath)).toBe(true);
    expect(existsSync(tmpPath)).toBe(false);
    expect(audioRepo.get(audioId)?.file_path).toBe(finalPath);
  });
  it('同名冲突追加 -2', () => {
    // 注:文件名含 id8(每条 id 不同 → 文件名天然不冲突),brief 原测试"两个同标题条目"
    // 实际不会触发 resolveUniquePath。要触发 -2 后缀,须让第二个条目的默认文件名先在磁盘存在
    const audioRepo = createAudioItemsRepo(db);
    const t1 = join(dir, 'a.mp3'); writeFileSync(t1, '1');
    const { audioId: id1, finalPath: p1 } = ingestDownloadedFile({ tmpPath: t1, title: '同', format: 'mp3', durationSec: null, fileSize: 1, sourceUrl: 'u1', audioDir: dir, exists: existsSync, audioRepo });
    const t2 = join(dir, 'b.mp3'); writeFileSync(t2, '2');
    const id2 = id1 + 1; // 单连接无并发插入,下一个条目 id 必为 id1+1
    writeFileSync(join(dir, `同-${String(id2).padStart(8, '0').slice(-8)}.mp3`), '占位');
    const { finalPath: p2 } = ingestDownloadedFile({ tmpPath: t2, title: '同', format: 'mp3', durationSec: null, fileSize: 1, sourceUrl: 'u2', audioDir: dir, exists: existsSync, audioRepo });
    expect(p2.endsWith('-2.mp3')).toBe(true);
    expect(p2).not.toBe(p1);
  });
  // 2026-09-29 用户拍板:合集条目入库要记住「第几集 / 所属合集」,剪辑室据此显示
  it('剧集字段 entryIndex/collectionTitle 随入库写进 audio_items(单视频不传 → null)', () => {
    const audioRepo = createAudioItemsRepo(db);
    const t1 = join(dir, 'ep3.mp3'); writeFileSync(t1, 'x');
    const { audioId } = ingestDownloadedFile({
      tmpPath: t1, title: '第 3 集', format: 'mp3', durationSec: null, fileSize: 1,
      sourceUrl: 'https://a/pl', audioDir: dir, exists: existsSync, audioRepo,
      entryIndex: 3, collectionTitle: '某合集',
    });
    expect(audioRepo.get(audioId)!.entry_index).toBe(3);
    expect(audioRepo.get(audioId)!.collection_title).toBe('某合集');
    const t2 = join(dir, 'single.mp3'); writeFileSync(t2, 'y');
    const { audioId: sid } = ingestDownloadedFile({ tmpPath: t2, title: '单视频', format: 'mp3', durationSec: null, fileSize: 1, sourceUrl: 'https://a/s', audioDir: dir, exists: existsSync, audioRepo });
    expect(audioRepo.get(sid)!.entry_index).toBeNull();
    expect(audioRepo.get(sid)!.collection_title).toBeNull();
  });
  it('rename 失败 → 已 INSERT 的行回滚删除(修复:不留指向 temp 的悬空行)', () => {
    const audioRepo = createAudioItemsRepo(db);
    // tmpPath 不存在 → renameSync 抛 ENOENT;此时行已 INSERT,必须回滚删除
    const tmpPath = join(dir, 'missing.mp3');
    expect(() => ingestDownloadedFile({
      tmpPath, title: '回滚', format: 'mp3', durationSec: null, fileSize: 1,
      sourceUrl: 'u', audioDir: dir, exists: existsSync, audioRepo,
    })).toThrow();
    expect(audioRepo.list()).toHaveLength(0);
  });
  // D8(T4)：sourceType 可选——剪辑/导出传 'edit'；不传保持 'download'(老路径回归保护)
  it("sourceType:'edit' → 落库 source_type==='edit'(D8)", () => {
    const audioRepo = createAudioItemsRepo(db);
    const t = join(dir, 'edit.mp3'); writeFileSync(t, 'x');
    const { audioId } = ingestDownloadedFile({
      tmpPath: t, title: '剪辑产物', format: 'mp3', durationSec: null, fileSize: 1,
      sourceUrl: '', audioDir: dir, exists: existsSync, audioRepo, sourceType: 'edit',
    });
    expect(audioRepo.get(audioId)!.source_type).toBe('edit');
  });
  it('不传 sourceType → 仍是 download(老下载路径回归)', () => {
    const audioRepo = createAudioItemsRepo(db);
    const t = join(dir, 'dl.mp3'); writeFileSync(t, 'x');
    const { audioId } = ingestDownloadedFile({
      tmpPath: t, title: '下载音频', format: 'mp3', durationSec: null, fileSize: 1,
      sourceUrl: 'https://a', audioDir: dir, exists: existsSync, audioRepo,
    });
    expect(audioRepo.get(audioId)!.source_type).toBe('download');
  });
  // 2026-10-01 spec audio-lineage D3：sourceImportId 透传到 source_import_id
  it('sourceImportId 透传进 source_import_id(缺省 → null)', () => {
    const audioRepo = createAudioItemsRepo(db);
    const t1 = join(dir, 'blood.mp3'); writeFileSync(t1, 'x');
    const { audioId } = ingestDownloadedFile({
      tmpPath: t1, title: '带血缘', format: 'mp3', durationSec: null, fileSize: 1,
      sourceUrl: 'https://a/pl', sourceImportId: 7, audioDir: dir, exists: existsSync, audioRepo,
    });
    expect(audioRepo.get(audioId)!.source_import_id).toBe(7);
    const t2 = join(dir, 'noblood.mp3'); writeFileSync(t2, 'y');
    const { audioId: nid } = ingestDownloadedFile({
      tmpPath: t2, title: '无血缘', format: 'mp3', durationSec: null, fileSize: 1,
      sourceUrl: '', audioDir: dir, exists: existsSync, audioRepo,
    });
    expect(audioRepo.get(nid)!.source_import_id).toBeNull();
  });
});

describe('moveIntoPlace(跨盘兜底, spec D6)', () => {
  it('同盘 rename 成功 → 只调 rename', () => {
    const calls: string[] = [];
    moveIntoPlace('a', 'b', {
      rename: (() => { calls.push('rename'); }) as never,
      copyFile: (() => { calls.push('copyFile'); }) as never,
      unlink: (() => { calls.push('unlink'); }) as never,
    });
    expect(calls).toEqual(['rename']);
  });
  it('rename 抛 EXDEV → 退化为 copyFile + unlink', () => {
    const calls: string[] = [];
    moveIntoPlace('a', 'b', {
      rename: (() => { const e = new Error('cross-device') as NodeJS.ErrnoException; e.code = 'EXDEV'; throw e; }) as never,
      copyFile: (() => { calls.push('copyFile'); }) as never,
      unlink: (() => { calls.push('unlink'); }) as never,
    });
    expect(calls).toEqual(['copyFile', 'unlink']);
  });
  it('rename 抛非 EXDEV（如 EBUSY）→ 原样抛出，不做复制', () => {
    const calls: string[] = [];
    expect(() => moveIntoPlace('a', 'b', {
      rename: (() => { const e = new Error('busy') as NodeJS.ErrnoException; e.code = 'EBUSY'; throw e; }) as never,
      copyFile: (() => { calls.push('copyFile'); }) as never,
      unlink: (() => { calls.push('unlink'); }) as never,
    })).toThrow('busy');
    expect(calls).toEqual([]);
  });
  // spec §0.6 明确要求：EXDEV 分支**走真实复制**后，目标文件存在、源文件被清理。
  // 上面两条只断言「被调了哪些桩、顺序如何」——即使把 copyFileSync(from, to) 写成 (to, from)
  // 也照样绿（桩不校验实参）。而 renameSync(old,new) 与 copyFileSync(src,dest) 参数序相反，
  // 正是最易写反的点。故本条**只注入会抛 EXDEV 的 rename**，copyFile/unlink 用真实现，
  // 通过读回目标文件内容来锁死实参顺序（写反时目标不会被创建，readFileSync 直接抛 → 变红）。
  it('EXDEV 分支走真实复制：目标文件存在、源文件被清理（spec §0.6）', () => {
    const from = join(dir, 'src.bin');
    const to = join(dir, 'dst.bin');
    writeFileSync(from, 'HELLO');
    const exdev = (() => { const e = new Error('cross-device') as NodeJS.ErrnoException; e.code = 'EXDEV'; throw e; }) as never;
    moveIntoPlace(from, to, { rename: exdev }); // 只注入 rename，copyFile/unlink 走真实现
    expect(readFileSync(to, 'utf8')).toBe('HELLO'); // 实参顺序写反的话这里必然失败
    expect(existsSync(from)).toBe(false);           // 源被清理
  });
});
