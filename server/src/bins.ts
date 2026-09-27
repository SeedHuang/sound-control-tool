import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const WIN = process.platform === 'win32';

/** PATH 分隔符切分 + 拼可执行名;空段忽略。纯函数(无 IO)供单测 */
export function candidatesFromPath(pathVar: string, name: string): string[] {
  const exe = WIN ? `${name}.exe` : name;
  return pathVar
    .split(path.delimiter)
    .filter(Boolean)
    .map((dir) => path.join(dir, exe));
}

export type BinName = 'yt-dlp' | 'ffmpeg';

/** 版本旗标因二进制而异:yt-dlp 用 `--version`,ffmpeg 只认 `-version`(双横线会报 Unrecognized option 并非零退出) */
const VERSION_FLAG: Record<BinName, string> = { 'yt-dlp': '--version', ffmpeg: '-version' };

export interface BinProbe {
  path: string | null;
  version: string | null;
}

/** 探测二进制:explicitPath 优先,否则扫 PATH;取首个存在的候选,版本取 stdout 首个非空行 */
export function probeBin(name: BinName, explicitPath?: string): Promise<BinProbe> {
  const candidates = explicitPath ? [explicitPath] : candidatesFromPath(process.env['PATH'] ?? '', name);
  // explicitPath 优先且不校验存在性;否则取首个真实存在的候选,全不存在则 path=null。
  // 用 || 而非 ??:空串 '' 视为"未提供"(与上一行 candidates 三元一致),否则空串会让 PATH 候选被静默丢弃
  const bin = explicitPath || candidates.find((p) => existsSync(p));
  return new Promise((resolve) => {
    if (!bin) return resolve({ path: null, version: null });
    // windowsHide:控制台子系统二进制在 Windows 上会弹控制台窗口
    execFile(bin, [VERSION_FLAG[name]], { timeout: 8000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve({ path: bin, version: null });
      // split()[0] 恒为字符串(可能为 '');空串需归一化为 null,否则与 string|null 契约冲突
      const v = stdout.trim().split(/\r?\n/)[0];
      resolve({ path: bin, version: v ? v : null });
    });
  });
}
