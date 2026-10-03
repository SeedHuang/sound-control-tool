# 时间轴分级（Spec B）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 时间轴画轨与音轨从「一次性 12 格铺满全片」改成三级金字塔——放大时画面采样随缩放变密，并支持缩放 + 平移两种切换方式。

**Architecture:** 服务端把「一张胶片条」扩成「L0 全片 36 格 + L1/L2 按 128s/24s 窗分段各 12 格」，每段独立生成、独立缓存、独立失效。L0 生成方式从 fps 滤镜整解码改为逐格 `-ss` 定点 seek（实测 45–52s → 10.29s）。波形从「一张固定 PNG」改成「服务端提取峰值数组 → 前端 Canvas 按当前缩放档位自绘」，数据源用 astats 修正链路（严禁字面 `reset=44100` 全键打印）。前端缩放档位离散（L0/L1/L2），Ctrl+滚轮切档、拖动平移，最小档保持 N2-c 的拖动定位。

**Tech Stack:** Electron + Fastify 5 + node:sqlite（server）/ UmiJS Max + React + antd 5（web）/ ffmpeg 9.0.2 Gyan full build（Windows）/ TypeScript 5 / vitest

**Spec:** `docs/superpowers/specs/2026-10-02-timeline-pyramid.md`（D1–D5 裁决 + §5 不做清单 + §6 验收五条）
**实测依据:** `.superpowers/sdd/2026-10-01-clip-works/ffmpeg-measure-report.md` §B 组 + 裁决表②
**账本:** `.superpowers/sdd/2026-10-03-timeline-pyramid/progress.md`

## Global Constraints

以下约束**每个任务都适用**，不再逐任务重复（数值来源：交接词「范围依据」表 + 实测报告 B 组；**定死项不得自由发挥**）：

### 参数（定死，勿改）

| 项 | 值 | 来源 |
|---|---|---|
| L0 总览 | 36 格铺满全片，**接管 legacy `/filmstrip` 路由**（URL 与文件名 `film-<id>.png` 不变） | B1 |
| L0 生成方式 | 逐格 `-ss` 定点 seek + tile 拼接（不再用 fps 滤镜整解码） | B1：10.29s vs 全解码 45–52s |
| L1 中景 | 12 格 / 128s 窗，`film-<id>-L1-<seg>.png`，终宽 = 格数×160、高 90 | B2 |
| L2 近景 | 12 格 / 24s 窗，同上命名规则 | spec D1 |
| L2 服务端门槛 | `duration > 300`（D5）。低于此值返回 404 + 明确文案 | spec D5 |
| 前端档位门槛 | L1 需 `duration > 128`，L2 需服务端放行（客户端只做 UI 隐藏，不做权威判定） | spec D5 |
| 采样点 | 每格取区间**起点**（沿用 N0 语义）；末段不足整窗按实际 span | N0 结论 / spec §5 |
| 波形 L0 | `asetnsamples=48000`（48kHz 素材 = 1 点/秒） | B3b 裁决表② |
| 波形 L1 段 | `asetnsamples=3840`（128s 窗 → 1600 点） | B3c |
| 波形 L2 段 | `asetnsamples=720`（24s 窗 → 1600 点） | B3c 同口径换算 |
| 峰值 JSON 字段 | `{v,sig,level,seg,t0,stepSec,points}`；`-inf` → `-99`；原子落盘 | B3b/B3c + 交接词 |
| 缓存版本 | `FILM_META_V` 2 → 3（老图自动失效） | spec D4 |

### 禁止项（spec §5 + 既定约束）

- **禁止任何 git 写操作**（commit/push/add/…）。改动留工作树，由用户自行提交。本仓的 review package 用「任务前快照 + `git diff --no-index`」（脚本 `.superpowers/sdd/2026-10-03-timeline-pyramid/pkg.ps1`）。
- **不引入任何新依赖**；**不引 wavesurfer.js**（m2-workspace D6 裁决仍有效）。
- 不做无级平滑缩放、不做多轨、不做关键帧帧级对齐。
- L0 语义保持「覆盖整段」，末格差一格是 tile 数学约定，**接受**（spec §5，N0 结论），不要"修"。
- web 沿用**内联 style**，不建 sc 文件（N1/N2 惯例）。

### 必须遵守的仓库规则

- **Electron 关键步骤/每个请求必须加日志，且日志页可见**（`.trae/rules/electron-dev-must-log.md`）：
  - hijacked reply（SSE / `<audio>` 这类）**必须手写 ACAO + Vary** 并记一条 debug 级 CORS 摘要。
  - execFile **三参回调** `(err, stdout, stderr)`，stderr 永远记日志（截 200 字符，缺则标「(无 stderr 输出)」）。
  - 失败路径必须 `pushLog`（catch 里写一行），否则用户看到的「失败：」是空的。
- **破坏性操作二次确认**（`.trae/rules/trae-project-rules.md`）：本批不新增删除按钮；若 T7 引入「清空画轨缓存」类按钮，必须 `Modal.confirm` + `okType:'danger'`。
- **删除/写入接口的 IO 语义**：`invalidateDerived` 清派生图失败**只记日志不让接口失败**（T3 保持）。
- **Umi 4 布局用 `<Outlet />`**：本批不碰 `web/src/layouts/index.tsx`，但若发现相关问题按规则报、不顺手改。
- **编辑代码禁止丢失 import**：同一文件禁止并行 SearchReplace；import 与代码合并进同一次编辑；改完立即 `npx tsc --noEmit --pretty` 校验该文件所在目录；全部改完再跑一次全量。

### 任务节奏（每个任务都一样）

严格串行 T1→T8。每个任务：
1. **快照**：`powershell -NoProfile -File .superpowers/sdd/2026-10-03-timeline-pyramid/pkg.ps1 -Mode snapshot -Task <N> -Files "<本任务要改的文件>"`
2. **RED**：先写测试，跑一次，确认它**因为功能缺失而失败**（不是语法错）。
3. **实现**：只实现本任务，不越界改下一个任务的调用点。
4. **绿**：本任务测试全绿 + 全量 `npx tsc --noEmit --pretty`（server/web/desktop 三包）。
5. **停**：**不 commit**（禁止 git 写操作），写 review package 交控制器审查。
6. 在账本 `progress.md` 追加本任务段落（做了什么、实测数字、遇到的红、留给下任务的提示）。

**允许的「预期红色」**：T2/T3 之间 typecheck 会报出 T3 才改的调用点；T5 之后 web 会红到 T6–T7 改完。实现者**不许越界修**，只把「哪些红、为什么」写进报告。

**测试基线**：server test 516/516（42 文件），**只增不减**。web/desktop 无单测（现有状况），靠 `tsc --noEmit` + build + 人工目验。

---

### Task 1: 档位契约与纯参数层

**Files:**
- Modify: `server/src/ffmpeg/derived-args.ts`
- Modify: `server/src/ffmpeg/derived-args.test.ts`

**Interfaces:**
- Consumes: 无（纯函数层，不碰 IO）
- Produces:
  ```ts
  export type FilmLevel = 0 | 1 | 2;
  export const FILM_LEVEL_TILES: Record<FilmLevel, number>;      // {0:36, 1:12, 2:12}
  export const FILM_LEVEL_SPAN_SEC: Record<FilmLevel, number>;   // {0:0(整片), 1:128, 2:24}
  export const FILM_CELL_W = 160;
  export const FILM_CELL_H = 90;
  export const FILM_TOTAL_TILES = 36;                            // L0
  export const WAVE_POINTS_PER_SEG = 1600;                       // L1/L2 段目标点数
  export const WAVE_NSAMPLES: Record<FilmLevel, number>;         // {0:48000, 1:3840, 2:720}
  export const FILM_META_V = 3;
  export function levelSpanSec(level: FilmLevel, durationSec: number): number;
  export function segmentCount(durationSec: number, level: FilmLevel): number;
  export function segmentSpan(durationSec: number, level: FilmLevel, seg: number): { t0: number; span: number };
  export function sampleTimes(durationSec: number, level: FilmLevel, seg: number): number[];
  export function filmShapeSig(level: FilmLevel, tiles: number): string;
  export function waveShapeSig(level: FilmLevel): string;
  export function filmCellArgs(videoPath: string, outPath: string, t: number): string[];
  export function filmTileArgs(outPath: string, cellDir: string, tiles: number): string[];
  export function wavePeakArgs(videoPath: string, seg: number | null, nsamples: number): string[];
  ```

- [ ] **Step 1: 写失败的测试**

在 `server/src/ffmpeg/derived-args.test.ts` 末尾追加两个 `describe` 块（**只加不改**已有块，避免打破 N0/N1 已锁定的断言）：

```ts
import {
  FILM_CELL_H, FILM_CELL_W, FILM_LEVEL_SPAN_SEC, FILM_LEVEL_TILES, FILM_META_V, FILM_TOTAL_TILES,
  WAVE_NSAMPLES, WAVE_POINTS_PER_SEG,
  filmCellArgs, filmShapeSig, filmTileArgs, levelSpanSec, sampleTimes, segmentCount, segmentSpan,
  wavePeakArgs, waveShapeSig,
} from './derived-args.js';

describe('档位常量（定死项，改这里等于改 spec）', () => {
  it('L0=36 格铺满全片，L1/L2 各 12 格；窗长 128s / 24s', () => {
    expect(FILM_TOTAL_TILES).toBe(36);
    expect(FILM_LEVEL_TILES[0]).toBe(36);
    expect(FILM_LEVEL_TILES[1]).toBe(12);
    expect(FILM_LEVEL_TILES[2]).toBe(12);
    expect(FILM_LEVEL_SPAN_SEC[1]).toBe(128);
    expect(FILM_LEVEL_SPAN_SEC[2]).toBe(24);
  });
  it('格子 160×90；波形段目标 1600 点；三档 N=48000/3840/720', () => {
    expect(FILM_CELL_W).toBe(160);
    expect(FILM_CELL_H).toBe(90);
    expect(WAVE_POINTS_PER_SEG).toBe(1600);
    expect(WAVE_NSAMPLES[0]).toBe(48000);
    expect(WAVE_NSAMPLES[1]).toBe(3840);
    expect(WAVE_NSAMPLES[2]).toBe(720);
  });
  it('L0 每段 128s → 1600 点，L2 每段 24s → 1600 点（48kHz 口径：span×48000÷N = 1600）', () => {
    expect((128 * 48000) / WAVE_NSAMPLES[1]).toBe(1600);
    expect((24 * 48000) / WAVE_NSAMPLES[2]).toBe(1600);
  });
  it('FILM_META_V 升到 3：老 v2 的图与 meta 全部判失效（spec D4）', () => {
    expect(FILM_META_V).toBe(3);
  });
});

describe('分段与采样点（采样点取区间起点，沿用 N0 语义）', () => {
  const T = 1290.325333; // 实测素材 media-13 的真实时长

  it('L0 段数为 1，窗长 = 整片（0 表示「不切段」）', () => {
    expect(segmentCount(T, 0)).toBe(1);
    expect(levelSpanSec(0, T)).toBe(T);
  });
  it('L1：1290.33s / 128s → 11 段（最后一段是余数）', () => {
    expect(segmentCount(T, 1)).toBe(11);
  });
  it('L2：1290.33s / 24s → 54 段', () => {
    expect(segmentCount(T, 2)).toBe(54);
  });
  it('L0 的 36 个采样点 = 区间起点（末格落在 35/36 处，不是片尾）', () => {
    const ts = sampleTimes(T, 0, 0);
    expect(ts).toHaveLength(36);
    expect(ts[0]).toBe(0);
    expect(ts[1]).toBeCloseTo((T * 1) / 36, 2);
    expect(ts[35]).toBeCloseTo((T * 35) / 36, 2);
    expect(ts[35]).toBeLessThan(T); // 末格不是片尾（N0 结论，spec §5 明确接受）
  });
  it('L1 段内 12 个采样点；末段不足整窗时按实际 span 取点（不越界）', () => {
    const ts = sampleTimes(T, 1, 0);
    expect(ts).toHaveLength(12);
    expect(ts[0]).toBeCloseTo(0, 2);
    expect(ts[11]).toBeCloseTo((128 * 11) / 12, 2);
    const last = sampleTimes(T, 1, 10); // 第 11 段 = 1280 → 1290.33，余 10.33s
    expect(last[0]).toBeCloseTo(1280, 2);
    expect(Math.max(...last)).toBeLessThan(T);
  });
  it('L2 段内 12 格、格距 2s（24s 窗）', () => {
    const ts = sampleTimes(T, 2, 3);
    expect(ts).toHaveLength(12);
    expect(ts[0]).toBeCloseTo(72, 2);
    expect(ts[1]).toBeCloseTo(72 + 2, 2);
  });
  it('segmentSpan：非末段 span=整窗；末段 span=余数（不虚构超出片尾的时间）', () => {
    expect(segmentSpan(T, 1, 0)).toEqual({ t0: 0, span: 128 });
    const tail = segmentSpan(T, 1, 10);
    expect(tail.t0).toBeCloseTo(1280, 2);
    expect(tail.span).toBeCloseTo(T - 1280, 2);
  });
  it('时长非法（0/NaN/负）→ 抛 RangeError，绝不退化出图', () => {
    for (const bad of [0, Number.NaN, -1]) {
      expect(() => segmentCount(bad, 1)).toThrow(RangeError);
      expect(() => sampleTimes(bad, 0, 0)).toThrow(RangeError);
    }
  });
});

describe('逐格 seek 与 tile 拼接参数（实测 B1/B2）', () => {
  it('filmCellArgs：-ss 在 -i 前（快速 seek）+ -frames:v 1 + scale=-1:90', () => {
    const args = filmCellArgs('v.mp4', 'c0.png', 512);
    expect(args.slice(0, 2)).toEqual(['-y', '-ss']);
    expect(args).toContain('512');
    expect(args[args.indexOf('-i') + 1]).toBe('v.mp4');
    expect(args[args.indexOf('-vf') + 1]).toBe('scale=-1:90');
    expect(args[args.indexOf('-frames:v') + 1]).toBe('1');
    expect(args[args.length - 1]).toBe('c0.png');
  });
  it('filmTileArgs：-start_number 0 + -i cell-%02d.png + tile=Nx1', () => {
    const args = filmTileArgs('sheet.png', 'D:\\tmp', 12);
    expect(args[args.indexOf('-start_number') + 1]).toBe('0');
    expect(args[args.indexOf('-i') + 1]).toBe('D:\\tmp\\cell-%02d.png');
    expect(args[args.indexOf('-vf') + 1]).toBe('tile=12x1');
    expect(args[args.length - 1]).toBe('sheet.png');
  });
  it('filmShapeSig / waveShapeSig：带 level 与关键参数，改常量签名自动跟着变', () => {
    expect(filmShapeSig(0, 36)).toContain('level=0');
    expect(filmShapeSig(1, 12)).toContain('level=1');
    expect(filmShapeSig(1, 12)).toContain('tiles=12');
    expect(filmShapeSig(1, 12)).toContain(`cell=${FILM_CELL_W}x${FILM_CELL_H}`);
    expect(filmShapeSig(0, 36)).toContain(`v${FILM_META_V}`);
    expect(waveShapeSig(2)).toContain('level=2');
    expect(waveShapeSig(2)).toContain(`n=${WAVE_NSAMPLES[2]}`);
  });
});

describe('波形峰值参数（实测 B3b/B3c；严禁字面 reset=44100 全键打印）', () => {
  it('L0 全片：无 -ss/-t，N=48000', () => {
    const args = wavePeakArgs('v.mp4', null, 48000);
    expect(args).not.toContain('-ss');
    expect(args).not.toContain('-t');
    expect(args[args.indexOf('-af') + 1]).toBe(
      'asetnsamples=48000,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level',
    );
    expect(args[args.length - 1]).toBe('-');
  });
  it('L1/L2 段：-ss <seg起点> -t <span>，N 取对应档', () => {
    const args = wavePeakArgs('v.mp4', { t0: 512, span: 128 }, 3840);
    expect(args[args.indexOf('-ss') + 1]).toBe('512');
    expect(args[args.indexOf('-t') + 1]).toBe('128');
    expect(args[args.indexOf('-af') + 1]).toContain('asetnsamples=3840');
  });
  it('输出走 -f null -（只要 stderr 里的 RMS 行，不落图片）', () => {
    expect(wavePeakArgs('v.mp4', null, 48000)).toContain('-f');
    expect(wavePeakArgs('v.mp4', null, 48000)[wavePeakArgs('v.mp4', null, 48000).indexOf('-f') + 1]).toBe('null');
  });
  it('防呆：astats 永远是 reset=1 —— 字面 reset=44100 实测 480s 超时 + 334MB 日志（B3a）', () => {
    for (const n of [48000, 3840, 720]) {
      expect(wavePeakArgs('v.mp4', null, n)[wavePeakArgs('v.mp4', null, n).indexOf('-af') + 1]).toContain('reset=1');
      expect(wavePeakArgs('v.mp4', null, n).join(' ')).not.toContain('reset=44100');
    }
  });
});
```

