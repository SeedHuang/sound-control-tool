// web/src/components/TimelineWave.tsx
// Spec B D2 · 波形自绘：从「一张固定样式的 PNG」改成「Canvas 按当前缩放档位重绘」。
// 为什么不用 PNG：showwavespic 出的图是死样式，画完就定了 —— 放大后看不出局部疏密（spec §2.5 的原始反馈）。
// 为什么不用 wavesurfer.js：m2-workspace D6 裁决明确不引（既有裁决，本批不重开讨论）。
// 画法：每个像素列取「该列时间范围内」所有点的 min/max 画一条竖线（包络）。同样多的点被摊到更多列
//   → 局部疏密自然显现，这正是 D2 要的「放大后能看到局部疏密」。
//
// ⚠️ 数据是**按段**取的（T4 的 ensureWavePeaks 就是按段产出的）：L1/L2 档位下窗口可能跨越段边界，
//   所以这里会取窗口覆盖的**全部段**（1 或 2 个）再合并绘制。**任一请求失败 → 整体显示失败占位**，
//   不做「只画有数据的那半」—— 缺口会被用户读成「那段没声音」，那是撒谎（spec D5 诚实原则）。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Typography } from 'antd';
import { logFe, wavePeakUrl } from '@/api';

// Canvas 不走 CSS，颜色在此以常量声明（值同 cyberColors，改主题时同步此处）。
// 只有本文件真正用到的三项：背景 / 波形 / 失败占位（本组件无网格线与独立静音基线绘制）
const WAVE_COLORS = {
  bg: '#0E0E17',
  wave: '#5EF6FF',
  placeholder: 'rgba(247, 80, 73, 0.35)',
} as const;

/** 峰值 JSON 的七字段契约（与 server 的 WavePeakData 一致）。 */
export type WavePeaks = {
  v: number; sig: string; level: 0 | 1 | 2; seg: number; t0: number; stepSec: number; points: number[];
};

/**
 * 各档窗长（秒）。**必须与 server 的 FILM_LEVEL_SPAN_SEC 一致**（server/src/ffmpeg/derived-args.ts）——
 * 这是本批已知的一处「两处副本」（另一处在服务端的档位门槛判定里），改一处必须同改另一处。
 * L0 的 0 是哨兵「不切段」：前端 L0 只取「不带段号的一整张」，用不到这个值。
 *
 * Spec B (T7) 起导出：studio-detail 算 `levelSpan` 与档位按钮的禁用条件也要用它 ——
 * 前端内部从两份收敛成一份（跨服务端那份仍有，见上）。
 */
export const LEVEL_SPAN_SEC: Record<0 | 1 | 2, number> = { 0: 0, 1: 128, 2: 24 };

/**
 * 各档**成品图**的宽（像素）。**必须与 server 的 `FILM_SHEET_W` 一致**（`server/src/ffmpeg/derived-args.ts`）——
 * 前端用它换算画轨的显示高（`filmH = trackW * 90 / <成品宽>`）。
 * ⚠️ 2026-10-03（OCR 审查修复）：Spec B 的 tile 拼接**不再做「整体 scale 到 1600×90」**，所以成品宽随档位变
 * （L0 = 36×160 = 5760，L1/L2 = 12×160 = 1920）。沿用旧的「固定 1600」会让 L0 的图只占框高的 1/3.6、
 * 轨道下半留大片空白。这是**前端第 3 处副本**（另两处：server 的 FILM_SHEET_W、server 的 FILM_CELL_W）。
 */
export const FILM_SHEET_W: Record<0 | 1 | 2, number> = { 0: 36 * 160, 1: 12 * 160, 2: 12 * 160 };

/** L1 的最低素材时长（秒）：放不下一个整窗（128s）就不给这一档 —— 与 server 的 checkLevelAvailable 同口径。 */
export const LEVEL1_MIN_DURATION_SEC = LEVEL_SPAN_SEC[1];
/** L2 的最低素材时长（秒）：**严格大于**（与 server 导出的 `LEVEL2_MIN_DURATION_SEC` 一致）。 */
export const LEVEL2_MIN_DURATION_SEC = 300;

