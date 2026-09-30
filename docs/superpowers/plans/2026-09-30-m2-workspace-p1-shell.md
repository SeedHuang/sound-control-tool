# P1 · 外壳（IA / 改名 / 页面头 / 滚动收口）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把应用的骨架换成"首页 / 资料库 / 剪辑室 / 设置"，页面头统一成两行（标题行 + 工具栏行）、固定在顶部，滚动全部收进各页自己的容器。

**Architecture:** 纯前端改造，不动后端、不动数据库。做法是三步：① 先立一个共用组件 `PageHeader`；② 把"公共内容区滚动"改成"每页自管滚动"；③ 再把两个页面的**文件名与路由互换**（`acquire`→`library` 资料库、`library`→`studio` 剪辑室），并新增 `/studio/:importId` 占位页。本阶段**不删**"音频/视频"切换器（只把它从独占一行挪进工具栏），避免出现"视频模式点不到"的功能真空——换成"产物类型 Radio"是 P2 的事。

**Tech Stack:** UmiJS Max 4（hash 路由）+ React 18 + antd 5 + TypeScript。**web 包没有测试框架**（`web/package.json` 只有 `dev` / `build` / `typecheck`），所以本阶段的每一步验证是 `typecheck` + `build` + 浏览器目验——这与仓库既有做法一致。

**Spec:** `docs/superpowers/specs/m2-workspace.md`（本计划实现其中的 **P1 · 外壳**、D1/D2/D3/D11，以及 §0.6 验收 1/2/3）

## Global Constraints

- 页面地图与命名（D1）：首页 `/`、资料库 `/library`、剪辑室 `/studio`、剪辑详情 `/studio/:importId`、设置 `/settings`；导航四项。
- 页面头（D2）：两行 —— ① 平台 logo + 标题 + 元信息 ② 工具栏；**固定不滚**。设置页用简化形态（无工具栏行）。
- 滚动（D3）：layout 内容区不再滚（`overflow:hidden`）；**每页根容器 `height:100% / minHeight:0`，超出的部分由页内自己的容器滚**。
- **禁止**用 `{children}` 渲染 Umi 4 布局子页面，必须 `<Outlet />`。
- **禁止并行对同一个文件发两次编辑**；每步编辑后从磁盘读回核对。
- 编辑完成后必须跑 `pnpm --filter @sct/web typecheck`；本阶段末尾跑一次 `pnpm --filter @sct/web build`。
- **不做 git 写操作**（仓库规则）：文件改名用"写新文件 + 删旧文件"，不要用 `git mv` / `git add`。
- 列表空态一律 antd `Empty`；破坏性按钮必须 `Modal.confirm`（本阶段无新增破坏性按钮）。
- 样式：`styled.*` 若需要，必须放独立 `sc.tsx`；本阶段用内联 style 即可，不新建 sc 文件。
- 路径写法：项目级资源用 `@/`；同目录/邻近用相对路径。

---

### Task 1: 建共用组件 `PageHeader`

**Files:**
- Create: `web/src/components/PageHeader.tsx`

**Interfaces:**
- Consumes: 无
- Produces: `export interface PageHeaderProps { icon?: ReactNode; title: ReactNode; meta?: ReactNode; toolbar?: ReactNode }`；`export default function PageHeader(props: PageHeaderProps): JSX.Element`

- [ ] **Step 1: 写组件**

