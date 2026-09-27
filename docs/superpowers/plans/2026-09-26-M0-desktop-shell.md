# M0 桌面壳与内嵌 server — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Git 红线:** 本计划包含 commit 步骤。执行开始前用户须明确同意按计划提交;未获同意则跳过所有 commit 步骤,仅保留工作区变更(遵守全局 Git 写操作禁令)。
>
> **修订 2026-09-26(Task 1 spike 裁决):** D9 双副本在 pnpm 12 下证伪(别名与原版去重为同一物理实例;Electron 44 需 ABI 149 无预编译且本机无 MSVC)。按 spec 0.7 预授权切换**方案 C:SQLite 驱动 = node:sqlite**(用户拍板 C1:Node 22.12 + NODE_OPTIONS flag)。Global Constraints 已更新;**Task 1/2 中 better-sqlite3/pickDriver/rebuild/probe:abi 相关代码以各任务 brief(task-1b-brief.md 及后续)为准**;Task 2 的 `openDatabase` 为**同步**签名;Task 3-8 不受影响(SQL 用法同形)。probe:abi 全文读作 probe:sqlite。
>
> **修订 2026-09-26(OCR 评审后二次修复):** ①**D1 变更**——desktop 的 `module/moduleResolution` 改 `node16`,TS 保留原生 dynamic import,故删除 `shared/dynamic-import.ts`(`new Function`),main.ts/probes 直接 `await import('@sct/server')`(已实测 probe:sqlite PASS)。计划中所有"经 dynamic-import.ts / new Function 包装"的表述作废。②**新增 D12 API token**——受保护路由(settings GET/PUT、bins/probe)要求 `x-sct-token`,Origin 为白名单 localhost 来源时豁免;token 经 portFile/URL query 流转。③server 的 `module/moduleResolution` 改 `NodeNext`。④其余修复(cors 白名单、health 只读化、bins/jobs/bootstrap/close 等 bug)见 `.superpowers/sdd/2026-09-26-M0-desktop-shell/ocr-fix-brief.md` 与 `ocr-fix-report.md`。

**Goal:** 用最小代价证明"better-sqlite3 双副本 + Electron 内嵌 Fastify server"走得通,并立起 web/server/desktop 三包开发态骨架,达成 PRD M0 验收。

**Architecture:** pnpm 三包 workspace;dev 态 server 由 tsx 独立进程跑(Node ABI),electron 只开窗口(portFile 握手);生产态 server 由 electron 主进程动态 import(Electron ABI,经别名副本 + 限定作用域 rebuild)。数据目录 dev 用 `.sct/dev-data`、生产用 `userData`,永不混用。

**Tech Stack:** Node 22.12.0 / pnpm 12.6.0 / TypeScript 5.9.3 / Fastify 5 / better-sqlite3 12(双副本)/ Electron(最新稳定,Task 1 锁定)/ UmiJS Max 4.7.17 / React 18 / antd 5 / vitest 3

**Spec:** `docs/superpowers/specs/m0-desktop-shell.md`(决定 D1-D11、机制 §0.3、测试边界 §0.4 与本计划配套阅读)

## Global Constraints

- 全部源码 `"type": "module"`(desktop 包除外:它是 CJS,无 type 字段)
- **server 源码相互 import 必须带 `.js` 后缀**(Node ESM 运行时要求)
- **desktop 为 CJS:禁止 `await import()` 直写**——TS 会把 import() 转译成 require,CJS 里 require 加载不了 ESM。必须经 `src/shared/dynamic-import.ts` 的 `new Function` 包装(Task 1 建立)
- **SQLite 驱动 = node:sqlite 内置模块（零原生模块）**：db 层唯一入口 `server/src/db/index.ts openDatabase(dbPath)`（同步，包装 `DatabaseSync`）；**禁止引入 better-sqlite3 / @electron/rebuild**（2026-09-26 spike 证伪裁决，见 spec 0.2 D9 / 0.7）
- **Node 侧 flag 红线**：本机 Node 22.12 运行 server 代码的一切入口（dev/test/probe:sqlite:node）必须经 `cross-env NODE_OPTIONS="--experimental-sqlite --disable-warning=ExperimentalWarning"` 注入；Electron 44（Node 24.21）无 flag
- strict TS + `noUncheckedIndexedAccess`;代码注释与 commit message 用中文
- 端口约定:API 缺省 7310(占用递增)、web dev 固定 8000(被占即失败);数据目录 dev=`.sct/dev-data`、prod=`userData`
- 不引入 electron-builder / logger / preload IPC(spec 0.5)
- 每个包的 typecheck 命令:`pnpm --filter <pkg> typecheck`;server 单测:`pnpm --filter @sct/server test`

## 已实测确认的前提(2026-09-26)

本机已探测(spec 0.1):Node v22.12.0(恰好压 rebuild 的 ≥22.12.0 线)、pnpm 12.6.0、ffmpeg 9.0.2-full_build、yt-dlp 2026.08.19。Electron 版本 **待 Task 1 安装后锁定并回写 spec 0.1**。平台事实(rebuild 行为、Umi hash+publicPath、CJS 动态 import ESM)已按官方文档核实,见 spec 0.1。

## File Structure

```
sound-control-tool/
├─ pnpm-workspace.yaml            # Task1: [server, desktop];Task5 加 web
├─ package.json                   # 根脚本(dev/build/probe/rebuild)
├─ .gitignore                     # 含 .sct/
├─ .sct/                          # dev 运行时产物(gitignore)
├─ server/                        # @sct/server — ESM
│  ├─ package.json  tsconfig.json  tsconfig.build.json  vitest.config.ts
│  └─ src/
│     ├─ index.ts                 # createServer 工厂(唯一出口)
│     ├─ bootstrap.ts             # mkdir + 五表 + 启动恢复 + 孤儿清理
│     ├─ dev.ts                   # dev 启动脚本(bootstrap + portFile)
│     ├─ settings-keys.ts         # settings 键名集中常量
│     ├─ bins.ts                  # 二进制探测(Task 8)
│     ├─ db/
│     │  ├─ index.ts              # pickDriver(双副本唯一分支) + openDatabase
│     │  ├─ schema.ts             # 五表 DDL(initSchema)
│     │  └─ repo/{settings.ts, jobs.ts}
│     ├─ net/find-free-port.ts
│     ├─ http/cors.ts             # 手写 CORS(origin 反射)
│     ├─ types/better-sqlite3-electron.d.ts
│     └─ probes/                  # (无,probe:abi:node 用 node -e)
├─ desktop/                       # @sct/desktop — CJS
│  ├─ package.json  tsconfig.json  vitest.config.ts
│  └─ src/
│     ├─ main.ts                  # 主进程(单实例锁/动态 import/回退链/开窗)
│     ├─ preload.ts               # 空骨架(D7)
│     └─ shared/
│        ├─ dynamic-import.ts     # CJS 内真实 dynamic import
│        └─ parse-port-file.ts    # portFile 解析(纯函数)
└─ web/                           # @sct/web — Umi Max(Task 5)
   ├─ package.json  .umirc.ts  tsconfig.json
   └─ src/
      ├─ api.ts                   # apiPort 解析 + 统一错误封装
      └─ pages/{index.tsx, settings.tsx}
```

