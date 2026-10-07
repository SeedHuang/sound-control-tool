// 「谁在出声」注册表 —— 保证同一时刻只有一路音频在响。
// 存在理由：单例播放引擎只覆盖「播放器自己」，而 WorkPreview 的 hover 预览会另起媒体元素。
// 两者若各播各的会重叠出声（听感混乱 + 双份解码）。
const sources = new Set<() => void>();

/** 注册一个"能出声的源"，返回注销函数（组件卸载时调用）。 */
export function registerSource(pause: () => void): () => void {
  sources.add(pause);
  return () => { sources.delete(pause); };
}

/** 停掉除 self 外的所有源（self = 即将出声的那个 pause 函数）。 */
export function silenceOthers(self: () => void): void {
  for (const p of sources) {
    if (p !== self) { try { p(); } catch { /* 单个源出错不影响其它 */ } }
  }
}
