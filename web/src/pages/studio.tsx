// web/src/pages/studio.tsx(剪辑室)
// 2026-09-29 用户拍板:列表 + 名称搜索 + 分页 + 平台 logo + 原视频地址 + 剧集「第几集/该集名字」;
// 又在搜索栏右侧加了「视图切换」:平铺(逐条列表)/ 剧集分组(作品聚合卡片墙,点卡片进该作品自己的音频列表)。
// 2026-09-30 P3-T2:改造成「以来源驱动的媒体中心」——根因是老逻辑只列 audio_items,
//   用户「下载了视频素材但还没剪出音频」时剪辑室一片空白;现在列表由 /api/imports(全量来源)∪ 孤儿音频驱动,
//   只有视频、没有音频的来源也会出现一张媒体卡(封面 + 标题 + 素材状态 + 音频数 + 编辑入口)。
// 布局与资料库同款:整页锁死内容区高度 —— 头(搜索/切换/计数)、身(自己滚)、脚(分页)三段;
// 行内 flexWrap + maxWidth,窄窗自动折行。
// 注意:本项目没有全局 reset,div 默认 content-box —— 凡「height:100% + padding」的这一层都要 boxSizing: border-box,
// 否则会比外框高出内边距那几像素、外框出现滚动条(2026-09-29 实测踩过:内容区 778 vs 本层 810)。
import { Button, Empty, Input, Modal, Pagination, Progress, Segmented, Tag, Tooltip, Typography } from 'antd';
import { AppstoreOutlined, ArrowLeftOutlined, SearchOutlined, UnorderedListOutlined } from '@ant-design/icons';
import { useNavigate } from '@umijs/max';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { apiGet, audioFileUrl, coverUrl, deleteAudio, listImports, logFe, onAudioChanged, type AudioRow, type ImportSource } from '@/api';
import SiteLogo, { siteColor } from '@/components/SiteLogo';

const PAGE_SIZE_OPTIONS = ['10', '20', '50'];
const CARD_MIN_WIDTH = 190;   // 卡片最小宽:窗口越宽列数越多(auto-fill),不是把列数写死
const CARDS_MAX_WIDTH = 1160; // 内容区最大宽:超宽屏上整块居中,不让卡片/正文被拉成巨幅

/** 主名:合集条目显示合集名(用户心里的「这张专辑」),单视频/录制显示自身标题 */
function mainTitle(it: AudioRow): string {
  return it.collection_title ?? it.title;
}
/** 摘掉服务端强制拼的尾部时间码后缀(…… [00:08-00:34] → ……)。
 *  用途:孤儿卡(源已删除/无来源)没有来源标题可挂,只能从条目名推作品名——带时间码的名字不是作品名。
 *  分钟可到三位(如 [120:00-121:30]),故 \d{2,};(格式来源:server/src/media/clip-job.ts 的 formatClipTitle) */
const CLIP_SUFFIX = / \[\d{2,}:\d{2}-\d{2,}:\d{2}\]$/;
function stripClipSuffix(s: string): string { return s.replace(CLIP_SUFFIX, '').trim(); }
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

/** 一个「作品」= 同一来源下的全部入库音频(番剧/课程/合集)。没有来源的(录制 + 历史遗留)收进一张「无来源」卡 */
interface WorkGroup {
  key: string;                 // 来源外键 'src:<importId>';无来源卡固定 'none'
  title: string;               // 作品名;孤儿卡取首条主名去掉时间码后缀
  site: string;                // 平台(算 logo 与品牌色)
  items: AudioRow[];           // 该组音频(来源卡可能为空:有视频素材但还没导出成品)
  importRow: ImportSource | null; // 来源行;来源已删(悬空)/无来源 → null
  latest: string;              // 最近入库时间(该组音频最大 created_at;无音频时退来源创建的 created_at)
  orphan: 'deleted' | 'none' | null; // null=正常来源卡;'deleted'=来源行已删(PRD FR-3.7「源已删除」);'none'=从来没有来源
  noLogo: boolean;             // 无来源卡且组内平台不唯一 → 不画平台 logo(画了就是瞎指一个平台)
}
/** 卡片计数(spec audio-lineage D9):成品(source_type=edit)/ 素材(下载/录制原料)分开数。
 *  来源卡额外保留「已下 N 集 / 共 M 集」(沿用改造前口径:N 取该来源下的音频条数,本 spec 不改它的语义)。 */
