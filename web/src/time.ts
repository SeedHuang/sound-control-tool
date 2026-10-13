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

/**
 * 秒 → `mm:ss.mmm`（毫秒级）。
 * 为什么单独开一个而不改 fmtTime：fmtTime 是全站唯一定义，被轨道时间尺与时长标签共用，
 * 改它的输出会把那些地方一起改掉（那是改变既有 UI，不是加功能）。
 * 判据：同一语义区用同一格式 —— 轨道时间尺/时长标签是 mm:ss，需要毫秒的地方另走这里。
 *
 * ⚠️ 浮点陷阱：浮点秒数直接乘 1000 再取整会得到 1.23 → 1229.9999... 这类值，
 *   直接 Math.floor 会得到 "00:01.229"。故先 Math.round 到毫秒再拆分。
 */
export const fmtTimeMs = (sec: number): string => {
  const totalMs = Math.round(Math.max(0, sec) * 1000);
  const ms = totalMs % 1000;
  const totalSec = Math.floor(totalMs / 1000);
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return `${p(Math.floor(totalSec / 60))}:${p(totalSec % 60)}.${p(ms, 3)}`;
};

/**
 * `mm:ss.mmm` / `ss.mmm` / `m:ss` → 秒。解析失败（空串、纯文字、多个冒号）返 null。
 * 调用方拿到 null 时的责任：夹到合法边界，不要弹错误 —— 用户敲错一个字符不该被拦下，
 *   越界夹边界比报错顺手（spec D7）。
 * 接受不带分钟的形式（"23.456"）是刻意的：用户很可能只敲秒段。
 */
export const parseTimeMs = (text: string): number | null => {
  const t = text.trim();
  if (t === '') return null;
  const parts = t.split(':');
  if (parts.length > 2) return null;
  // ⚠️ 分两支取确定值，**不要**写成 `[head, tail] = parts` 后统一判 undefined ——
  //   不带分钟的形式（"23.456"）里 tail 本来就是 undefined，那样写会把「允许单段」这个
  //   有意设计直接判成解析失败（noUncheckedIndexedAccess 下 parts[i] 是 string | undefined）。
  const hasMin = parts.length === 2;
  const minPart = hasMin ? parts[0] : undefined;
  const secPart = hasMin ? parts[1] : parts[0];
  if (secPart === undefined) return null;
  if (hasMin) {
    // 分钟段必须是纯数字；秒段允许带小数
    if (minPart === undefined || !/^\d+$/.test(minPart)) return null;
  }
  if (!/^\d+(\.\d+)?$/.test(secPart)) return null;
  const secs = Number(secPart);
  const mins = hasMin && minPart !== undefined ? Number(minPart) : 0;
  if (!Number.isFinite(secs) || !Number.isFinite(mins)) return null;
  return mins * 60 + secs;
};