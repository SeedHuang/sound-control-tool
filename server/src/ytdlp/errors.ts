// server/src/ytdlp/errors.ts
export interface YtdlpErrorInfo { code: string; message: string; next: string }
// D9:stderr 特征 → 中文 message + 可执行 next。特征匹配按优先级(DRM > 412 风控 > 登录 > 站点 > 网络)
export function mapYtdlpError(e: { code?: string; stderr?: string; binPath?: string | null }): YtdlpErrorInfo {
  if (e.code === 'ENOENT' || !e.binPath) {
    return { code: 'YTDLP_NOT_FOUND', message: 'yt-dlp 未找到或路径无效', next: '请到设置页配置 yt-dlp 路径后重试' };
  }
  const s = e.stderr ?? '';
  if (/DRM|inaccessible|playright/i.test(s)) return { code: 'DRM', message: '该内容受 DRM 保护，无法下载音频', next: '换用可下载的源，或录制系统声音' };
  // B 站 412 风控(置于 DRM 之后、登录之前):未带登录 Cookie 被风控拦截,用户可自助修复(设置页贴 Cookie)
  if (/412|Precondition Failed/i.test(s)) return { code: 'RISK_CONTROL', message: 'B 站风控拦截（HTTP 412）：该内容需要登录 Cookie 才能访问', next: '到设置页粘贴 B 站 Cookie 后重试' };
  if (/sign in|login|authentication|会员|登录/i.test(s)) return { code: 'AUTH_REQUIRED', message: '该内容需要登录/会员才能下载', next: '登录对应网站后重试（yt-dlp 不支持网页登录态时，需另想办法）' };
  if (/unsupported URL|no such extractor|不支持/i.test(s)) return { code: 'UNSUPPORTED_SITE', message: '该站点 yt-dlp 暂不支持', next: '换用支持的站点，或录制系统声音' };
  if (/timed out|connection|network|无法解析|403|404/i.test(s)) return { code: 'NETWORK', message: '网络请求失败或资源不可达', next: '检查网络后重试' };
  // 输出撑爆子进程缓冲(2026-09-29 实测:某 YouTube 视频 -J 输出 11MB,当时上限 4MB)。
  // 这条没有 stderr 可匹配,只能靠 Node 的错误码识别;不给映射的话用户看到的是那串包名,完全不知道怎么回事。
  if (/MAXBUFFER/i.test(e.code ?? '')) {
    return { code: 'OUTPUT_TOO_LARGE', message: 'yt-dlp 的输出过大,超出程序缓冲上限', next: '换更短的视频/更小的合集重试;反复出现请把这条日志发给开发者' };
  }
  // 摘要为空(无 stderr 输出)不得返回空 message:至少让用户看到退出码
  const summary = s.trim();
  return {
    code: 'YTDLP_ERROR',
    message: summary ? summary.split(/\r?\n/).slice(-3).join(' ').slice(0, 200) : `yt-dlp 退出码 ${e.code ?? '未知'}（无 stderr 输出）`,
    next: '重试；若反复失败，换用录制系统声音',
  };
}
