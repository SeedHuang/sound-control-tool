import { app, BrowserWindow, dialog, shell } from 'electron';
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
  // 外链走系统浏览器(2026-09-29:剪辑室「原视频」链接用 target=_blank):
  // 不拦的话 Electron 默认新开一个无 preload 的裸窗口,点一次冒一个;这里统一 deny + openExternal
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  if (mode === 'file') {
    const indexPath = path.join(app.getAppPath(), '..', 'web', 'dist', 'index.html');
    await mainWindow.loadFile(indexPath, { search });
  } else {
    // 2026-09-30 端口错位根治:web 的真实端口由 scripts/dev.js 写进 .sct/dev-web-port(只由我们自己的编排器写),
    // 本进程只信这个文件。旧实现"等 8000 有任意 <500 响应就 loadURL"在端口被参照项目(bilibili_favorite_manager)
    // 的 dev server 占用时,会把别人家的页面装进我们的窗口(check-port.js 头注释记录的同族坑),已删。
    const webPort = await resolveDevWebPort();
    if (webPort === null) {
      dialog.showErrorBox(
        'Web 页面未就绪',
        '60 秒内未读到 .sct/dev-web-port(web dev 实际端口文件)。\n\nweb 端口现由 scripts/dev.js 自动挑选空闲端口并写入该文件。\n请用以下方式启动:\n\n  pnpm dev\n\n(单独 pnpm dev:electron 不再受支持)',
      );
      app.exit(1);
      return;
    }
    // 日志(仓库规则:关键步骤留痕;token 只记来源不记值,dev.js 会以 [electron] 前缀转发到终端)
    console.log(`[electron] dev:加载 web dev server http://localhost:${webPort}(apiPort=${apiPort},token=${apiToken ? 'query' : 'none'})`);
    await mainWindow.loadURL(`http://localhost:${webPort}/?${search}`);
  }
}

/** 读 .sct/dev-web-port(scripts/dev.js 在 web HTTP 就绪后写入 {"port":N});60s 内读到合法端口,否则 null。
 *  信任锚:该文件只由我们自己的编排器写入,且编排器每次启动先清旧文件 —— 残留值不可能被误读。 */
async function resolveDevWebPort(): Promise<number | null> {
  const portFile = path.join(app.getAppPath(), '..', '.sct', 'dev-web-port');
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (existsSync(portFile)) {
      let raw = '';
      try {
        raw = readFileSync(portFile, 'utf8');
        const parsed = JSON.parse(raw) as { port?: unknown };
        const port = Number(parsed.port);
        if (Number.isInteger(port) && port > 0 && port < 65536) {
          console.log(`[electron] dev:读到 web 端口 ${port}(来源 ${portFile})`);
          return port;
        }
        console.error(`[electron] dev:端口文件内容非法(重试):${raw.slice(0, 100)}`);
      } catch (e) {
        console.error(`[electron] dev:端口文件读取/解析失败(重试):${e instanceof Error ? e.message : String(e)}`);
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  console.error('[electron] dev:60s 内未读到有效的 .sct/dev-web-port');
  return null;
}
