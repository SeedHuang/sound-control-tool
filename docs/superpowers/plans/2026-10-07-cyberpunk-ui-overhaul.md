# CP2077 全站 UI 改造 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `sound-control-tool` 的 `web/` 前台整体改造为 CP2077 赛博朋克风格（切角、Rajdhani、红青撞色、扫描线、发光）。

**Architecture:** 三层——① antd 深度换肤（`app.tsx` + `ConfigProvider` + `theme.darkAlgorithm`）；② Cyber 原语层（`CyberCard`/`CyberButton`/`SectionTitle`/`CyberDivider`）；③ 全局样式（`global.css`）。外观之外**不动**业务逻辑、数据流与手势。

**Tech Stack:** Umi 4 (`@umijs/max` 4.7.17) + antd 5.21 + React 18 + TypeScript；样式为**纯 CSS**（不引入 less / styled-components）。

**Spec:** `docs/superpowers/specs/2026-10-07-cyberpunk-ui-overhaul-design.md`

**参照实现（可直接对照/复制）:** `D:\Seed\system-c-cleaner`（同 Figma 来源、已落地）

## Global Constraints

- 字体栈唯一写法：`'Rajdhani', -apple-system, 'Segoe UI', 'Microsoft YaHei', 'PingFang SC', sans-serif`
- 切角唯一真相源：CSS 变量 `--cyber-clip: polygon(12px 0, 100% 0, 100% calc(100% - 12px), calc(100% - 12px) 100%, 0 100%, 0 12px)`
- 三档底色：`bgLayout #0E0E17` / `bgContainer #161616` / `bgElevated #1A1A26`
- 主红 `#F75049`、主青 `#5EF6FF`、绿 `#1DED83`、黄 `#F0B537`、橙 `#FB932E`
- 全站 `borderRadius: 0`
- **禁止**改动：`server/`、`desktop/`、任何数据获取/状态管理/手势逻辑
- 每个任务结束后立即 `pnpm --filter @sct/web run typecheck`
- **禁止任何 git 写操作**（改动留工作树，由用户提交）
- 中文标题不做 `text-transform` 破坏（CSS uppercase 对汉字天然无效，安全）

---

### Task 1: 主题地基（字体 + 令牌 + ConfigProvider + 全局样式）

**Files:**
- Create: `web/src/assets/fonts/Rajdhani-{Light,Regular,Medium,SemiBold,Bold}.ttf`（从参照项目复制）
- Create: `web/src/setup/theme.tsx`
- Create: `web/src/app.tsx`
- Modify: `web/src/global.css`

**Interfaces:**
- Produces: `cyberColors`（色板对象）、`cyberFontStack`（字符串）、`cyberTheme`（antd ThemeConfig）
- Consumes: 无（地基）

- [ ] **Step 1: 复制 Rajdhani 字体**

```powershell
New-Item -ItemType Directory -Force -Path "d:\Seed\sound-control-tool\web\src\assets\fonts" | Out-Null
Copy-Item "D:\Seed\system-c-cleaner\src\assets\fonts\Rajdhani-*.ttf" "d:\Seed\sound-control-tool\web\src\assets\fonts\"
Get-ChildItem "d:\Seed\sound-control-tool\web\src\assets\fonts" | Select-Object Name, Length
```
Expected: 列出 5 个 `.ttf`（Light/Regular/Medium/SemiBold/Bold），每个 > 0 字节

- [ ] **Step 2: 新建令牌文件 `web/src/setup/theme.tsx`**

