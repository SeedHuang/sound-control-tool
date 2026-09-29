export const SETTINGS_KEYS = {
  outputDir: 'output_dir',
  defaultFormat: 'default_format',
  defaultBitrate: 'default_bitrate',
  binYtdlp: 'bin_ytdlp',
  binFfmpeg: 'bin_ffmpeg',
  binsProbedAt: 'bins_probed_at',
} as const;

// B 站 Cookie 存储键:故意不加入 SETTINGS_KEYS——settings 路由的白名单按 Object.values(SETTINGS_KEYS) 过滤,
// 一旦加入,GET /api/settings 就会把凭据内容回传 UI。凭据只经 /api/cookie 路由读写(GET 只回 set/length 元数据)。
export const BILI_COOKIE_KEY = 'bili_cookie';
