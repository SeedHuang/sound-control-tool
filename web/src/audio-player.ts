// 单例播放引擎：全应用**唯一**的音频媒体元素 + 一份播放状态。
// 为什么单例（spec D4）：① 全局单实例纪律需要跨页面互斥；② 顶栏「预览音频」按钮要复用同一实例——
//   「谁在播」必须只有一个真相，否则按钮与列表行会各持一份、必然漂移。
// 订阅走 React 18 内建 useSyncExternalStore，不引状态管理库。
import { getPreviewMuted, getSettings, logFe, putSettings, setPreviewMuted } from '@/api';
import { registerSource, silenceOthers } from '@/silence';

export type PlayerState = {
  audioId: number | null;
  playing: boolean;
  loading: boolean;
  duration: number;
  volume: number;
  muted: boolean;
  rate: number;
  error: string | null;
};

const INITIAL: PlayerState = {
  audioId: null, playing: false, loading: false, duration: 0,
  volume: 0.8, muted: true, rate: 1, error: null,
};

let el: HTMLAudioElement | null = null;
let state: PlayerState = INITIAL;
const listeners = new Set<() => void>();
const timeListeners = new Set<(t: number) => void>();

function emit(): void { for (const l of listeners) l(); }
function set(patch: Partial<PlayerState>): void { state = { ...state, ...patch }; emit(); }

/** 播放器侧的音量设置键（静音复用既有的 studio_preview_muted，不新建第二份状态）。 */
const VOLUME_KEY = 'studio_player_volume';

/** 引擎的「暂停」动作 —— 必须是**稳定引用**：注册表靠引用比对跳过 self，
 *  若每次传新的箭头函数，引擎会把自己也停掉（起播瞬间被 pause，症状是点播放没反应）。 */
function pauseEngine(): void {
  try { el?.pause(); } catch { /* 元素已销毁，忽略 */ }
}

function ensureEl(): HTMLAudioElement {
  if (el !== null) return el;
  const a = new Audio();
  a.preload = 'metadata';
  a.addEventListener('loadedmetadata', () => set({ duration: Number.isFinite(a.duration) ? a.duration : 0 }));
  a.addEventListener('play', () => set({ playing: true, loading: false }));
  a.addEventListener('pause', () => set({ playing: false }));
  a.addEventListener('ended', () => { set({ playing: false }); seek(0); });
  a.addEventListener('timeupdate', () => { for (const cb of timeListeners) cb(a.currentTime); });
  a.addEventListener('error', () => {
    logFe('error', `播放器加载失败 id=${state.audioId ?? '(none)'}`);
    set({ playing: false, loading: false, error: '音频加载失败' });
  });
  el = a;
  registerSource(pauseEngine); // 登记进互斥表：其它源（如 hover 预览）起播时能停掉引擎
  return a;
}

/** 页面启动时读持久化的总开关与音量（失败不阻塞——用默认值继续）。 */
export function initFromSettings(): void {
  void getPreviewMuted().then((m) => set({ muted: m })).catch(() => { /* 用默认 */ });
  void getSettings()
    .then((s) => {
      const v = Number(s[VOLUME_KEY]);
      if (Number.isFinite(v) && v >= 0 && v <= 1) set({ volume: v });
      applyVolume();
    })
    .catch(() => { /* 用默认 */ });
}

function applyVolume(): void {
  if (el === null) return;
  el.volume = state.volume;
  el.muted = state.muted;
  el.playbackRate = state.rate;
}

/** 播/停切换：同一 id → 切；不同 id → 装载并播（先停旧的 → 全局单实例）。 */
export function toggle(audioId: number, src: string): void {
  const a = ensureEl();
  if (state.audioId === audioId && !a.paused) { a.pause(); return; }
  silenceOthers(pauseEngine); // 让 hover 预览等其它源先停（self 必须是同一引用，见 pauseEngine 注释）
  if (state.audioId !== audioId || a.src !== src) {
    a.src = src;
    set({ audioId, duration: 0, error: null });
  }
  applyVolume();
  set({ loading: true });
  logFe('info', `播放器起播 id=${audioId}`);
  void a.play().then(() => set({ loading: false })).catch((e: unknown) => {
    logFe('error', `播放器起播失败 id=${audioId}: ${(e as Error).message}`);
    set({ loading: false, playing: false, error: '起播失败' });
  });
}

export function stop(): void {
  if (el !== null) el.pause();
  set({ audioId: null, playing: false, loading: false, duration: 0, error: null });
}

export function seek(sec: number): void {
  if (el === null) return;
  const t = Math.max(0, Math.min(sec, Number.isFinite(el.duration) ? el.duration : sec));
  try { el.currentTime = t; } catch { /* 元数据未就绪时忽略 */ }
  for (const cb of timeListeners) cb(t);
}

export function setVolume(v: number): void {
  const nv = Math.max(0, Math.min(1, v));
  // ⚠️ 刻意**不改 muted**（2026-10-07 审查修复 ②）：muted 是「喇叭按钮」这个全局总开关的专属状态。
  // 原写法 `muted: nv === 0 ? true : state.muted` 有两个方向都错：
  //   往 0 拖 → 把总开关锁成静音；再拖回 50% → `state.muted` 已是 true，**永远解不开**（界面显示 50% 却无声）；
  //   往非 0 拖 → 顺手把用户明确关掉的总开关**又打开了**（用户明明按了静音，拖下音量条就出声了）。
  // 音量 0 本身就是静音（el.volume=0），不需要借 muted 表达；两个概念各管一件事。
  set({ volume: nv });
  applyVolume();
  void putSettings({ [VOLUME_KEY]: String(nv) }).catch((e: Error) => logFe('error', `保存播放器音量失败: ${e.message}`));
}

/** 静音开关 = 全局总开关（与工具栏那个同一份状态，spec D15）。 */
export function toggleMute(): void {
  const next = !state.muted;
  set({ muted: next });
  applyVolume();
  void setPreviewMuted(next).catch((e: Error) => logFe('error', `保存声音开关失败: ${e.message}`));
}

export function setRate(r: number): void {
  set({ rate: r });
  applyVolume();
}

export function subscribe(cb: () => void): () => void { listeners.add(cb); return () => { listeners.delete(cb); }; }
export function getSnapshot(): PlayerState { return state; }
export function getTime(): number { return el?.currentTime ?? 0; }
export function onTime(cb: (t: number) => void): () => void { timeListeners.add(cb); return () => { timeListeners.delete(cb); }; }
