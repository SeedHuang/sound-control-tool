// web/src/pages/studio-detail.tsx
// P4 剪辑详情页（spec m2-workspace §0.5 P4 / §0.3）：页面头（来源名 + 第 N 集 D20）+ 预览监视器 + 时间轴 + 多段 CRUD。
// 图↔时间映射（spec §0.3 裁决，brief 同款）：派生图固定 1600 宽 ↔ [0, duration]；
//   容器里点击像素 X → t = (X - 容器左边) / 容器宽 * duration。
//   ⚠️ 换算一律用**容器实际像素宽**（getBoundingClientRect().width），不写死 1600 ——
//   窄窗下 CSS 会把图压缩到容器宽，写死 1600 会让「点哪儿跳哪儿」整体偏移（brief「图↔时间映射」裁决）。
// duration 以 <video>.duration 为**唯一真相**（不引入服务端 ffprobe 时长当第二份真相，D10）。
// 本任务（T5 + T6）做**本地**多段编辑 + 预览 + 时间轴，并接线保存（PUT /api/projects，全量替换 D18）
//   与导出（POST /api/projects/:id/export，以请求体为准 D15，SSE 进度）；编辑段时置脏、离开未保存时提示。
// 布局锁内容区高度：页面头固定，正文自己滚（spec D3，body 不滚）。
import { Alert, Button, Empty, Input, message, Modal, Progress, Radio, Space, Tag, Tooltip, Typography } from 'antd';
import { ArrowLeftOutlined, DeleteOutlined, ExportOutlined, FolderOpenOutlined, PlusOutlined, SaveOutlined } from '@ant-design/icons';
import { useNavigate, useParams } from '@umijs/max';
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import PageHeader from '@/components/PageHeader';
import { exportProject, filmstripUrl, getImport, getProject, getSettings, listMedia, logFe, mediaFileUrl, putProject, subscribeJob, waveformUrl, type ImportDetail } from '@/api';
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
  const { importId: importIdRaw } = useParams<{ importId: string }>();
  const importId = Number(importIdRaw);
  const navigate = useNavigate();

  const [info, setInfo] = useState<ImportDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [duration, setDuration] = useState(0);        // <video>.duration —— 时间轴的唯一真相
  const [current, setCurrent] = useState(0);          // 播放头位置（秒）
  const [segments, setSegments] = useState<EditSeg[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [rev] = useState(0);                          // 版本串的本地分量（T7 起与 file_size 拼成 version）
  const [fileSize, setFileSize] = useState<number | null>(null); // 素材字节数：upsert 换素材不改 created_at，只能靠它识别「素材被替换」

  // —— T6 保存/导出接线新增状态 ——
  const [dirty, setDirty] = useState(false);           // 有未保存改动（离开前提示的依据）
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [exportMode, setExportMode] = useState<'separate' | 'merge'>('separate');
  const [exportFormat, setExportFormat] = useState<'mp3' | 'm4a' | 'wav'>('mp3');
  const [exportPercent, setExportPercent] = useState(0); // job 的 progress 百分比（导出进度条）
  const [exportMsg, setExportMsg] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  // —— T5 工具栏图标化/打开导出目录新增状态（spec D7/D9/D10/D13）——
  const [saving, setSaving] = useState(false);        // 「保存」按钮 loading：防连点重复 PUT（不改按钮 disabled 语义）
  const [openingDir, setOpeningDir] = useState(false); // 「打开导出目录」loading：工具栏 📂 与成功绿条按钮**共用**
  const [exportDir, setExportDir] = useState('');      // output_dir_resolved：绿条展示「导到哪了」（服务端算好的绝对路径）

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [trackW, setTrackW] = useState(IMG_W);

  const validId = Number.isInteger(importId) && importId > 0;

  // —— 脏标记无死角 ——
  // 段的所有变更点（addSegment/removeSegment/moveSegment/setLabel/dragEdge/clearAll）都走 setSegs：
  //   它把「改段」与「置脏」绑成一次原子操作，避免逐个 handler 手工 setDirty 时漏掉某一个。
  // 反例：若只在保存按钮附近 setDirty，拖边微调（pointermove 高频触发）就极易漏置 → 用户以为改了其实没标脏。
  const setSegs = useCallback((updater: (prev: EditSeg[]) => EditSeg[]): void => {
    setSegments((prev) => updater(prev));
    setDirty(true);
  }, []);

  // 载入已存工程：来源在但没工程 → 空段（正常态）。回填**不置脏**——这不是用户的改动。
  useEffect(() => {
    if (!validId) return;
    getProject(importId)
      .then((p) => {
        setSegments(p ? p.segments.map((s) => ({ start_sec: s.start_sec, end_sec: s.end_sec, label: s.label ?? null })) : []);
        setDirty(false);
      })
      .catch((e: Error) => logFe('error', `拉取剪辑工程失败 import=${importId}: ${e.message}`)); // 失败留痕，不静默
  }, [importId, validId]);

  // 取该来源素材的 file_size 作版本串分量（T7-1）：服务端 upsert 换素材时不更新 created_at，
  //   故只有 file_size 变化才能反映「素材被替换」；拼进版本串收口 <video>/派生图拿到旧缓存的窗口。
  useEffect(() => {
    if (!validId) return;
    listMedia()
      .then((list) => setFileSize(list.find((m) => m.import_id === importId)?.file_size ?? null))
      .catch((e: unknown) => logFe('error', `拉素材列表失败: ${e instanceof Error ? e.message : String(e)}`));
  }, [importId, validId]);

  // 挂载时取一次导出目录（spec D13）：绿条要展示「导到哪了」，而前端不知道数据目录，只能问服务端算好的 output_dir_resolved。
  // 用户可能在别处改了设置，故导出完成时（onDone）再刷一次。
  useEffect(() => {
    if (!validId) return;
    getSettings()
      .then((s) => setExportDir(s.output_dir_resolved ?? ''))
      .catch((e: unknown) => logFe('error', `读取导出目录失败: ${e instanceof Error ? e.message : String(e)}`));
  }, [importId, validId]);

  // 离开未保存提示（覆盖刷新/关闭）：SPA 内导航（返回按钮）不走 beforeunload，故「返回」另用 goBack 拦。
  useEffect(() => {
    if (!dirty) return undefined;
    const h = (e: BeforeUnloadEvent): void => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  // 保存 = 全量替换（D18）：PUT { name, segments }；用服务端返回的工程回填（服务端定的 sort_order 顺序即新顺序）。
  // 回填**不置脏**（这正是「已保存」的状态）。
  const doSave = async (): Promise<void> => {
    if (saving) return; // 连点守卫：第二次进来直接返回（loading 已亮，避免重复 PUT 打架）
    setSaving(true);
    setSaveMsg(null);
    try {
      const r = await putProject(importId, { name: info?.title ?? null, segments });
      setSegments(r.project.segments.map((s) => ({ start_sec: s.start_sec, end_sec: s.end_sec, label: s.label ?? null })));
      setDirty(false);
      setSaveMsg('已保存');
    } catch (e) {
      setSaveMsg(`保存失败：${(e as Error).message}`); // 失败给用户可见文字（apiPut 内部已 logFe）
    } finally {
      setSaving(false); // 无论成败都复位，否则按钮永久 loading
    }
  };

  // 导出 = 以**当前界面上的段**为准（D15：不读 DB 工程、不自动保存）；进度走 SSE，终态只发一次 done（C-2）。
  const doExport = async (): Promise<void> => {
    if (segments.length === 0) { setExportMsg('先添加至少一个剪辑段'); return; }
    setExporting(true); setExportPercent(0); setExportMsg(null);
    try {
      const { jobId } = await exportProject(importId, { mode: exportMode, format: exportFormat, segments });
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
          // 导出完成时刷一次目录：用户可能在别处改了设置，绿条要展示最新落盘位置。
          // 失败仍保留旧值（background 刷新，弹错会吵用户），但**必须留痕**——静默 catch 违反日志铁律，出问题时无从排查。
          void getSettings()
            .then((s) => setExportDir(s.output_dir_resolved ?? ''))
            .catch((e: unknown) => logFe('error', `导出完成后刷新导出目录失败: ${e instanceof Error ? e.message : String(e)}`));
        },
        // 竞态兜底：服务端对「订阅前已终态」的 job 走补发分支——只发 status{state:'done'}，不发 done 事件
        //   （server/src/ytdlp/ytdlp-routes.ts:657-660）；而 subscribeJob 对 state==='done' 只 es.close()、不回调 onDone
        //   （web/src/api.ts:278）。若这里只认 error，此路径下既不复位 exporting 也无成功文案 → 导出按钮永久 loading。
        //   故补 done 分支复位；用函数式更新 prev ?? … 保证正常路径 onDone 先写的文案不被降级成笼统文案。
        onStatus: (s) => {
          if (s.state === 'error') { off(); setExporting(false); setExportMsg(`导出失败：${s.message ?? ''}`); }
          else if (s.state === 'done') { off(); setExporting(false); setExportMsg((prev) => prev ?? '已导出'); }
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

  // 来源详情：来源名（D20 标题）+ 素材集号 + has_video（D17 空态判据）
  useEffect(() => {
    if (!validId) {
      logFe('error', `剪辑详情入口非法 importId=${String(importIdRaw)}`); // 失败路径必须留痕，不做静默分支
      setErr('来源不存在');
      return;
    }
    getImport(importId)
      .then(setInfo)
      .catch((e: Error) => {
        // apiGet 内部已记一条；这里再记是因为「页面最终显示了什么错误」才是排查起点（含 importId 上下文）
        logFe('error', `拉取来源详情失败 import=${importId}: ${e.message}`);
        setErr(e.message);
      });
  }, [importId, importIdRaw, validId]);

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
    //   （段区块宽度 0、列表显「时长 00:00」，且与 D18「end_sec > start_sec」冲突，T6 保存必被拒）。
    // 因此剩余时长不足 0.1s 时把起点回退到片尾前 10 秒（并 clamp 到 ≥0），保证产生的段恒满足 end > start。
    const start = duration - current < 0.1 ? clamp(duration - 10, 0, duration) : clamp(current, 0, duration);
    const end = clamp(start + 10, start + 0.1, duration); // 从播放头起、默认 10 秒，随后可拖边微调
    setSegs((prev) => [...prev, { start_sec: start, end_sec: end, label: null }]); // 走 setSegs → 置脏
    setSelected(segments.length); // 新段的下标 = 追加前的长度
    logFe('info', `打点 import=${importId} ${start.toFixed(2)}-${end.toFixed(2)}s 共 ${segments.length + 1} 段`);
  };
  const removeSegment = (i: number): void => {
    setSegs((prev) => prev.filter((_, k) => k !== i)); // 走 setSegs → 置脏
    setSelected(null);
    logFe('info', `删除剪辑点 import=${importId} 第 ${i + 1} 段`);
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

  // 「清空所有剪辑点」二次确认（仓库规则：破坏性操作必须确认；只删本工程的剪辑点，不动已导出的音频）
  const clearAll = (): void => {
    if (segments.length === 0) return;
    Modal.confirm({
      title: '清空所有剪辑点？',
      content: '只清空本工程里的剪辑时间点，已导出的音频不受影响。',
      okText: '清空',
      okType: 'danger', // 破坏性按钮统一红色
      cancelText: '取消',
      onOk: () => {
        const n = segments.length;
        setSegs(() => []); // 走 setSegs → 置脏（清空后保存即 PUT segments:[]，C-5）
        setSelected(null);
        logFe('info', `清空剪辑点 import=${importId} 共 ${n} 段`);
      },
    });
  };

  // 预览地址：版本串 &v= 收口「素材替换后浏览器还拿旧流」的缓存窗口。
  // ⚠️ 用 useMemo 钉住 —— mediaFileUrl 内部会 logFe(debug) 且同步上报后端；
  //    若在渲染体里直调，播放时 onTimeUpdate 每秒触发数次重渲染 → 日志面板被刷爆 + 每秒数条 POST。
  // 预览与派生图共用同一版本串（T7-1）：file_size 变即素材被替换（服务端 upsert 不更新 created_at，故必须靠它）。
  const version = `${fileSize ?? 'na'}-${rev}`;
  const previewSrc = useMemo(
    () => (validId ? `${mediaFileUrl(importId)}&v=${version}` : ''),
    [validId, importId, version],
  );

  // —— 无素材空态（D17）：不进空编辑器，直接给「去资料库下视频」的出口 ——
  if (err !== null) return <Typography.Text type="danger" style={{ padding: 16 }}>{err}</Typography.Text>;
  // 来源详情未到时（info === null）先占位：否则会直接落到主渲染，立刻对 /api/media/:id/file、waveform、filmstrip 发请求——
  // 对 has_video=false 的来源这三个请求必然失败 → 触发 img onError 的 logFe('error')，在日志页留下「波形图/胶片条加载失败」的误导性错误记录；
  // 也短暂违反了「无素材时不渲染时间轴」（D17）。拿到 info 后再决定走空态还是时间轴。
  if (info === null) return <Typography.Text type="secondary" style={{ padding: 16 }}>加载中…</Typography.Text>;
  if (info !== null && !info.has_video) {
    return (
      <div style={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {/* 标题仍是来源名（T8 标题纪律：不出现与导航 Tab 重名的固定标题） */}
        <PageHeader title={info.title} toolbar={<Button onClick={goBack}>返回剪辑室</Button>} />
        <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Empty description="这个来源还没有视频素材">
            <Button type="primary" onClick={() => navigate('/library')}>去资料库下视频</Button>
          </Empty>
        </div>
      </div>
    );
  }

  const pct = duration > 0 ? (current / duration) * 100 : 0;
  const ticks = duration > 0 ? Array.from({ length: 11 }, (_v, i) => (duration * i) / 10) : [];
  // D20：集号只在素材登记了合集集号时显示；用 Number.isInteger 判定（字段缺失时为 undefined，
  // 用 !== null 会渲染出「第 undefined 集」——剪辑室页踩过同款坑）
  const epText = info !== null && Number.isInteger(info.material_entry_index) ? `第 ${info.material_entry_index} 集` : undefined;

  return (
    <div style={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <PageHeader
        title={info?.title ?? `来源 #${importIdRaw ?? '?'}`}
        meta={epText}
        toolbar={(
          <>
            {/* spec D9/D10：工具栏全部换纯图标，每个都挂中文 Tooltip；只加图标/提示/loading，不改任何 disabled/onClick 语义 */}
            <Tooltip title={saveMsg !== null && saveMsg.startsWith('保存失败') ? saveMsg : '保存剪辑点'}>
              <Button type="primary" icon={<SaveOutlined />} loading={saving} onClick={() => void doSave()} />
            </Tooltip>
            <Tooltip title="导出音频（以当前界面上的段为准）">
              <Button icon={<ExportOutlined />} loading={exporting} onClick={() => void doExport()} />
            </Tooltip>
            {/* 「打点」是本地编辑的入口，保留（计划工具栏清单漏列了它——去掉就无法新增段，与 T5 编辑器功能冲突） */}
            <Tooltip title="在当前播放头打点">
              {/* 禁用态必须包一层 span，否则 antd Tooltip 收不到鼠标事件、悬停不出提示（D9 要求提示可查） */}
              <span>
                <Button icon={<PlusOutlined />} disabled={duration <= 0 || segments.length >= MAX_SEGMENTS} onClick={addSegment} />
              </span>
            </Tooltip>
            {/* D8：无桥（浏览器直连模式）时禁用，且 Tooltip 要看得出「为什么点不了」——静默无反应比禁用更糟，用户会以为坏了；
                故文案随 hasDesktopBridge() 切换，与绿条那颗按钮（见下方 exportMsg Alert 的 action）保持一致 */}
            <Tooltip title={hasDesktopBridge() ? '打开导出目录' : '仅桌面应用内可用'}>
              {/* 无桥禁用；包 span 让禁用态也能悬停（antd Tooltip 对 disabled 元素不触发鼠标事件） */}
              <span>
                <Button icon={<FolderOpenOutlined />} loading={openingDir} disabled={!hasDesktopBridge()} onClick={() => void onOpenExportDir()} />
              </span>
            </Tooltip>
            <Tooltip title="清空所有剪辑点">
              <span>
                <Button danger icon={<DeleteOutlined />} disabled={segments.length === 0} onClick={clearAll} />
              </span>
            </Tooltip>
            <Tooltip title="返回剪辑室">
              <Button icon={<ArrowLeftOutlined />} onClick={goBack} />
            </Tooltip>
          </>
        )}
      />
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {/* 预览监视器：走既有 Range 路由 /api/media/:id/file；<video> 不播完不预载，控制条自带 seek */}
        <video
          ref={videoRef}
          key={previewSrc}
          src={previewSrc}
          controls
          onLoadedMetadata={(e) => {
            const d = e.currentTarget.duration || 0;
            setDuration(d);
            // duration 是时间轴的唯一真相；它为 0 时整条时间轴不渲染，所以「到底量到多长」必须留痕
            logFe('info', `预览就绪 import=${importId} duration=${d.toFixed(2)}s`);
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

        {/* 段列表：起止 + 该段时长 + 标签 + 上移/下移/删除（顺序即保存后的段序） */}
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
                  <Tag color="blue" style={{ marginInlineEnd: 0 }}>{i + 1}</Tag>
                  <Typography.Text>{fmtTime(s.start_sec)} - {fmtTime(s.end_sec)}</Typography.Text>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>时长 {fmtTime(s.end_sec - s.start_sec)}</Typography.Text>
                  <Input size="small" placeholder="标签（可空）" value={s.label ?? ''} maxLength={100} onChange={(e) => setLabel(i, e.target.value)} style={{ maxWidth: 200 }} />
                  <Button size="small" onClick={() => moveSegment(i, -1)} disabled={i === 0}>上移</Button>
                  <Button size="small" onClick={() => moveSegment(i, 1)} disabled={i === segments.length - 1}>下移</Button>
                  <Button size="small" danger onClick={() => removeSegment(i)}>删除</Button>
                </div>
              ))}
            </div>
          )}
        {/* 导出设置（时间轴下方）：模式 + 格式 + 进度 + 结果提示（保存/导出成败都给可见文字） */}
        <div style={{ border: '1px solid #f0f0f0', borderRadius: 6, padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <Space wrap>
            <Typography.Text strong>导出</Typography.Text>
            <Radio.Group
              value={exportMode}
              onChange={(e) => setExportMode(e.target.value as 'separate' | 'merge')}
              options={[{ label: '分多段', value: 'separate' }, { label: '合并成一段', value: 'merge' }]}
            />
            <Radio.Group
              value={exportFormat}
              onChange={(e) => setExportFormat(e.target.value as 'mp3' | 'm4a' | 'wav')}
              options={[{ label: 'mp3', value: 'mp3' }, { label: 'm4a', value: 'm4a' }, { label: 'wav', value: 'wav' }]}
            />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>导出的是当前界面上的剪辑段，不会自动保存工程</Typography.Text>
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
                      告诉他产物同时进了剪辑室、可直接试听。仅成功态显示，失败/警告态不显示 */}
                  {exportMsg.startsWith('已导出') && (
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>文件已同时登记到剪辑室</Typography.Text>
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
        {/* 映射口径自陈：让「点哪儿跳哪儿」的换算依据在界面上可见（窄窗下容器宽 < 1600，换算按容器宽） */}
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          时间轴宽度 {trackW}px · 图固定 1600 宽（点击位置按容器宽度换算成时间）
        </Typography.Text>
      </div>
    </div>
  );
}
