// 统一页面头(spec m2-workspace D2):① 平台 logo + 标题 + 元信息(右)  ② 工具栏。
// 固定不滚:调用方把它作为 flex 列的**第一个 flexShrink:0** 子项,滚动交给后面的内容容器。
// toolbar 不传 → 不渲染第二行(当前无调用方这样用;曾误记为"设置页用这个简化形态",实际设置页是一摞 Card,并未引用本组件)。
import type { ReactNode } from 'react';
import { cyberColors, cyberFontStack } from '@/setup/theme';

export interface PageHeaderProps {
  /** 左侧小图标(平台 logo);没有就留空 */
  icon?: ReactNode;
  /** 主标题(来源名 / 页面名) */
  title: ReactNode;
  /** 标题右侧的元信息(时长、集数、第几集…) */
  meta?: ReactNode;
  /** 第二行工具栏;不传则不渲染这一行 */
  toolbar?: ReactNode;
}

export default function PageHeader({ icon, title, meta, toolbar }: PageHeaderProps) {
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
            flex: 1,
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
      </div>
      {toolbar != null && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
          {toolbar}
        </div>
      )}
    </div>
  );
}
