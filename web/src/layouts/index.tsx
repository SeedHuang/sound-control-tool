// web/src/layouts/index.tsx(全局导航:Umi 约定布局,自动包裹全部路由——2026-09-29 用户反馈"内页无导航回不去")
// 2026-09-29 真根因(参照 D:\Seed\system-c-cleaner 可跑项目定位):Umi 4 布局是路由树父节点,
// 必须用 <Outlet /> 渲染子页面;此前写 {children} 在 Umi 4 下恒为 undefined——
// 菜单照常渲染、页面内容永不渲染、React.lazy 从未触发、全程无报错。hash/MFSU 均为此表象的岔路。
// 跳转/高亮用 @umijs/max 的 useNavigate/useLocation(tsconfig paths 已配 umi → src/.umi/exports.ts)。
import { Outlet, useLocation, useNavigate } from '@umijs/max';
import { Badge, Button, Menu } from 'antd';
import { DownloadOutlined, HomeOutlined, ScissorOutlined, SettingOutlined, VideoCameraOutlined } from '@ant-design/icons';
import { useEffect, useState } from 'react';
import LogsButton from '@/components/LogsButton';
import TaskDrawer from '@/components/TaskDrawer';
import { onOpenDownloader } from '@/desktop';
// 引擎持久化状态（总开关 + 音量）在布局层初始化，见下方 useEffect 注释（修复：深链详情页也会读到用户设置）
import { initFromSettings } from '@/audio-player';
import { cyberColors } from '@/setup/theme';
import { CyberDivider } from '@/components/cyber';
import '@/global.css'; // 卡片墙动效等全局样式(显式引入,不依赖框架的全局样式约定)

const NAV_ITEMS = [
  { key: '/', label: '首页', icon: <HomeOutlined /> },
  { key: '/library', label: '资料库', icon: <VideoCameraOutlined /> },
  { key: '/studio', label: '剪辑室', icon: <ScissorOutlined /> },
  { key: '/settings', label: '设置', icon: <SettingOutlined /> },
];

export default function GlobalLayout() {
  const location = useLocation(); // 路由变化 → 布局重渲染 → 高亮跟随
  const navigate = useNavigate(); // 路由原生跳转:走 Umi history,页面必切
  // 任务抽屉(2026-09-30 spec D11):开合状态与在途数都放 layout —— 抽屉挂在布局上、切 tab 不卸载,状态自然不丢。
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [activeCount, setActiveCount] = useState(0);
  // 托盘菜单「显示下载器」→ 打开抽屉(spec D14)。订阅一次即可(布局不随路由卸载);
  // 返回的取消订阅函数直接作为 cleanup,避免热更新/卸载后句柄残留。无桌面桥时返回空函数,浏览器模式无副作用。
  useEffect(() => onOpenDownloader(() => setDrawerOpen(true)), []);
  // 引擎的持久化状态（全局声音开关 + 音量）在**布局层**读入一次：布局对所有路由只挂载一次（含深链/刷新到作品详情页），
  // 这样播放器不会停留在默认的 muted:true / volume:0.8，而与用户已保存的设置一致。
  // 空依赖 + 只调一次 —— 引擎自身会去重，本处不做重复读。
  useEffect(() => { initFromSettings(); }, []);
  // 子路由也要高亮父项:`/studio/12` 必须让"剪辑室"亮起来(否则详情页看不出自己在哪个板块)。
  // 首页用精确匹配,避免它把任何路径都吃掉。
  const selected =
    NAV_ITEMS.find((i) => (i.key === '/' ? location.pathname === '/' : location.pathname.startsWith(i.key)))?.key ?? '/';
  return (
    /* App 壳(2026-09-29 用户拍板:整页不准滚 body)——根节点锁死 100vh、overflow hidden;
       顶栏固定一行,内容区占满剩余高度、超出自己滚。各页在内容区内自管滚动。 */
    <div className="cyber-app" style={{ height: '100vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* 顶栏:菜单占左侧,日志按钮收右侧;flexShrink 0 保证高度永不被压缩 */}
      <div
        style={{
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          paddingInline: 16,
          background: cyberColors.bgLayout,
        }}
      >
        {/* Menu 底边框移到外层 div,否则按钮下方会断线 */}
        <Menu
          className="cyber-topnav"
          mode="horizontal"
          selectedKeys={[selected]}
          items={NAV_ITEMS}
          onClick={({ key }) => navigate(key)}
          style={{ flex: 1, minWidth: 0, borderBottom: 'none' }}
        />
        {/* 任务入口(spec D11):徽标显示在途总数,点击开全局抽屉;放在日志按钮左侧 */}
        <Badge count={activeCount} size="small">
          <Button className="cyber-topnav-icon" type="text" icon={<DownloadOutlined />} onClick={() => setDrawerOpen(true)} />
        </Badge>
        {/* 日志按钮全局唯一,从三个页面收拢到此 */}
        <LogsButton />
      </div>
      {/* 顶栏与内容区之间的赛博分隔线(红切角),承担原 borderBottom 的分隔职责 */}
      <CyberDivider style={{ flexShrink: 0 }} />
      {/* 内容区(spec m2-workspace D3):这里**不再滚**——滚动交给每个页面自己的容器。
          留 overflow:hidden 是为了把"页面超出"这件事挡在内容区里,不让它顶到 body。
          minHeight 0 是 flex 子项允许收缩的关键,少了它子页面的 height:100% 会失效。 */}
      <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
        <Outlet /> {/* Umi 4 子页面唯一正确渲染方式(参考项目同款) */}
      </div>
      {/* 全局任务抽屉(spec D11):放在内容区之后作为 overlay,不参与 flex 布局;
          它挂在本布局上,切换 tab 不会卸载 —— 抽屉开合与在途数都不丢。 */}
      <TaskDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} onCountChange={setActiveCount} />
    </div>
  );
}
