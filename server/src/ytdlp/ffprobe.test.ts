// server/src/ytdlp/ffprobe.test.ts
import { describe, expect, it } from 'vitest';
import { probeDuration, probeVideoMeta } from './ffprobe.js';
describe('probeDuration', () => {
  it('解析 format.duration 为秒', async () => {
    const doExec = ((_b: string, _a: string[], _o: unknown, cb: (e: null, out: string) => void) => {
      cb(null, '{"format":{"duration":"61.500000"}}');
    }) as never;
    await expect(probeDuration('ffprobe', 'x.mp3', 10000, doExec)).resolves.toBe(61.5);
  });
  it('执行失败返回 null', async () => {
    const doExec = ((_b: string, _a: string[], _o: unknown, cb: (e: Error) => void) => {
      cb(new Error('boom'));
    }) as never;
    await expect(probeDuration('ffprobe', 'x.mp3', 10000, doExec)).resolves.toBeNull();
  });
  it('JSON 缺 duration 返回 null', async () => {
    const doExec = ((_b: string, _a: string[], _o: unknown, cb: (e: null, out: string) => void) => {
      cb(null, '{"format":{}}');
    }) as never;
    await expect(probeDuration('ffprobe', 'x.mp3', 10000, doExec)).resolves.toBeNull();
  });
});
describe('probeVideoMeta（N1 Task 2：视频宽高，入库用）', () => {
  it('参数快照：-v error -select_streams v:0 -show_entries stream=width,height -of json', async () => {
    let got: string[] = [];
    const doExec = ((_b: string, a: string[], _o: unknown, cb: (e: null, out: string) => void) => {
      got = a;
      cb(null, '{"streams":[{"width":3840,"height":2160}]}');
    }) as never;
    await expect(probeVideoMeta('ffprobe', 'x.mp4', 10000, doExec)).resolves.toEqual({ width: 3840, height: 2160 });
    expect(got).toEqual(['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', 'x.mp4']);
  });
  it('执行失败 → {width:null,height:null}，不抛错（调用方按未知处理）', async () => {
    const doExec = ((_b: string, _a: string[], _o: unknown, cb: (e: Error) => void) => {
      cb(new Error('boom'));
    }) as never;
    await expect(probeVideoMeta('ffprobe', 'x.mp4', 10000, doExec)).resolves.toEqual({ width: null, height: null });
  });
  it('无视频流（纯音频文件 streams 为空）→ null/null', async () => {
    const doExec = ((_b: string, _a: string[], _o: unknown, cb: (e: null, out: string) => void) => {
      cb(null, '{"streams":[]}');
    }) as never;
    await expect(probeVideoMeta('ffprobe', 'x.mp3', 10000, doExec)).resolves.toEqual({ width: null, height: null });
  });
  it('JSON 解析失败 → null/null', async () => {
    const doExec = ((_b: string, _a: string[], _o: unknown, cb: (e: null, out: string) => void) => {
      cb(null, 'not-json');
    }) as never;
    await expect(probeVideoMeta('ffprobe', 'x.mp4', 10000, doExec)).resolves.toEqual({ width: null, height: null });
  });
  it('流里缺 width/height 字段 → null/null', async () => {
    const doExec = ((_b: string, _a: string[], _o: unknown, cb: (e: null, out: string) => void) => {
      cb(null, '{"streams":[{"codec_name":"h264"}]}');
    }) as never;
    await expect(probeVideoMeta('ffprobe', 'x.mp4', 10000, doExec)).resolves.toEqual({ width: null, height: null });
  });
});
