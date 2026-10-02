// web/src/pages/index.tsx(首页,P5-T2 重构:仪表盘)
// 2026-09-30 用户反馈「首页只剩一句健康检查」—— 改成两块 Top3 仪表盘:正在编辑 / 最近下载;
// 健康检查挪到设置页(见 settings.tsx,「服务是否可用」属于诊断/设置场景)。
// 数据源:GET /api/home(P5-T1 已就位,editing / recent 各最多 3 条)。
// 纪律:① 不出现与导航 Tab(首页/资料库/剪辑室/设置)重名的标题;② 跳转一律走 useNavigate(hash 路由下走 Umi history)。
import { Alert, Card, Empty, Spin, Typography } from 'antd';
import { useNavigate } from '@umijs/max';
import { useEffect, useState, type ReactNode } from 'react';
import { coverUrl, getHome, logFe, type HomeEditingRow, type HomeRecentRow } from '@/api';
import SiteLogo, { siteColor } from '@/components/SiteLogo';

/** 首页卡片(封面 + 标题 + 副标题)。
 *  为什么抽成组件:每张卡的「封面是否坏掉」是各自独立的态,若在页面里用一个共享 state,一张图挂了会连累全部。
 *  封面取不到 → onError 回退纯色底 + 平台 logo,并记 debug 日志(验收⑥:回退不崩且有日志)。 */
function HomeCard({ importId, site, title, subtitle, onClick }: {
  importId: number; site: string; title: string; subtitle: string; onClick: () => void;
}) {
  const [broken, setBroken] = useState(false);
  const tint = siteColor(site);
  return (
    <div
      className="sct-card"
      role="button"
      tabIndex={0}
      aria-label={title}
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } }}
      style={{ border: '1px solid #f0f0f0', borderRadius: 10, background: '#fff', overflow: 'hidden', cursor: 'pointer', display: 'flex', flexDirection: 'column', minWidth: 0 }}
    >
      <div style={{ position: 'relative', aspectRatio: '16 / 9', background: tint.bg, overflow: 'hidden' }}>
        {broken ? (
          <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <SiteLogo site={site} size={40} />
          </div>
        ) : (
          <img
            src={coverUrl(importId)}
            alt=""
            onError={() => { setBroken(true); logFe('debug', `home cover onError import=${importId} → 回退纯色底`); }}
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          />
        )}
      </div>
      <div style={{ padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
        <Typography.Text strong ellipsis={{ tooltip: title }} style={{ minWidth: 0 }}>{title}</Typography.Text>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>{subtitle}</Typography.Text>
      </div>
    </div>
  );
}

/** 卡片网格:auto-fill + 最小宽,窗口宽了自动加列(不写死列数) */
function CardGrid({ children }: { children: ReactNode }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 12 }}>
      {children}
    </div>
  );
}

export default function IndexPage() {
  const navigate = useNavigate();
  const [editing, setEditing] = useState<HomeEditingRow[]>([]);
  const [recent, setRecent] = useState<HomeRecentRow[]>([]);
  const [loaded, setLoaded] = useState(false); // 主数据是否已返回 —— 区分「加载中」与「确实为空」
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // 诊断日志:首页打开就留痕(「首页空着」时区分是没请求、请求挂了,还是真没数据)
    logFe('info', 'IndexPage mounted → GET /api/home');
    getHome()
      .then((d) => { setEditing(d.editing); setRecent(d.recent); setError(null); })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoaded(true));
  }, []);

  return (
    /* 首页自管滚动(spec D3):根容器锁死高度,超出的部分由内部这层滚 */
    <div style={{ boxSizing: 'border-box', height: '100%', minHeight: 0, overflowY: 'auto', padding: 16 }}>
      {error !== null && (
        <Alert type="error" showIcon message="无法加载首页" description={error} style={{ marginBottom: 16 }} />
      )}
      {!loaded && error === null && <Spin />}

      {/* 错误态只显示错误(不叠两块空态,否则「拉不到数据」会被误读成「本来就没有」) */}
      {error === null && loaded && (
        <>
          {/* 正在编辑:一行 = 一件作品(1 资料 = N 作品,spec clip-works D18);点卡片进该作品的剪辑详情 /studio/:projectId。
              key 必须用 project_id —— 多件作品共享同一 import_id,用 import_id 会撞出重复 key */}
          <Card title="正在编辑" style={{ marginBottom: 16 }}>
            {editing.length === 0 ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有正在编辑的作品" />
            ) : (
              <CardGrid>
                {editing.map((row) => (
                  <HomeCard
                    key={row.project_id}
                    importId={row.import_id}
                    site={row.site}
                    title={row.name ?? '未命名作品'}
                    subtitle={`${row.segment_count} 段`}
                    onClick={() => { logFe('info', `home editing → /studio/${row.project_id}`); navigate(`/studio/${row.project_id}`); }}
                  />
                ))}
              </CardGrid>
            )}
          </Card>

          {/* 最近下载:点卡片进资料库并预选该来源 /library?id=N(资料库侧一次性预选,见 library.tsx) */}
          <Card title="最近下载">
            {recent.length === 0 ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有下载过的作品" />
            ) : (
              <CardGrid>
                {recent.map((row) => (
                  <HomeCard
                    key={row.import_id}
                    importId={row.import_id}
                    site={row.site}
                    title={row.title}
                    subtitle={row.created_at}
                    onClick={() => { logFe('info', `home recent → /library?id=${row.import_id}`); navigate(`/library?id=${row.import_id}`); }}
                  />
                ))}
              </CardGrid>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
