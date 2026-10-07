# CP2077 全站 UI 改造设计（sound-control-tool）

- 日期：2026-10-07
- 状态：**已实施**（2026-10-07）—— 实施计划见 `docs/superpowers/plans/2026-10-07-cyberpunk-ui-overhaul.md`
- 目标仓库：`d:\Seed\sound-control-tool`（`web/` 包）
- 参照实现：`D:\Seed\system-c-cleaner`（**同一 Figma 来源、已落地的 CP2077 全站改造**）

## 1 背景与目标

用户要求按 Figma 模板 **UI Kit - CP2077 (Community)** 对本站做**整体 UI 改造**。

- 参考稿：`https://www.figma.com/design/4m3pOlCOGUKEadjXbVOT4u/UI-Kit---CP2077--Community-?node-id=1-2333`
- 还原强度：**完整赛博朋克**（切角边框、Rajdhani 字体、红青撞色、扫描线纹理、发光效果、大写标题）
- 范围：**5 个页面 + 全局布局 + 7 个共享组件**（`pages/` 全部 + `layouts/index.tsx` + `components/` 全部）
- 不在范围：`server/`、`desktop/`、业务逻辑与数据流（本方案**只动外观层**）

**为什么能绕过 Figma API**：2026-10-07 取数时 Figma API 报 429（`Retry after 297113 seconds`，约 82 小时），用户席位（Viewer/Collaborator + Starter 计划）配额极低。所幸同机存在 `system-c-cleaner`——**用同一个 Figma 链接做过的同类改造**，其 spec、令牌、原语层、字体文件均可直接作为权威参照。本文所有色值/字号/形状均已与「Figma 已取到的 Color Styles 段」交叉核对（见 §3 注）。

## 2 参照来源与可信度

| 来源 | 用途 | 可信度 |
|---|---|---|
| Figma Color Styles 段（本次实际取到） | 全站色板 | **实测**（本次 API 返回原文） |
| Figma Buttons / Separators 段（本次实际取到） | 按钮基调、分隔线形态 | **实测** |
| `system-c-cleaner/docs/superpowers/specs/2026-09-22-cp2077-theme-design.md` | 排版规则、组件特征、令牌映射 | 同源实现，已落地验证 |
| `system-c-cleaner/src/setup/theme.tsx` | antd token 全量取值 | 可直接移植 |
| `system-c-cleaner/src/components/cyber/*` | Cyber 原语实现 | 可直接移植（需适配，见 §7） |
| `system-c-cleaner/src/assets/fonts/Rajdhani-*.ttf` | 字体文件（OFL，可再分发） | 直接复制 |

**本次未取到的**（Figma 429 阻塞）：完整排版刻度表、`Cards`/`Forms` 段微观形态、`icons` 图标集、`menu_bg_texture` 位图。→ 见 §11「本批不做 / 后续补」。

## 3 颜色规范（已交叉核对）

主色板（Figma Color Styles #1:2310 **实测** + 参照实现同名值一致）：

| 用途 | 值 | 说明 |
|---|---|---|
| 背景主色 | `#0E0E17` | 全局底（Figma「Primary」近黑） |
| 面板底 | `#161616` | 卡片/浮层底（Figma Separators 段底色，实测） |
| 抬升底 | `#1A1A26` | 表头/浮层 |
| 主红 | `#F75049` | 主色：选中态、强调、危险 |
| 主青 | `#5EF6FF` | 数值、链接、次强调 |
| 绿 | `#1DED83` | 成功 |
| 黄 | `#F0B537` | 警告/谨慎 |
| 橙 | `#FB932E` | 次警示（Figma Secondary/Orange，实测） |
| 蓝 | `#2570D4` | 备用 |
| 紫 | `#9D2BF5` | 备用 |
| 对比灰 | `#D6D0D0` | 装饰/代码块文字（不用作底色） |

派生值（参照实现，与 Figma 复合色一致）：

