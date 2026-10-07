// web/src/components/PlayerWaveform.tsx
// CyberAudioPlayer 的中间块：Canvas 自绘的**曲线波形**，兼任进度条（spec §5.2 / D7·D8·D13）。
//
// 为什么自绘而不是引库：与 TimelineWave 同一裁决 —— 不引 wavesurfer.js（m2-workspace D6，既有裁决不重开）。
//   本组件形态与 TimelineWave 不同，故不共用实现，只复用「dpr / rAF / ResizeObserver」的处理套路：
//     · TimelineWave = 竖条包络 + 按段取数（多段合并、失败整体占位）；
//     · 本组件     = 平滑曲线 + 整条一次性传入（已播/未播双色 + 播放头 + 刻度）。
//
// 与外壳的分工（要点 7）：本组件不订阅引擎的状态快照，`progress` 由外壳按引擎当前时间算好传入；
//   播放中（playing=true）这里自己起 rAF 逐帧读引擎的 getTime() 重算 —— 每帧 setState 会把 React 拖垮，
//   所以高频重绘不进 React state、只进 Canvas 的 rAF 循环。
import { useCallback, useEffect, useRef } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { getTime } from '@/audio-player';

/**
 * 颜色/线宽常量。Canvas 不走 CSS，颜色只能在此声明（值照抄 spec §5.2 视觉规格表，不改）。
 * ⚠️ 画布背景**故意不填色**：由外壳的深底透出。自己填 #0E0E17 会盖住已播背景带之外的层次。
 */
const COLORS = {
  curveUnplayed: 'rgba(94, 246, 255, 0.28)',
  curvePlayed: '#5EF6FF',
  playedBg: 'rgba(94, 246, 255, 0.14)',
  playhead: '#F75049',
  midline: 'rgba(255, 255, 255, 0.07)',
  tickMajor: 'rgba(255, 255, 255, 0.22)',
  tickMinor: 'rgba(255, 255, 255, 0.10)',
} as const;

/**
 * dB → 0..1 的高度映射。
 * **-99 是「静音 / 无效」的哨兵**（server 把 `-inf` 折过来的）—— 必须落到基线 0，
 * 不能按 -99dB 的数值去算高度（那是谎言：把「没声音」画成「有一点点声音」）。
 * -60dB 作为满格起点：数字音频的 RMS 基本落在 [-60, 0]dB 区间。
 */
const norm = (db: number): number => (db <= -99 ? 0 : Math.max(0, Math.min(1, (db + 60) / 60)));

/** 顶部预留：满幅处线宽 2.2（半宽 1.1）不被画出画布。 */
const PAD_TOP = 3;

