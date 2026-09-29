// web/src/pages/library.tsx(音频库)
// 2026-09-29 用户拍板:列表 + 名称搜索 + 分页 + 平台 logo + 原视频地址 + 剧集「第几集/该集名字」;
// 又在搜索栏右侧加了「视图切换」:平铺(逐条列表)/ 剧集分组(作品聚合卡片墙,点卡片进该作品自己的音频列表)。
// 布局与获取页同款:整页锁死内容区高度 —— 头(搜索/切换/计数)、身(自己滚)、脚(分页)三段;
// 行内 flexWrap + maxWidth,窄窗自动折行。
// 注意:本项目没有全局 reset,div 默认 content-box —— 凡「height:100% + padding」的这一层都要 boxSizing: border-box,
// 否则会比外框高出内边距那几像素、外框出现滚动条(2026-09-29 实测踩过:内容区 778 vs 本层 810)。
import { Button, Empty, Input, Modal, Pagination, Progress, Segmented, Tag, Typography } from 'antd';
import { AppstoreOutlined, ArrowLeftOutlined, SearchOutlined, UnorderedListOutlined } from '@ant-design/icons';
import { useEffect, useRef, useState } from 'react';
import { apiGet, audioFileUrl, coverUrl, deleteAudio, listImports, logFe, onAudioChanged, type AudioRow, type ImportSource } from '@/api';
import SiteLogo, { siteColor } from '@/components/SiteLogo';

const PAGE_SIZE_OPTIONS = ['10', '20', '50'];
const CARD_MIN_WIDTH = 190;   // 卡片最小宽:窗口越宽列数越多(auto-fill),不是把列数写死
const CARDS_MAX_WIDTH = 1160; // 内容区最大宽:超宽屏上整块居中,不让卡片/正文被拉成巨幅

/** 主名:合集条目显示合集名(用户心里的「这张专辑」),单视频/录制显示自身标题 */
function mainTitle(it: AudioRow): string {
  return it.collection_title ?? it.title;
}
/** 「第 N 集」标签;单视频 → null。
    用 Number.isInteger 判定而不是 `=== null`:字段缺失(老版本 server 不返回 entry_index 时是 undefined)
    也曾被渲染成「第 undefined 集」——实测踩到过,判定收严后缺字段一律不显示。 */
function episodeTag(it: AudioRow): string | null {
  return Number.isInteger(it.entry_index) ? `第 ${it.entry_index} 集` : null;
}
/** 解析器给「平台没给标题的分集」的兜底名(server 侧 parse.ts 的 `条目 N`)——
    它不是集名,当集名显示出来就是「第 94 集 条目 94」这种废话,故识别为占位符不显示。 */
const PLACEHOLDER_TITLE = /^条目\s*\d+$/;
/** 该集自己的名字(合集条目才有;与合集名相同、或是占位名 → 不显示) */
function episodeTitle(it: AudioRow): string | null {
  if (!it.collection_title || it.title === it.collection_title) return null;
  if (PLACEHOLDER_TITLE.test(it.title.trim())) return null;
  return it.title;
}
function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** 一个「作品」= 同一来源网址下的全部入库音频(番剧/课程/合集)。没有来源网址的(理论上只有录制)各自成卡 */
interface WorkGroup {
  key: string;                 // 来源网址
  title: string;               // 作品名(合集名)
  site: string;                // 平台(算 logo 与品牌色)
  items: AudioRow[];           // 已下载的音频
  importRow: ImportSource | null; // 解析时落库的来源行(拿封面 + 总集数);来源被删了就是 null
  latest: string;              // 最近入库时间
}
/** 「已下 N 集 / 共 M 集」文案;单条作品/无来源记录各有说法 */
function workCountText(w: WorkGroup): string {
  if (w.importRow === null) return `已下 ${w.items.length} 条`;
  if (w.importRow.kind === 'single') return `${w.items.length} 条`;
  return `已下 ${w.items.length} 集 / 共 ${w.importRow.entry_count} 集`;
}