| 用途 | 值 |
|---|---|
| 卡片描边 | `rgba(94, 246, 255, 0.3)`（青 30%） |
| 卡片底 | `rgba(94, 246, 255, 0.1)`（青 10%） |
| 红描边 | `rgba(247, 80, 73, 0.5)` |
| 主分隔线 | 红 2px、opacity 0.3 |
| 卡片内分隔线 | 红 1px、opacity 0.5 |
| 正文/次文本/弱文本 | `#F0F0F0` / `rgba(255,255,255,0.6)` / `rgba(255,255,255,0.4)` |
| hover 红晕 | `rgba(247, 80, 73, 0.08)` |

## 4 字体规范

| 项 | 值 |
|---|---|
| 字体族 | **Rajdhani**（OFL 开源，本地打包，离线可用） |
| 标题 | SemiBold 600、`text-transform: uppercase`、`letter-spacing: -0.04em` |
| 正文 | Medium 500、`letter-spacing: -0.04em` |
| 发光标题 | 红 `#F75049` + `text-shadow: 0 0 14px rgba(247,80,73,0.8)` |
| 按钮字 | Rajdhani Bold 大写（Figma 原用商业字体 Blender Pro，不可打包，以 Rajdhani Bold 替代） |
| 中文字形 | Rajdhani 无 CJK → **回退**到 `Microsoft YaHei` / `PingFang SC` |

**字体栈**（唯一的完整写法）：`'Rajdhani', -apple-system, 'Segoe UI', 'Microsoft YaHei', 'PingFang SC', sans-serif`

**中英混排口径**：`uppercase` 与负字距**只对拉丁字母与数字生效**，CSS 对汉字天然无效——中文标题保持原字面，不做破坏。

## 5 技术路线

**方案 A：antd 深度换肤 + Cyber 原语层 + 全局样式**（沿用参照项目已验证的路线）。

三层：

1. **antd 主题层**：新增 `web/src/app.tsx`，用 `ConfigProvider` + `theme.darkAlgorithm` 注入令牌（见 §6）。目标项目当前**完全没有主题层**（无 `app.tsx`、无 `ConfigProvider`，antd 走默认浅色），这是本方案的第一块地基。
2. **Cyber 原语层**：新增 `web/src/components/cyber/`，提供 `CyberCard` / `CyberButton` / `SectionTitle` / `CyberDivider`（见 §7）。
3. **全局样式层**：重写 `web/src/global.css`（见 §8）。

**为什么要三层**：只换 antd token 覆盖不到自定义切角与扫描线；只写全局样式又会让 antd 组件（表格/弹窗/菜单）仍是浅色圆角。三层各管一段，互不打架。

## 6 设计令牌（新增 `web/src/setup/theme.tsx`）

从参照项目移植并按本站语义调整：

```
cyberColors = {
  bgLayout #0E0E17, bgContainer #161616, bgElevated #1A1A26,
  red #F75049, cyan #5EF6FF, green #1DED83, yellow #F0B537, orange #FB932E,
  blue #2570D4, purple #9D2BF5, contrast #D6D0D0,
  textPrimary #F0F0F0, textSecondary rgba(255,255,255,.6), textMuted rgba(255,255,255,.4),
  borderCyan rgba(94,246,255,.3), borderRed rgba(247,80,73,.5), borderWhite rgba(255,255,255,.08),
  hoverRed rgba(247,80,73,.08), cyanSoft rgba(94,246,255,.1), redSoft rgba(247,80,73,.15)
}
cyberFontStack = "'Rajdhani', sans-serif"
```

antd `cyberTheme` token（对齐参照实现）：

| token | 值 |
|---|---|
| `algorithm` | `theme.darkAlgorithm` |
| `colorPrimary` | `cyberColors.red` |
| `colorInfo` / `colorLink` | `cyberColors.cyan` |
| `colorSuccess` / `colorWarning` / `colorError` | green / yellow / red |
| `colorBgLayout` / `colorBgContainer` / `colorBgElevated` | 三档底色 |
| `colorText` / `colorTextSecondary` / `colorTextTertiary` | 三级文本 |
| `colorBorder` / `colorBorderSecondary` | `borderWhite` |
| `borderRadius` | **0**（全站方角） |
| `fontSize` / `controlHeight` | 14 / 36 |
| `fontFamily` | §4 的完整字体栈 |

