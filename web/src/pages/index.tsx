import { Alert, Button, Card, Space, Spin, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { apiGet } from '@/api';

interface Health {
  ok: boolean;
  sqlite: string | null;
  port: number;
}

export default function IndexPage() {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiGet<Health>('/api/health').then(setHealth).catch((e: Error) => setError(e.message));
  }, []);

  // 按真实字段判定,而非无条件印成功
  const ok = health !== null && health.ok === true && health.sqlite !== null;

  return (
    <>
      <Card title="音频库(骨架)" style={{ margin: 16 }}>
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
    <Space style={{ marginTop: 16 }}>
      <Button type="primary" onClick={() => (window.location.hash = '#/acquire')}>去获取</Button>
      <Button onClick={() => (window.location.hash = '#/library')}>去音频库</Button>
    </Space>
    </>
  );
}