依赖方向:`desktop →(动态, 仅生产态)→ server;web →(HTTP)→ server;server 内部 http → {db, net};无任何反向依赖。

---

### Task 1: 仓库脚手架最小集 + ABI spike(最小可信链路)

**Files:**
- Create: `pnpm-workspace.yaml`, `package.json`, `.gitignore`
- Create: `server/package.json`, `server/tsconfig.json`, `server/tsconfig.build.json`, `server/src/db/index.ts`, `server/src/db/index.test.ts`, `server/src/types/better-sqlite3-electron.d.ts`, `server/src/index.ts`, `server/src/shared/dynamic-import.ts`(desktop 侧,见下)
- Create: `desktop/package.json`, `desktop/tsconfig.json`, `desktop/src/shared/dynamic-import.ts`, `desktop/src/probes/abi.ts`

**Interfaces:**
- Consumes: 无(起点)
- Produces:
  - `openDatabase(dbPath: string): Promise<import('better-sqlite3').Database>`(server/db)
  - `pickDriver(hasElectron: boolean): 'better-sqlite3-electron' | 'better-sqlite3'`
  - `createServer(opts: { port: number; dbPath: string; tempDir: string; portFile?: string }): Promise<{ port: number; close(): Promise<void> }>`(最小版,Task 3 增强)
  - desktop `dynamicImport(specifier: string): Promise<unknown>`
  - 根脚本 `pnpm rebuild:electron` / `pnpm probe:abi` / `pnpm probe:abi:node`

- [ ] **Step 1: 写仓库骨架文件**

`pnpm-workspace.yaml`:

```yaml
packages:
  - server
  - desktop

nodeLinker: isolated

allowBuilds:
  better-sqlite3: true
  electron: true

