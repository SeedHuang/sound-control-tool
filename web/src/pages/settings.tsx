import { Alert, Button, Card, Descriptions, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { apiGet, apiPort } from '@/api';

interface BinProbe {
  path: string | null;
  version: string | null;
}
interface BinsResult {
  ytdlp: BinProbe;
  ffmpeg: BinProbe;
}

function BinCard({ title, bin, loading }: { title: string; bin: BinProbe | null; loading: boolean }) {
  // loading 由父组件显式传入(仅请求进行中为 true),不再由 bin === null 推导
  if (loading) return <Card title={title} loading style={{ marginBottom: 16 }} />;
  if (!bin) {
    return (
      <Card title={title} style={{ marginBottom: 16 }}>
        <Alert type="error" showIcon message="暂无数据" description="探测未成功。请确认本地服务可用后点击「重新探测」。" />
      </Card>
    );
  }
  if (bin.path === null) {
    return (
      <Card title={title} style={{ marginBottom: 16 }}>
        <Alert
          type="error"
          showIcon
          message="未检测到"
          description="影响:相关获取功能不可用。请确认已安装并加入 PATH,或在设置中指定完整路径。"
        />
      </Card>
    );
  }
  return (
    <Card title={title} style={{ marginBottom: 16 }}>
      <Descriptions size="small" column={1}>
        <Descriptions.Item label="路径">{bin.path}</Descriptions.Item>
        <Descriptions.Item label="版本">
          {bin.version ?? <Typography.Text type="danger">已找到但版本探测失败</Typography.Text>}
        </Descriptions.Item>
      </Descriptions>
    </Card>
  );
}

export default function SettingsPage() {
  const [bins, setBins] = useState<BinsResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [probing, setProbing] = useState(false);

  const probe = (): Promise<void> => {
    if (probing) return Promise.resolve(); // in-flight 守卫,避免并发探测竞态
    setProbing(true);
    setLoading(true);
    return apiGet<BinsResult>('/api/bins/probe')
      .then((r) => {
        setBins(r);
        setError(null);
      })
      .catch((e: Error) => {
        setError(e.message);
        setBins(null);
      })
      .finally(() => {
        setLoading(false);
        setProbing(false);
      });
  };

  useEffect(() => {
    void probe();
  }, []);

  return (
    <div style={{ margin: 16 }}>
      {error && (
        <Alert
          type="error"
          showIcon
          message="无法连接本地服务"
          description={error}
          style={{ marginBottom: 16 }}
        />
      )}
      <Card title="设置" style={{ marginBottom: 16 }}>
        <Typography.Text>API 端口:{apiPort()}</Typography.Text>
        <Button style={{ float: 'right' }} loading={probing} onClick={() => void probe()}>
          重新探测
        </Button>
      </Card>
      <BinCard title="yt-dlp" bin={bins?.ytdlp ?? null} loading={loading} />
      <BinCard title="ffmpeg" bin={bins?.ffmpeg ?? null} loading={loading} />
    </div>
  );
}