```tsx
// web/src/components/PageHeader.tsx
// 统一页面头(spec m2-workspace D2):① 平台 logo + 标题 + 元信息(右)  ② 工具栏。
// 固定不滚:调用方把它作为 flex 列的**第一个 flexShrink:0** 子项,滚动交给后面的内容容器。
// toolbar 不传 → 不渲染第二行(设置页用这个简化形态)。
import type { ReactNode } from 'react';

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
        background: '#fff',
        borderBottom: '1px solid rgba(5, 5, 5, 0.06)',
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
            lineHeight: '24px',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {title}
        </div>
        {meta !== undefined && (
          <div style={{ flexShrink: 0, fontSize: 12, color: 'rgba(0, 0, 0, 0.45)' }}>{meta}</div>
        )}
      </div>
      {toolbar !== undefined && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
          {toolbar}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: 类型检查**

Run: `pnpm --filter @sct/web typecheck`
Expected: 通过（无输出）。若报 `Cannot find module` 之类，检查路径是否写错。

- [ ] **Step 3: 从磁盘读回核对**

用 Read 打开 `web/src/components/PageHeader.tsx`，确认内容与上面一致（尤其是 `toolbar !== undefined` 这个判断——用 `!== undefined` 而不是 `&&`，因为空的工具栏行也不该出现）。

- [ ] **Step 4: 提交**

```bash
git add web/src/components/PageHeader.tsx
git commit -m "feat(web): 新增统一页面头组件 PageHeader"
```

---

### Task 2: 滚动收口 —— layout 不滚，各页自管

**Files:**
- Modify: `web/src/layouts/index.tsx`
- Modify: `web/src/pages/index.tsx`（首页：现在完全没有自己的滚动容器）
- Modify: `web/src/pages/settings.tsx`（设置页：现在靠公共容器滚）

**Interfaces:**
- Consumes: 无
- Produces: 约定 —— **每个页面组件的最外层必须是 `height:100% / minHeight:0` 的 flex 列，并且自己负责滚动**。后续所有页面的 P2–P5 改造都落在这个约定上。

- [ ] **Step 1: layout 内容区改为不可滚**

把 `web/src/layouts/index.tsx` 里这一行：

```tsx
      {/* 内容区:minHeight 0 是 flex 子项允许收缩、内部滚动生效的关键 */}
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        <Outlet /> {/* Umi 4 子页面唯一正确渲染方式(参考项目同款) */}
      </div>
```

改成：

```tsx
      {/* 内容区(spec m2-workspace D3):这里**不再滚**——滚动交给每个页面自己的容器。
          留 overflow:hidden 是为了把"页面超出"这件事挡在内容区里,不让它顶到 body。
          minHeight 0 是 flex 子项允许收缩的关键,少了它子页面的 height:100% 会失效。 */}
      <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
        <Outlet /> {/* Umi 4 子页面唯一正确渲染方式(参考项目同款) */}
      </div>
```

- [ ] **Step 2: 首页加自己的滚动容器**

把 `web/src/pages/index.tsx` 的 `return` 整块改成（保留既有的健康检查逻辑与状态，不动 `useEffect`）：

```tsx
  return (
    /* 首页自管滚动(spec D3):根容器锁死高度,超出的部分由内部这层滚 */
    <div style={{ height: '100%', minHeight: 0, overflowY: 'auto', padding: 16 }}>
      <Card title="首页">
        {error && <Alert type="error" showIcon message="无法连接本地服务" description={error} />}
        {!error && !health && <Spin />}
        {!error && health && ok && (
          <Typography.Text>
            后端 OK · SQLite 读写成功 · API 端口 {health.port}
          </Typography.Text>
        )}
        {!error && health && !ok && (
          <Alert
            type="error"
            showIcon
            message="后端异常"
            description={`health.ok=${String(health.ok)}, sqlite=${String(health.sqlite)}`}
          />
        )}
      </Card>
    </div>
  );
```

- [ ] **Step 3: 设置页加自己的滚动容器**

把 `web/src/pages/settings.tsx` 里 `SettingsPage` 的 `return` 最外层那一行：

```tsx
    <div style={{ margin: 16 }}>
```

改成：

```tsx
    /* 设置页自管滚动(spec D3):锁死高度 + 自己滚,不再依赖布局的内容区 */
    <div style={{ boxSizing: 'border-box', height: '100%', minHeight: 0, overflowY: 'auto', padding: 16 }}>