```tsx
import { theme } from 'antd';

/** CP2077 UI Kit 提取的色板：UI Kit - CP2077 (Community)
 *  与参照实现 system-c-cleaner/src/setup/theme.tsx 逐值一致 */
export const cyberColors = {
  bgLayout: '#0E0E17',
  bgContainer: '#161616',
  bgElevated: '#1A1A26',
  red: '#F75049',
  cyan: '#5EF6FF',
  green: '#1DED83',
  yellow: '#F0B537',
  orange: '#FB932E',
  blue: '#2570D4',
  purple: '#9D2BF5',
  contrast: '#D6D0D0',
  textPrimary: '#F0F0F0',
  textSecondary: 'rgba(255, 255, 255, 0.6)',
  textMuted: 'rgba(255, 255, 255, 0.4)',
  borderCyan: 'rgba(94, 246, 255, 0.3)',
  borderRed: 'rgba(247, 80, 73, 0.5)',
  borderWhite: 'rgba(255, 255, 255, 0.08)',
  hoverRed: 'rgba(247, 80, 73, 0.08)',
  cyanSoft: 'rgba(94, 246, 255, 0.1)',
  redSoft: 'rgba(247, 80, 73, 0.15)',
} as const;

/** CP2077 数字/英文标题字体栈（组件内联使用；antd token 用完整回退栈） */
export const cyberFontStack = "'Rajdhani', sans-serif";

/** antd v5 深色主题 token（对齐 CP2077 UI Kit） */
export const cyberTheme = {
  algorithm: theme.darkAlgorithm,
  token: {
    colorPrimary: cyberColors.red,
    colorInfo: cyberColors.cyan,
    colorLink: cyberColors.cyan,
    colorSuccess: cyberColors.green,
    colorWarning: cyberColors.yellow,
    colorError: cyberColors.red,
    colorBgLayout: cyberColors.bgLayout,
    colorBgContainer: cyberColors.bgContainer,
    colorBgElevated: cyberColors.bgElevated,
    colorBorder: cyberColors.borderWhite,
    colorBorderSecondary: cyberColors.borderWhite,
    colorText: cyberColors.textPrimary,
    colorTextSecondary: cyberColors.textSecondary,
    colorTextTertiary: cyberColors.textMuted,
    borderRadius: 0,
    fontSize: 14,
    fontFamily:
      "'Rajdhani', -apple-system, 'Segoe UI', 'Microsoft YaHei', 'PingFang SC', sans-serif",
    controlHeight: 36,
  },
  components: {
    Menu: {
      darkItemBg: 'transparent',
      darkItemSelectedBg: cyberColors.red,
      darkItemColor: cyberColors.textSecondary,
      darkItemHoverColor: cyberColors.textPrimary,
      itemBorderRadius: 0,
    },
    Table: {
      headerBg: cyberColors.bgElevated,
      headerBorderRadius: 0,
      rowHoverBg: cyberColors.hoverRed,
    },
    Button: { primaryShadow: 'none' },
    Modal: { contentBg: cyberColors.bgContainer, headerBg: cyberColors.bgContainer },
    Card: { colorBgContainer: cyberColors.bgContainer },
  },
};
```

- [ ] **Step 3: 新建 `web/src/app.tsx`（Umi 4 运行时配置，注入 ConfigProvider）**

```tsx
// Umi 4 运行时配置:rootContainer 包裹全部路由,antd 主题在此注入(此前项目无任何主题层)
import { ConfigProvider } from 'antd';
import type { ReactNode } from 'react';
import { cyberTheme } from '@/setup/theme';

export function rootContainer(container: ReactNode) {
  return <ConfigProvider theme={cyberTheme}>{container}</ConfigProvider>;
}
```

- [ ] **Step 4: 重写 `web/src/global.css`**

保留现有 `.sct-card` 动效段（原样），在文件顶部加入以下内容：

```css
/* CP2077 切角几何唯一真相源(替代参照项目的 less 变量 @cyberClip) */
:root {
  --cyber-clip: polygon(12px 0, 100% 0, 100% calc(100% - 12px), calc(100% - 12px) 100%, 0 100%, 0 12px);
}

/* Rajdhani(OFL 许可,本地打包,离线可用)。中文字形不在 Rajdhani 内,由回退栈接管 */
@font-face { font-family: 'Rajdhani'; src: url('./assets/fonts/Rajdhani-Light.ttf') format('truetype'); font-weight: 300; font-display: swap; }
@font-face { font-family: 'Rajdhani'; src: url('./assets/fonts/Rajdhani-Regular.ttf') format('truetype'); font-weight: 400; font-display: swap; }
@font-face { font-family: 'Rajdhani'; src: url('./assets/fonts/Rajdhani-Medium.ttf') format('truetype'); font-weight: 500; font-display: swap; }
@font-face { font-family: 'Rajdhani'; src: url('./assets/fonts/Rajdhani-SemiBold.ttf') format('truetype'); font-weight: 600; font-display: swap; }
@font-face { font-family: 'Rajdhani'; src: url('./assets/fonts/Rajdhani-Bold.ttf') format('truetype'); font-weight: 700; font-display: swap; }

html, body, #root { height: 100%; }
body { margin: 0; background: #0e0e17; color: #f0f0f0; }

/* 滚动条:方形深灰,hover 红 */
::-webkit-scrollbar { width: 8px; height: 8px; }
::-webkit-scrollbar-thumb { background: #2a2a38; }
::-webkit-scrollbar-thumb:hover { background: #f75049; }

/* 扫描线覆盖层(挂在布局根 .cyber-app 上;不进 Widget/浮层) */
.cyber-app { position: relative; }
.cyber-app::after {
  content: '';
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 9999;
  background: repeating-linear-gradient(transparent 0 3px, rgba(255, 255, 255, 0.015) 3px 4px);
}

/* antd 浮层方角化(主题 token 覆盖不到浮层内容盒) */
.ant-modal .ant-modal-content,
.ant-modal .ant-modal-header,
.ant-dropdown-menu,
.ant-select-dropdown,
.ant-popover .ant-popover-inner,
.ant-message-notice-content,
.ant-tooltip-inner,
.ant-picker-dropdown .ant-picker-panel-container {
  border-radius: 0 !important;
}
```

