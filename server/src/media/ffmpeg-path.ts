// 为什么单独一个模块:剪辑路由与"重试剪辑任务"两条路径都要解析 ffmpeg,不能各写一份(spec D10)。
import { probeBin } from '../bins.js';
import type { DB } from '../db/index.js';
import { createSettingsRepo } from '../db/repo/settings.js';
import { SETTINGS_KEYS } from '../settings-keys.js';
import { pushLog } from '../logs.js';

/**
 * ffmpeg 路径:设置页配了就用它,空则扫 PATH。
 * 与既有 getFfprobe 的关键区别:那里拿不到就**静默跳过**(探测可选),这里拿不到剪辑整个不可用 → 返回 null 让上层报错。
 */
export async function resolveFfmpegPath(db: DB): Promise<string | null> {
  const configured = createSettingsRepo(db).get(SETTINGS_KEYS.binFfmpeg);
  if (configured !== null && configured.trim() !== '') return configured;
  const probed = await probeBin('ffmpeg');
  // source 用 'media'(logs.ts 批4 起已有 'clip';这行报的是环境级 ffmpeg 缺失,发生在具体剪辑任务开始前,沿用 'media' 与 media 域日志连续)
  if (probed.path === null) pushLog('error', 'media', 'ffmpeg 既未配置也不在 PATH —— 剪辑不可用');
  return probed.path;
}
