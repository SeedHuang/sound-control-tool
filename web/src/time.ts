// 时间码格式化（全站唯一定义，2026-10-09 审查第 3 轮抽出）。
//
// ⚠️ **只有 `mm:ss` 这一种规格走这里**。播放器时间码的 `m:ss`（分钟不补零）是**另一种规格**，
//   它留在 CyberAudioPlayer 里自己实现，**不要**把它合进本文件：
//   合并会把播放器时间码从「1:05」变成「01:05」，那是改变既有 UI，不是去重。
//   判据：同一屏幕/同一语义区用同一格式；播放器按 spec §9 定的是 m:ss，轨道与段列表用的是 mm:ss。

/** 秒 → `mm:ss`（分钟与秒都补零）。轨道时间尺、段列表、时长标签统一走这里，避免同一屏出现两套写法。 */
export const fmtTime = (sec: number): string => {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(Math.floor(sec / 60))}:${p(Math.floor(sec % 60))}`;
};