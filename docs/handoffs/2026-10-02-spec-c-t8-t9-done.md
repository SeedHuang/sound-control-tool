# Session 交接：sound-control-tool → Spec C T8+T9 完成，余 T10/T11（2026-10-02）

## 元信息

| 键 | 值 |
|---|---|
| 交接时间 | 2026-10-02 04:20（Asia/Shanghai，+08:00） |
| 项目根 | `d:\Seed\sound-control-tool` |
| HEAD | `1b52cc0`（T6+T7，用户已提交）；工作树 **6 项未提交** |
| 验证基线 | typecheck **全绿、退出码 0**（server 0 / web 0 / desktop 0）+ build **成功**（首次）+ unit **439/439（42 文件）**（2026-10-02 实跑） |
| 继任自 | `docs/handoffs/2026-10-01-spec-c-t8-t9.md` |
| 状态 | T8、T9 均已收口（审查 + 修复 + 复核全过）；**余 T10、T11** |

## 工作树（6 项，改动由用户自行 commit）

```
 M web/.umirc.ts                              ← T9：路由 /studio/:importId → /:projectId
 M web/src/api.ts                             ← T8 修复轮：apiPost 的 next 恒丢
 M web/src/pages/library.tsx                  ← T8：剪辑 icon + canClip 判据
 M web/src/pages/studio-detail.tsx            ← T9：整段改造（522 → 约 860 行）
 M web/src/pages/studio.tsx                   ← T8：工具栏接上新建作品弹层
?? web/src/components/NewWorkModal.tsx       ← T8：新建
```

无临时/派生/备份产物残留；**全程零 git 写操作**（HEAD 仍是 `1b52cc0`）。

## 本次完成

### T6 F-1 限定范围复核 —— Approved
守卫在 [studio.tsx:78-82](file:///d:/Seed/sound-control-tool/web/src/pages/studio.tsx#L78-L82)。四条路径逐条推演：焦点在卡片按 Enter/空格正常进编辑页；焦点在删除按钮按 Enter/空格，冒泡被 `if (e.target !== e.currentTarget) return;` 拦下、**不 `preventDefault`** → 原生 button 触发 click → `stopPropagation` → 只弹确认框。**原 Important 关闭，无新破坏。**

### T8 新建作品两条入口 —— Approved
新建 [NewWorkModal.tsx](file:///d:/Seed/sound-control-tool/web/src/components/NewWorkModal.tsx)；`studio.tsx` 工具栏接上弹层；`library.tsx` 工具栏在「下载」后插 `ScissorOutlined`。

修复轮关掉两条 Important：
1. **下完视频剪刀仍灰、文案说谎** —— `detail.has_video` 只在选中来源时写回一次，下载完成走的是另一条路。改读页面**既有**的 `currentMaterial`（页面里 `<video>`/换集确认/默认选集都已在读它，剪刀原是孤例）
2. **`apiPost` 的 `next` 恒丢** —— `??` 短路导致服务端「下一步怎么办」到不了用户眼前。同文件 `apiPut` 早已修过同款，照它统一

### T9 编辑页作品维度改造 —— Approved
[studio-detail.tsx](file:///d:/Seed/sound-control-tool/web/src/pages/studio-detail.tsx) 整段改造 + 路由改 `:projectId`。**切片边界首次清干净**（typecheck 全绿、build 首次成功）。

修复轮关掉三条 Important：
1. **`<video>` 一失败就永久锁死编辑，会真丢用户数据** —— 打了几段点 → 播放时请求偶然失败 → 保存变灰 → F5 → 未保存的段全没。修法是**收窄只读态**（只认两个服务端确认的事实）+ 失败另出黄条 + 「重试加载」按钮，**失败后保存/导出/清空仍可用 → 段不丢**
2. **成品播放器 URL 在渲染体直调 → 日志被刷爆**（本文件顶部注释自己写着这个坑）
3. **换作品 id 无 stale 防护**（静默写错数据）—— 四条加载链各一个序号，**先自增再判早退**

## 真机目验（2026-10-02，浏览器实点）

- ✅ **删除弹窗真机点过了**（用户明确要求）：标题带作品名、正文「将同时删除它的 0 条成品（音频文件一并删除），不可恢复。」、取消/删除两键，**且 URL 仍是 `/studio` 没误跳编辑页**
- ✅ T8 全链路：工具栏「新建作品」→ 弹层列 2 个可剪资料 → 点「用这个剪辑」→ **直接进 `/studio/1`**，作品名带服务端默认值、时间轴空、成品明细 `Empty` 正确、按钮按状态正确禁用
- ✅ 作品墙点整张卡正常进编辑页；计数与卡片摘要一致
- ⏳ **未做**：键盘激活卡片内删除按钮的真机那一下（浏览器 WebView 中途反复 `WebView is not ready`，未硬撑）

## 下一步：T10（首页改作品维度）

plan 行 **1077–1102**。**T10 之前首页「正在编辑」那三张卡是坏的**：`index.tsx:107` 仍传 `row.import_id`，现在被当作品 id 查。

⚠️ **危害要说准**（T9 审查者纠正了实现者的轻描淡写）：两个 id 是**各自独立的自增序列、号段会重叠** → 恰好 id 相同时**会正常打开别人的作品，用户照常编辑保存 → 静默写错数据**，不是"必然报作品不存在"。服务端 [home.ts](file:///d:/Seed/sound-control-tool/server/src/db/repo/home.ts) 已返回 `project_id`，T10 只需前端接上。

T11 = 文档回扫 + 整支最终验证（plan 行 1103 起）。**T11 要统一收口的 deferred**：
- T8：`apiDelete` 仍是 `??` 短路老写法；`staleSource` 异常时序会卡住；`has_video` 与 `currentMaterial` 两套口径并存
- T9：`studio.tsx:272` 与 `WorkPreview.tsx:112/123` 是与 T9 同款的「渲染体直调带日志 URL」刷屏形状
- T6+T7：滚动位置估算式补偿；主列表失败整页只剩红字
- 术语「工程」残留、③ 小切片三条（排队取消不补 SSE 终态 / 导出取消被静默吞 / 作业 payload `JSON.parse` 无兜底）——**用户 2026-10-01 明确要求"记住"，T11 之后立即开**

## 留给用户的人工目验（spec §0.8）

作品改名保存后刷新仍在；导出成功后成品明细立刻出现且能播能单条删；**下载完视频后剪刀按钮立刻可用**（T8 修复）；只读态两种黄条 + 重试能否恢复；Electron 下"打开声音"是否真有声；hover 预览 400ms 触感与滚动是否回顶；**键盘 Tab 到卡片内删除按钮按 Enter 是否只弹确认框**。

## 两条控制器自己的教训

1. **派发前先确认落点存在**（第二次犯）：T8 我写 brief 时说「`apiPost` 已经把 `error.next` 拼好」，实现者照做 → 审查才发现 `??` 短路导致 `next` 恒丢。**"契约已就绪"这句话也要核过再写进 brief。**
2. **审查者对实现者的反向指控也要核**：T8 审查 §五第 3 条据递归 `pnpm typecheck` 那行指控 desktop 有错，实际 desktop 单跑退出码 0、零输出 —— 那行是 `pnpm -r` 的连带标记。**不能靠递归输出判断子包状态，必须单跑。**