function workCountText(w: WorkGroup): string {
  const products = w.items.filter((i) => i.source_type === 'edit').length;
  const materials = w.items.length - products;
  const parts: string[] = [];
  if (materials > 0) parts.push(`素材 ${materials} 条`);
  parts.push(`成品 ${products} 条`);
  if (w.importRow !== null && w.importRow.kind === 'playlist') {
    parts.push(`已下 ${w.items.length} 集 / 共 ${w.importRow.entry_count} 集`);
  }
  return parts.join(' · ');
}

/** 作品聚合卡片:封面(没图退纯色底 + 平台 logo)+ 作品名 + 已下/共集数 + 素材状态 + 细进度条 + 最近入库 + 编辑入口 */
function WorkCard({ work, onOpen }: { work: WorkGroup; onOpen: () => void }) {
  const navigate = useNavigate();
  const [coverBroken, setCoverBroken] = useState(false);
  const [coverLoaded, setCoverLoaded] = useState(false);
  const imp = work.importRow;
  // 是否渲染 <img>:有来源记录就试——本地有图秒出;没有的话服务端会现拿(可能要先单独问一次 yt-dlp,首次几秒后出图);
  // 真拿不到 → onError → 回退纯色卡片。**不要用 has_cover 当开关**:那样"还没图的来源"永远没机会去拿图
  const showCover = imp !== null && !coverBroken;
  const tint = siteColor(work.site);
  const total = imp === null || imp.kind === 'single' ? null : imp.entry_count;
  // 素材状态(D17):有视频素材才显示「素材:第 N 集」/「素材:集数未知」;没素材就不加这个标记
  // (不加比加个"素材:无"更有辨识度——没标记=还没下视频,一眼能看出来)
  const materialText = imp !== null && imp.has_video
    ? (imp.material_entry_index !== null ? `素材:第 ${imp.material_entry_index} 集` : '素材:集数未知')
    : null;
  // 编辑入口(验收②):有素材才可点 → 进 /studio/:importId(P4 编辑器接手);
  // 无素材(has_video=false)/ 孤儿来源(importRow=null)一律禁用 + tooltip 说明原因。
  // disabled 的原生 button 不触发鼠标事件 → Tooltip 收不到,必须垫一层 <span> 才能悬停出提示。
  const editNode = imp !== null && imp.has_video ? (
    <Button
      size="small"
      type="primary"
      onClick={(e) => {
        e.stopPropagation(); // 别把点击冒泡给整张卡(那会变成"打开该来源的音频列表")
        logFe('info', `进入剪辑详情 import=${imp.id}`);
        navigate(`/studio/${imp.id}`); // Umi 纪律:用 useNavigate,不走 window.location.hash
      }}
    >
      编辑
    </Button>
  ) : (
    <Tooltip title={imp === null ? '未关联来源,无法进入剪辑' : '这个来源还没有视频素材,先去资料库下视频'}>
      <span style={{ display: 'inline-block' }}>
        <Button size="small" disabled>编辑</Button>
      </span>
    </Tooltip>
  );
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
            {/* 无来源卡且组内平台不唯一 → 不画 logo(画了就是瞎指一个平台) */}
            {!work.noLogo && <SiteLogo site={work.site} size={44} />}
          </div>
        )}
        {/* 平台角标:封面上的白 logo 会看不见,垫一层半透明黑底 */}
        {!work.noLogo && (
          <span style={{ position: 'absolute', left: 8, top: 8, display: 'flex', background: 'rgba(0, 0, 0, 0.45)', borderRadius: 6, padding: 3 }}>
            <SiteLogo site={work.site} size={14} />
          </span>
        )}
      </div>
      <div style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 4 }}>
        <Typography.Text strong ellipsis={{ tooltip: work.title }} style={{ minWidth: 0 }}>{work.title}</Typography.Text>
        {/* 音频数(workCountText)+ 素材状态同一行;不再另叠一个重复的音频数文案 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>{workCountText(work)}</Typography.Text>
          {materialText !== null && <Tag color="green" style={{ marginInlineEnd: 0 }}>{materialText}</Tag>}
          {/* PRD FR-3.7:来源被删后产物仍在,这里明确告诉用户"源没了" */}
          {work.orphan === 'deleted' && <Tag color="red" style={{ marginInlineEnd: 0 }}>源已删除</Tag>}
        </div>
        {total !== null && total > 0 && (
          <Progress percent={Math.min(100, Math.round((work.items.length / total) * 100))} showInfo={false} size="small" strokeColor={tint.fg} />
        )}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>最近入库 {work.latest}</Typography.Text>
          {editNode}
        </div>
      </div>
    </div>
  );
}