minimumReleaseAge: 0
```

> web 目录 Task 5 才创建,现在写进 packages 会 install 失败(bfm 同款教训)。Task 5 时追加 `- web` 与 `esbuild`/`@swc/core` 的 allowBuilds。

`package.json`(根):

```json
{
  "name": "sound-control-tool",
  "private": true,
  "version": "0.0.0",
  "scripts": {
    "rebuild:electron": "pnpm --filter @sct/desktop rebuild:electron",
    "probe:abi": "pnpm --filter @sct/desktop probe:abi",
    "probe:abi:node": "pnpm --filter @sct/server probe:abi:node"
  },
  "devDependencies": {
    "concurrently": "^9.1.0"
  }
}
```

`.gitignore`:

```
node_modules/
dist/
*.db
*.db-journal
.env
.sct/
.DS_Store
```

`server/package.json`:

```json
{
  "name": "@sct/server",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "dev": "tsx src/dev.ts",
    "probe:abi:node": "node --input-type=module -e \"const m=await import('better-sqlite3');new m.default(':memory:').exec('create table t(a)');console.log('[probe:abi:node] Node 副本 OK')\""
  },
  "dependencies": {
    "better-sqlite3": "^12.11.1",
    "better-sqlite3-electron": "npm:better-sqlite3@^12.11.1",
    "fastify": "^5.12.4"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^9.6.0",
    "@types/node": "^22.20.2",
    "tsx": "^4.23.13",
    "typescript": "^5.9.3",
    "vitest": "^3.2.7"
  }
}
```

`server/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "types": ["node"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "verbatimModuleSyntax": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["src/**/*.ts"]
}
```

`server/tsconfig.build.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": false,
    "outDir": "dist",
    "declaration": true
  },
  "exclude": ["src/**/*.test.ts", "src/dev.ts", "src/probes/**"]
}
```

`desktop/package.json`:

```json
{
  "name": "@sct/desktop",
  "private": true,
  "version": "0.0.0",
  "main": "dist/main.js",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "rebuild:electron": "electron-rebuild --module-dir ../server --only better-sqlite3-electron --force",
    "probe:abi": "pnpm --filter @sct/server build && pnpm run build && electron dist/probes/abi.js"
  },
  "devDependencies": {
    "@electron/rebuild": "^4.2.0",
    "@types/node": "^22.20.2",
    "typescript": "^5.9.3",
    "vitest": "^3.2.7"
  }
}
```

> electron 本体在 Step 3 用 `pnpm add -D electron@latest` 安装并锁定版本,不预写版本号(防猜测)。

`desktop/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "CommonJS",
    "moduleResolution": "node",
    "types": ["node"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "sourceMap": true
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 2: 写 server 双副本 db 层 + 最小入口(含失败测试)**

`server/src/types/better-sqlite3-electron.d.ts`:

```ts
declare module 'better-sqlite3-electron' {
  import betterSqlite3 from 'better-sqlite3';
  export default betterSqlite3;
}
```

`server/src/db/index.ts`:

```ts
type DB = import('better-sqlite3').Database;

/** D9 唯一分支点:Electron 内用别名副本,Node(vitest/tsx)内用原版 */
export function pickDriver(hasElectron: boolean): 'better-sqlite3-electron' | 'better-sqlite3' {
  return hasElectron ? 'better-sqlite3-electron' : 'better-sqlite3';
}

export async function openDatabase(dbPath: string): Promise<DB> {
  const name = pickDriver(Boolean(process.versions.electron));
  const mod = (await import(name)) as { default: new (p: string) => DB };
  return new mod.default(dbPath);
}
```

`server/src/db/index.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { pickDriver } from './index.js';

describe('pickDriver(D9 双副本唯一分支)', () => {
  it('Node 运行时选原版', () => {
    expect(pickDriver(false)).toBe('better-sqlite3');
  });
  it('Electron 运行时选别名副本', () => {
    expect(pickDriver(true)).toBe('better-sqlite3-electron');
  });
  it('本进程(vitest=Node)实际应选原版', () => {
    expect(pickDriver(Boolean(process.versions.electron))).toBe('better-sqlite3');
  });
});
```

`server/src/index.ts`(最小版,Task 3 重写为正式版):

```ts
import Fastify from 'fastify';
import { mkdirSync } from 'node:fs';
import { openDatabase } from './db/index.js';

export interface CreateServerOpts {
  port: number;
  dbPath: string;
  tempDir: string;
  portFile?: string;
}

export async function createServer(opts: CreateServerOpts): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  mkdirSync(opts.tempDir, { recursive: true });
  const db = await openDatabase(opts.dbPath);
  db.exec('CREATE TABLE IF NOT EXISTS spike_health (v TEXT NOT NULL)');

  const app = Fastify({ logger: false });
  let port = opts.port;

  app.get('/api/health', async () => {
    db.prepare('INSERT INTO spike_health (v) VALUES (?)').run(String(Date.now()));
    const row = db.prepare('SELECT v FROM spike_health ORDER BY rowid DESC LIMIT 1').get<{ v: string }>();
    return { ok: true, sqlite: row?.v ?? null, port };
  });

  await app.listen({ port: opts.port, host: '127.0.0.1' });
  const addr = app.server.address();
  if (typeof addr === 'object' && addr !== null) port = addr.port;

  if (opts.portFile) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(opts.portFile, JSON.stringify({ port, pid: process.pid }));
  }

  return {
    port,
    close: async () => {
      await app.close();
      db.close();
    },
  };
}
```

- [ ] **Step 3: 写 desktop spike 侧**

`desktop/src/shared/dynamic-import.ts`:

```ts
/**
 * CJS 产物中保留真实 dynamic import。
 * TS 会把 import() 转译成 require,CJS 里 require 加载不了 ESM 的 @sct/server。
 * 这是 Global Constraints 红线的落实点,desktop 内所有跨包加载必须走它。
 */
const dynamicImport = new Function('specifier', 'return import(specifier);') as (
  specifier: string,
) => Promise<unknown>;
export { dynamicImport };
```

`desktop/src/probes/abi.ts`:

```ts
/** D2 spike:验证项②(Electron 主进程动态 import server 完整入口 + SQLite 往返)。手工运行 pnpm probe:abi */
import { app } from 'electron';
import os from 'node:os';
import path from 'node:path';
import { dynamicImport } from '../shared/dynamic-import';

interface ServerModule {
  createServer(opts: {
    port: number;
    dbPath: string;
    tempDir: string;
  }): Promise<{ port: number; close: () => Promise<void> }>;
}

app.whenReady().then(async () => {
  let failures = 0;
  try {
    const server = (await dynamicImport('@sct/server')) as ServerModule;
    const s = await server.createServer({
      port: 7399,
      dbPath: ':memory:',
      tempDir: path.join(os.tmpdir(), 'sct-probe-abi'),
    });
    const res = await fetch('http://127.0.0.1:7399/api/health');
    const body = (await res.json()) as { ok: boolean; sqlite: string | null };
    const ok = body.ok === true && typeof body.sqlite === 'string';
    console.log(`② Electron 内 import server + SQLite 往返: ${ok ? 'OK' : 'FAIL'} ${JSON.stringify(body)}`);
    if (!ok) failures++;
    await s.close();
  } catch (e) {
    console.error('② FAIL:', e);
    failures++;
  }
  console.log('① rebuild 生效与否由本探针是否通过间接证明;③ 由 pnpm probe:abi:node 验证');
  console.log(failures === 0 ? '=== probe:abi PASS ===' : `=== probe:abi FAIL(${failures}) ===`);
  app.exit(failures === 0 ? 0 : 1);
});
```

- [ ] **Step 4: 安装依赖**

Run: `pnpm install`(根)
Expected: 成功;`node_modules/.pnpm` 中同时存在 `better-sqlite3@12.x` 与 `better-sqlite3-electron_better-sqlite3@12.x` 两个虚拟副本

Run: `pnpm --filter @sct/desktop add -D electron@latest`
Expected: 成功;**把 package.json 中实际写入的 electron 版本记录下来**(Step 7 回写 spec 0.1)

- [ ] **Step 5: 限定作用域 rebuild + 跑三项验证(D2)**

Run: `pnpm rebuild:electron`
Expected: 成功;若报"找不到模块",按顺序尝试:`--module-dir ..` → 在 server 目录内运行 `pnpm exec electron-rebuild --only better-sqlite3-electron --force`;**把最终生效的命令形式回写 spec 0.2 D9**。若别名副本始终无法被 rebuild → **停止,回报用户**(候选 C:node:sqlite 另立 spike)

Run: `pnpm probe:abi`
Expected: 输出 `② ... OK` 且 `=== probe:abi PASS ===`,退出码 0(验证②,同时证明①别名副本 rebuild 后可被 Electron 加载)

Run: `pnpm probe:abi:node`
Expected: 输出 `[probe:abi:node] Node 副本 OK`(验证③:rebuild 后原版副本在 Node 下不受影响)

- [ ] **Step 6: 静态检查 + 单测**

Run: `pnpm --filter @sct/server test`
Expected: PASS(pickDriver 3 用例)

Run: `pnpm --filter @sct/server typecheck` 与 `pnpm --filter @sct/desktop typecheck`
Expected: 均无输出、退出码 0

- [ ] **Step 7: 回写 spec + 提交**

把以下结论回写 `docs/superpowers/specs/m0-desktop-shell.md`:0.1 表格补 Electron 实际版本;0.2 D9 补"实际生效的 rebuild 命令形式"。

```bash
git add pnpm-workspace.yaml package.json .gitignore server desktop docs/superpowers/specs/m0-desktop-shell.md
git commit -m "feat: 三包骨架 + ABI spike 通过(双副本策略验证)"
```

---

### Task 2: server 数据层与启动恢复(TDD)

**Files:**
- Create: `server/vitest.config.ts`, `server/src/db/schema.ts`, `server/src/db/repo/settings.ts`, `server/src/db/repo/jobs.ts`, `server/src/bootstrap.ts`, `server/src/net/find-free-port.ts`, `server/src/settings-keys.ts`
- Test: `server/src/db/repo/settings.test.ts`, `server/src/db/repo/jobs.test.ts`, `server/src/bootstrap.test.ts`, `server/src/net/find-free-port.test.ts`

**Interfaces:**
- Consumes: `openDatabase`(Task 1)
- Produces:
  - `initSchema(db: DB): void`(五表,DDL = PRD §4.1 逐字)
  - `createSettingsRepo(db): { get(key): string | null; set(key, value): void; all(): Record<string, string> }`
  - `createJobsRepo(db): { markAllInterrupted(message: string): number; create(kind: string, payload: unknown): number; get(id: number): JobRow | null }`
  - `bootstrap(opts: { dbPath: string; tempDir: string }): Promise<void>`
  - `cleanOrphans(tempDir: string, keep: Set<string>): void`
  - `findFreePort(start: number, tries?: number): Promise<number>`
  - `SETTINGS_KEYS`(常量对象)

- [ ] **Step 1: vitest 配置**

`server/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
});
```

- [ ] **Step 2: 写五表 schema**

`server/src/db/schema.ts`(DDL 逐字取自 PRD §4.1,勿改):

```ts
type DB = import('better-sqlite3').Database;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS audio_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('download','recording','edit')),
  source_url TEXT,
  parent_id INTEGER,
  file_path TEXT NOT NULL UNIQUE,
  format TEXT NOT NULL,
  duration_sec REAL,
  file_size INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','error','cancelled')),
  progress REAL NOT NULL DEFAULT 0,
  message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);
CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS audio_item_tags (
  audio_id INTEGER NOT NULL REFERENCES audio_items(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (audio_id, tag_id)
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/** 幂等:IF NOT EXISTS,重复调用安全 */
export function initSchema(db: DB): void {
  db.exec(SCHEMA_SQL);
}
```

- [ ] **Step 3: 写失败测试(repo + bootstrap + findFreePort)**

`server/src/db/repo/settings.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../index.js';
import { initSchema } from '../schema.js';
import { createSettingsRepo } from './settings.js';

describe('settings repo(内存 SQLite,真 SQL)', () => {
  let db: import('better-sqlite3').Database;
  beforeEach(async () => {
    db = await openDatabase(':memory:');
    initSchema(db);
  });

  it('set 后 get 取回;覆盖写生效', () => {
    const repo = createSettingsRepo(db);
    repo.set('k', 'v1');
    expect(repo.get('k')).toBe('v1');
    repo.set('k', 'v2');
    expect(repo.get('k')).toBe('v2');
  });

  it('get 不存在的键返回 null;all() 返回全部', () => {
    const repo = createSettingsRepo(db);
    expect(repo.get('nope')).toBeNull();
    repo.set('a', '1');
    repo.set('b', '2');
    expect(repo.all()).toEqual({ a: '1', b: '2' });
  });
});
```

`server/src/db/repo/jobs.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../index.js';
import { initSchema } from '../schema.js';
import { createJobsRepo } from './jobs.js';

describe('jobs repo', () => {
  let db: import('better-sqlite3').Database;
  beforeEach(async () => {
    db = await openDatabase(':memory:');
    initSchema(db);
  });

  it('markAllInterrupted 把 pending/running 置为 error 并返回行数', () => {
    const repo = createJobsRepo(db);
    const a = repo.create('ytdlp_download', { url: 'x' });
    const b = repo.create('ffmpeg_edit', { spec: {} });
    db.prepare("UPDATE jobs SET status='running' WHERE id=?").run(a);
    db.prepare("UPDATE jobs SET status='done' WHERE id=?").run(b); // done 不应被动

    const n = repo.markAllInterrupted('应用中断,可重试');
    expect(n).toBe(1);
    expect(repo.get(a)?.status).toBe('error');
    expect(repo.get(a)?.message).toBe('应用中断,可重试');
    expect(repo.get(b)?.status).toBe('done');
  });
});
```

`server/src/bootstrap.test.ts`:

```ts
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bootstrap, cleanOrphans } from './bootstrap.js';

const dirs: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(path.join(tmpdir(), 'sct-boot-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('bootstrap(启动恢复 + 孤儿清理)', () => {
  it('running 任务被置为 error;再次运行幂等', async () => {
    const data = tmpDir();
    const dbPath = path.join(data, 'sct.db');
    await bootstrap({ dbPath, tempDir: path.join(data, 'tmp') });
    // 模拟上次崩溃残留:手工塞一行 running
    const { openDatabase } = await import('./db/index.js');
    const db = await openDatabase(dbPath);
    db.prepare("INSERT INTO jobs (kind, payload, status) VALUES ('ytdlp_download', '{}', 'running')").run();
    db.close();

    await bootstrap({ dbPath, tempDir: path.join(data, 'tmp') }); // 第二次启动
    const db2 = await openDatabase(dbPath);
    const row = db2.prepare('SELECT status, message FROM jobs').get<{ status: string; message: string }>();
    db2.close();
    expect(row?.status).toBe('error');
    expect(row?.message).toContain('应用中断');
  });

  it('孤儿清理:keep 之外的文件被删,keep 之内的保留;dbPath 父目录自动创建', async () => {
    const data = tmpDir();
    const tempDir = path.join(data, 'tmp');
    writeFileSync(path.join(tempDir, 'a.tmp'), 'x');
    writeFileSync(path.join(tempDir, 'b.tmp'), 'y');
    cleanOrphans(tempDir, new Set([path.join(tempDir, 'b.tmp')]));
    expect(existsSync(path.join(tempDir, 'a.tmp'))).toBe(false);
    expect(existsSync(path.join(tempDir, 'b.tmp'))).toBe(true);

    const nested = path.join(data, 'deep', 'sct.db'); // 父目录不存在
    await bootstrap({ dbPath: nested, tempDir });
    expect(existsSync(nested)).toBe(true);
  });
});
```

`server/src/net/find-free-port.test.ts`:

```ts
import net from 'node:net';
import { describe, expect, it } from 'vitest';
import { findFreePort } from './find-free-port.js';

function listen(port: number): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(port, '127.0.0.1', () => resolve(srv));
  });
}

describe('findFreePort', () => {
  it('起始端口空闲时原样返回', async () => {
    const p = await findFreePort(7330);
    expect(p).toBe(7330);
  });

  it('被占时向后递增到下一个空闲端口', async () => {
    const srv = await listen(7341);
    const p = await findFreePort(7341);
    expect(p).toBeGreaterThan(7341);
    await new Promise<void>((r) => srv.close(() => r()));
  });
});
```

- [ ] **Step 4: 跑测试确认失败**

Run: `pnpm --filter @sct/server test`
Expected: FAIL —— 模块不存在(settings/jobs/bootstrap/find-free-port)

- [ ] **Step 5: 写实现**

`server/src/db/repo/settings.ts`:

```ts
type DB = import('better-sqlite3').Database;

export interface SettingsRepo {
  get(key: string): string | null;
  set(key: string, value: string): void;
  all(): Record<string, string>;
}

export function createSettingsRepo(db: DB): SettingsRepo {
  return {
    get: (key) => db.prepare('SELECT value FROM settings WHERE key = ?').get<{ value: string }>(key)?.value ?? null,
    set: (key, value) => db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value),
    all: () => Object.fromEntries(db.prepare('SELECT key, value FROM settings').all<{ key: string; value: string }>().map((r) => [r.key, r.value])),
  };
}
```

`server/src/db/repo/jobs.ts`:

```ts
type DB = import('better-sqlite3').Database;

export interface JobRow {
  id: number;
  kind: string;
  payload: string;
  status: string;
  progress: number;
  message: string | null;
}

export interface JobsRepo {
  markAllInterrupted(message: string): number;
  create(kind: string, payload: unknown): number;
  get(id: number): JobRow | null;
}

export function createJobsRepo(db: DB): JobsRepo {
  return {
    markAllInterrupted: (message) =>
      db.prepare("UPDATE jobs SET status='error', message=?, finished_at=datetime('now') WHERE status IN ('pending','running')").run(message).changes,
    create: (kind, payload) =>
      Number(db.prepare("INSERT INTO jobs (kind, payload) VALUES (?, ?)").run(kind, JSON.stringify(payload)).lastInsertRowid),
    get: (id) => db.prepare('SELECT id, kind, payload, status, progress, message FROM jobs WHERE id = ?').get<JobRow>(id) ?? null,
  };
}
```

`server/src/settings-keys.ts`(键名集中常量,spec P2-13):

```ts
export const SETTINGS_KEYS = {
  outputDir: 'output_dir',
  defaultFormat: 'default_format',
  defaultBitrate: 'default_bitrate',
  binYtdlp: 'bin_ytdlp',
  binFfmpeg: 'bin_ffmpeg',
  binsProbedAt: 'bins_probed_at',
} as const;
```

`server/src/net/find-free-port.ts`:

```ts
import net from 'node:net';

function isFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

/** 从 start 起找第一个空闲端口;D4 的落实点。找不到抛错 */
export async function findFreePort(start: number, tries = 50): Promise<number> {
  for (let p = start; p < start + tries; p++) {
    if (await isFree(p)) return p;
  }
  throw new Error(`[${start}, ${start + tries}) 区间内无空闲端口`);
}
```

`server/src/bootstrap.ts`:

```ts
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { openDatabase } from './db/index.js';
import { initSchema } from './db/schema.js';
import { createJobsRepo } from './db/repo/jobs.js';

/** 删除 tempDir 中 keep 之外的条目(S1 keep 恒为空集;S2 起由活跃任务 payload.tempFiles 提供) */
export function cleanOrphans(tempDir: string, keep: Set<string>): void {
  for (const entry of readdirSync(tempDir)) {
    const full = path.join(tempDir, entry);
    if (!keep.has(full) && !keep.has(entry)) rmSync(full, { recursive: true, force: true });
  }
}

function listActiveTempFiles(db: import('better-sqlite3').Database): Set<string> {
  const keep = new Set<string>();
  const rows = db.prepare("SELECT payload FROM jobs WHERE status IN ('pending','running')").all<{ payload: string }>();
  for (const r of rows) {
    try {
      const p = JSON.parse(r.payload) as { tempFiles?: string[] };
      for (const f of p.tempFiles ?? []) keep.add(f);
    } catch { /* 坏 payload 不阻塞启动 */ }
  }
  return keep;
}

/** spec 0.3:mkdir → 五表 → 启动恢复 → 孤儿清理。dev 由 dev.ts 调,生产由 electron main 调 */
export async function bootstrap(opts: { dbPath: string; tempDir: string }): Promise<void> {
  mkdirSync(path.dirname(opts.dbPath), { recursive: true });
  mkdirSync(opts.tempDir, { recursive: true });
  const db = await openDatabase(opts.dbPath);
  try {
    initSchema(db);
    createJobsRepo(db).markAllInterrupted('应用中断,可重试');
    cleanOrphans(opts.tempDir, listActiveTempFiles(db));
  } finally {
    db.close();
  }
}
```

- [ ] **Step 6: 跑测试确认通过 + 提交**

Run: `pnpm --filter @sct/server test`
Expected: PASS(Task 1 的 3 例 + 本任务全部)

Run: `pnpm --filter @sct/server typecheck`
Expected: 无输出、退出码 0

```bash
git add server
git commit -m "feat(server): 五表 schema、settings/jobs repo、bootstrap 启动恢复与孤儿清理"
```

---

### Task 3: createServer 正式版(端口递增 / CORS / 五表 / portFile)

**Files:**
- Modify(整文件重写): `server/src/index.ts`
- Create: `server/src/http/cors.ts`, `server/src/index.test.ts`, `server/src/dev.ts`

**Interfaces:**
- Consumes: `findFreePort`(Task 2)、`initSchema`(Task 2)、`openDatabase`(Task 1)
- Produces:
  - `createServer(opts: CreateServerOpts): Promise<{ port: number; close(): Promise<void> }>` —— 端口占用自动递增;已挂 CORS;health 走五表就绪后的真实 db;portFile 写 `{port, pid}`
  - `bootstrap`(由本文件 re-export,desktop 只 import '@sct/server' 一个入口)

- [ ] **Step 1: 写失败测试(集成,真实 HTTP)**

`server/src/index.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from './index.js';

const cleanup: Array<() => void> = [];
function tmp(): string {
  const d = mkdtempSync(path.join(tmpdir(), 'sct-cs-'));
  cleanup.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}
afterEach(() => { for (const f of cleanup.splice(0)) f(); });

describe('createServer(正式版)', () => {
  it('health 返回 ok 且包含实际端口', async () => {
    const s = await createServer({ port: 7350, dbPath: ':memory:', tempDir: path.join(tmp(), 'tmp') });
    const res = await fetch(`http://127.0.0.1:${s.port}/api/health`);
    const body = (await res.json()) as { ok: boolean; port: number; sqlite: string | null };
    expect(body.ok).toBe(true);
    expect(body.port).toBe(s.port);
    expect(typeof body.sqlite).toBe('string');
    await s.close();
  });

  it('端口被占时自动递增', async () => {
    const s1 = await createServer({ port: 7351, dbPath: ':memory:', tempDir: path.join(tmp(), 't1') });
    const s2 = await createServer({ port: 7351, dbPath: ':memory:', tempDir: path.join(tmp(), 't2') });
    expect(s2.port).toBeGreaterThan(s1.port);
    await s1.close();
    await s2.close();
  });

  it('CORS:带 Origin 的请求被反射;preflight 返回 204', async () => {
    const s = await createServer({ port: 7352, dbPath: ':memory:', tempDir: path.join(tmp(), 't3') });
    const res = await fetch(`http://127.0.0.1:${s.port}/api/health`, { headers: { origin: 'http://localhost:8000' } });
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:8000');

    const pre = await fetch(`http://127.0.0.1:${s.port}/api/health`, {
      method: 'OPTIONS',
      headers: { origin: 'http://localhost:8000', 'access-control-request-method': 'GET' },
    });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe('http://localhost:8000');
    await s.close();
  });

  it('portFile 写入 {port, pid}', async () => {
    const data = tmp();
    const file = path.join(data, 'dev-port');
    const s = await createServer({ port: 7353, dbPath: ':memory:', tempDir: path.join(data, 't4'), portFile: file });
    const parsed = JSON.parse(await import('node:fs').then((m) => m.readFileSync(file, 'utf8'))) as { port: number; pid: number };
    expect(parsed.port).toBe(s.port);
    expect(parsed.pid).toBe(process.pid);
    await s.close();
  });

  it('close 后端口释放(可复用)', async () => {
    const s = await createServer({ port: 7354, dbPath: ':memory:', tempDir: path.join(tmp(), 't5') });
    await s.close();
    const s2 = await createServer({ port: 7354, dbPath: ':memory:', tempDir: path.join(tmp(), 't6') });
    expect(s2.port).toBe(7354);
    await s2.close();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @sct/server test -- src/index.test.ts`
Expected: FAIL —— CORS 头缺失 / 递增未实现 / 五表未初始化

- [ ] **Step 3: 写实现(整文件重写 index.ts + cors.ts + dev.ts)**

`server/src/http/cors.ts`:

```ts
import type { FastifyInstance } from 'fastify';

/** origin 反射:dev 的 localhost:8000 与 file://(origin=null)都要能访问;node 侧 fetch 无 CORS 不受影响 */
export function registerCors(app: FastifyInstance): void {
  app.addHook('onSend', async (req, reply) => {
    const origin = req.headers.origin;
    if (origin) {
      reply.header('access-control-allow-origin', origin);
      reply.header('vary', 'Origin');
    }
  });
  app.addHook('preHandler', async (req, reply) => {
    if (req.method === 'OPTIONS') {
      reply
        .header('access-control-allow-methods', 'GET,PUT,POST,OPTIONS')
        .header('access-control-allow-headers', 'content-type')
        .header('access-control-max-age', '86400');
      return reply.code(204).send();
    }
  });
}
```

`server/src/index.ts`(整文件重写):

```ts
import Fastify from 'fastify';
import { mkdirSync, writeFileSync } from 'node:fs';
import { openDatabase } from './db/index.js';
import { initSchema } from './db/schema.js';
import { registerCors } from './http/cors.js';
import { findFreePort } from './net/find-free-port.js';

export { bootstrap } from './bootstrap.js';

export interface CreateServerOpts {
  port: number;       // 必传,约定 dev 7310;占用自动递增
  dbPath: string;     // 必传:electron→userData/sct.db;dev→.sct/dev-data/sct.db;测试→:memory:
  tempDir: string;    // 必传,分运行时同 dbPath
  portFile?: string;  // 仅 dev:写入 {port, pid}(JSON),供 electron 握手
}

export async function createServer(opts: CreateServerOpts): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  mkdirSync(opts.tempDir, { recursive: true });
  const db = await openDatabase(opts.dbPath);
  initSchema(db);

  const app = Fastify({ logger: false });
  registerCors(app);

  app.get('/api/health', async () => {
    db.prepare('CREATE TABLE IF NOT EXISTS health_probe (v TEXT NOT NULL)').run();
    db.prepare('INSERT INTO health_probe (v) VALUES (?)').run(String(Date.now()));
    const row = db.prepare('SELECT v FROM health_probe ORDER BY rowid DESC LIMIT 1').get<{ v: string }>();
    return { ok: true, sqlite: row?.v ?? null, port };
  });

  const port = await findFreePort(opts.port);
  await app.listen({ port, host: '127.0.0.1' });
  const addr = app.server.address();
  const actualPort = typeof addr === 'object' && addr !== null ? addr.port : port;

  if (opts.portFile) {
    writeFileSync(opts.portFile, JSON.stringify({ port: actualPort, pid: process.pid }));
  }

  return {
    port: actualPort,
    close: async () => {
      await app.close();
      db.close();
    },
  };
}
```

`server/src/dev.ts`:

```ts
/** dev 启动脚本:bootstrap 归属本进程(spec 0.3 启动序列第 3 步的 dev 侧) */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootstrap, createServer } from './index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dataDir = path.join(root, '.sct', 'dev-data');
const dbPath = path.join(dataDir, 'sct.db');
const tempDir = path.join(dataDir, 'tmp');

