import { Empty, List, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { apiGet, audioFileUrl } from '@/api';
import LogsButton from '@/components/LogsButton';

interface AudioRow { id: number; title: string; source_type: string; format: string; duration_sec: number | null; created_at: string }
export default function LibraryPage() {
  const [items, setItems] = useState<AudioRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    apiGet<AudioRow[]>('/api/audio').then(setItems).catch((e: Error) => setError(e.message));
  }, []);
  if (error)
    return (
      <>
        <Typography.Text type="danger">{error}</Typography.Text>
        <LogsButton />
      </>
    );
  if (items.length === 0)
    return (
      <>
        <Empty description="暂无音频，先去获取页下载吧" style={{ marginTop: 64 }} />
        <LogsButton />
      </>
    );
  return (
    <>
      <List
        style={{ margin: 16 }}
        dataSource={items}
        renderItem={(it) => (
          <List.Item>
            <List.Item.Meta title={it.title} description={`${it.format} · ${it.duration_sec ? `${it.duration_sec.toFixed(1)}s` : '时长未知'} · ${it.created_at}`} />
            <audio controls src={audioFileUrl(it.id)} style={{ width: 320 }} />
          </List.Item>
        )}
      />
      <LogsButton />
    </>
  );
}
