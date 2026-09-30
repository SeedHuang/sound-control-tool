# P3 · 剪辑室（媒体列表）Implementation Plan

> 来源：spec m2-workspace §0.5 P3 + 用户 2026-09-30 反馈（"下载好视频，剪辑室什么都没有"——剪辑室必须是**媒体中心**：来源列表，每个媒体有封面、素材状态、编辑入口，其下挂音频可快速试听）。
> 依赖：T2 已交付 `/api/imports` 的 `has_video/has_project/segment_count`；coverUrl 封面设施现成。
> **注意（T8 裁决）**：剪辑室加头部时**不得加与 Tab 重名的标题**。

**Goal:** 剪辑室从"音频文件平铺"重构为"媒体（来源）列表"：每个来源一张卡（封面 + 标题 + 素材状态含第 N 集 + 音频数 + 编辑入口），下挂该来源的音频可快速试听；来源即使只有视频素材（还没有音频）也显示——这直接修掉"下载视频后剪辑室空白"。

**Architecture:** 后端一行增量（imports 同一 JOIN 带出 `material_entry_index`）；前端 studio.tsx 重构为 imports 驱动 + 孤儿音频兜底。数据全部现成，无新表。

**Tech Stack:** 不变。**Spec:** `docs/superpowers/specs/m2-workspace.md` §0.5 P3 + D12/D17 + T8 裁决。

## Global Constraints

- 媒体卡三种来源状态：有素材（编辑可进，显示"素材：第 N 集"）、无素材（**编辑禁用 + tooltip**，D17）、无来源的孤儿音频（ recordings/旧数据，归"未关联来源"组，永不消失）。
- 快速试听（现有 `<audio>`）、搜索、分页、删除音频——**行为保留**。
- 封面 `coverUrl(importId)`，onError 回退灰底（同资料库共用位模式）。
- 无重复标题（T8）；不 commit（未授权）；每次编辑读回核对；同文件禁并行编辑；读回矛盾 → BLOCKED。

## Tasks

### Task 1: 后端 —— /api/imports 增 material_entry_index
- Modify: `server/src/db/repo/imports.ts`（derivedJoin 同一 JOIN 带 `source_videos.entry_index AS material_entry_index`，NULL 归一）+ `ImportSummaryRow`；路由测试补断言。
- [ ] 读实况 → 改 → 测试（`pnpm --filter @sct/server test`）

### Task 2: 前端 —— studio.tsx 媒体列表重构
- Modify: `web/src/api.ts`（ImportSource 增 `material_entry_index: number | null`）
- Modify: `web/src/pages/studio.tsx`（重构）：
  1. 列表驱动改为 `imports`（/api/imports 全量）∪ 孤儿音频（source_url 匹配不上任何 import 的 audio_items → "未关联来源"组）
  2. 媒体卡：封面（coverUrl，onError 回退）+ 标题 + `has_video` → "素材：第 N 集"（N=material_entry_index；NULL 显示"素材：集数未知"）/ 无素材 → 无标记 + **编辑禁用 + tooltip**（D17）+ 音频数 + 已剪/下载音频的快速试听（点卡展开该来源的音频行，现有 renderRow 复用）
  3. "编辑"入口 → `/studio/:importId`（占位页已有，P4 填充）
  4. 搜索/分页/删除音频/播放保留；**不加与 Tab 重名的标题**；空态：无任何来源与音频 → 引导去资料库
- [ ] 读实况 → 改 → `pnpm --filter @sct/web typecheck` + `build`

### Task 3: 收尾
- [ ] `pnpm typecheck` 三包 + server test 全绿 + web build
- [ ] 手工目验清单：下载视频后剪辑室出现该媒体卡（"素材：第 N 集"）→ 点编辑进详情占位；无素材来源编辑禁用；孤儿音频不消失；快速试听/搜索/分页回归

## 风险
- imports 驱动后，"删除来源"会让对应媒体卡消失但其音频（若还有）变孤儿——沿用现有孤儿兜底即可。
