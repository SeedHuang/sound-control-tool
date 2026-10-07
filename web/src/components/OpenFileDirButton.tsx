// 成品行「打开所在目录」按钮（2026-10-07 用户要求）：一个图标，hover 出该文件的**具体文件信息**。
// 为什么独立成组件：作品详情页的成品行与剪辑室「无作品」列表要用**一模一样**的图标/提示/取目录逻辑，
//   分两份写必然漂移（本仓库的惯常做法：同一段 UI 出现第二遍就抽公共件）。
//
// 两条硬约束（改之前先读）：
//   1. 桌面桥的 reveal-path **只接受目录**（desktop/src/main.ts 里校验 statSync(p).isDirectory()，
//      再用 shell.openPath 打开）→ 这里传的是**文件所在目录**，不是文件本身。
//   2. 目录由 file_path **现算**，不读设置里的 output_dir_resolved —— 用户改过导出目录后，
//      老成品仍在旧目录里，只有按文件自身算才对。
import { Button, Tooltip, message } from 'antd';
import { FolderOpenOutlined } from '@ant-design/icons';
import type { ReactNode } from 'react';
import { hasDesktopBridge } from '@/desktop';
import { revealDir } from '@/export-dir';

/** 字节 → 人类可读（hover 的文件信息用）。1 位小数；不足 1KB 给整数 B。 */
function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** 取路径的父目录（Windows 反斜杠与 Unix 斜杠都认）。web 侧没有 path 模块，就近手写。 */
function dirOf(p: string): string {
  return p.replace(/[\\/][^\\/]*$/, '');
}

/** filePath / fileSize 取 AudioRow 的同名字段（服务端 /api/audio 本来就整行回传）。 */
export default function OpenFileDirButton({ filePath, fileSize }: { filePath?: string; fileSize?: number | null }): ReactNode {
  // 只取一次：提示文案与按钮 disabled 必须**同源**，否则会出现「按钮禁用着、却提示你点击打开」这种自相矛盾
  const canOpen = hasDesktopBridge();
  const onOpen = async (): Promise<void> => {
    const dir = dirOf(filePath ?? '');
    if (dir === '') { message.error('拿不到该成品的目录'); return; }
    const r = await revealDir(dir);
    if (!r.ok) message.error(r.message ?? '打开目录失败');
  };
  return (
    <Tooltip title={(
      <div style={{ maxWidth: 420 }}>
        <div style={{ wordBreak: 'break-all' }}>{filePath ?? '路径未知'}</div>
        <div style={{ opacity: 0.75 }}>
          {typeof fileSize === 'number' ? fmtSize(fileSize) : '大小未知'} · {canOpen ? '点击在资源管理器中打开' : '仅桌面应用内可用'}
        </div>
      </div>
    )}>
      {/* 禁用态包一层 span，否则 antd Tooltip 收不到鼠标事件、悬停不出提示（同工具栏各处）；无桥见 tooltip 文案 */}
      <span>
        <Button size="small" aria-label="打开所在目录" icon={<FolderOpenOutlined />} disabled={!canOpen} onClick={() => void onOpen()} />
      </span>
    </Tooltip>
  );
}
