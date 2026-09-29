// web/src/layouts/index.tsx(全局导航:Umi 约定布局,自动包裹全部路由——2026-09-29 用户反馈"内页无导航回不去")
// 注:导航读写用原生 window.location.hash,与各页面既有模式一致(@umijs/max 未导出 history/useLocation)
import { Menu } from 'antd';
import type { ReactNode } from 'react';
import LogsButton from '@/components/LogsButton';

const NAV_ITEMS = [
  { key: '/', label: '首页' },
  { key: '/acquire', label: '获取' },
  { key: '/library', label: '音频库' },
  { key: '/settings', label: '设置' },
];

/** 当前 hash 内路径:'#/acquire?x' → '/acquire';空 hash → '/' */
function currentPath(): string {
  const h = window.location.hash.replace(/^#/, '');
  return (h.split('?')[0] ?? '') || '/';
}

export default function GlobalLayout({ children }: { children: ReactNode }) {
  // 路由切换时布局随 children 重渲染,渲染期读 hash 即当前页
  const selected = NAV_ITEMS.find((i) => i.key === currentPath())?.key ?? '/';
  return (
    <div style={{ minHeight: '100vh' }}>
      <Menu
        mode="horizontal"
        selectedKeys={[selected]}
        items={NAV_ITEMS}
        onClick={({ key }) => { window.location.hash = key; }}
        style={{ paddingInline: 16 }}
      />
      {children}
      {/* 日志按钮全局唯一,从三个页面收拢到此 */}
      <LogsButton />
    </div>
  );
}
