import { Alert, Card, Spin, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { apiGet, logFe } from '@/api';

interface Health {
  ok: boolean;
  sqlite: string | null;
  port: number;
}

export default function IndexPage() {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // 诊断日志:页面打开 / 离开都要留痕——「看不到健康状态」时区分是没请求还是请求挂了
    logFe('info', 'IndexPage mounted → GET /api/health');
    apiGet<Health>('/api/health').then(setHealth).catch((e: Error) => setError(e.message));
  }, []);

  // 按真实字段判定,而非无条件印成功
  const ok = health !== null && health.ok === true && health.sqlite !== null;

  return (
    /* 首页自管滚动(spec D3):根容器锁死高度,超出的部分由内部这层滚 */
    <div style={{ height: '100%', minHeight: 0, overflowY: 'auto', padding: 16 }}>
      <Card title="首页">
        {error && <Alert type="error" showIcon message="无法连接本地服务" description={error} />}
        {!error && !health && <Spin />}
        {!error && health && ok && (
          <Typography.Text>
            后端 OK · SQLite 读写成功 · API 端口 {health.port}
          </Typography.Text>
        )}
        {!error && health && !ok && (
          <Alert
            type="error"
            showIcon
            message="后端异常"
            description={`health.ok=${String(health.ok)}, sqlite=${String(health.sqlite)}`}
          />
        )}
      </Card>
    </div>
  );
}