然后在文件顶部的 import 里补上新增的符号（**一次改完，别分两步**）。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server; npx vitest run src/ffmpeg/derived-args.test.ts`
Expected: FAIL，报 `FILM_LEVEL_TILES` 等未导出（TS 编译期错误）。这是预期的 RED。

- [ ] **Step 3: 实现**

在 `server/src/ffmpeg/derived-args.ts` 末尾追加（**保留全部既有导出与注释，一行都不许删改** —— 它们锁着 N0/N1 的行为）：

```ts
// —— Spec B 时间轴分级（2026-10-03）——
// 形状签名机制沿用 N0：能由纯代码常量派生的参数全进 sig，改常量 → sig 变 → 老图自动判失效。
// 但「改 fps 计算方式本身」这类要手动加版本号的弱点，本批由 FILM_META_V 2→3 一次性兜住（老 v2 全部作废）。

/** 档位：0=总览（整片一张）、1=中景（128s 窗）、2=近景（24s 窗）。离散三档，不做无级（spec D3）。 */
export type FilmLevel = 0 | 1 | 2;

/** L0 铺满全片的格数（实测 B1：36 格逐格 seek 共 10.29s，替代 fps 滤镜整解码的 45–52s）。 */
export const FILM_TOTAL_TILES = 36;

/** 每格终宽 160（实测 B2：12 格拼成 1920 宽）。高恒为 90。 */
export const FILM_CELL_W = 160;
export const FILM_CELL_H = 90;

/** 各档格数：L0 铺满，L1/L2 每段 12 格。 */
export const FILM_LEVEL_TILES: Record<FilmLevel, number> = { 0: FILM_TOTAL_TILES, 1: 12, 2: 12 };

/** 各档窗长（秒）。L0 的 0 是哨兵「不切段、窗=整片」——真实窗长由 durationSec 决定。 */
export const FILM_LEVEL_SPAN_SEC: Record<FilmLevel, number> = { 0: 0, 1: 128, 2: 24 };

/**
 * 波形每段目标点数：128s 窗与 24s 窗都给 1600 点（实测 B3c 的 3840/1600 口径按比例缩到 720）。
 * 为什么要「每段点数恒定」而不是「点数随窗长变」：前端 Canvas 按可视宽度取点，恒定点数让
 * 缩放时列宽稳定，不会因为窗长不同而忽粗忽细。
 */
export const WAVE_POINTS_PER_SEG = 1600;

/**
 * astats 窗口采样数 N（48kHz 素材口径，实测 B3b/B3c）：
 * L0=48000 → 1 点/秒（1290s 片 ≈ 1290 点）；L1=3840 → 128s 窗 1600 点；L2=720 → 24s 窗 1600 点。
 * ⚠️ 素材采样率不是 48kHz 时点数会按比例偏移（44.1kHz → 约 0.92 倍），这在可接受范围内：
 *   前端按返回的 points.length 画，不硬编码点数。
 * ⚠️ N 越小 → 窗口越多 → stderr 行越多 → 越慢。720 已经比 B3c 实测的 3840 多 5.3 倍行数，
 *   仍属秒级（实测 1600 行 = 233KB；720 口径下 24s 窗仍是 1600 行，与 B3c 同量级）。
 */
export const WAVE_NSAMPLES: Record<FilmLevel, number> = { 0: 48000, 1: 3840, 2: 720 };

/** .meta 的 schema 版本。2→3：老 v2 的 L0 图与 meta 全部判失效重生成（spec D4）。 */
export const FILM_META_V = 3;

const assertPositiveDuration = (durationSec: number): void => {
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    throw new RangeError(`需要已知的正时长（收到 ${String(durationSec)}）：时长未知时不得退化出图`);
  }
};

/** 本档实际窗长：L0 返回 durationSec（整片），L1/L2 返回定长窗（即便片尾余数不足，见 segmentSpan）。 */
export function levelSpanSec(level: FilmLevel, durationSec: number): number {
  assertPositiveDuration(durationSec);
  return level === 0 ? durationSec : FILM_LEVEL_SPAN_SEC[level];
}

/** 段数：L0 恒 1；L1/L2 = ceil(时长 / 窗长)。 */
export function segmentCount(durationSec: number, level: FilmLevel): number {
  assertPositiveDuration(durationSec);
  if (level === 0) return 1;
  return Math.max(1, Math.ceil(durationSec / FILM_LEVEL_SPAN_SEC[level]));
}

/** 某段的实际覆盖区间。末段 span 按余数收窄，绝不虚构超出片尾的时间。 */
export function segmentSpan(durationSec: number, level: FilmLevel, seg: number): { t0: number; span: number } {
  assertPositiveDuration(durationSec);
  if (level === 0) return { t0: 0, span: durationSec };
  const span = FILM_LEVEL_SPAN_SEC[level];
  const t0 = seg * span;
  return { t0, span: Math.max(0, Math.min(span, durationSec - t0)) };
}

/**
 * 某段的采样时刻（秒）。**每格取区间起点**（沿用 N0 语义，spec §5 明确保持）。
 * 末段格数按实际 span 收窄（余数不足整格距时仍取最后一格起点，但不超过片尾）。
 */
