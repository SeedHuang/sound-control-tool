# M2 剩余阶段总执行计划（P3 → P4 → P5 → 收尾）

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development（P1/P2 同款：每任务派实现子代理 → 独立审查 → 修复环 → 台账记账）。
> 权威 spec：`docs/superpowers/specs/2026-09-30-m2-remaining-p3-p4-p5.md` + `docs/superpowers/specs/m2-workspace.md`（详细契约）。
> 本计划吸收并取代 `2026-09-30-m2-workspace-p3-studio.md`（P3 细化版，内容已并入 Phase P3）。

## Global Constraints

- 提交：用户授权制——子代理一律 **不 commit**，任务完成即停；用户按逻辑块自行提交。
- 每任务第一步 Read 目标文件磁盘实况（本会话工具回执有污染史）；每次编辑后读回核对；同文件禁止并行编辑。
- pushLog source 合法值：`logs.ts` 联合类型无 `'ytdlp'`，用 `'job'`。
- 页面标题不得与导航 Tab 重名（T8 裁决）。
- 验证基线：三包 typecheck + server vitest（242 起步）+ web build；web 无测试框架（目验补）。
- D19 NULL 语义、D17/D20、m1c 替换语义：以 remaining spec §1/§2 与 m2-workspace §0.2 为准，**不要重新讨论**。

---

## Phase P3：剪辑室媒体列表（3 任务）

### T1 后端：/api/imports 增 material_entry_index
- Modify `server/src/db/repo/imports.ts`（derivedJoin 同 JOIN 增 `source_videos.entry_index AS material_entry_index`，NULL 归一）+ `ImportSummaryRow`。
- Test：imports 路由断言有/无素材两态。
- [ ] 读实况 → 改 → `pnpm --filter @sct/server test`

### T2 前端：studio.tsx 媒体列表重构
- Modify `web/src/api.ts`（ImportSource + material_entry_index）；Modify `web/src/pages/studio.tsx`。
- 内容按 spec §1 T2 六条（imports 驱动 ∪ 孤儿音频 / 媒体卡 / 编辑入口 D17 / 快速试听 / 搜索分页保留 / 无重复标题）。
- [ ] 读实况 → 改 → typecheck + build

### T3 收尾
- [ ] 三包 typecheck + server test + web build + 目验清单汇编

---

## Phase P4：剪辑详情页（8 任务；T1 实测未过前不得开 T2）

### T1 开工前实测 F/G/H
- [ ] F `showwavespic`：参数/尺寸/颜色/是否直出 PNG（记入报告）
- [ ] G `fps+tile` 胶片条换算（先 scale 定高）
- [ ] H 图片端点 × `sendFileWithRange`：`<img>` Range 请求兼容性

### T2 服务端派生图
- Create `server/src/media/derived-images.ts` + 路由 `/api/media/:id/waveform|filmstrip`（固定 1600×120/1600×90、临时名→rename、size>0 命中、素材变更作废、守卫豁免、pushLog、stderr 摘要）
- [ ] vitest：命中缓存不重跑 ffmpeg / 零字节不命中 / 素材缺失 404 / 守卫豁免

### T3 剪辑工程 CRUD
- Modify `clip-projects.ts`（list/get/upsert 全量替换**事务** D18 + updated_at 显式写）+ 路由 `GET/PUT/DELETE /api/projects/:importId?`
- [ ] vitest：upsert 后 updated_at 变新 / 事务回滚旧段完好 / 幂等 DELETE / 段校验

### T4 导出 job + D8
- Modify `ingest.ts`（sourceType 参数）+ `schema.ts`（历史纠偏 SQL）+ 新 `ffmpeg-export.ts`（separate/merge）+ 路由 `POST /api/projects/:importId/export`
- [ ] vitest：separate N 条 / merge 1 条 / 标题后端拼 / retry 素材缺失明确失败 / 历史纠偏 SQL 四例

### T5 前端编辑器骨架
- Create `web/src/pages/studio-detail.tsx` 重写（替换占位）：页面头（来源名+第 N 集）+ 预览监视器 + 时间轴（画轨/音轨/播放头/段区块）+ 多段 CRUD
- [ ] typecheck + build

### T6 保存 + 导出接线
- Modify `studio-detail.tsx` + `api.ts`（projects/export 封装）
- [ ] 保存 PUT / 导出两段进度 / 离开未保存提示 / 清空剪辑点二次确认 / D17 空态

### T7 P4 backlog 逐项收口
- [ ] file_size 拼版本串 / clearByImportId 事务 / NULL→NULL 用例 / aria-pressed / 尾缀措辞 / upsert 注释 / imports SQL 去重

### T8 收尾
- [ ] 全量验证 + 目验清单（剪辑闭环：多段→保存→刷新仍在→分多段导出+合并导出）

---

## Phase P5：首页（2 任务）

### T1 后端 /api/home
- [ ] editing/recent 两块聚合 + vitest（去重、排除 NULL import_id、edit 过滤）

### T2 前端首页重构
- [ ] 两块 Top3（封面+点击跳转）+ Empty + 健康检查挪设置页 + typecheck/build

---

## 收尾

- [ ] PRD §5/§6/§2.3/§2.4 回写；m1c spec §0.6 废弃标注
- [ ] 全站 grep `获取|音频库`（应用文案层）终扫
- [ ] 手工目验总清单交付
