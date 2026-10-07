import { Button } from 'antd';
import type { ButtonProps } from 'antd';
import type { CSSProperties, ReactNode } from 'react';
import './cyber.css';

interface CyberCardProps {
  /** cyan：青描边（默认）；red：红描边 */
  variant?: 'cyan' | 'red';
  /** DOM id（页面内滚动定位用） */
  id?: string;
  /** 左侧竖条（对应 Figma Card/Frame-M） */
  stripe?: boolean;
  className?: string;
  /** 注意：style 作用于描边层，勿在 style 上设 padding/background */
  style?: CSSProperties;
  contentStyle?: CSSProperties;
  children?: ReactNode;
}

/** CP2077 切角面板：外层主色做"描边"，内层内缩 1px 同 clip-path 做底色 */
export function CyberCard({ variant = 'cyan', id, stripe, className, style, contentStyle, children }: CyberCardProps) {
  const cls = ['cyber-card', `cyber-card-${variant}`, stripe ? 'cyber-card-stripe' : '', className ?? ''].filter(Boolean).join(' ');
  return (
    <div id={id} className={cls} style={style}>
      <div className="cyber-card-inner" style={contentStyle}>{children}</div>
    </div>
  );
}

/** size/shape 已被 cyber.css 钉死，一并 Omit 防无声 no-op */
interface CyberButtonProps extends Omit<ButtonProps, 'variant' | 'size' | 'shape'> {
  variant?: 'cyan' | 'red';
}

/** CP2077 切角轮廓按钮（基于 antd Button，仅覆盖外观，保留 loading/icon/disabled 语义） */
export function CyberButton({ variant = 'cyan', className, ...rest }: CyberButtonProps) {
  return <Button {...rest} className={`cyber-btn cyber-btn-${variant} ${className ?? ''}`.trim()} />;
}

interface SectionTitleProps {
  /** 红色发光效果 */
  glow?: boolean;
  style?: CSSProperties;
  children?: ReactNode;
}

/** Rajdhani SemiBold 大写标题；glow 时红色 + 模糊光晕 */
export function SectionTitle({ glow, style, children }: SectionTitleProps) {
  return <div className={`cyber-title${glow ? ' cyber-title-glow' : ''}`} style={style}>{children}</div>;
}

/** 红色分隔线（Figma Separators：2px、30% 透明度、左端斜切缺口） */
export function CyberDivider({ style, className }: { style?: CSSProperties; className?: string }) {
  return <div className={`cyber-divider ${className ?? ''}`.trim()} style={style} />;
}