/** 卡内分组标题(spec audio-lineage D9):素材(下载/录制的原料)在前、成品(剪辑/导出)在后 */
function GroupHeader({ label, count }: { label: string; count: number }) {
  return (
    <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', margin: '4px 0 8px' }}>
      {label} {count}
    </Typography.Text>
  );
}

type ViewKind = 'flat' | 'group';

export default function StudioPage() {
  const navigate = useNavigate(); // 「编辑」入口 + 空态「去资料库」用;Umi 纪律:走 useNavigate 而非 window.location.hash
  const [items, setItems] = useState<AudioRow[]>([]);
  const [imports, setImports] = useState<ImportSource[]>([]);
  // 「来源列表是否可信」(2026-10-01 终审 I-1):音频与来源是两个分开发的请求(音频通常先到),
  // 分组时要靠它决定能不能判"悬空"。用三态而非布尔 —— 因为失败也**不能**判悬空:不知道 ≠ 没有了。
  // 若把失败当"来源列表确实为空",带外键的成品会被断言成「源已删除」(假事实),用户可能据此误删;
  // 而失败只是"这一次没问到",下一次 load 成功就自愈(布尔方案在 .finally 里成功失败都置真,正是把失败压成假的"可信")。
  // loading=请求还没回来 / ok=拿到了、可信 / failed=请求失败、不可信
  const [importsState, setImportsState] = useState<'loading' | 'ok' | 'failed'>('loading');
  // 音频请求是否已 settle(2026-10-01 OCR 审查 F7):音频与来源是两个分开发的请求。
  // 若**来源先到、音频后到**(或音频请求失败),items 还是 [] → D13 那条分组日志会先打一行错的
  // "源已删除 0 张、无来源 0 条" —— 而这行正是用户验收时要照抄核对的,属于"日志不诚实"。
  // 与 importsState 同款三态:loading=还没回来 / ok=拿到 / failed=失败(失败也算 settle,但那时数据不可信)。
  const [audioState, setAudioState] = useState<'loading' | 'ok' | 'failed'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  // 默认「剧集分组」(D12 要求;Ruling P3-2):媒体卡墙是这一页的主体,平铺作为可选项保留
  const [view, setView] = useState<ViewKind>('group');
  const [openKey, setOpenKey] = useState<string | null>(null); // 进入了哪个作品(key = WorkGroup.key:`src:<importId>` 或 'none')
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const audioRefs = useRef<Map<number, HTMLAudioElement | null>>(new Map());

  // 列表拉取收口成 load():挂载时拉一次,之后两个时机自动重拉——
  //   ① 下载入库完成时的进程内通知(用户很可能正开着这一页等新文件);
  //   ② 窗口重新可见 / 重新获得焦点(例如另开窗口把文件下完再切回来,或①的通知没送到)。
  // 2026-09-29 用户反馈「下载结束后点剪辑室,刚下的文件不在列表里」——根因就是缺这两个时机:
  // 切页那一下确实拉过列表,但后端 rename+ffprobe+INSERT 比它晚几秒(实测差 4 秒),此后页面不再刷新。
  // 导入来源一起拉:分组视图要拿它算「共 N 集」和封面。
  useEffect(() => {
    const load = (): void => {
      // 两个请求分开发(2026-09-29 评审修):原来用 Promise.all 绑死 —— 导入来源只是用来算「共 N 集」和
      // 取封面,它失败不该把已经拿到的主列表一起丢掉(整页只剩错误文字)。
      apiGet<AudioRow[]>('/api/audio')
        // 成功必须清 error:否则一次瞬时失败(切回窗口那一下超时之类)会把整页**永久**钉在错误文字上,
        // 后面的自动刷新即使成功也照样白屏(2026-09-29 评审修)。同时置 audioState(F7):settle 才允许打分组日志
        .then((rows) => { setItems(rows); setError(null); setAudioState('ok'); })
        .catch((e: Error) => { setError(e.message); setAudioState('failed'); });
      void listImports()
        .then((rows) => { setImports(rows); setImportsState('ok'); })
        // 保留原有错误日志;并置 failed —— 失败时来源列表**不可信**,分组不得据此判"源已删除"
        .catch((e: Error) => {
          logFe('error', `拉取导入来源失败(不影响音频列表): ${e.message}`);
          setImportsState('failed');
        });
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

  // 诊断日志(spec audio-lineage D13):分组结果留痕 —— "几张来源卡 / 几张孤儿卡"是这次改造最容易出错的地方
  useEffect(() => {
    // 来源列表未到齐**或请求失败**都不打这一行(2026-10-01 终审 I-1):否则会先打一行错的分组结果
    // (来源卡 0 张、源已删除 N 张),而验收正让用户照这行日志核对——错的那行会被当成"本该如此"
    if (importsState !== 'ok') return;
    // 音频请求也必须 settle(F7):否则"来源先到、音频后到"时会先打一行 "源已删除 0 张、无来源 0 条"(错的)。
    // 失败也算 settle(不再 loading),但那时 items 不可信 —— 这一行只是诊断留痕,不据此做任何破坏性判断。
    if (audioState === 'loading') return;
    if (items.length === 0 && imports.length === 0) return;
    const live = new Set(imports.map((i) => i.id));
    // 用 == null 而不是 !== null(2026-10-01 终审 I-4):字段缺失(undefined)不算悬空 id,免得并进"源已删除"
    const dangling = new Set(items.map((i) => i.source_import_id).filter((v): v is number => v != null && !live.has(v)));
    // 同理用 == null:undefined 也要算「无来源」,不被漏掉
    const noSource = items.filter((i) => i.source_import_id == null).length;
    logFe('info', `剪辑室分组:来源卡 ${imports.length} 张、源已删除 ${dangling.size} 张、无来源 ${noSource} 条`);
  }, [items, imports, importsState, audioState]);

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

  // 剪辑室(P3-T2 → 2026-10-01 血缘改造):列表**由来源驱动** ∪ 孤儿音频。
  // 归并键换成 source_import_id(spec audio-lineage D6)——旧的"按 source_url 字符串相等"不构成血缘:
  // 导出产物从不写 source_url(恒为空串),于是同一个视频剪出的 8 个片段在 dev 库里散成 8 张碎卡(实测)。
  // 三类卡:① 来源卡(来源行在) ② 「源已删除」卡(有外键但来源行已删,按 id 各自成卡,D8)
  //        ③ 一张「无来源」卡(外键为 null:录制 + 历史遗留,D7)
  const works: WorkGroup[] = (() => {
    const map = new Map<string, WorkGroup>();
    // ① 来源先建卡:latest 先用来源创建时间兜底(该来源还没音频时,排序键就是它)
    for (const imp of imports) {
      map.set(`src:${imp.id}`, {
        key: `src:${imp.id}`, title: imp.title, site: imp.site, items: [], importRow: imp,
        latest: imp.created_at, orphan: null, noLogo: false,
      });
    }
    // ② 音频按外键挂到对应来源卡下;外键为空 → 汇总到一张「无来源」卡
    for (const it of items) {
      // 用 == null 而不是 === null(2026-10-01 终审 I-4):新前端 + 旧 server 版本错配时该字段可能缺失(undefined),
      // 严格判 null 会漏掉它 → 并成一张 src:undefined 的卡并误标红。与 :34 附近 entry_index 的判定同一精神
      const key = it.source_import_id == null ? 'none' : `src:${it.source_import_id}`;
      const cur = map.get(key);
      if (cur !== undefined) {
        // 该组首条音频接管排序键(覆盖来源创建时间),之后取最大 —— 即「该组音频最大 created_at」
        if (cur.items.length === 0 || it.created_at > cur.latest) cur.latest = it.created_at;
        cur.items.push(it);
      } else if (key === 'none') {
        map.set('none', {
          key: 'none', title: '无来源', site: it.site, items: [it], importRow: null,
          latest: it.created_at, orphan: 'none', noLogo: false,
        });
      } else if (importsState !== 'ok') {
        // 来源列表还没回来(两个请求分开发的,音频通常先到)**或请求失败** → 一律**先不判"悬空"**:
        // 否则会闪一张假的「源已删除」卡;失败时更会永久谎报。不知道 ≠ 没有了 —— 不能对用户断言一个假事实
        // ("源已删除"会误导,甚至促成误删)。只有 importsState === 'ok'(确实拿到且可信)才敢说这个外键的来源真被删了。
        map.set(key, {
          key, title: stripClipSuffix(mainTitle(it)) || '来源', site: it.site, items: [it], importRow: null,
          latest: it.created_at, orphan: null, noLogo: false,
        });
      } else {
        // 有外键但来源行不在 map 里 = 来源已删(悬空)→ 按该 id 单独成卡,不并进「无来源」
        map.set(key, {
          key, title: '源已删除', site: it.site, items: [it], importRow: null,
          latest: it.created_at, orphan: 'deleted', noLogo: false,
        });
      }
    }
    // ③ 收口:孤儿卡的标题取首条主名去时间码后缀(带时间码的名字不是作品名);
    //    无来源卡的平台 logo 只在组内平台唯一时才画(录制与历史遗留混在一起时指不准)
    for (const w of map.values()) {
      if (w.orphan === null) continue;
      w.title = stripClipSuffix(mainTitle(w.items[0]!)) || (w.orphan === 'deleted' ? '源已删除' : '无来源');
    }
    const none = map.get('none');
    if (none !== undefined) {
      none.site = none.items[0]!.site;
      none.noLogo = new Set(none.items.map((i) => i.site)).size > 1;
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

  // 卡内按「素材 / 成品」分组(spec audio-lineage D9):只对"进入某个来源后"的那一层生效;平铺视图不分。
  // 口径用 source_type 而非标题后缀:source_type 是入库时定死的事实,标题是可变文本(能重命名)。
  const openMaterial: AudioRow[] = openWork === null ? [] : pageRows.filter((r) => r.source_type !== 'edit');
  const openProduct: AudioRow[] = openWork === null ? [] : pageRows.filter((r) => r.source_type === 'edit');

  // 「全部 N」取的是**当前这一层**的未过滤数(2026-09-29 评审修):原来一律写 items.length,
  // 进入某作品后一搜索就会显示成「共 3 条(全部 57 条)」,读起来像"这部作品有 57 集"。
  let allCount = items.length;
  if (cardLevel) allCount = works.length;
  else if (openWork !== null) allCount = openWork.items.length;

  const switchView = (v: ViewKind): void => { setView(v); setOpenKey(null); setPage(1); };
  const openCard = (key: string): void => { setOpenKey(key); setPage(1); };
  const backToCards = (): void => { setOpenKey(null); setPage(1); };

  // 整页空:既没有任何来源、也没有任何音频 —— 这是**唯一**该出现「去资料库」引导的情况(P3-T2 空态要求)
  const wholeEmptyNode = (
    <Empty description="还没有任何来源或音频,先去资料库添加吧" style={{ marginTop: 64 }}>
      <Button type="primary" onClick={() => navigate('/library')}>去资料库</Button>
    </Empty>
  );

  /** 平铺层/作品内的同一条行 UI(播放器、原视频、删除都在这一行) */
  const renderRow = (it: AudioRow) => {
    // D12:导出产物 source_url 恒为空串(不写第二份来源) → 进了来源卡就用该卡的来源网址回退显示"原视频"
    const sourceHref = (it.source_url !== null && it.source_url !== '') ? it.source_url : (openWork?.importRow?.url ?? null);
    return (
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
          {sourceHref !== null && (
            <a
              href={sourceHref}
              target="_blank"
              rel="noreferrer"
              title={sourceHref}
              style={{ flex: '0 1 360px', minWidth: 160, fontSize: 12, color: '#1677ff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            >
              原视频:{sourceHref}
            </a>
          )}
          <audio ref={(el) => { audioRefs.current.set(it.id, el); }} controls src={audioFileUrl(it.id)} style={{ flex: '1 1 280px', minWidth: 220 }} />
          <Button danger size="small" onClick={() => onDelete(it.id, mainTitle(it))}>删除</Button>
        </div>
      </div>
    );
  };

  // 正文四态(P3-T2):整页空 → 「去资料库」;卡片墙;进入某来源(零音频说明 / 搜索结果 / 音频行);平铺行。
  // 关键区分:进入的**来源**零音频时,说的是「该来源还没有音频；到剪辑详情导出成品」——不复用「先去资料库下载」,
  // 用户可能早就下了视频、只是还没剪,那句会把人误导回去重下。
  let body: ReactNode;
  if (imports.length === 0 && items.length === 0) {
    body = wholeEmptyNode;
  } else if (cardLevel) {
    body = pageWorks.length === 0
      ? <Empty description={`没有匹配「${query.trim()}」的作品`} style={{ marginTop: 64 }} />
      : (
        /* 卡片墙:auto-fill + 最小宽 —— 窗口宽了自动加列;整块居中限宽,超宽屏不把卡片拉成巨幅 */
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(auto-fill, minmax(${CARD_MIN_WIDTH}px, 1fr))`, gap: 12, width: '100%', maxWidth: CARDS_MAX_WIDTH, margin: '0 auto' }}>
          {pageWorks.map((w) => <WorkCard key={w.key} work={w} onOpen={() => openCard(w.key)} />)}
        </div>
      );
  } else if (openWork !== null && openWork.items.length === 0) {
    // 文案 2026-10-01 spec audio-lineage §0.5:音频一律从剪辑获得——原句「还没有下载音频」会把人误导回去重下
    const imp = openWork.importRow;
    body = (
      <Empty description="该来源还没有音频；到剪辑详情导出成品" style={{ marginTop: 64 }}>
        {imp !== null && <Button type="primary" onClick={() => { logFe('info', `进入剪辑详情 import=${imp.id}`); navigate(`/studio/${imp.id}`); }}>去剪辑详情</Button>}
      </Empty>
    );
  } else {
    body = pageRows.length === 0
      ? <Empty description={query.trim() === '' ? '暂无音频' : `没有匹配「${query.trim()}」的音频`} style={{ marginTop: 64 }} />
      : (
        /* 列表:整块居中限宽,超宽屏上播放器/文字不横跨整屏 */
        <div style={{ width: '100%', maxWidth: CARDS_MAX_WIDTH, minWidth: 0, margin: '0 auto' }}>
          {openWork === null ? (
            pageRows.map(renderRow) // 平铺视图:不分组的原样列表
          ) : (
            <>
              {openMaterial.length > 0 && <GroupHeader label="素材" count={openMaterial.length} />}
              {openMaterial.map(renderRow)}
              {openProduct.length > 0 && <GroupHeader label="成品" count={openProduct.length} />}
              {openProduct.map(renderRow)}
            </>
          )}
        </div>
      );
  }

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
          {q !== '' ? `(全部 ${allCount} ${cardLevel ? '部' : '条'})` : ''}
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
          同一层内翻页/搜索不重播(那种高频动作不该有动效)。
          paddingTop 12(2026-09-29 评审修):overflow 容器按 padding box 裁切,不留出空间的话,
          首行卡片悬停上浮的 2px 与阴影上半截会被切掉——恰好切在最想显精致的那一下。 */}
      <div
        key={cardLevel ? 'cards' : openWork === null ? 'flat' : `work-${openWork.key}`}
        className="sct-view-enter"
        style={{ boxSizing: 'border-box', flex: 1, minHeight: 0, overflowY: 'auto', paddingRight: 4, paddingTop: 12 }}
      >
        {body}
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