/**
 * 窗口覆盖哪些段号。L0 = [0]（不带段号，全片一张）；L1/L2 可能跨段边界 → 返回 1 或 2 个段号。
 * Spec B (T7) 起导出：**画轨的段取图与波形的段取数必须用同一份计算** ——
 * 各算一份的下一站必然是「段边界上两者差一格」（画轨取 1 段、波形取 2 段，或反之）。
 */
export function segsFor(level: 0 | 1 | 2, windowStart: number, windowSpan: number): number[] {
  if (level === 0) return [0];
  const span = LEVEL_SPAN_SEC[level];
  const first = Math.max(0, Math.floor(windowStart / span));
  // 减 1e-6：窗口右边界正好落在段边界时别把下一段也算进来（多取一段只是多一次请求，但语义更准）
  const last = Math.max(first, Math.floor((windowStart + windowSpan - 1e-6) / span));
  return Array.from({ length: last - first + 1 }, (_, i) => first + i);
}

/**
 * dB → 0..1 的高度。
 * **-99 是「静音 / 无效」的哨兵**（server 把 `-inf` 折过来的，见 wave-peaks.ts 的 parseRmsStderr）——
 * 画成基线 0。它不是「很小的音量」，不能按 -99dB 的数值去算高度。
 * -60dB 作为满格起点：数字音频的 RMS 基本落在 [-60, 0]dB 区间。
 */
const dbToUnit = (db: number): number => {
  if (db <= -99) return 0;
  return Math.max(0, Math.min(1, (db + 60) / 60));
};

