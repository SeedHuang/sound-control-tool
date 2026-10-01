import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { buildDownloadArgs, buildParseArgs, buildProbeFormatsArgs, buildVideoDownloadArgs, buildWriteThumbnailArgs } from './args.js';
describe('buildParseArgs', () => {
  it('固定 -J --flat-playlist --no-warnings', () => {
    expect(buildParseArgs('https://b23.tv/abc')).toEqual(['-J', '--flat-playlist', '--no-warnings', 'https://b23.tv/abc']);
  });
});
// 2026-09-29:封面改由 yt-dlp 自己写(--write-thumbnail)——Node fetch 不读系统代理,外网图床直连必超时
describe('buildWriteThumbnailArgs', () => {
  it('--skip-download + --write-thumbnail + 只取第 1 集 + -o 模板', () => {
    const a = buildWriteThumbnailArgs('https://b23.tv/abc', 'D:/covers/cover-5.%(ext)s');
    expect(a).toEqual(['--skip-download', '--write-thumbnail', '--playlist-items', '1', '--no-warnings', '-o', 'D:/covers/cover-5.%(ext)s', 'https://b23.tv/abc']);
    expect(a).not.toContain('--flat-playlist');
    expect(a).not.toContain('-J');
  });
});
describe('buildDownloadArgs', () => {
  it('单条强制 --no-playlist + 含 --windows-filenames', () => {
    const a = buildDownloadArgs({ url: 'u', options: { format: 'mp3' }, outDir: 'D:/tmp' });
    expect(a).toContain('--no-playlist');
    expect(a).toContain('--windows-filenames');
    expect(a).toContain('-o');
  });
  it('合集单元素换算 --playlist-items(D8:单产物模型,多选由前端逐条提交)', () => {
    const a = buildDownloadArgs({ url: 'u', options: { format: 'm4a', entryIndices: [3] }, outDir: 'D:/tmp' });
    expect(a).toContain('--playlist-items');
    expect(a[a.indexOf('--playlist-items') + 1]).toBe('3');
  });
  it('无 entryIndices 时强制 --no-playlist', () => {
    const a = buildDownloadArgs({ url: 'u', options: { format: 'mp3' }, outDir: 'D:/tmp' });
    expect(a).toContain('--no-playlist');
    expect(a).not.toContain('--playlist-items');
  });
  it('片段下载带 --download-sections', () => {
    const a = buildDownloadArgs({ url: 'u', options: { format: 'wav', section: { start: 61, end: 184.5 } }, outDir: 'D:/tmp' });
    expect(a).toContain('--download-sections');
    expect(a[a.indexOf('--download-sections') + 1]).toBe('*61-184.5');
  });
  it('quality 缺省时不出现 --audio-quality', () => {
    const a = buildDownloadArgs({ url: 'u', options: { format: 'mp3' }, outDir: 'D:/tmp' });
    expect(a).not.toContain('--audio-quality');
  });
});
describe('cookiePath 注入(--cookies,B 站风控)', () => {
  it('buildParseArgs 带 cookiePath → --cookies + 路径插在 url 之前', () => {
    expect(buildParseArgs('u', 'D:/sct-data/cookies.txt')).toEqual(['--cookies', 'D:/sct-data/cookies.txt', '-J', '--flat-playlist', '--no-warnings', 'u']);
  });
  it('buildParseArgs 无 cookiePath → 不含 --cookies(原形态不变)', () => {
    expect(buildParseArgs('u')).toEqual(['-J', '--flat-playlist', '--no-warnings', 'u']);
  });
  it('buildDownloadArgs 带 cookiePath → 含 --cookies 且位于 url 之前', () => {
    const a = buildDownloadArgs({ url: 'u', options: { format: 'mp3' }, outDir: 'D:/tmp', cookiePath: 'D:/sct-data/cookies.txt' });
    expect(a).toContain('--cookies');
    expect(a[a.indexOf('--cookies') + 1]).toBe('D:/sct-data/cookies.txt');
    expect(a.indexOf('--cookies')).toBeLessThan(a.lastIndexOf('u'));
  });
  it('buildDownloadArgs 无 cookiePath → 不含 --cookies', () => {
    const a = buildDownloadArgs({ url: 'u', options: { format: 'mp3' }, outDir: 'D:/tmp' });
    expect(a).not.toContain('--cookies');
  });
});
describe('buildVideoDownloadArgs(下视频做定位素材)', () => {
  const base = { url: 'https://a/v', outDir: 'C:/tmp/job1', videoHeight: 480 as const };
  it('不含 -x(那是抽音频,会把视频流丢掉);强制 mp4 合流;要音轨(剪辑从它抽音)', () => {
    const args = buildVideoDownloadArgs(base);
    expect(args).not.toContain('-x');
    expect(args).toContain('--merge-output-format');
    expect(args[args.indexOf('--merge-output-format') + 1]).toBe('mp4');
    expect(args.join(' ')).toContain('height<=480');
  });
  it('带 cookie 时 --cookies 在 url 之前;输出模板在 outDir 下', () => {
    const args = buildVideoDownloadArgs({ ...base, cookiePath: 'C:/tmp/ck.txt' });
    expect(args.indexOf('--cookies')).toBeLessThan(args.indexOf('https://a/v'));
    expect(args[args.indexOf('-o') + 1]).toBe(join('C:/tmp/job1', '%(id)s.%(ext)s'));
  });
  it('进度模板与音频那条一致(前端进度条复用)', () => {
    expect(buildVideoDownloadArgs(base).join(' ')).toContain('--progress-template');
  });
  // P2 方案A(Task 1,2026-09-30):视频单集下载——镜像音频侧 entryIndices → --playlist-items(D8 单产物模型)
  it('带 entryIndices: [3] → 追加 --playlist-items 3(镜像音频侧)', () => {
    const args = buildVideoDownloadArgs({ ...base, entryIndices: [3] });
    expect(args).toContain('--playlist-items');
    expect(args[args.indexOf('--playlist-items') + 1]).toBe('3');
    expect(args).not.toContain('--no-playlist');
  });
  it('不带 entryIndices → 保持 --no-playlist(单视频素材不受影响)', () => {
    const args = buildVideoDownloadArgs(base);
    expect(args).toContain('--no-playlist');
    expect(args).not.toContain('--playlist-items');
  });
  // Task 2(2026-09-30 spec D10):videoHeight 类型放宽为整数 → 实测档/非规整值都能直接拼进表达式(表达式本身未改)
  it('任意整数档位(1440、1056 等非规整实测值)直接拼进 height<=N', () => {
    expect(buildVideoDownloadArgs({ url: 'u', outDir: 'D:/t', videoHeight: 1440 }).join(' ')).toContain('height<=1440');
    expect(buildVideoDownloadArgs({ url: 'u', outDir: 'D:/t', videoHeight: 1056 }).join(' ')).toContain('height<=1056');
  });
});
// Task 3(2026-09-30 spec D15/D18):风控节流只作用于下载,0/空一律不拼(默认即"不限",保持既有行为)
describe('风控节流参数(spec D15/D18)', () => {
  const baseVideo = { url: 'https://a/v', outDir: 'C:/tmp/job1', videoHeight: 480 };
  const baseAudio = { url: 'u', options: { format: 'mp3' as const }, outDir: 'D:/tmp' };
  it('视频 sleepSeconds>0 → 下载参数含 --sleep-requests <n>', () => {
    const a = buildVideoDownloadArgs({ ...baseVideo, throttle: { sleepSeconds: 2 } });
    expect(a[a.indexOf('--sleep-requests') + 1]).toBe('2');
  });
  it('音频 sleepSeconds>0 → 同样含 --sleep-requests <n>(两支都受保护)', () => {
    const a = buildDownloadArgs({ ...baseAudio, throttle: { sleepSeconds: 3 } });
    expect(a[a.indexOf('--sleep-requests') + 1]).toBe('3');
  });
  it('sleepSeconds=0/缺省 → 不含 --sleep-requests(两支)', () => {
    expect(buildVideoDownloadArgs({ ...baseVideo, throttle: { sleepSeconds: 0 } })).not.toContain('--sleep-requests');
    expect(buildVideoDownloadArgs(baseVideo)).not.toContain('--sleep-requests');
    expect(buildDownloadArgs({ ...baseAudio, throttle: { sleepSeconds: 0 } })).not.toContain('--sleep-requests');
    expect(buildDownloadArgs(baseAudio)).not.toContain('--sleep-requests');
  });
  it('limitRate 非空 → 含 --limit-rate;空串/缺省 → 不含(两支)', () => {
    expect(buildDownloadArgs({ ...baseAudio, throttle: { limitRate: '500K' } })).toContain('--limit-rate');
    expect(buildVideoDownloadArgs({ ...baseVideo, throttle: { limitRate: '500K' } })).toContain('--limit-rate');
    expect(buildDownloadArgs({ ...baseAudio, throttle: { limitRate: '' } })).not.toContain('--limit-rate');
    expect(buildVideoDownloadArgs(baseVideo)).not.toContain('--limit-rate');
  });
  it('节流只进下载参数——探测/解析/封面参数不含(拿 buildProbeFormatsArgs / buildParseArgs / buildWriteThumbnailArgs 断言)', () => {
    expect(buildProbeFormatsArgs('https://a/v')).not.toContain('--sleep-requests');
    expect(buildProbeFormatsArgs('https://a/v')).not.toContain('--limit-rate');
    expect(buildParseArgs('https://a/v')).not.toContain('--limit-rate');
    expect(buildParseArgs('https://a/v')).not.toContain('--sleep-requests');
    expect(buildWriteThumbnailArgs('https://a/v', 'D:/c/x.%(ext)s')).not.toContain('--limit-rate');
  });
  // 回归保护:默认设置(0/空/缺省)下,拼了 throttle 与不拼 throttle 的参数必须逐字一致——
  // 这条钉死"改造未改变既有下载行为",任何一处多拼/少拼都会红
  it('默认值(0/空/缺省)与不传 throttle 逐字一致(默认行为不变)', () => {
    expect(buildDownloadArgs({ ...baseAudio, throttle: { sleepSeconds: 0, limitRate: '' } }))
      .toEqual(buildDownloadArgs(baseAudio));
    expect(buildVideoDownloadArgs({ ...baseVideo, throttle: { sleepSeconds: 0, limitRate: '' } }))
      .toEqual(buildVideoDownloadArgs(baseVideo));
  });
});
