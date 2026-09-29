import { Button, Empty, List, Modal, Space, Typography } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { apiGet, audioFileUrl, deleteAudio, logFe } from '@/api';

interface AudioRow { id: number; title: string; source_type: string; format: string; duration_sec: number | null; created_at: string }
export default function LibraryPage() {
  const [items, setItems] = useState<AudioRow[]>([]);
  const [error, setError] = useState<string | null>(null);
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
  if (error) return <Typography.Text type="danger">{error}</Typography.Text>;
  if (items.length === 0) return <Empty description="暂无音频,先去获取页下载吧" style={{ marginTop: 64 }} />;
  return (
    <List
      style={{ margin: 16 }}
      dataSource={items}
      renderItem={(it) => (
        <List.Item
          actions={[
            <Button key="del" danger size="small" onClick={() => onDelete(it.id, it.title)}>删除</Button>,
          ]}
        >
          <List.Item.Meta
            title={<Space>{it.title}<Typography.Text type="secondary" style={{ fontSize: 12 }}>{it.source_type}</Typography.Text></Space>}
            description={`${it.format} · ${it.duration_sec ? `${it.duration_sec.toFixed(1)}s` : '时长未知'} · ${it.created_at}`}
          />
          <audio ref={(el) => { audioRefs.current.set(it.id, el); }} controls src={audioFileUrl(it.id)} style={{ width: 320 }} />
        </List.Item>
      )}
    />
  );
}