export default function TimelineWave(props: {
  importId: number;
  /** 素材版本串：素材被替换后 URL 不变，靠它 + 服务端 no-store 避免拿到上一集的波形 */
  rev: string | number;
  level: 0 | 1 | 2;
  /** 可视窗口起点（秒）与跨度（秒）—— 由调用方按当前档位算好 */
  windowStart: number;
  windowSpan: number;
  height: number;
  onRetry?: () => void;
}): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // 按段存：每段的 t0 / stepSec / points 各自独立。跨段时两段的点密度可能不同 ——
  // 非 48kHz 素材的 stepSec 是「按实际点数反推」的，各段会略有差异，不能假设全窗口统一。
  const [segs, setSegs] = useState<Array<{ t0: number; stepSec: number; points: number[] }> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);

  // 只有「覆盖的段集合」变化才需要重新取数 —— 它在拖动平移时大多数帧都不变（segsKey 就是那个信号）。
  const segsKey = useMemo(
    () => segsFor(props.level, props.windowStart, props.windowSpan).join(','),
    [props.level, props.windowStart, props.windowSpan],
  );

  useEffect(() => {
    const id = ++seq.current;
    const list = segsFor(props.level, props.windowStart, props.windowSpan);
    setLoading(true); setErr(null);
    // ⚠️ 开新请求前**清掉上一份数据**（2026-10-03 OCR 审查第 8 轮 medium）：本组件换 importId/level/rev 时
    //   **不重挂载**（父组件没给 key），所以不清的话 paint 会继续把**上一件素材 / 上一档**的波形画在新轨道上 ——
    //   缓存未命中时服务端要现跑 ffmpeg，那几秒里用户看到的是「别人的波形」+ 一行「加载中」。
    //   失败路径本来就清（见下），这里补上开始路径，两者一致。
    setSegs(null);
    Promise.all(list.map(async (s) => {
      const r = await fetch(wavePeakUrl(props.importId, props.level, s, props.rev));
      if (!r.ok) {
        // ⚠️ 服务端回的是 `{error:{code,message,next}}`，message+next 是**给人看的下一步**
        // （如「ffmpeg 未找到：请到设置页配置路径」）。原来只取 `HTTP <status>` → 失败占位上写
        // 「波形生成失败（HTTP 500）」，用户既不知道发生了什么也不知道该干什么（OCR 审查发现）。
        // 这里把 message + next 都取出来；解析失败就退回状态码（不能因为读 body 失败就丢掉状态码信息）。
        const body = await r.json().catch(() => null) as { error?: { message?: string; next?: string } } | null;
        const msg = body?.error?.message ?? `HTTP ${r.status}`;
        throw new Error(body?.error?.next ? `${msg}（${body.error.next}）` : msg);
      }
      return (await r.json()) as WavePeaks;
    }))
      .then((rows) => {
        if (id !== seq.current) return; // 过期响应（用户又切了档/换了窗口）→ 丢弃
        setSegs(rows.map((d) => ({ t0: d.t0, stepSec: d.stepSec, points: d.points })));
        setLoading(false);
      })
      .catch((e: Error) => {
        if (id !== seq.current) return;
        // 任一失败 → 整体失败（见文件头注释：缺口会被读成「那段没声音」）
        setSegs(null); setErr(e.message); setLoading(false);
        logFe('error', `波形峰值加载失败 import=${props.importId} level=${props.level} segs=${list.join(',')}: ${e.message}`);
      });
    return () => { seq.current += 1; };
    // ⚠️ 故意只依赖 segsKey（而不是 windowStart/windowSpan）：后者在拖动时每帧都变，
    // 进依赖会让每次 pointermove 都重发一遍请求（本地服务端也扛不住这种浪）。内容一致性由 segsKey 保证。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.importId, props.level, props.rev, segsKey]);

  const paint = useCallback((): void => {
    const cv = canvasRef.current;
    if (cv === null) return;
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth;
    const h = props.height;
    if (w <= 0 || h <= 0) return;
    // devicePixelRatio：不做的话 2x 屏上波形是糊的（画布像素被拉伸到两倍 CSS 尺寸）
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
    }
    const g = cv.getContext('2d');
    if (g === null) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    g.fillStyle = WAVE_COLORS.bg; g.fillRect(0, 0, w, h);
    if (segs === null || segs.length === 0) return;
    const mid = h / 2;
    const span = Math.max(0.001, props.windowSpan);
    g.strokeStyle = WAVE_COLORS.wave; g.lineWidth = 1;
    for (let px = 0; px < w; px += 1) {
      const ta = props.windowStart + (px / w) * span;
      const tb = props.windowStart + ((px + 1) / w) * span;
      // 只取本列**峰值** hi：单极性 RMS 的包络对称于中线，上下端点都用它。
      // 不要再引入 lo —— 上一版用它算下端点，导致含幅度变化的列（起音/瞬态）只填下半屏的一部分，
      // **瞬态画得比持续响更矮**（与读波形的人的预期相反）。R11 修掉的正是这个。
      let hi = Number.NEGATIVE_INFINITY;
      let any = false;
      // 遍历所有段：跨段时窗口两边分别由不同段提供数据（各段按自己的 t0/stepSec 定位）
      for (const s of segs) {
        const i0 = Math.max(0, Math.floor((ta - s.t0) / s.stepSec));
        const i1 = Math.min(s.points.length, Math.ceil((tb - s.t0) / s.stepSec));
        for (let i = i0; i < i1; i += 1) {
          const u = dbToUnit(s.points[i]!);
          if (u > hi) hi = u;
          any = true;
        }
      }
      if (!any) continue; // 该列没有数据（窗口还没铺满 / 段边界缝隙）→ 留空，不画假的
      // ⚠️ 上下端点都用本列**峰值** hi，且**异号**（2026-10-03 OCR 审查第 10/11 轮 medium）：
      //   points 是单极性 RMS 幅值（dbToUnit → 0..1，响=1、静音=0），波形要**对称于中线**。
      //   两端都用 `mid -` → 只画上半屏、持续响处塌成 1px 线（R10 查出的回归）。
      //   下端用 lo → 含幅度变化的列（起音/瞬态：安静+响）只填下半屏一部分，**瞬态画得比持续响更矮**，
      //   与读波形的人的预期正好相反，也正是 D2 要暴露的局部细节反而丢了（R11 修正）。
      const amp = hi * (mid - 1);
      const yTop = mid - amp;
      const yBot = mid + amp;
      g.beginPath();
      g.moveTo(px + 0.5, yTop);
      g.lineTo(px + 0.5, Math.max(yBot, yTop + 0.5)); // 最少 1px：静音也该看到一条基线
      g.stroke();
    }
  }, [segs, props.height, props.windowSpan, props.windowStart]);

  useEffect(() => { paint(); }, [paint]);

  // 容器宽度变化（窗口缩放 / 分栏拖动）→ 画布 CSS 宽度变了但位图没变 → 内容被拉伸变糊。
  // 用 ResizeObserver 而不是 window.resize：拖分栏、切布局都不发 resize 事件。
  // ⚠️ paint 进 ref、依赖为 []（2026-10-03 OCR 审查第 3 轮 low）：paint 每次 windowStart/windowSpan 变都重建，
  //   若 effect 依赖 [paint]，平移时每帧都会 disconnect + 重新 observe（且 observe() 本身还会多触发一次回调）。
  //   观察器只需在画布挂载时装一次，回调里读最新的 paint。
  const paintRef = useRef(paint);
  paintRef.current = paint;
  useEffect(() => {
    const cv = canvasRef.current;
    if (cv === null) return undefined;
    const ro = new ResizeObserver(() => paintRef.current());
    ro.observe(cv);
    return () => ro.disconnect();
    // ⚠️ 依赖必须含 `err`（2026-10-03 OCR 审查第 4 轮 medium）：<canvas> 是**条件渲染**的 ——
    //   err !== null 时组件返回失败占位（画布卸载），onRetry 成功后会在**新 DOM 节点**上重挂。
    //   依赖为 [] 时观察器仍盯着已脱离的旧节点 → 波形一旦从错误恢复，容器缩放就不再重绘（画布拉伸发糊）。
  }, [err]);

  if (err !== null) {
    // 失败：斜纹占位 + 重试（spec D5：**不用邻段内容冒充**）
    // ⚠️ 必须 `position:'relative' + zIndex`（2026-10-03 OCR 审查第 8 轮 medium）：父组件在波形**之后**还渲染了
    //   一层 `position:absolute; inset:0` 的定位层（盖住两张 <img>、不让浏览器拖走图片）。
    //   绝对定位的层会画在普通流内容之上 → 它会**吞掉这个占位上的所有点击**，「重试」永远点不到；
    //   而且 pointerdown 仍会冒到轨道层 → 点「重试」变成 seek 视频、错误占位还在屏幕上
    //   —— 正是 waveNonce 那套接线想避免的「按钮是假的」。给占位自己一个定位层与 z-index 即可。
    return (
      <div
        style={{
          position: 'relative', zIndex: 1,
          // ⚠️ 容器**不吃指针事件**，只在「重试」那颗链接上打开（2026-10-03 OCR 审查第 11 轮 medium）：
          //   上一版给整个占位加 onPointerDown stopPropagation → 占位覆盖整条音轨带，而段区块的拖柄
          //   高度是 filmH+waveH（音轨带占其中约 6 成）→ **音轨带内的定位/平移/段拖柄全被吞掉**。
          //   那是比「重试点不到」更严重的回归（把整条轨道的交互换掉）。
          //   z-index 只负责盖住上方那层定位层（不让它挡住重试），不改变事件归属。
          pointerEvents: 'none',
          height: props.height, display: 'flex', alignItems: 'center', justifyContent: 'center',
          // 斜纹失败占位：主斜纹用占位红，底纹用深底（原两档深灰 #1a202c / #232b3b → 令牌色；
          // 45° / 8px / 16px 的斜纹几何保持不变）
          background: `repeating-linear-gradient(45deg,${WAVE_COLORS.placeholder},${WAVE_COLORS.placeholder} 8px,${WAVE_COLORS.bg} 8px,${WAVE_COLORS.bg} 16px)`,
        }}
      >
        <Typography.Text type="secondary" style={{ fontSize: 12, pointerEvents: 'none' }}>
          波形生成失败（{err}）
          {props.onRetry !== undefined && (
            <Typography.Link
              // 只拦这一颗链接：不让它冒到轨道层变成「点重试却 seek 了视频」
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); props.onRetry?.(); }}
              style={{ marginLeft: 8, pointerEvents: 'auto' }}
            >重试</Typography.Link>
          )}
        </Typography.Text>
      </div>
    );
  }
  return (
    <div style={{ position: 'relative', height: props.height }}>
      <canvas ref={canvasRef} style={{ display: 'block', width: '100%', height: props.height }} />
      {loading && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>波形加载中…</Typography.Text>
        </div>
      )}
    </div>
  );
}
