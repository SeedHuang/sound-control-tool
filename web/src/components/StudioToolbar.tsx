// 剪辑室工具栏的**右侧按钮组容器**（spec D3）。
// 为什么只抽这一段、不抽整行：整行的「同排 / 限宽 / 靠右」布局已由 PageHeader 的 toolbarInline 模式实现，
//   在这里重写第二遍会出现两套布局真相。返回按钮也不归这里——它走 PageHeader 的 leading。
// 为什么值得单独抽：用户要求「工具栏布局固定下来成为一个标准组件」，后续页面接入直接用。
import type { ReactNode } from 'react';

export interface StudioToolbarProps {
  /** 右侧按钮组（由调用方给，本组件不关心具体有哪些按钮） */
  tools: ReactNode;
}

export default function StudioToolbar({ tools }: StudioToolbarProps) {
  return <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>{tools}</div>;
}
