import { describe, expect, it } from 'vitest';
import { mapYtdlpError } from './errors.js';
describe('mapYtdlpError', () => {
  it('ENOENT → YTDLP_NOT_FOUND + 设置页指引', () => {
    const r = mapYtdlpError({ code: 'ENOENT' });
    expect(r.code).toBe('YTDLP_NOT_FOUND');
    expect(r.next).toContain('设置页');
  });
  it('binPath 为 null → YTDLP_NOT_FOUND', () => {
    expect(mapYtdlpError({ binPath: null }).code).toBe('YTDLP_NOT_FOUND');
  });
  it('DRM 特征', () => {
    expect(mapYtdlpError({ stderr: 'ERROR: This video is DRM protected', binPath: 'yt-dlp' }).code).toBe('DRM');
  });
  it('需登录特征', () => {
    expect(mapYtdlpError({ stderr: 'Please sign in to view this content', binPath: 'yt-dlp' }).code).toBe('AUTH_REQUIRED');
  });
  it('未知错误摘要截断 + 重试指引', () => {
    const r = mapYtdlpError({ stderr: 'ERROR: Something weird happened', binPath: 'yt-dlp' });
    expect(r.code).toBe('YTDLP_ERROR');
    expect(r.next).toContain('重试');
  });
});
describe('412 风控映射与空 stderr 兜底', () => {
  it('412/Precondition Failed → RISK_CONTROL + 设置页指引', () => {
    const r = mapYtdlpError({ code: '1', stderr: 'ERROR: [bilibili] HTTP Error 412: Precondition Failed', binPath: 'yt-dlp' });
    expect(r.code).toBe('RISK_CONTROL');
    expect(r.message).toContain('412');
    expect(r.next).toContain('设置页');
  });
  it('优先级:DRM 在 412 之前(同时命中 → DRM)', () => {
    expect(mapYtdlpError({ stderr: 'DRM protected; HTTP 412', binPath: 'yt-dlp' }).code).toBe('DRM');
  });
  it('412 在登录之前:纯 login 文本仍 AUTH_REQUIRED', () => {
    expect(mapYtdlpError({ stderr: 'please login to continue', binPath: 'yt-dlp' }).code).toBe('AUTH_REQUIRED');
  });
  it('非零退出但 stderr 为空 → message 不得为空(带退出码)', () => {
    const r = mapYtdlpError({ code: '1', stderr: '', binPath: 'yt-dlp' });
    expect(r.code).toBe('YTDLP_ERROR');
    expect(r.message).toBe('yt-dlp 退出码 1（无 stderr 输出）');
  });
  it('code 缺失且 stderr 空 → 退出码显示 未知', () => {
    expect(mapYtdlpError({ stderr: '   ', binPath: 'yt-dlp' }).message).toBe('yt-dlp 退出码 未知（无 stderr 输出）');
  });
});
