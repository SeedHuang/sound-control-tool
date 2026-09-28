// server/src/ytdlp/ffprobe.test.ts
import { describe, expect, it } from 'vitest';
import { probeDuration } from './ffprobe.js';
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
