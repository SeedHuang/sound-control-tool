export const SETTINGS_KEYS = {
  outputDir: 'output_dir',
  defaultFormat: 'default_format',
  defaultBitrate: 'default_bitrate',
  binYtdlp: 'bin_ytdlp',
  binFfmpeg: 'bin_ffmpeg',
  binsProbedAt: 'bins_probed_at',
  // 下载保护类设置（spec D2/D17）：三项只影响**下载**任务（剪辑/导出不受影响，D18）。
  // 键名与 default 值集中在此——PUT 校验与 index.ts 装配都从这里取值，避免两处各写一份漂移。
  maxConcurrentDownloads: 'max_concurrent_downloads', // 同时下载数，默认 '1'，合法 1..5
  downloadSleepSeconds: 'download_sleep_seconds', // 合集批量请求间隔(秒)，默认 '0'，合法 0..10
  downloadLimitRate: 'download_limit_rate', // 限速，默认 ''（不限），非空须形如 '500K'
  // 剪辑室 hover 预览的默认开关（spec clip-works D12）：'1' = 静音（默认）。加入白名单才能被 PUT。
  studioPreviewMuted: 'studio_preview_muted',
} as const;

// B 站 Cookie 存储键:故意不加入 SETTINGS_KEYS——settings 路由的白名单按 Object.values(SETTINGS_KEYS) 过滤,
// 一旦加入,GET /api/settings 就会把凭据内容回传 UI。凭据只经 /api/cookie 路由读写(GET 只回 set/length 元数据)。
export const BILI_COOKIE_KEY = 'bili_cookie';