```

> 注意：`boxSizing: 'border-box'` 不能省。本仓库没有全局 reset，`div` 默认 `content-box`，`height:100% + padding` 会高出外框那 32px、凭空多出一条滚动条（`library.tsx` 顶部注释记着这个坑）。

- [ ] **Step 4: 类型检查 + 构建**

Run: `pnpm --filter @sct/web typecheck`
Expected: 通过。
Run: `pnpm --filter @sct/web build`
Expected: 构建成功。

- [ ] **Step 5: 浏览器目验（关键验收点）**

启动 `pnpm dev`，在四个页面各滚到底，确认：
- 顶栏（首页/资料库/剪辑室/设置）**始终不动**；
- `<body>` 不出现滚动条（DevTools 里 `document.body.scrollHeight === document.body.clientHeight`）。

- [ ] **Step 6: 提交**

```bash
git add web/src/layouts/index.tsx web/src/pages/index.tsx web/src/pages/settings.tsx
git commit -m "refactor(web): 滚动收口——布局不滚,各页自管滚动"
```

---

### Task 3: 文件名与路由互换（获取→资料库、音频库→剪辑室）+ 详情占位页

**Files:**
- Create: `web/src/pages/studio.tsx`（内容 = 现在的 `library.tsx`，即音频库）
- Delete: `web/src/pages/library.tsx`（旧音频库，内容已搬到 studio.tsx）
- Create: `web/src/pages/library.tsx`（内容 = 现在的 `acquire.tsx`，即获取）
- Delete: `web/src/pages/acquire.tsx`
- Create: `web/src/pages/studio-detail.tsx`（剪辑详情占位）
- Modify: `web/.umirc.ts`

**Interfaces:**
- Consumes: `PageHeader`（Task 1）
- Produces: 路由 `/library`（资料库）、`/studio`（剪辑室）、`/studio/:importId`（剪辑详情）。P2 只改 `pages/library.tsx`；P3 只改 `pages/studio.tsx`；P4 只改 `pages/studio-detail.tsx`。

> **为什么顺序不能反**：两个文件要互换名字，必须先把"音频库"搬去 `studio.tsx` 并删掉 `library.tsx`，再把"获取"写进 `library.tsx`。反了会互相覆盖。

- [ ] **Step 1: 把音频库搬成剪辑室**

1. Read `web/src/pages/library.tsx` 全文。
2. Write 到新路径 `web/src/pages/studio.tsx`，并**同步把其中所有"音频库"字样改成"剪辑室"**。需要改的具体位置（以当前文件为准）：
   - 第 1 行的文件头注释：`// web/src/pages/library.tsx(音频库)` → `// web/src/pages/studio.tsx(剪辑室)`
   - 空态文案：`'暂无音频,先去获取页下载吧'` → `'暂无音频,先去资料库下载吧'`
3. 其余逻辑（搜索 / 分页 / 分组 / 删除 / 播放）**一行都不改**——封面、"编辑"入口、默认分组是 P3 的事。
4. Delete `web/src/pages/library.tsx`。
5. Read `web/src/pages/studio.tsx` 核对：文件头是 `studio.tsx(剪辑室)`、空态是"先去资料库下载吧"、其余与原文一致。

- [ ] **Step 2: 把获取搬成资料库**

1. Read `web/src/pages/acquire.tsx` 全文。
2. Write 到 `web/src/pages/library.tsx`，并**把"获取页"相关字样改成"资料库"**。具体改：
   - 第 1 行文件头：`// web/src/pages/acquire.tsx(获取页 2026-09-29 重构:...)` → `// web/src/pages/library.tsx(资料库 2026-09-30:P1 仅改名搬文件,职责仍是"只负责下载")`
   - 组件名 `AcquirePage` → `LibraryPage`
   - 确认弹窗文案 `'会一并删除该来源的视频素材文件（已剪出的音频不受影响）。'` **保持不动**（P2 会改成含"剪辑工程也会删"，本阶段不提前改）
