// server/src/ytdlp/errors.ts
export interface YtdlpErrorInfo { code: string; message: string; next: string }
// D9:stderr 特征 → 中文 message + 可执行 next。特征匹配按优先级(DRM > 登录 > 站点 > 网络)
export function mapYtdlpError(e: { code?: string; stderr?: string; binPath?: string | null }): YtdlpErrorInfo {
  if (e.code === 'ENOENT' || !e.binPath) {
    return { code: 'YTDLP_NOT_FOUND', message: 'yt-dlp 未找到或路径无效', next: '请到设置页配置 yt-dlp 路径后重试' };
  }
  const s = e.stderr ?? '';
  if (/DRM|inaccessible|playright/i.test(s)) return { code: 'DRM', message: '该内容受 DRM 保护，无法下载音频', next: '换用可下载的源，或录制系统声音' };
  if (/sign in|login|authentication|会员|登录/i.test(s)) return { code: 'AUTH_REQUIRED', message: '该内容需要登录/会员才能下载', next: '登录对应网站后重试（yt-dlp 不支持网页登录态时，需另想办法）' };
  if (/unsupported URL|no such extractor|不支持/i.test(s)) return { code: 'UNSUPPORTED_SITE', message: '该站点 yt-dlp 暂不支持', next: '换用支持的站点，或录制系统声音' };
  if (/timed out|connection|network|无法解析|403|404/i.test(s)) return { code: 'NETWORK', message: '网络请求失败或资源不可达', next: '检查网络后重试' };
  return { code: 'YTDLP_ERROR', message: s.trim().split(/\r?\n/).slice(-3).join(' ').slice(0, 200), next: '重试；若反复失败，换用录制系统声音' };
}