export function sampleTimes(durationSec: number, level: FilmLevel, seg: number): number[] {
  const { t0, span } = segmentSpan(durationSec, level, seg);
  const tiles = FILM_LEVEL_TILES[level];
  const step = span / tiles;
  return Array.from({ length: tiles }, (_, i) => round2(t0 + step * i));
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** 胶片图形状签名：level + 格数 + 格子尺寸 + schema 版本。命中时逐字比对（沿用 N0 机制）。 */
export function filmShapeSig(level: FilmLevel, tiles: number): string {
  return `v${FILM_META_V}|level=${level}|tiles=${tiles}|cell=${FILM_CELL_W}x${FILM_CELL_H}`;
}

/** 波形峰值形状签名：level + 窗长 + N + schema 版本。 */
export function waveShapeSig(level: FilmLevel): string {
  return `v${FILM_META_V}|level=${level}|span=${FILM_LEVEL_SPAN_SEC[level] === 0 ? 'full' : FILM_LEVEL_SPAN_SEC[level]}|n=${WAVE_NSAMPLES[level]}`;
}

/**
 * 单格抽帧（实测 B1/B2 的命令形态）。**-ss 必须放在 -i 之前**（输入选项 = 快速 seek，
 * 放在 -i 之后会从 0 解码到该点，2.1GB 素材上会变成几十秒）。scale=-1:90 保持原比例、只定高。
 */
export function filmCellArgs(videoPath: string, outPath: string, t: number): string[] {
  return ['-y', '-ss', String(t), '-i', videoPath, '-frames:v', '1', '-vf', `scale=-1:${FILM_CELL_H}`, outPath];
}

/** tile 拼接：把逐格产出的小图按文件名序列拼成一行。实测 B2 拼接仅 0.03s，可忽略其耗时。 */
export function filmTileArgs(outPath: string, cellDir: string, tiles: number): string[] {
  return ['-y', '-start_number', '0', '-i', `${cellDir}\\cell-%02d.png`, '-vf', `tile=${tiles}x1`, '-frames:v', '1', outPath];
}

/**
 * 波形峰值提取（实测 B3b/B3c 修正链路）。
 * ⚠️ 三个关键点，一个都不能改回去：
 *   ① `asetnsamples=N` 强制窗口 —— 没有它，astats 的 reset 按解码帧数（AAC 帧=1024 采样）走，
 *      根本不是「N 采样一窗」。
 *   ② `reset=1` —— 每窗重置累计量。B3a 的字面 `reset=44100` 实测 **480s 超时 + 334MB 日志**，
 *      根因是它把 reset 参数当成了采样数，且不带 key 时 ametadata 把 ~170 个指标/帧全打出来。
 *   ③ `ametadata=print:key=...` 只打 RMS 一个键 —— 数据从 **stderr** 解析，不落文件。
 * seg 为 null 表示全片（L0），此时不加 -ss/-t。
 */
export function wavePeakArgs(videoPath: string, seg: { t0: number; span: number } | null, nsamples: number): string[] {
  const args = ['-y'];
  if (seg !== null) args.push('-ss', String(seg.t0), '-t', String(seg.span));
  args.push(
    '-i', videoPath, '-vn',
    '-af', `asetnsamples=${nsamples},astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level`,
    '-f', 'null', '-',
  );
  return args;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd server; npx vitest run src/ffmpeg/derived-args.test.ts`
Expected: PASS（既有 22 条 + 新增 17 条全绿）。

Run: `cd server; npx tsc --noEmit --pretty 2>&1 | Select-String "src/ffmpeg"`
Expected: 无输出（0 错）。

- [ ] **Step 5: 快照 + review package**

```powershell
powershell -NoProfile -File .superpowers/sdd/2026-10-03-timeline-pyramid/pkg.ps1 -Mode snapshot -Task 1 -Files "server/src/ffmpeg/derived-args.ts","server/src/ffmpeg/derived-args.test.ts"
# 实现完成后：
powershell -NoProfile -File .superpowers/sdd/2026-10-03-timeline-pyramid/pkg.ps1 -Mode diff -Task 1
```

- [ ] **Step 6: 记账本，停在此处**

在 `progress.md` 追加 T1 段落。**不 commit**。

---

### Task 2: L0 总览接管（逐格 seek 生成）

**Files:**
- Modify: `server/src/media/derived-images.ts`
- Modify: `server/src/media/derived-images.test.ts`

**Interfaces:**
- Consumes: T1 的 `FILM_TOTAL_TILES` / `FILM_CELL_W` / `FILM_CELL_H` / `filmCellArgs` / `filmTileArgs` / `filmShapeSig` / `FILM_META_V` / `segmentSpan` / `sampleTimes` / `assertPositiveDuration` 的等价校验
- Produces:
  ```ts
  // derived-images.ts 新增导出（T3/T5 消费）
  export type DerivedKind = 'wave' | 'film' | 'filmSeg' | 'wavePeak';
  export type FilmSegRef = { level: 1 | 2; seg: number };
  export function derivedFileName(kind: DerivedKind, importId: number, seg?: FilmSegRef): string;
  //  'film'     → film-<id>.png            （L0，URL 不变，向后兼容）
  //  'filmSeg'  → film-<id>-L<lv>-<seg>.png
  //  'wavePeak' → wavepeak-<id>-L<lv>[-<seg>].json
  export function invalidateDerived(derivedDir: string, importId: number): { removed: number };
  ```

- [ ] **Step 1: 写失败的测试**

在 `derived-images.test.ts` 追加：

```ts
describe('L0 总览：逐格 seek 生成（实测 B1：36 格 10.29s vs fps 滤镜整解码 45–52s）', () => {
  it('36 格 → 调 36 次 cell 抽帧 + 1 次 tile 拼接，共 37 次 doExec（不再是 1 次）', async () => {
    const { fn, calls } = execStub(() => ({ write: 'PNG' }));
    const r = await ensureDerivedImage({ kind: 'film', importId: 3, videoPath: 'v.mp4', derivedDir, tempDir, db, doExec: fn, probe: async () => 1290.325333, resolveFfmpeg: resolveOk });
    expect(r).toMatchObject({ ok: true, cached: false });
    const cellCalls = calls.filter((c) => c.args.includes('-ss'));
    const tileCalls = calls.filter((c) => c.args.includes('-i') && c.args[0] === '-y' && c.args[1] === '-start_number');
    expect(cellCalls).toHaveLength(36);
    expect(tileCalls).toHaveLength(1);
    // 每格的 -ss 都在 -i 之前（放在后面 = 从 0 解码，2.1GB 素材会变几十秒）
    for (const c of cellCalls) expect(c.args.indexOf('-ss')).toBeLessThan(c.args.indexOf('-i'));
    // 第 2 格落在 1/36 处（第 1 格是 0）
    expect(cellCalls[1]!.args[cellCalls[1]!.args.indexOf('-ss') + 1]).toBe('35.84');
  });

  it('cell 临时文件全部清理（不留 36 个半成品）', async () => {
    const { fn, calls } = execStub(() => ({ write: 'PNG' }));
    await ensureDerivedImage({ kind: 'film', importId: 4, videoPath: 'v.mp4', derivedDir, tempDir, db, doExec: fn, probe: async () => 1290.325333, resolveFfmpeg: resolveOk });
    // tile 拼接是最后一次调用，cell 目录里不该剩任何 cell-*.png
    const cellDir = calls[calls.length - 1]!.args[calls[calls.length - 1]!.args.indexOf('-i') + 1]!.replace(/\\cell-%02d\.png$/, '');
    const leftovers = existsSync(cellDir) ? readdirSync(cellDir).filter((f) => f.startsWith('cell-')) : [];
    expect(leftovers).toHaveLength(0);
  });

  it('任一格失败 → 整体 FFMPEG_FAIL，不落半张图（不留「有图无凭据」）', async () => {
    let n = 0;
    const { fn } = execStub((out) => { n += 1; return n === 5 ? { err: Object.assign(new Error('boom'), { code: 1 }), stderr: 'Invalid data found' } : { write: 'PNG' }; });
    const r = await ensureDerivedImage({ kind: 'film', importId: 5, videoPath: 'v.mp4', derivedDir, tempDir, db, doExec: fn, probe: async () => 1290.325333, resolveFfmpeg: resolveOk });
    expect(r).toMatchObject({ ok: false, code: 'FFMPEG_FAIL' });
    expect(existsSync(join(derivedDir, 'film-5.png'))).toBe(false);
    expect(existsSync(join(derivedDir, 'film-5.png.meta'))).toBe(false);
  });

  it('meta 升到 v3 且带 level=0（老 v2 的图自动判失效）', async () => {
    const { fn } = execStub(() => ({ write: 'PNG' }));
    await ensureDerivedImage({ kind: 'film', importId: 6, videoPath: 'v.mp4', derivedDir, tempDir, db, doExec: fn, probe: async () => 200, resolveFfmpeg: resolveOk });
    const m = JSON.parse(readFileSync(join(derivedDir, 'film-6.png.meta'), 'utf8')) as Record<string, unknown>;
    expect(m.v).toBe(3);
    expect(m.level).toBe(0);
    expect(String(m.sig)).toContain('level=0');
  });

  it('老 v2 的 meta → 判失效重生成（spec D4 的核心机制）', async () => {
    mkdirSync(derivedDir, { recursive: true });
    writeFileSync(join(derivedDir, 'film-7.png'), 'PNG');
    writeFileSync(join(derivedDir, 'film-7.png.meta'), JSON.stringify({ v: 2, sig: 'v2|tiles=12|size=1600x90|fps=min(12/T,30)', durationSec: 200, vf: 'fps=1.000000,scale=-1:90,tile=12x1,scale=1600:90', generatedAt: '' }));
    const { fn, calls } = execStub(() => ({ write: 'PNG' }));
    const r = await ensureDerivedImage({ kind: 'film', importId: 7, videoPath: 'v.mp4', derivedDir, tempDir, db, doExec: fn, probe: async () => 200, resolveFfmpeg: resolveOk });
    expect(r).toMatchObject({ ok: true, cached: false });
    expect(calls.length).toBeGreaterThan(0);
  });
});

describe('derivedFileName 命名契约', () => {
  it('L0 沿用 legacy 名（URL/文件名不变，向后兼容）', () => {
    expect(derivedFileName('film', 12)).toBe('film-12.png');
    expect(derivedFileName('wave', 12)).toBe('wave-12.png');
  });
  it('分段图名带 level 与段号', () => {
    expect(derivedFileName('filmSeg', 12, { level: 1, seg: 3 })).toBe('film-12-L1-3.png');
    expect(derivedFileName('filmSeg', 12, { level: 2, seg: 0 })).toBe('film-12-L2-0.png');
  });
  it('峰值 JSON：L0 不带段号，L1/L2 带段号', () => {
    expect(derivedFileName('wavePeak', 12, { level: 0, seg: 0 })).toBe('wavepeak-12-L0.json');
    expect(derivedFileName('wavePeak', 12, { level: 1, seg: 3 })).toBe('wavepeak-12-L1-3.json');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server; npx vitest run src/media/derived-images.test.ts`
Expected: FAIL（新 describe 块引用未导出的 `derivedFileName`，以及 L0 仍是单次 fps 滤镜调用 → 36 格断言不成立）。

- [ ] **Step 3: 实现**

在 `derived-images.ts` 里改三处：

**(a) 顶部 `DerivedKind` 与命名函数**（把原来那行 `export type DerivedKind = 'wave' | 'film';` 换掉）：

```ts
export type DerivedKind = 'wave' | 'film' | 'filmSeg' | 'wavePeak';
/** 分段引用（L0 不需要段，故用 0 占位）。 */
export type FilmSegRef = { level: 1 | 2; seg: number };

/**
 * 派生图文件名（单一来源，命中判定/生成/清理三处共用 —— 各写一份必然漂移）。
 * **L0 沿用 legacy 名 `film-<id>.png`**：URL 与文件名都不变，老前端与老缓存引用继续有效（spec D1「接管现有路由」）。
 * 分段图加 `-L<lv>-<seg>`，峰值 JSON 用自己的 `wavepeak-` 前缀（与 PNG 混在一个目录里靠扩展名区分）。
 * ⚠️ 清理侧的前缀匹配必须精确段（`film-1-` 会误伤 `film-11-`）——见 invalidateDerived。
 */
export function derivedFileName(kind: DerivedKind, importId: number, seg?: FilmSegRef): string {
  if (kind === 'film' || kind === 'wave') return `${kind}-${importId}.png`;
  const lv = seg?.level ?? 0;
  const segPart = lv === 0 ? '' : `-${seg!.seg}`;
  if (kind === 'filmSeg') return `film-${importId}-L${lv}${segPart}.png`;
  return `wavepeak-${importId}-L${lv}${segPart}.json`;
}
```

**(b) `FilmMeta` 类型加 `level` 字段**（`v` 已由 T1 升到 3）：

```ts
export type FilmMeta = { v: number; level: FilmLevel; sig: string; durationSec: number; tiles: number; generatedAt: string };
```
> `vf` 字段**删掉**：L0 改逐格 seek 后不再有单一滤镜串，老字段无意义。`readFilmMeta` 里对 `vf` 的必填校验同步删。

**(c) `generateDerivedImage` 的 film 分支改成逐格 seek 循环**。把 `args = buildFilmstripArgs(...)` 那一段（现 [derived-images.ts](file:///d:/Seed/sound-control-tool/server/src/media/derived-images.ts#L206-L207)）与后面 `const run = await new Promise(...)` 的单次执行，换成：

```ts
  // —— 分派：kind 决定「跑几次 ffmpeg、跑什么参数」——
  // wave      = legacy 整片 PNG（保留不删，混跑兼容；前端 T6 之后改用 wavePeak）
  // film      = L0 总览，36 格逐格 seek + 1 次 tile 拼接（实测 B1：10.29s vs 整解码 45–52s）
  // filmSeg   = L1/L2 单段，段内 12 格逐格 seek + tile 拼接（实测 B2：3.38s/段）
  // wavePeak  = astats 峰值走 stderr，产物是 JSON 不是图片（实测 B3b/B3c）
  // 统一：临时名 → rename、退出码 0 也要查 size>0、落盘前做变局分类（OCR R4-R10 沉淀，勿删）。
```

`(d)` 逐格 seek 的执行体（放在 `generateDerivedImage` 内，替换原单次 `doExec` 调用）：

```ts
  const doExec = o.doExec ?? execFile;
  const runCell = (args: string[]): Promise<{ ok: boolean; reason: string }> =>
    new Promise((resolveRun) => {
      doExec(ffmpegPath, args, { timeout: 120_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, _stdout, stderr) => {
        if (err) {
          const e = err as NodeJS.ErrnoException;
          const t = tail(stderr);
          pushLog('error', 'media', `派生图 ffmpeg 失败 kind=${o.kind} import=${o.importId} code=${e.code ?? '?'} stderr=${t}`);
          resolveRun({ ok: false, reason: `ffmpeg 失败（${e.code ?? '?'}）：${t}` });
          return;
        }
        resolveRun({ ok: true, reason: '' });
      });
    });

  // 逐格 seek 循环：每格一个临时小图，凑齐后 tile 拼成一张。
  // **任一格失败即整体失败**：半张雪碧图（12 格里 5 格空）比报错更糟 —— 用户看不出少了内容。
  const runFilmStrip = async (tiles: number, times: number[]): Promise<{ ok: boolean; reason: string }> => {
    const cellDir = join(o.tempDir, `cells-${o.kind}-${o.importId}-${uniq}`);
    mkdirSync(cellDir, { recursive: true });
    try {
      for (let i = 0; i < times.length; i += 1) {
        const cellPath = join(cellDir, `cell-${String(i).padStart(2, '0')}.png`);
        const r = await runCell(filmCellArgs(o.videoPath, cellPath, times[i]!));
        if (!r.ok) return { ok: false, reason: `第 ${i + 1}/${times.length} 格抽帧失败：${r.reason}` };
        // 退出码 0 ≠ 有产物（实测 G9 的教训，逐格也要查）
        let cellSize = 0;
        try { cellSize = statSync(cellPath).size; } catch { cellSize = 0; }
        if (cellSize <= 0) return { ok: false, reason: `第 ${i + 1}/${times.length} 格抽帧退出码 0 但无产物` };
      }
      const r = await runCell(filmTileArgs(tmp, cellDir, tiles));
      if (!r.ok) return { ok: false, reason: `tile 拼接失败：${r.reason}` };
      return { ok: true, reason: '' };
    } finally {
      // cell 临时件必清（36 个半成品堆在 temp/ 里，下次生成还会撞名）
      try { rmSync(cellDir, { recursive: true, force: true }); } catch { /* 尽力清理 */ }
    }
  };
```

`film`（L0）与 `filmSeg` 的分派：

```ts
    const tiles = FILM_LEVEL_TILES[lv];
    const times = sampleTimes(durationSec, lv, lv === 0 ? 0 : o.seg!.seg);
    filmMeta = { v: FILM_META_V, level: lv, sig: filmShapeSig(lv, tiles), durationSec, tiles, generatedAt: new Date().toISOString() };
    runLater = runFilmStrip(tiles, times);
```

`wave` / `wavePeak` 保留单次调用形态（`wavePeak` 在 T4 落地，本任务先让它走不通的显式失败，避免半成品代码混进基线）：

```ts
  if (o.kind === 'wavePeak') {
    // T4 落地：astats 峰值链路。本任务先明确失败，不给半成品路径。
    return { ok: false, code: 'FFMPEG_FAIL', message: '波形峰值链路尚未落地（Spec B T4）' };
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd server; npx vitest run src/media/derived-images.test.ts src/media/media-routes.test.ts`
Expected: PASS（既有全绿 + 新增 7 条）。

Run: `cd server; npx vitest run`
Expected: 全量绿，**用例数 ≥ 516**（只增不减）。

Run: `cd server; npx tsc --noEmit --pretty 2>&1 | Select-String "src/media|src/ffmpeg"`
Expected: 无输出。

> **预期红色提示**：本任务改完后 `checkDerivedCache` 若已被 T2 之外的调用点（`media-routes.ts`）以旧签名调用，typecheck 可能报错——那属于 T5 的活，**记录不修**。

- [ ] **Step 5: 快照 + review package + 记账本**，不 commit。

---

### Task 3: L1/L2 分段生成器与全级失效

**Files:**
- Create: `server/src/media/derived-pyramid.ts`
- Modify: `server/src/media/derived-images.ts`（`invalidateDerived`）
- Modify: `server/src/media/derived-images.test.ts`

**Interfaces:**
- Consumes: T1 全部参数函数；T2 的 `DerivedKind` / `derivedFileName` / `ensureDerivedImage` 新形态
- Produces:
  ```ts
  // derived-pyramid.ts
  export type LevelAvailability = { ok: true } | { ok: false; reason: 'TOO_SHORT' | 'LEVEL_DISABLED'; message: string };
  export function checkLevelAvailable(durationSec: number, level: FilmLevel): LevelAvailability;
  export function segmentFileMeta(durationSec: number, level: 1 | 2, seg: number): FilmMeta;
  export function ensureFilmSegment(o: { level: 1 | 2; seg: number; importId: number; videoPath: string; derivedDir: string; tempDir: string; db: DB; doExec?: ExecLike; probe?: typeof probeDuration; resolveFfmpeg?: (db: DB) => Promise<string | null>; sourceState?: (p: string) => 'current' | 'replaced' | 'gone' }): Promise<DerivedResult>;
  // derived-images.ts
  export function invalidateDerived(derivedDir: string, importId: number): { removed: number };
  ```

- [ ] **Step 1: 写失败的测试**

新建 `server/src/media/derived-pyramid.test.ts`（骨架照抄 `derived-images.test.ts` 的 beforeEach/桩）：

```ts
// server/src/media/derived-pyramid.test.ts
// L1/L2 分段雪碧图（Spec B T3）：真实临时目录 + 注入桩，不真拉 ffmpeg。
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type DB } from '../db/index.js';
import type { ExecLike } from './derived-images.js';
import { checkLevelAvailable, ensureFilmSegment, segmentFileMeta } from './derived-pyramid.js';

let root: string; let derivedDir: string; let tempDir: string; let db: DB; let stubBin: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sct-dp-'));
  derivedDir = join(root, 'derived'); tempDir = join(root, 'tmp');
  mkdirSync(tempDir, { recursive: true });
  stubBin = join(root, 'bin'); mkdirSync(stubBin, { recursive: true });
  writeFileSync(join(stubBin, 'ffmpeg.exe'), ''); writeFileSync(join(stubBin, 'ffprobe.exe'), '');
  db = openDatabase(':memory:');
});
afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

function execStub(behavior: (outPath: string) => { err?: Error; stderr?: string; write?: string }) {
  const calls: Array<{ bin: string; args: string[] }> = [];
  const fn = ((bin: string, args: string[], _o: unknown, cb: (e: Error | null, out: string, err: string) => void) => {
    calls.push({ bin, args });
    const out = args[args.length - 1]!;
    const b = behavior(out);
    if (b.write !== undefined) writeFileSync(out, b.write);
    if (b.err !== undefined) cb(b.err, '', b.stderr ?? ''); else cb(null, '', b.stderr ?? '');
  }) as unknown as ExecLike;
  return { fn, calls };
}
const resolveOk = async (): Promise<string | null> => join(stubBin, 'ffmpeg.exe');

describe('checkLevelAvailable（档位门槛，spec D5）', () => {
  it('L0 永远可用', () => expect(checkLevelAvailable(10, 0)).toEqual({ ok: true }));
  it('L2 需 duration > 300（D5 取整到 5 分钟），300 整不可用', () => {
    expect(checkLevelAvailable(300, 2).ok).toBe(false);
    expect(checkLevelAvailable(301, 2).ok).toBe(true);
  });
  it('L1 需至少有一个整窗（128s），不足 128s 不可用', () => {
    expect(checkLevelAvailable(128, 1).ok).toBe(true);
    expect(checkLevelAvailable(100, 1).ok).toBe(false);
  });
  it('不可用时 message 说清「多长才能用」，不是只说「失败」', () => {
    const r = checkLevelAvailable(100, 2);
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.message).toContain('300'); expect(r.message).toContain('2'); }
  });
});

describe('segmentFileMeta', () => {
  it('L1 第 3 段：tiles=12、sig 带 level=1、v=3', () => {
    const m = segmentFileMeta(1290.325333, 1, 3);
    expect(m.v).toBe(3);
    expect(m.level).toBe(1);
    expect(m.tiles).toBe(12);
    expect(m.sig).toContain('level=1');
    expect(m.durationSec).toBe(1290.325333);
  });
  it('同一段重复算出的 meta 逐字相同（签名里不许有时间/随机成分）', () => {
    expect(JSON.stringify(segmentFileMeta(600, 2, 5))).toBe(JSON.stringify(segmentFileMeta(600, 2, 5)));
  });
});

describe('ensureFilmSegment（单段生成）', () => {
  it('L1 第 0 段 → 12 格 cell + 1 次 tile；第 1 格 -ss=0，第 2 格 -ss=10.67（128/12）', async () => {
    const { fn, calls } = execStub(() => ({ write: 'PNG' }));
    const r = await ensureFilmSegment({ level: 1, seg: 0, importId: 1, videoPath: 'v.mp4', derivedDir, tempDir, db, doExec: fn, probe: async () => 1290.325333, resolveFfmpeg: resolveOk });
    expect(r).toMatchObject({ ok: true, cached: false });
    const cellCalls = calls.filter((c) => c.args.includes('-ss'));
    expect(cellCalls).toHaveLength(12);
    expect(cellCalls[0]!.args[cellCalls[0]!.args.indexOf('-ss') + 1]).toBe('0');
    expect(cellCalls[1]!.args[cellCalls[1]!.args.indexOf('-ss') + 1]).toBe('10.67');
    expect(existsSync(join(derivedDir, 'film-1-L1-0.png'))).toBe(true);
    expect(existsSync(join(derivedDir, 'film-1-L1-0.png.meta'))).toBe(true);
  });

  it('末段按实际 span 取点，不虚构超出片尾的时间（第 11 段 t0=1280，余 10.33s）', async () => {
    const { fn, calls } = execStub(() => ({ write: 'PNG' }));
    await ensureFilmSegment({ level: 1, seg: 10, importId: 2, videoPath: 'v.mp4', derivedDir, tempDir, db, doExec: fn, probe: async () => 1290.325333, resolveFfmpeg: resolveOk });
    const first = calls.find((c) => c.args.includes('-ss'))!;
    expect(first.args[first.args.indexOf('-ss') + 1]).toBe('1280');
  });

  it('命中缓存 → cached:true，零 doExec（L0/L1/L2 走同一套 meta 自愈）', async () => {
    const { fn, calls } = execStub(() => ({ write: 'PNG' }));
    await ensureFilmSegment({ level: 1, seg: 0, importId: 3, videoPath: 'v.mp4', derivedDir, tempDir, db, doExec: fn, probe: async () => 1290.325333, resolveFfmpeg: resolveOk });
    const r2 = await ensureFilmSegment({ level: 1, seg: 0, importId: 3, videoPath: 'v.mp4', derivedDir, tempDir, db, doExec: fn, probe: async () => 1290.325333, resolveFfmpeg: resolveOk });
    expect(r2).toMatchObject({ ok: true, cached: true });
    expect(calls.filter((c) => c.args.includes('-ss'))).toHaveLength(12); // 没有第二轮
  });

  it('档位不可用（2s 素材要 L2）→ 明确失败，不起 ffmpeg', async () => {
    const { fn, calls } = execStub(() => ({ write: 'PNG' }));
    const r = await ensureFilmSegment({ level: 2, seg: 0, importId: 4, videoPath: 'v.mp4', derivedDir, tempDir, db, doExec: fn, probe: async () => 2, resolveFfmpeg: resolveOk });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('300');
    expect(calls).toHaveLength(0);
  });

  it('素材在生成期间被换源 → SRC_CHANGED，产物丢弃（沿用 OCR 变局分类器）', async () => {
    let n = 0;
    const { fn } = execStub(() => { n += 1; return { write: 'PNG' }; });
    const r = await ensureFilmSegment({
      level: 1, seg: 0, importId: 5, videoPath: join(root, 'real.mp4'), derivedDir, tempDir, db, doExec: fn,
      probe: async () => 1290.325333, resolveFfmpeg: resolveOk,
      sourceState: () => 'gone', // 登记没了 = 素材被整个删除
    });
    // 若视频文件不存在 → 身份取不到 → 走③④分支，gone → 'deleted' → SRC_CHANGED
    expect(r.ok).toBe(false);
    if (!r.ok) expect(['SRC_CHANGED']).toContain(r.code);
    expect(existsSync(join(derivedDir, 'film-5-L1-0.png'))).toBe(false);
    void n;
  });

  it('temp 目录不留 cell 残留', async () => {
    const { fn } = execStub(() => ({ write: 'PNG' }));
    await ensureFilmSegment({ level: 1, seg: 1, importId: 6, videoPath: 'v.mp4', derivedDir, tempDir, db, doExec: fn, probe: async () => 1290.325333, resolveFfmpeg: resolveOk });
    expect(readdirSync(tempDir).filter((f) => f.startsWith('cells-'))).toHaveLength(0);
  });
});
```

在 `derived-images.test.ts` 追加（前缀碰撞这条是 spec D4 明确点名的坑）：

```ts
describe('invalidateDerived 全级清扫（spec D4）', () => {
  it('清掉 L0 + 所有 L1/L2 段 + 峰值 JSON + 各自 meta', () => {
    mkdirSync(derivedDir, { recursive: true });
    const names = ['film-1.png', 'film-1.png.meta', 'film-1-L1-0.png', 'film-1-L1-0.png.meta', 'film-1-L2-7.png', 'film-1-L2-7.png.meta', 'wavepeak-1-L0.json', 'wavepeak-1-L1-3.json'];
    for (const n of names) writeFileSync(join(derivedDir, n), 'x');
    const r = invalidateDerived(derivedDir, 1);
    expect(r.removed).toBe(names.length);
    expect(readdirSync(derivedDir)).toHaveLength(0);
  });

  it('⚠️ 前缀碰撞：清 importId=1 不得误删 importId=11 的任何文件（`film-1-` 会误匹配 `film-11-`）', () => {
    mkdirSync(derivedDir, { recursive: true });
    const keep = ['film-11.png', 'film-11.png.meta', 'film-11-L1-0.png', 'film-11-L2-7.png', 'film-11-L2-7.png.meta', 'wavepeak-11-L0.json', 'wavepeak-11-L1-3.json', 'wave-11.png'];
    for (const n of keep) writeFileSync(join(derivedDir, n), 'x');
    writeFileSync(join(derivedDir, 'film-1.png'), 'x');
    writeFileSync(join(derivedDir, 'film-1-L1-0.png'), 'x');
    const r = invalidateDerived(derivedDir, 1);
    expect(r.removed).toBe(2);
    for (const n of keep) expect(existsSync(join(derivedDir, n))).toBe(true);
  });

  it('⚠️ 同理不得误删 importId=1 与 10/12 的段文件（`film-1-L` vs `film-12-L` 是不同前缀，安全）', () => {
    mkdirSync(derivedDir, { recursive: true });
    for (const n of ['film-12-L1-0.png', 'film-10-L1-0.png', 'wavepeak-12-L0.json']) writeFileSync(join(derivedDir, n), 'x');
    invalidateDerived(derivedDir, 1);
    expect(readdirSync(derivedDir).sort()).toEqual(['film-10-L1-0.png', 'film-12-L1-0.png', 'wavepeak-12-L0.json']);
  });

  it('删失败只记日志、不抛（素材变化时清派生图不该让主流程挂掉，仓库规则）', () => {
    // 不存在的目录 → rmSync 失败 → 不抛、返回 removed:0
    expect(() => invalidateDerived(join(root, 'no-such-dir'), 9)).not.toThrow();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server; npx vitest run src/media/derived-pyramid.test.ts`
Expected: FAIL（模块不存在）。

Run: `cd server; npx vitest run src/media/derived-images.test.ts -t "invalidateDerived"`
Expected: FAIL（`invalidateDerived` 返回 void，`r.removed` 取不到）。

- [ ] **Step 3: 实现**

新建 `server/src/media/derived-pyramid.ts`：

```ts
// server/src/media/derived-pyramid.ts
// Spec B L1/L2 分段雪碧图：**复用** derived-images.ts 的缓存自愈 / 在途合并 / 原子落盘 / 变局分类
// （那些机制是 N0 + OCR 12 轮沉淀的地基，本文件不复制第二份 —— 复制即漂移）。
// 本文件只负责「段」这层概念：门槛判定、段 meta、单段生成。
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { DB } from '../db/index.js';
import { pushLog } from '../logs.js';
import type { probeDuration } from '../ytdlp/ffprobe.js';
import { FILM_META_V, FILM_LEVEL_TILES, filmShapeSig, sampleTimes, segmentSpan, type FilmLevel } from '../ffmpeg/derived-args.js';
import { ensureDerivedImage, type ExecLike, type FilmMeta, type DerivedResult } from './derived-images.js';

/**
 * 档位可用性门槛（spec D5：短视频不建全套缓存）。
 * - L0 永远可用（它就是「整片一张」，任何长度都需要）。
 * - L1 至少要有一个整窗（128s），否则第 0 段就是残段，不如直接用 L0。
 * - L2 服务端门槛 duration > 300（D5 原文「5 分钟」取整）；**服务端是权威判定方**，
 *   前端只做 UI 隐藏 —— 前端拿不到真实 duration 的场景（探测失败）不能靠前端放行。
 * ⚠️ 这两个阈值是**计划推导值**而非实测项（开放问题 1 已向用户说明）：L0 36 格与 L1 12 格/128s
 *   的密度 crossover 在 T≈384s，取 300 与 128 均为「宁可少一档也不要画一张几乎全是空白段的图」。
 *   异议只需改这两个数字，不动逻辑。
 */
export function checkLevelAvailable(durationSec: number, level: FilmLevel): { ok: true } | { ok: false; reason: 'TOO_SHORT'; message: string } {
  if (level === 0) return { ok: true };
  if (level === 1 && durationSec >= 128) return { ok: true };
  if (level === 2 && durationSec > 300) return { ok: true };
  const need = level === 1 ? '128' : '300';
  return { ok: false, reason: 'TOO_SHORT', message: `素材时长 ${Math.round(durationSec)}s，放不下一档 ${need}s 的窗口（本档要求 ${need}s${level === 2 ? '以上' : ''}）` };
}

/** 段 meta：L1/L2 每段固定 12 格，sig 带 level —— 命中判定逐字比对（沿用 N0 的自愈机制）。 */
export function segmentFileMeta(durationSec: number, level: 1 | 2, seg: number): FilmMeta {
  return {
    v: FILM_META_V,
    level,
    sig: filmShapeSig(level, FILM_LEVEL_TILES[level]),
    durationSec,
    tiles: FILM_LEVEL_TILES[level],
    generatedAt: new Date().toISOString(),
  };
}

/**
 * 单段生成。**所有缓存/并发/落盘/变局逻辑都委托给 ensureDerivedImage** —— 本函数只做三件事：
 *   ① 门槛判定（不可用就别起 ffmpeg）；② 算出采样点；③ 把段信息传下去。
 * 段采样点由 derived-args 的 sampleTimes 统一算（每格取区间起点，末段按实际 span 收窄），
 * 这里不重写一遍公式。
 */
export async function ensureFilmSegment(o: {
  level: 1 | 2; seg: number; importId: number; videoPath: string;
  derivedDir: string; tempDir: string; db: DB;
  doExec?: ExecLike; probe?: typeof probeDuration; resolveFfmpeg?: (db: DB) => Promise<string | null>;
  sourceState?: (p: string) => 'current' | 'replaced' | 'gone';
}): Promise<DerivedResult> {
  // 门槛要先判，但**需要 duration** → 与 ensureDerivedImage 一样走 probe。
  // 为避免「探两次时长」，这里只在 ffprobe 缺失/探测失败时按 derived-images 的口径明确失败。
  const probe = o.probe ?? (await import('../ytdlp/ffprobe.js')).probeDuration;
  const ffmpegPath = (o.resolveFfmpeg ?? (await import('./ffmpeg-path.js')).resolveFfmpegPath)(o.db) as unknown;
  void ffmpegPath; // 实际解析在 ensureDerivedImage 内部做，这里不重复解析（避免两次 await 与两处失败文案）
  const durationSec = await probe(
    // ffprobe 路径与 ensureDerivedImage 同口径（字符串推导），失败按 PROBE_FAIL 走
    (await import('./derived-images.js')).derivedProbePath(o.db) ?? 'ffprobe',
    o.videoPath, 60_000,
  );
  if (durationSec === null || !(durationSec > 0)) {
    pushLog('error', 'media', `分段雪碧图失败：探测不到素材时长 import=${o.importId} L${o.level}-${o.seg}`);
    return { ok: false, code: 'PROBE_FAIL', message: '素材信息读取失败，无法生成该段画轨：视频文件可能未下载完整或已损坏' };
  }
  const avail = checkLevelAvailable(durationSec, o.level);
  if (!avail.ok) {
    pushLog('info', 'media', `分段雪碧图跳过：档位不可用 import=${o.importId} L${o.level} duration=${durationSec.toFixed(2)}s reason=${avail.reason}`);
    return { ok: false, code: 'PROBE_FAIL', message: avail.message };
  }
  return ensureDerivedImage({
    kind: 'filmSeg', importId: o.importId, videoPath: o.videoPath,
    derivedDir: o.derivedDir, tempDir: o.tempDir, db: o.db,
    doExec: o.doExec, probe: o.probe, resolveFfmpeg: o.resolveFfmpeg, sourceState: o.sourceState,
    seg: { level: o.level, seg: o.seg },
    tiles: FILM_LEVEL_TILES[o.level],
    times: sampleTimes(durationSec, o.level, o.seg),
    metaFor: () => segmentFileMeta(durationSec, o.level, o.seg),
  });
}
```

> **实现者注意**：`ensureDerivedImage` 需要接受 `seg` / `tiles` / `times` / `metaFor` 四个新可选参数（未传时走 L0/wave 的老路径）。这一步是 T2 已备好的扩展点，**在 T2 就把它们留成可选字段并注释「T3 用」**——如果 T2 没留，现在补上并注明是 T3 的改动。

同时在 `derived-images.ts` 里把 `invalidateDerived` 换成前缀精确清扫：

```ts
/**
 * 素材一变（换集/换清晰度重下、删素材/删来源）→ **所有档位所有段**的派生图作废（spec D4）。
 *
 * ⚠️ **前缀精确匹配是这里唯一的坑**（OCR 沉淀的真事故形态）：
 *   朴素实现 `startsWith('film-1-')` 会把 `film-11-*.png`（importId=11 的段图）一起删掉 ——
 *   用户 B 的素材在用户 A 换源时被清缓存，B 打开页面只能重新生成（几十秒白等）。
 *   规则：段图名恒为 `film-<id>-L<lv>-<seg>.png`，所以段图的前缀必须写成 `film-<id>-L`；
 *   L0 与 wave 是**无后缀精确名**（`film-<id>.png` / `wave-<id>.png`），用 === 判。
 *
 * 删失败只记日志不抛：素材变化时清派生图不该让主流程挂掉（仓库规则：删除接口文件 IO 失败不让接口失败）。
 * 返回值给调用方记日志用（「清了几张」是排查素材重画的第一手数字）。
 */
export function invalidateDerived(derivedDir: string, importId: number): { removed: number } {
  const exact = new Set([`film-${importId}.png`, `film-${importId}.png.meta`, `wave-${importId}.png`, `wavepeak-${importId}-L0.json`]);
  const segPrefix = `film-${importId}-L`;
  const waveSegPrefix = `wavepeak-${importId}-L`;
  let removed = 0;
  let names: string[] = [];
  try { names = readdirSync(derivedDir); } catch { return { removed: 0 }; }
  for (const name of names) {
    const isTarget = exact.has(name)
      || (name.startsWith(segPrefix) && /\.png(\.meta)?$/.test(name))
      || (name.startsWith(waveSegPrefix) && /\.json$/.test(name));
    if (!isTarget) continue;
    try { rmSync(join(derivedDir, name), { force: true }); removed += 1; }
    catch (e) { pushLog('info', 'media', `清派生图失败(忽略) name=${name}: ${msgOf(e)}`); }
  }
  pushLog('debug', 'media', `清派生图 import=${importId} removed=${removed}`);
  return { removed };
}
```

需要在文件顶部 import 里补 `readdirSync`（**与其它 import 改动合并成同一次编辑**）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd server; npx vitest run src/media/derived-pyramid.test.ts src/media/derived-images.test.ts src/media/media-routes.test.ts`
Expected: PASS。

Run: `cd server; npx vitest run`
Expected: 全量绿，用例数 ≥ 516 + 本批新增。

Run: `cd server; npx tsc --noEmit --pretty 2>&1 | Select-String "src/media|src/ffmpeg"`
Expected: 无输出。

- [ ] **Step 5: 快照 + review package + 记账本**，不 commit。

---

### Task 4: 波形峰值生成器（astats 链路）

**Files:**
- Create: `server/src/media/wave-peaks.ts`
- Create: `server/src/media/wave-peaks.test.ts`
- Modify: `server/src/media/derived-images.ts`（接上 `wavePeak` 分支，替掉 T2 留的「尚未落地」占位）

**Interfaces:**
- Consumes: T1 的 `wavePeakArgs` / `WAVE_NSAMPLES` / `waveShapeSig`；T2 的 `derivedFileName` / `ensureDerivedImage`
- Produces:
  ```ts
  // wave-peaks.ts（纯解析，导出以便单测）
  export type WavePeakData = { v: number; sig: string; level: FilmLevel; seg: number; t0: number; stepSec: number; points: number[] };
  export function parseRmsStderr(stderr: string): number[];
  export function buildWavePeakJson(d: Omit<WavePeakData, 'v' | 'sig' | 'generatedAt'>): string;
  export function ensureWavePeaks(o: { level: FilmLevel; seg: number; importId: number; videoPath: string; derivedDir: string; tempDir: string; db: DB; durationSec: number; doExec?: ExecLike; resolveFfmpeg?: (db: DB) => Promise<string | null>; sourceState?: (p: string) => 'current' | 'replaced' | 'gone' }): Promise<{ ok: true; data: WavePeakData; cached: boolean } | { ok: false; code: 'NO_FFMPEG' | 'FFMPEG_FAIL'; message: string }>;
  ```

- [ ] **Step 1: 写失败的测试**

新建 `server/src/media/wave-peaks.test.ts`：

```ts
// server/src/media/wave-peaks.test.ts
// 波形峰值（Spec B T4）：**数据从 stderr 解析**（实测 B3b/B3c），不是从文件读。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type DB } from '../db/index.js';
import { WAVE_NSAMPLES } from '../ffmpeg/derived-args.js';
import type { ExecLike } from './derived-images.js';
import { buildWavePeakJson, ensureWavePeaks, parseRmsStderr } from './wave-peaks.js';

let root: string; let derivedDir: string; let tempDir: string; let db: DB; let stubBin: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sct-wp-'));
  derivedDir = join(root, 'derived'); tempDir = join(root, 'tmp');
  mkdirSync(tempDir, { recursive: true });
  stubBin = join(root, 'bin'); mkdirSync(stubBin, { recursive: true });
  writeFileSync(join(stubBin, 'ffmpeg.exe'), ''); writeFileSync(join(stubBin, 'ffprobe.exe'), '');
  db = openDatabase(':memory:');
});
afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

/** 造 astats 的 stderr：B3b 的真实输出形态 —— 每窗一行 `lavfi.astats.Overall.RMS_level=<值>` */
function rmsStderr(values: (number | string)[]): string {
  return ['frame:0    pts:0       pts_time:0', ...values.map((v, i) => `frame:${i} pts:${i * 3840} pts_time:${(i * 3840) / 48000}\nlavfi.astats.Overall.RMS_level=${v}`)].join('\n');
}
function execStderrStub(stderr: string, onCall?: (args: string[]) => void) {
  const calls: string[][] = [];
  const fn = ((_bin: string, args: string[], _o: unknown, cb: (e: Error | null, out: string, err: string) => void) => {
    calls.push(args); onCall?.(args); cb(null, '', stderr);
  }) as unknown as ExecLike;
  return { fn, calls };
}
const resolveOk = async (): Promise<string | null> => join(stubBin, 'ffmpeg.exe');

describe('parseRmsStderr（从 stderr 提 RMS，实测 B3b 的输出形态）', () => {
  it('1600 个有限值 → 解析出 1600 个点，顺序不乱', () => {
    const vals = Array.from({ length: 1600 }, (_, i) => -20 + (i % 7));
    expect(parseRmsStderr(rmsStderr(vals))).toEqual(vals);
  });
  it('-inf → -99（JSON 里 -Infinity 非法，前端 JSON.parse 会直接抛）', () => {
    expect(parseRmsStderr(rmsStderr([-20, '-inf', -30]))).toEqual([-20, -99, -30]);
  });
  it('inf / -inf / nan 一律归 -99（宁可信「静音」也不给前端 NaN）', () => {
    expect(parseRmsStderr(rmsStderr(['inf', '-inf', 'nan']))).toEqual([-99, -99, -99]);
  });
  it('非数字行忽略（ffmpeg 的进度/统计行混在 stderr 里）', () => {
    const s = `size=N/A time=00:00:24.00 bitrate=N/A speed=1.0x\n${rmsStderr([-21])}`;
    expect(parseRmsStderr(s)).toEqual([-21]);
  });
  it('一个 RMS 行都没有 → 返回空数组（由调用方明确失败，不落空 JSON）', () => {
    expect(parseRmsStderr('size=N/A time=00:00:24.00')).toEqual([]);
  });
});

describe('buildWavePeakJson（凭据字段固定，spec D4）', () => {
  it('含 v/sig/level/seg/t0/stepSec/points 七项，JSON 可被 JSON.parse', () => {
    const j = buildWavePeakJson({ level: 1, seg: 3, t0: 384, stepSec: 0.08, points: [-20, -99, -30] });
    const o = JSON.parse(j) as Record<string, unknown>;
    expect(Object.keys(o).sort()).toEqual(['level', 'points', 'seg', 'sig', 'stepSec', 't0', 'v']);
    expect(o.level).toBe(1); expect(o.seg).toBe(3); expect(o.t0).toBe(384);
    expect(o.points).toEqual([-20, -99, -30]);
  });
  it('stepSec 由 N 推出：L1 段 3840/48000 = 0.08s/点', () => {
    const o = JSON.parse(buildWavePeakJson({ level: 1, seg: 0, t0: 0, stepSec: 3840 / 48000, points: [-1] })) as { stepSec: number };
    expect(o.stepSec).toBeCloseTo(0.08, 5);
  });
});

describe('ensureWavePeaks（生成 + 缓存）', () => {
  it('L1 段 → 调一次 ffmpeg（-f null -），产物是 wavepeak-<id>-L1-<seg>.json', async () => {
    const { fn, calls } = execStderrStub(rmsStderr(Array.from({ length: 1600 }, () => -22)));
    const r = await ensureWavePeaks({ level: 1, seg: 3, importId: 1, videoPath: 'v.mp4', derivedDir, tempDir, db, durationSec: 1290.325333, doExec: fn, resolveFfmpeg: resolveOk });
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('-f');
    const p = join(derivedDir, 'wavepeak-1-L1-3.json');
    expect(existsSync(p)).toBe(true);
    const o = JSON.parse(readFileSync(p, 'utf8')) as { points: number[]; seg: number; t0: number };
    expect(o.points).toHaveLength(1600);
    expect(o.seg).toBe(3);
    expect(o.t0).toBeCloseTo(384, 2); // 128 × 3
  });

  it('L0 走全片：-ss/-t 都不带，N=48000，文件名不带段号', async () => {
    const { fn, calls } = execStderrStub(rmsStderr(Array.from({ length: 1290 }, () => -20)));
    const r = await ensureWavePeaks({ level: 0, seg: 0, importId: 2, videoPath: 'v.mp4', derivedDir, tempDir, db, durationSec: 1290.325333, doExec: fn, resolveFfmpeg: resolveOk });
    expect(r.ok).toBe(true);
    expect(calls[0]).not.toContain('-ss');
    expect(calls[0]).not.toContain('-t');
    expect(calls[0][calls[0]!.indexOf('-af') + 1]).toContain(`asetnsamples=${WAVE_NSAMPLES[0]}`);
    expect(existsSync(join(derivedDir, 'wavepeak-2-L0.json'))).toBe(true);
  });

  it('命中缓存 → 零 ffmpeg（第二遍 cached:true）', async () => {
    const { fn, calls } = execStderrStub(rmsStderr(Array.from({ length: 1600 }, () => -22)));
    await ensureWavePeaks({ level: 1, seg: 0, importId: 3, videoPath: 'v.mp4', derivedDir, tempDir, db, durationSec: 1290.325333, doExec: fn, resolveFfmpeg: resolveOk });
    const r2 = await ensureWavePeaks({ level: 1, seg: 0, importId: 3, videoPath: 'v.mp4', derivedDir, tempDir, db, durationSec: 1290.325333, doExec: fn, resolveFfmpeg: resolveOk });
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.cached).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('stderr 没有 RMS 行 → FFMPEG_FAIL，不落空 JSON（诚实原则：宁可报错也不给「一条平线」）', async () => {
    const { fn } = execStderrStub('size=N/A time=00:00:24.00 bitrate=N/A');
    const r = await ensureWavePeaks({ level: 1, seg: 0, importId: 4, videoPath: 'v.mp4', derivedDir, tempDir, db, durationSec: 1290.325333, doExec: fn, resolveFfmpeg: resolveOk });
    expect(r).toMatchObject({ ok: false, code: 'FFMPEG_FAIL' });
    expect(existsSync(join(derivedDir, 'wavepeak-4-L1-0.json'))).toBe(false);
  });

  it('ffmpeg 报错（带 stderr）→ FFMPEG_FAIL 且 message 含 stderr 尾行（三参回调，仓库规则）', async () => {
    const err = Object.assign(new Error('boom'), { code: 1 });
    const fn = ((_b: string, _a: string[], _o: unknown, cb: (e: Error | null, o: string, er: string) => void) => {
      cb(err, '', 'noise\nOutput file does not contain any stream');
    }) as unknown as ExecLike;
    const r = await ensureWavePeaks({ level: 1, seg: 0, importId: 5, videoPath: 'v.mp4', derivedDir, tempDir, db, durationSec: 1290.325333, doExec: fn, resolveFfmpeg: resolveOk });
    expect(r).toMatchObject({ ok: false, code: 'FFMPEG_FAIL' });
    if (!r.ok) expect(r.message).toContain('does not contain any stream');
  });

  it('ffmpeg 拿不到 → NO_FFMPEG，不调 doExec', async () => {
    const { fn, calls } = execStderrStub(rmsStderr([-1]));
    const r = await ensureWavePeaks({ level: 0, seg: 0, importId: 6, videoPath: 'v.mp4', derivedDir, tempDir, db, durationSec: 1290.325333, doExec: fn, resolveFfmpeg: async () => null });
    expect(r).toMatchObject({ ok: false, code: 'NO_FFMPEG' });
    expect(calls).toHaveLength(0);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server; npx vitest run src/media/wave-peaks.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现**

新建 `server/src/media/wave-peaks.ts`：

```ts
// server/src/media/wave-peaks.ts
// Spec B D2 · 多级波形峰值：服务端提取**峰值数组**（JSON），前端 Canvas 按当前缩放档位自绘。
// 数据源 = astats 修正链路（实测 B3b/B3c 裁决表②），**解析 stderr**——`-f null -` 不产出文件。
// ⚠️ 三条铁律（都是实测踩出来的）：
//   ① `reset=1` 固定，字面 `reset=44100` 实测 **480s 超时 + 334MB 日志**（B3a）——不要"优化"回去。
//   ② 只 `print:key=...RMS_level` 一个键：不带 key 会把 ~170 个指标/帧全打出来，日志爆炸才是慢的根因。
//   ③ 拿不到 RMS 行 → **明确失败**，绝不落一个空 points 的 JSON（前端会画成一条平线，
//      用户以为"这段没声音"——那是撒谎）。
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DB } from '../db/index.js';
import { pushLog } from '../logs.js';
import { FILM_META_V, WAVE_NSAMPLES, wavePeakArgs, waveShapeSig, type FilmLevel } from '../ffmpeg/derived-args.js';
import { derivedFileName, type ExecLike } from './derived-images.js';
import { resolveFfmpegPath } from './ffmpeg-path.js';

/** 峰值凭据：七项字段，spec D4 定的契约。points 是 RMS（dB，-99 = 静音/无效）。 */
export type WavePeakData = { v: number; sig: string; level: FilmLevel; seg: number; t0: number; stepSec: number; points: number[] };

const RMS_KEY = 'lavfi.astats.Overall.RMS_level=';

/**
 * 从 stderr 里抽 RMS 序列（**顺序即时间顺序**，ametadata=print 按帧打印）。
 * - 只认带 RMS_KEY 的行 —— ffmpeg 的进度行、统计行混在 stderr 里，不能误当数据。
 * - `-inf` / `inf` / `nan` 一律折成 **-99**：JSON 没有 Infinity/NaN 字面量，
 *   `JSON.stringify` 会把它们写成 `null`，前端 JSON.parse 后画不出东西还会报 NaN 错。
 *   -99 = 「这一窗没有有效电平」，前端按静音画（视觉上是一条基线），语义诚实。
 */
export function parseRmsStderr(stderr: string): number[] {
  const out: number[] = [];
  for (const raw of stderr.split(/\r?\n/)) {
    const line = raw.trim();
    const i = line.indexOf(RMS_KEY);
    if (i < 0) continue;
    const v = Number.parseFloat(line.slice(i + RMS_KEY.length).trim());
    if (!Number.isFinite(v)) out.push(-99);
    else out.push(v);
  }
  return out;
}

export function buildWavePeakJson(d: { level: FilmLevel; seg: number; t0: number; stepSec: number; points: number[] }): string {
  return JSON.stringify({ v: FILM_META_V, sig: waveShapeSig(d.level), level: d.level, seg: d.seg, t0: d.t0, stepSec: d.stepSec, points: d.points });
}

/** 命中判定：文件存在 + size>0 + v 对得上 + sig 逐字相同（与 PNG 派生图同一套自愈机制）。 */
function readPeakIfFresh(path: string, level: FilmLevel): WavePeakData | null {
  try {
    if (statSync(path).size <= 0) return null;
    const o = JSON.parse(readFileSync(path, 'utf8')) as Partial<WavePeakData>;
    if (o === null || typeof o !== 'object') return null;
    if (o.v !== FILM_META_V) return null;
    if (o.sig !== waveShapeSig(level)) return null;
    if (typeof o.level !== 'number' || typeof o.seg !== 'number' || typeof o.t0 !== 'number' || typeof o.stepSec !== 'number') return null;
    if (!Array.isArray(o.points) || o.points.length === 0) return null;
    if (!o.points.every((p) => typeof p === 'number')) return null;
    return o as WavePeakData;
  } catch { return null; }
}

/**
 * 生成（或命中）某档某段的波形峰值。
 * **不做在途合并**：峰值生成是秒级（L0 实测 2.31s），而 PNG 雪碧图是 10s+；且同一段并发请求
 * 在前端被视口去重挡掉一层。真出现并发时最多各跑一次 ffmpeg，代价可接受——不为它引入第二份在途表。
 */
export async function ensureWavePeaks(o: {
  level: FilmLevel; seg: number; importId: number; videoPath: string;
  derivedDir: string; tempDir: string; db: DB; durationSec: number;
  doExec?: ExecLike; resolveFfmpeg?: (db: DB) => Promise<string | null>;
  sourceState?: (p: string) => 'current' | 'replaced' | 'gone';
}): Promise<{ ok: true; data: WavePeakData; cached: boolean } | { ok: false; code: 'NO_FFMPEG' | 'FFMPEG_FAIL'; message: string }> {
  const dest = join(o.derivedDir, derivedFileName('wavePeak', o.importId, { level: o.level === 0 ? 0 : o.level, seg: o.seg } as never));
  const hit = readPeakIfFresh(dest, o.level);
  if (hit !== null) {
    pushLog('debug', 'media', `波形峰值命中缓存 import=${o.importId} L${o.level}-${o.seg} points=${hit.points.length}`);
    return { ok: true, data: hit, cached: true };
  }
  const resolve = o.resolveFfmpeg ?? resolveFfmpegPath;
  const bin = await resolve(o.db);
  if (bin === null) {
    pushLog('error', 'media', `波形峰值失败：ffmpeg 未找到 import=${o.importId}`);
    return { ok: false, code: 'NO_FFMPEG', message: 'ffmpeg 未找到或未配置：请到设置页配置 ffmpeg 路径' };
  }
  const n = WAVE_NSAMPLES[o.level];
  const segArg = o.level === 0 ? null : { t0: o.seg * (o.level === 1 ? 128 : 24), span: o.level === 1 ? 128 : 24 };
  const args = wavePeakArgs(o.videoPath, segArg, n);
  const tail = (s: string | undefined): string => (s ?? '').trim().split('\n').slice(-1)[0]?.slice(0, 200) || '(无 stderr 输出)';
  pushLog('info', 'media', `波形峰值生成开始 import=${o.importId} L${o.level}-${o.seg} n=${n} args=${args.join(' ')}`);
  const doExec = o.doExec ?? execFile;
  const run = await new Promise<{ ok: boolean; stderr: string }>((resolveRun) => {
    // maxBuffer 要给足：1600 行 RMS + ffmpeg 进度行实测 ~233KB，给 8MB 留余量
    doExec(bin, args, { timeout: 120_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, _stdout, stderr) => {
      if (err) {
        const e = err as NodeJS.ErrnoException;
        pushLog('error', 'media', `波形峰值 ffmpeg 失败 import=${o.importId} L${o.level}-${o.seg} code=${e.code ?? '?'} stderr=${tail(stderr)}`);
        resolveRun({ ok: false, stderr: stderr ?? '' });
        return;
      }
      resolveRun({ ok: true, stderr: stderr ?? '' });
    });
  });
  if (!run.ok) return { ok: false, code: 'FFMPEG_FAIL', message: `波形峰值提取失败：${tail(run.stderr)}` };
  const points = parseRmsStderr(run.stderr);
  if (points.length === 0) {
    // 诚实原则：没有数据就说没有，不落空 JSON 让前端画一条假平线
    pushLog('error', 'media', `波形峰值失败：stderr 里没有 RMS 行 import=${o.importId} L${o.level}-${o.seg} stderr=${tail(run.stderr)}`);
    return { ok: false, code: 'FFMPEG_FAIL', message: '波形峰值提取失败：ffmpeg 未输出音频统计（素材可能没有音轨）' };
  }
  const stepSec = n / 48000; // 48kHz 素材口径；非 48kHz 时点数按比例偏移，前端按 points.length 画，不依赖此值定位
  const json = buildWavePeakJson({ level: o.level, seg: o.seg, t0: segArg?.t0 ?? 0, stepSec, points });
  const uniq = `${Date.now()}-${randomBytes(4).toString('hex')}`;
  const tmp = join(o.tempDir, `wavepeak-${o.importId}-L${o.level}-${o.seg}-${uniq}.json`);
  try {
    mkdirSync(o.derivedDir, { recursive: true });
    writeFileSync(tmp, json, 'utf8');
    renameSync(tmp, dest); // 同盘原子：前端不会读到半截 JSON
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch { /* 尽力清理 */ }
    const msg = e instanceof Error ? e.message : String(e);
    pushLog('error', 'media', `波形峰值落盘失败 import=${o.importId} L${o.level}-${o.seg}: ${msg}`);
    return { ok: false, code: 'FFMPEG_FAIL', message: `波形峰值落盘失败：${msg}` };
  }
  pushLog('info', 'media', `波形峰值生成完成 import=${o.importId} L${o.level}-${o.seg} points=${points.length} bytes=${existsSync(dest) ? statSync(dest).size : 0}`);
  return { ok: true, data: JSON.parse(json) as WavePeakData, cached: false };
}
```

把 `derived-images.ts` 里 T2 留的 `wavePeak` 占位失败删掉，改为转调：

```ts
  if (o.kind === 'wavePeak') {
    // 波形峰值走独立模块（它要解析 stderr 而不是收 PNG，形态与图片分支差太多，硬塞进来会让本文件失控）
    const { ensureWavePeaks } = await import('./wave-peaks.js');
    if (durationSec === null || !(durationSec > 0)) {
      return { ok: false, code: 'PROBE_FAIL', message: '素材信息读取失败，无法生成波形：视频文件可能未下载完整或已损坏' };
    }
    return ensureWavePeaks({ level: 1, seg: 0, importId: o.importId, videoPath: o.videoPath, derivedDir: o.derivedDir, tempDir: o.tempDir, db: o.db, durationSec, doExec: o.doExec, resolveFfmpeg: o.resolveFfmpeg, sourceState: o.sourceState });
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd server; npx vitest run src/media/wave-peaks.test.ts`
Expected: PASS（12 条）。

Run: `cd server; npx vitest run`
Expected: 全量绿。

- [ ] **Step 5: 快照 + review package + 记账本**，不 commit。

---

### Task 5: 路由与前端 API

**Files:**
- Modify: `server/src/media/media-routes.ts`
- Modify: `server/src/media/media-routes.test.ts`
- Modify: `web/src/api.ts`

**Interfaces:**
- Consumes: T2 `derivedFileName` / `ensureDerivedImage`；T3 `ensureFilmSegment` / `checkLevelAvailable`；T4 `ensureWavePeaks`
- Produces（前端可用的 URL 构造函数，`web/src/api.ts`）：
  ```ts
  export function filmstripUrl(importId: number, rev: string | number): string;                                  // 不变（L0 接管）
  export function waveformUrl(importId: number, rev: string | number): string;                                   // 不变（legacy PNG 保留）
  export function filmSegUrl(importId: number, level: 1 | 2, seg: number, rev: string | number): string;
  export function wavePeakUrl(importId: number, level: 0 | 1 | 2, seg: number, rev: string | number): string;
  ```

- [ ] **Step 1: 写失败的测试**

在 `media-routes.test.ts` 追加：

```ts
describe('分段/峰值路由（Spec B）', () => {
  it('GET /api/media/:id/filmseg?level=1&seg=3 → 200 image/png（鉴权走 query token 三件套）', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/media/1/filmseg?level=1&seg=3&token=${token}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('image/png');
  });
  it('level 非法（0 / 3 / 缺省 / 非数字）→ 400 并说清只接受 1 或 2', async () => {
    const r1 = await app.inject({ method: 'GET', url: `/api/media/1/filmseg?level=3&seg=0&token=${token}` });
    expect(r1.statusCode).toBe(400);
    const r2 = await app.inject({ method: 'GET', url: `/api/media/1/filmseg?seg=0&token=${token}` });
    expect(r2.statusCode).toBe(400);
    expect(r2.json().error.message).toContain('1');
  });
  it('段号越界 → 404（不静默夹到最后一段：那样图和 URL 说的不是同一段）', async () => {
    const r = await app.inject({ method: 'GET', url: `/api/media/1/filmseg?level=1&seg=9999&token=${token}` });
    expect(r.statusCode).toBe(404);
  });
  it('档位不可用（素材太短要 L2）→ 404 且文案说清要多久（D5 诚实原则）', async () => {
    const r = await app.inject({ method: 'GET', url: `/api/media/2/filmseg?level=2&seg=0&token=${token}` });
    expect(r.statusCode).toBe(404);
    expect(r.json().error.message).toContain('300');
  });
  it('无 token 且非本机 origin → 401（三件套照抄，不许因新路由开天窗）', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/media/1/filmseg?level=1&seg=0', headers: { origin: 'http://evil.example' } });
    expect(r.statusCode).toBe(401);
  });
  it('GET /api/media/:id/wavepeak?level=1&seg=0 → 200 application/json，body 七字段齐全', async () => {
    const r = await app.inject({ method: 'GET', url: `/api/media/1/wavepeak?level=1&seg=0&token=${token}` });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('application/json');
    const o = r.json() as Record<string, unknown>;
    for (const k of ['v', 'sig', 'level', 'seg', 't0', 'stepSec', 'points']) expect(o).toHaveProperty(k);
  });
  it('wavepeak 的 level=0 合法（整片一张），level=1/2 需段号', async () => {
    expect((await app.inject({ method: 'GET', url: `/api/media/1/wavepeak?level=0&token=${token}` })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/api/media/1/wavepeak?level=1&token=${token}` })).statusCode).toBe(400);
  });
  it('legacy /filmstrip 与 /waveform 仍在（混跑兼容，不删）', async () => {
    expect((await app.inject({ method: 'GET', url: `/api/media/1/filmstrip?token=${token}` })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/api/media/1/waveform?token=${token}` })).statusCode).toBe(200);
  });
});
```

> 实现者注意：本测试文件现有的 `app` / `token` / 素材桩怎么写的就怎么复用，**不要新建第二个 describe 块的 app**。素材 1 是长素材（够 L1/L2），素材 2 是短素材（触发 D5 门槛）——若现有桩只有一个素材，按现有桩的方式再加一个短素材并在 `beforeEach` 里登记。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server; npx vitest run src/media/media-routes.test.ts`
Expected: FAIL（404 route not found）。

- [ ] **Step 3: 实现**

**(a) `DERIVED_FAIL` 加两行**（新失败码只加一行，仓库口径）：

```ts
  // Spec B：档位门槛不满足 = 「这个素材没有这一档」，不是服务端故障。404 + 说清要多久。
  LEVEL_UNAVAILABLE: { status: 404, next: '素材太短，放不下这一档的时间窗；换一个更长的素材，或用更粗的档位' },
  BAD_SEGMENT: { status: 400, next: '段号或档位参数不对（档位只接受 1 / 2，段号从 0 起）' },
```

并在 `DerivedResult` 联合里加 `'LEVEL_UNAVAILABLE' | 'BAD_SEGMENT'`（T3 的 `ensureFilmSegment` 返回的就是它们）。

**(b) 两个新路由**（`serveDerived` 的鉴权三件套**逐字照抄**，不许简化）：

```ts
  // —— Spec B：分段雪碧图（?level=1|2&seg=N）——
  // 鉴权/404/失败映射与 serveDerived 完全同口径 —— 复制它的三件套，别自己"简化"。
  app.get('/api/media/:importId/filmseg', async (req, reply) => {
    const importId = Number((req.params as { importId: string }).importId);
    const q = (req.query ?? {}) as { token?: string; level?: string; seg?: string };
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
    if (q.token !== token && !isAllowedLocalOrigin(origin) && !isLocalPageReferer(req.headers.referer)) {
      pushLog('error', 'media', `分段雪碧图 401 import=${importId} origin=${origin || '(none)'} token=${q.token ? 'present' : 'missing'}`);
      return reply.code(401).send({ ok: false, error: { code: 'UNAUTHORIZED', message: 'token 无效', next: '' } });
    }
    if (!Number.isInteger(importId) || importId <= 0) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: '素材不存在', next: '' } });
    const level = Number(q.level);
    const seg = Number(q.seg);
    if ((level !== 1 && level !== 2) || !Number.isInteger(seg) || seg < 0) {
      // 参数错是**用法错**（400），不是素材不在（404）—— 前端拼错 URL 时能一眼看出来
      pushLog('error', 'media', `分段雪碧图 400 import=${importId} level=${q.level ?? '(none)'} seg=${q.seg ?? '(none)'}`);
      return reply.code(400).send({ ok: false, error: { code: 'BAD_SEGMENT', message: '档位只接受 1 或 2，段号是从 0 起的整数', next: '检查请求参数 level 与 seg' } });
    }
    const row = videosRepo.get(importId);
    if (!row) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: '素材不存在', next: '' } });
    if (!existsSync(row.file_path)) return reply.code(404).send({ ok: false, error: { code: 'FILE_MISSING', message: '素材文件已丢失，请重新下载视频', next: '回到资料库重新下视频' } });
    const r = await ensureFilmSegment({ level, seg, importId, videoPath: row.file_path, derivedDir: derivedDirFor(mediaDir), tempDir: deps.tempDir, db, sourceState: (p) => { const cur = videosRepo.get(importId); if (cur === null) return 'gone'; return cur.file_path === p ? 'current' : 'replaced'; } });
    if (!r.ok) {
      // 门槛不满足（素材太短）与真失败要分开：前者是 404「没这一档」，后者按 DERIVED_FAIL 映射
      const fail = DERIVED_FAIL[r.code];
      pushLog('error', 'media', `分段雪碧图接口失败 import=${importId} L${level}-${seg} code=${r.code} msg=${r.message.slice(0, 200)}`);
      return reply.code(fail.status).send({ ok: false, error: { code: r.code, message: r.message, next: fail.next } });
    }
    reply.header('content-type', 'image/png').header('cache-control', 'no-store');
    return reply.send(createReadStream(r.path));
  });

  // —— Spec B：波形峰值 JSON ——
  app.get('/api/media/:importId/wavepeak', async (req, reply) => {
    // 同款鉴权三件套（<img> 拿不到 header，但 fetch 能拿；仍认 query token 以便 <img> 兜底与调试）
    ... 同 filmseg 的三件套 ...
    const durationSec = await probeDuration(ffprobePath, row.file_path, PROBE_TIMEOUT_MS);
    const r = await ensureWavePeaks({ level, seg, importId, videoPath: row.file_path, derivedDir: derivedDirFor(mediaDir), tempDir: deps.tempDir, db, durationSec });
    // JSON 产物：cache-control 同 PNG 用 no-store（素材一变即作废、URL 不变）
    reply.header('content-type', 'application/json; charset=utf-8').header('cache-control', 'no-store');
    return reply.send(r.data);
  });
```

**(c) `web/src/api.ts`** 追加两个 URL 构造函数（**只加不改**既有 `filmstripUrl` / `waveformUrl`）：

```ts
/** Spec B 分段雪碧图：level 1/2 + 段号（128s / 24s 窗）。取图口径同 filmstripUrl —— query token。 */
export function filmSegUrl(importId: number, level: 1 | 2, seg: number, rev: string | number): string {
  const token = apiToken();
  return `${API_BASE}/api/media/${importId}/filmseg?level=${level}&seg=${seg}&token=${encodeURIComponent(token ?? '')}&rev=${encodeURIComponent(String(rev))}`;
}
/** Spec B 波形峰值 JSON：level 0 = 整片一张（无段号），1/2 = 分段。 */
export function wavePeakUrl(importId: number, level: 0 | 1 | 2, seg: number, rev: string | number): string {
  const token = apiToken();
  const segPart = level === 0 ? '' : `&seg=${seg}`;
  return `${API_BASE}/api/media/${importId}/wavepeak?level=${level}${segPart}&token=${encodeURIComponent(token ?? '')}&rev=${encodeURIComponent(String(rev))}`;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd server; npx vitest run src/media/media-routes.test.ts`
Expected: PASS。

Run: `cd server; npx vitest run` + `npx tsc --noEmit --pretty`（server）
Run: `cd web; npx tsc --noEmit --pretty` —— 允许有「T6/T7 才消费的未用导出」以外的错误；**新增的未用函数不算错**（tsc 不报未使用导出）。

- [ ] **Step 5: 快照 + review package + 记账本**，不 commit。

---

### Task 6: 波形 Canvas 自绘组件

**Files:**
- Create: `web/src/components/TimelineWave.tsx`
- Modify: `web/src/api.ts`（若 T5 未加 `fetchWavePeaks`，在这里补）

**Interfaces:**
- Consumes: T5 的 `wavePeakUrl`
- Produces:
  ```tsx
  export type WavePeaks = { v: number; sig: string; level: 0 | 1 | 2; seg: number; t0: number; stepSec: number; points: number[] };
  export function TimelineWave(props: {
    importId: number; rev: string | number; duration: number;
    level: 0 | 1 | 2;              // 当前档位（T7 传入）
    windowStart: number;            // 可视窗口起点（秒）
    windowSpan: number;             // 可视窗口跨度（秒）
    height: number;
    onRetry?: () => void;           // 失败占位上的「重试」回调
  }): JSX.Element;
  ```

- [ ] **Step 1: 先确认前端测试现状**

Run: `cd web; npx vitest run 2>&1 | Select-Object -Last 5`
Expected: 若报「no test files」→ **本仓 web 无单测**，T6 用「typecheck + build + 人工目验」验收，不要为此新建测试框架（超出本任务范围，记在账本里）。

- [ ] **Step 2: 实现组件**

新建 `web/src/components/TimelineWave.tsx`（**内联 style，不建 sc**，仓库惯例）：

```tsx
// web/src/components/TimelineWave.tsx
// Spec B D2 · 波形自绘：从「一张固定 PNG」改成「Canvas 按当前缩放档位重绘」。
// 为什么不用 PNG：showwavespic 出的图是固定样式，画完就死了 —— 放大后看不出局部疏密（spec §2.5 的原始反馈）。
// 为什么不用 wavesurfer.js：m2-workspace D6 裁决明确不引（既有裁决，本批不重开讨论）。
// 画法：每个像素列取该列覆盖的点数里的 min/max 画竖线（包络）。放大后点数被摊到更多列 →
//   局部疏密自然显现，这正是 D2 要的「放大后能看到局部疏密」。
import { useCallback, useEffect, useRef, useState } from 'react';
import { Typography } from 'antd';
import { logFe } from '../api';
import { wavePeakUrl, type WavePeaks } from '../api';

// dB → 0..1 的高度。-99（静音/无效）画成基线高度 0；-60dB 画到满格。
// 上下界取自 RMS 的常见范围：数字音频的 RMS 落在 [-60, 0] dB，安静片段约 -50~-40。
const dbToUnit = (db: number): number => {
  if (db <= -99) return 0;
  return Math.max(0, Math.min(1, (db + 60) / 60));
};

export function TimelineWave(props: {
  importId: number; rev: string | number; duration: number;
  level: 0 | 1 | 2; windowStart: number; windowSpan: number; height: number;
  onRetry?: () => void;
}): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [data, setData] = useState<WavePeaks | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);

  const levelRef = useRef(props.level);
  levelRef.current = props.level;

  // 档位切换 → 重新取对应档的峰值。L0 永远有（整片一张），L1/L2 可能 404（素材太短）→ 走下面的占位。
  useEffect(() => {
    const id = ++seq.current;
    setLoading(true); setErr(null);
    const url = wavePeakUrl(props.importId, props.level, 0, props.rev);
    fetch(url)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return (await r.json()) as WavePeaks;
      })
      .then((d) => { if (id !== seq.current) return; setData(d); setLoading(false); })
      .catch((e: Error) => {
        if (id !== seq.current) return;
        setData(null); setErr(e.message); setLoading(false);
        logFe('error', `波形峰值加载失败 import=${props.importId} level=${props.level}: ${e.message}`);
      });
    return () => { seq.current += 1; };
  }, [props.importId, props.level, props.rev]);

  // 重绘：数据、窗口、尺寸任一变化都重画。devicePixelRatio 处理 —— 不做的话 2x 屏上波形是糊的。
  const paint = useCallback((): void => {
    const cv = canvasRef.current;
    if (cv === null) return;
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth; const h = props.height;
    if (w <= 0 || h <= 0) return;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    }
    const g = cv.getContext('2d');
    if (g === null) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    g.fillStyle = '#0b1220'; g.fillRect(0, 0, w, h);
    if (data === null || data.points.length === 0) return;
    const mid = h / 2;
    g.strokeStyle = '#22d3ee'; g.lineWidth = 1;
    const span = Math.max(0.001, props.windowSpan);
    const t0 = data.t0;
    const tEnd = t0 + data.points.length * data.stepSec;
    // 只画落在可视窗口里的点：窗口外的不画（省一半绘制，也避免把窗口外的波形压扁进视口）
    for (let px = 0; px < w; px += 1) {
      const ta = props.windowStart + (px / w) * span;
      const tb = props.windowStart + ((px + 1) / w) * span;
      let ia = Math.floor((ta - t0) / data.stepSec);
      let ib = Math.ceil((tb - t0) / data.stepSec);
      if (ib <= 0 || ia >= data.points.length) continue;
      ia = Math.max(0, ia); ib = Math.min(data.points.length, ib);
      let lo = 0; let hi = 0; let any = false;
      for (let i = ia; i < ib; i += 1) {
        const u = dbToUnit(data.points[i]!);
        if (!any) { lo = hi = u; any = true; } else { if (u < lo) lo = u; if (u > hi) hi = u; }
      }
      if (!any) continue;
      const yTop = mid - hi * (mid - 1);
      const yBot = mid - lo * (mid - 1);
      g.beginPath(); g.moveTo(px + 0.5, yTop); g.lineTo(px + 0.5, Math.max(yBot, yTop + 0.5)); g.stroke();
    }
    void tEnd;
  }, [data, props.height, props.windowSpan, props.windowStart]);

  useEffect(() => { paint(); }, [paint]);
  useEffect(() => {
    const onResize = (): void => paint();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [paint]);

  if (err !== null) {
    // 失败段：斜纹占位 + 重试（spec D5：**不用邻段内容冒充**）
    return (
      <div style={{
        height: props.height, display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'repeating-linear-gradient(45deg,#1a202c,#1a202c 8px,#232b3b 8px,#232b3b 16px)',
      }}>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          波形生成失败（{err}）
          {props.onRetry !== undefined && <a onClick={props.onRetry} style={{ marginLeft: 8 }}>重试</a>}
        </Typography.Text>
      </div>
    );
  }
  return (
    <div style={{ position: 'relative', height: props.height }}>
      <canvas ref={canvasRef} style={{ display: 'block', width: '100%', height: props.height }} />
      {loading && <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}><Typography.Text type="secondary" style={{ fontSize: 12 }}>波形加载中…</Typography.Text></div>}
    </div>
  );
}
```

- [ ] **Step 3: 验证**

Run: `cd web; npx tsc --noEmit --pretty 2>&1 | Select-String "TimelineWave"`
Expected: 无输出。

Run: `cd web; npm run build`
Expected: EXIT=0（此时组件还没被用上，tree-shaking 会把它摇掉，不影响 build）。

- [ ] **Step 4: 快照 + review package + 记账本**，不 commit。

---

### Task 7: 缩放 / 平移 / 分段画轨

**Files:**
- Modify: `web/src/pages/studio-detail.tsx`

**Interfaces:**
- Consumes: T5 的 `filmSegUrl` / `filmstripUrl`；T6 的 `TimelineWave`
- Produces: 无（页面内状态，不外泄）

- [ ] **Step 1: 先加缩放状态与换算（纯逻辑，先不接 UI）**

在 `studio-detail.tsx` 里，紧跟 `const [duration, setDuration] = useState(0)` 之后加：

```tsx
  // —— Spec B：缩放档位与可视窗口 ——
  // 档位离散三档（spec D3：不做无级平滑缩放，本地工具够用且实现简单、行为可预期）。
  //   L0 = 整片一张（36 格）→ L1 = 128s 窗（12 格）→ L2 = 24s 窗（12 格）
  // **windowSpan 是「视口能看到多少秒」**，windowStart 是「视口从第几秒开始」——
  // 段区块/播放头/刻度全部按它换算，不再按 duration 百分比（那是 L0 专属的算法）。
  const [level, setLevel] = useState<0 | 1 | 2>(0);
  const [windowStart, setWindowStart] = useState(0);
  const levelSpan = level === 0 ? (duration > 0 ? duration : 1) : level === 1 ? 128 : 24;
  /** 当前档位下可见的段号集合（画轨要按段取图；空数组 = 用 L0 整片图） */
  const visibleSegs = useMemo(() => {
    if (level === 0 || duration <= 0) return [];
    const n = Math.max(1, Math.ceil(duration / levelSpan));
    const first = Math.max(0, Math.floor(windowStart / levelSpan));
    const last = Math.min(n - 1, Math.floor((windowStart + levelSpan) / levelSpan));
    return Array.from({ length: last - first + 1 }, (_, i) => first + i);
  }, [level, duration, levelSpan, windowStart]);
  // 窗口越界校正：素材换了 / 档位变了 / 拖到片尾 → 别让窗口停在空白区
  useEffect(() => {
    if (duration <= 0) return;
    setWindowStart((w) => Math.max(0, Math.min(w, Math.max(0, duration - levelSpan))));
  }, [duration, level, levelSpan]);
  const timeToPct = useCallback((t: number): number => ((t - windowStart) / levelSpan) * 100, [windowStart, levelSpan]);
  // xToTime 的反向：拖动定位/拖边微调都要用它把「时间」写回「像素位置」
  const pctToTime = useCallback((p: number): number => windowStart + (p / 100) * levelSpan, [windowStart, levelSpan]);
```

- [ ] **Step 2: 替换时间换算的三个调用点**

| 位置 | 改法 |
|---|---|
| `xToTime`（现 [studio-detail.tsx](file:///d:/Seed/sound-control-tool/web/src/pages/studio-detail.tsx#L394-L400)） | 内部由 `(px/width)*duration` 改成 `windowStart + (px/width)*levelSpan`，并把 `duration` 依赖换成 `levelSpan`。**注释要写明「这是缩放版的换算，L0 时它与旧公式等价」**。 |
| 时间尺刻度 `left: ${(i / 10) * 100}%` | 改成 `timeToPct(windowStart + (levelSpan * i) / 10)`，刻度文字用 `fmtTime(windowStart + (levelSpan * i) / 10)`。10 等分保持。 |
| 段区块 `left` / `width` | `left: ${timeToPct(s.start_sec)}%`、`width: ${((Math.min(s.end_sec, windowStart + levelSpan) - Math.max(s.start_sec, windowStart)) / levelSpan) * 100}%`（**裁剪到窗口**，否则窗口外的段会画到容器外）。 |
| 播放头 `left: ${pct}%` | 改成 `timeToPct(current)`，窗口外时 `display:'none'`。 |

- [ ] **Step 3: 画轨按段渲染**

把现 `<img src={filmstripUrl(...)}>` 换成：

```tsx
                {/* 画轨：L0 = 整片一张（URL 不变，向后兼容）；L1/L2 = 按可视窗口取段。
                    objectFit:'contain' + 等比高（沿用 N2-b：不变形、不裁）。
                    段图按窗口偏移量左移，使段边界与时间轴对齐（关键：段与段不能有缝也不能重叠）。 */}
                {level === 0 ? (
                  <img
                    src={filmstripUrl(importId, version)}
                    alt="画轨"
                    onLoad={() => setFilmReady(true)}
                    onError={() => { setFilmReady(true); logFe('error', `胶片条加载失败 import=${importId}`); }}
                    style={{ display: 'block', width: '100%', height: filmH, objectFit: 'contain', background: '#111' }}
                  />
                ) : (
                  <div style={{ position: 'relative', width: '100%', height: filmH, background: '#111', overflow: 'hidden' }}>
                    {visibleSegs.map((seg) => {
                      const segT0 = seg * levelSpan;
                      // 段在窗口内的左边界（%）：段起点 - 窗口起点
                      const leftPct = ((segT0 - windowStart) / levelSpan) * 100;
                      // 段图自身显示宽度（%）：段实际 span（末段可能是余数）
                      const segSpan = Math.min(levelSpan, duration - segT0);
                      const widthPct = (segSpan / levelSpan) * 100;
                      return (
                        <img
                          key={seg}
                          src={filmSegUrl(importId, level as 1 | 2, seg, version)}
                          alt={`画轨段 ${seg}`}
                          onLoad={() => setFilmReady(true)}
                          onError={() => { setFilmReady(true); logFe('error', `分段画轨加载失败 import=${importId} L${level}-${seg}`); }}
                          style={{ position: 'absolute', left: `${leftPct}%`, width: `${widthPct}%`, height: filmH, objectFit: 'fill' }}
                        />
                      );
                    })}
                  </div>
                )}
```

- [ ] **Step 4: 波形换成 Canvas**

把现 `<img src={waveformUrl(...)}>` 换成：

```tsx
                {/* 音轨：Spec B 起为 Canvas 自绘（按当前档位重绘，放大后能看到局部疏密）。
                    失败显示斜纹占位 + 重试（spec D5 诚实原则，不用邻段冒充）。 */}
                <TimelineWave
                  importId={importId}
                  rev={version}
                  duration={duration}
                  level={level}
                  windowStart={windowStart}
                  windowSpan={levelSpan}
                  height={waveH}
                  onRetry={() => logFe('info', `用户重试波形 import=${importId} L${level}`)}
                />
```

**import 补进文件顶部**（与其它改动**同一次编辑**完成）：
```tsx
import { filmSegUrl } from '@/api';   // 按仓库路径规范：项目级公共资源用 @/
import { TimelineWave } from '@/components/TimelineWave';
```

- [ ] **Step 5: Ctrl+滚轮缩放（useEffect 原生监听，`{passive:false}`）**

```tsx
  // Ctrl+滚轮 = 切档（spec D3）。**必须 useEffect + addEventListener(…, {passive:false})**：
  // React 的 onWheel 在 React 17+ 挂在根容器上、且是 passive 的，拦不住页面滚动（Ctrl+滚轮在浏览器里
  // 本来就是缩放整页，我们要在时间轴范围内接管它）。带上 trackRef 判定「指针在不在时间轴上」。
  // ⚠️ 缩放锚点 = 光标处的时间点：档位切换后那个时间点必须**留在同一像素位置**，否则
  //   每次缩放都会「跳」一下（用户要找的位置跑了），这是缩放手感的关键。
  useEffect(() => {
    const el = trackRef.current;
    if (el === null) return undefined;
    const onWheel = (ev: WheelEvent): void => {
      if (!ev.ctrlKey) return; // 普通滚轮照常翻页面，不抢
      if (duration <= 0) return;
      ev.preventDefault();
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0) return;
      const ratio = (ev.clientX - rect.left) / rect.width;
      if (ratio < 0 || ratio > 1) return; // 指针不在时间轴上 → 让浏览器缩放整页
      const anchorT = windowStart + ratio * levelSpan; // 光标处的时间（切换前）
      const next = ev.deltaY < 0 ? Math.min(2, level + 1) : Math.max(0, level - 1);
      if (next === level) return;
      setLevel(next);
      // 换档后按新窗长把锚点放回同一像素位置（近似：档位切换时窗长按 128/24 的比例变，
      // 这里用「锚点在新窗内的相对位置不变」来算，误差在半格以内，用户感知不到）
      const newSpan = next === 0 ? duration : next === 1 ? 128 : 24;
      const ratio2 = newSpan > 0 ? (anchorT / duration) * 1 : 0;
      setWindowStart(Math.max(0, Math.min(duration - newSpan, anchorT - ratio2 * newSpan)));
      logFe('info', `时间轴缩放 project=${projectId} level=${level}→${next} anchor=${anchorT.toFixed(2)}s`);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [duration, level, levelSpan, windowStart, projectId]);
```

> **实现者注意**：上面的锚点保持是**近似算法**。若真机目验觉得「缩放时锚点漂移明显」，改为「记录指针相对时间轴的像素 x，换档后 `newStart = anchorT - ratio * newSpan`」（`ratio` 用**旧**窗长算的 `ratio` 复用，而不是 `anchorT/duration`）。计划给的是起步版本，**目验后调**属正常。

- [ ] **Step 6: 缩放态的手势分权（spec D3 的切换规则，必须注释写死）**

在 `startScrub` 之前插入：

```tsx
  // —— Spec B D3 · 手势分权（**切换规则写死在此注释，实现不许临时发挥**）——
  //   ① L0（最粗档）：空白区拖动 = **拖动定位 seek**（N2-c 行为**原样保持**，不因引入缩放而变）
  //   ② L1/L2：空白区拖动 = **平移视口**；**单击（位移 < 4px）= seek**（用户仍能一步定位）
  //   ③ 段区块左右 8px 拖柄 = 拖边微调（任何档位都不变，dragEdge 已 stopPropagation）
  //   ④ 段区块中部 click = 选中（任何档位都不变）
  // 为什么这样切：L0 是「一屏看全片」，用户在 L0 想的是定位；放大后用户想的是「挪窗口看别处」，
  //   同一个手势在两种意图下必须是两件事，否则二者必抢。**判据是「有没有位移」**：
  //   位移 0 = 点一下 = 定位（意图明确）；位移 > 0 = 拖 = 挪窗口（意图明确）。
```

`startScrub` 内部改两处：
1. `pointerdown` 时记 `downX` 与 `moved`（已有 `moved`，加 `downX`）。
2. `move` 里：`level === 0` 走原 `seekThrottled(t)`；`level > 0` 且 `Math.abs(ev.clientX - downX) > 4` 时改 `setWindowStart(clamp(startPct2Time(...), 0, duration - levelSpan))`。

- [ ] **Step 7: 档位按钮 UI**

时间轴上方加一行按钮（**不引新组件，用 antd 现有**）：

```tsx
                <div style={{ display: 'flex', gap: 4, alignItems: 'center', marginBottom: 4 }}>
                  <Typography.Text type="secondary" style={{ fontSize: 11 }}>缩放</Typography.Text>
                  <Button size="small" type={level === 0 ? 'primary' : 'default'} onClick={() => setLevel(0)}>全片</Button>
                  <Button size="small" type={level === 1 ? 'primary' : 'default'} disabled={duration <= 128} onClick={() => setLevel(1)}>中景</Button>
                  <Button size="small" type={level === 2 ? 'primary' : 'default'} disabled={duration <= 300} onClick={() => setLevel(2)}>近景</Button>
                  {/* 快捷键与提示：Ctrl+滚轮（Windows 笔记本触控板同样是 Ctrl+滚轮） */}
                  <Typography.Text type="secondary" style={{ fontSize: 11, marginLeft: 8 }}>Ctrl+滚轮切档 · 拖动平移 · 单击定位</Typography.Text>
                </div>
```

- [ ] **Step 8: 验证**

Run: `cd web; npx tsc --noEmit --pretty 2>&1 | Select-String "studio-detail|TimelineWave"`
Expected: 无输出。

Run: `cd web; npm run build`
Expected: EXIT=0。

Run: `cd server; npx tsc --noEmit --pretty` + `npx vitest run`
Expected: 0 错 / 全量绿（本任务不该改 server，若报错说明 T5 有遗留，**记录不修**）。

- [ ] **Step 9: 快照 + review package + 记账本**，不 commit。

---

### Task 8: 文档回扫与整支验证

**Files:**
- Modify: `docs/superpowers/specs/2026-10-02-timeline-pyramid.md`（状态行）
- Modify: `web/src/api.ts`（`waveformUrl` 注释补一句「legacy 保留」的现状）
- Modify: `docs/handoffs/2026-10-03-specb-timeline-pyramid.md`（追加实施结果段）
- Modify: `.superpowers/sdd/2026-10-03-timeline-pyramid/progress.md`

- [ ] **Step 1: 全量验证（三包 + 测试 + 两个 build）**

```powershell
# 三包 typecheck
cd server; npx tsc --noEmit --pretty; cd ..
cd web;    npx tsc --noEmit --pretty; cd ..
cd desktop; npx tsc --noEmit --pretty; cd ..
# server 测试
cd server; npx vitest run; cd ..
# build
cd web; npm run build; cd ..
cd desktop; npm run build; cd ..
```

**记下真实数字**（用例数、文件数、EXIT code）—— 报告里的数字必须取终态实测，并把取数命令一并写出（仓库规则：数字不许凭记忆填）。

- [ ] **Step 2: 文档回扫**

```powershell
Get-ChildItem -Path docs,.superpowers -Recurse -File -Include *.md | Select-String -Pattern '未做|未验证|待建|待定|TODO|12 格|12格|1600×120|showwavespic' | Select-Object Path,LineNumber,Line
```

逐条对照现状处理：
- spec 的「⏳ 待实测」标记 → 改成实测结论或注明「已由裁决表②定死」。
- spec 状态行「草案，待用户过目」→ 改成「已实施（commit 由用户提交）」。
- 任何仍写「12 格」「1600×120 波形 PNG」的地方 → 改成档位语义。
- `docs/handoffs/2026-10-01-timeline-thumbnails-and-audio-lineage.md` 里描述 legacy 行为的段落 → 加一句「已被 Spec B 接管（L0 沿用同名，段图另加后缀）」。
- `web/src/api.ts` 的 `waveformUrl` / `filmstripUrl` 注释 → 注明「`filmstripUrl` 现由 L0 接管；`waveformUrl` 为 legacy PNG，T6 起前端主用 `wavePeakUrl`」。

- [ ] **Step 3: 验收五条移交（spec §6）**

**程序侧能给的**（如实给，不代签）：
- 冷启动首屏 L0 出图耗时（跑一次真机，记下数字与基线 10.29s 的差）。
- L1 单段出图耗时（基线 3.38s）。
- L0 波形峰值出数据耗时（基线 2.31s）。
- 失败段是否出现斜纹占位 + 重试；日志页是否能看到失败原因。

**只能人工目验的**（写成清单交用户）：
1. 21:30 素材：总览铺满全片；放大 2 档后该段画面明显变密、段边界无跳变。
2. 缩放/平移与拖动定位、拖边微调互不抢（N2-c 三区在缩放态仍成立）。
3. 冷启动首屏 L0 出图耗时（对照 10.29s 基线）。
4. 波形放大后能看到局部疏密。
5. 生成失败段有明确占位与重试，日志页可见原因。

- [ ] **Step 4: 记账本 + 写交接词**，**不 commit**。

---

## 自查（写完计划后对照 spec 逐条过）

**Spec 覆盖检查**：

| Spec 条目 | 落在哪 |
|---|---|
| D1 分级雪碧图（L0 36 格 / L1 128s / L2 24s / 分段寻址 / 逐格 seek vs 分段解码） | T1（参数）+ T2（L0 逐格 seek）+ T3（L1/L2 分段） |
| D2 多级波形峰值（峰值数组 / Canvas 自绘 / 数据量估算） | T1（`WAVE_POINTS_PER_SEG`=1600 即数据量结论：L0 约 1290 点 ≈ 20KB）+ T4（提取）+ T6（自绘） |
| D3 前端交互（Ctrl+滚轮 / 档位 / 平移 / 与 N2-c 分权 / 播放头不错位） | T7（Step 1/2/5/6） |
| D4 缓存与失效（L0 接管 + level 进 sig + 视口优先 + 空闲预取 + invalidate 全清） | T2（`FILM_META_V` 2→3 + `filmShapeSig` 带 level）+ T3（`invalidateDerived` 全级清扫）+ T7（`visibleSegs` 视口优先） |
| D5 失败与降级（失败段明确占位 + 不用邻段冒充 / 短视频只到 L1） | T3（`checkLevelAvailable`）+ T5（`LEVEL_UNAVAILABLE` 404 + 说清要多久）+ T6（斜纹占位 + 重试） |
| §5 不做（不引 wavesurfer / 不做无级缩放 / 不做多轨 / 不做帧级对齐 / L0 末格约定不动） | Global Constraints 明确列为禁止项；T7 的档位是离散三档 |
| §6 验收五条 | T8 Step 3 移交（程序侧实测 + 人工目验清单） |
| Task 1 实测（4 组） | **已完成**（ffmpeg-measure-report §B 组 + 裁决表②），T1 的参数全部来自那份实测 |

**空位自查**：无 TBD / TODO / 「类似 Task N」/ 无代码的「加错误处理」类步骤。类型与函数名在 T1 定义的 Interfaces 块里逐字对齐后续任务的 Consumes。

**已知的取舍（写下来给用户看）**：
1. **D5 的 L2 门槛 `duration > 300` 与前端按钮的 `duration > 300` 是同一个数的两处副本**（T3 服务端权威 / T7 前端隐藏）。**若将来要改，只改 T3 的 `checkLevelAvailable` + T7 的 disabled**——两处必须同改，写在这里防止漏。
2. **L1 的前端门槛（128s）与服务端一致**，理由同上。
3. **锚点保持是近似算法**（T7 Step 5 已注明），目验后调。
4. **T3 的 `ensureFilmSegment` 里 duration 的探测路径**需要在实现时与 `derived-images.ts` 的 ffprobe 推导口径对齐（计划里给了 `derivedProbePath` 占位导出，落地时确认它的存在；不存在就在 `derived-images.ts` 里导出它，**这是 T3 的一处显式接口要求**）。