3. Delete `web/src/pages/acquire.tsx`。
4. Read `web/src/pages/library.tsx` 核对。

- [ ] **Step 3: 新建剪辑详情占位页**

```tsx
// web/src/pages/studio-detail.tsx
// 剪辑详情页 —— P1 只放占位(spec m2-workspace §0.5:P4 才实现时间轴/多段/保存/导出)。
// 之所以 P1 就建它:导航高亮与路由结构先立起来,后面 P4 只往这个文件里填。
import { Button, Empty } from 'antd';
import { useNavigate, useParams } from '@umijs/max';
import PageHeader from '@/components/PageHeader';

export default function StudioDetailPage() {
  const { importId } = useParams<{ importId: string }>();
  const navigate = useNavigate();
  return (
    <div style={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <PageHeader
        title={`剪辑详情（来源 #${importId ?? '?'}）`}
        meta="P4 实现"
        toolbar={<Button onClick={() => navigate('/studio')}>返回剪辑室</Button>}
      />
      <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Empty description="剪辑工作台将在 P4 落地（时间轴 + 多剪辑点 + 保存 + 导出）" />
      </div>
    </div>
  );
}
```

- [ ] **Step 4: 更新路由表**

把 `web/.umirc.ts` 的 `routes` 改成：

```ts
  routes: [
    { path: '/', component: 'index' },
    { path: '/library', component: 'library' },       // 资料库(原 acquire)
    { path: '/studio', component: 'studio' },         // 剪辑室(原 library)
    { path: '/studio/:importId', component: 'studio-detail' },
    { path: '/settings', component: 'settings' },
  ],
```

- [ ] **Step 5: 类型检查 + 构建**

Run: `pnpm --filter @sct/web typecheck`
Expected: 通过。
Run: `pnpm --filter @sct/web build`
Expected: 构建成功（若报"找不到 pages/library"，说明 Step 2 的写入没落盘，回到 Step 2 重做）。

- [ ] **Step 6: 目验**

`pnpm dev` 后逐个直接访问 hash 路由，确认都能出页面、控制台无报错：
- `#/` 首页、`#/library` 资料库（左来源列表 + 集数网格）、`#/studio` 剪辑室（原音频库内容）、`#/studio/1` 剪辑详情占位、`#/settings` 设置。

- [ ] **Step 7: 提交**

```bash
git add web/src/pages/ web/.umirc.ts
git status --short
git commit -m "refactor(web): 页面与路由互换——获取→资料库、音频库→剪辑室,新增剪辑详情占位页"
```

> `git add <目录>` 会把该目录下的**删除**一并暂存（git 2.0+ 的行为），所以不必单独处理被删的 `acquire.tsx` / 旧 `library.tsx`。`git status --short` 应能看到两条 `D` 与三条 `A`/`M`。

---

### Task 4: 导航改名 + 高亮跟随子路由

**Files:**
- Modify: `web/src/layouts/index.tsx`

**Interfaces:**
- Consumes: Task 3 的路由
- Produces: 无（纯 UI）

- [ ] **Step 1: 改导航项**

把 `NAV_ITEMS` 改成：

```tsx
const NAV_ITEMS = [
  { key: '/', label: '首页' },
  { key: '/library', label: '资料库' },
  { key: '/studio', label: '剪辑室' },
  { key: '/settings', label: '设置' },
];
```

- [ ] **Step 2: 让 `/studio/:importId` 也高亮"剪辑室"**

把这一行：

```tsx
  const selected = NAV_ITEMS.find((i) => i.key === location.pathname)?.key ?? '/';
```

改成：

```tsx
  // 子路由也要高亮父项:`/studio/12` 必须让"剪辑室"亮起来(否则详情页看不出自己在哪个板块)。
  // 首页用精确匹配,避免它把任何路径都吃掉。
  const selected =
    NAV_ITEMS.find((i) => (i.key === '/' ? location.pathname === '/' : location.pathname.startsWith(i.key)))?.key ?? '/';
```

