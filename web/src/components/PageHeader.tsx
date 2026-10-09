// 统一页面头(spec m2-workspace D2):① 平台 logo + 标题 + 元信息(右)  ② 工具栏。
// 固定不滚:调用方把它作为 flex 列的**第一个 flexShrink:0** 子项,滚动交给后面的内容容器。
// toolbar 不传 → 不渲染工具栏(当前无调用方这样用;曾误记为"设置页用这个简化形态",实际设置页是一摞 Card,并未引用本组件)。
// toolbarInline(2026-10-09):工具栏与标题并成**一行**(剪辑室用)。此时标题改用 maxWidth 限宽 ——
//   默认的 flex:1 会把标题撑到满格,右侧按钮就没位置了;调用方需同时给 titleMaxWidth。
import type { ReactNode } from 'react';
import { cyberColors, cyberFontStack } from '@/setup/theme';

export interface PageHeaderProps {
  /** 左侧小图标(平台 logo);没有就留空 */
  icon?: ReactNode;
  /** 主标题(来源名 / 页面名) */
  title: ReactNode;
  /** 标题右侧的元信息(时长、集数、第几集…) */
  meta?: ReactNode;
  /** 工具栏;不传则不渲染。默认排**第二行** */
  toolbar?: ReactNode;
  /** 工具栏与标题**同排一行**(排在最右);默认 false = 另起第二行。
   *  2026-10-09 用户要求「两行并一行」时加的：单行下标题要限宽,否则超长标题会把右侧按钮挤出可视区。 */
  toolbarInline?: boolean;
  /** 标题区最大宽度(px);仅 toolbarInline 时生效(标题需要给它右侧的按钮让位) */
  titleMaxWidth?: number;
}

export default function PageHeader({ icon, title, meta, toolbar, toolbarInline = false, titleMaxWidth }: PageHeaderProps) {
  const toolbarRow = (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        flexWrap: toolbarInline ? 'nowrap' : 'wrap',
        // 同排时靠右贴边 + 永不压缩:按钮是操作区,被挤变形比换行更糟
        marginLeft: toolbarInline ? 'auto' : undefined,
        flexShrink: toolbarInline ? 0 : undefined,
      }}
    >
      {toolbar}
    </div>
  );

  return (
    <div
      style={{
        flexShrink: 0,
        padding: '10px 16px',
        background: cyberColors.bgLayout,
        borderBottom: `1px solid ${cyberColors.borderWhite}`,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
        {icon}
        <div
          style={{
            // 同排时用 maxWidth 限宽而非 flex:1 —— flex:1 会把标题区撑到满格,右侧按钮就没位置了
            flex: toolbarInline ? '0 1 auto' : 1,
            maxWidth: toolbarInline ? titleMaxWidth : undefined,
            minWidth: 0,
            fontSize: 16,
            fontWeight: 600,
            fontFamily: cyberFontStack,
            color: cyberColors.textPrimary,
            lineHeight: '24px',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {title}
        </div>
        {meta != null && (
          <div style={{ flexShrink: 0, fontSize: 12, color: cyberColors.textMuted }}>{meta}</div>
        )}
        {toolbarInline && toolbar != null && toolbarRow}
      </div>
      {!toolbarInline && toolbar != null && <div style={{ marginTop: 8 }}>{toolbarRow}</div>}
    </div>
  );
}
