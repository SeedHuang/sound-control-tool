// web/src/components/LogsButton.tsx(2026-09-29 用户反馈:"一个按钮看前后端日志")
// 固定悬浮按钮 + 抽屉面板:后端日志(拉 /api/logs)+ 前端日志(api.ts 环形缓冲),
// 跨进程问题(浏览器↔server↔yt-dlp)可观测——CORS 修复前的 SSE 断连排查就缺这样一个入口。
import { Button, Drawer, Empty, Space, Typography } from 'antd';
import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { fetchLogs, getFeLogs, type LogRow } from '@/api';

// 等宽日志块:日志是给排查用的,字体一乱时间戳就没法对齐
const preStyle: CSSProperties = {
  margin: 0,
  maxHeight: 320,
  overflow: 'auto',
  background: '#f6f6f6',
  padding: 8,
  fontSize: 12,
  lineHeight: 1.6,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-all',
};

/** 渲染"时间 [级别] 消息"一行一条,最新的在最上(打开先看到刚发生的);error 行加 [错误] 前缀 */
function renderRows(rows: LogRow[]): string {
  return [...rows]
    .reverse()
    .map((r) => `${r.ts} [${r.level === 'error' ? '错误' : '信息'}] ${r.message}`)
    .join('\n');
}

export default function LogsButton() {
  const [open, setOpen] = useState(false);
  const [backend, setBackend] = useState<LogRow[] | null>(null); // null=尚未拉取过
  const [error, setError] = useState<string | null>(null);
  const [feRows, setFeRows] = useState<LogRow[]>([]);

  const refresh = useCallback(async () => {
    setError(null);
    setFeRows(getFeLogs()); // 前端快照同步(渲染期直取会错过刚发生的几条)
    try {
      setBackend(await fetchLogs());
    } catch (e) {
      setError((e as Error).message); // 拉取失败也留在面板里(server 没起时用户能自己看到原因)
    }
  }, []);

  // 每次打开抽屉都拉最新后端日志 + 前端快照
  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  return (
    <>
      <Button
        type="primary"
        style={{ position: 'fixed', right: 24, bottom: 24, zIndex: 1000 }}
        onClick={() => setOpen(true)}
      >
        日志
      </Button>
      <Drawer title="诊断日志" width={560} open={open} onClose={() => setOpen(false)}>
        <Space direction="vertical" style={{ width: '100%' }} size="large">
          <div>
            <Space style={{ marginBottom: 8 }}>
              <Typography.Text strong>后端日志</Typography.Text>
              <Button size="small" onClick={() => void refresh()}>刷新</Button>
            </Space>
            {error && <Typography.Text type="danger">{error}</Typography.Text>}
            {!error && backend !== null && backend.length === 0 && (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无后端日志" />
            )}
            {!error && backend !== null && backend.length > 0 && (
              <pre style={preStyle}>{renderRows(backend)}</pre>
            )}
          </div>
          <div>
            <Typography.Text strong>前端日志</Typography.Text>
            {feRows.length === 0 ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无前端日志" />
            ) : (
              <pre style={preStyle}>{renderRows(feRows)}</pre>
            )}
          </div>
        </Space>
      </Drawer>
    </>
  );
}