- [ ] **Step 3: 类型检查 + 目验**

Run: `pnpm --filter @sct/web typecheck`
Expected: 通过。
浏览器里进 `#/studio/1`，确认顶部"剪辑室"是选中态。

- [ ] **Step 4: 提交**

```bash
git add web/src/layouts/index.tsx
git commit -m "feat(web): 导航改名并支持子路由高亮"
```

---

### Task 5: 资料库接入 `PageHeader` —— 把顶部那条空横带用起来

**Files:**
- Modify: `web/src/pages/library.tsx`（Task 3 建出来的资料库页）

**Interfaces:**
- Consumes: `PageHeader`（Task 1）
- Produces: 资料库页的 DOM 结构约定 —— **页面头（固定）+ 主体（左来源列表 / 右内容，各管各滚）**。P2 会在这个骨架上把工具栏换成"产物类型 Radio + 格式/档位 + 下载 + 删除来源"，并让集数网格对音频/视频共用。

> **本任务要解决的正是用户第一条抱怨**：现在顶部单独占一行放一个**左对齐**的 Segmented（约 52px 高），它右边整片空着；下面内容区自己还加 16px 内边距 —— 两段叠一起，顶部约 68px 只放了一个小控件。
>
> **本任务只做"搬家"**：把 Segmented 挪进新的工具栏行（**行为完全不变**），并把来源标题 + logo 抬到标题行。把 Segmented 换成"产物类型 Radio"是 P2。

- [ ] **Step 1: 改 `return` 的骨架**

打开 `web/src/pages/library.tsx`（Task 3 从 `acquire.tsx` 搬过来的那份）。**只做下面三处改动，文件里其它 JSX 一行都不要动。**

**改动 ①：删掉独占一行的 Segmented。** 找到这一块（在 `return (` 之后、左列表那个 `<div style={{ display: 'flex', flex: 1, minHeight: 0 }}>` 之前）：

```tsx
      <Segmented
        value={mode}
        onChange={(v) => { setMode(v as 'audio' | 'video'); setError(null); setDone(null); }}
        options={[{ value: 'audio', label: '下载音频' }, { value: 'video', label: '视频预览剪音频' }]}
        style={{ alignSelf: 'flex-start', margin: '12px 16px 8px' }}
      />
```

整块删掉 —— 它要搬到页面头的工具栏里（见改动 ②）。

**改动 ②：在改动 ① 删掉的位置，插入页面头。**

```tsx
      {/* 页面头(spec D2):① 来源 logo + 标题 ② 工具栏。
          模式切换暂时放在工具栏里,行为与改造前完全一致;P2 再把它换成"产物类型 Radio"。 */}
      <PageHeader
        icon={detail === null ? undefined : <SiteLogo site={detail.site} size={20} />}
        title={detail === null ? '资料库' : detail.title}
        meta={
          detail !== null && detail.duration_sec !== null
            ? `时长 ${Math.floor(detail.duration_sec / 60)} 分 ${Math.round(detail.duration_sec % 60)} 秒`
            : undefined
        }
        toolbar={
          <Segmented
            value={mode}
            onChange={(v) => { setMode(v as 'audio' | 'video'); setError(null); setDone(null); }}
            options={[{ value: 'audio', label: '下载音频' }, { value: 'video', label: '视频预览剪音频' }]}
          />
        }
      />
```

**改动 ③：卡片不再重复显示标题与时长。** 找到右栏里 `<Card ...>` 的开头：

```tsx
            <Card
              title={<Space><SiteLogo site={detail.site} size={18} /><span>{detail.title}</span></Space>}
              extra={(
```

把 `title={...}` 改成 `title={null}`；`extra={(` 及其后的按钮**保持原样不动**（P2 才把整套动作搬进工具栏）：

