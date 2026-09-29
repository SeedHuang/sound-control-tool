// web/src/layouts/index.tsx(全局导航:Umi 约定布局,自动包裹全部路由——2026-09-29 用户反馈"内页无导航回不去")
import { Menu } from 'antd';
import type { ReactNode } from 'react';
import { history } from '@umijs/max';
import LogsButton from '@/components/LogsButton';

const NAV_ITEMS = [
  { key: '/', label: '首页' },
  { key: '/acquire', label: '获取' },
  { key: '/library', label: '音频库' },
  { key: '/settings', label: '设置' },
];

export default function GlobalLayout({ children }: { children: ReactNode }) {
  // hash 路由:history.location.pathname 即 hash 内路径;路由切换时布局随 children 重渲染,读值即当前页
  const pathname = history.location.pathname;
  const selected = NAV_ITEMS.find((i) => i.key === pathname)?.key ?? '/';
  return (
    <div style={{ minHeight: '100vh' }}>
      <Menu
        mode="horizontal"
        selectedKeys={[selected]}
        items={NAV_ITEMS}
        onClick={({ key }) => history.push(key)}
        style={{ paddingInline: 16 }}
      />
      {children}
      {/* 日志按钮全局唯一,从三个页面收拢到此 */}
      <LogsButton />
    </div>
  );
}
