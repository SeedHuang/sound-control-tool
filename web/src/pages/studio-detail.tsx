// web/src/pages/studio-detail.tsx
// 剪辑详情页 —— P1 只放占位(spec m2-workspace §0.5:P4 才实现时间轴/多段/保存/导出)。
// 之所以 P1 就建它:导航高亮与路由结构先立起来,后面 P4 只往这个文件里填。
import { Button, Empty } from 'antd';
import { useNavigate, useParams } from '@umijs/max';
import PageHeader from '@/components/PageHeader';

export default function StudioDetailPage() {
  const { importId } = useParams<{ importId: string }>();
  const navigate = useNavigate();
  return (
    <div style={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <PageHeader
        title={`剪辑详情（来源 #${importId ?? '?'}）`}
        meta="P4 实现"
        toolbar={<Button onClick={() => navigate('/studio')}>返回剪辑室</Button>}
      />
      <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Empty description="剪辑工作台将在 P4 落地（时间轴 + 多剪辑点 + 保存 + 导出）" />
      </div>
    </div>
  );
}
