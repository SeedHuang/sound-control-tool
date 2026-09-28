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