components 覆盖：`Layout`（三区底）、`Menu`（`darkItemSelectedBg: red` + 方角，本站为**顶栏横向**，见 §9）、`Table`（表头 `bgElevated` + 方角 + `rowHoverBg: hoverRed`）、`Button`（去 primary 阴影）、`Modal`（内容/头底 `bgContainer`）。

## 7 Cyber 原语层（新增 `web/src/components/cyber/`）

| 组件 | 说明 | 相对参照项目的适配 |
|---|---|---|
| `CyberCard` | 切角面板。**双层法**：外层 `padding:1px` + 主色底做描边，内层同 `clip-path` 做底色。变体 cyan（默认）/ red；可选左侧竖条 | 无 |
| `CyberButton` | 切角轮廓按钮，基于 antd `Button` 包 className（保留 loading/icon/disabled 语义） | 无 |
| `SectionTitle` | Rajdhani SemiBold 大写 + 负字距；`glow` 启用红色发光 | 无 |
| `CyberDivider` | 红 2px 30% 分隔线 + 左端斜切缺口 | 无 |

**切角几何（唯一真相源）**：目标项目是**纯 CSS**（参照项目用 less 变量跨文件共享），因此改用 **CSS 自定义属性**：

```css
:root {
  --cyber-clip: polygon(12px 0, 100% 0, 100% calc(100% - 12px), calc(100% - 12px) 100%, 0 100%, 0 12px);
}
```

各处以 `clip-path: var(--cyber-clip)` 引用。这样在**不引入 less** 的前提下保住「一处定义」（若引入 less 则违反本站「不用 styled-components/保持纯 CSS」的既有惯例，且多一个构建依赖）。

**文件形态**：`cyber/index.tsx` + `cyber/cyber.css`（参照项目为 `cyber.less`，此处改 `.css`）。

## 8 全局样式（重写 `web/src/global.css`）

保留原有动效口径（`sct-card` 悬停/按压/减弱动效，见文件头注释），新增：

- `:root` → `--cyber-clip` 常量
- `body` 底色 `#0E0E17`、文字 `#F0F0F0`
- Rajdhani 5 个 `@font-face`（Light 300 / Regular 400 / Medium 500 / SemiBold 600 / Bold 700），`font-display: swap`
- **扫描线覆盖层**：`.cyber-app::after` fixed 全屏 `repeating-linear-gradient(transparent 0 3px, rgba(255,255,255,0.015) 3px 4px)`，`pointer-events:none`、`z-index:9999`
- 滚动条：8px 方形，thumb `#2A2A38`，hover `#F75049`
- **antd 浮层方角化**：`.ant-modal-content` / `.ant-dropdown-menu` / `.ant-select-dropdown` / `.ant-popover-inner` / `.ant-message-notice-content` / `.ant-tooltip-inner` / `.ant-picker-panel-container` → `border-radius: 0 !important`

## 9 布局改造（`web/src/layouts/index.tsx`）

**本站是顶部横向导航**（参照项目是左侧 Sider）——这是移植的主要差异点：

- 根节点加 `className="cyber-app"`（挂扫描线层）
- 布局三区底色 `#0E0E17`（现有顶栏写死的 `background:'#fff'`、`borderBottom:'1px solid rgba(5,5,5,.06)'` 全部替换）
- 顶栏下缘：红色 `CyberDivider` 或 1px 红 30% 线，替代现有浅灰分隔
- **Menu 选中态**（横向）：选中项红色背景 + `clip-path: var(--cyber-clip)` 切角 + 白字；未选中 `textSecondary`、hover 提亮为 `textPrimary`（对齐参照项目侧栏选中态，改横向尺寸）
- 右侧「任务抽屉入口 + 日志按钮」：图标按钮改造为 cyber 风格（方角、hover 红晕）
- 顶部标题/品牌区：Rajdhani 大写

