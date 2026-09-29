// web/src/pages/library.tsx(音频库 2026-09-29 用户拍板重构)
// 用户提的三件事:① 每行要有「音频名 + 第几集 + 该集自己的名字」;② 要能按名字搜索;③ 要分页。
// 追加:显示原视频地址 + 视频平台 logo;内容区要上下左右都自适应(窗口大小变化不出现横向溢出/大片空白)。
// 布局与获取页同款:整页锁死内容区高度 —— 头(搜索/计数)、身(列表,自己滚)、脚(分页)三段;
// 行内 flexWrap + maxWidth,窄窗自动折行。
import { Button, Empty, Input, Modal, Pagination, Tag, Typography } from 'antd';
import { SearchOutlined } from '@ant-design/icons';
import { useEffect, useMemo, useRef, useState } from 'react';
import { apiGet, audioFileUrl, deleteAudio, logFe, type AudioRow } from '@/api';
import SiteLogo from '@/components/SiteLogo';

const PAGE_SIZE_OPTIONS = ['10', '20', '50'];

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

export default function LibraryPage() {
  const [items, setItems] = useState<AudioRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const audioRefs = useRef<Map<number, HTMLAudioElement | null>>(new Map());
  useEffect(() => {
    apiGet<AudioRow[]>('/api/audio').then(setItems).catch((e: Error) => setError(e.message));
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

  // 按名字搜索(合集名 / 音频名 / 集数都参与匹配)——本地过滤,输入即响应
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q === '') return items;
    return items.filter((it) => `${mainTitle(it)} ${it.title} ${it.entry_index ?? ''}`.toLowerCase().includes(q));
  }, [items, query]);
  // 页码在渲染期收敛:搜索/删除后当前页可能越界,直接算给分页器和切片用,不出现空白页
  const maxPage = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, maxPage);
  const pageItems = filtered.slice((safePage - 1) * pageSize, safePage * pageSize);

  if (error) return <Typography.Text type="danger">{error}</Typography.Text>;
  return (
    /* 高度锁死为布局内容区高度、overflow hidden:滚动全部收敛到内部列表。
       boxSizing: border-box 必须写(2026-09-29 实测修复):本项目没有全局 reset,div 默认是 content-box,
       height:100% + padding:16 会让这一层比外框高 32px → 外框出现滚动条、分页被顶到屏幕外(双滚动条)。
       实测数据:内容区 clientHeight=778,本层 scrollHeight=810,差的就是这 32px 内边距。 */
    <div style={{ boxSizing: 'border-box', height: '100%', minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column', padding: 16, gap: 12 }}>
      {/* 头:搜索框(左)+ 计数(右);窄窗自动折行 */}
      <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <Input
          allowClear
          prefix={<SearchOutlined />}
          placeholder="搜索音频名 / 合集名"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setPage(1); }}
          style={{ flex: '0 1 320px', minWidth: 180, maxWidth: 420 }}
        />
        <Typography.Text type="secondary">
          共 {filtered.length} 条{query.trim() !== '' ? `(全部 ${items.length} 条)` : ''}
        </Typography.Text>
      </div>

      {/* 身:列表区自己滚(上下自适应);行内 flexWrap(左右自适应)。
          boxSizing: border-box 同上——否则 padding-right:4 会把这一层撑宽 4px,滚动条被父层裁掉半截 */}
      <div style={{ boxSizing: 'border-box', flex: 1, minHeight: 0, overflowY: 'auto', paddingRight: 4 }}>
        {items.length === 0 ? (
          <Empty description="暂无音频,先去获取页下载吧" style={{ marginTop: 64 }} />
        ) : pageItems.length === 0 ? (
          <Empty description={`没有匹配「${query.trim()}」的音频`} style={{ marginTop: 64 }} />
        ) : (
          pageItems.map((it) => (
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
          ))
        )}
      </div>

      {/* 脚:分页固定在底部(列表滚它不滚) */}
      <div style={{ flexShrink: 0, display: 'flex', justifyContent: 'flex-end' }}>
        <Pagination
          current={safePage}
          pageSize={pageSize}
          total={filtered.length}
          showSizeChanger
          pageSizeOptions={PAGE_SIZE_OPTIONS}
          showTotal={(t) => `共 ${t} 条`}
          onChange={(p, ps) => { setPage(p); setPageSize(ps); }}
        />
      </div>
    </div>
  );
}
