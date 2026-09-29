# Trae AI 工作规则(本仓库专属)

> **落地**:2026-09-29
> **触发**:Trae IDE 启动时自动加载 `.trae/rules/*.md`,所有与本仓库相关的会话均受此约束。

---

## Umi Max 约定:layout 渲染子页面必须用 `<Outlet />`

**绝对禁止**在 `src/layouts/index.tsx`(或任何 Umi 4 约定布局)里用 `{children}` 或 `{props.children}` 渲染子页面。**必须**用 `<Outlet />`。

### 真相(本次真实踩坑)

Umi 4 的 `src/layouts/index.tsx` 是**路由树里的父节点**。React Router v6(底层)规定:父路由占位必须用 `<Outlet />`。在 Umi 4 下,布局组件**不会**收到 `children` prop——它永远是 undefined。

**踩坑后果链**:
1. 菜单渲染正常(它不依赖 children)
2. 页面内容渲染进空占位 → 整片空白
3. 页面组件是 `React.lazy`,占位是空的 → 懒加载**根本不触发**
4. 全程零报错——它「正常工作」,只是往空气里渲染

### 反例(本次真实触发)

```tsx
// ❌ 致命错 — Umi 4 布局下 children 恒为 undefined
export default function GlobalLayout({ children }: { children: ReactNode }) {
  return (
    <div>
      <Menu ... />
      {children}  {/* 永远是空 */}
    </div>
  );
}
```

**症状**:菜单出来、点 tab 没反应、内容区空白、network 看不到页面 chunk 请求、console 零报错。极易被误导去查 hash、MFSU、token、CORS——全是岔路。

### 正例

```tsx
// ✅ 正确 — 参照 D:\Seed\system-c-cleaner\src\layouts\index.tsx
import { Outlet, useLocation, useNavigate } from '@umijs/max';

export default function GlobalLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <div>
      <Menu onClick={({ key }) => navigate(key)} selectedKeys={[location.pathname]} ... />
      <Outlet />  {/* Umi 4 子页面唯一正确渲染方式 */}
    </div>
  );
}
```

### 自检清单(每次新建/修改 Umi 4 布局)

- [ ] 用 `<Outlet />` 而不是 `{children}` 吗?
- [ ] 跳转用 `useNavigate()` 而不是 `window.location.hash = ...` 吗?(前者走 Umi history,后者绕过它——Umi 监听 popstate,不监听原生 hashchange)
- [ ] 高亮用 `useLocation().pathname` 而不是渲染期一次性读 `window.location.hash` 吗?

### 关联依赖

- **tsconfig paths 必须配** `umi`: `"paths": { "@/*": ["src/*"], "umi": ["src/.umi/exports.ts"] }`
  - 原因:`@umijs/max` 类型声明是 `export * from 'umi'`,但 pnpm 隔离下 `umi` 不是 web 的直接依赖,不配映射则 TS 解析不到 `useNavigate`/`useLocation` 类型。

---

## Electron 前后端开发:关键步骤必须加日志

> **落地**:2026-09-29
> **来源**:用户当场指令——「electron 的前后端开发,关键步骤,请求都要加日志,可以在日志页中查看」
> **触发场景**:用户实际操作 M1 全流程时发现,缺日志导致定位 bug 极慢——尤其浏览器直连模式、SSE 长连接、CORS、token 来源这些「看网络面板看不出来」的问题。

### 铁律

**任何 Electron 桌面项目里,前后端「关键步骤」和「每个请求」都要写日志,且必须能在前端「日志页」里看到。**

### 什么叫「关键步骤」(程序侧)

不是每个 `console.log` 都要留,但凡涉及下面任何一类,**必须留**:

- 进程/子进程生命周期:`app.whenReady` / 子进程 `spawn` 的 PID、`exit` 码与 `stderr` 摘要、`taskkill` 清理结果
- 跨进程握手:dev web 端口探测(port-file 读不到 / 拿到值)、`loadURL` 前后
- 鉴权/token:D12 守卫的「拒/放」、token 来源(首启动随机生成 vs 持久化复用)、`apiToken` 是否出现在请求里
- 跨源响应:SSE/`<audio>` 这种 hijacked reply 的 ACAO / Vary 头究竟写没写
- 副作用落盘:数据库 INSERT / 文件 rename / cookie 文件 materialize,记前后路径
- 长连接:EventSource 的 `open` / `error` / `close`,以及每条事件 `type` 与关键字段(`percent`、`state`、`audioId`)

### 什么叫「请求」(网络侧)

每个 HTTP 请求/响应,至少要记:

