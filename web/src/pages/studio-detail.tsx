// web/src/pages/studio-detail.tsx
// 剪辑**作品**编辑页（2026-10-01 spec clip-works D16：路由参数 = **作品 id**，不再是资料 id）。
// 本页同时持有两个 id，**不要混**：
//   · 作品维度（projectId，来自路由）：段、作品名、保存 / 导出 / 成品明细 / 成品删除。
//   · 资料维度（importId = work.import_id）：<video> 预览、波形图、胶片条、素材版本串。
// 图↔时间映射（spec §0.3 裁决，brief 同款）：派生图固定 1600 宽 ↔ [0, duration]；
//   容器里点击像素 X → t = (X - 容器左边) / 容器宽 * duration。
//   ⚠️ 换算一律用**容器实际像素宽**（getBoundingClientRect().width），不写死 1600 ——
//   窄窗下 CSS 会把图压缩到容器宽，写死 1600 会让「点哪儿跳哪儿」整体偏移（brief「图↔时间映射」裁决）。
// duration 以 <video>.duration 为**唯一真相**（不引入服务端 ffprobe 时长当第二份真相，D10）。
// 保存 = PUT /api/projects/:projectId（全量替换 D18，回填**不置脏**——那正是「已保存」的状态）；
//   导出 = POST /api/projects/:projectId/export，以请求体为准 D15，SSE 进度；改动置脏、离开未保存时提示。
// 只读态（D16，2026-10-02 修复轮 1 收窄）：**只由服务端确认的两个事实触发** —— 资料已删（404）/ 这个资料没有素材行；
//   此时顶部黄条 + 编辑控件全禁用，但「已导出的成品」照常可试听、可单条删除（成品不依赖素材文件）。
//   ⚠️ <video> 加载失败**不再是**只读态触发源：它有四种成因（文件真被删 / 网络抖 / 文件损坏 / 编码不支持），
//   页面分不出来，而原实现一律按"文件被删"处理且**永久锁死**（<video> 被卸载 → onError 不再触发 → 只能 F5 刷新，
//   未保存的剪辑点全丢）。现在改成：只出黄条说清"这次没加载出来 + 可能的原因"+ 给「重试加载」出口，**编辑照常可用**
//   （段本来就在本地，保存只写 DB，不碰视频文件）。详见 readOnlyMsg / videoErrMsg 处的注释。
// 布局锁内容区高度：页面头固定，正文自己滚（spec D3，body 不滚）。
// ⚠️ 本项目没有全局 reset，div 默认 content-box —— 凡是「height:100% 且带 padding」的层都要 boxSizing:'border-box'，
//   否则会多出内边距那几像素、外框出现多余滚动条（2026-09-29 实测坑，studio.tsx 顶部同样记着）。
import { Alert, Button, Empty, Input, message, Modal, Progress, Radio, Space, Tag, Tooltip, Typography } from 'antd';
import { ArrowLeftOutlined, CustomerServiceOutlined, DeleteOutlined, ExportOutlined, FolderOpenOutlined, PlusOutlined, SaveOutlined, StopOutlined } from '@ant-design/icons';
import { useNavigate, useParams } from '@umijs/max';
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import PageHeader from '@/components/PageHeader';
import {
  ApiError, audioFileUrl, deleteAudio, exportWork, filmSegUrl, filmstripUrl, getImport, getSettings, getWork, listMedia,
  listProducts, logFe, mediaFileUrl, putWork, subscribeJob, type AudioRow, type ImportDetail, type WorkDetailDTO,
} from '@/api';
import TimelineWave, { FILM_SHEET_W, LEVEL1_MIN_DURATION_SEC, LEVEL2_MIN_DURATION_SEC, LEVEL_SPAN_SEC, segsFor } from '@/components/TimelineWave';
import { hasDesktopBridge } from '@/desktop';
import { openExportDir } from '@/export-dir';

const IMG_W = 1600;   // 派生图固定宽（D14，服务端按 1600 生成）；此处只当 ResizeObserver 还没量到宽时的兜底
// ⚠️ 下面两个是**原图像素高**（服务端固定 1600×120 / 1600×90，见 server/src/ffmpeg/derived-args.ts），
//   **不再直接当显示高用**。页面上的显示高按容器宽等比算（见 filmH / waveH），否则宽高比会被强行改变。
const WAVE_H = 120;   // 波形原图高（D14）
const FILM_H = 90;    // 胶片条原图高（D14）
const RULER_H = 20;   // 时间尺行高（段区块与播放头都要给它让位）
const MAX_SEGMENTS = 50; // 段数上限（与服务端校验一致，D18）；超了就不给打点，免得保存时才被拒

/** 编辑期段（未保存）：只有起止与标签，无 id / sort_order —— 保存时按数组顺序定 sort_order（T6） */
interface EditSeg { start_sec: number; end_sec: number; label: string | null }

const pad = (n: number): string => String(n).padStart(2, '0');
const fmtTime = (sec: number): string => `${pad(Math.floor(sec / 60))}:${pad(Math.floor(sec % 60))}`;
const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);

