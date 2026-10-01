// 输出目录的**唯一解析点**（spec D11）：设置里配了就用它，留空回退到传入的默认目录。
// 为什么要单一来源：设置路由（要回 output_dir_resolved 给前端）与导出 job（要决定落盘位置）
// 必须给出同一个答案；两处各写一份公式，迟早漂移（同族教训：P4-T7-7 的派生列 SQL 去重）。
import type { DB } from './db/index.js';
import { createSettingsRepo } from './db/repo/settings.js';
import { SETTINGS_KEYS } from './settings-keys.js';

export function resolveOutputDir(db: DB, fallbackDir: string): string {
  const configured = createSettingsRepo(db).get(SETTINGS_KEYS.outputDir);
  return configured !== null && configured.trim() !== '' ? configured : fallbackDir;
}