export default function PlayerWaveform(props: {
  /** 峰值数组（RMS，单位 dB；-99 = 静音/无效哨兵）。null = 尚未取到或取失败 → 只画静态基线 */
  points: number[] | null;
  /** 总时长（秒）；<=0 时不画刻度数字 */
  duration: number;
  /** 是否正在播放（true 时起 rAF 逐帧重绘） */
  playing: boolean;
  /** 已播比例 0..1（由外壳组件按引擎的当前时间算好传入） */
  progress: number;
  /** 点击/拖动定位回调（秒） */
  onSeek: (sec: number) => void;
  /** 时长未知（duration<=0）时点了波形 → 调它给用户一句明说，替代「点了没反应」（诚实原则） */
  onSeekUnavailable?: () => void;
  /** 画布高，默认 34 */
  height?: number;
}): JSX.Element {
  const height = props.height ?? 34;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // 拖动中标志：pointermove 只在按下的拖动里才定位，否则「鼠标划过」也会 seek。
  const draggingRef = useRef(false);

  const paint = useCallback((): void => {
    const cv = canvasRef.current;
    if (cv === null) return;
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth;
    const h = height;
    if (w <= 0 || h <= 0) return;
    // devicePixelRatio：不做的话 2x 屏上曲线是糊的（位图被拉伸到两倍 CSS 尺寸）。
    // 只在尺寸真的变了才写 canvas.width/height —— 每次写都会清空位图，虽然随后就重画，仍属多余。
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
    }
    const g = cv.getContext('2d');
    if (g === null) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h); // 保持透明背景（由外壳深底透出）

    const midY = h / 2;

    // 中线（通长）。最先画，压在波形之下。
    g.strokeStyle = COLORS.midline;
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(0, midY);
    g.lineTo(w, midY);
    g.stroke();

    // 刻度：主刻度约 8 根（每 ceil(cols/8) 像素一根），次刻度取主刻度中点，都贴底。
    const cols = Math.max(1, Math.round(w));
    const majorStep = Math.ceil(cols / 8);
    g.lineWidth = 1;
    for (let x = 0; x <= w; x += majorStep) {
      g.strokeStyle = COLORS.tickMajor;
      g.beginPath();
      g.moveTo(x, h - 4);
      g.lineTo(x, h);
      g.stroke();
      const mx = x + majorStep / 2; // 次刻度落在当前主刻度与下一根之间
      if (mx <= w) {
        g.strokeStyle = COLORS.tickMinor;
        g.beginPath();
        g.moveTo(mx, h - 2);
        g.lineTo(mx, h);
        g.stroke();
      }
    }

    // 失败态（诚实原则，必做）：没有数据只画「中线 + 刻度」这条静态基线，**绝不画任何假波形**。
    // 理由：Spec B 反复确立「没有数据就说没有」—— 画一条假的平线/假花纹会让用户以为「这段没声音」，那是撒谎。
    const src = props.points;
    if (src === null || src.length === 0) return;

    // 已播比例：播放中读引擎实时位置（rAF 每帧调本函数），否则用外壳算好的静态 progress。
    const ratio = props.playing && props.duration > 0 ? getTime() / props.duration : props.progress;
    const playedX = Math.max(0, Math.min(1, ratio)) * w;

    // 重采样：每像素列取该列覆盖点的**最大值**（峰值包络），得到 cols 个幅度 0..1。
    // 用最大值而非平均：避免瞬态被邻点摊平 —— 波形该有的「毛刺」要留着。
    const n = src.length;
    const amps = new Array<number>(cols);
    for (let c = 0; c < cols; c += 1) {
      const i0 = Math.floor((c / cols) * n);
      const i1 = Math.min(n, Math.max(i0 + 1, Math.ceil(((c + 1) / cols) * n)));
      let m = 0;
      for (let i = i0; i < i1; i += 1) {
        const u = norm(src[i]!);
        if (u > m) m = u;
      }
      amps[c] = m;
    }

    // 顶点序列：以**中线为基线、向上为正**（单边波形，与参考图一致）。x 均分整宽。
    const ampMax = midY - PAD_TOP; // 满幅时的可用高度
    const pts: Array<{ x: number; y: number }> = new Array(cols);
    for (let c = 0; c < cols; c += 1) {
      pts[c] = { x: cols > 1 ? (c / (cols - 1)) * w : 0, y: midY - amps[c]! * ampMax };
    }

    // 平滑折线：相邻顶点的**中点**作为线段终点，顶点本身作为 quadraticCurveTo 的控制点。
    // 这是标准的「把折线磨成曲线」手法 —— 既平滑又不过冲（不会画出数据里没有的峰）。
    const strokeCurve = (color: string, lw: number): void => {
      g.strokeStyle = color;
      g.lineWidth = lw;
      g.lineJoin = 'round';
      g.lineCap = 'round';
      g.beginPath();
      g.moveTo(pts[0]!.x, pts[0]!.y);
      for (let i = 1; i < cols - 1; i += 1) {
        const cx = (pts[i]!.x + pts[i + 1]!.x) / 2;
        const cy = (pts[i]!.y + pts[i + 1]!.y) / 2;
        g.quadraticCurveTo(pts[i]!.x, pts[i]!.y, cx, cy);
      }
      g.lineTo(pts[cols - 1]!.x, pts[cols - 1]!.y);
      g.stroke();
    };

    // 先整条按「未播色」画一遍。
    strokeCurve(COLORS.curveUnplayed, 2);

    // 再在 [0, playedX] 裁剪区内：填已播背景带 + 重画已播曲线（亮色、稍粗）。
    // 顺序是「先填带、后画线」—— 让已播线压在带上，不被那层 0.14 的半透明盖暗。
    if (playedX > 0) {
      g.save();
      g.beginPath();
      g.rect(0, 0, playedX, h);
      g.clip();
      g.fillStyle = COLORS.playedBg;
      g.fillRect(0, 0, playedX, h);
      strokeCurve(COLORS.curvePlayed, 2.2);
      g.restore();
    }

    // 播放头（最后画，压在所有之上）：贯穿全高。
    g.strokeStyle = COLORS.playhead;
    g.lineWidth = 1.6;
    g.beginPath();
    g.moveTo(playedX, 0);
    g.lineTo(playedX, h);
    g.stroke();
  }, [height, props.points, props.duration, props.playing, props.progress]);

  // 每帧渲染都把最新 paint 放进 ref：rAF 循环与 ResizeObserver 都经 ref 调它，
  // 于是这两者只需装配一次，不必随 props 变化反复解绑/重绑。
  const paintRef = useRef(paint);
  paintRef.current = paint;

  // props 变化（含非播放态下外壳传入的 progress）→ 重绘一次。
  useEffect(() => {
    paint();
  }, [paint]);

  // 播放中起 rAF 逐帧重绘；暂停/卸载则取消（否则后台空转 + 泄漏）。
  // 为什么不用 onTime 的 timeupdate 事件：它约 4Hz，进度条会一跳一跳；rAF 才够顺，
  // 故本组件只消费 getTime()、不订阅 onTime（引入它反而与 rAF 重复驱动重绘）。
  useEffect(() => {
    if (!props.playing) return undefined;
    let raf = 0;
    const loop = (): void => {
      paintRef.current();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [props.playing]);

  // 容器宽度变化（窗口缩放 / 分栏拖动）→ 画布 CSS 宽变了但位图没变，内容被拉伸变糊。
  // 用 ResizeObserver 而不是 window.resize：拖分栏、切布局都不发 resize 事件。
  // 依赖为 []（观察器只在画布挂载时装一次）；回调读最新的 paintRef，不随 props 重建观察器。
  useEffect(() => {
    const cv = canvasRef.current;
    if (cv === null) return undefined;
    const ro = new ResizeObserver(() => paintRef.current());
    ro.observe(cv);
    return () => ro.disconnect();
  }, []);

  // 交互：只定位，不做缩放/平移（那是时间轴组件的职责，本组件不做）。
  const seekTo = (clientX: number): void => {
    const cv = canvasRef.current;
    if (cv === null) return;
    // 时长未知（duration<=0，常见于 DB 缺 duration_sec）→ 无从定位，**明说**而不是静默 return：
    // 静默 return 的症状是「波形画得出来、点下去没反应」，用户会以为坏了（诚实原则）。
    if (!(props.duration > 0)) {
      props.onSeekUnavailable?.();
      return;
    }
    const rect = cv.getBoundingClientRect();
    if (rect.width <= 0) return;
    const r = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    props.onSeek(r * props.duration);
  };
  const onPointerDown = (e: ReactPointerEvent<HTMLCanvasElement>): void => {
    draggingRef.current = true;
    // 捕获指针：拖出画布范围后仍能收到 pointermove/pointerup。
    e.currentTarget.setPointerCapture(e.pointerId);
    seekTo(e.clientX);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLCanvasElement>): void => {
    if (draggingRef.current) seekTo(e.clientX);
  };
  const onPointerEnd = (e: ReactPointerEvent<HTMLCanvasElement>): void => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* 指针已释放（如指针已消失）——忽略 */
    }
  };

  return (
    <canvas
      ref={canvasRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      // touchAction:'none' —— 否则触屏横向拖动会被浏览器滚动手势抢走。
      style={{ display: 'block', width: '100%', height, cursor: 'pointer', touchAction: 'none' }}
    />
  );
}