/** 作品聚合卡片:封面(没图退纯色底 + 平台 logo)+ 作品名 + 已下/共集数 + 细进度条 + 最近入库 */
function WorkCard({ work, onOpen }: { work: WorkGroup; onOpen: () => void }) {
  const [coverBroken, setCoverBroken] = useState(false);
  const [coverLoaded, setCoverLoaded] = useState(false);
  const imp = work.importRow;
  // 是否渲染 <img>:有来源记录就试——本地有图秒出;没有的话服务端会现拿(可能要先单独问一次 yt-dlp,首次几秒后出图);
  // 真拿不到 → onError → 回退纯色卡片。**不要用 has_cover 当开关**:那样"还没图的来源"永远没机会去拿图
  const showCover = imp !== null && !coverBroken;
  const tint = siteColor(work.site);
  const total = imp === null || imp.kind === 'single' ? null : imp.entry_count;
  return (
    <div
      className="sct-card"
      role="button"
      tabIndex={0}
      aria-label={work.title}
      onClick={onOpen}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } }}
      style={{ border: '1px solid #f0f0f0', borderRadius: 10, background: '#fff', overflow: 'hidden', cursor: 'pointer', display: 'flex', flexDirection: 'column' }}
    >
      {/* 封面区:固定 16:9 占位,图从透明淡入——避免图片加载完成时把整行卡片顶一下 */}
      <div style={{ position: 'relative', aspectRatio: '16 / 9', background: tint.bg, overflow: 'hidden' }}>
        {showCover ? (
          <img
            src={coverUrl(imp.id)}
            alt=""
            onError={() => setCoverBroken(true)}
            onLoad={() => setCoverLoaded(true)}
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block', opacity: coverLoaded ? 1 : 0, transition: 'opacity 200ms cubic-bezier(0.23, 1, 0.32, 1)' }}
          />
        ) : (
          <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <SiteLogo site={work.site} size={44} />
          </div>
        )}
        {/* 平台角标:封面上的白 logo 会看不见,垫一层半透明黑底 */}
        <span style={{ position: 'absolute', left: 8, top: 8, display: 'flex', background: 'rgba(0, 0, 0, 0.45)', borderRadius: 6, padding: 3 }}>
          <SiteLogo site={work.site} size={14} />
        </span>
      </div>
      <div style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 4 }}>
        <Typography.Text strong ellipsis={{ tooltip: work.title }} style={{ minWidth: 0 }}>{work.title}</Typography.Text>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>{workCountText(work)}</Typography.Text>
        {total !== null && total > 0 && (
          <Progress percent={Math.min(100, Math.round((work.items.length / total) * 100))} showInfo={false} size="small" strokeColor={tint.fg} />
        )}
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>最近入库 {work.latest}</Typography.Text>
      </div>
    </div>
  );
}

type ViewKind = 'flat' | 'group';

