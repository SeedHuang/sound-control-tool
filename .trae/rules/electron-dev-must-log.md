# Electron 前后端开发:关键步骤必须加日志

> **落地**:2026-09-29
> **来源**:用户当场指令——「electron 的前后端开发,关键步骤,请求都要加日志,可以在日志页中查看」
> **触发场景**:用户实际操作 M1 全流程时发现,缺日志导致定位 bug 极慢——尤其浏览器直连模式、SSE 长连接、CORS、token 来源这些「看网络面板看不出来」的问题。

## 铁律

**任何 Electron 桌面项目里,前后端「关键步骤」和「每个请求」都要写日志,且必须能在前端「日志页」里看到。**

## 什么叫「关键步骤」(程序侧)

不是每个 `console.log` 都要留,但凡涉及下面任何一类,**必须留**:

- 进程/子进程生命周期:`app.whenReady` / 子进程 `spawn` 的 PID、`exit` 码与 `stderr` 摘要、`taskkill` 清理结果
- 跨进程握手:dev web 端口探测(port-file 读不到 / 拿到值)、`loadURL` 前后
- 鉴权/token:D12 守卫的「拒/放」、token 来源(首启动随机生成 vs 持久化复用)、`apiToken` 是否出现在请求里
- 跨源响应:SSE/`<audio>` 这种 hijacked reply 的 ACAO / Vary 头究竟写没写
- 副作用落盘:数据库 INSERT / 文件 rename / cookie 文件 materialize,记前后路径
- 长连接:EventSource 的 `open` / `error` / `close`,以及每条事件 `type` 与关键字段(`percent`、`state`、`audioId`)

## 什么叫「请求」(网络侧)

每个 HTTP 请求/响应,至少要记:

| 字段 | 必记原因 |
|---|---|
| 方法 + 路径 | 看到底是哪个路由出问题 |
| 状态码 | 一眼定位 401 / 412 / 500 |
| 来源 origin | 排查 CORS(localhost 直连 vs Electron file:// vs web) |
| token 来源(query vs header) | 排查 D12 守卫漏放 |
| 关键 body / 错误摘要(前 200 字符) | 看异常内容,不要全文塞日志 |
| 耗时(ms) | 慢请求/超时一眼可见 |

## 日志页怎么落地

M1 已有的设施,直接复用,不要另造:

- **后端**:`server/src/logs.ts` 的环形缓冲(500 条),通过 `GET /api/logs` 暴露
- **前端入口**:右下角浮动 `<LogsButton />`(已挂在 `web/src/layouts/index.tsx`),点击展开 Drawer
- **写入点**:`server/src/index.ts` 的 Fastify `onResponse` 钩子(已有 HTTP 摘要)+ 业务代码里手动 `pushLog('info', 'subsystem', '...')`

## 反例(本次真实触发)

1. **SSE 没进度条**——根因是 hijacked reply 没写 ACAO 头。curl 不查 CORS,所以光看后端日志看不出。**SSE/audio 这种 hijacked 端点,必须在响应头里塞一条「debug 级 CORS 摘要」**(origin 是否在白名单 + 实际写了哪个 ACAO 值)。
2. **B 站 412**——前两次只看 stdout 不知道 yt-dlp 实际给了什么。后改为 `(err, stdout, stderr)` 三参回调,stderr 必有,缺则降级标「(无 stderr 输出)」。
3. **空错误消息**——`Error: parse xxxx 失败:` 冒号后空。原因:`execFile` 回调没取 stderr。**永远不要相信 err.message 就够用,stderr 永远记下来。**

## 正例

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

## 自检清单(每次新增端点/子流程)

- [ ] 这个路由有 `onResponse` 钩子自动落摘要吗?(有 → 不必手写;没有 → 补一条 `pushLog`)
- [ ] hijacked reply 写了 ACAO + Vary 吗?(SSE / `<audio>` 必须手写)
- [ ] stderr 拿到了吗?(execFile 三参回调)
- [ ] 失败路径有日志吗?(catch 里写一行,否则用户看到的「失败:」会空着)
- [ ] 前端关键事件(onProgress, onStatus, onDone)触发后有 console 吗?(前端日志区也要看得到)