await bootstrap({ dbPath, tempDir });
const { port, close } = await createServer({
  port: 7310,
  dbPath,
  tempDir,
  portFile: path.join(root, '.sct', 'dev-port'),
});
console.log(`[server] listening on http://127.0.0.1:${port}`);

process.on('SIGINT', async () => {
  await close();
  process.exit(0);
});
```

- [ ] **Step 4: 跑测试确认通过 + 提交**

Run: `pnpm --filter @sct/server test`
Expected: PASS(全部;含 index.test.ts 5 例)

Run: `pnpm --filter @sct/server typecheck && pnpm --filter @sct/server build`
Expected: typecheck 退出码 0;dist/ 生成(含 index.d.ts)

```bash
git add server
git commit -m "feat(server): createServer 正式版(端口递增/CORS/五表/portFile 握手)"
```

---

### Task 4: desktop 主进程正式形态

**Files:**
- Modify: `desktop/package.json`(补 dev/test 脚本)
- Create: `desktop/src/shared/parse-port-file.ts`, `desktop/src/shared/parse-port-file.test.ts`, `desktop/src/main.ts`, `desktop/src/preload.ts`, `desktop/vitest.config.ts`

**Interfaces:**
- Consumes: `createServer`/`bootstrap`(Task 3,经 `dynamicImport('@sct/server')`);`dynamicImport`(Task 1)
- Produces:
  - `parsePortFile(content: string): { port: number; pid: number } | null`(纯函数)
  - 主进程行为:单实例锁 →(生产)import+bootstrap+createServer / (dev)portFile+health 回退链 → 开窗 `?apiPort=`
  - preload 空骨架(D7)

- [ ] **Step 1: 写失败测试(parsePortFile)**

`desktop/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
});
```

`desktop/src/shared/parse-port-file.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parsePortFile } from './parse-port-file.js';

