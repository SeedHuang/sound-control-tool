// web/src/components/CyberAudioPlayer.tsx
// CP2077 音频播放器外壳（spec §5.1，任务 T5）。
// 单行 42px：[▶ 播放键] [曲线波形（撑满）] [0:42/1:52] | [🔊 音量] [1x 倍速]。
//
// 关键纪律（各有原因，改动前请先读）：
//   ① 状态只有一个真相 = 单例引擎（audio-player.ts）。本组件**不自持**播放/静音/音量/倍速任何副本，
//      全部经 useSyncExternalStore 读引擎快照 —— 两份真相必然漂移（spec D15）。
//   ② 「当前行」判据 = st.audioId === audioId。非当前行一律显示静态未播态，不能继承别人正在播的进度/时长。
//   ③ progress 契约（与 T4 PlayerWaveform 的跨任务交接项）：详见 handlePlay 下方注释。
//   ④ 键盘快捷键必须避让输入类元素（spec §5.3），且只在 isCurrent 时生效（一屏多行不能同时响应）。
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Button, Popover, Slider, message } from 'antd';
import { CaretRightFilled, MutedOutlined, PauseOutlined, SoundOutlined } from '@ant-design/icons';
import {
  getSnapshot, getTime, onTime, seek, setRate, setVolume, subscribe, toggle, toggleMute,
} from '@/audio-player';
import { audioWavepeakUrl, logFe } from '@/api';
import PlayerWaveform from '@/components/PlayerWaveform';
import { cyberColors, cyberFontStack } from '@/setup/theme';
import './CyberAudioPlayer.css';

/** 倍速循环档（spec D12）：点击在四档间循环。 */
const RATES = [0.5, 1, 1.5, 2];