export default function StudioDetailPage() {
  // 路由参数是**作品 id**（spec D16）；资料 id 由作品带出来（work.import_id），两者不可混用
  const { projectId: projectIdRaw } = useParams<{ projectId: string }>();
  const projectId = Number(projectIdRaw);
  const navigate = useNavigate();

  const [work, setWork] = useState<WorkDetailDTO | null>(null); // 作品（作品名 + 段的唯一真相）
  const [nameDraft, setNameDraft] = useState('');              // 顶栏作品名输入框的草稿
  const [workMissing, setWorkMissing] = useState(false);        // getWork 回 null = 作品已被删除
  const [info, setInfo] = useState<ImportDetail | null>(null); // 资料（预览/派生图/标题/集号的来源）
  const [sourceMissing, setSourceMissing] = useState(false);    // 资料查不到（404）→ 只读态
  // <video> 这次没加载出来。存**浏览器的 MediaError.code**（null = 正常），不存一个自己猜的布尔：
  //   code 是浏览器给的真实判据，4=浏览器不认识这个源（容器/编码不支持）、3=解码失败（文件损坏/编码不认识）、
  //   2=取流失败（网络中断 / 服务端 404 / 文件被外部移走都落这一档）。文案按它分档，不把猜测说成事实。
  const [videoErrCode, setVideoErrCode] = useState<number | null>(null);
  const [videoNonce, setVideoNonce] = useState(0);              // 重试计数：拼进 <video> 的 src/key，点「重试加载」就换 URL 重新拉一次
  const [err, setErr] = useState<string | null>(null);
  const [duration, setDuration] = useState(0);        // <video>.duration —— 时间轴的唯一真相
  const [current, setCurrent] = useState(0);          // 播放头位置（秒）
  const [segments, setSegments] = useState<EditSeg[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [rev] = useState(0);                          // 版本串的本地分量（T7 起与 file_size 拼成 version）
  const [fileSize, setFileSize] = useState<number | null>(null); // 素材字节数：upsert 换素材不改 created_at，只能靠它识别「素材被替换」

  // —— 保存/导出接线状态 ——
  const [dirty, setDirty] = useState(false);           // 有未保存改动（离开前提示的依据）
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [exportMode, setExportMode] = useState<'separate' | 'merge'>('separate');
  const [exportFormat, setExportFormat] = useState<'mp3' | 'm4a' | 'wav'>('mp3');
  // 导出内容三选(2026-10-02 N1 spec D5.1):audio=现状音频;video=视频带音轨;videoAn=视频纯视频。缺省 audio = 音频老路径零回归。
  // exportFormat 刻意是独立 state:切到视频时格式 Radio 隐藏(服务端固定 mp4),切回音频恢复且**保留上次选中值**(不重置)
  const [exportKind, setExportKind] = useState<'audio' | 'video' | 'videoAn'>('audio');
  const [exportPercent, setExportPercent] = useState(0); // job 的 progress 百分比（导出进度条）
  const [exportMsg, setExportMsg] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  // —— 工具栏图标化/打开导出目录状态（spec D7/D9/D10/D13）——
  const [saving, setSaving] = useState(false);        // 「保存」按钮 loading：防连点重复 PUT（不改按钮 disabled 语义）
  const [openingDir, setOpeningDir] = useState(false); // 「打开导出目录」loading：工具栏 📂 与成功绿条按钮**共用**
  const [exportDir, setExportDir] = useState('');      // output_dir_resolved：绿条展示「导到哪了」（服务端算好的绝对路径）

  // —— 成品明细（D16/D17：GET /api/audio?project=<作品id>）——
  const [products, setProducts] = useState<AudioRow[]>([]);
  const [productsErr, setProductsErr] = useState<string | null>(null); // 拉取失败要**看得见**，否则空列表会被误读成「没有成品」
  const [previewingId, setPreviewingId] = useState<number | null>(null); // 正在试听的成品 id（顶栏「预览音频」按钮）
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [trackW, setTrackW] = useState(IMG_W);
  // —— 派生图(胶片条)加载态(W3/N0 复核遗留,2026-10-02 deferred 批)——
  // 服务端对大素材(如 2.1GB)生成 L0 胶片条约 10s（实测：36 格逐格 seek；Spec B 之前是 fps 滤镜整解码 ~50s），
  // 期间 <img> 是空轨道,用户不知道在等什么。
  // 不做骨架屏:轨道高度已由等比布局预留,只补一行小字。
  // ⚠️ 画轨的「已就绪」**按段键集合**记，不是一个全局布尔（2026-10-03 OCR 审查第 3 轮 medium 修复）：
  //   原来「一个布尔 + 段集合变化就复位 false」有两个病 ——
  //   ① 平移跨段（[0]→[0,1]）该复位，OK；但**回移**（[0,1]→[0]）也复位，而存活的 `<img key=0>`
  //      src 没变、React 不会重新触发 load → 布尔永远回不到 true →「画轨生成中」永久盖住已加载完的轨道；
  //   ② 一段失败（onError）把全局布尔置 true → 别的段还没好却提示「已完成」。
  // 现在：**已加载 / 已失败**的段键各记一份，就绪 = 当前可见段全部有结论（旧的键不清，切档/平移自然复用）。
  // （声明放在 level / visibleSegs 之后 —— 它要用那两者算 filmKeys。）
  const [filmLoaded, setFilmLoaded] = useState<Record<string, true>>({});
  const [filmFailed, setFilmFailed] = useState<Record<string, true>>({});

  /**
   * 从「已加载 / 已失败」记录里**删掉一个键**（2026-10-03 OCR 审查第 2 轮 low）。
   * 四个调用点（L0 的 onLoad、段图的 onLoad、段图重试×2）原本各内联一份
   * `if (p[k] !== true) return p; const next = {...p}; delete next[k]; return next;` ——
   * 「**没有就原样返回**」那半句是 React 的关键：直接 `delete` 会每次都造新对象，
   * 让 `useEffect`/memo 的依赖判定失效（这里恰好都只影响 setState 内容，尚未造成可见故障，
   * 但它是下一处「为什么组件老是重渲染」的种子）。删键与「不变就返回」的判据只此一份。
   */
  const clearFilmKey = (k: string): ((p: Record<string, true>) => Record<string, true>) =>
    (p) => {
      if (p[k] !== true) return p;
      const next = { ...p };
      delete next[k];
      return next;
    };

  // —— Spec B（T7）：缩放档位与可视窗口 ——
  // 档位离散三档（spec D3：不做无级平滑缩放 —— 本地工具够用、实现简单、行为可预期）：
  //   L0 = 整片一张（36 格）→ L1 = 128s 窗（12 格）→ L2 = 24s 窗（12 格）
  // **windowStart / levelSpan 是「视口能看到哪一段秒」** —— 段区块 / 播放头 / 刻度 / 画轨全部按它换算，
  // 不再按 duration 百分比（那是 L0 专属的算法；L0 时 windowStart=0、levelSpan=duration，两者等价）。
  const [level, setLevel] = useState<0 | 1 | 2>(0);
  const [windowStart, setWindowStart] = useState(0);
  /** 波形「重试」计数器：拼进传给 <TimelineWave> 的 rev → rev 变 → 组件重新取数。
   *  组件内部没有"命令式重取"的口子（它是按 rev 自取的），所以重试只能这样触发 —— 别把 onRetry 写成只记日志，
   *  那样按钮是个假的（点了没反应，用户会以为波形坏了修不好）。 */
  const [waveNonce, setWaveNonce] = useState(0);
  /** 画轨段「重试」计数器（**按段号记**，不是全局一个）：与 waveNonce 同款机制（拼进 rev → URL 变 → 重新请求）。
   *  ⚠️ 2026-10-03（OCR 审查第 1 轮 medium）：段图失败占位原本**只有一句文案、没有重试入口**，
   *   而 `<img>` 的 src 在 importId/level/seg/version 都不变时是同一个 URL —— 浏览器不会重新请求、
   *   React 也不会重新触发 onLoad/onError → 斜纹占位在本次会话里**永久停留**，用户切档/平移多少次都恢复不了。
   *   那是 spec D5「斜纹 + 重试」只做了一半：诚实是诚实了，但用户被钉死在这一档。
   *  ⚠️ 刻意**按段**而不是全局一个（第 2 轮 low）：全局的话点第 1 段的重试会让**同窗所有段**换 URL 重新请求 ——
   *   服务端多数命中缓存不会重跑 ffmpeg，代价小，但语义不对（用户只想重试这一段），
   *   且已加载好的邻段会**闪一下空白**（src 变 → 重新解码 → onLoad 前有帧空档）。 */
  const [filmNonceBySeg, setFilmNonceBySeg] = useState<Record<string, number>>({});
  /** 本档窗长（秒）：L0 = 整片。`Math.max(duration, 1)` 兜底 duration=0（避免除零 —— 那时时间轴本来也不渲染）。 */
  const levelSpan = level === 0 ? Math.max(duration, 1) : LEVEL_SPAN_SEC[level];
  /**
   * 档位门槛（与**服务端** `checkLevelAvailable` 同口径，2026-10-03 OCR 审查：原先滚轮切档绕过了门槛）。
   * 边界：L1 放行 `>= 128`（等价于按钮在 `duration < 128` 时禁用）、L2 放行 `> 300`。
   * 为什么要在这里也判一次：滚轮/按钮是**两个入口**，只在一个判 → 另一个能绕过（滚轮能跳到素材放不下的档位，
   * 画轨只留空白、错误只进日志）。服务端仍是权威判定（真出岔子会返回 LEVEL_UNAVAILABLE 404）。
   */
  const levelUsable = (lv: 0 | 1 | 2): boolean =>
    lv === 0 || (lv === 1 ? duration >= LEVEL1_MIN_DURATION_SEC : duration > LEVEL2_MIN_DURATION_SEC);
  /**
   * 切档的**唯一入口**：档位与窗口在**同一次更新**里落。
   * ⚠️ 为什么不能分开（2026-10-03 OCR 审查第 3 轮 medium）：只 setLevel 不夹 windowStart →
   *   切档后那一帧的窗口可能已在素材之外（如近景末尾 windowStart=duration-24，点「中景」→
   *   窗口变成 [duration-24, duration+104]）→ 越界段被请求 → 服务端 404 + 多余的时长探测，
   *   而且时间尺/段区块/播放头会闪一帧错位。校正 effect 跑得再快也补不上这一帧。
   * @param wantStart 可选的**期望**窗口起点（滚轮锚点保持用）；不传则沿用当前起点并夹紧
   */
  const applyLevel = (lv: 0 | 1 | 2, wantStart?: number): void => {
    const span = lv === 0 ? Math.max(duration, 1) : LEVEL_SPAN_SEC[lv];
    const maxStart = Math.max(0, duration - span);
    const base = wantStart ?? windowStart;
    setLevel(lv);
    setWindowStart(Math.max(0, Math.min(base, maxStart)));
    logFe('info', `时间轴切档 project=${projectId} level=${level}→${lv} start=${Math.max(0, Math.min(base, maxStart)).toFixed(2)}s span=${span}s`);
  };
  /** 当前档位下**可视窗口覆盖**的段号（画轨按段取图）。空数组 = 用 L0 整片图。
   *  与波形共用同一份 `segsFor`（段边界上两者必须一致，各算一份必然差一格）。 */
  const visibleSegs = useMemo(() => segsFor(level, windowStart, levelSpan), [level, windowStart, levelSpan]);
  /**
   * 当前可见段的「键」（L0 一个键、L1/L2 每段一个）。**与 <img> 的 key 同源** ——
   * 两处各算一份必然漂移，而漂移的表现是「图加载完了但提示不消失」这种极难查的现象。
   * 段集合**收缩**时（回移）存活的段键仍在 loaded 记录里 → filmReady 立刻为 true，
   * 不需要「先复位再等一次 onLoad」—— 那是第 3 轮 medium 修掉的病。
   */
  const filmKeys = useMemo(
    () => (level === 0 ? ['L0'] : visibleSegs.map((s) => `L${level}-${s}`)),
    [level, visibleSegs],
  );
  /** 画轨就绪 = 可见段全部有结论（成功或失败都算「有结论」，错误另有斜纹占位） */
  const filmReady = filmKeys.every((k) => filmLoaded[k] === true || filmFailed[k] === true);
  const derivedLoading = !filmReady; // 波形自带「加载中」，这里只管画轨（所以提示文案只说画轨，见 JSX）
  // 窗口越界校正 + **档位降级**（2026-10-03 OCR 审查第 2 轮修复）：
  //  ① 换作品不重挂载、素材也可能被原地换成更短的片 → duration 变小后当前档可能已失效；
  //     不降级的话按钮显示「选中但禁用」、轨道继续请求服务端必然 404 的档位 →
  //     onError 把 filmReady 置 true → 用户只看到一条空画轨、错误只在日志里（正是这次要避免的症状）。
  //  ② 窗口别停在素材之外（那时轨道整片空白，用户以为坏了）。
  useEffect(() => {
    if (duration <= 0) return;
    if (level === 1 && !levelUsable(1)) { setLevel(0); setWindowStart(0); return; }
    if (level === 2 && !levelUsable(2)) { setLevel(0); setWindowStart(0); return; }
    setWindowStart((w) => Math.max(0, Math.min(w, Math.max(0, duration - levelSpan))));
  }, [duration, level, levelSpan]); // eslint-disable-line react-hooks/exhaustive-deps
  // 过期响应丢弃（修复轮 1，Important 3）：换作品 id 时组件**不会**重挂载，effect 只是带着新 id 重跑，
  // 旧请求还在飞。若不丢弃，「作品 1 慢、作品 2 快」时作品 1 的响应后到，会把作品 1 的段与名字盖到作品 2 的页面上
  // （标题还是 作品 #2，肉眼看不出异常），用户一保存就把作品 1 的内容写进了作品 2 —— 静默写错数据。
  // 四个 ref 各管一条加载链：作品 / 资料详情 / 素材列表 / 成品列表
  // （**不能合用**：同一个 importId 变化会同时触发 getImport 与 listMedia 两条链，合用序号会让先发的那条
  //    被后发的作废、结果被静默丢掉 —— 那就是另一种「不写日志的静默失败」）。
  const workSeq = useRef(0);
  const sourceSeq = useRef(0);
  const mediaSeq = useRef(0);
  const listSeq = useRef(0);

  const validId = Number.isInteger(projectId) && projectId > 0;
  /** 资料 id：预览与派生图仍按资料取（D16：时间轴/波形/胶片条不变） */
  const importId: number | null = work?.import_id ?? null;

  // —— 脏标记无死角 ——
  // 段的所有变更点（addSegment/removeSegment/moveSegment/setLabel/dragEdge/clearAll）都走 setSegs：
  //   它把「改段」与「置脏」绑成一次原子操作，避免逐个 handler 手工 setDirty 时漏掉某一个。
  // 反例：若只在保存按钮附近 setDirty，拖边微调（pointermove 高频触发）就极易漏置 → 用户以为改了其实没标脏。
  const setSegs = useCallback((updater: (prev: EditSeg[]) => EditSeg[]): void => {
    setSegments((prev) => updater(prev));
    setDirty(true);
  }, []);

  // 载入作品（按**作品 id**）：作品名 + 段。回填**不置脏**——这不是用户的改动。
  // getWork 只把「恰好 404」（作品已删）收敛成 null，其它错误照常抛（别吞：吞了会渲染成空编辑器，用户以为没段而覆盖保存）。
  useEffect(() => {
    const seq = ++workSeq.current; // 序号提到判早退**之前**：早退也必须作废在途请求，否则旧响应仍能写回
    // 复位：这两个 flag 原来只置真不复位，换 id 后一次失败会永久粘住（作品一直显示「不存在」、错误一直红着）
    setWorkMissing(false);
    setErr(null);
    if (!validId) {
      logFe('error', `编辑页入口非法 projectId=${String(projectIdRaw)}`); // 失败路径必须留痕，不做静默分支
      setErr('作品不存在');
      return;
    }
    getWork(projectId)
      .then((w) => {
        if (seq !== workSeq.current) return; // 过期响应：用户已切到别的作品，丢弃（否则会把作品 1 的段写进作品 2）
        if (w === null) {
          setWorkMissing(true);
          logFe('error', `作品不存在 project=${projectId}`);
          return;
        }
        setWork(w);
        setNameDraft(w.name ?? '');
        setSegments(w.segments.map((s) => ({ start_sec: s.start_sec, end_sec: s.end_sec, label: s.label ?? null })));
        setDirty(false);
        // 换作品要重置素材侧的态：上一件的只读原因不能粘到新的一件上
        setSourceMissing(false);
        setVideoErrCode(null);
        setVideoNonce(0);
        setDuration(0);
        setCurrent(0);
        setSelected(null);
        // ⚠️ 缩放态也要复位（2026-10-03 OCR 审查第 6 轮 medium）：组件**不重挂载**，而 `info` 仍保留
        //   上一件的值 → 复位后的那一帧会以「新 importId + duration=0 + 上一件的 level/windowStart」渲染，
        //   segsFor 用旧窗口算出如 `L2-20` 这类段号 → 请求新素材上不存在的段 → 服务端 404 + 多余探测，
        //   还会留下误导性的错误日志与「波形生成失败」占位。校正 effect 跑在渲染之后，补不上这一帧 ——
        //   与 applyLevel 的约定一致：**档位与窗口必须在同一次更新里落**。
        setLevel(0);
        setWindowStart(0);
      })
      .catch((e: Error) => {
        if (seq !== workSeq.current) return;
        logFe('error', `拉取作品失败 project=${projectId}: ${e.message}`); // 失败留痕，不静默
        setErr(`拉取作品失败：${e.message}`); // 同时给用户可见文字
      });
  }, [projectId, validId]);

  // 成品明细：作品维度取数（D17：复用 GET /api/audio?project=）。导出成功后要重拉，故抽成可复用的 load。
  const loadProducts = useCallback((): void => {
    const seq = ++listSeq.current; // 同上：早退也要作废在途请求
    if (!validId) return;
    listProducts(projectId)
      .then((rows) => {
        if (seq !== listSeq.current) return; // 过期响应：已切到别的作品，别把它的成品挂到当前页
        setProducts(rows); setProductsErr(null);
      })
      .catch((e: Error) => {
        if (seq !== listSeq.current) return;
        logFe('error', `拉取成品列表失败 project=${projectId}: ${e.message}`);
        setProductsErr(e.message); // 空列表 + 一句报错，不让用户误以为「没导出过」
      });
  }, [projectId, validId]);

  useEffect(() => { loadProducts(); }, [loadProducts]);

  // 取该资料素材的 file_size 作版本串分量（T7-1）：服务端 upsert 换素材时不更新 created_at，
  //   故只有 file_size 变化才能反映「素材被替换」；拼进版本串收口 <video>/派生图拿到旧缓存的窗口。
  // ⚠️ 素材是**资料**维度的（media.import_id），所以这里等 work 回来、拿到 importId 才查。
  useEffect(() => {
    const seq = ++mediaSeq.current; // 换资料时旧响应会写错 file_size → 版本串错 → 拿旧缓存的派生图
    if (importId === null) return;
    listMedia()
      .then((list) => {
        if (seq !== mediaSeq.current) return;
        setFileSize(list.find((m) => m.import_id === importId)?.file_size ?? null);
      })
      .catch((e: unknown) => {
        if (seq !== mediaSeq.current) return;
        logFe('error', `拉素材列表失败: ${e instanceof Error ? e.message : String(e)}`);
      });
  }, [importId]);

  // 挂载时取一次导出目录（spec D13）：绿条要展示「导到哪了」，而前端不知道数据目录，只能问服务端算好的 output_dir_resolved。
  // 用户可能在别处改了设置，故导出完成时（onDone）再刷一次。
  useEffect(() => {
    if (!validId) return;
    getSettings()
      .then((s) => setExportDir(s.output_dir_resolved ?? ''))
      .catch((e: unknown) => logFe('error', `读取导出目录失败: ${e instanceof Error ? e.message : String(e)}`));
  }, [projectId, validId]);

  // 离开未保存提示（覆盖刷新/关闭）：SPA 内导航（返回按钮）不走 beforeunload，故「返回」另用 goBack 拦。
  useEffect(() => {
    if (!dirty) return undefined;
    const h = (e: BeforeUnloadEvent): void => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  // 保存 = 全量替换（D18）：PUT { name, segments }；用服务端返回的作品回填（服务端定的 sort_order 顺序即新顺序）。
  // 作品名取**输入框草稿**（D16：不再拿资料标题当作品名）；空白串 → null（服务端同一口径）。
  // 回填**不置脏**（这正是「已保存」的状态）。
  const doSave = async (): Promise<void> => {
    if (saving) return; // 连点守卫：第二次进来直接返回（loading 已亮，避免重复 PUT 打架）
    setSaving(true);
    setSaveMsg(null);
    try {
      const trimmed = nameDraft.trim();
      const r = await putWork(projectId, { name: trimmed === '' ? null : trimmed, segments });
      setSegments(r.segments.map((s) => ({ start_sec: s.start_sec, end_sec: s.end_sec, label: s.label ?? null })));
      setNameDraft(r.name ?? ''); // 回填服务端定稿（去空白 / 空名 → null），输入框与库里一致
      setWork((prev) => (prev === null ? prev : { ...prev, name: r.name, updated_at: r.updated_at, segments: r.segments }));
      setDirty(false);
      setSaveMsg('已保存');
    } catch (e) {
      setSaveMsg(`保存失败：${(e as Error).message}`); // 失败给用户可见文字（apiPut 内部已 logFe）
    } finally {
      setSaving(false); // 无论成败都复位，否则按钮永久 loading
    }
  };

  // 导出 = 以**当前界面上的段**为准（D15：不读 DB 作品、不自动保存）；进度走 SSE，终态只发一次 done（C-2）。
  // N1(spec D5.2):导出内容按 exportKind 透传——音频走既有 mp3/m4a/wav;视频恒 mp4(mediaKind='video',videoAn 标记纯视频)
  const doExport = async (): Promise<void> => {
    if (segments.length === 0) { setExportMsg('先添加至少一个剪辑段'); return; }
    setExporting(true); setExportPercent(0); setExportMsg(null);
    try {
      const { jobId } = await exportWork(projectId, {
        mode: exportMode,
        format: exportKind === 'audio' ? exportFormat : 'mp4',
        mediaKind: exportKind === 'audio' ? 'audio' : 'video',
        videoAn: exportKind === 'videoAn',
        segments,
      });
      // subscribeJob 在 status=error/cancelled 时也会回调 onError 兜底，故 onStatus 与 onError 都可能触发；
      //   两处都 off() 关流——重复 close 一个 EventSource 是幂等的，无害。
      const off = subscribeJob(jobId, {
        onProgress: (p) => setExportPercent(Math.round(p.percent)),
        onDone: (d) => {
          off(); setExporting(false);
          // C-2：separate 多段时终态只发一次 done，带 count → 提示「N 段」，否则笼统提示。
          // N1(spec D5.2):视频导出的 done 也带 count(字段名 audioId 保留 = 成品行 id)→ 判据只看 count,kind 无关
          const n = typeof d.count === 'number' ? d.count : null;
          // D13：主文案只说段数，不提「剪辑室」——那是下面那句固定说明的措辞，主文案若也提会与之重复、拗口
          setExportMsg(n !== null ? `已导出 ${n} 段` : '已导出');
          // 成品明细是**这一页**的产出，出口在这里（作品墙不再承担试听/单条删除，D14/D16）→ 导出完立刻重拉，
          //   否则用户导完还得手动刷新才看得到新成品。
          loadProducts();
          // 导出完成时刷一次目录：用户可能在别处改了设置，绿条要展示最新落盘位置。
          // 失败仍保留旧值（background 刷新，弹错会吵用户），但**必须留痕**——静默 catch 违反日志铁律，出问题时无从排查。
          void getSettings()
            .then((s) => setExportDir(s.output_dir_resolved ?? ''))
            .catch((e: unknown) => logFe('error', `导出完成后刷新导出目录失败: ${e instanceof Error ? e.message : String(e)}`));
        },
        // 竞态兜底：服务端对「订阅前已终态」的 job 走补发分支——只发 status{state:'done'}，不发 done 事件
        //   （server/src/ytdlp/ytdlp-routes.ts 的 SSE 路由里那段「已结束的 job 立即补发终态」；找法：搜
        //   `['done', 'error', 'cancelled'].includes(job.status)`，行号会漂移所以不写死）；而 subscribeJob 对
        //   state==='done' 只 es.close()、不回调 onDone（web/src/api.ts 的 subscribeJob）。
        //   若这里只认 error，此路径下既不复位 exporting 也无成功文案 → 导出按钮永久 loading。
        //   故补 done 分支复位；用函数式更新 prev ?? … 保证正常路径 onDone 先写的文案不被降级成笼统文案。
        onStatus: (s) => {
          if (s.state === 'error') { off(); setExporting(false); setExportMsg(`导出失败：${s.message ?? ''}`); }
          else if (s.state === 'done') { off(); setExporting(false); setExportMsg((prev) => prev ?? '已导出'); loadProducts(); }
        },
        onError: (m) => { off(); setExporting(false); setExportMsg(`导出失败：${m}`); },
      });
    } catch (e) {
      setExporting(false);
      setExportMsg(`导出失败：${(e as Error).message}`); // 失败给用户可见文字（apiPost 内部已 logFe）
    }
  };

  // 打开导出目录：工具栏 📂 与导出成功绿条里的按钮**共用同一个动作**（spec D7/D8/D11）；
  //   openExportDir 内部已完成「无桥降级 / 取目录 / 调系统打开 / logFe」，这里只负责 loading 与用户可见反馈。
  const onOpenExportDir = async (): Promise<void> => {
    setOpeningDir(true);
    try {
      const r = await openExportDir();
      if (r.ok) message.success(`已打开 ${r.dir}`);
      else message.error(r.message ?? '打开导出目录失败');
    } finally {
      setOpeningDir(false);
    }
  };

  // 成品明细的单条删除（仓库铁律：破坏性操作必须二次确认；文案说清「删哪条(带标题) + 连带删什么 + 不可恢复」）
  const removeProduct = (it: AudioRow): void => {
    Modal.confirm({
      title: `删除《${it.title}》？`,
      content: '此操作会同时删除成品文件和数据库记录，不可恢复。',
      okText: '删除',
      okType: 'danger',
      cancelText: '取消',
      onOk: async () => {
        try {
          const r = await deleteAudio(it.id);
          if (previewingId === it.id) stopPreview();
          setProducts((prev) => prev.filter((x) => x.id !== it.id)); // 本地移除,不必再拉一次列表
          logFe('info', `删除成品 id=${it.id} deleted=${r.deleted}`);
        } catch (e) {
          logFe('error', `删除成品失败 id=${it.id}: ${(e as Error).message}`);
          throw e; // 让 Modal 保持打开并显示错误
        }
      },
    });
  };

  // 返回剪辑室：有未保存改动先确认（Modal.confirm），无改动直接走
  const goBack = (): void => {
    if (!dirty) { navigate('/studio'); return; }
    Modal.confirm({
      title: '有未保存的剪辑点',
      content: '离开将丢失未保存的改动。',
      okText: '离开',
      okButtonProps: { danger: true },
      cancelText: '留下',
      onOk: () => navigate('/studio'),
    });
  };

  // 资料详情：来源名（页面标题）+ 素材集号 + has_video（有没有素材）。
  // 404 = 资料已被删除 → **只读态**（不是整页报错）：成品还在，得让用户还能试听/删除。
  // 其它错误（500/连不上）不套「资料已删除」这句话（那会把真实故障说成事实）→ 整页报错 + 可见文字。
  useEffect(() => {
    const seq = ++sourceSeq.current; // 换资料时旧响应会写错 info（标题/has_video 整个是别的资料的）
    setSourceMissing(false); // 复位：原来只置真，切到正常资料后仍卡在只读态
    if (importId === null) return;
    getImport(importId)
      .then((d) => {
        if (seq !== sourceSeq.current) return; // 过期响应，丢弃
        setInfo(d); setSourceMissing(false);
      })
      .catch((e: Error) => {
        if (seq !== sourceSeq.current) return;
        if (e instanceof ApiError && e.status === 404) {
          setSourceMissing(true);
          logFe('info', `资料已删除(只读态) import=${importId} project=${projectId}`);
          return;
        }
        // apiGet 内部已记一条；这里再记是因为「页面最终显示了什么错误」才是排查起点（含 id 上下文）
        logFe('error', `拉取来源详情失败 import=${importId}: ${e.message}`);
        setErr(e.message);
      });
  }, [importId, projectId]);

  // 时间轴容器宽度：图被 CSS 拉伸到容器宽，点击换算要用**容器**像素宽（写死 1600 在窄窗会失准）
  // ⚠️ 依赖里必须有 videoErrCode（2026-10-02 审查 Important）：轨道这整块的渲染条件是
  //   `info !== null && info.has_video && videoErrCode === null && importId !== null`（见下方时间轴 JSX）。
  //   视频加载失败 → 整块**卸载**（trackRef 变 null）；点「重试加载」→ videoErrCode 归 null → 整块**重新挂载**（新 DOM 节点）。
  //   依赖只有 [info] 时这条路上 effect 不会重跑，ro 从头到尾没挂到新节点上 → trackW 冻结在兜底的 IMG_W(1600)
  //   → filmH/waveH 退回 round(1600×90/1600)=90 与 120，**正好是 N2-b 修复前那两个旧常量**：
  //   宽高比修复静默失效、图上重新冒黑边，而且此后拖窗口宽度也不再更新。
  // 为什么不必再加别的（推演过轨道的每一个挂载/卸载条件）：
  //   · info —— 已覆盖 has_video 的来源（两者来自同一份 info 对象）。
  //   · importId / work —— 变了只是换掉两张图的 URL，React 按位置**复用同一个 DOM 节点**，
  //     被 ResizeObserver 观察的元素没变、它的宽度也没变，量宽器不需要重挂（早退分支 el===null 也不会因它们触发）。
  //   · duration —— 轨道外壳与它无关（只影响刻度/段区块/播放头，不影响挂不挂）。
  useEffect(() => {
    const el = trackRef.current;
    if (el === null) return undefined;
    const ro = new ResizeObserver(() => setTrackW(el.clientWidth || IMG_W));
    ro.observe(el);
    setTrackW(el.clientWidth || IMG_W);
    return () => ro.disconnect();
  }, [info, videoErrCode]);

  const seek = (t: number): void => {
    const v = videoRef.current;
    if (v !== null) v.currentTime = clamp(t, 0, duration || 0);
  };

  // 时间 → 轨道内的百分比位置（Spec B：缩放后轨道的 0% / 100% 对应**窗口**两端，不再是整片两端；
  // L0 时 windowStart=0、levelSpan=duration → 与旧的 (t/duration)*100 完全等价，所以 L0 行为不变）。
  const timeToPct = useCallback((t: number): number => ((t - windowStart) / levelSpan) * 100, [windowStart, levelSpan]);

  // 像素 → 时间。**缩放态下这是「窗口内换算」**：L0 时与旧公式 (px/width)*duration 完全等价。
  const xToTime = useCallback((clientX: number): number => {
    const el = trackRef.current;
    if (el === null || duration <= 0) return 0;
    const rect = el.getBoundingClientRect();
    // rect.width 是元素实际像素宽（= 1600 缩放后的值），不是 rect.right - left 的魔法数字
    const t = windowStart + (clamp(clientX - rect.left, 0, rect.width) / rect.width) * levelSpan;
    return clamp(t, 0, duration); // 窗口贴到片尾时右边界会略超出 → 夹回来
  }, [duration, levelSpan, windowStart]);

  const addSegment = (): void => {
    if (duration <= 0 || segments.length >= MAX_SEGMENTS) return;
    // 起点回退：播放头停在片尾时 current === duration，原写法 start = duration，则
    //   end = clamp(duration+10, duration+0.1, duration) = duration → 生成 start === end 的**零长非法段**
    //   （段区块宽度 0、列表显「时长 00:00」，且与 D18「end_sec > start_sec」冲突，保存必被拒）。
    // 因此剩余时长不足 0.1s 时把起点回退到片尾前 10 秒（并 clamp 到 ≥0），保证产生的段恒满足 end > start。
    const start = duration - current < 0.1 ? clamp(duration - 10, 0, duration) : clamp(current, 0, duration);
    const end = clamp(start + 10, start + 0.1, duration); // 从播放头起、默认 10 秒，随后可拖边微调
    setSegs((prev) => [...prev, { start_sec: start, end_sec: end, label: null }]); // 走 setSegs → 置脏
    setSelected(segments.length); // 新段的下标 = 追加前的长度
    logFe('info', `打点 project=${projectId} import=${importId} ${start.toFixed(2)}-${end.toFixed(2)}s 共 ${segments.length + 1} 段`);
  };
  const removeSegment = (i: number): void => {
    setSegs((prev) => prev.filter((_, k) => k !== i)); // 走 setSegs → 置脏
    setSelected(null);
    logFe('info', `删除剪辑点 project=${projectId} 第 ${i + 1} 段`);
  };
  const moveSegment = (i: number, dir: -1 | 1): void => {
    setSegs((prev) => { // 走 setSegs → 置脏（顺序变即要保存的改动）
      const j = i + dir;
      if (j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      const tmp = next[i]!; next[i] = next[j]!; next[j] = tmp; // 交换顺序 = 保存时段的先后（sort_order 按数组序）
      return next;
    });
  };
  const setLabel = (i: number, label: string): void => {
    setSegs((prev) => prev.map((s, k) => (k === i ? { ...s, label: label === '' ? null : label } : s))); // 走 setSegs → 置脏
  };

  // 拖边微调：pointermove 期间只改被拖段的首/尾（clamp 到 [0,duration]，首尾至少差 0.1s，和服务端校验同口径）
  // 监听挂在 window 上而不是元素上：指针划出细窄的拖柄后事件还能继续跟手（挂在元素上会中途“掉手”）
  const dragEdge = (index: number, edge: 'start' | 'end') => (e: ReactPointerEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    setSelected(index);
    const move = (ev: PointerEvent): void => {
      const t = xToTime(ev.clientX);
      setSegs((prev) => prev.map((s, i) => { // 走 setSegs → 置脏（拖边微调也是要保存的改动）
        if (i !== index) return s;
        return edge === 'start'
          ? { ...s, start_sec: clamp(t, 0, s.end_sec - 0.1) }
          : { ...s, end_sec: clamp(t, s.start_sec + 0.1, duration) };
      }));
    };
    const up = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // Ctrl+滚轮 = 切档（spec D3）。**必须 useEffect + addEventListener(…, {passive:false})**：
  //   React 的 onWheel 在 React 17+ 挂在根容器上、且是 passive 的，拦不住页面滚动 —— 而 Ctrl+滚轮在浏览器里
  //   本来就是「缩放整页」，我们要在时间轴范围内把它接管过来（时间轴外照旧缩放整页）。
  // ⚠️ 锚点 = 光标处的时间点：换档后那一秒必须留在**同一像素位置**，否则每次缩放画面都"跳"一下、用户找不到刚才看的地方。
  // ⚠️ 依赖里**不能放 windowStart / level**（2026-10-03 OCR 审查第 3 轮 high）：
  //   ① 放 windowStart → 平移时每帧都重订阅（拖动顺滑度直接受损）；
  //   ② 不放它们又要读到当前值 → 用 ref（每次渲染同步最新值，监听器本身只在真正需要时重建）。
  // ⚠️ 依赖里**必须**放 info / videoErrCode（同一批 high）：整块轨道挂载在
  //   `info!==null && has_video && videoErrCode===null && importId!==null` 之下 ——
  //   视频报错 → 轨道卸载；「重试加载」→ 在**新 DOM 节点**上重挂。这两个信号不变时 effect 不重跑、
  //   清理不执行 → wheel 监听留在已脱离的节点上，**新挂的时间轴上 Ctrl+滚轮静默失灵**。
  //   （与下面 ResizeObserver 那条是同一个坑，本仓已踩过一次。）
  const levelRef = useRef(level);
  const levelSpanRef = useRef(levelSpan);
  const windowStartRef = useRef(windowStart);
  levelRef.current = level;
  levelSpanRef.current = levelSpan;
  windowStartRef.current = windowStart;
  useEffect(() => {
    const el = trackRef.current;
    if (el === null) return undefined;
    const onWheel = (ev: WheelEvent): void => {
      const lv = levelRef.current;
      const span = levelSpanRef.current;
      const wStart = windowStartRef.current;
      if (!ev.ctrlKey) return; // 普通滚轮照常翻页面，不抢
      if (duration <= 0) return;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0) return;
      const ratio = (ev.clientX - rect.left) / rect.width;
      if (ratio < 0 || ratio > 1) return; // 指针不在时间轴上 → 不拦截，让浏览器缩放整页
      // 档位是离散的 0|1|2 —— 用显式边界判断（Math.min/Math.max 返回 number，收窄不回来）
      const want = ev.deltaY < 0 ? lv + 1 : lv - 1;
      if (want < 0 || want > 2 || want === lv) return; // 到顶/到底 → 不响应（也不改窗口）
      const next = want as 0 | 1 | 2;
      // ⚠️ 门槛要与按钮同一份（2026-10-03 OCR 审查修复）：原先这里只判 0..2 不判 duration，
      // 于是素材太短时滚轮仍能切到 L1/L2 → 画轨空白、错误只进日志（按钮的 disabled 形同虚设）。
      if (!levelUsable(next)) {
        logFe('info', `时间轴切档被门槛拦下 project=${projectId} level=${lv}→${next} duration=${duration.toFixed(2)}s`);
        return; // 不 preventDefault：让浏览器照常缩放整页（用户可能只是想缩页面）
      }
      // ⚠️ preventDefault 必须放在**所有守卫之后**（2026-10-03 OCR 审查第 2 轮修复）：
      //   原来它在守卫之前无条件调用 → 上面两条 return（到顶/门槛拦下）时**页面缩放也被吞掉**，
      //   结果「指针在时间轴上 Ctrl+滚轮」什么反应都没有（既不切档也不缩页面），用户无路可走。
      ev.preventDefault();
      // 锚点时间按**当前**窗算（换档前的位置），换档后按同一 ratio 反推新窗口起点 → 光标处那一秒不动
      const anchorT = wStart + ratio * span;
      const newSpan = next === 0 ? duration : LEVEL_SPAN_SEC[next];
      const newStart = anchorT - ratio * newSpan;
      // ⚠️ **必须传 newStart**（2026-10-03 OCR 审查第 4 轮 medium）：不传时 applyLevel 会退回
      //   「沿用当前 windowStart」→ 锚点保持形同没写（每次缩放画面都跳一下）。
      //   这是第 3 轮引入的回归 —— 加 applyLevel 时漏了参数。
      applyLevel(next, newStart);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
    // ⚠️ `levelUsable` **不进依赖**（2026-10-03 OCR 审查第 4 轮 medium）：它是内联箭头函数，每次渲染
    //   都是新引用 → 进了依赖就等于每次渲染都重订阅（平移时每帧一次），把上面三个 ref 的优化全抵消。
    //   它只依赖 duration（已在依赖里）与模块常量，所以读到的永远是当前值。
  }, [duration, projectId, info, videoErrCode]); // eslint-disable-line react-hooks/exhaustive-deps

  // —— 拖动定位（2026-10-02 N2-c）：时间轴上**三块区域各归谁**，实现时必须分区清楚、互不抢事件 ——
  //   ① 段区块左右各 8px 拖柄 → **拖边微调**（dragEdge）。它在 pointerdown 里已 stopPropagation，
  //      事件压根不冒到轨道层 → 拖边时永远不会误触发定位。
  //   ② 其余全部（时间尺 / 画轨 / 音轨 / 段区块**中部**）→ **拖动定位**：按下即 seek，拖动过程持续 seek（跟手）。
  //   ③ 段区块中部的 click → **选中该段**（既有行为，保留不动）。
  // ②③ 能共存：定位走 pointerdown、选中走 click，是两个不同的事件，一个手势同时满足两条，互不干扰。
  // 为什么不再挂在"点击定位层"的 onClick 上（旧实现，用户反馈的「滑动不顺」就出在这）：
  //   onClick 只在**松手时**触发一次 —— 拖动过程零反馈；而且按住拖完松手还会**再补跳一次**到松手处（误跳）。
  // 现在定位只发生在 pointerdown/pointermove，松手不再触发任何 seek → 误跳从根上不存在了。
  // ⚠️ 这里**故意不调** e.preventDefault()。**理由不是「它会抑制 click」** —— 2026-10-02 审查 Minor 6 核过规范：
  //   Pointer Events Level 2 §10.1 只保证被取消的 pointerdown 会抑制 mousedown/mouseover/mousemove/mouseup
  //   这一类**兼容鼠标事件**，click / auxclick / contextmenu 并不在其列（Level 3 还专门有一节澄清三者的关系），
  //   所以真调了它，③「点段选中」大概率照样点得出来。真正的理由是：**这一层不需要靠 preventDefault 做事** ——
  //   拖动时的防选中已分别由轨道层的 userSelect:'none'（别选中刻度文字）和定位层的整层遮挡（别把原生图片拖走）解决，
  //   不依赖 preventDefault 的副作用。少一个副作用就少一处跨浏览器行为不一致的隐患。
  // rAF 节流：pointermove 在高采样率鼠标上可达每秒数百次，每次都写 video.currentTime 会把媒体管线打满。
  //   合并成「每帧最多 seek 一次」，播放头仍跟手（最多晚一帧 ≈16ms，人眼察觉不到）。
  const scrubTargetRef = useRef(0);
  const scrubRafRef = useRef<number | null>(null);
  // 本次拖动挂在 window 上的收尾函数（审查 Minor 1/2）：pointerup **不一定会来** ——
  //   触屏纵向滑动被浏览器接管时来的是 pointercancel，鼠标在窗口外松手时根本不来。只靠 up 拆监听就会残留到下一次手势。
  const scrubStopRef = useRef<(() => void) | null>(null);
  const seekThrottled = (t: number): void => {
    scrubTargetRef.current = t;
    if (scrubRafRef.current !== null) return; // 本帧已排期 → 只更新目标位置，等下一帧统一 seek
    scrubRafRef.current = window.requestAnimationFrame(() => {
      scrubRafRef.current = null;
      seek(scrubTargetRef.current);
    });
  };
  // 卸载兜底（审查 Minor 1）：把在途的 window 监听拆掉。stop() 里含 removeEventListener×4（move/up/cancel/
  //   pointerdown-capture 兜底）+ cancelAnimationFrame，
  //   即「监听器」与「那一帧 rAF」两样都收干净（写法与 studio.tsx 卸载时清 400ms 定时器同一套）。
  // 不做也没有功能性危害（seek 里有 videoRef.current 判空、卸载后不会再 setState），但它是真泄漏，且触屏那条路彻底走不通。
  useEffect(() => () => { scrubStopRef.current?.(); }, []);
  // —— Spec B D3 · 手势分权（**切换规则写死在此，实现不许临时发挥**）——
  //   ① L0（最粗档）：空白区拖动 = **拖动定位 seek**（N2-c 行为原样保持，不因引入缩放而变）
  //   ② L1/L2：空白区拖动 = **平移视口**；**单击（位移 < 4px）= 定位**（用户仍能一步跳到某处）
  //   ③ 段区块左右 8px 拖柄 = 拖边微调（任何档位都不变，dragEdge 已 stopPropagation）
  //   ④ 段区块中部 click = 选中（任何档位都不变）
  // 为什么这样切：L0 是「一屏看全片」，用户在 L0 想的是**定位**；放大后想的是「挪窗口看别处」——
  //   同一个手势在两种意图下必须是两件事，否则二者必抢。**判据是「有没有位移」**：
  //   位移 ≈ 0 = 点一下 = 定位（意图明确）；位移 > 阈值 = 拖 = 挪窗口（意图明确）。
  // ⚠️ 别把②里的「单击定位」也砍掉：砍了之后缩放到 L1/L2 就再也点不到"某处"，用户只能拖到大概位置。
  const startScrub = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0 || duration <= 0) return; // 只认左键（右键是上下文菜单，不抢）；没有 duration 谈不上定位
    scrubStopRef.current?.(); // 上一次若没被 up 收掉（窗口外松手那种），先拆干净再挂这一次的
    const panMode = level > 0; // L1/L2 拖动 = 平移窗口；L0 保持 N2-c 的拖动定位
    const downX = e.clientX;
    const startWindow = windowStart; // 平移的基准：用起始窗口算，别用「上一帧的 state」（否则位移会累积放大）
    const rectW = trackRef.current?.getBoundingClientRect().width ?? 0;
    if (!panMode) {
      scrubTargetRef.current = xToTime(e.clientX);
      seek(scrubTargetRef.current); // 按下即 seek，不等移动（L0 的既有行为）
    }
    // 日志降噪（审查 Minor 4）：**纯点击（按下→松手，一次都没移动）不记任何日志**。
    //   logFe 不只往本地环形缓冲塞一条（web/src/api.ts 的 FE_LOG_CAP 只有 200 条），还同步 POST /api/logs；
    //   用户在时间轴上点几十下，真出问题时想看的那条 error 就被冲掉了 —— 与下方 productSrcs 那条既有教训同源。
    //   「真的拖动了」仍然两条齐全：开始那条在**第一次真正移动**时补记，结束那条在 pointerup 记。
    let moved = false;
    // 监听挂 window（与 dragEdge 同一套做法）：指针划出轨道后事件仍继续跟手，挂在元素上会中途"掉手"
    const move = (ev: PointerEvent): void => {
      if (ev.buttons === 0) return; // 丢键（拖出窗口）后 pointermove 仍会来，别再乱 seek
      const dx = ev.clientX - downX;
      if (panMode) {
        // 4px 阈值：触摸与高分屏上「点一下」也会带一两像素抖动，不设阈值会把点击误判成拖动
        if (Math.abs(dx) <= 4) return; // 还没越过阈值 → 先当作可能的单击，什么都不做
        if (!moved) {
          moved = true;
          logFe('info', `时间轴平移开始 project=${projectId} level=${level} from=${startWindow.toFixed(2)}s`);
        }
        if (rectW > 0) {
          // 向右拖（dx>0）→ 内容右移 → 窗口起点左移（减）；clamp 到 [0, duration-levelSpan]
          const next = startWindow - (dx / rectW) * levelSpan;
          setWindowStart(Math.max(0, Math.min(next, Math.max(0, duration - levelSpan))));
        }
        return;
      }
      const t = xToTime(ev.clientX);
      if (!moved) { moved = true; logFe('info', `时间轴拖动定位开始 project=${projectId} t=${t.toFixed(2)}s`); }
      seekThrottled(t);
    };
    const stop = (): void => { // 收尾 = 拆四个监听 + 取消在排期的那一帧。写成幂等的，pointerup / pointercancel / 下一次 pointerdown（capture 兜底）/ 卸载共用
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('pointerdown', stop, true); // OCR R1(2026-10-03)medium:下方 capture 兜底监听一并拆
      if (scrubRafRef.current !== null) { window.cancelAnimationFrame(scrubRafRef.current); scrubRafRef.current = null; }
      scrubStopRef.current = null;
    };
    const onUp = (ev: PointerEvent): void => {
      if (panMode) {
        // ⚠️ 判据用 `moved`（move 里只有越过 4px 阈值才置 true = 「本次确实平移过」），**不用松手瞬间的 |dx|**：
        //   用户把窗口拖走一段又挪回起点附近松手时，|dx| 会回到 0 → 会被误判成单击 → 用**陈旧的 xToTime 闭包**
        //   （它捕获的 windowStart 是按下时的值，而此时窗口已被平移改过）算出与当前窗口不符的时间并 seek，
        //   播放头会莫名跳一下。moved 是本次手势的既成事实，不受回移影响。（OCR 审查发现）
        const wasDrag = moved;
        stop(); // 先收尾：本次手势到此结束，不受后续事件影响
        if (!wasDrag) {
          // 位移没越过阈值 = 用户其实只想**点一下定位**（缩放态也要保留一步到位的定位能力，见上方分权注释②）
          const t = xToTime(ev.clientX);
          seek(t);
          logFe('info', `时间轴单击定位 project=${projectId} level=${level} t=${t.toFixed(2)}s`);
        } else {
          logFe('info', `时间轴平移结束 project=${projectId} level=${level}`);
        }
        return;
      }
      // 补最后一帧：rAF 可能还没跑就被 pointerup 打断 → 播放头会停在松手前一帧的位置（尾巴差十几像素）
      scrubTargetRef.current = xToTime(ev.clientX);
      stop(); // 先收尾再 seek：本次手势到此结束，不受后续事件影响
      seek(scrubTargetRef.current);
      if (moved) logFe('info', `时间轴拖动定位结束 project=${projectId} t=${scrubTargetRef.current.toFixed(2)}s`);
    };
    // pointercancel（审查 Minor 2）：手势被系统接管（触屏纵向滑动被浏览器拿去滚动、窗口失焦等）时**只收尾**，
    //   不再补那一次 seek —— 手势都被取消了还把播放头猛挪一下是纯打扰。缺了它监听器会一直挂到下一次 pointerup。
    const onCancel = (): void => { stop(); };
    scrubStopRef.current = stop;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    // OCR 复审 R1(2026-10-03) medium:pointerup 在窗口外松手等场景可能丢失 → 上面三个监听残留成
    // 「活着的僵尸手势」:随后的无关 pointerup(点工具栏按钮)会经 onUp 误 seek 播放头;随后在段拖柄上
    // 按下拖边(dragEdge 已 stopPropagation,startScrub 不会重入收尾)会让残留 move 在拖边时乱 seek。
    // 兜底:任意下一次 pointerdown 先收尾上一手势。capture 阶段注册,赶在 startScrub/dragEdge 处理之前;
    // stop 只拆监听、不碰事件对象 → 不影响任何正常点击/拖拽;本手势自己的 pointerdown 派发到轨道层时
    // window 捕获阶段早已结束,运行期后注册的监听不会回头收尾本次按下。
    window.addEventListener('pointerdown', stop, true);
  };

  // 「清空所有剪辑点」二次确认（仓库规则：破坏性操作必须确认；只删本作品的剪辑点，不动已导出的音频）
  const clearAll = (): void => {
    if (segments.length === 0) return;
    Modal.confirm({
      title: '清空所有剪辑点？',
      content: '只清空本作品里的剪辑时间点，已导出的音频不受影响。',
      okText: '清空',
      okType: 'danger', // 破坏性按钮统一红色
      cancelText: '取消',
      onOk: () => {
        const n = segments.length;
        setSegs(() => []); // 走 setSegs → 置脏（清空后保存即 PUT segments:[]，C-5）
        setSelected(null);
        logFe('info', `清空剪辑点 project=${projectId} 共 ${n} 段`);
      },
    });
  };

  // 预览地址：版本串 &v= 收口「素材替换后浏览器还拿旧流」的缓存窗口。
  // ⚠️ 用 useMemo 钉住 —— mediaFileUrl 内部会 logFe(debug) 且同步上报后端；
  //    若在渲染体里直调，播放时 onTimeUpdate 每秒触发数次重渲染 → 日志面板被刷爆 + 每秒数条 POST。
  // 预览与派生图共用同一版本串（T7-1）：file_size 变即素材被替换（服务端 upsert 不更新 created_at，故必须靠它）。
  const version = `${fileSize ?? 'na'}-${rev}`;
  // retry=N 参与 key/src：点「重试加载」时 N 变 → URL 变 → <video> 重新挂载并**真的重新发一次请求**
  //   （只改 key 不改 src 的话，浏览器可能命中上一次失败的缓存，重试变成空操作）。
  const previewSrc = useMemo(
    () => (importId !== null ? `${mediaFileUrl(importId)}&v=${version}&retry=${videoNonce}` : ''),
    [importId, version, videoNonce],
  );

  // 成品列表每条的播放地址（Important 2 修复轮 1）：**同样必须 useMemo 钉住**，理由与 previewSrc 完全相同 ——
  //   audioFileUrl 内部第一件事就是 logFe(debug) + 同步 POST /api/logs。原先这里直调，
  //   而 <video> 的 onTimeUpdate 每秒触发 4~60 次重渲染 → 每秒十几到几十条 debug + 同样多的 POST，
  //   200/500 条的环形缓冲会被冲掉，真正要看的 error 被挤掉（本仓日志页就靠那个缓冲）。
  const productSrcs = useMemo(
    () => new Map(products.map((p) => [p.id, audioFileUrl(p.id)] as const)),
    [products],
  );

  // 换素材时清空画轨的加载/失败记录（2026-10-03 OCR 审查第 3 轮）：段键不含 importId，
  // 换素材后旧的 'L1-0' 会被误当成已加载 → 新素材的段图永远等不到 onLoad → 「画轨生成中」永不消失。
  // ⚠️ 不依赖 windowStart / level：平移/切档不需要清（键命中已有记录就是已加载，见 filmReady 注释）。
  useEffect(() => {
    setFilmLoaded({});
    setFilmFailed({});
    // nonce 也要清（2026-10-03 OCR 审查第 2 轮 low）：段键 `L1-0` 不含 importId，
    // 上一件素材点过几次重试就会留下计数 → 新素材第一次取图就带一个非零 nonce。
    // 功能上无害（服务端不认 rev），但它让「首屏 URL 与上次不同」失去诊断价值
    // （排查时看到 URL 变却不知道为什么变），且素材 id 复用时计数会越滚越大。
    setFilmNonceBySeg({});
  }, [importId, version]);

  // 顶栏「预览音频」（D16）：播**最新一条音频成品**。listProducts 的排序是 created_at DESC, id DESC（服务端 SQL），
  //   故过滤后第一条就是最新。没有成品 → 禁用 + Tooltip 说清原因（静默无反应会被当成坏了）。
  // N1(spec D5.3):按钮语义就是"听" → 只数**音频**成品(视频成品不参与);作品只导出过视频时禁用并指向下方列表(视频行可直接播)
  const audioProducts = products.filter((p) => (p.media_kind ?? 'audio') === 'audio');
  const latestProduct = audioProducts[0] ?? null;
  const previewing = previewingId === null ? null : (products.find((p) => p.id === previewingId) ?? null);
  const previewTip = productsErr !== null
    ? '成品列表读取失败，暂时无法试听'
    : (latestProduct !== null
      ? '试听最新一条成品'
      : (products.length > 0 ? '这个作品只导出过视频，可在下方成品列表直接播放' : '这个作品还没有导出过成品'));
  const stopPreview = (): void => {
    const el = previewAudioRef.current;
    if (el !== null) el.pause();
    setPreviewingId(null);
  };
  const onPreviewAudio = (): void => {
    const el = previewAudioRef.current;
    const p = latestProduct;
    if (el === null || p === null) return;
    el.src = audioFileUrl(p.id); // 换 src 自动从头播
    setPreviewingId(p.id);
    logFe('info', `预览成品音频 id=${p.id} 标题=${p.title}`);
    void el.play().catch((e: unknown) => {
      const m = e instanceof Error ? e.message : String(e);
      logFe('error', `预览成品音频起播失败 id=${p.id}: ${m}`);
      setPreviewingId(null);
      message.error(`播放失败：${m}`); // 失败给用户可见文字
    });
  };

  // 只读态（spec D16）：**两个**触发源 —— 资料查不到（服务端 404）/ 这个资料没有素材行（has_video=false）。
  //   两者都是服务端明确回报的**事实**，所以页面据此禁用编辑控件是站得住的。
  // ⚠️ 修复轮 1（Important 1）：<video> 加载失败**不再**是只读态的触发源。
  //   原来它在页面里永久锁死编辑（<video> 一被卸载 onError 就不再触发，又没有重试入口），
  //   于是一次网络抖动 / 文件损坏 / 编码不支持就会把用户逼到「只能按 F5」→ 未保存的剪辑点全丢。
  //   素材读不出来 ≠ 不能编辑：段本来就在本地，保存也只写 DB（服务端 PUT 不碰视频文件），
  //   所以正确做法是**给出路**（重试加载 / 去资料库）而不是锁死。
  const readOnlyMsg: string | null = sourceMissing
    ? '资料已删除，无法再编辑；已导出的成品仍可试听与删除'
    : (info !== null && !info.has_video
      ? '这个资料没有视频素材，无法再编辑；已导出的成品仍可试听与删除'
      : null);
  const readOnly = readOnlyMsg !== null;

  // <video> 这次没加载出来的原因分档：只用浏览器给的 MediaError.code（真实判据），**不用它推断"文件被删了"**。
  //   事实：<video> 的请求是浏览器直接发的，前端拿不到 HTTP 状态码、也拿不到 ApiError；
  //   而本页其它请求（getImport.has_video / listMedia.file_size）都只反映 DB 行，**证明不了磁盘文件还在**。
  //   → 「文件真的没了」这个事实本页拿不到，文案只能说清"这次没加载出来 + 可能的原因"，不冒充确定结论。
  const videoErrReason: string = videoErrCode === 1 ? '浏览器中止了这次加载'
    : videoErrCode === 2 ? '拉流失败（可能是网络中断或服务端出错，也可能是文件已被外部删除）'
      : videoErrCode === 3 ? '解码失败（文件可能已损坏，或编码不被支持）'
        : videoErrCode === 4 ? '服务端返回的内容不是浏览器能解码的视频（可能是编码/容器不支持）'
          : '原因未知';
  const videoErrMsg: string | null = videoErrCode === null
    ? null
    : `视频素材这次没加载出来：${videoErrReason}。已打的剪辑点没有丢，可点「重试加载」再试一次，或到资料库重新下载素材`;
  // 重试加载：清错误码 + nonce 自增。src 与 key 都变 → <video> 重新挂载并**真的重新发一次请求**
  //   （只清错误码、URL 不变的话，浏览器可能直接复用上次失败的结果，重试就成了空操作）。
  const retryVideo = (): void => {
    setVideoErrCode(null);
    setVideoNonce((n) => n + 1);
    logFe('info', `重试加载视频素材 import=${String(importId)} project=${projectId} 第 ${videoNonce + 1} 次`);
  };

  // —— 整页错误 / 作品已删：给可见文字 + 出口（作品被删时页内已无任何可用操作，必须给回剪辑室的路）——
  if (err !== null) {
    return (
      <div style={{ padding: 16, display: 'flex', alignItems: 'center', gap: 12 }}>
        <Typography.Text type="danger">{err}</Typography.Text>
        <Button onClick={goBack}>返回剪辑室</Button>
      </div>
    );
  }
  if (workMissing) {
    return (
      <div style={{ padding: 16, display: 'flex', alignItems: 'center', gap: 12 }}>
        <Typography.Text type="danger">作品不存在（可能已被删除）</Typography.Text>
        <Button onClick={() => navigate('/studio')}>返回剪辑室</Button>
      </div>
    );
  }
  // 作品未到（getWork 在飞）先占位：过早渲染会立刻对 /api/media/:id/file、waveform、filmstrip 发请求——
  // 对没有素材的资料这三个请求必然失败 → 触发 img/video onError 的 logFe('error')，在日志页留下误导性错误记录。
  if (work === null) return <Typography.Text type="secondary" style={{ padding: 16 }}>加载中…</Typography.Text>;
  // 资料还在查：同样先占位（原因同上，见 info 未到时不渲染时间轴的老注释）
  if (info === null && !sourceMissing) return <Typography.Text type="secondary" style={{ padding: 16 }}>加载中…</Typography.Text>;

  // （Spec B 已删除旧的 pct / ticks：时间尺、段区块、播放头的位置现在都由 timeToPct(时间) 按**当前窗口**换算，
  //  不再是「整片百分比」。旧的 (i/10)*100% 刻度只在 L0 成立 —— 缩放到 L1/L2 后它会与窗口对不上。）
  // —— N2-b（2026-10-02）：两张派生图**按原图比例**铺满轨道，不再被拉变形 ——
  // 旧写法是 `width:100% + height:固定 90/120 + objectFit:'fill'`，fill 会强行改宽高比：
  // 容器 1400px 宽时横向缩到 0.875、纵向仍是 1.0 → 画面被纵向拉长约 14%（窗口越宽越扁）。
  // 现在显示高 = 容器实测宽 × (原图高 / 原图宽)，图按自己的比例铺满，**既不变形也不裁**。
  // 为什么不用 objectFit:'cover' + 固定高（方案 A，已否决）：固定高比下 cover 会按高对齐去裁两侧 ——
  // 1400px 容器配 90px 高，cover 要按 1600:90 缩放后左右各裁掉 100px（12 格胶片条少掉 1.5 格），
  // 那样"图上某点 ↔ 某个时间"就对不上了，等于毁掉 N0 刚修好的「覆盖整段」语义。**保持比例且不裁**才是对的。
  // 代价（已知、接受）：轨道总高随窗口宽变化（1400px 宽 → 胶片条 79px + 波形 105px = 184px）。
  // 高度只跟宽度走，横向映射（xToTime / 段区块的 left、width 百分比）**完全不受影响**。
  //
  // ⚠️ 2026-10-03（OCR 审查修复）：Spec B 之后**胶片图宽度随档位变**（L0 = 36 格 × 160 = 5760，
  // L1/L2 = 12 格 × 160 = 1920；tile 拼接不再做「整体 scale 到 1600×90」），所以这里**不能再用固定 IMG_W**：
  // 沿用 1600 会让 L0 的图（5760×90）以 contain 塞进「按 1600 算出的框」里 → 宽度撑满、高度只有框高的 1/3.6，
  // 轨道下半留大片空白（看起来像布局坏了）。服务端把该数导在 FILM_SHEET_W —— **单一来源，别在这里另写数字**。
  // L0（5760 宽）比 L1/L2（1920 宽）更「扁」是几何必然：36 格排一行，格宽相对高度更小。
  // 代价（接受）：**切档时轨道总高会变**（L0 更矮、L1/L2 更高）—— 这是「同屏看到的信息量不同」的诚实代价。
  const sheetW = FILM_SHEET_W[level];
  const filmH = Math.round((trackW * FILM_H) / sheetW);
  const waveH = Math.round((trackW * WAVE_H) / IMG_W); // 波形仍是固定 1600×120 的 legacy PNG 口径
  // 集号只在素材登记了合集集号时显示；用 Number.isInteger 判定（字段缺失时为 undefined，
  // 用 !== null 会渲染出「第 undefined 集」——剪辑室页踩过同款坑）
  const epText = info !== null && Number.isInteger(info.material_entry_index) ? `第 ${info.material_entry_index} 集` : undefined;

  return (
    <div style={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <PageHeader
        title={info?.title ?? `作品 #${projectIdRaw ?? '?'}`}
        meta={epText}
        toolbar={(
          <>
            {/* 作品名（D16）：顶栏可编辑。**不再拿资料标题当作品名** —— 作品是 1 资料 N 件，名字得是作品自己的。
                onChange 置脏（打字就脏，"打完字直接按 F5"也拦得住）。
                onBlur 也要兜（输入法回车等不一定触发 change），但**只在真的与已存值不同时**才置脏 ——
                否则"点进输入框什么都没改又点出来"会留下一个假的未保存标记，离开时弹一个假的确认框。 */}
            <Typography.Text type="secondary" style={{ fontSize: 12, flexShrink: 0 }}>作品名</Typography.Text>
            <Input
              value={nameDraft}
              onChange={(e) => { setNameDraft(e.target.value); setDirty(true); }}
              onBlur={() => { if (nameDraft.trim() !== (work?.name ?? '').trim()) setDirty(true); }}
              placeholder="给这个作品起个名"
              disabled={readOnly}
              style={{ width: 220 }}
            />
            {/* spec D9/D10：工具栏全部换纯图标，每个都挂中文 Tooltip；只加图标/提示/loading，不改任何 disabled/onClick 语义 */}
            <Tooltip title={readOnlyMsg ?? (saveMsg !== null && saveMsg.startsWith('保存失败') ? saveMsg : '保存剪辑点')}>
              {/* 禁用态包一层 span，否则 antd Tooltip 收不到鼠标事件、悬停不出提示（D9 要求提示可查） */}
              <span>
                <Button type="primary" icon={<SaveOutlined />} loading={saving} disabled={readOnly} onClick={() => void doSave()} />
              </span>
            </Tooltip>
            {/* N1:导出内容已不止音频(导出区可选视频),固定文案去掉"音频"二字;「以当前界面上的段为准」保留(D15 语义) */}
            <Tooltip title={readOnlyMsg ?? '导出（以当前界面上的段为准）'}>
              <span>
                <Button icon={<ExportOutlined />} loading={exporting} disabled={readOnly} onClick={() => void doExport()} />
              </span>
            </Tooltip>
            {/* 「打点」是本地编辑的入口，保留（计划工具栏清单漏列了它——去掉就无法新增段，与编辑页功能冲突）。
                W3(T9 复核,2026-10-02 deferred 批):禁用原因分流——视频没时长 / 段数满 / 可用,各说各的话,
                别让用户对着灰按钮猜为什么点不了 */}
            <Tooltip title={readOnlyMsg ?? (duration <= 0 ? '视频还没加载出时长，无法打点' : segments.length >= MAX_SEGMENTS ? `最多 ${MAX_SEGMENTS} 段，先删一段` : '在当前播放头打点')}>
              {/* 禁用态必须包一层 span，否则 antd Tooltip 收不到鼠标事件、悬停不出提示（D9 要求提示可查） */}
              <span>
                <Button icon={<PlusOutlined />} disabled={readOnly || duration <= 0 || segments.length >= MAX_SEGMENTS} onClick={addSegment} />
              </span>
            </Tooltip>
            {/* 「预览音频」（D16）：试听这个作品最新一条成品；只读态下**仍可用**（成品不依赖素材） */}
            <Tooltip title={previewTip}>
              <span>
                <Button icon={<CustomerServiceOutlined />} disabled={latestProduct === null || productsErr !== null} onClick={onPreviewAudio} />
              </span>
            </Tooltip>
            {previewing !== null && (
              <>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>正在试听《{previewing.title}》</Typography.Text>
                <Button size="small" type="link" icon={<StopOutlined />} onClick={stopPreview}>停止</Button>
              </>
            )}
            {/* D8：无桥（浏览器直连模式）时禁用，且 Tooltip 要看得出「为什么点不了」——静默无反应比禁用更糟，用户会以为坏了；
                故文案随 hasDesktopBridge() 切换，与绿条那颗按钮（见下方 exportMsg Alert 的 action）保持一致 */}
            <Tooltip title={hasDesktopBridge() ? '打开导出目录' : '仅桌面应用内可用'}>
              {/* 无桥禁用；包 span 让禁用态也能悬停（antd Tooltip 对 disabled 元素不触发鼠标事件） */}
              <span>
                <Button icon={<FolderOpenOutlined />} loading={openingDir} disabled={!hasDesktopBridge()} onClick={() => void onOpenExportDir()} />
              </span>
            </Tooltip>
            <Tooltip title={readOnlyMsg ?? '清空所有剪辑点'}>
              <span>
                <Button danger icon={<DeleteOutlined />} disabled={readOnly || segments.length === 0} onClick={clearAll} />
              </span>
            </Tooltip>
            <Tooltip title="返回剪辑室">
              <Button icon={<ArrowLeftOutlined />} onClick={goBack} />
            </Tooltip>
          </>
        )}
      />
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {/* 只读态黄条（D16）：说清「为什么不能编辑」+「还能干什么」；成品明细在下面照常可用。
            触发源只有两个**服务端确认的事实**（资料 404 / 没有素材行），不含 <video> 加载失败。 */}
        {readOnlyMsg !== null && (
          <Alert
            type="warning"
            showIcon
            message={readOnlyMsg}
            action={sourceMissing ? undefined : <Button size="small" onClick={() => navigate('/library')}>去资料库</Button>}
          />
        )}
        {/* 素材加载失败黄条（修复轮 1 Important 1）：**不锁编辑**，只说清"这次没加载出来 + 可能原因"+ 给重试出口。
            原来这里一失败就永久锁死全页（<video> 被卸载 → onError 不再触发 → 只能 F5 → 未保存的段全丢）。 */}
        {videoErrMsg !== null && (
          <Alert
            type="warning"
            showIcon
            message={videoErrMsg}
            action={(
              <Space>
                <Button size="small" type="primary" onClick={retryVideo}>重试加载</Button>
                <Button size="small" onClick={() => navigate('/library')}>去资料库</Button>
              </Space>
            )}
          />
        )}
        {/* 预览监视器 + 时间轴：仍按**资料**取（video / 派生图）；资料没了或**本次加载失败**就不渲染，
            免得对不存在的素材反复发请求、在日志页刷一串误导性的加载失败。
            ⚠️ 判据用 videoErrCode（浏览器给的错误码），失败后**给得出路**（上面的「重试加载」会把 nonce 递增 → 本块重新挂载）。 */}
        {info !== null && info.has_video && videoErrCode === null && importId !== null && (
          <>
            {/* 预览监视器：走既有 Range 路由 /api/media/:id/file；<video> 不播完不预载，控制条自带 seek */}
            <video
              ref={videoRef}
              key={previewSrc}
              src={previewSrc}
              controls
              onLoadedMetadata={(e) => {
                const d = e.currentTarget.duration || 0;
                setDuration(d);
                setVideoErrCode(null); // 这次真的解码出来了 → 清掉上一次失败的黄条
                // duration 是时间轴的唯一真相；它为 0 时整条时间轴不渲染，所以「到底量到多长」必须留痕
                logFe('info', `预览就绪 project=${projectId} import=${importId} duration=${d.toFixed(2)}s`);
              }}
              onError={(e) => {
                // 记浏览器的 MediaError.code：它是**真实判据**（2 网络/服务端错、3 解码失败、4 源不可解码）。
                // ⚠️ 不能拿它推断"文件被外部删了"——code 2 与 404/网络中断/服务端出错无法区分，本页也拿不到
                //    <video> 那次请求的 HTTP 状态码（浏览器直接发的，取不到 ApiError）。所以文案只说"可能的原因"。
                const code = e.currentTarget.error?.code ?? null;
                setVideoErrCode(code ?? 0); // 0 = 有 onError 但读不到 code（异常兜底），文案归到「原因未知」
                logFe('error', `视频素材加载失败 import=${importId} project=${projectId} mediaErrCode=${code ?? '(none)'} retry=${videoNonce}`);
              }}
              onTimeUpdate={(e) => setCurrent(e.currentTarget.currentTime)}
              style={{ width: '100%', maxWidth: 720, background: '#000', borderRadius: 8, alignSelf: 'center' }}
            />

            {/* Spec B：缩放档位（离散三档，spec D3 明确不做无级平滑缩放）。
                门槛数与服务端一致（128s / 300s）—— 服务端是权威判定，这里只是**别让用户点了才知道不行**。
                ⚠️ 改这两个数要同时改 server/src/media/derived-pyramid.ts 的 checkLevelAvailable。 */}
            <div style={{ display: 'flex', gap: 4, alignItems: 'center', marginBottom: 4, flexWrap: 'wrap' }}>
              <Typography.Text type="secondary" style={{ fontSize: 11 }}>缩放</Typography.Text>
              <Button size="small" type={level === 0 ? 'primary' : 'default'} onClick={() => applyLevel(0)}>全片</Button>
              <Button size="small" type={level === 1 ? 'primary' : 'default'} disabled={!levelUsable(1)} onClick={() => applyLevel(1)}>中景</Button>
              <Button size="small" type={level === 2 ? 'primary' : 'default'} disabled={!levelUsable(2)} onClick={() => applyLevel(2)}>近景</Button>
              <Typography.Text type="secondary" style={{ fontSize: 11, marginLeft: 8 }}>
                Ctrl+滚轮切档 · {level === 0 ? '拖动定位' : '拖动平移、单击定位'}
              </Typography.Text>
            </div>
            {/* 时间轴（spec 需求 7：三轨同屏）：时间尺 + 画轨（胶片条）+ 音轨（波形）+ 播放头 + 段区块 */}
            <div style={{ position: 'relative' }}>
              {/* 轨道层：**整层**接 pointerdown 做拖动定位（区域②，见 startScrub 处的三分区说明）。
                  userSelect:'none' —— 拖动时别把刻度文字选中（这里不能靠 preventDefault，见 startScrub 注释）。
                  段区块在它上面（自己处理 ① 和 ③）；下面那层"定位层"只剩光标与遮挡原生图片拖动的作用。 */}
              <div
                ref={trackRef}
                onPointerDown={startScrub}
                // OCR R3(2026-10-03) low·bug:缺 touchAction:'none' 时触屏拖动会被浏览器当页面滚动接管(发
                // pointercancel),连续定位在触屏上走不通——onCancel 只该是安全网,不该是主路径。
                // 代价:从时间轴起手的竖向滚动不再滚页面(时间轴周边区域照常滚)——标准 scrubber 取舍。
                style={{ position: 'relative', width: '100%', userSelect: 'none', touchAction: 'none' }}
              >
                {/* 时间尺：10 等分刻度。（Spec B：刻度按**当前窗口**铺 —— L0 时窗口=整片，与旧版逐字一致）
                    ⚠️ `duration > 0` 守卫必须留着（2026-10-03 OCR 审查）：素材 metadata 还没到时
                    levelSpan 退化成 1，不挡的话会渲染出「0.00s…1.00s」这排看似正常、实则无意义的刻度。
                    同源教训：N0 修掉的「时长未知却画出一张标准尺寸的正常图」。 */}
                <div style={{ position: 'relative', height: RULER_H }}>
                  {Array.from({ length: duration > 0 ? 11 : 0 }, (_v, i) => windowStart + (levelSpan * i) / 10).map((t, i) => (
                    <span key={i} style={{ position: 'absolute', left: `${timeToPct(t)}%`, fontSize: 11, color: '#999', transform: 'translateX(-50%)' }}>{fmtTime(t)}</span>
                  ))}
                </div>
                {/* 画轨：L0 = 整片一张（URL 与文件名都不变，向后兼容）；L1/L2 = 按可视窗口取段。
                    显示高按容器宽**等比**算(N2-b) → 不变形、不裁。onLoad/onError 都置「已结论」→ 生成中提示消失。
                    ⚠️ 2026-10-03（OCR 审查第 3 轮 medium）：L0 失败原先**只记日志、什么都不显示**（下面那句
                    「失败走日志,不重复造错误 UI」是 N0 时代的旧决策）。那时 L0 是**唯一**档位，失败=页面没救了，
                    记日志够用；现在 L1/L2 有了斜纹+重试，L0 却没有 → 同一份代码两套失败反馈，用户切回全片
                    只看到一条空黑轨道，连「生成失败」四个字都没有。**失败必须看得见**（spec D5 诚实原则）。 */}
                {level === 0 ? (
                  <div style={{ position: 'relative', width: '100%', height: filmH, background: '#111' }}>
                    <img
                      src={filmstripUrl(importId, `${version}-f${filmNonceBySeg.L0 ?? 0}`)}
                      alt="画轨"
                      onLoad={() => {
                        setFilmLoaded((p) => ({ ...p, L0: true }));
                        // 同上：成功一次就清掉失败记录（记录不能自相矛盾）
                        setFilmFailed(clearFilmKey('L0'));
                      }}
                      onError={() => {
                        setFilmFailed((p) => ({ ...p, L0: true }));
                        logFe('error', `胶片条加载失败 import=${importId}`);
                      }}
                      style={{ display: 'block', width: '100%', height: filmH, objectFit: 'contain', background: '#111' }}
                    />
                    {/* L0 失败占位：事件/z-index 与段图占位同款（理由见那里注释①②③）。
                        段键复用 'L0' → 换素材时的清空、以及 filmReady 的判定都无需为它另开一套。 */}
                    {filmFailed.L0 === true && (
                      <div style={{
                        position: 'absolute', zIndex: 1, pointerEvents: 'none', inset: 0,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        background: 'repeating-linear-gradient(45deg,rgba(26,32,44,0.9),rgba(26,32,44,0.9) 8px,rgba(35,43,59,0.9) 8px,rgba(35,43,59,0.9) 16px)',
                      }}>
                        <Typography.Text type="secondary" style={{ fontSize: 12, pointerEvents: 'none' }}>
                          画轨生成失败
                          <Typography.Link
                            onPointerDown={(e) => e.stopPropagation()}
                            onClick={(e) => {
                              e.stopPropagation();
                              setFilmFailed(clearFilmKey('L0'));
                              setFilmLoaded(clearFilmKey('L0'));
                              setFilmNonceBySeg((p) => ({ ...p, L0: (p.L0 ?? 0) + 1 }));
                              logFe('info', `用户重试画轨 L0 import=${importId}`);
                            }}
                            style={{ marginLeft: 8, pointerEvents: 'auto' }}
                          >重试</Typography.Link>
                        </Typography.Text>
                      </div>
                    )}
                  </div>
                ) : (
                  <div style={{ position: 'relative', width: '100%', height: filmH, background: '#111', overflow: 'hidden' }}>
                    {/* 段图各自按「段起点 - 窗口起点」定位、按段**实际跨度**定宽 —— 段与段之间不留缝也不重叠。
                        objectFit:'fill'：宽度已经按时间比例算好了，再用 contain 会因为原图比例不同而缩出缝。 */}
                    {visibleSegs.map((seg) => {
                      const segT0 = seg * levelSpan;
                      // 末段可能是余数（不足一整窗）—— 图表宽度按实际跨度给，别撑到窗口外
                      const segSpan = Math.max(0, Math.min(levelSpan, duration - segT0));
                      const key = `L${level}-${seg}`;
                      return (
                        <img
                          key={key}
                          src={filmSegUrl(importId, level as 1 | 2, seg, `${version}-f${filmNonceBySeg[key] ?? 0}`)}
                          alt={`画轨段 ${seg}`}
                          onLoad={() => {
                            setFilmLoaded((p) => ({ ...p, [key]: true }));
                            // ⚠️ 同时**清掉失败记录**（2026-10-03 OCR 审查第 4 轮 medium）：
                            //   失败可能是暂时的（500 环境问题 / 409 素材被换），用户切档再回来时这一次真的加载成功了 ——
                            //   只写 loaded 不清 failed → 斜纹占位永久盖在已经加载好的段图上，页内还没法清。
                            setFilmFailed(clearFilmKey(key));
                          }}
                          onError={() => { setFilmFailed((p) => ({ ...p, [key]: true })); logFe('error', `分段画轨加载失败 import=${importId} L${level}-${seg}`); }}
                          style={{ position: 'absolute', left: `${timeToPct(segT0)}%`, width: `${(segSpan / levelSpan) * 100}%`, height: filmH, objectFit: 'fill' }}
                        />
                      );
                    })}
                    {/* 失败段斜纹占位（spec D5 诚实原则：**不用邻段内容冒充**）。
                        ⚠️ **逐段定位，不做整轨覆盖**（2026-10-03 OCR 审查第 5 轮 medium）：L1/L2 的窗口只覆盖 1–2 段，
                        整轨 `inset:0` 的斜纹会把**已经加载好的邻段也盖掉** —— 用户明明有画面却看不到，
                        而文案还写着「部分画轨段失败」，自相矛盾。画轨是多个独立 <img>，占位就该跟它们同形。
                        （波形那边整面覆盖是无奈之举：它是一整块 canvas，没有「部分失败」的概念。） */}
                    {visibleSegs.filter((s) => filmFailed[`L${level}-${s}`] === true).map((seg) => {
                      const segT0 = seg * levelSpan;
                      const segSpan = Math.max(0, Math.min(levelSpan, duration - segT0));
                      return (
                        <div key={`failed-${seg}`} style={{
                          // `zIndex:1` 与 `pointerEvents:'none'` 是上面注释 ①② 的落点，缺任一个重试就点不到
                          position: 'absolute', zIndex: 1, pointerEvents: 'none',
                          left: `${timeToPct(segT0)}%`, width: `${(segSpan / levelSpan) * 100}%`,
                          top: 0, height: filmH, display: 'flex', alignItems: 'center', justifyContent: 'center',
                          background: 'repeating-linear-gradient(45deg,rgba(26,32,44,0.9),rgba(26,32,44,0.9) 8px,rgba(35,43,59,0.9) 8px,rgba(35,43,59,0.9) 16px)',
                        }}>
                          {/* ⚠️ 事件与 z-index 与 TimelineWave 的失败占位同款（2026-10-03 OCR 审查第 1 轮 medium）：
                              ① `zIndex:1` —— 父组件在画轨**之后**还有一层 `position:absolute; inset:0` 的定位层
                                 （盖住 <img>、不让浏览器拖走图片），它会盖住本占位并**吞掉所有点击** → 重试永远点不到；
                              ② `pointerEvents:'none'` 容器 + 只在链接上开 `auto` —— 整层吃事件会把音轨带的
                                 定位/平移/段拖柄全吞掉（那比「重试点不到」更严重）；
                              ③ stopPropagation —— 不让它冒到轨道层变成「点重试却 seek 了视频」。 */}
                          <Typography.Text type="secondary" style={{ fontSize: 11, pointerEvents: 'none' }}>
                            这段生成失败
                            <Typography.Link
                              onPointerDown={(e) => e.stopPropagation()}
                              onClick={(e) => {
                                e.stopPropagation();
                                // nonce 变 → 该段 URL 变 → 浏览器重新请求；同时清掉失败记录，
                                // 否则 filmReady 立刻又是 true（斜纹还在但「生成中」提示不出现，两边自相矛盾）。
                                const k = `L${level}-${seg}`;
                                setFilmFailed(clearFilmKey(k));
                                setFilmLoaded(clearFilmKey(k));
                                setFilmNonceBySeg((p) => ({ ...p, [k]: (p[k] ?? 0) + 1 }));
                                logFe('info', `用户重试画轨段 import=${importId} L${level}-${seg}`);
                              }}
                              style={{ marginLeft: 8, pointerEvents: 'auto' }}
                            >重试</Typography.Link>
                          </Typography.Text>
                        </div>
                      );
                    })}
                  </div>
                )}
                {/* 音轨：Spec B 起为 Canvas 自绘 —— 按当前档位与窗口重绘，放大后能看到局部疏密。
                    它自己带「加载中」与「失败占位 + 重试」，所以不再需要外层的 waveReady。
                    ⚠️ **duration > 0 才挂载**（2026-10-03 OCR 审查第 10 轮 medium）：metadata 还没到时
                    levelSpan 退化成哨兵值 1s → 每一列都落在文件的**第一秒**里 → 画出「看似正常的波形」
                    （L0 是整条恒定竖条，更细的点距则把第一秒拉满全宽）—— 与时间尺那道守卫同一个病根。
                    晚挂载零成本：峰值请求本来就由服务端缓存兜着。 */}
                {duration > 0 && (
                  <TimelineWave
                    importId={importId}
                    rev={`${version}-w${waveNonce}`}
                    level={level}
                    windowStart={windowStart}
                    windowSpan={levelSpan}
                    height={waveH}
                    onRetry={() => {
                      // rev 里带上 nonce → 组件收到新的 rev → 重新取数（见 waveNonce 的定义处注释）
                      setWaveNonce((n) => n + 1);
                      logFe('info', `用户重试波形 import=${importId} L${level}`);
                    }}
                  />
                )}
                {/* 定位层：**不再挂 onClick**（旧实现的误跳来源，见 startScrub 注释）。
                    保留它只为两件事：给空白区一个 crosshair 光标；盖住两张 <img>，不让浏览器把它们当图片拖走。 */}
                <div style={{ position: 'absolute', inset: 0, cursor: 'crosshair' }} />
                {/* 段区块：按**当前窗口**绝对定位，覆盖画轨+音轨两行（top 让开时间尺）。
                    中部：pointerdown 冒到轨道层 → L0 拖动定位 / L1L2 拖动平移（②）；
                    click 仍走下面的 setSelected → 选中该段（③，任何档位不变）。 */}
                {duration > 0 && segments.map((s, i) => {
                  // Spec B：只画**段与窗口的交集** —— 窗口外的段若照原样画，会溢出到容器外面去。
                  const visStart = Math.max(s.start_sec, windowStart);
                  const visEnd = Math.min(s.end_sec, windowStart + levelSpan);
                  if (visEnd <= visStart) return null;
                  return (
                    <div
                      key={i}
                      onClick={(e) => { e.stopPropagation(); setSelected(i); }}
                      style={{
                        position: 'absolute', top: RULER_H, height: filmH + waveH,
                        left: `${timeToPct(visStart)}%`, width: `${((visEnd - visStart) / levelSpan) * 100}%`,
                        background: 'rgba(22,119,255,0.20)', boxSizing: 'border-box',
                        border: selected === i ? '2px solid #1677ff' : '1px solid rgba(22,119,255,0.6)',
                      }}
                    >
                      {/* 左右 8px 拖柄：按住改起止（区域①，pointerdown 已 stopPropagation，不与定位抢）。
                          只在**段真实端点落在窗口内**时才画 —— 段被窗口裁掉一头时，那个拖柄不在视口里，
                          画在裁剪边界上会让人以为拖柄在段的中间（拖起来才发现改的是别处）。 */}
                      {visStart === s.start_sec && <div onPointerDown={dragEdge(i, 'start')} style={{ position: 'absolute', left: 0, top: 0, width: 8, height: '100%', cursor: 'ew-resize' }} />}
                      {visEnd === s.end_sec && <div onPointerDown={dragEdge(i, 'end')} style={{ position: 'absolute', right: 0, top: 0, width: 8, height: '100%', cursor: 'ew-resize' }} />}
                    </div>
                  );
                })}
                {/* 播放头：随 <video> 的 timeupdate 走；pointerEvents none，别挡住拖动定位。
                    Spec B：位置按窗口换算；播放头在**窗口外**时不画 —— 换算出来是负百分比或 >100%，
                    画出来就是一条贴在容器边上、骗人的假红线。 */}
                {duration > 0 && current >= windowStart && current <= windowStart + levelSpan && (
                  <div style={{ position: 'absolute', top: 0, left: `${timeToPct(current)}%`, width: 2, height: RULER_H + filmH + waveH, background: '#ff4d4f', pointerEvents: 'none' }} />
                )}
                {/* 生成中提示(W3/N0 复核遗留)：画轨还没结论就在轨道上给一行小字 —— 空轨道不说话用户只会以为坏了。
                    不做骨架屏(高度已预留)；覆盖层 pointerEvents none，不挡拖动定位；任一段失败即视为「有结论」，提示消失。
                    ⚠️ 2026-10-03（OCR 审查第 4 轮）两处过时陈述已改：① 「~50s」是 Spec B 之前的数字（L0 逐格 seek 实测 10.29s，
                    L1/L2 单段 3.38s，见下面按档位给秒数）；② 「错误只走日志」不再成立 —— 本轮给 L0 与 L1/L2 都补了
                    斜纹占位 + 重试，失败是**看得见且可恢复**的（spec D5 诚实原则）。 */}
                {derivedLoading && (
                  <div style={{ position: 'absolute', top: RULER_H, left: 0, width: '100%', height: filmH + waveH, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
                    {/* 文案只说画轨（2026-10-03 OCR 审查第 3 轮 low）：derivedLoading 现在只跟画轨，
                        波形有自己的加载态 —— 说「画轨/波形」会有一半是假的。
                        ⚠️ 秒数**按档位给**（第 4 轮 medium）：写死「10 秒」在 L0 对（实测 B1 = 10.29s），
                        但 L1/L2 是单段 12 格（实测 B2 = 3.38s）—— 切到中景后仍写「约需 10 秒」是把用户
                        的预期拉长 3 倍。数字取自实测报告 `.superpowers/sdd/2026-10-01-clip-works/ffmpeg-measure-report.md` §B 组。 */}
                    <Typography.Text type="secondary" style={{ fontSize: 12, background: 'rgba(255,255,255,0.85)', padding: '2px 10px', borderRadius: 4 }}>
                      画轨生成中，大文件约需 {level === 0 ? 10 : 4} 秒…
                    </Typography.Text>
                  </div>
                )}
              </div>
            </div>
          </>
        )}

        {/* 段列表：起止 + 该段时长 + 标签 + 上移/下移/删除（顺序即保存后的段序）
            只读态下这排控件一并禁用：保存已禁用，若这里还能改，用户会以为改进去了、离开时才发现没保存。 */}
        {segments.length === 0
          ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有剪辑点：拖播放头到位置，点「在当前播放头打点」" />
          : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {segments.map((s, i) => (
                <div
                  key={i}
                  onClick={() => setSelected(i)}
                  style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', border: selected === i ? '1px solid #1677ff' : '1px solid #f0f0f0', borderRadius: 6 }}
                >
                  {/* 修复轮 1 Minor 5（deferred，理由见 task-9-report）：这排控件没挂 Tooltip ——
                      给 antd 禁用态控件补提示必须包一层 <span> 垫层，而这一行是 flex 布局，
                      插 span 会改变标签输入框/按钮的排布（属"段列表手感不要动"的范围），故不收。
                      顶部黄条已说明"为什么全灰"，不至于让用户摸不着头脑。 */}
                  <Tag color="blue" style={{ marginInlineEnd: 0 }}>{i + 1}</Tag>
                  <Typography.Text>{fmtTime(s.start_sec)} - {fmtTime(s.end_sec)}</Typography.Text>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>时长 {fmtTime(s.end_sec - s.start_sec)}</Typography.Text>
                  <Input size="small" placeholder="标签（可空）" value={s.label ?? ''} maxLength={100} disabled={readOnly} onChange={(e) => setLabel(i, e.target.value)} style={{ maxWidth: 200 }} />
                  <Button size="small" onClick={() => moveSegment(i, -1)} disabled={readOnly || i === 0}>上移</Button>
                  <Button size="small" onClick={() => moveSegment(i, 1)} disabled={readOnly || i === segments.length - 1}>下移</Button>
                  <Button size="small" danger disabled={readOnly} onClick={() => removeSegment(i)}>删除</Button>
                </div>
              ))}
            </div>
          )}
        {/* 导出设置（时间轴下方）：模式 + 格式 + 进度 + 结果提示（保存/导出成败都给可见文字） */}
        <div style={{ border: '1px solid #f0f0f0', borderRadius: 6, padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <Space wrap>
            <Typography.Text strong>导出</Typography.Text>
            {/* N1(spec D5.1):导出内容三选,标签样式同「导出」。选任一视频项 → 格式 Radio 隐藏(服务端固定 mp4);
                切回音频恢复且保留上次选中的 exportFormat(state 不重置)。只读态一并禁用(修复轮 1 Minor 1 同款理由)。 */}
            <Typography.Text strong>导出内容</Typography.Text>
            <Tooltip title={readOnlyMsg ?? '导出什么:音频(mp3/m4a/wav)或视频(mp4)'}>
              <span>
                <Radio.Group
                  value={exportKind}
                  onChange={(e) => setExportKind(e.target.value as 'audio' | 'video' | 'videoAn')}
                  options={[{ label: '音频', value: 'audio' }, { label: '视频（带音轨）', value: 'video' }, { label: '视频（纯视频）', value: 'videoAn' }]}
                  disabled={readOnly}
                />
              </span>
            </Tooltip>
            {/* 修复轮 1 Minor 1：只读态把这几个单选组一并禁用 —— 导出按钮已灰，用户改设置却发现点不动会困惑。
                Tooltip 给 span 垫层，禁用态也能悬停看到原因（与工具栏同一套写法）。 */}
            <Tooltip title={readOnlyMsg ?? '导出时怎么切段'}>
              <span>
                <Radio.Group
                  value={exportMode}
                  onChange={(e) => setExportMode(e.target.value as 'separate' | 'merge')}
                  options={[{ label: '分多段', value: 'separate' }, { label: '合并成一段', value: 'merge' }]}
                  disabled={readOnly}
                />
              </span>
            </Tooltip>
            {/* 格式 Radio 仅音频导出需要(spec D5.1):选视频时隐藏;条件渲染只动 JSX,exportFormat state 不重置 → 切回不丢 */}
            {exportKind === 'audio' && (
              <Tooltip title={readOnlyMsg ?? '导出成什么格式'}>
                <span>
                  <Radio.Group
                    value={exportFormat}
                    onChange={(e) => setExportFormat(e.target.value as 'mp3' | 'm4a' | 'wav')}
                    options={[{ label: 'mp3', value: 'mp3' }, { label: 'm4a', value: 'm4a' }, { label: 'wav', value: 'wav' }]}
                    disabled={readOnly}
                  />
                </span>
              </Tooltip>
            )}
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>导出的是当前界面上的剪辑段，不会自动保存</Typography.Text>
          </Space>
          {exporting && <Progress percent={exportPercent} />}
          {saveMsg !== null && <Alert type={saveMsg.startsWith('保存失败') ? 'error' : 'success'} message={saveMsg} showIcon />}
          {exportMsg !== null && (
            <Alert
              type={exportMsg.startsWith('导出失败') ? 'error' : (exportMsg.startsWith('已导出') ? 'success' : 'warning')}
              showIcon
              /* 成功绿条（D13）：文案 = 「已导出 N 段」+ 目标目录绝对路径；右侧 action 里给「打开导出目录」按钮 */
              message={(
                <span>
                  {exportMsg}
                  {exportMsg.startsWith('已导出') && exportDir !== '' && (
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>（{exportDir}）</Typography.Text>
                  )}
                  {/* D13 要求的固定一句：正面回答本切片存在的根因——用户「导出在哪、找不到」的焦虑；
                      告诉他产物就在下面的「已导出的成品」里、可直接试听。仅成功态显示，失败/警告态不显示 */}
                  {exportMsg.startsWith('已导出') && (
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>文件已登记到本页下方的「已导出的成品」</Typography.Text>
                  )}
                </span>
              )}
              action={exportMsg.startsWith('已导出') ? (
                /* 包 span 让禁用态（浏览器直连模式，D8）也能悬停出提示 */
                <Tooltip title={hasDesktopBridge() ? '在资源管理器中打开' : '仅桌面应用内可用'}>
                  <span>
                    <Button size="small" loading={openingDir} disabled={!hasDesktopBridge()} onClick={() => void onOpenExportDir()}>
                      打开导出目录
                    </Button>
                  </span>
                </Tooltip>
              ) : undefined}
            />
          )}
        </div>

        {/* 成品明细（D16/D17）：这一页的产出都在这儿 —— 试听 + 单条删除（作品墙不再承担，D14）。
            读的是 GET /api/audio?project=<作品id>，所以只含本作品的成品；导出成功后已重拉一次。 */}
        <div style={{ border: '1px solid #f0f0f0', borderRadius: 6, padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {/* 计数：拉取失败时不写数字（原来写 products.length 会显示「（0）」，读起来像"你确实没有成品"，真相是"没读到"） */}
          <Typography.Text strong>{productsErr !== null ? '已导出的成品（数量未知）' : `已导出的成品（${products.length}）`}</Typography.Text>
          {productsErr !== null && <Alert type="error" showIcon message={`成品列表读取失败：${productsErr}`} />}
          {products.length === 0 && productsErr === null
            ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="这个作品还没有导出过成品" />
            : products.map((it) => (
              <div
                key={it.id}
                style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', padding: '6px 8px', border: '1px solid #f0f0f0', borderRadius: 6 }}
              >
                <Typography.Text strong ellipsis={{ tooltip: it.title }} style={{ flex: '1 1 240px', minWidth: 0 }}>{it.title}</Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {/* 时长用 Number.isFinite 判（不是 !== null）：字段缺失/NaN 时也归到「时长未知」，
                      免得渲染出「undefined 秒」——同款坑在 material_entry_index 上踩过（见上方 epText） */}
                  {it.format} · {Number.isFinite(it.duration_sec) ? fmtTime(it.duration_sec as number) : '时长未知'}
                </Typography.Text>
                {/* src 取自 productSrcs（useMemo 钉住）——不能在这里直调 audioFileUrl，它内部会 logFe+POST，
                    而 onTimeUpdate 每秒触发数十次重渲染会把日志环形缓冲刷爆（见 Important 2 修复注释）。
                    N1(spec D5.2):按 media_kind 分流(字段缺失按 'audio' 兜,老服务端混跑防护)——视频行 <video controls
                    preload="metadata">(同一 /api/audio/:id/file 路由直接回 mp4)+ 分辨率徽标(无高不显示);音频行一字不动。
                    删除按钮/确认框/空态两种成品共用,不改。 */}
                {(it.media_kind ?? 'audio') === 'video' ? (
                  <>
                    <video
                      controls
                      preload="metadata"
                      src={productSrcs.get(it.id)}
                      onError={() => logFe('error', `成品视频加载失败 id=${it.id} work=${projectId} title=${it.title}`)}
                      style={{ maxWidth: 320, borderRadius: 6 }}
                    />
                    {it.height ? <Tag>{it.height}p</Tag> : null}
                  </>
                ) : (
                  <audio
                    controls
                    src={productSrcs.get(it.id)}
                    onError={() => logFe('error', `成品音频加载失败 id=${it.id} work=${projectId} title=${it.title}`)}
                    style={{ flex: '1 1 260px', minWidth: 220 }}
                  />
                )}
                <Button size="small" danger onClick={() => removeProduct(it)}>删除</Button>
              </div>
            ))}
        </div>
        {/* 隐藏播放器：顶栏「预览音频」按钮控制它（不渲染原生 controls，避免与上面每条的播放器重复） */}
        <audio
          ref={previewAudioRef}
          preload="none"
          onEnded={() => setPreviewingId(null)}
          onError={() => { logFe('error', '预览音频元素加载失败'); setPreviewingId(null); }}
        />
        {/* 映射口径自陈：让「点哪儿跳哪儿」的换算依据在界面上可见（窄窗下容器宽 < 1600，换算按容器宽） */}
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          时间轴宽度 {trackW}px · 图固定 1600 宽（点或拖动的位置都按容器宽度换算成时间；按住拖动可连续定位，段两端 8px 是拖边微调）
        </Typography.Text>
      </div>
    </div>
  );
}