```tsx
            <Card
              title={null}   /* 标题已抬到页面头(D2),卡里不再重复 */
              extra={(
```

再把**卡片内容区**里这段"时长"文案整块删掉（同一条信息已作为页面头的 `meta` 显示）：

```tsx
              {detail.duration_sec !== null && (
                <Typography.Text type="secondary" style={{ flexShrink: 0 }}>
                  时长 {Math.floor(detail.duration_sec / 60)} 分 {Math.round(detail.duration_sec % 60)} 秒
                </Typography.Text>
              )}
```

**右栏外层那个 `<div style={{ flex: 1, minWidth: 0, padding: 16, display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}>` 的 `padding: 16` 保持不动** —— 它给的是卡片四周的留白，跟"顶部空一截"无关。那条空白的成因是改动 ① 删掉的那一整行。

> **为什么这样就能消掉顶部空白**：原来顶部单独占一行只放一个**左对齐**的 Segmented（约 52px 高），它右边整片空着；现在这一行换成页面头 —— 左边 logo + 标题、右边元信息，再下一行放工具栏。同样的高度开始承载信息，不再是空带。

- [ ] **Step 2: 补 import**

把 `web/src/pages/library.tsx` 顶部的 import 里补上（**和上面的改动放在同一次编辑里，绝不分两步**，否则 import 会被覆盖丢失）：

```tsx
import PageHeader from '@/components/PageHeader';
```

若 `Space` 因为删掉了 Card title 而不再被使用，把它从 antd 的 import 列表里一并去掉（`typecheck` 会告诉你 `'Space' is declared but its value is never read`）。

- [ ] **Step 3: 类型检查**

Run: `pnpm --filter @sct/web typecheck`
Expected: 通过。常见报错与处置：`Cannot find name 'Space'` → 说明 `Space` 还在用，把它加回 import；`'Space' is declared but never read` → 从 import 里删掉。

- [ ] **Step 4: 目验（验收锚点 3 的核心）**

浏览器里打开资料库页，逐条确认：
- 顶部**不再有一整条空白横带**；来源标题与 logo 在左上，模式切换在其下方那一行；
- 左侧来源列表、右侧集数网格各自能独立滚到底，**页面头纹丝不动**；
- 切到"视频预览剪音频"模式，`VideoClipPanel` 照常出现并能用（**行为与改造前一致**）。

- [ ] **Step 5: 提交**

```bash
git add web/src/pages/library.tsx
git commit -m "feat(web): 资料库接入统一页面头,消除顶部空白横带"
```

---

### Task 6: 全站改名清扫 + 阶段验收

**Files:**
- Modify: 视扫描结果而定（预期命中：`web/src/pages/studio.tsx`、`web/src/pages/settings.tsx`、`server/src/media/media-routes.ts`、`web/src/components/VideoClipPanel.tsx`）

**Interfaces:**
- Consumes: Task 3–5 的改名结果
- Produces: 无

> 仓库规则《落地完成后，回头扫一遍所有"声明它的地方"》。改名是典型的"声明散落各处"的改动。

- [ ] **Step 1: 扫描**

Run: `Get-ChildItem web,server,desktop -Recurse -File -Include *.ts,*.tsx,*.css | Select-String -Pattern '获取页|获取'`

再跑一次：

Run: `Get-ChildItem web,server,desktop -Recurse -File -Include *.ts,*.tsx,*.css | Select-String -Pattern '音频库'`

- [ ] **Step 2: 逐条对照现状改**

**预期的命中与改法**（以扫描实际结果为准，不要漏）：

