// web/src/components/VideoClipPanel.tsx
// 资料库「视频预览剪音频」模式(2026-09-29 spec m1c-video-clip)。
// 为什么单独一个文件:library.tsx 已经很长,这个模式的交互(下视频/打点/剪)是自成一体的。
// 2026-09-30 实测:剪辑/下载完成 onDone 设 msg 后 refresh() 的 setMedia 会触发 effect,把成功提示和打点一并清零——
// 故拆成「来源 id 变化才清打点/提示」(lastSourceId ref)与「media 对齐选中素材」两个 effect,后者不清任何状态。
import { Alert, Button, Empty, InputNumber, Modal, Progress, Radio, Space, Typography } from 'antd';
import { useEffect, useRef, useState } from 'react';
import {
  clipMedia, deleteMedia, listMedia, mediaFileUrl, startDownload, subscribeJob,
  type DoneEvent, type ImportSource, type MediaItem,
} from '@/api';
import SiteLogo from '@/components/SiteLogo';

const HEIGHTS = [360, 480, 720, 1080] as const;
type Height = (typeof HEIGHTS)[number];

/** 秒 → mm:ss.s(打点输入框显示用) */
function fmt(sec: number): string {
  // 先四舍五入到 0.1s 再进位:否则 59.96 会显示成 00:60.0(秒满 60 没进到分)
  const t = Math.round(sec * 10) / 10;
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(1).padStart(4, '0')}`;
}
/** 字节 → 人类可读 */
function humanSize(bytes: number | null): string {
  if (bytes === null) return '大小未知';
  return bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}

// prop 只声明用到的字段(id/url/title):library.tsx 传入的 detail 是 ImportDetail(不含 entry_count),
// 用 Pick 才能让 ImportDetail 直接当 source 传进来(与计划参考实现的差异点,其余照抄)。
export default function VideoClipPanel({ source }: { source: Pick<ImportSource, 'id' | 'url' | 'title'> | null }) {
  const [media, setMedia] = useState<MediaItem[]>([]);
  const [height, setHeight] = useState<Height>(480);
  const [current, setCurrent] = useState<MediaItem | null>(null);
  const [start, setStart] = useState<number>(0);
  const [end, setEnd] = useState<number>(0);
  const [now, setNow] = useState<number>(0);
  const [format, setFormat] = useState<'mp3' | 'm4a' | 'wav'>('mp3');
  const [jobId, setJobId] = useState<number | null>(null);
  // 进度条显示条件不依赖 busy:I1 修复(2026-09-30)——服务端 201 立即返回、job 异步跑(R7),busy 只在
  // POST 往返瞬间为 true,依赖它则长任务(下 25MB 视频/剪长片段)期间零反馈。jobStage 由 SSE 置位:
  // progress → 'running'(下载,真实百分比),phase → 'ingest'(入库/剪辑,percent 无意义);
  // 终态(onDone / status done|error|cancelled)置 null 收掉。
  const [jobStage, setJobStage] = useState<'running' | 'ingest' | null>(null);
  const [percent, setPercent] = useState(0);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const refresh = (): void => {
    listMedia().then((list) => {
      setMedia(list);
      // 当前选中的素材可能已被删/被换 → 重新对齐
      setCurrent((cur) => (cur === null ? null : list.find((m) => m.import_id === cur.import_id) ?? null));
    }).catch((e: Error) => setError(e.message));
  };
  useEffect(refresh, []);
  // 来源 id 变化时才清打点/提示:ref 记住上一次 id,只有真正变了才清(首次挂载 ref 为 undefined,
  // source 非 null 的第一次也算变化,照清)。media 刷新/重渲染不会误清 onDone 刚设的提示与打点。
  const lastSourceId = useRef<number | undefined>(undefined);
  useEffect(() => {
    const id = source?.id;
    if (id === lastSourceId.current) return;
    lastSourceId.current = id;
    setStart(0); setEnd(0); setMsg(null); setError(null);
  }, [source]);
  // media 变化(如 refresh 后)只重新对齐选中素材,不清任何状态
  useEffect(() => {
    if (source === null) return;
    setCurrent(media.find((m) => m.import_id === source.id) ?? null);
  }, [source, media]);

  // job 生命周期:进度反馈(I1)+ 完成提示 + 素材列表刷新
  useEffect(() => {
    if (jobId === null) return undefined;
    return subscribeJob(jobId, {
      onProgress: (p) => { setJobStage('running'); setPercent(Math.round(p.percent)); },
      onPhase: () => setJobStage('ingest'), // 下载结束→入库;剪辑任务开场即推(clip-job.ts),进入无百分比段
      onDone: (d: DoneEvent) => {
        setJobStage(null); // 终态收掉进度条
        setMsg(d.kind === 'video' ? `已下好视频素材（${d.height ?? '?'}p）` : `《${d.title}》已入库`);
        refresh();
      },
      onStatus: (s) => {
        if (s.state === 'done') { setJobStage(null); refresh(); } // SSE 终态补发无富载荷 → onDone 不触发,刷新兜底
        else if (s.state === 'error' || s.state === 'cancelled') { setJobStage(null); setError(s.message ?? s.state); }
      },
    });
  }, [jobId]);

  const onDownloadVideo = async (): Promise<void> => {
    if (source === null || busy) return;
    setBusy(true); setError(null); setMsg(null);
    try {
      const r = await startDownload({
        url: source.url, title: source.title,
        produce: 'video', options: { videoHeight: height, format: 'mp3' },
      });
      setJobId(r.jobId);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  const onClip = async (): Promise<void> => {
    if (current === null || busy) return;
    if (!(end > start)) { setError('结束时间必须大于开始时间'); return; }
    setBusy(true); setError(null); setMsg(null);
    try {
      const r = await clipMedia(current.import_id, { start, end, format });
      setJobId(r.jobId);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  const onDeleteMedia = (m: MediaItem): void => {
    // 破坏性操作必须二次确认(仓库规则),写清"删什么 / 不连带删什么"
    Modal.confirm({
      title: `删除素材《${m.title}》?`,
      content: '只删除本地的视频素材文件，已剪出的音频不受影响。下次想再剪需要重新下载视频。',
      okText: '删除', okType: 'danger', cancelText: '取消',
      onOk: async () => { await deleteMedia(m.import_id); if (current?.import_id === m.import_id) setCurrent(null); refresh(); },
    });
  };

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      {error && <Alert type="error" showIcon message={error} />}
      {msg && <Alert type="success" showIcon message={msg} />}

      <Space wrap>
        <Typography.Text type="secondary">{source === null ? '先在左侧选一个来源' : `来源：${source.title}`}</Typography.Text>
        <Radio.Group size="small" value={height} onChange={(e) => setHeight(e.target.value as Height)} disabled={busy}>
          {HEIGHTS.map((h) => <Radio.Button key={h} value={h}>{h}p</Radio.Button>)}
        </Radio.Group>
        <Button type="primary" onClick={() => void onDownloadVideo()} loading={busy} disabled={source === null}>
          {current === null ? '下视频' : '重新下视频（覆盖当前素材）'}
        </Button>
      </Space>

      {/* I1(2026-09-30):job 活跃即显示(onProgress/onPhase 置位),不再依赖 busy——否则 POST 201 返回后
          长任务期间零反馈。下载段真实百分比;入库/剪辑段 percent 无意义 → 100% active 无数字
          (对齐 library.tsx 两段式口径)。视频下载与剪辑共用同一根:两种 job 都走 SSE。 */}
      {jobId !== null && jobStage !== null && (
        jobStage === 'ingest'
          ? <Progress percent={100} status="active" showInfo={false} />
          : <Progress percent={percent} status="active" />
      )}

      {current === null ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有这个来源的视频素材——先点「下视频」" />
      ) : (
        <>
          <video
            ref={videoRef}
            controls
            src={mediaFileUrl(current.import_id)}
            style={{ width: '100%', maxHeight: 420, background: '#000' }}
            onTimeUpdate={(e) => setNow(e.currentTarget.currentTime)}
            onError={() => setError('素材文件已丢失，请重新下载视频')}
          />
          <Space wrap>
            <Typography.Text>当前 {fmt(now)}</Typography.Text>
            <Button size="small" onClick={() => setStart(Math.round(now * 10) / 10)}>设为起点</Button>
            <Button size="small" onClick={() => setEnd(Math.round(now * 10) / 10)}>设为终点</Button>
            <Typography.Text type="secondary">起点</Typography.Text>
            <InputNumber size="small" min={0} step={0.1} value={start} onChange={(v) => setStart(Number(v ?? 0))} />
            <Typography.Text type="secondary">终点</Typography.Text>
            <InputNumber size="small" min={0} step={0.1} value={end} onChange={(v) => setEnd(Number(v ?? 0))} />
            <Radio.Group size="small" value={format} onChange={(e) => setFormat(e.target.value as 'mp3' | 'm4a' | 'wav')}>
              <Radio.Button value="mp3">mp3</Radio.Button>
              <Radio.Button value="m4a">m4a</Radio.Button>
              <Radio.Button value="wav">wav</Radio.Button>
            </Radio.Group>
            <Button type="primary" onClick={() => void onClip()} loading={busy}>剪出音频</Button>
          </Space>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            区间 {fmt(start)} – {fmt(end)}（{Math.max(0, Math.round((end - start) * 10) / 10)} 秒）
          </Typography.Text>
        </>
      )}

      <div>
        <Typography.Text strong>已下过的素材</Typography.Text>
        {media.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无素材" />
        ) : (
          media.map((m) => (
            <div key={m.import_id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '1px solid #f0f0f0' }}>
              <SiteLogo site={m.site} size={18} />
              <Typography.Text ellipsis style={{ minWidth: 0, flex: 1 }}>{m.title}</Typography.Text>
              {/* 显示"当初选的档位",不是实测分辨率 —— 文案写"档位"别让用户误解 */}
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>档位 {m.height ?? '?'}p</Typography.Text>
              {/* spec §0.6 五要素(标题/logo/档位/大小/时间):取日期部分,与 secondary 小字风格一致 */}
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>{m.created_at.slice(0, 10)}</Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>{humanSize(m.file_size)}</Typography.Text>
              <Button size="small" onClick={() => { setCurrent(m); setStart(0); setEnd(0); setMsg(null); }}>打开</Button>
              <Button size="small" danger onClick={() => onDeleteMedia(m)}>删除</Button>
            </div>
          ))
        )}
      </div>
    </Space>
  );
}