- [ ] **Step 5: 验证**

```powershell
pnpm --filter @sct/web run typecheck
pnpm --filter @sct/web run build
```
Expected: typecheck 0 错；build EXIT=0

---

### Task 2: Cyber 原语层

**Files:**
- Create: `web/src/components/cyber/index.tsx`
- Create: `web/src/components/cyber/cyber.css`

**Interfaces:**
- Consumes: `--cyber-clip`（Task 1 的 CSS 变量）
- Produces:
  - `<CyberCard variant?: 'cyan'|'red'; id?; stripe?; className?; style?; contentStyle?; children />`
  - `<CyberButton variant?: 'cyan'|'red' ...ButtonProps />`（`size`/`shape` 被 Omit）
  - `<SectionTitle glow?; style?; children />`
  - `<CyberDivider style?; className? />`

- [ ] **Step 1: 新建 `web/src/components/cyber/index.tsx`**

```tsx
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
```

- [ ] **Step 2: 新建 `web/src/components/cyber/cyber.css`**（参照项目 `cyber.less` 转纯 CSS，`@cyberClip` → `var(--cyber-clip)`）

```css
/* ---------- CyberCard ---------- */
.cyber-card { position: relative; padding: 1px; clip-path: var(--cyber-clip); background: rgba(94, 246, 255, 0.3); }
.cyber-card-inner { position: relative; clip-path: var(--cyber-clip); background: #161616; padding: 20px; height: 100%; }
.cyber-card-red { background: rgba(247, 80, 73, 0.5); }
.cyber-card-stripe .cyber-card-inner::before {
  content: ''; position: absolute; left: 8px; top: 0; bottom: 0; width: 5px; background: rgba(94, 246, 255, 0.3);
}

/* ---------- CyberButton ---------- */
.cyber-btn.ant-btn {
  clip-path: var(--cyber-clip); border: none; border-radius: 0; padding: 0 18px; height: 36px;
  background: rgba(94, 246, 255, 0.9); position: relative; color: #fff;
  text-transform: uppercase; font-weight: 700; letter-spacing: 0.02em;
}
.cyber-btn.ant-btn::after {
  content: ''; position: absolute; inset: 1px; clip-path: var(--cyber-clip);
  background: rgba(0, 0, 0, 0.75); transition: background 0.15s;
}
.cyber-btn.ant-btn:hover::after { background: rgba(94, 246, 255, 0.18); }
.cyber-btn.ant-btn > span { position: relative; z-index: 1; }
.cyber-btn-red.ant-btn { background: rgba(247, 80, 73, 0.9); }
.cyber-btn-red.ant-btn::after { background: rgba(247, 80, 73, 0.25); }
.cyber-btn-red.ant-btn:hover::after { background: rgba(247, 80, 73, 0.45); }
.cyber-btn.ant-btn-disabled, .cyber-btn.ant-btn[disabled] { opacity: 0.45; }

/* ---------- SectionTitle ---------- */
.cyber-title {
  font-family: 'Rajdhani', -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif;
  font-weight: 600; text-transform: uppercase; letter-spacing: -0.04em; color: #fff; font-size: 16px; line-height: 1.3;
}
.cyber-title-glow { color: #f75049; text-shadow: 0 0 14px rgba(247, 80, 73, 0.8); }

/* ---------- CyberDivider ---------- */
.cyber-divider { height: 2px; background: rgba(247, 80, 73, 0.3); clip-path: polygon(10px 0, 100% 0, 100% 100%, 10px 100%, 0 50%); }
```

