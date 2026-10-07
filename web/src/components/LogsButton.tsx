// web/src/components/LogsButton.tsx(2026-09-29 用户反馈:"一个按钮看前后端日志")
// 顶栏右侧固定按钮,点开抽屉看日志:后端日志(拉 /api/logs)+ 前端日志(api.ts 环形缓冲),
// 跨进程问题(浏览器↔server↔yt-dlp)可观测——CORS 修复前的 SSE 断连排查就缺这样一个入口。
import { Button, Drawer, Empty, Space, Switch, Typography } from 'antd';
import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { fetchLogs, getFeLogs, type LogRow } from '@/api';
import { cyberColors } from '@/setup/theme';

// 等宽日志块:日志是给排查用的,字体一乱时间戳就没法对齐
const preStyle: CSSProperties = {
  margin: 0,
  maxHeight: 320,
  overflow: 'auto',
  // 与全站滚动容器同款：永久预占滚动条槽，防「滚动条占位 ⇄ 宽度 ⇄ 高度」自激抖动（详见 studio-detail.tsx 同款注释）
  scrollbarGutter: 'stable',
  background: cyberColors.bgLayout,
  color: cyberColors.textPrimary,
  border: `1px solid ${cyberColors.borderWhite}`,
  padding: 8,
  fontSize: 12,
  lineHeight: 1.6,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-all',
};

// 抽屉开着期间每秒拉一次前后端日志:
// 原版只在「打开瞬间」拉一次,开着期间 menu 点击 / SSE 事件产生的 logFe 全看不到——
// 用户反馈「菜单点了日志没出现」就是这个根因。1s 间隔对排查够即时,对网络/CPU 可忽略。
const POLL_MS = 1000;

/** 级别 → 中文标签(2026-09-29 加 debug 档:'调试' 是"例行但排查时有用"的一类,面板默认折叠) */
function levelLabel(level: LogRow['level']): string {
  if (level === 'error') return '错误';
  if (level === 'debug') return '调试';
  return '信息';
}

/** 级别 → 语义色(CP2077):错误红 / 信息青 / 调试弱化 */
const LEVEL_COLOR: Record<LogRow['level'], string> = {
  error: cyberColors.red,
  info: cyberColors.cyan,
  debug: cyberColors.textMuted,
};

/** 渲染"时间 [级别] 消息"一行一条,最新的在最上(打开先看到刚发生的);整行按级别上色 */
function renderRows(rows: LogRow[]): JSX.Element[] {
  return [...rows]
    .reverse()
    .map((r, i) => (
      <div key={`${r.ts}-${i}`} style={{ color: LEVEL_COLOR[r.level] }}>
        {`${r.ts} [${levelLabel(r.level)}] ${r.message}`}
      </div>
    ));
}

/** 面板默认视角 = 隐藏调试:SSE open / audioFileUrl 这类每屏好几条,不折叠会把真正要看的信息挤走 */
function visibleRows(rows: LogRow[], showDebug: boolean): LogRow[] {
  return showDebug ? rows : rows.filter((r) => r.level !== 'debug');
}
function countDebug(rows: LogRow[]): number {
  return rows.reduce((n, r) => (r.level === 'debug' ? n + 1 : n), 0);
}

export default function LogsButton() {
  const [open, setOpen] = useState(false);
  const [backend, setBackend] = useState<LogRow[] | null>(null); // null=尚未拉取过
  const [error, setError] = useState<string | null>(null);
  const [feRows, setFeRows] = useState<LogRow[]>([]);
  const [showDebug, setShowDebug] = useState(false); // 调试日志默认折叠(2026-09-29):例行日志太多,不默认展开

  const refresh = useCallback(async () => {
    setError(null);
    setFeRows(getFeLogs()); // 前端快照同步(渲染期直取会错过刚发生的几条)
    try {
      setBackend(await fetchLogs());
    } catch (e) {
      setError((e as Error).message); // 拉取失败也留在面板里(server 没起时用户能自己看到原因)
    }
  }, []);

  // 抽屉打开瞬间拉一次 + 开着期间每秒轮询,确保 menu 点击 / SSE 事件产生的 logFe 立刻可见
  useEffect(() => {
    if (!open) return;
    void refresh();
    const t = setInterval(() => { void refresh(); }, POLL_MS);
    return () => clearInterval(t);
  }, [open, refresh]);

  return (
    <>
      <Button type="primary" className="cyber-topnav-icon" onClick={() => setOpen(true)}>
        日志
      </Button>
      <Drawer title="诊断日志" width={560} open={open} onClose={() => setOpen(false)}>
        <Space direction="vertical" style={{ width: '100%' }} size="large">
          {/* 级别过滤(2026-09-29):『调试』档默认折叠。一个开关统管前后端两份日志——排查 CORS/token 时才展开 */}
          <Space>
            <Switch size="small" checked={showDebug} onChange={setShowDebug} />
            <Typography.Text>显示调试日志</Typography.Text>
            {!showDebug && (
              <Typography.Text type="secondary">
                (已隐藏 {countDebug(backend ?? []) + countDebug(feRows)} 条)
              </Typography.Text>
            )}
          </Space>
          <div>
            <Space style={{ marginBottom: 8 }}>
              <Typography.Text strong>后端日志</Typography.Text>
              <Button size="small" onClick={() => void refresh()}>刷新</Button>
              {/* 清空入口不在这里(2026-09-29 用户拍板):抽屉只负责"看",破坏性操作搬到设置页「清空所有日志」并二次确认 */}
            </Space>
            {error && <Typography.Text type="danger">{error}</Typography.Text>}
            {!error && backend !== null && backend.length === 0 && (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无后端日志" />
            )}
            {!error && backend !== null && backend.length > 0 && visibleRows(backend, showDebug).length === 0 && (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无日志(已有的全是调试日志)" />
            )}
            {!error && backend !== null && visibleRows(backend, showDebug).length > 0 && (
              <pre style={preStyle}>{renderRows(visibleRows(backend, showDebug))}</pre>
            )}
          </div>
          <div>
            <Typography.Text strong>前端日志</Typography.Text>
            {feRows.length === 0 && (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无前端日志" />
            )}
            {feRows.length > 0 && visibleRows(feRows, showDebug).length === 0 && (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无日志(已有的全是调试日志)" />
            )}
            {visibleRows(feRows, showDebug).length > 0 && (
              <pre style={preStyle}>{renderRows(visibleRows(feRows, showDebug))}</pre>
            )}
          </div>
        </Space>
      </Drawer>
    </>
  );
}