describe('parsePortFile(回退链第一环,双跑/脏文件是真实场景)', () => {
  it('合法 JSON 返回 port/pid', () => {
    expect(parsePortFile('{"port":7311,"pid":123}')).toEqual({ port: 7311, pid: 123 });
  });
  it('垃圾内容 / 缺字段 / 非法端口 → null', () => {
    expect(parsePortFile('not json')).toBeNull();
    expect(parsePortFile('{"pid":1}')).toBeNull();
    expect(parsePortFile('{"port":99999,"pid":1}')).toBeNull();
    expect(parsePortFile('{"port":"7311","pid":1}')).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @sct/desktop test`
Expected: FAIL —— parse-port-file 不存在

- [ ] **Step 3: 写实现**

`desktop/src/shared/parse-port-file.ts`:

```ts
export interface DevPortInfo {
  port: number;
  pid: number;
}

/** server 侧写入契约:JSON {port, pid}(spec 0.3);垃圾/缺失一律 null,由回退链兜底 */
export function parsePortFile(content: string): DevPortInfo | null {
  try {
    const o = JSON.parse(content) as Record<string, unknown>;
    const port = o['port'];
    const pid = o['pid'];
    if (typeof port !== 'number' || !Number.isInteger(port) || port <= 0 || port > 65535) return null;
    if (typeof pid !== 'number' || !Number.isInteger(pid)) return null;
    return { port, pid };
  } catch {
    return null;
  }
}
```

`desktop/src/main.ts`:

```ts
import { app, BrowserWindow, dialog } from 'electron';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { dynamicImport } from './shared/dynamic-import';
import { parsePortFile } from './shared/parse-port-file';

/** 生产加载形态用 --load=file 触发(Task 7);R5 前无打包,这是 file:// 验证的开关 */
const FILE_LOAD = process.argv.includes('--load=file');

interface ServerModule {
  bootstrap(opts: { dbPath: string; tempDir: string }): Promise<void>;
  createServer(opts: { port: number; dbPath: string; tempDir: string }): Promise<{
    port: number;
    close: () => Promise<void>;
  }>;
}

let mainWindow: BrowserWindow | null = null;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    mainWindow?.focus();
  });
  void app.whenReady().then(run).catch((e: unknown) => {
    dialog.showErrorBox('启动失败', String(e));
    app.exit(1);
  });
}

async function run(): Promise<void> {
  if (FILE_LOAD) {
    const server = await importServer();
    const userData = app.getPath('userData');
    const dbPath = path.join(userData, 'sct.db');
    const tempDir = path.join(userData, 'tmp');
    await server.bootstrap({ dbPath, tempDir });
    const s = await server.createServer({ port: 7310, dbPath, tempDir });
    app.on('will-quit', () => {
      void s.close();
    });
    await openWindow('file', s.port);
  } else {
    const apiPort = await resolveDevApiPort();
    await openWindow('dev', apiPort);
  }
}

/** D10:import 失败禁止裸崩,给可执行指引 */
async function importServer(): Promise<ServerModule> {
  try {
    return (await dynamicImport('@sct/server')) as ServerModule;
  } catch (e) {
    dialog.showErrorBox(
      '加载本地服务失败',
      '常见原因:better-sqlite3 的 Electron 副本未重建,或 Electron 刚升级。\n\n请运行:\n\n  pnpm rebuild:electron\n\n然后重新启动。\n\n' + String(e),
    );
    app.exit(1);
    throw e; // 不可达,使 TS 知晓此处不会正常返回
  }
}

async function healthOk(port: number): Promise<boolean> {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 1500);
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: ctl.signal });
    clearTimeout(timer);
    if (!res.ok) return false;
    const body = (await res.json()) as { ok?: boolean };
    return body.ok === true;
  } catch {
    return false;
  }
}