- [ ] **Step 3: 缩窄 cyber-btn 在表单内的尺寸（本站表单较多，避免按钮过大）**

在 `cyber.css` 末尾追加：

```css
/* 小尺寸按钮变体（表单内联用；不改参照项目的默认 36px） */
.cyber-btn-sm.ant-btn { height: 28px; padding: 0 12px; font-size: 12px; }
```

- [ ] **Step 4: 验证**

```powershell
pnpm --filter @sct/web run typecheck
```
Expected: 0 错

---

### Task 3: 全局布局（顶栏横向导航）

**Files:**
- Modify: `web/src/layouts/index.tsx`

**Interfaces:**
- Consumes: `cyberColors`（Task 1）、`CyberDivider`（Task 2）
- Produces: 无（叶子改动）

- [ ] **Step 1: 改根节点与顶栏配色**

- 根 `<div>` 加 `className="cyber-app"`（挂扫描线层）
- 顶栏 `background: '#fff'` → `cyberColors.bgLayout`
- 顶栏 `borderBottom: '1px solid rgba(5, 5, 5, 0.06)'` → `'none'`，改由下方 `CyberDivider` 承担分隔
- 顶栏内加 `<SectionTitle>` 承载品牌名（如有），Rajdhani 大写

- [ ] **Step 2: 加顶栏下缘红色分隔线**

在顶栏 `</div>` 之后、内容区之前插入：

```tsx
<CyberDivider style={{ flexShrink: 0 }} />
```

- [ ] **Step 3: Menu 选中态改横向红切角**

给 `Menu` 加 `className="cyber-topnav"`，并在 `global.css` 末尾追加：

```css
.cyber-topnav.ant-menu { background: transparent; border-bottom: none; }
.cyber-topnav.ant-menu-horizontal > .ant-menu-item-selected {
  background: rgba(247, 80, 73, 0.9) !important;
  clip-path: var(--cyber-clip);
  color: #fff !important;
}
.cyber-topnav.ant-menu-horizontal > .ant-menu-item::after { display: none !important; }
.cyber-topnav.ant-menu-horizontal > .ant-menu-item { border-radius: 0; }
```

- [ ] **Step 4: 右侧图标按钮（任务入口 + 日志）改方角 + hover 红晕**

`global.css` 末尾追加：

```css
.cyber-topnav-icon.ant-btn { border-radius: 0; }
.cyber-topnav-icon.ant-btn:hover { background: rgba(247, 80, 73, 0.08) !important; }
```
并把布局里的任务按钮、`LogsButton` 外层按钮加 `className="cyber-topnav-icon"`。

- [ ] **Step 5: 验证**

```powershell
pnpm --filter @sct/web run typecheck
```
Expected: 0 错

---

### Task 4: 共享组件换肤（6 个文件）

**Files:**
- Modify: `web/src/components/PageHeader.tsx`
- Modify: `web/src/components/SiteLogo.tsx`
- Modify: `web/src/components/LogsButton.tsx`
- Modify: `web/src/components/NewWorkModal.tsx`
- Modify: `web/src/components/TaskDrawer.tsx`
- Modify: `web/src/components/WorkPreview.tsx`

**Interfaces:**
- Consumes: `cyberColors`（Task 1）、`CyberCard`/`CyberButton`/`SectionTitle`（Task 2）

**统一替换口径（六个文件通用）：**

| 原值 | 改为 |
|---|---|
| `'#fff'` / `'white'`（容器底） | `cyberColors.bgContainer`（卡片内）或 `cyberColors.bgLayout`（整条栏） |
| `'rgba(5, 5, 5, 0.06)'`（分隔线） | `cyberColors.borderWhite` |
| `'rgba(0, 0, 0, 0.45)'`（次要文字） | `cyberColors.textMuted` |
| `'rgba(0, 0, 0, 0.88)'` / `'#000'`（主文字） | `cyberColors.textPrimary` |
| `borderRadius` 非 0 | `0` |
| 卡片容器 | `<CyberCard>` 包裹 |
| 主要动作按钮 | `<CyberButton>` |
| 章节标题 | `<SectionTitle>` |

