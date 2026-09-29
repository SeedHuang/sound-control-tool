// server/src/ytdlp/ingest.test.ts
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type DB } from '../db/index.js';
import { initSchema } from '../db/schema.js';
import { createAudioItemsRepo } from '../db/repo/audio-items.js';
import { ingestDownloadedFile } from './ingest.js';

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
  // 2026-09-29 用户拍板:合集条目入库要记住「第几集 / 所属合集」,音频库据此显示
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
});
