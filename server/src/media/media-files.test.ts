// server/src/media/media-files.test.ts
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deleteVideoFiles, findVideoFile, placeVideo } from './media-files.js';

let dir: string;
let tmpPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sct-media-'));
  tmpPath = join(dir, 'incoming.mp4');
  writeFileSync(tmpPath, 'VIDEOBYTES');
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('placeVideo 覆盖语义(spec §0.4)', () => {
  it('首次落盘:改成 media-<id>.mp4', () => {
    const r = placeVideo({ tmpPath, mediaDir: dir, importId: 7, ext: 'mp4', registeredPath: null });
    expect(r).toEqual({ ok: true, path: join(dir, 'media-7.mp4') });
    expect(findVideoFile(dir, 7)).toBe(join(dir, 'media-7.mp4'));
  });
  it('目标已被我们登记过 → 直接覆盖,不加序号', () => {
    writeFileSync(join(dir, 'media-7.mp4'), 'OLD');
    const r = placeVideo({ tmpPath, mediaDir: dir, importId: 7, ext: 'mp4', registeredPath: join(dir, 'media-7.mp4') });
    expect(r).toEqual({ ok: true, path: join(dir, 'media-7.mp4') });
    expect(readdirSync(dir).filter((f) => f.startsWith('media-7'))).toEqual(['media-7.mp4']);
  });
  it('目标已存在但 DB 没登记(D15:用户手工放的文件)→ 改用序号名,原文件不动', () => {
    writeFileSync(join(dir, 'media-7.mp4'), 'USERFILE');
    const r = placeVideo({ tmpPath, mediaDir: dir, importId: 7, ext: 'mp4', registeredPath: null });
    expect(r).toEqual({ ok: true, path: join(dir, 'media-7.2.mp4') });
    expect(readdirSync(dir).find((f) => f === 'media-7.mp4')).toBe('media-7.mp4');
  });
  it('D15:落序号名并登记后,再重下 → 覆盖自己登记的序号文件,用户手工文件不动(fix R6)', () => {
    writeFileSync(join(dir, 'media-7.mp4'), 'USERFILE');
    // 第一次:DB 没登记 → 落序号名,避开用户手工文件
    const r1 = placeVideo({ tmpPath, mediaDir: dir, importId: 7, ext: 'mp4', registeredPath: null });
    expect(r1).toEqual({ ok: true, path: join(dir, 'media-7.2.mp4') });
    writeFileSync(tmpPath, 'VIDEOBYTES2'); // 上一轮 rename 把 tmp 消耗掉了
    // 第二次重下:DB 已登记 media-7.2.mp4 → 序号查找途中命中它,允许覆盖;用户手工文件不动
    const r2 = placeVideo({ tmpPath, mediaDir: dir, importId: 7, ext: 'mp4', registeredPath: join(dir, 'media-7.2.mp4') });
    expect(r2).toEqual({ ok: true, path: join(dir, 'media-7.2.mp4') });
    expect(readFileSync(join(dir, 'media-7.2.mp4'), 'utf8')).toBe('VIDEOBYTES2');
    expect(readFileSync(join(dir, 'media-7.mp4'), 'utf8')).toBe('USERFILE');
  });
  it('换扩展名重下:只清登记的那个旧文件,未登记的同前缀孤儿不动(fix R6)', () => {
    writeFileSync(join(dir, 'media-7.webm'), 'OLD');
    // webm → mp4:登记的旧 webm 被清,规范名 mp4 直接落
    const r = placeVideo({ tmpPath, mediaDir: dir, importId: 7, ext: 'mp4', registeredPath: join(dir, 'media-7.webm') });
    expect(r).toEqual({ ok: true, path: join(dir, 'media-7.mp4') });
    expect(existsSync(join(dir, 'media-7.webm'))).toBe(false);
    // 再来一次,DB 未登记(mp4 已存在):落序号名;同前缀的未登记孤儿文件绝不被扫删
    writeFileSync(join(dir, 'media-7.3.webm'), 'ORPHAN');
    writeFileSync(tmpPath, 'VIDEOBYTES2'); // 上一轮 rename 把 tmp 消耗掉了
    const r2 = placeVideo({ tmpPath, mediaDir: dir, importId: 7, ext: 'mp4', registeredPath: null });
    expect(r2).toEqual({ ok: true, path: join(dir, 'media-7.2.mp4') });
    expect(readFileSync(join(dir, 'media-7.mp4'), 'utf8')).toBe('VIDEOBYTES');
    expect(readFileSync(join(dir, 'media-7.3.webm'), 'utf8')).toBe('ORPHAN');
  });
  it('目标被占用(rename 抛 EPERM)→ ok:false reason:busy,不误报成功', () => {
    const r = placeVideo({
      tmpPath, mediaDir: dir, importId: 7, ext: 'mp4', registeredPath: null,
      // 注入:模拟 Windows 上"文件被占用"的 rename 失败
      rename: () => { throw Object.assign(new Error('busy'), { code: 'EPERM' }); },
    } as never);
    expect(r).toEqual({ ok: false, reason: 'busy', message: '该视频正在被播放/处理，请先关闭预览再重试' });
    expect(findVideoFile(dir, 7)).toBeNull();
  });
  it('deleteVideoFiles:删掉该来源全部素材;不存在算空成功', () => {
    writeFileSync(join(dir, 'media-8.jpg'), 'x');
    expect(deleteVideoFiles(dir, 8).deleted).toEqual([join(dir, 'media-8.jpg')]);
    expect(deleteVideoFiles(dir, 8)).toEqual({ deleted: [], failed: [] });
  });
});