- [ ] **Step 1: `PageHeader.tsx`** — `background:'#fff'` → `cyberColors.bgLayout`；`borderBottom` → `1px solid ${cyberColors.borderWhite}`；`meta` 色 → `cyberColors.textMuted`；`title` 加 `fontFamily: cyberFontStack`
- [ ] **Step 2: `SiteLogo.tsx`** — 确认 logo 在深底可见；不可见的深色描边改为 `cyberColors.cyan` 或 `textPrimary`
- [ ] **Step 3: `LogsButton.tsx`** — 抽屉/列表换深底；级别色改用语义色（error→red、info→cyan、debug→textMuted）；按钮加 `cyber-topnav-icon`
- [ ] **Step 4: `NewWorkModal.tsx`** — 弹窗底由 antd token 接管（方角）；表单控件保持 antd；确认按钮改 `<CyberButton variant="cyan">`、取消保持默认
- [ ] **Step 5: `TaskDrawer.tsx`** — 抽屉换深底；任务状态色映射：进行中 `cyan`、成功 `green`、失败 `red`、取消 `textMuted`
- [ ] **Step 6: `WorkPreview.tsx`** — 预览卡用 `<CyberCard>`；数值/时长用 `cyan` + `cyberFontStack`
- [ ] **Step 7: 验证**

```powershell
pnpm --filter @sct/web run typecheck
```
Expected: 0 错

---

### Task 5: 首页 + 设置页

**Files:**
- Modify: `web/src/pages/index.tsx`（132 行）
- Modify: `web/src/pages/settings.tsx`（385 行）

**Interfaces:**
- Consumes: Task 1/2 的令牌与原语

- [ ] **Step 1: `index.tsx`** — 页面标题改 `<SectionTitle glow>`；功能卡改 `<CyberCard>`；主要动作按钮改 `<CyberButton>`
- [ ] **Step 2: `settings.tsx`** — 一摞 antd `<Card>` 改 `<CyberCard>`（保留表单字段）；危险操作（清空日志等）用 `<CyberButton variant="red">` 且**保留** `Modal.confirm` 二次确认（不得删除）
- [ ] **Step 3: 验证**

```powershell
pnpm --filter @sct/web run typecheck
```
Expected: 0 错

---

### Task 6: 资料库 + 剪辑室

**Files:**
- Modify: `web/src/pages/library.tsx`（597 行）
- Modify: `web/src/pages/studio.tsx`（383 行）

**Interfaces:**
- Consumes: Task 1/2

- [ ] **Step 1: `library.tsx`** — 卡片墙外层改 `<CyberCard>`（**保留** `sct-card` 类名，动效不能丢）；时长/数值用 `cyan` + `cyberFontStack`；筛选控件方角
- [ ] **Step 2: `studio.tsx`** — 作品卡改 `<CyberCard>`；空态保留 antd `<Empty>`（项目规则：列表空态必须用 antd Empty）；新建入口按钮改 `<CyberButton>`
- [ ] **Step 3: 验证**

```powershell
pnpm --filter @sct/web run typecheck
```
Expected: 0 错

---

### Task 7: TimelineWave Canvas 配色

**Files:**
- Modify: `web/src/components/TimelineWave.tsx`（253 行，Canvas 自绘）

**Interfaces:**
- Consumes: Task 1 的色值（此处需在 JS 内以常量形式引用，Canvas 不走 CSS）

- [ ] **Step 1: 抽出颜色常量**

在文件顶部（组件外）新增：

```ts
// Canvas 不走 CSS，颜色在此以常量声明（值同 cyberColors，改主题时同步此处）
const WAVE_COLORS = {
  bg: '#0E0E17',
  wave: '#5EF6FF',
  grid: 'rgba(255, 255, 255, 0.06)',
  silentBase: 'rgba(255, 255, 255, 0.25)',
  placeholder: 'rgba(247, 80, 73, 0.35)',
} as const;
```

- [ ] **Step 2: 替换绘制处的硬编码色**

把 `fillStyle` / `strokeStyle` 的硬编码值全部换成 `WAVE_COLORS.*`（背景、波形、网格线、静音基线、失败占位斜纹）。**只改颜色，不动任何绘制几何与数据逻辑。**