/** 秒 → `m:ss`（spec §9 时间码格式）。自己写：项目无日期/时长工具库，引依赖不值得。 */
function fmtTime(s: number): string {
  const total = Math.max(0, Math.floor(Number.isFinite(s) ? s : 0));
  const m = Math.floor(total / 60);
  const sec = total % 60;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

interface Props {
  /** 成品 id（audio_items.id） */
  audioId: number;
  /** 音频流地址（调用方传 audioFileUrl(id)，保持既有鉴权口径） */
  src: string;
  /** 行外已知时长（秒）—— 仅用于元数据加载前的时间码/刻度占位，**不发给服务端**（时长以 DB 为权威） */
  durationHint?: number | null;
}

export default function CyberAudioPlayer({ audioId, src, durationHint }: Props): JSX.Element {
  const st = useSyncExternalStore(subscribe, getSnapshot);
  const isCurrent = st.audioId === audioId;

  // 非当前行不能借用引擎里「别人」的时长（引擎只装一条），否则一屏多行的时间码分母全错。
  // 所以只有本行是当前行时才信 st.duration，否则回退到行外传入的 hint。
  const dur = isCurrent && st.duration > 0 ? st.duration : (durationHint ?? 0);
  const playing = isCurrent && st.playing;

  // ---- 波形峰值：fetch 一次，失败只记日志并保持 null（T4 会画静态基线，绝不编造波形）----
  // waveNonce：失败态下点「重试」时 +1 → 触发本 effect 重新发请求（spec §5.2「失败：静态基线 + 可重试」）。
  const [points, setPoints] = useState<number[] | null>(null);
  const [waveFailed, setWaveFailed] = useState(false);
  const [waveNonce, setWaveNonce] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setPoints(null); // 请求开始先清空，避免旧波形串台到新行 / 上一次重试
    setWaveFailed(false);
    void fetch(audioWavepeakUrl(audioId))
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j: { points?: number[] }) => {
        if (!cancelled) setPoints(Array.isArray(j.points) ? j.points : null);
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setPoints(null);
          setWaveFailed(true); // 置失败标记 → 波形区显示「重试」入口（只影响波形，不禁播）
          logFe('error', `波形加载失败 id=${audioId}: ${(e as Error).message}`);
        }
      });
    return () => { cancelled = true; };
  }, [audioId, waveNonce]);

  // 波形重试：改 nonce 即让上面的 effect 重跑（重新 fetch audioWavepeakUrl(audioId)）。
  const retryWave = useCallback((): void => { setWaveNonce((n) => n + 1); }, []);

  // ---- 时间码用秒级 state；高频时间只进 ref ----
  // 为什么：timeupdate 约 4Hz，若每次渲染整行会让一屏多行白刷；时间码只需秒级精度 → 只在整数秒变化时 setState。
  const [sec, setSec] = useState(0);
  const timeRef = useRef(0); // 最新当前时间（秒）；暂停瞬间用它/引擎值算 progress，不触发渲染
  const isCurrentRef = useRef(isCurrent);
  const durRef = useRef(dur);
  useEffect(() => { isCurrentRef.current = isCurrent; }, [isCurrent]);
  useEffect(() => { durRef.current = dur; }, [dur]);

  useEffect(() => {
    const off = onTime((t) => {
      timeRef.current = t; // 永远更新 ref（供暂停转换读数）
      if (!isCurrentRef.current) return; // 非当前行的秒表不动（省一屏多行的多余渲染）
      const s = Math.floor(t);
      setSec((prev) => (prev === s ? prev : s));
    });
    return off;
  }, []);

  // ---- ⭐ progress 契约（T4 交接项，必做）----
  // T4 的 PlayerWaveform 在 playing 由真变假那一帧会改用 props.progress 画播放头；若此刻 progress 落后，
  // 播放头会先闪到旧位置再纠正（≈跳一下）。根治办法：让「暂停那一帧」的 progress 当场就是对的。
  // 做法：用 React 官方「渲染期根据 prop 变化调整 state」的写法 —— playing 由真变假时**在同一次渲染里**
  // 读取引擎定格时间（pause 时 currentTime 已定，getTime() 即波形最后一帧读到的值）算出 progress 并入 state；
  // 这样 React 会丢弃这次渲染、立刻用新 state 重渲染，DOM 只提交一次，不存在「先画旧值再纠正」的一帧。
  // 用 getTime() 而不是 timeRef：timeupdate 约 4Hz，timeRef 可能落后至多 250ms，会再引入一次小跳。
  const [pausedProgress, setPausedProgress] = useState(0);
  const [prevPlaying, setPrevPlaying] = useState(playing);
  if (playing !== prevPlaying) {
    setPrevPlaying(playing);
    if (!playing && isCurrent) { // 只在「本行由播转停」时算；切成非当前行不算（那属于别人在播）
      const t = getTime();
      timeRef.current = t;
      setPausedProgress(dur > 0 ? clamp01(t / dur) : 0);
    }
  }

  // audioId 换了（组件被复用渲染另一行）→ 复位本地显示态，避免残留上一行的进度/秒数。
  useEffect(() => {
    setSec(0);
    timeRef.current = 0;
    setPausedProgress(0);
  }, [audioId]);

  // ---- 定位（波形点击 / 方向键共用）：seek 后同步 pausedProgress，暂停态下播放头才会跟着走 ----
  const doSeek = useCallback((target: number): void => {
    const d = durRef.current;
    const clamped = d > 0 ? Math.max(0, Math.min(target, d)) : Math.max(0, target);
    seek(clamped);
    const actual = getTime(); // 引擎可能再夹一次，以实际落点为准
    timeRef.current = actual;
    if (d > 0) setPausedProgress(clamp01(actual / d));
  }, []);

  const onWaveformSeek = useCallback((s: number): void => {
    if (!isCurrentRef.current) toggle(audioId, src); // 点非当前行的波形 → 先起播该行
    doSeek(s);
  }, [audioId, src, doSeek]);

  // 时长未知（DB 缺 duration_sec 且元数据未就绪）时点波形：说清为什么不能定位，而不是静默无反应。
  const seekUnavailable = useCallback((): void => {
    logFe('info', `波形定位不可用：时长未知 id=${audioId}`);
    message.info('这条成品的时长还没读出来，暂时不能拖动定位');
  }, [audioId]);

  // ---- 静音轻提示（spec §4.4）：静音态下起播 → 浮现一行提示，约 3s 自动消失，**不擅自改用户设置** ----
  const [hintVisible, setHintVisible] = useState(false);
  const hintTimerRef = useRef<number | null>(null);
  const showHint = useCallback((): void => {
    setHintVisible(true);
    if (hintTimerRef.current !== null) window.clearTimeout(hintTimerRef.current);
    hintTimerRef.current = window.setTimeout(() => {
      setHintVisible(false);
      hintTimerRef.current = null;
    }, 3000);
  }, []);
  useEffect(() => () => {
    if (hintTimerRef.current !== null) window.clearTimeout(hintTimerRef.current);
  }, []);

  // ---- 播放键：起播时若全局静音 → 顺带提示（读引擎快照，避免依赖 st 反复重建回调）----
  const handlePlay = useCallback((): void => {
    const snap = getSnapshot();
    const starting = !(snap.audioId === audioId && snap.playing);
    if (starting && snap.muted) showHint();
    toggle(audioId, src);
  }, [audioId, src, showHint]);

  // ---- 倍速循环 ----
  const cycleRate = useCallback((): void => {
    const cur = getSnapshot().rate;
    const i = RATES.indexOf(cur);
    setRate(RATES[(i + 1) % RATES.length] ?? 1);
  }, []);

  // ---- 键盘快捷键（作用域严格，spec §5.3）----
  // 焦点在**任何可交互元素**内 → 一律直接 return（绝不抢输入/按钮）。
  // ⚠️ BUTTON / role=button 也要挡：本行内就有 4 个按钮（播放/音量/倍速），焦点停在「倍速」上按空格时，
  //   若不挡则本该触发该按钮的动作会被改成「播放/暂停」；音量 Popover 里的滑块方向键同理。
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      const el = e.target as HTMLElement | null;
      if (el !== null) {
        const tag = el.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON' || el.isContentEditable) return;
        // antd 的 Space 组件用 role="switch"（Switch/Checkbox 都属这类），同样不该抢
        const role = el.getAttribute('role');
        if (role === 'button' || role === 'switch' || role === 'slider' || role === 'link') return;
      }
      if (!isCurrent) return;
      if (e.code === 'Space' || e.key === ' ') {
        e.preventDefault(); // 否则空格会滚动页面
        handlePlay();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        doSeek(Math.max(0, getTime() - 5));
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        doSeek(getTime() + 5);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isCurrent, handlePlay, doSeek]);

  // 音量滑块（spec 终审 ⑥）：拖动中**只更新本地显示**（dragVol），松手（onChangeComplete）才 setVolume 落盘。
  // 原写法 onChange={setVolume} 会在拖动全程每个 step 触发 → putSettings 落盘 + 打日志，纯属浪费。
  // 拖动中用 dragVol 作为受控值，松手后置回 null → value 回到引擎的 st.volume（唯一真相）。
  const [dragVol, setDragVol] = useState<number | null>(null);
  // 音量滑块弹层：方角由全局 CSS 钉死（.ant-popover .ant-popover-inner）。
  const volumePanel = (
    <Slider
      min={0} max={1} step={0.05}
      value={dragVol ?? st.volume}
      onChange={setDragVol}                                        // 拖动中：只更新本地预览，不落盘
      onChangeComplete={(v) => { setDragVol(null); setVolume(v); }} // 松手：落盘一次
      style={{ width: 120, margin: 0 }}
    />
  );

  return (
    <div
      className={`cap-row${st.muted ? ' cap-muted' : ''}`}
      // position:relative 给 .cap-hint 定位（贴在本行上方）；minWidth:0 允许中间波形在窄容器里正常收缩。
      style={{ position: 'relative', minWidth: 0 }}
    >
      <Button
        type="text"
        className="cap-play"
        aria-label={playing ? '暂停' : '播放'}
        // 起播中给个 loading（antd 自带），别让它看起来是「点了没反应」；非当前行不显示。
        loading={st.loading && isCurrent}
        icon={playing ? <PauseOutlined style={{ color: cyberColors.textPrimary }} /> : <CaretRightFilled style={{ color: cyberColors.cyan }} />}
        onClick={handlePlay}
      />
      <div style={{ flex: 1, minWidth: 0, position: 'relative' }}>
        <PlayerWaveform
          points={points}
          duration={dur}
          playing={playing}
          // 非当前行恒为 0（静态未播态）；当前行用 pausedProgress（暂停帧已由上面的转换算法对齐）。
          progress={isCurrent ? pausedProgress : 0}
          onSeek={onWaveformSeek}
          // 时长未知时点波形：给一句明说，替代「点了没反应」（诚实原则，2026-10-07 审查修复）
          onSeekUnavailable={seekUnavailable}
        />
        {/* 波形失败重试入口（spec §5.2「失败：静态基线 + 可重试」）：只影响波形，**不禁播**——
            右侧播放键依旧可点、时间码/进度照常工作。点击 → retryWave 重新 fetch 波形。 */}
        {waveFailed && (
          <Button
            type="text"
            size="small"
            onClick={retryWave}
            style={{ position: 'absolute', right: 2, top: '50%', transform: 'translateY(-50%)', height: 'auto', padding: '0 4px', fontSize: 11, color: cyberColors.red }}
          >
            波形加载失败 · 重试
          </Button>
        )}
      </div>
      <span className="cap-time" style={{ fontFamily: cyberFontStack }}>
        {`${fmtTime(isCurrent ? sec : 0)}/${fmtTime(dur)}`}
      </span>
      <span className="cap-sep" />
      <Popover trigger="hover" placement="top" content={volumePanel}>
        <Button
          type="text"
          className="cap-icon"
          aria-label="声音开关"
          icon={st.muted ? <MutedOutlined /> : <SoundOutlined />}
          onClick={toggleMute}
        />
      </Popover>
      <Button type="text" className="cap-icon cap-icon-cap" aria-label="倍速" onClick={cycleRate}>
        {`${st.rate}x`}
      </Button>
      {hintVisible && !(isCurrent && st.error !== null) && <div className="cap-hint">声音已关闭 · 点喇叭开启</div>}
      {/* 播放失败可见（终审修复 ①）：引擎把失败写进 state.error，此前只进日志、界面上静默无声
          （相对原生 <audio> 是功能回归）。仅当前行显示；文案可操作（指向日志页）。复用 .cap-hint 的贴顶定位。 */}
      {isCurrent && st.error !== null && (
        <div className="cap-hint" style={{ borderColor: cyberColors.borderRed }}>
          {`${st.error}，可在日志页查看原因`}
        </div>
      )}
    </div>
  );
}
