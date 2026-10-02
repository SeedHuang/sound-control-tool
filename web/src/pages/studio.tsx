// web/src/pages/studio.tsx(剪辑室 = 作品墙)
// 2026-10-01 spec clip-works:一个资料可以有多个剪辑作品,卡片 = 一个作品,点整张卡进编辑页。
// 删掉了旧的三类卡(资料卡 / 源已删除 / 无来源)、平铺视图与下钻层、分页(改为无限下拉 + 分批渲染)。
// 布局铁律(2026-09-29 定,2026-10-01 沿用):整页锁死高度 —— 头(toolbar/搜索)固定、身(自己滚)、无脚(分页已删)。
// 注意:本项目没有全局 reset,div 默认 content-box —— 凡「height:100% + padding」的这一层都要 boxSizing: border-box,
// 否则会比外框高出内边距那几像素、外框出现滚动条(2026-09-29 实测踩过:内容区 778 vs 本层 810)。
import { Button, Empty, Input, Modal, Tag, Tooltip, Typography } from 'antd';
import { DeleteOutlined, MutedOutlined, PlusOutlined, SearchOutlined, SoundOutlined } from '@ant-design/icons';
import { useNavigate } from '@umijs/max';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  apiGet, audioFileUrl, coverUrl, deleteAudio, deleteWork, getPreviewMuted, listWorks, logFe, onAudioChanged,
  setPreviewMuted, type AudioRow, type WorkSummaryDTO,
} from '@/api';
import NewWorkModal from '@/components/NewWorkModal';
import SiteLogo, { siteColor } from '@/components/SiteLogo';
import WorkPreview, { unlockAudio } from '@/components/WorkPreview';

const BATCH = 20;                // 每批渲染 20 条(spec D13):服务端一次性返回全部,前端分批渲染
const CARD_MIN_WIDTH = 190;
const CARDS_MAX_WIDTH = 1160;
// 「重拉列表时保住滚动位置」用的**行高估算**:卡片封面上限 16:9 + 文字区,约 200 上下;
// 拿它乘"新插入的条数"给 scrollTop 补位。列数随窗口变,这只是"大致对齐",不追求像素级。
const ROW_HEIGHT_EST = 210;

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** 作品卡:封面 + 作品名 + 资料名 + 摘要 + 最近编辑 + 删除;整张可点 = 进编辑页 */
function WorkCard({ work, muted, onOpen, onDelete }: {
  work: WorkSummaryDTO;
  muted: boolean;
  onOpen: () => void;
  onDelete: () => void;
}): JSX.Element {
  const [coverBroken, setCoverBroken] = useState(false);
  const [hoverReady, setHoverReady] = useState(false); // hover 停留 400ms 才起播(鼠标划过一排卡不许张张起播)
  const timer = useRef<number | null>(null);
  const tint = siteColor(work.source?.site ?? 'other');
  // 摘要口径(验收要点①②,spec §0.5):**只数这一个作品的段与成品**,绝不把素材音频算进来。
  // 数据直接来自服务端按作品聚合的列(product_count / segment_count),不在这里二次过滤 ——
  // "15/10" 这种荒谬值就是把成品也算进"已下集数"造成的,新页面不重犯。
  const summary = `成品 ${work.product_count} 条 · ${work.segment_count} 段 · 共 ${formatDuration(work.total_sec)}`;

  // 卸载时清掉 400ms 定时器:否则鼠标划过卡片后立刻切页,定时器仍会在卸载后触发 setState(泄漏 + 警告)
  useEffect(() => () => { if (timer.current !== null) window.clearTimeout(timer.current); }, []);

  const enter = (): void => { timer.current = window.setTimeout(() => setHoverReady(true), 400); };
  const leave = (): void => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    setHoverReady(false); // 移开 → WorkPreview 卸载 → 立刻停 + 回起点
  };

  return (
    <div
      className="sct-card"
      role="button"
      tabIndex={0}
      aria-label={work.name ?? `作品 #${work.id}`}
      onClick={onOpen}
      // 键盘守卫:只在事件源就是卡片本身时才处理。卡片里嵌了删除按钮(可聚焦的交互元素),
      // 它被 Enter/空格激活时,键盘事件会冒泡到这一层;若不拦,这里会先 preventDefault() 抢掉
      // 删除按钮的默认"点击"(→ Modal.confirm 根本不弹),再 onOpen() 误跳进编辑页。
      // 鼠标路径有 stopPropagation 兜着,键盘路径没有 —— 这条守卫正是补那个口子。
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); }
      }}
      onMouseEnter={enter}
      onMouseLeave={leave}
      style={{ border: '1px solid #f0f0f0', borderRadius: 10, background: '#fff', overflow: 'hidden', cursor: 'pointer', display: 'flex', flexDirection: 'column' }}
    >
      <div style={{ position: 'relative', aspectRatio: '16 / 9', background: tint.bg, overflow: 'hidden' }}>
        {/* 封面:有来源记录就试取图(onError 回退纯色底)。**刻意不用 has_cover 当渲染开关** ——
            那样"还没抓过图"的来源永远没机会触发服务端抓取(见 api.ts 的同类说明)。 */}
        {work.source !== null && !coverBroken
          ? <img
              src={coverUrl(work.import_id)}
              alt=""
              loading="lazy"
              onError={() => setCoverBroken(true)}
              style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
            />
          : <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <SiteLogo site={work.source?.site ?? 'other'} size={44} />
            </div>}
        {/* hover 快速预览(T7 组件):active 由上面的 400ms 定时器控制;muted 来自 toolbar 的声音开关 */}
        <WorkPreview work={work} active={hoverReady} muted={muted} />
        {work.source === null && <Tag color="default" style={{ position: 'absolute', right: 8, top: 8 }}>资料已删除</Tag>}
      </div>
      <div style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Typography.Text strong ellipsis={{ tooltip: work.name ?? '' }} style={{ minWidth: 0, flex: 1 }}>{work.name ?? `作品 #${work.id}`}</Typography.Text>
          {/* 删除:stopPropagation,否则会顺带进编辑页(整张卡都是点击区) */}
          <Tooltip title="删除这个作品（连同它的成品）">
            <Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={(e) => { e.stopPropagation(); onDelete(); }} />
          </Tooltip>
        </div>
        <Typography.Text type="secondary" ellipsis={{ tooltip: work.source?.title ?? '' }} style={{ fontSize: 12, minWidth: 0 }}>
          {work.source?.title ?? '（资料已删除）'}
        </Typography.Text>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>{summary}</Typography.Text>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>最近编辑 {work.updated_at}</Typography.Text>
      </div>
    </div>
  );
}

