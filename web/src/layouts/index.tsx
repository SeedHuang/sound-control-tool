// web/src/layouts/index.tsx(全局导航:Umi 约定布局,自动包裹全部路由——2026-09-29 用户反馈"内页无导航回不去")
// 2026-09-29 真根因(参照 D:\Seed\system-c-cleaner 可跑项目定位):Umi 4 布局是路由树父节点,
// 必须用 <Outlet /> 渲染子页面;此前写 {children} 在 Umi 4 下恒为 undefined——
// 菜单照常渲染、页面内容永不渲染、React.lazy 从未触发、全程无报错。hash/MFSU 均为此表象的岔路。
// 跳转/高亮用 @umijs/max 的 useNavigate/useLocation(tsconfig paths 已配 umi → src/.umi/exports.ts)。
import { Outlet, useLocation, useNavigate } from '@umijs/max';
import { Menu } from 'antd';
import LogsButton from '@/components/LogsButton';
import '@/global.css'; // 卡片墙动效等全局样式(显式引入,不依赖框架的全局样式约定)

const NAV_ITEMS = [
  { key: '/', label: '首页' },
  { key: '/acquire', label: '获取' },
  { key: '/library', label: '音频库' },
  { key: '/settings', label: '设置' },
];

export default function GlobalLayout() {
  const location = useLocation(); // 路由变化 → 布局重渲染 → 高亮跟随
  const navigate = useNavigate(); // 路由原生跳转:走 Umi history,页面必切
  const selected = NAV_ITEMS.find((i) => i.key === location.pathname)?.key ?? '/';
  return (
    /* App 壳(2026-09-29 用户拍板:整页不准滚 body)——根节点锁死 100vh、overflow hidden;
       顶栏固定一行,内容区占满剩余高度、超出自己滚。各页在内容区内自管滚动。 */
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* 顶栏:菜单占左侧,日志按钮收右侧;flexShrink 0 保证高度永不被压缩 */}
      <div
        style={{
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          paddingInline: 16,
          background: '#fff',
          borderBottom: '1px solid rgba(5, 5, 5, 0.06)',
        }}
      >
        {/* Menu 底边框移到外层 div,否则按钮下方会断线 */}
        <Menu
          mode="horizontal"
          selectedKeys={[selected]}
          items={NAV_ITEMS}
          onClick={({ key }) => navigate(key)}
          style={{ flex: 1, minWidth: 0, borderBottom: 'none' }}
        />
        {/* 日志按钮全局唯一,从三个页面收拢到此 */}
        <LogsButton />
      </div>
      {/* 内容区:minHeight 0 是 flex 子项允许收缩、内部滚动生效的关键 */}
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        <Outlet /> {/* Umi 4 子页面唯一正确渲染方式(参考项目同款) */}
      </div>
    </div>
  );
}