export default function LibraryPage() {
  const [items, setItems] = useState<AudioRow[]>([]);
  const [imports, setImports] = useState<ImportSource[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [view, setView] = useState<ViewKind>('flat');
  const [openKey, setOpenKey] = useState<string | null>(null); // 进入了哪个作品(用来源网址当 key)
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const audioRefs = useRef<Map<number, HTMLAudioElement | null>>(new Map());

  // 列表拉取收口成 load():挂载时拉一次,之后两个时机自动重拉——
  //   ① 下载入库完成时的进程内通知(用户很可能正开着这一页等新文件);
  //   ② 窗口重新可见 / 重新获得焦点(例如另开窗口把文件下完再切回来,或①的通知没送到)。
  // 2026-09-29 用户反馈「下载结束后点音频库,刚下的文件不在列表里」——根因就是缺这两个时机:
  // 切页那一下确实拉过列表,但后端 rename+ffprobe+INSERT 比它晚几秒(实测差 4 秒),此后页面不再刷新。
  // 导入来源一起拉:分组视图要拿它算「共 N 集」和封面。
  useEffect(() => {
    const load = (): void => {
      void Promise.all([apiGet<AudioRow[]>('/api/audio'), listImports()])
        .then(([rows, imps]) => { setItems(rows); setImports(imps); })
        .catch((e: Error) => setError(e.message));
    };
    load();
    const off = onAudioChanged(load);
    const onVisible = (): void => { if (document.visibilityState === 'visible') load(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', load);
    return () => {
      off();
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', load);
    };
  }, []);

  // 2026-09-29:删除按钮 → antd Modal.confirm 弹窗(用户拍板);
  // 先把对应行的 <audio> 暂停并清 src,避免删除瞬间 audio 还在请求 /api/audio/:id/file(range 请求 404 噪声)
  const onDelete = (id: number, title: string) => {
    Modal.confirm({
      title: `删除《${title}》?`,
      content: '此操作会同时删除音频文件和数据库记录,不可恢复。',
      okText: '删除',
      okType: 'danger',
      cancelText: '取消',
      onOk: async () => {
        // 先停播放,再调接口(2026-09-29 用户体感优化 + 日志去噪声)
        const a = audioRefs.current.get(id);
        if (a) { a.pause(); a.removeAttribute('src'); a.load(); }
        logFe('info', `删除请求 id=${id} title=${title.slice(0, 60)}`);
        try {
          await deleteAudio(id);
          setItems((prev) => prev.filter((it) => it.id !== id)); // 本地移除,避免再拉一次列表
          logFe('info', `删除完成 id=${id}`);
        } catch (e) {
          // 失败保留行(让用户看到原列表,可重试)
          logFe('error', `删除失败 id=${id}: ${(e as Error).message}`);
          throw e; // 让 Modal 显示原生错误
        }
      },
    });
  };

  // 按来源网址聚合成作品(2026-09-29 用户拍板)。刻意按网址而不是按名字:同名作品不会错并,
  // 单视频也各自成卡;代价是同一作品被两种网址变体下载过会分成两张卡(取语义正确优先)。
  const works: WorkGroup[] = (() => {
    const byUrl = new Map(imports.map((i) => [i.url, i]));
    const map = new Map<string, WorkGroup>();
    for (const it of items) {
      const key = it.source_url ?? `#item-${it.id}`;
      const cur = map.get(key);
      if (cur) {
        cur.items.push(it);
        if (it.created_at > cur.latest) cur.latest = it.created_at;
      } else {
        map.set(key, { key, title: mainTitle(it), site: it.site, items: [it], importRow: byUrl.get(key) ?? null, latest: it.created_at });
      }
    }
    return [...map.values()].sort((a, b) => (a.latest < b.latest ? 1 : -1)); // 最近入库在前
  })();

  // 搜索:平铺层按条匹配;分组层按作品名或任意一集匹配;进入作品后只搜这一部
  const q = query.trim().toLowerCase();
  const matches = (it: AudioRow): boolean => q === '' || `${mainTitle(it)} ${it.title} ${it.entry_index ?? ''}`.toLowerCase().includes(q);
  const flatRows = items.filter(matches);
  const shownWorks = works.filter((w) => q === '' || w.title.toLowerCase().includes(q) || w.items.some(matches));
  const openWork = openKey === null ? null : works.find((w) => w.key === openKey) ?? null;
  const openRows = openWork === null ? [] : openWork.items.filter(matches);

  const cardLevel = view === 'group' && openWork === null; // 卡片墙层
  const total = cardLevel ? shownWorks.length : openWork === null ? flatRows.length : openRows.length;
  const maxPage = Math.max(1, Math.ceil(total / pageSize)); // 页码渲染期收敛:搜索/删除后越界不出现空白页
  const safePage = Math.min(page, maxPage);
  const from = (safePage - 1) * pageSize;
  const pageWorks = cardLevel ? shownWorks.slice(from, from + pageSize) : [];
  const pageRows = cardLevel ? [] : (openWork === null ? flatRows : openRows).slice(from, from + pageSize);

  const switchView = (v: ViewKind): void => { setView(v); setOpenKey(null); setPage(1); };
  const openCard = (key: string): void => { setOpenKey(key); setPage(1); };
  const backToCards = (): void => { setOpenKey(null); setPage(1); };

  const emptyNode = (
    <Empty
      description={
        items.length === 0 ? '暂无音频,先去获取页下载吧'
          : cardLevel ? `没有匹配「${query.trim()}」的作品`
            : `没有匹配「${query.trim()}」的音频`
      }
      style={{ marginTop: 64 }}
    />
  );

  /** 平铺层/作品内的同一条行 UI(播放器、原视频、删除都在这一行) */
  const renderRow = (it: AudioRow) => (
    <div
      key={it.id}
      style={{ border: '1px solid #f0f0f0', borderRadius: 8, padding: '12px 16px', marginBottom: 8, display: 'flex', flexDirection: 'column', gap: 8 }}
    >
      {/* 第 1 行:平台 logo + 名称 + 第几集 + 该集名字 + 格式/时长/入库时间 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <SiteLogo site={it.site} size={18} />
        <Typography.Text strong ellipsis={{ tooltip: mainTitle(it) }} style={{ maxWidth: 420, minWidth: 0 }}>
          {mainTitle(it)}
        </Typography.Text>
        {episodeTag(it) !== null && <Tag color="blue" style={{ marginInlineEnd: 0 }}>{episodeTag(it)}</Tag>}
        {episodeTitle(it) !== null && (
          <Typography.Text type="secondary" ellipsis={{ tooltip: episodeTitle(it) ?? '' }} style={{ maxWidth: 320, minWidth: 0 }}>
            {episodeTitle(it)}
          </Typography.Text>
        )}
        <Typography.Text type="secondary" style={{ fontSize: 12, marginInlineStart: 'auto' }}>
          {it.format} · {it.duration_sec ? formatDuration(it.duration_sec) : '时长未知'} · {it.created_at}
        </Typography.Text>
      </div>
      {/* 第 2 行:原视频地址 + 播放器 + 删除;窄窗自动折行,地址过长省略号 + 悬停看全文 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        {it.source_url !== null && it.source_url !== '' && (
          <a
            href={it.source_url}
            target="_blank"
            rel="noreferrer"
            title={it.source_url}
            style={{ flex: '0 1 360px', minWidth: 160, fontSize: 12, color: '#1677ff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          >
            原视频:{it.source_url}
          </a>
        )}
        <audio ref={(el) => { audioRefs.current.set(it.id, el); }} controls src={audioFileUrl(it.id)} style={{ flex: '1 1 280px', minWidth: 220 }} />
        <Button danger size="small" onClick={() => onDelete(it.id, mainTitle(it))}>删除</Button>
      </div>
    </div>
  );

  if (error) return <Typography.Text type="danger">{error}</Typography.Text>;
  return (
    <div style={{ boxSizing: 'border-box', height: '100%', minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column', padding: 16, gap: 12 }}>
      {/* 头:搜索框 + 视图切换(用户拍板:切换器在搜索栏右侧);进了作品就换成「返回分组」 */}
      <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        {openWork !== null && <Button icon={<ArrowLeftOutlined />} onClick={backToCards}>返回分组</Button>}
        <Input
          allowClear
          prefix={<SearchOutlined />}
          placeholder={openWork !== null ? '搜索这一部的集名' : '搜索作品名 / 音频名'}
          value={query}
          onChange={(e) => { setQuery(e.target.value); setPage(1); }}
          style={{ flex: '0 1 320px', minWidth: 180, maxWidth: 420 }}
        />
        {openWork === null && (
          <Segmented
            value={view}
            onChange={(v) => switchView(v as ViewKind)}
            options={[
              { value: 'flat', label: '平铺', icon: <UnorderedListOutlined /> },
              { value: 'group', label: '剧集分组', icon: <AppstoreOutlined /> },
            ]}
          />
        )}
        <Typography.Text type="secondary">
          {cardLevel ? `共 ${shownWorks.length} 部` : `共 ${total} 条`}
          {q !== '' ? `(全部 ${cardLevel ? works.length : items.length} ${cardLevel ? '部' : '条'})` : ''}
        </Typography.Text>
      </div>

      {/* 进了作品:一行作品信息(平台 logo + 作品名 + 已下/共),让用户清楚"现在在看哪一部" */}
      {openWork !== null && (
        <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <SiteLogo site={openWork.site} size={20} />
          <Typography.Text strong ellipsis={{ tooltip: openWork.title }} style={{ maxWidth: 480, minWidth: 0 }}>{openWork.title}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>{workCountText(openWork)}</Typography.Text>
        </div>
      )}

      {/* 身:自己滚(上下自适应)。key 让「切视图 / 进作品 / 返回」时重新挂载 → 触发一次淡入,
          同一层内翻页/搜索不重播(那种高频动作不该有动效) */}
      <div
        key={cardLevel ? 'cards' : openWork === null ? 'flat' : `work-${openWork.key}`}
        className="sct-view-enter"
        style={{ boxSizing: 'border-box', flex: 1, minHeight: 0, overflowY: 'auto', paddingRight: 4 }}
      >
        {items.length === 0 ? emptyNode : cardLevel ? (
          pageWorks.length === 0 ? emptyNode : (
            /* 卡片墙:auto-fill + 最小宽 —— 窗口宽了自动加列;整块居中限宽,超宽屏不把卡片拉成巨幅 */
            <div style={{ display: 'grid', gridTemplateColumns: `repeat(auto-fill, minmax(${CARD_MIN_WIDTH}px, 1fr))`, gap: 12, width: '100%', maxWidth: CARDS_MAX_WIDTH, margin: '0 auto' }}>
              {pageWorks.map((w) => <WorkCard key={w.key} work={w} onOpen={() => openCard(w.key)} />)}
            </div>
          )
        ) : pageRows.length === 0 ? emptyNode : (
          /* 列表:整块居中限宽,超宽屏上播放器/文字不横跨整屏 */
          <div style={{ width: '100%', maxWidth: CARDS_MAX_WIDTH, minWidth: 0, margin: '0 auto' }}>
            {pageRows.map(renderRow)}
          </div>
        )}
      </div>

      {/* 脚:分页固定在底部(列表滚它不滚) */}
      <div style={{ flexShrink: 0, display: 'flex', justifyContent: 'center' }}>
        <Pagination
          current={safePage}
          pageSize={pageSize}
          total={total}
          showSizeChanger
          pageSizeOptions={PAGE_SIZE_OPTIONS}
          showTotal={(t) => (cardLevel ? `共 ${t} 部作品` : `共 ${t} 条`)}
          onChange={(p, ps) => { setPage(p); setPageSize(ps); }}
        />
      </div>
    </div>
  );
}