| 位置 | 现状 | 改成 |
|---|---|---|
| `server/src/media/media-routes.ts` 的 `FILE_MISSING` 分支 | `next: '回到获取页重新下视频'` | `next: '回到资料库重新下视频'` |
| `web/src/pages/studio.tsx` 空态 | `'暂无音频,先去资料库下载吧'` | Task 3 已改；此处核对无遗漏 |
| `web/src/pages/settings.tsx` 里提到"音频库/获取"的说明文字 | 例如"看日志请点右下角…"之类 | 按现状改成新页面名 |
| `web/src/components/VideoClipPanel.tsx` 注释 | 提到"获取页" | 改成"资料库"（**只改注释**，逻辑不动 —— 它的重做在 P2） |

> **不要改**：`docs/` 下的 PRD / spec / 规则文档正文。按 spec §0.8 验收 2，本次验收范围限定为**应用界面与用户可见文案**；历史文档的回写是 spec §0.13 的事，单独一批做。

- [ ] **Step 3: 改完复扫一遍**

重跑 Step 1 的两条命令，确认在 `web/`、`server/`、`desktop/` 范围内**不再有**用户可见的"获取页 / 音频库"字样（注释里的历史说明允许保留，但要在同一行注明"（历史名）"）。

- [ ] **Step 4: 阶段验收（对照 spec §0.8）**

- [ ] **[自]** `pnpm typecheck` 通过
- [ ] **[自]** `pnpm --filter @sct/web build` 通过
- [ ] **[人]** 导航四项 = 首页 / 资料库 / 剪辑室 / 设置
- [ ] **[人]** 应用界面与用户可见文案里不再出现"获取""音频库"
- [ ] **[人]** 四页滚动各自独立：任一处滚到底，顶栏与页面头都不动
- [ ] **[人]** 资料库：视频模式仍可用（P1 不留功能真空）

- [ ] **Step 5: 提交**

```bash
git add -u web/ server/ desktop/
git commit -m "chore: 全站文案随页面改名清扫(获取→资料库 / 音频库→剪辑室)"
```

---

## Self-Review

**1. Spec 覆盖**
- D1 页面地图与去 tab → Task 3（路由）+ Task 4（导航）。⚠️ **去 tab 只做了一半**：spec 的 P1 原文是"删掉 Segmented"，但本计划把它改成"挪进工具栏、行为不变"，删掉它并换成"产物类型 Radio"归 P2。**因此我已同步修订 spec 的 P1 段**（把"删掉"改为"挪进工具栏"）—— 若你更希望 P1 就删干净，需要把"产物类型 Radio"提前到 P1，那会让 P1 与 P2 的边界糊掉，不建议。
- D2 页面头 → Task 1 + Task 5（资料库）+ Task 3 Step 3（详情占位页已用上）。设置页的"简化形态"体现在 Task 2 Step 3（只加滚动容器，不加头）——**设置页的 PageHeader 留到 P2**，因为 P1 给设置页加两行头没有实际收益（没有工具栏可放）。
- D3 滚动收口 → Task 2。
- D11 改名清扫 → Task 6。
- §0.7 手工目验"顶部不再空一截" → Task 5 Step 4。

**2. Placeholder 扫描**：无 TBD / TODO；所有代码步骤都给了可直接粘贴的代码。

**3. 类型一致性**：`PageHeader` 的 props 名（`icon` / `title` / `meta` / `toolbar`）在 Task 1 定义，在 Task 3 与 Task 5 使用，三处一致；`studio-detail.tsx` 用 `PageHeader` 时只传了 `title` / `meta` / `toolbar`（`icon` 可选，未传合法）。

**4. 遗漏自查发现的偏差（已在上文标注）**：设置页的 PageHeader 延到 P2；"删 Segmented"降级为"挪位置"。两处都已在 spec 或本 Self-Review 中写明理由，避免执行者照 P1 原文去删而制造功能真空。

---

## 后续计划（不在本文件）

- P2 · 资料库（下载统一）：独立计划
- P3 · 剪辑室（原音频库）：独立计划
- P4 · 剪辑详情页（时间轴 + 多段 + 保存 + 导出）：独立计划
- P5 · 首页：独立计划
