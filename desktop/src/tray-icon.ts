// 托盘图标的加载。
//
// 为什么要内嵌一份 base64(这是"打包后图标丢失"的根治手段):
//   原先只按 `__dirname/../assets/tray.png` 读文件 —— 这在 dev 下成立,但**打包形态
//   无法保证 assets/ 随包**(electron-builder 至今未引入,推迟到 M3 后,所以打包器的
//   文件包含规则目前无从验证)。凡是"依赖运行时路径"的方案,都可能在某次打包后
//   悄悄退化成空白图位;而空白托盘图标在真机上极难排查(用户只看到"托盘点不到")。
//   故改为:优先读文件(方便换图),读不到就用**内嵌的那一份**。内嵌串与文件同源,
//   由 scripts/make-tray-icon.mjs 生成(该脚本会打印可直接粘回的 base64)。
import { existsSync } from 'node:fs';
import path from 'node:path';
import { nativeImage, type NativeImage } from 'electron';

/** desktop/assets/tray.png 的逐字节副本(149 字节 PNG)。换图请重跑 make-tray-icon.mjs 并同步此串。 */
const TRAY_ICON_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAXElEQVR4nO3WMQoAMAgDQF/Rr/b5du3SDjEigQiu5hALjbUzJzsMMEAS8CoDDDDAgBZAtSgb6ArXASCIliNkh0OvgBmuCfghkFnwj4gRXgLciMoMbQCjDTBgHHAAQ/cE3KShDnAAAAAASUVORK5CYII=';

/**
 * 候选文件路径。顺序有意如此:
 *   ① `dist/assets` —— build 会把 assets/ 拷进 dist/,这是"打包只带 dist/"时的正常命中点
 *   ② `dist` 的上一级 —— dev 形态(`electron .` + main=dist/main.js)下的命中点
 * 两个都存在时内容相同(同一份文件),所以顺序不影响结果。
 */
const CANDIDATE_PATHS = [
  path.join(__dirname, 'assets', 'tray.png'),
  path.join(__dirname, '..', 'assets', 'tray.png'),
];

function loadFromDisk(): NativeImage | null {
  for (const candidate of CANDIDATE_PATHS) {
    try {
      if (!existsSync(candidate)) continue;
      const img = nativeImage.createFromPath(candidate);
      if (!img.isEmpty()) return img;
      // 文件在但解不出图(损坏/被换成非 PNG):跳过,交给内嵌兜底
      console.error(`[electron] tray:图标解码为空,跳过(${candidate})`);
    } catch (e) {
      console.error(`[electron] tray:读图标失败,跳过(${candidate}):${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return null;
}

/** 加载托盘图标:文件优先(便于换图)→ 内嵌副本 → 空图(理论上到不了这一步)。 */
export function loadTrayIcon(): NativeImage {
  const fromDisk = loadFromDisk();
  if (fromDisk !== null) return fromDisk;

  // 文件读不到不是错误:打包形态可能只带 dist/,内嵌副本才是稳定来源
  const embedded = nativeImage.createFromDataURL(`data:image/png;base64,${TRAY_ICON_PNG_BASE64}`);
  if (!embedded.isEmpty()) {
    console.log('[electron] tray:未找到图标文件,使用内嵌图标');
    return embedded;
  }
  console.error('[electron] tray:内嵌图标解码为空(不应发生),用空图兜底');
  return nativeImage.createEmpty();
}