/** D3 回退链:portFile → 7310 → dialog 指引并退出 */
async function resolveDevApiPort(): Promise<number> {
  const portFile = path.join(app.getAppPath(), '.sct', 'dev-port');
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (existsSync(portFile)) {
      const info = parsePortFile(readFileSync(portFile, 'utf8'));
      if (info && (await healthOk(info.port))) return info.port;
    }
    if (await healthOk(7310)) return 7310;
    await new Promise((r) => setTimeout(r, 500));
  }
  dialog.showErrorBox('本地服务未启动', '10 秒内未检测到本地 API 服务。\n\n请先运行:\n\n  pnpm dev:server\n\n(或直接 pnpm dev)');
  app.exit(1);
  return 0;
}

async function openWindow(mode: 'dev' | 'file', apiPort: number): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  if (mode === 'file') {
    const indexPath = path.join(app.getAppPath(), '..', 'web', 'dist', 'index.html');
    await mainWindow.loadFile(indexPath, { search: `apiPort=${apiPort}` });
  } else {
    await mainWindow.loadURL(`http://localhost:8000/?apiPort=${apiPort}`);
  }
}
```

`desktop/src/preload.ts`(D7 空骨架):

```ts
// S1 无任何 IPC(spec D7);S3 引入 setDisplayMediaRequestHandler 时在此扩展 contextBridge
export {};
```

`desktop/package.json` scripts 区补两行:

```json
"test": "vitest run",
"dev": "tsc -p tsconfig.json && electron ."
```

- [ ] **Step 4: 跑测试确认通过 + 提交**

Run: `pnpm --filter @sct/desktop test && pnpm --filter @sct/desktop typecheck`
Expected: PASS + 退出码 0

```bash
git add desktop
git commit -m "feat(desktop): 主进程正式形态(单实例锁/回退链/生产内嵌/失败可诊断)"
```

---

### Task 5: web 包(Umi Max + 两页 + 生产配置)

**Files:**
- Modify: `pnpm-workspace.yaml`(packages 加 `- web`;allowBuilds 加 `esbuild: true`、`'@swc/core': true`)
- Create: `web/package.json`, `web/.umirc.ts`, `web/tsconfig.json`, `web/src/api.ts`, `web/src/pages/index.tsx`, `web/src/pages/settings.tsx`

**Interfaces:**
- Consumes: `GET /api/health`(Task 3)
- Produces:
  - `apiPort(): number`(读 `?apiPort=`,缺省 7310;D11 唯一解析点)
  - `apiGet<T>(path): Promise<T>`(失败抛带指引的 ApiError)
  - 页面 `/`(health 展示)与 `/settings`(骨架,Task 8 填充)

- [ ] **Step 1: workspace 与包骨架**

`pnpm-workspace.yaml` packages 与 allowBuilds 区改为:

```yaml
packages:
  - server
  - desktop
  - web

nodeLinker: isolated

allowBuilds:
  better-sqlite3: true
  electron: true
  esbuild: true
  '@swc/core': true

minimumReleaseAge: 0
```

`web/package.json`:

```json
{
  "name": "@sct/web",
  "private": true,
  "version": "0.0.0",
  "scripts": {
    "dev": "max dev",
    "build": "max build",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@ant-design/icons": "^5.6.1",
    "@umijs/max": "4.7.17",
    "antd": "^5.21.0",
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "typescript": "^5.9.3"
  }
}
```

`web/.umirc.ts`:

```ts
import { defineConfig } from '@umijs/max';

export default defineConfig({
  // spec 0.1 事实 2:Electron file:// 下必须 hash 路由 + 相对 publicPath,否则白屏
  history: { type: 'hash' },
  hash: true,
  publicPath: process.env.NODE_ENV === 'production' ? './' : '/',
  routes: [
    { path: '/', component: 'index' },
    { path: '/settings', component: 'settings' },
  ],
});
```

`web/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "lib": ["dom", "dom.iterable", "esnext"],
    "module": "esnext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmit": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*.ts", "src/**/*.tsx"]
}
```

- [ ] **Step 2: api.ts(D3/D11 的 web 侧)**

`web/src/api.ts`:

```ts
/** D3 唯一解析点:URL ?apiPort= 优先,缺省 7310(浏览器独立开发场景) */
export function apiPort(): number {
  const raw = new URLSearchParams(window.location.search).get('apiPort');
  const n = raw ? Number(raw) : NaN;
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : 7310;
}

export const API_BASE = `http://127.0.0.1:${apiPort()}`;

export class ApiError extends Error {}