export default function StudioPage(): JSX.Element {
  const navigate = useNavigate();
  const [works, setWorks] = useState<WorkSummaryDTO[]>([]);
  const [orphans, setOrphans] = useState<AudioRow[]>([]);   // 无作品成品(安全网,通常为空)
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [shown, setShown] = useState(BATCH);                // 已渲染条数
  const [muted, setMuted] = useState(true);                 // 默认静音(spec D12);初值由 getPreviewMuted 拉取后覆盖
  const [newOpen, setNewOpen] = useState(false);             // 「新建作品」弹层开关(T8)
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  // 记上一次列表长度:重拉后按「新长度 − 旧长度」估算"被插到最前面的条数",给 scrollTop 补位(spec D13)
  const prevLenRef = useRef(0);

  // 过滤(spec §0.5:按作品名 / 所属资料名过滤)。放在 effects 之前,供 IntersectionObserver 的依赖使用。
  const q = query.trim().toLowerCase();
  const visible = q === ''
    ? works
    : works.filter((w) => (w.name ?? '').toLowerCase().includes(q) || (w.source?.title ?? '').toLowerCase().includes(q));

  useEffect(() => {
    const load = (): void => {
      // 主列表失败要显式报错;无作品成品只是安全网,失败只记日志(别把整页钉在错误态)
      listWorks()
        .then((rows) => {
          const delta = rows.length - prevLenRef.current;
          prevLenRef.current = rows.length;
          setWorks(rows);
          setError(null);
          // 服务端按 updated_at 倒序返回 → 新作品 / 刚改过的作品会插在**最前**,已有内容整体下移。
          // 给 scrollTop 补上这几位的高度,正在看第 3 屏的用户就不会被顶回顶部(只在"本来就滚着"时补)。
          if (delta > 0) {
            requestAnimationFrame(() => {
              const el = scrollRef.current;
              if (el !== null && el.scrollTop > 0) el.scrollTop += delta * ROW_HEIGHT_EST;
            });
          }
        })
        .catch((e: Error) => { setError(e.message); logFe('error', `拉取作品列表失败: ${e.message}`); });
      // 安全网数据源(spec §0.5):GET /api/audio **不带 project 参数 = 全库**;筛出"edit 且无作品"的。
      // 为什么不用 listProducts:它按作品 id 查,覆不全库 —— 安全网要的正是"不知道属于谁"的那些行。
      void apiGet<AudioRow[]>('/api/audio')
        .then((rows) => setOrphans(rows.filter((r) => r.source_type === 'edit' && r.source_work_id == null)))
        .catch((e: Error) => logFe('error', `拉取无作品成品失败(不影响作品墙): ${e.message}`));
      void getPreviewMuted().then(setMuted).catch((e: Error) => logFe('error', `读取预览声音设置失败: ${e.message}`));
    };
    load();
    // 三个既有重拉时机(别丢):① 下载/导出完成后的进程内通知;② 窗口重新可见;③ 窗口重新获得焦点
    const off = onAudioChanged(load);
    const onVisible = (): void => { if (document.visibilityState === 'visible') load(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', load);
    return () => { off(); document.removeEventListener('visibilitychange', onVisible); window.removeEventListener('focus', load); };
  }, []);

  // 无限下拉:哨兵元素进视口 → 多渲染一批。**重拉列表不重置 shown、不给容器加 key** →
  // 已渲染内容与滚动位置天然保住(配合上面的 scrollTop 补位,spec D13 的"不跳回顶部"才真的成立)。
  useEffect(() => {
    const el = sentinelRef.current;
    if (el === null) return undefined;
    const io = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) setShown((n) => Math.min(n + BATCH, visible.length));
    }, { root: scrollRef.current, rootMargin: '200px' });
    io.observe(el);
    return () => io.disconnect();
  }, [visible.length]);

  const onToggleMute = async (): Promise<void> => {
    const next = !muted;
    setMuted(next);
    if (!next) unlockAudio(); // 打开声音那一下是唯一可靠的用户手势 → 拿它做一次解锁尝试(见 WorkPreview)
    try { await setPreviewMuted(next); } catch (e) { logFe('error', `保存预览声音设置失败: ${(e as Error).message}`); }
  };

  // 删除作品:本仓铁律——破坏性操作必须二次确认。文案要说清「删的是哪个作品(带名)」+「连带删什么(条数)+不可恢复」
  const onDeleteWork = (w: WorkSummaryDTO): void => {
    Modal.confirm({
      title: `删除《${w.name ?? `作品 #${w.id}`}》？`,
      content: `将同时删除它的 ${w.product_count} 条成品（音频文件一并删除），不可恢复。`,
      okText: '删除',
      okType: 'danger',
      cancelText: '取消',
      onOk: async () => {
        try {
          const r = await deleteWork(w.id);
          setWorks((prev) => prev.filter((x) => x.id !== w.id)); // 本地移除,不必再拉一次列表
          logFe('info', `删除作品成功 id=${w.id} 连带成品=${r.deleted_products} 条`);
        } catch (e) {
          logFe('error', `删除作品失败 id=${w.id}: ${(e as Error).message}`);
          throw e; // 让 Modal 保持打开并显示错误
        }
      },
    });
  };

  // 无作品成品的单条删除(安全网分组里用)
  const onDeleteOrphan = (it: AudioRow): void => {
    Modal.confirm({
      title: `删除《${it.title}》？`,
      content: '此操作会同时删除音频文件和数据库记录，不可恢复。',
      okText: '删除',
      okType: 'danger',
      cancelText: '取消',
      onOk: async () => {
        try {
          await deleteAudio(it.id);
          setOrphans((prev) => prev.filter((x) => x.id !== it.id));
          logFe('info', `删除无作品成品 id=${it.id}`);
        } catch (e) {
          logFe('error', `删除无作品成品失败 id=${it.id}: ${(e as Error).message}`);
          throw e;
        }
      },
    });
  };

  if (error !== null) return <Typography.Text type="danger">{error}</Typography.Text>;

  const pageWorks = visible.slice(0, shown);

  const body: ReactNode = (
    <div style={{ width: '100%', maxWidth: CARDS_MAX_WIDTH, margin: '0 auto' }}>
      {visible.length === 0 ? (
        // 空态:一个作品都没有(或搜索无结果)。**这里不放「新建作品」按钮** —— 新建入口按 spec 只在 toolbar 上,
        // 空态再放一个会与 toolbar 的按钮重复。弹层(T8 已落地)挂在页面末尾,toolbar 按钮点它。
        <Empty description={q === '' ? '还没有剪辑作品' : `没有匹配「${query.trim()}」的作品`} style={{ marginTop: 64 }} />
      ) : (
        <>
          {/* 卡片网格:auto-fill + 最小宽 —— 窗口越宽列数越多;整块居中限宽,超宽屏不把卡片拉成巨幅 */}
          <div style={{ display: 'grid', gridTemplateColumns: `repeat(auto-fill, minmax(${CARD_MIN_WIDTH}px, 1fr))`, gap: 12 }}>
            {pageWorks.map((w) => (
              <WorkCard
                key={w.id}
                work={w}
                muted={muted}
                onOpen={() => { logFe('info', `打开作品 id=${w.id}`); navigate(`/studio/${w.id}`); }}
                onDelete={() => onDeleteWork(w)}
              />
            ))}
          </div>
          {/* 无限下拉哨兵:滚到它就多渲染一批(不占格) */}
          <div ref={sentinelRef} style={{ height: 1 }} />
        </>
      )}

      {/* 「无作品」安全网分组(spec §0.5):仅当确实存在"无作品成品"时才渲染。正常流程下永远为空 →
          整块不出现。它是防"数据静默消失"的网:万一日后又有代码路径产出无作品成品,用户仍能看见、试听、单条删。 */}
      {orphans.length > 0 && (
        <div style={{ marginTop: 24 }}>
          <Typography.Title level={5}>无作品（{orphans.length}）</Typography.Title>
          {orphans.map((it) => (
            <div
              key={it.id}
              style={{ border: '1px solid #f0f0f0', borderRadius: 8, padding: '10px 14px', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}
            >
              <Typography.Text strong ellipsis={{ tooltip: it.title }} style={{ flex: '1 1 240px', minWidth: 0 }}>{it.title}</Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {it.format} · {it.duration_sec ? formatDuration(it.duration_sec) : '时长未知'}
              </Typography.Text>
              <audio controls src={audioFileUrl(it.id)} style={{ flex: '1 1 260px', minWidth: 220 }} />
              <Button danger size="small" onClick={() => onDeleteOrphan(it)}>删除</Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );

  return (
    <div style={{ boxSizing: 'border-box', height: '100%', minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column', padding: 16, gap: 12 }}>
      {/* 头:toolbar —— 新建作品 / 搜索 / 声音开关 / 计数 */}
      <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        {/* 「新建作品」按钮(T8):打开弹层列「可剪的资料」;选中创建成功后直接进编辑页 */}
        <Button type="primary" icon={<PlusOutlined />} onClick={() => { logFe('info', '点「新建作品」打开弹层'); setNewOpen(true); }}>
          新建作品
        </Button>
        <Input
          allowClear
          prefix={<SearchOutlined />}
          placeholder="搜索作品名 / 资料名"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setShown(BATCH); }} // 过滤变化 → 渲染批数回到第一批
          style={{ flex: '0 1 320px', minWidth: 180, maxWidth: 420 }}
        />
        <Tooltip title={`预览声音：${muted ? '关' : '开'}`}>
          <Button
            aria-label="预览声音开关"
            icon={muted ? <MutedOutlined /> : <SoundOutlined />}
            onClick={() => void onToggleMute()}
          />
        </Tooltip>
        <Typography.Text type="secondary" style={{ marginInlineStart: 'auto' }}>共 {visible.length} 个作品</Typography.Text>
      </div>

      {/* 身:自己滚(上下自适应)。paddingTop 12:overflow 容器按 padding box 裁切,不留空间的话
          首行卡片悬停上浮的 2px 与阴影上半截会被切掉。**不给这一层加 key** —— 加了就会在列表变化时重挂载、把滚动位置清掉。 */}
      <div
        ref={scrollRef}
        className="sct-view-enter"
        style={{ boxSizing: 'border-box', flex: 1, minHeight: 0, overflowY: 'auto', paddingRight: 4, paddingTop: 12 }}
      >
        {body}
      </div>

      {/* 新建作品弹层(T8):列可剪资料 → 选中创建 → 直接进编辑页(此时时间轴是空的,用户从零开始剪) */}
      <NewWorkModal
        open={newOpen}
        onClose={() => setNewOpen(false)}
        onCreated={(projectId) => { setNewOpen(false); navigate(`/studio/${projectId}`); }}
      />
    </div>
  );
}