## 10 页面与共享组件改造

| 文件 | 行数 | 主要改动 |
|---|---|---|
| `pages/index.tsx` | 132 | 标题改 `SectionTitle`；卡片改 `CyberCard`；动作按钮改 `CyberButton` |
| `pages/library.tsx` | 597 | 卡片墙 = `CyberCard`（保留 `sct-card` 动效）；筛选项方角；数值/时长用青 Rajdhani |
| `pages/studio.tsx` | 383 | 作品列表卡片换肤；新建作品弹窗（`NewWorkModal`）改 cyber 表单 |
| `pages/studio-detail.tsx` | **1445** | 最大的一个：工具栏/时间轴容器/侧栏全部换肤；**时间轴与波形的配色必须重调**（见下） |
| `pages/settings.tsx` | 385 | 一摞 `Card` → `CyberCard`；表单控件方角化；危险操作按钮用 red 变体 |
| `components/PageHeader.tsx` | 54 | 写死的 `#fff` / `rgba(0,0,0,.45)` 全部换成令牌；标题 Rajdhani |
| `components/LogsButton.tsx` | 124 | 抽屉与按钮换肤 |
| `components/NewWorkModal.tsx` | 171 | 弹窗换肤（方角、深底） |
| `components/SiteLogo.tsx` | 42 | 平台 logo 换色适配深底 |
| `components/TaskDrawer.tsx` | 159 | 任务抽屉换肤；状态色改用语义色（进行中青/成功绿/失败红/取消灰） |
| `components/WorkPreview.tsx` | 155 | 预览卡换肤 |
| `components/TimelineWave.tsx` | 253 | **Canvas 自绘**：波形与网格线目前是硬编码颜色，必须改为 CP2077 色（波形青 `#5EF6FF`、背景 `#0E0E17`、网格 `rgba(255,255,255,.06)`、静音基线灰） |

**⚠️ `studio-detail.tsx`（1445 行）+ `TimelineWave.tsx` 是本批风险最高的两块**：前者含大量内联样式与手势逻辑，后者是 Canvas 绘制（颜色写在 JS 里，不走 CSS）。改它俩时必须**只改颜色/字体，不碰交互与几何**。

## 11 本批不做 / 后续补（Figma 429 造成的缺口）

| 项 | 状态 | 补的时机 |
|---|---|---|
| 完整排版刻度表（各级字号/行高精确定义） | 本批用参照实现的近似值 | Figma 额度恢复后校准 |
| `Cards` / `Forms` 段的微观形态 | 本批按 CyberCard/方角表单近似 | 同上 |
| `icons` 图标集（自定义赛博图标） | 本批沿用 `@ant-design/icons` | 同上 |
| `menu_bg_texture` 背景位图 | 本批用 CSS 扫描线替代（参照项目同做法） | 若确需，额度恢复后下载 |
| 自定义赛博光标、故障（glitch）动效 | 未在 Figma 取证 | 用户后续指定 |

## 12 风险与缓解

| 风险 | 缓解 |
|---|---|
| antd 暗色算法与红青配色局部对比度不足 | 数值/正文用青 `#5EF6FF` 与 `#F0F0F0`，标签用红；均高于 WCAG 基线（参照项目已实证） |
| 1445 行的 `studio-detail.tsx` 改动面大、易误伤交互 | 只动颜色/字体/形状，**不动手势、布局几何、数据流**；分任务实施，每任务后立即 typecheck |
| `TimelineWave` 为 Canvas，颜色在 JS 内硬编码 | 单列一个任务，颜色抽为常量后再用主题色 |
| 扫描线覆盖层遮挡交互 | `pointer-events: none`（参照项目已实证） |
| clip-path 在 Electron 渲染异常 | 项目 Electron/Chromium 较新，支持多年；参照项目已实证 |
| 无 `app.tsx` 时 ConfigProvider 接入方式 | Umi 4 用 `src/app.tsx` 的 `rootContainer` 包裹（本批新建） |
| 字体文件遗漏权重 | 5 个权重全部复制，`@font-face` 逐一声明 |