| 字段 | 必记原因 |
|---|---|
| 方法 + 路径 | 看到底是哪个路由出问题 |
| 状态码 | 一眼定位 401 / 412 / 500 |
| 来源 origin | 排查 CORS(localhost 直连 vs Electron file:// vs web) |
| token 来源(query vs header) | 排查 D12 守卫漏放 |
| 关键 body / 错误摘要(前 200 字符) | 看异常内容,不要全文塞日志 |
| 耗时(ms) | 慢请求/超时一眼可见 |

### 日志页怎么落地

M1 已有的设施,直接复用,不要另造:

- **后端**:`server/src/logs.ts` 的环形缓冲(500 条),通过 `GET /api/logs` 暴露
- **前端入口**:右下角浮动 `<LogsButton />`(已挂在 `web/src/layouts/index.tsx`),点击展开 Drawer
- **写入点**:`server/src/index.ts` 的 Fastify `onResponse` 钩子(已有 HTTP 摘要)+ 业务代码里手动 `pushLog('info', 'subsystem', '...')`

### 反例(本次真实触发)

1. **SSE 没进度条**——根因是 hijacked reply 没写 ACAO 头。curl 不查 CORS,所以光看后端日志看不出。**SSE/audio 这种 hijacked 端点,必须在响应头里塞一条「debug 级 CORS 摘要」**(origin 是否在白名单 + 实际写了哪个 ACAO 值)。
2. **B 站 412**——前两次只看 stdout 不知道 yt-dlp 实际给了什么。后改为 `(err, stdout, stderr)` 三参回调,stderr 必有,缺则降级标「(无 stderr 输出)」。
3. **空错误消息**——`Error: parse xxxx 失败:` 冒号后空。原因:`execFile` 回调没取 stderr。**永远不要相信 err.message 就够用,stderr 永远记下来。**

### 正例

```ts
// server/src/ytdlp/ytdlp-routes.ts(SSE 端点)
const origin = req.headers.origin;
const allowOrigin = typeof origin === 'string' && isAllowedOrigin(origin) ? origin : null;
pushLog('debug', 'sse', `open job=${id} origin=${origin ?? '(none)'} acao=${allowOrigin ?? '(none)'}`);
reply.raw.writeHead(200, {
  'content-type': 'text/event-stream',
  'access-control-allow-origin': allowOrigin ?? undefined,
  'vary': origin ? 'Origin' : undefined,
});
```

```ts
// server/src/ytdlp/parse.ts
execFile(binPath, args, (err, stdout, stderr) => {
  if (err) {
    pushLog('error', 'ytdlp.parse', `bin=${binPath} code=${err.code ?? '?'} stderr=${stderr?.slice(0, 200) || '(empty)'}`);
    return reject(mapYtdlpError(err, stderr || ''));
  }
  // ...
});
```

### 自检清单(每次新增端点/子流程)

- [ ] 这个路由有 `onResponse` 钩子自动落摘要吗?(有 → 不必手写;没有 → 补一条 `pushLog`)
- [ ] hijacked reply 写了 ACAO + Vary 吗?(SSE / `<audio>` 必须手写)
- [ ] stderr 拿到了吗?(execFile 三参回调)
- [ ] 失败路径有日志吗?(catch 里写一行,否则用户看到的「失败:」会空着)
- [ ] 前端关键事件(onProgress, onStatus, onDone)触发后有 console 吗?(前端日志区也要看得到)

---

## 删除/写入接口的文件 IO 语义

**新增的删除/写入接口,IO 失败要让接口成功**(2026-09-29 用户拍板+audio delete 真实落地)。

### 原则

| 场景 | 策略 | 理由 |
|---|---|---|
| 删磁盘文件(ENOENT) | 不抛错,log info,接口仍 200 | DB 行删了就达到用户"删了"的语义 |
| 删磁盘文件(权限/IO) | 不抛错,log warn(用 info+前缀),接口仍 200 | 同上——不让单点磁盘抖动毁掉主流程 |
| 写磁盘文件失败 | 接口返错(500),但要保留 DB 一致性(rollback) | 写入与 DB 强一致,失败要让用户重试 |

### 反例

```ts
// ❌ 致命错 — 文件缺失让接口 500
app.delete('/api/audio/:id', async (req) => {
  const row = repo.get(req.params.id);
  unlinkSync(row.file_path); // ENOENT 直接抛 500,DB 行还没删
  repo.delete(req.params.id);
  return { ok: true };
});
```

### 正例

```ts
// ✅ 正确 — 文件 IO 失败不让接口失败
const fileResult = deleteAudioFile(id, repo); // try/catch 兜底,返 { deleted, path }
repo.delete(id); // DB 删是用户期望的"删了"语义
return { ok: true, deleted: fileResult.deleted };
```

### 自检清单(每次新增删除/写文件接口)

- [ ] 文件 IO 失败时接口仍能成功吗?(删文件失败不能让接口 500)
- [ ] DB 与文件的删除顺序是 "先文件后 DB" 吗?(DB 先删就读不到 file_path 了)
- [ ] 工具函数头部写了"失败策略"吗?(便于 reviewer 一眼看清)