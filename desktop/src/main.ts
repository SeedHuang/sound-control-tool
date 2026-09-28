import { app, BrowserWindow, dialog } from 'electron';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parsePortFile, type DevPortInfo } from './shared/parse-port-file.js';
import { probeHealth, type ServerModule } from './shared/server-contract.js';

/** 生产加载形态用 --load=file 触发(Task 7);R5 前无打包,这是 file:// 验证的开关 */
const FILE_LOAD = process.argv.includes('--load=file');

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
    // Low:will-quit 不被 Electron await;改 before-quit + preventDefault,await close 后再 exit
    let quitting = false;
    app.on('before-quit', (event) => {
      if (quitting) return;
      event.preventDefault();
      quitting = true;
      void s.close().finally(() => app.exit(0));
    });
    await openWindow('file', s.port, s.token);
  } else {
    const resolved = await resolveDevApiPort();
    if (resolved.port > 0) await openWindow('dev', resolved.port, resolved.token);
  }
}

/** D10:import 失败禁止裸崩,给可执行指引 */
async function importServer(): Promise<ServerModule> {
  try {
    // module:node16 下 TS 保留真实 import()(不再降级为 require);CJS 主进程可直接加载 ESM 的 @sct/server
    return (await import('@sct/server')) as unknown as ServerModule;
  } catch (e) {
    dialog.showErrorBox(
      '加载本地服务失败',
      '常见原因:server 构建产物缺失(dist/)或运行时模块加载失败。\n\n请运行:\n\n  pnpm --filter @sct/server build\n\n然后重新启动。\n\n' + String(e),
    );
    app.exit(1);
    throw e; // 仅为 TS 类型完备;app.exit 异步终止前外层 catch 可能再弹一次窗,可接受
  }
}

/** D3 回退链:portFile → 7310 → dialog 指引并退出 */
async function resolveDevApiPort(): Promise<{ port: number; token: string }> {
  // appPath=desktop 包目录,仓库根在其上一级;打包形态(M3)时此处需重新审视
  const portFile = path.join(app.getAppPath(), '..', '.sct', 'dev-port');
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (existsSync(portFile)) {
      let info: DevPortInfo | null = null;
      try {
        info = parsePortFile(readFileSync(portFile, 'utf8'));
      } catch {
        /* 读取失败(并发删除/占用/AV 锁) → 交回退链兜底,不逃逸 */
      }
      if (info && (await probeHealth(info.port))) return { port: info.port, token: info.token };
    }
    if (await probeHealth(7310)) {
      // 7310 兜底:此为"server 已按默认端口跑起来但 portFile 缺失"的场景,非本套 dev 流程,token 无从得知 → 传空串。
      // 该路径下浏览器豁免不生效(页面 Origin 非 localhost/file:// 时),受保护路由会 401——可接受降级(/api/health 仍通)。
      return { port: 7310, token: '' };
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  dialog.showErrorBox('本地服务未启动', '10 秒内未检测到本地 API 服务。\n\n请先运行:\n\n  pnpm dev:server\n\n(或直接 pnpm dev)');
  app.exit(1);
  return { port: 0, token: '' };
}

async function openWindow(mode: 'dev' | 'file', apiPort: number, apiToken: string): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
    },
  });
  const search = `apiPort=${apiPort}&apiToken=${apiToken}`;
  if (mode === 'file') {
    const indexPath = path.join(app.getAppPath(), '..', 'web', 'dist', 'index.html');
    await mainWindow.loadFile(indexPath, { search });
  } else {
    // 竞态修复:dev server(webpack)启动慢于 electron,直接 loadURL 会 ERR_CONNECTION_REFUSED 弹"启动失败"。
    // 先等 8000 有 HTTP 响应(任意状态码,dev 页面编译中也会返回 HTML)再加载。
    const webReady = await waitForWebReady(8000, 60_000);
    if (!webReady) {
      dialog.showErrorBox('Web 页面未就绪', '60 秒内未检测到 web dev server(8000 端口)。\n\n请确认已运行:\n\n  pnpm dev:web\n\n(或直接 pnpm dev 三进程一起起)');
      app.exit(1);
      return;
    }
    await mainWindow.loadURL(`http://localhost:8000/?${search}`);
  }
}

/** 轮询等待端口上有 HTTP 响应;dev server 一旦 listen 即响应,编译中页面也返回 HTML */
async function waitForWebReady(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 800);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, { signal: ctl.signal });
      if (res.status < 500) return true;
    } catch {
      /* 未就绪,继续轮询 */
    } finally {
      clearTimeout(timer);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}