## 13 验证

1. 每步编辑后：`pnpm --filter @sct/web run typecheck`（对应 `tsc --noEmit`）
2. 全量：`pnpm --filter @sct/web run build`（EXIT=0）
3. **人工目验**（web 无单测，最终观感只能人看）：5 个页面逐页对照参照项目 `system-c-cleaner` 的观感，检查切角方向、红青描边、分隔线透明度、字体大小写
4. 回归确认：剪映/导出/下载等**交互行为逐个过一遍**（本批不动逻辑，但改样式可能误伤可点击区域与 z-index）

## 14 与参照项目的差异清单（照抄会错的地方）

| # | 差异 | 处理 |
|---|---|---|
| 1 | 导航：Sider → **顶栏横向** | 菜单选中态样式改横向形态 |
| 2 | 样式语言：less → **纯 CSS** | 切角常量改 `--cyber-clip` CSS 变量；`cyber.less` → `cyber.css` |
| 3 | 字体文件位置：`src/assets/fonts/` | 需**复制**到本站同路径（含 5 个 ttf） |
| 4 | 主题入口：已有 `setup/theme.tsx` → **本站没有** | 新建 `app.tsx` + `setup/theme.tsx` |
| 5 | 页面集完全不同 | 逐页按 §10 映射，不照搬 |
| 6 | 本站有 Canvas 波形（参照项目没有） | 单列任务，JS 内颜色抽常量 |

## 15 实施结果（2026-10-07）

### 新增文件

| 文件 | 作用 |
|---|---|
| `web/src/app.tsx` | Umi 4 运行时配置：`rootContainer` 注入 `ConfigProvider`（项目此前无主题层） |
| `web/src/setup/theme.tsx` | `cyberColors` / `cyberFontStack` / `cyberTheme` |
| `web/src/components/cyber/index.tsx` + `cyber.css` | Cyber 原语层（`CyberCard` / `CyberButton` / `SectionTitle` / `CyberDivider`） |
| `web/src/assets/fonts/Rajdhani-{Light,Regular,Medium,SemiBold,Bold}.ttf` | 字体（自参照项目复制，OFL） |

### 改动文件

`global.css`（重写，保留原动效段）、`layouts/index.tsx`、`components/` 下 7 个（`PageHeader` / `SiteLogo` / `LogsButton` / `NewWorkModal` / `TaskDrawer` / `WorkPreview` / `TimelineWave`）、`pages/` 全部 5 个。

### 验证（终态实测，取数命令随数字一并写出）

| 项 | 结果 | 取数命令 |
|---|---|---|
| 三包 typecheck | **0 错** | `pnpm -r run typecheck` |
| web build | **EXIT=0** | `pnpm --filter @sct/web run build` |
| desktop build | **EXIT=0** | `pnpm --filter @sct/desktop run build` |
| server 测试（本批未改 server，跑一次取证） | **615/615 绿（45 文件）** | `cd server; npm test` |
| 硬编码浅色残留扫描 | **0 命中** | `Select-String -Path "web/src/**/*.tsx" -Pattern "background: '#fff'\|rgba\(5, ?5, ?5\|#1677ff\|#f0f0f0"` |

### 两处实施中的偏差（如实记录）

1. **时间轴刻度**：spec §10 提到「波形与网格线配色重调」，实施时确认 `TimelineWave.tsx` **本就没有网格线绘制**，故 `WAVE_COLORS` 只保留实际使用的三项（背景 / 波形 / 失败占位），未为不存在的绘制新增代码。
2. **首页标题**：spec §10 建议首页标题改 `<SectionTitle glow>`，但该页文件头有既有纪律「首页不出现与导航 Tab 重名的标题」，故未新增页面级标题，只把区块标题改为 `<SectionTitle>`。

### 待人工目验（程序侧验不了，移交用户）

web 端**无单测**，最终观感只能人眼验。清单见 `docs/after/cyberpunk-ui-visual-acceptance-open-decisions.md`。