export async function apiGet<T>(path: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`);
  } catch {
    throw new ApiError(`无法连接本地服务(apiPort=${apiPort()})。请确认 server 进程已启动(pnpm dev:server)。`);
  }
  if (!res.ok) throw new ApiError(`请求失败 ${res.status}:${path}`);
  return (await res.json()) as T;
}
```

- [ ] **Step 3: 两个页面**

`web/src/pages/index.tsx`:

```tsx
import { Alert, Card, Spin, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { apiGet } from '@/api';

interface Health {
  ok: boolean;
  sqlite: string | null;
  port: number;
}

export default function IndexPage() {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiGet<Health>('/api/health').then(setHealth).catch((e: Error) => setError(e.message));
  }, []);

  return (
    <Card title="音频库(骨架)" style={{ margin: 16 }}>
      {error && <Alert type="error" showIcon message="无法连接本地服务" description={error} />}
      {!error && !health && <Spin />}
      {health && (
        <Typography.Text>
          后端 OK · SQLite 读写成功 · API 端口 {health.port}
        </Typography.Text>
      )}
    </Card>
  );
}
```

`web/src/pages/settings.tsx`(Task 8 扩展,本步只立骨架):

```tsx
import { Card, Typography } from 'antd';
import { apiPort } from '@/api';

export default function SettingsPage() {
  return (
    <Card title="设置" style={{ margin: 16 }}>
      <Typography.Text>API 端口:{apiPort()}</Typography.Text>
    </Card>
  );
}
```

- [ ] **Step 4: 安装 + 验证 dev 与 build**

Run: `pnpm install`
Expected: 成功(web 进入 workspace)

Run: `pnpm --filter @sct/web typecheck`
Expected: 退出码 0(首次可能需先跑一次 `pnpm --filter @sct/web exec max generate` 生成 .umi 类型)

Run: `pnpm --filter @sct/web dev` 然后浏览器开 `http://localhost:8000/?apiPort=7310`(server 未跑时应看到 Alert;`pnpm dev:server` 后刷新应看到"后端 OK")
Expected: 两种状态符合预期

Run: `pnpm --filter @sct/web build`
Expected: `web/dist/index.html` 生成,资源为相对路径(`./xxx.js`)

- [ ] **Step 5: 提交**

```bash
git add pnpm-workspace.yaml web
git commit -m "feat(web): Umi Max 骨架、api 统一封装、hash 路由 + 相对 publicPath"
```

---

### Task 6: dev 三进程串联

**Files:**
- Modify: `package.json`(根,补 dev 系列脚本)

**Interfaces:**
- Consumes: server dev.ts(Task 3)、desktop dev 脚本(Task 4)、web dev(Task 5)
- Produces: `pnpm dev` 一键起三进程;electron 经 portFile+health+回退链拿到 apiPort

- [ ] **Step 1: 根脚本**

`package.json` scripts 改为:

```json
{
  "scripts": {
    "dev": "concurrently -k -n server,web,electron \"pnpm dev:server\" \"pnpm dev:web\" \"pnpm dev:electron\"",
    "dev:server": "pnpm --filter @sct/server dev",
    "dev:web": "pnpm --filter @sct/web dev --port 8000",
    "dev:electron": "pnpm --filter @sct/desktop dev",
    "build": "pnpm --filter @sct/server build && pnpm --filter @sct/web build && pnpm --filter @sct/desktop build",
    "start:file": "pnpm --filter @sct/desktop start:file",
    "typecheck": "pnpm -r run typecheck",
    "test": "pnpm -r run test",
    "rebuild:electron": "pnpm --filter @sct/desktop rebuild:electron",
    "probe:abi": "pnpm --filter @sct/desktop probe:abi",
    "probe:abi:node": "pnpm --filter @sct/server probe:abi:node"
  }
}
```

`desktop/package.json` scripts 补(配合 Task 7):

```json
"start:file": "pnpm run build && electron . --load=file"
```

> `--port 8000` 显式传给 max dev(spec 0.3);若实测 umi 被占端口时静默换端口而非失败,加预检脚本并在回写 spec 0.3 记录。

- [ ] **Step 2: 端到端 dev 验证(手动清单)**

Run: `pnpm rebuild:electron` 后 `pnpm dev`
Expected(逐项核对,记录到 spec 0.4 探针结论):
1. 三进程全部起来,无报错
2. electron 窗口显示"后端 OK · SQLite 读写成功 · API 端口 7310"
3. 浏览器开 `http://localhost:8000/?apiPort=7310` 同样显示 OK(ADR-2 浏览器独立开发)
4. 不带 `?apiPort=` 开 `http://localhost:8000/` 仍 OK(缺省 7310)
5. Ctrl+C 一次杀掉全部三进程(-k 收割),`.sct/dev-port` 残留但下次启动 health 验证会跳过脏端口

- [ ] **Step 3: 异常路径抽查**

Run: 只跑 `pnpm dev:electron`(不跑 server)
Expected: 窗口不出现,~10 秒后弹"本地服务未启动"dialog(D10)

Run: 手工把 `.sct/dev-port` 改成 `{"port":9,"pid":1}` 再 `pnpm dev`
Expected: 回退链走 7310 正常启动(portFile 脏值被 health 验证拦下)

- [ ] **Step 4: 提交**

```bash
git add package.json desktop/package.json docs/superpowers/specs/m0-desktop-shell.md
git commit -m "feat: dev 三进程串联(portFile 握手 + 回退链 + -k 收割)"
```

---

### Task 7: 生产形态端到端(file:// + hash 路由)

**Files:**
- 无新文件;验证 Task 5 的构建配置与 Task 4 的 `--load=file` 分支

**Interfaces:**
- Consumes: `pnpm build`(三包)、`pnpm start:file`
- Produces: D3b 实测结论(hash 是否保留 location.search)、spec 0.4 探针结论回写

- [ ] **Step 1: 构建并启动**

Run: `pnpm build && pnpm start:file`
Expected: 窗口打开 file:// 页面,**显示"后端 OK"**(说明:hash 路由可达、publicPath './' 资源加载成功、?apiPort= 注入贯通、内嵌 server 的 SQLite 读写成功——M0 验收达成)

- [ ] **Step 2: D3b 检查 + 异常路径**

Run: 在窗口内访问 `#/settings`(地址栏或页面内路由)
Expected: hash 路由切换正常;settings 页显示 apiPort(与 dev 同源逻辑)

Run: `pnpm rebuild:electron` 后重复 `pnpm start:file`(模拟"install 后忘 rebuild"的反向:先 `pnpm install --force` 再直接 start:file)
Expected: 若 ABI 失败 → **"加载本地服务失败"dialog 且文案含 `pnpm rebuild:electron`**(D10 验证)

- [ ] **Step 3: 回写 + 提交**

把 D3b(hash 与 location.search 共存行为)与 file:// 端到端结论回写 spec 0.1/0.4。

```bash
git add docs/superpowers/specs/m0-desktop-shell.md
git commit -m "docs(spec): 生产形态端到端结论回写(file:// + hash + ABI dialog)"
```

---

### Task 8: 设置页 + probe:bins + 收尾

**Files:**
- Create: `server/src/bins.ts`, `server/src/bins.test.ts`, `server/src/http/settings-routes.ts`, 修改 `server/src/index.ts`(注册路由)
- Modify: `web/src/pages/settings.tsx`(完整版)

**Interfaces:**
- Consumes: `createSettingsRepo`/`SETTINGS_KEYS`(Task 2)
- Produces:
  - `candidatesFromPath(pathVar, name): string[]`、`probeBin(name, explicitPath?): Promise<{ path: string | null; version: string | null }>`
  - `GET /api/settings` / `PUT /api/settings`(键白名单校验)/ `GET /api/bins/probe`
  - 设置页:二进制探测卡片(缺失标红)、apiPort 展示、默认输出目录/格式(存储到 settings)

- [ ] **Step 1: 写失败测试(bins 探测纯函数部分)**

`server/src/bins.test.ts`:

```ts
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { candidatesFromPath } from './bins.js';

describe('candidatesFromPath(纯函数)', () => {
  it('按分隔符切分并拼接可执行文件名;空段忽略', () => {
    const p = ['C:\\\\a', '', 'C:\\\\b'].join(path.delimiter);
    const name = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
    expect(candidatesFromPath(p, 'yt-dlp')).toEqual([
      path.join('C:\\\\a', name),
      path.join('C:\\\\b', name),
    ]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @sct/server test -- src/bins.test.ts`
Expected: FAIL —— bins 模块不存在

- [ ] **Step 3: 写实现**

`server/src/bins.ts`:

```ts
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const WIN = process.platform === 'win32';

export function candidatesFromPath(pathVar: string, name: string): string[] {
  const exe = WIN ? `${name}.exe` : name;
  return pathVar
    .split(path.delimiter)
    .filter(Boolean)
    .map((dir) => path.join(dir, exe))
    .filter((p) => existsSync(p));
}

export type BinName = 'yt-dlp' | 'ffmpeg';

export interface BinProbe {
  path: string | null;
  version: string | null;
}

export function probeBin(name: BinName, explicitPath?: string): Promise<BinProbe> {
  const candidates = explicitPath ? [explicitPath] : candidatesFromPath(process.env['PATH'] ?? '', name);
  return new Promise((resolve) => {
    if (candidates.length === 0) return resolve({ path: null, version: null });
    const bin = candidates[0]!;
    execFile(bin, ['--version'], { timeout: 8000 }, (err, stdout) => {
      if (err) return resolve({ path: bin, version: null });
      resolve({ path: bin, version: stdout.trim().split('\n')[0] ?? null });
    });
  });
}
```

`server/src/http/settings-routes.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import { probeBin } from '../bins.js';
import { createSettingsRepo } from '../db/repo/settings.js';
import { SETTINGS_KEYS } from '../settings-keys.js';
import type { DB } from '../db/index.js';

const ALLOWED_KEYS = new Set<string>(Object.values(SETTINGS_KEYS));

export function registerSettingsRoutes(app: FastifyInstance, db: DB): void {
  const repo = createSettingsRepo(db);

  app.get('/api/settings', async () => repo.all());

  app.put('/api/settings', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    for (const [k, v] of Object.entries(body)) {
      if (!ALLOWED_KEYS.has(k)) return reply.code(400).send({ error: `未知设置键:${k}` });
      if (typeof v !== 'string') return reply.code(400).send({ error: `设置值必须是字符串:${k}` });
    }
    for (const [k, v] of Object.entries(body)) repo.set(k, v as string);
    return { ok: true };
  });

  app.get('/api/bins/probe', async () => {
    const ytdlp = await probeBin('yt-dlp', repo.get(SETTINGS_KEYS.binYtdlp) ?? undefined);
    const ffmpeg = await probeBin('ffmpeg', repo.get(SETTINGS_KEYS.binFfmpeg) ?? undefined);
    repo.set(SETTINGS_KEYS.binsProbedAt, new Date().toISOString());
    if (ytdlp.version) repo.set(SETTINGS_KEYS.binYtdlp, ytdlp.path!);
    if (ffmpeg.version) repo.set(SETTINGS_KEYS.binFfmpeg, ffmpeg.path!);
    return { ytdlp, ffmpeg };
  });
}
```

`server/src/index.ts` 修改:createServer 内 `registerCors(app);` 之后加一行 `registerSettingsRoutes(app, db);`,顶部补 `import { registerSettingsRoutes } from './http/settings-routes.js';`。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @sct/server test`
Expected: PASS(全部)

- [ ] **Step 5: 设置页完整版**

`web/src/pages/settings.tsx`(整文件重写):

```tsx
import { Alert, Button, Card, Descriptions, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { apiGet, apiPort } from '@/api';

interface BinProbe {
  path: string | null;
  version: string | null;
}
interface BinsResult {
  ytdlp: BinProbe;
  ffmpeg: BinProbe;
}

function BinCard({ title, bin }: { title: string; bin: BinProbe | null }) {
  if (!bin) return <Card title={title} loading />;
  const missing = bin.version === null;
  return (
    <Card title={title} style={{ marginBottom: 16 }}>
      {missing ? (
        <Alert
          type="error"
          showIcon
          message="未检测到"
          description="影响:相关获取功能不可用。请确认已安装并加入 PATH,或在下方手动指定路径。"
        />
      ) : (
        <Descriptions size="small" column={1}>
          <Descriptions.Item label="路径">{bin.path}</Descriptions.Item>
          <Descriptions.Item label="版本">{bin.version}</Descriptions.Item>
        </Descriptions>
      )}
    </Card>
  );
}

export default function SettingsPage() {
  const [bins, setBins] = useState<BinsResult | null>(null);

  const probe = () => apiGet<BinsResult>('/api/bins/probe').then(setBins).catch(() => setBins(null));

  useEffect(() => {
    void probe();
  }, []);

  return (
    <div style={{ margin: 16 }}>
      <Card title="设置" style={{ marginBottom: 16 }}>
        <Typography.Text>API 端口:{apiPort()}</Typography.Text>
        <Button style={{ float: 'right' }} onClick={() => void probe()}>
          重新探测
        </Button>
      </Card>
      <BinCard title="yt-dlp" bin={bins?.ytdlp ?? null} />
      <BinCard title="ffmpeg" bin={bins?.ffmpeg ?? null} />
    </div>
  );
}
```

- [ ] **Step 6: 全量验证 + 回写 + 提交**

Run: `pnpm typecheck && pnpm test && pnpm build`
Expected: 全部退出码 0

Run: `pnpm dev` → 设置页确认两个二进制卡片显示版本(ffmpeg 9.0.2 / yt-dlp 2026.08.19);M0 验收("设置页 + 二进制路径检测")达成

把 probe:bins 结论回写 spec 0.4。

```bash
git add server web docs/superpowers/specs/m0-desktop-shell.md
git commit -m "feat: 设置页二进制探测 + settings API,M0 验收闭环"
```

---

## Self-Review

**1. Spec 覆盖**

| Spec 要求 | 对应任务 |
|---|---|
| D1(CJS + 动态 import) | Task 1(desktop tsconfig + dynamic-import) |
| D2(spike 三项验证) | Task 1 Step 5 |
| D3/D3b(端口注入 + hash 实测) | Task 5 api.ts / Task 6 / Task 7 |
| D4(必传 + 递增) | Task 1/3 签名 + findFreePort |
| D5(五表 + bootstrap) | Task 2 |
| D6(两页 + 端口可见) | Task 5 / Task 8 |
| D7(preload 空骨架) | Task 4 |
| D8(单实例锁 + -k) | Task 4 / Task 6 |
| D9(双副本) | Task 1(别名依赖 + rebuild 限定) |
| D10(可诊断) | Task 4(importServer dialog + 回退链 dialog) |
| D11(API 不可达 Alert) | Task 5 api.ts + index 页 |
| 0.3 CORS | Task 3 |
| 0.4 测试清单 | findFreePort/portFile/settings/bootstrap/孤儿/pickDriver 全部落测 |
| M0 验收 | Task 6(dev 态)+ Task 7(file:// 态)+ Task 8(设置页) |

**未覆盖且刻意如此**:入库契约 §3.5(S2)、logger(S2)、electron-builder(M3 后)、源 URL 重复检测(S2)。settings 的"手动指定二进制路径"UI 输入框本计划未做(探测已覆盖验收;手动指定输入框随 S2 批量下载需求一起做,避免一次性 UI)。

**2. 占位符扫描**:无 TBD/TODO;全部代码块完整可运行。electron 版本号由 Task 1 Step 4 实装后锁定(显式步骤,非占位)。

**3. 类型一致性**:`CreateServerOpts`(Task 1 定义,Task 3 重写保持同形)→ probe:abi(T1)/main.ts(T4)/dev.ts(T3)调用一致;`parsePortFile` 返回 `{port,pid} | null` ↔ 写入方 `JSON.stringify({port, pid})` 一致;`pickDriver` ↔ D9 副本名一致;`SETTINGS_KEYS` ↔ settings-routes 白名单一致。

## 执行交接

计划已保存到 `docs/superpowers/plans/2026-09-26-M0-desktop-shell.md`。两种执行方式:

**1. Subagent 驱动(推荐)** —— 每个任务派一个全新 subagent,任务间 review;Task 1(spike)失败即全局停止

**2. 本会话内联执行** —— 用 executing-plans 带检查点批量执行

**注意**:无论哪种方式,commit 步骤开始前需你确认(全局 Git 禁令);Task 1 的 spike 结论(含 Electron 版本、rebuild 命令形式)必须回写 spec 后才进入 Task 2。
