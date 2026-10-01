// web/src/components/TaskDrawer.tsx(2026-09-30 download-queue-tray spec D11/D12)
// 全局任务抽屉:下载/剪辑/导出**同列**,分「进行中 / 排队中」两组,可取消。
// 挂在 layouts/index.tsx 上 → 不随路由卸载 → 切 tab 不丢(这正是"挂 layout"的意义)。
// 数据源是轮询 GET /api/jobs?active=1(D9/D10):单任务 SSE 只盯一个 job,给不出队列全貌。
import { Alert, Button, Drawer, Empty, Progress, Space, Tag, Typography, message } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { cancelJob, listActiveJobs, logFe, type ActiveJob, type DownloadBatch } from '@/api';

interface TaskDrawerProps {
  open: boolean;
  onClose: () => void;
  /** 在途总数变化时回调 layout 更新导航徽标(D11) */
  onCountChange: (n: number) => void;
}

// 空批次:初始值(还没有任何下载时上方"下载中 0/0"的口径)
const EMPTY_BATCH: DownloadBatch = { total: 0, done: 0, running: 0, queued: 0 };

// 在途非空 → 1s(进度源本就是秒级,要跟得上);空闲 → 5s(没任务时别空转打服务端)
const POLL_BUSY_MS = 1000;
const POLL_IDLE_MS = 5000;

/** kind → 中文标签(D12:类型标签)。只有下载类会排队(D1),但抽屉是统一任务中心,三类都要显示 */
function kindLabel(kind: string): string {
  if (kind === 'ytdlp_video' || kind === 'ytdlp_download') return '下载';
  if (kind === 'ffmpeg_clip') return '剪辑';
  if (kind === 'ffmpeg_export') return '导出';
  return kind; // 未知 kind 原样显示,不静默吞掉(便于排查新增 kind)
}

/** kind → Tag 颜色,让三类任务一眼可分 */
function kindColor(kind: string): string {
  if (kind === 'ytdlp_video' || kind === 'ytdlp_download') return 'blue';
  if (kind === 'ffmpeg_clip') return 'purple';
  if (kind === 'ffmpeg_export') return 'green';
  return 'default';
}

export default function TaskDrawer({ open, onClose, onCountChange }: TaskDrawerProps) {
  const [jobs, setJobs] = useState<ActiveJob[]>([]);
  const [downloads, setDownloads] = useState<DownloadBatch>(EMPTY_BATCH);
  const [err, setErr] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<number | null>(null);

  // 下一次该等多久,由"本轮在途是否非空"决定。放 ref 而非 state:自调度闭包里要读到最新值,又不想触发重渲染
  const busyRef = useRef(false);
  // onCountChange 每次渲染都是新函数引用;放 ref 里取最新,避免它进 effect 依赖导致轮询被反复重启
  const onCountChangeRef = useRef(onCountChange);
  useEffect(() => {
    onCountChangeRef.current = onCountChange;
  }, [onCountChange]);

  useEffect(() => {
    // alive / timer 都是**本次 effect 的闭包私有变量**(不用组件级 ref):React 18 StrictMode 会在 dev 下
    // 挂载后立刻卸载再挂载,若共用一个组件级标记,第一次的 in-flight 请求回来时会误判"还活着"→
    // 排出一条**重复的**轮询链。闭包私有变量能保证只有"当前这次 effect"的请求才会续期。
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async (): Promise<void> => {
      try {
        const r = await listActiveJobs();
        if (!alive) return; // 请求期间被卸载 → 丢弃结果
        const active = r.jobs.filter((j) => j.status === 'pending' || j.status === 'running');
        setJobs(active);
        setDownloads(r.downloads);
        setErr(null);
        busyRef.current = active.length > 0;
        onCountChangeRef.current(active.length);
      } catch (e) {
        if (!alive) return;
        // 不静默 catch(spec §0.5):logFe 落日志 + 抽屉内 Alert;**不弹全局错误**;
        // 徽标保持上一次值(此处**不调用** onCountChange,也就不会把徽标清零)。
        const msg = e instanceof Error ? e.message : String(e);
        setErr(msg);
        logFe('error', `拉取在途任务失败:${msg}`);
      } finally {
        // 只在自己还活着时排下一次;节奏保持失败前的档位(有任务仍快轮询,网络恢复后能迅速接上)
        if (alive) {
          timer = setTimeout(() => {
            void tick();
          }, busyRef.current ? POLL_BUSY_MS : POLL_IDLE_MS);
        }
      }
    };
    void tick();
    // 卸载清定时器:否则组件销毁后仍在轮询(内存泄漏 + 无谓请求)
    return () => {
      alive = false;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };
  }, []);

  const onCancel = (id: number): void => {
    setCancelling(id);
    cancelJob(id)
      // 乐观移除:让"取消"按钮立刻有反馈;下一次轮询(≤1s)会拿到权威状态并同步徽标
      .then(() => setJobs((prev) => prev.filter((j) => j.id !== id)))
      .catch((e: unknown) => message.error(e instanceof Error ? e.message : String(e)))
      .finally(() => setCancelling(null));
  };

  const running = jobs.filter((j) => j.status === 'running');
  const pending = jobs.filter((j) => j.status === 'pending');

  /** 单条任务:D12 要求「类型标签 + 标题 + 进度条 + 百分比 + 取消按钮」(百分比由 Progress 自带展示) */
  const renderItem = (j: ActiveJob): JSX.Element => (
    <div
      key={j.id}
      style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0', borderBottom: '1px solid rgba(5,5,5,0.06)' }}
    >
      <Tag color={kindColor(j.kind)} style={{ marginInlineEnd: 0 }}>
        {kindLabel(j.kind)}
      </Tag>
      <div style={{ flex: 1, minWidth: 0 }}>
        <Typography.Text ellipsis style={{ display: 'block' }}>
          {j.subtitle !== null ? `${j.title} · ${j.subtitle}` : j.title}
        </Typography.Text>
        {/* 排队中(未起进程)进度必为 0,用 normal;进行中用 active(条纹动画)一眼区分两态 */}
        <Progress percent={j.progress} size="small" status={j.status === 'running' ? 'active' : 'normal'} />
      </div>
      <Button size="small" danger loading={cancelling === j.id} onClick={() => onCancel(j.id)}>
        取消
      </Button>
    </div>
  );

  return (
    <Drawer title="任务" width={480} open={open} onClose={onClose}>
      <Space direction="vertical" style={{ width: '100%' }} size="middle">
        {/* 顶部与托盘同一口径(D16):数字都由服务端算,前端只展示,避免两处漂移 */}
        <Typography.Text type="secondary">
          下载中 {downloads.done}/{downloads.total}
        </Typography.Text>
        {err !== null && <Alert type="error" showIcon message="任务列表刷新失败" description={err} />}
        {jobs.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有正在进行的任务" />
        ) : (
          <>
            {running.length > 0 && (
              <div>
                <Typography.Text strong>进行中</Typography.Text>
                {running.map(renderItem)}
              </div>
            )}
            {pending.length > 0 && (
              <div>
                <Typography.Text strong>排队中</Typography.Text>
                {pending.map(renderItem)}
              </div>
            )}
          </>
        )}
      </Space>
    </Drawer>
  );
}
