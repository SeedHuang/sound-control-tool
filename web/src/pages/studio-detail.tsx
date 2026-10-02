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
  ApiError, audioFileUrl, deleteAudio, exportWork, filmstripUrl, getImport, getSettings, getWork, listMedia, listProducts,
  logFe, mediaFileUrl, putWork, subscribeJob, waveformUrl, type AudioRow, type ImportDetail, type WorkDetailDTO,
} from '@/api';
import { hasDesktopBridge } from '@/desktop';
import { openExportDir } from '@/export-dir';

const IMG_W = 1600;   // 派生图固定宽（D14，服务端按 1600 生成）；此处只当 ResizeObserver 还没量到宽时的兜底
const WAVE_H = 120;   // 波形图高（D14）
const FILM_H = 90;    // 胶片条高（D14）
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
  const doExport = async (): Promise<void> => {
    if (segments.length === 0) { setExportMsg('先添加至少一个剪辑段'); return; }
    setExporting(true); setExportPercent(0); setExportMsg(null);
    try {
      const { jobId } = await exportWork(projectId, { mode: exportMode, format: exportFormat, segments });
      // subscribeJob 在 status=error/cancelled 时也会回调 onError 兜底，故 onStatus 与 onError 都可能触发；
      //   两处都 off() 关流——重复 close 一个 EventSource 是幂等的，无害。
      const off = subscribeJob(jobId, {
        onProgress: (p) => setExportPercent(Math.round(p.percent)),
        onDone: (d) => {
          off(); setExporting(false);
          // C-2：separate 多段时终态只发一次 done，带 count → 提示「N 段」，否则笼统提示
          const n = d.kind === 'audio' && typeof d.count === 'number' ? d.count : null;
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
      content: '此操作会同时删除音频文件和数据库记录，不可恢复。',
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
  useEffect(() => {
    const el = trackRef.current;
    if (el === null) return undefined;
    const ro = new ResizeObserver(() => setTrackW(el.clientWidth || IMG_W));
    ro.observe(el);
    setTrackW(el.clientWidth || IMG_W);
    return () => ro.disconnect();
  }, [info]);

  const seek = (t: number): void => {
    const v = videoRef.current;
    if (v !== null) v.currentTime = clamp(t, 0, duration || 0);
  };

  const xToTime = useCallback((clientX: number): number => {
    const el = trackRef.current;
    if (el === null || duration <= 0) return 0;
    const rect = el.getBoundingClientRect();
    // rect.width 是元素实际像素宽（= 1600 缩放后的值），不是 rect.right - left 的魔法数字
    return (clamp(clientX - rect.left, 0, rect.width) / rect.width) * duration;
  }, [duration]);

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

  // 顶栏「预览音频」（D16）：播**最新一条成品**。listProducts 的排序是 created_at DESC, id DESC（服务端 SQL），
  //   故数组第一条就是最新。没有成品 → 禁用 + Tooltip 说清原因（静默无反应会被当成坏了）。
  const latestProduct = products[0] ?? null;
  const previewing = previewingId === null ? null : (products.find((p) => p.id === previewingId) ?? null);
  const previewTip = productsErr !== null
    ? '成品列表读取失败，暂时无法试听'
    : (latestProduct === null ? '这个作品还没有导出过成品' : '试听最新一条成品');
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

  const pct = duration > 0 ? (current / duration) * 100 : 0;
  const ticks = duration > 0 ? Array.from({ length: 11 }, (_v, i) => (duration * i) / 10) : [];
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
            <Tooltip title={readOnlyMsg ?? '导出音频（以当前界面上的段为准）'}>
              <span>
                <Button icon={<ExportOutlined />} loading={exporting} disabled={readOnly} onClick={() => void doExport()} />
              </span>
            </Tooltip>
            {/* 「打点」是本地编辑的入口，保留（计划工具栏清单漏列了它——去掉就无法新增段，与编辑页功能冲突） */}
            <Tooltip title={readOnlyMsg ?? '在当前播放头打点'}>
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

            {/* 时间轴（spec 需求 7：三轨同屏）：时间尺 + 画轨（胶片条）+ 音轨（波形）+ 播放头 + 段区块 */}
            <div style={{ position: 'relative' }}>
              <div ref={trackRef} style={{ position: 'relative', width: '100%' }}>
                {/* 时间尺：10 等分刻度 */}
                <div style={{ position: 'relative', height: 20 }}>
                  {ticks.map((t, i) => (
                    <span key={i} style={{ position: 'absolute', left: `${(i / 10) * 100}%`, fontSize: 11, color: '#999', transform: 'translateX(-50%)' }}>{fmtTime(t)}</span>
                  ))}
                </div>
                {/* 画轨（胶片条 PNG，固定 1600×90，CSS 拉伸填满容器）——加载失败只记日志，不阻断页面 */}
                <img
                  src={filmstripUrl(importId, version)}
                  alt="画轨"
                  onError={() => logFe('error', `胶片条加载失败 import=${importId}`)}
                  style={{ display: 'block', width: '100%', height: FILM_H, objectFit: 'fill', background: '#111' }}
                />
                {/* 音轨（波形 PNG，固定 1600×120） */}
                <img
                  src={waveformUrl(importId, version)}
                  alt="音轨"
                  onError={() => logFe('error', `波形图加载失败 import=${importId}`)}
                  style={{ display: 'block', width: '100%', height: WAVE_H, objectFit: 'fill', background: '#0b1220' }}
                />
                {/* 点击定位层：空白处点一下 → seek（段区块叠在它之上，自己 stopPropagation） */}
                <div onClick={(e) => seek(xToTime(e.clientX))} style={{ position: 'absolute', inset: 0, cursor: 'crosshair' }} />
                {/* 段区块：按百分比绝对定位，覆盖画轨+音轨两行（top 让开 20px 的时间尺） */}
                {duration > 0 && segments.map((s, i) => (
                  <div
                    key={i}
                    onClick={(e) => { e.stopPropagation(); setSelected(i); }}
                    style={{
                      position: 'absolute', top: 20, height: FILM_H + WAVE_H,
                      left: `${(s.start_sec / duration) * 100}%`, width: `${((s.end_sec - s.start_sec) / duration) * 100}%`,
                      background: 'rgba(22,119,255,0.20)', boxSizing: 'border-box',
                      border: selected === i ? '2px solid #1677ff' : '1px solid rgba(22,119,255,0.6)',
                    }}
                  >
                    {/* 左右 8px 拖柄：按住改起止 */}
                    <div onPointerDown={dragEdge(i, 'start')} style={{ position: 'absolute', left: 0, top: 0, width: 8, height: '100%', cursor: 'ew-resize' }} />
                    <div onPointerDown={dragEdge(i, 'end')} style={{ position: 'absolute', right: 0, top: 0, width: 8, height: '100%', cursor: 'ew-resize' }} />
                  </div>
                ))}
                {/* 播放头：随 <video> 的 timeupdate 走；pointerEvents none，别挡住点击定位 */}
                {duration > 0 && <div style={{ position: 'absolute', top: 0, left: `${pct}%`, width: 2, height: 20 + FILM_H + WAVE_H, background: '#ff4d4f', pointerEvents: 'none' }} />}
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
            {/* 修复轮 1 Minor 1：只读态把这两个单选组一并禁用 —— 导出按钮已灰，用户改设置却发现点不动会困惑。
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
                    而 onTimeUpdate 每秒触发数十次重渲染会把日志环形缓冲刷爆（见 Important 2 修复注释） */}
                <audio
                  controls
                  src={productSrcs.get(it.id)}
                  onError={() => logFe('error', `成品音频加载失败 id=${it.id} work=${projectId} title=${it.title}`)}
                  style={{ flex: '1 1 260px', minWidth: 220 }}
                />
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
          时间轴宽度 {trackW}px · 图固定 1600 宽（点击位置按容器宽度换算成时间）
        </Typography.Text>
      </div>
    </div>
  );
}
