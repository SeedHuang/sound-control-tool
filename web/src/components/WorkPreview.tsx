// web/src/components/WorkPreview.tsx
// 剪辑室卡片的 hover 快速预览(spec clip-works D11 / §0.5)。
// 三条纪律,每条都有代价兜着:
//   ① 同一时刻只播 1 个 —— 鼠标划过一排卡时,每张都起播 = 十几个视频流同时解码(本地 CPU 直接跪)
//   ② 移开即卸载元素 —— 不只是 pause():留着元素就会留住解码器与 Range 连接
//   ③ 起播被拒要回退静音再试,最终失败也只记 debug —— hover 是个"随手"操作,不能弹错误框
import { useEffect, useRef, useState } from 'react';
import { audioFileUrl, logFe, mediaFileUrl, type WorkSummaryDTO } from '@/api';

// 模块级:全页面同一时刻唯一在播的预览元素(纪律①)。跨卡片共享 → 必须放模块作用域,不能放组件 state。
let currentEl: HTMLMediaElement | null = null;

/** 点「打开声音」那一下是本页唯一可靠的用户手势,拿它做一次"解锁"尝试
 *  (浏览器把"与本页有过交互"当作允许带声自动播放的依据之一)。失败无所谓——
 *  真正的兜底是预览起播被拒时回退静音(见下)。 */
export function unlockAudio(): void {
  try {
    // 一段 0 采样的合法 wav:只为消费一次用户手势,不产生实际声音
    const a = new Audio('data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=');
    a.volume = 0;
    void a.play().catch(() => { /* 忽略:解锁失败不影响静音预览 */ });
  } catch { /* 忽略 */ }
}

interface Props { work: WorkSummaryDTO; active: boolean; muted: boolean }

export default function WorkPreview({ work, active, muted }: Props): JSX.Element | null {
  const mediaRef = useRef<HTMLVideoElement | HTMLAudioElement | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false); // 加载/播放失败 → 回退封面(不再渲染媒体元素)

  // 数据源二选一(spec §0.5 hover 表):
  //  · 有视频 → 播视频(复用既有 Range 路由)
  //  · 无视频但有成品 → 播该作品**最新那条成品**(只有音频的卡)
  //  · 资料已删(source=null)/ 两者都没有 → 只剩封面,不播
  const isVideo = work.source !== null && work.source.has_video;
  const productId = work.latest_product_id;
  const isAudioOnly = !isVideo && work.source !== null && productId !== null;
  const hasPreview = isVideo || isAudioOnly;
  // 首段(有剪辑点 → 播这一段);无首段 → 视频播开头 5 秒。
  // 依赖取原始数值而非 work.first_segment 对象 —— 每次 listWorks 都会给新对象,拿对象当依赖会让预览在重拉时反复重播。
  const segStart = work.first_segment?.start_sec ?? null;
  const segEnd = work.first_segment?.end_sec ?? null;

  // 移开鼠标后清掉失败标记:下次 hover 允许重试(一次失败不该把这张卡永久钉在封面上)
  useEffect(() => { if (!active) setFailed(false); }, [active]);

  useEffect(() => {
    if (!active || failed || !hasPreview) return undefined;
    const el = mediaRef.current;
    if (el === null) return undefined;

    // 纪律①:新的一张起播前先把前一张停掉(别的卡各自的 active 变 false 会自行卸载,这里只兜"重叠起播")
    if (currentEl !== null && currentEl !== el) {
      try { currentEl.pause(); } catch { /* 元素已卸载,忽略 */ }
    }
    currentEl = el;

    const startSec = segStart ?? 0;
    // 停止点:有剪辑点 → 段尾;无剪辑点的视频 → 开头 5 秒;音频 → null(跟随鼠标离开,不主动停)
    const stopSec: number | null = segEnd !== null ? segEnd : (isVideo ? 5 : null);

    // 定位到起点:元数据未就绪时直接设 currentTime 会被忽略 → 等 loadedmetadata 再设一次
    const seekToStart = (): void => { try { el.currentTime = startSec; } catch { /* 忽略 */ } };
    el.addEventListener('loadedmetadata', seekToStart);
    seekToStart();

    const onTimeUpdate = (): void => {
      if (stopSec !== null && el.currentTime >= stopSec) el.pause(); // 播完那一段/那 5 秒就停,不循环
      // 细进度条(静音时的反馈,spec §0.5):直接改 DOM 宽度,不触发 React 重渲染
      const dur = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : 0;
      const span = stopSec !== null ? stopSec - startSec : dur - startSec;
      const bar = barRef.current;
      if (bar !== null && span > 0) bar.style.width = `${Math.min(100, Math.max(0, ((el.currentTime - startSec) / span) * 100))}%`;
    };
    el.addEventListener('timeupdate', onTimeUpdate);

    // 起播:静音一定允许;出声可能被自动播放策略拒 → 回退静音再试一次(spec §0.5「有声预览」行)
    const startPlay = (): void => {
      el.play().catch(() => {
        if (el.muted) { logFe('debug', `hover 预览起播失败(静音也被拒) work=${work.id}`); setFailed(true); return; }
        el.muted = true; // 回退静音再试:不弹错,用户至少能看到进度条在走
        logFe('debug', `hover 预览出声被拒,回退静音 work=${work.id}`);
        el.play().catch(() => { logFe('debug', `hover 预览静音起播也失败 work=${work.id}`); setFailed(true); });
      });
    };
    startPlay();

    // 移开/卸载:停 + 回起点 + 解绑,不留解码器与连接(纪律②)
    return () => {
      el.removeEventListener('loadedmetadata', seekToStart);
      el.removeEventListener('timeupdate', onTimeUpdate);
      try { el.pause(); el.currentTime = startSec; } catch { /* 元素已销毁,忽略 */ }
      if (currentEl === el) currentEl = null;
    };
    // muted 刻意**不进依赖**:切换静音开关不该把正在播的预览重播一遍(React 会自己更新 muted 属性)
  }, [active, failed, hasPreview, isVideo, segStart, segEnd, work.id, work.import_id, productId]);

  // active=false → return null = **卸载元素**(纪律②:不只是暂停,元素都不留)
  if (!active || failed) return null;

  const onError = (): void => { logFe('debug', `hover 预览加载失败,回退封面 work=${work.id}`); setFailed(true); };

  let media: JSX.Element | null = null;
  if (isVideo) {
    media = (
      <video
        ref={(el) => { mediaRef.current = el; }}
        muted={muted}
        playsInline
        preload="none"
        src={mediaFileUrl(work.import_id)}
        onError={onError}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }}
      />
    );
  } else if (isAudioOnly && productId !== null) {
    media = (
      <audio
        ref={(el) => { mediaRef.current = el; }}
        muted={muted}
        preload="none"
        src={audioFileUrl(productId)}
        onError={onError}
      />
    );
  }
  if (media === null) return null; // 两者都没有 → 只剩封面

  return (
    <>
      {media}
      {/* 细进度条:静音时只有音频的卡看不出变化,靠它表示"正在预览"(spec §0.5) */}
      <div ref={barRef} style={{ position: 'absolute', left: 0, bottom: 0, height: 3, width: 0, background: '#1677ff', transition: 'width 120ms linear' }} />
    </>
  );
}