- [ ] **Step 3: 验证**

```powershell
pnpm --filter @sct/web run typecheck
```
Expected: 0 错

---

### Task 8: 作品详情页（最大文件，最高风险）

**Files:**
- Modify: `web/src/pages/studio-detail.tsx`（1445 行）

**Interfaces:**
- Consumes: Task 1/2、Task 7 的 `WAVE_COLORS`（若该页直接绘制）

- [ ] **Step 1: 分区替换（按顺序，每区改完即 typecheck）**

按出现顺序处理：① 页面头部 → ② 工具栏/操作条 → ③ 时间轴容器与刻度 → ④ 段区块与拖柄 → ⑤ 右侧/底部侧栏 → ⑥ 弹窗与提示。

统一口径同 Task 4 的替换表。**严格遵守：只改颜色 / 字体 / 圆角 / 边框，不改任何手势处理、坐标计算、时间换算、事件绑定。**

- [ ] **Step 2: 逐个自查（每区改完）**

```powershell
pnpm --filter @sct/web run typecheck
```
Expected: 0 错

- [ ] **Step 3: 回扫硬编码浅色残留**

```powershell
Select-String -Path "web/src/pages/studio-detail.tsx" -Pattern "#fff|#ffffff|rgba\(0, 0, 0|rgba\(0,0,0"
```
Expected: 无命中（或仅剩有意保留的白色文字）

- [ ] **Step 4: 全量验证**

```powershell
pnpm --filter @sct/web run typecheck
pnpm --filter @sct/web run build
```
Expected: typecheck 0 错；build EXIT=0

---

### Task 9: 文档回扫 + 全量验证

**Files:**
- Modify: `docs/superpowers/specs/2026-10-07-cyberpunk-ui-overhaul-design.md`（状态行改「已实施」）
- Modify: `docs/after/*`（若本批引入新的未完成项）

- [ ] **Step 1: 全量验证**

```powershell
pnpm -r run typecheck
pnpm --filter @sct/web run build
pnpm --filter @sct/desktop run build
pnpm --filter @sct/server run test
```
Expected: 三包 typecheck 0 错；web/desktop build EXIT=0；server 测试 615/615

- [ ] **Step 2: 硬编码浅色残留全仓扫描**

```powershell
Select-String -Path "web/src/**/*.tsx","web/src/*.css" -Pattern "background: '#fff'|background: 'white'"
```
Expected: 无命中

- [ ] **Step 3: 更新 spec 状态行** → 「已实施（2026-10-XX）」+ 验证结果 + 人工目验清单

- [ ] **Step 4: 人工目验清单移交给用户**（web 无单测，观感只能人看）：5 个页面逐页对照参照项目；检查切角方向、红青描边、分隔线透明度、大小写、交互区域未被遮挡

---

## Self-Review

**Spec coverage：**
- §3 色板 → Task 1 Step 2 ✓
- §4 字体 → Task 1 Step 1/4 ✓
- §5 三层路线 → Task 1（层 1+3）+ Task 2（层 2）✓
- §6 令牌 → Task 1 Step 2/3 ✓
- §7 原语层 → Task 2 ✓
- §8 全局样式 → Task 1 Step 4 + Task 3 Step 3/4 ✓
- §9 布局 → Task 3 ✓
- §10 页面与组件 → Task 4/5/6/7/8 ✓（覆盖全部 12 个文件）
- §11 本批不做 → 已在 spec 记录，无需任务 ✓
- §13 验证 → Task 9 ✓
- §14 差异清单 → Task 2（less→css）、Task 3（sider→topnav）、Task 1 Step 1（字体复制）✓

**Placeholder scan：** 无 TBD/TODO；Task 4–8 的替换以「替换口径表」+ 具体文件动作给出，未使用「类似 Task N」省略（口径表在该任务内重述）。

**Type consistency：** `cyberColors` / `cyberFontStack` / `cyberTheme` 三个导出在 Task 1 定义，Task 3–8 引用一致；`CyberCard`/`CyberButton`/`SectionTitle`/`CyberDivider` 四个组件名与 props 在 Task 2 定义，Task 4–8 引用一致；`WAVE_COLORS` 仅在 Task 7 定义与使用。
