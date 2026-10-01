import { app, BrowserWindow, dialog, ipcMain, Menu, shell, Tray } from 'electron';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parsePortFile, type DevPortInfo } from './shared/parse-port-file.js';
import { probeHealth, type ServerModule } from './shared/server-contract.js';
import { loadTrayIcon } from './tray-icon.js';

/** 生产加载形态用 --load=file 触发(Task 7);R5 前无打包,这是 file:// 验证的开关 */
const FILE_LOAD = process.argv.includes('--load=file');

let mainWindow: BrowserWindow | null = null;
/** 托盘(spec D13/D14/D15)的模块级状态:openWindow 已经把这两个值交给我们,存下来给轮询用 */
let tray: Tray | null = null;
let apiPort = 0;
let apiToken = '';
/** 关窗收托盘的开关:false → 关窗只隐藏;true → 放行真正的退出(spec D15,由 before-quit / 托盘「退出」置位) */
let isQuitting = false;
/** 轮询用 setTimeout 自调度(在途 1s / 空闲 5s),不用 setInterval——请求堆积会让界面与进度错拍 */
const TRAY_POLL_BUSY_MS = 1000;
const TRAY_POLL_IDLE_MS = 5000;
/** 连续失败达到这个次数才把 tooltip 标成"服务未连接":单次抖动不改界面,避免闪烁(spec §0.5) */
const TRAY_POLL_FAIL_THRESHOLD = 3;
let trayPollTimer: ReturnType<typeof setTimeout> | null = null;
let trayPollRunning = false;
let trayPollFailures = 0;
/** 上一轮是否有在途任务——决定下一轮间隔(失败时保持上一轮节奏,网络恢复后能立刻接上) */
let trayPollBusy = false;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // 关窗收托盘后窗口多了"隐藏态",而 Windows 下 focus() 不会让被 hide 的窗口重新显示
    // → 双击图标再启动时若无反应,用户会以为应用坏了。故走 showMainWindow()(内部 show()+focus(),
    // 且已处理 null / isDestroyed)。函数声明会被提升,顶层 handler 可直接调用。
    showMainWindow();
  });
  void app.whenReady().then(run).catch((e: unknown) => {
    dialog.showErrorBox('启动失败', String(e));
    app.exit(1);
  });
}

async function run(): Promise<void> {
  // 最早注册 IPC:渲染进程一加载就可能调用它,必须早于任何窗口创建
  registerExportDirIpc();
  // 退出开关 + 轮询清理:必须早于窗口创建注册,否则"窗口还没出来就退出"会漏挂。
  // 注意与 FILE_LOAD 分支里那条既有的 before-quit 共存——那条负责 "await s.close() 后再 exit(0)",
  // 这条只负责"放行关窗 + 停轮询",两者是分工不是替换(都在同一个事件上,各自独立跑)。
  app.on('before-quit', () => {
    isQuitting = true;
    stopTrayPolling();
    tray?.destroy();
    tray = null;
  });
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
    apiPort = s.port;
    apiToken = s.token;
    await openWindow('file', s.port, s.token);
    setupTray();
  } else {
    const resolved = await resolveDevApiPort();
    // 记下端口与 token:托盘轮询直接拿它们请求 /api/jobs(token 走 x-sct-token 头,与渲染进程一致)
    apiPort = resolved.port;
    apiToken = resolved.token;
    if (resolved.port > 0) await openWindow('dev', resolved.port, resolved.token);
    setupTray();
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

/** 导出目录相关的最小 IPC（spec D7）：主进程先校验"确实是个存在的目录"，
 *  再把字符串交给系统——不允许渲染进程把任意路径丢给 shell。 */
function registerExportDirIpc(): void {
  // 必须 async + await：若同步返回 shell.openPath(p) 的 Promise，下面 try/catch 捕不到它的异步拒绝，
  // 异常会经 ipcMain.handle 冒泡成渲染侧 invoke 的 reject —— 违反"两个 handler 都要兜底、不把异常原样抛给渲染进程"。
  ipcMain.handle('sct:reveal-path', async (_e, p: unknown) => {
    try {
      if (typeof p !== 'string' || p.trim() === '') {
        console.error(`[electron] reveal-path 未打开(path=${String(p)}, reason=路径为空)`);
        return { ok: false, message: '路径为空' };
      }
      if (!existsSync(p) || !statSync(p).isDirectory()) {
        console.error(`[electron] reveal-path 未打开(path=${p}, reason=目录不存在或不是文件夹)`);
        return { ok: false, message: '目录不存在或不是文件夹' };
      }
      // shell.openPath 返回空串 = 成功；非空串是系统给的错误描述
      const msg = await shell.openPath(p);
      if (msg === '') {
        console.log(`[electron] reveal-path 已打开(path=${p})`);
        return { ok: true };
      }
      console.error(`[electron] reveal-path 未打开(path=${p}, reason=${msg})`);
      return { ok: false, message: msg };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`[electron] reveal-path 失败(path=${String(p)}, reason=${message})`); // 仓库规则：关键步骤留痕
      return { ok: false, message };
    }
  });

  ipcMain.handle('sct:pick-directory', async () => {
    try {
      // 磁盘实况：Electron 44 的 showOpenDialog 只有 (window, options) 与 (options) 两个重载，
      // 传 `mainWindow ?? undefined` 不被任一重载接受（TS 报无匹配重载），故按有无父窗口分两支调用。
      const r = mainWindow === null
        ? await dialog.showOpenDialog({ properties: ['openDirectory'] })
        : await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
      return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0]!;
    } catch (e) {
      console.error(`[electron] pick-directory 失败: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  });
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

// ── 托盘(spec D13/D14/D15):把"下载到哪了"从页内搬到系统层,关窗也不丢 ────────────────

/** 建托盘。**没有窗口、或没有真实端口/token 就完全不建**——空 token 轮询只会一路 401,徒增噪音。 */
function setupTray(): void {
  const win = mainWindow;
  if (win === null) {
    console.log('[electron] tray:无窗口,跳过建托盘');
    return;
  }
  if (apiPort <= 0 || apiToken === '') {
    console.log(`[electron] tray:缺少 apiPort/apiToken(port=${apiPort}, token=${apiToken === '' ? 'none' : 'present'}),跳过建托盘`);
    return;
  }
  // 图标:文件优先(便于换图),读不到就用内嵌副本。
  // 为什么不做成"只读 __dirname/../assets":打包形态无法保证 assets/ 随包,而空白
  // 托盘图位在真机上极难排查(用户只看到"托盘点不到")。解析链见 tray-icon.ts。
  const icon = loadTrayIcon();
  try {
    tray = new Tray(icon);
  } catch (e) {
    // 托盘建不起来不该毁掉主流程:记日志后降级为"无托盘"(这时关窗就不隐藏,见下面的 close 分支)
    console.error(`[electron] tray:创建失败(不阻塞主流程):${e instanceof Error ? e.message : String(e)}`);
    tray = null;
    return;
  }
  tray.setToolTip('就绪');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '打开主窗口', click: () => showMainWindow() },
      { label: '显示下载器', click: () => openDownloaderFromTray() },
      { type: 'separator' },
      { label: '退出', click: () => { isQuitting = true; app.quit(); } },
    ]),
  );
  // 左键单击 = 显示并聚焦主窗口(D14);Windows 上右键才是菜单
  tray.on('click', () => showMainWindow());

  // 关窗 = 收进托盘(D15),应用不退出、下载继续。只有 isQuitting 时才放行真正的关闭。
  win.on('close', (event) => {
    // 没托盘时不许隐藏:那样窗口就再也找不回来了(用户只能去任务管理器)
    if (isQuitting || tray === null) return;
    event.preventDefault();
    win.hide();
    console.log('[electron] tray:窗口收进托盘(应用不退出,下载继续)');
    showFirstTrayHint();
  });
  win.on('closed', () => {
    stopTrayPolling();
    tray?.destroy();
    tray = null;
    console.log('[electron] tray:窗口已销毁,托盘与轮询一并清理');
  });

  console.log(`[electron] tray:已创建(apiPort=${apiPort}, token=present, 图标=${icon.isEmpty() ? '空图(兜底)' : '已加载'})`);
  startTrayPolling();
}

function showMainWindow(): void {
  if (mainWindow === null || mainWindow.isDestroyed()) return;
  mainWindow.show();
  mainWindow.focus();
}

/** 托盘「显示下载器」:托盘碰不到 DOM,只能让主进程先保证窗口可见,再把指令转给渲染进程(spec §0.3)。 */
function openDownloaderFromTray(): void {
  showMainWindow();
  mainWindow?.webContents.send('sct:open-downloader');
  console.log('[electron] tray:已通知渲染进程打开下载器抽屉');
}

/** 首次收托盘提示一次(D15)。标记文件放 userData:读不到标记也照常提示——宁多一次,
 *  也不要让用户以为应用"没关掉、后台有鬼"。写标记失败不阻塞本次提示(下次会再提示一遍)。 */
function showFirstTrayHint(): void {
  if (tray === null) return;
  const marker = path.join(app.getPath('userData'), 'tray-hint-shown');
  try {
    if (existsSync(marker)) return;
  } catch (e) {
    console.error(`[electron] tray:读首次提示标记失败(按未提示处理):${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    if (process.platform === 'win32') {
      tray.displayBalloon({ title: '已最小化到托盘', content: '下载会继续,双击托盘图标可唤回窗口。' });
    } else {
      // 非 Windows 没有气泡 API,退化为 tooltip(总比一声不吭强)
      tray.setToolTip('已最小化到托盘,下载会继续');
    }
    writeFileSync(marker, new Date().toISOString());
    console.log('[electron] tray:首次收托盘提示已展示');
  } catch (e) {
    console.error(`[electron] tray:首次提示失败(不阻塞):${e instanceof Error ? e.message : String(e)}`);
  }
}

function startTrayPolling(): void {
  if (trayPollRunning) return;
  trayPollRunning = true;
  trayPollFailures = 0;
  trayPollBusy = false;
  void trayTick();
}

/** 停轮询:退出/窗口销毁时调用。自调度的下一次不会排——因为 tick 的 finally 会检查 trayPollRunning。 */
function stopTrayPolling(): void {
  trayPollRunning = false;
  if (trayPollTimer !== null) {
    clearTimeout(trayPollTimer);
    trayPollTimer = null;
  }
}

/** 一轮拉取:GET /api/jobs?active=1(D9),更新 tooltip 与任务栏进度条,再自己排下一次。 */
async function trayTick(): Promise<void> {
  try {
    const res = await fetch(`http://127.0.0.1:${apiPort}/api/jobs?active=1`, {
      headers: { 'x-sct-token': apiToken },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as {
      jobs?: Array<{ kind?: unknown; status?: unknown; progress?: unknown }>;
      downloads?: { total?: unknown; done?: unknown; running?: unknown; queued?: unknown };
    };
    // 请求期间可能已退出/窗口没了 → 丢弃结果,不要再碰 UI
    if (!trayPollRunning || tray === null) return;

    const jobs = Array.isArray(body.jobs) ? body.jobs : [];
    const d = body.downloads ?? {};
    const total = Number(d.total) || 0;
    const done = Number(d.done) || 0;
    // 托盘是「下载器」:在途判定与「当前%」只取下载类(job.kind 形如 ytdlp_video / ytdlp_download)。
    // GET /api/jobs 故意同时返回剪辑/导出(D12 抽屉要统一展示、那是对的),但托盘不该被它们影响——
    // 否则"没有下载、只在剪辑室导出一个"会显示成"下载中 0/0 · 当前 55%"这类自相矛盾的口径,
    // 且任务栏会显示 ffmpeg 的进度。分数(done/total)本就来自只统计下载的 downloads 批次(D16),两者对齐。
    const dl = jobs.filter((j) => typeof j.kind === 'string' && j.kind.startsWith('ytdlp_'));
    const active = dl.length;
    trayPollFailures = 0;
    trayPollBusy = active > 0;
    // 「当前 n%」口径 = **运行中的下载任务**的平均进度(排队中的进度必为 0,算进去会稀释);无运行中 → 0
    const running = dl.filter((j) => j.status === 'running');
    const avg =
      running.length === 0
        ? 0
        : Math.round(running.reduce((sum, j) => sum + (Number(j.progress) || 0), 0) / running.length);

    tray.setToolTip(active > 0 ? `下载中 ${done}/${total} · 当前 ${avg}%` : '就绪');
    // 任务栏进度条(D13):有在途 → 按平均进度;无在途 → -1 清除(不清会留下一条永远卡住的进度)
    mainWindow?.setProgressBar(active > 0 ? avg / 100 : -1);
  } catch (e) {
    trayPollFailures += 1;
    // 失败只落日志,不弹窗、不改界面(§0.5);连续失败到阈值才改 tooltip,避免闪断就跳变
    console.error(`[electron] tray:拉取在途任务失败(第 ${trayPollFailures} 次):${e instanceof Error ? e.message : String(e)}`);
    if (tray !== null && trayPollFailures >= TRAY_POLL_FAIL_THRESHOLD) tray.setToolTip('本地服务未连接');
  } finally {
    // 自调度:只在自己还"活着"时排下一次;间隔用上一轮的在途状态(失败时保持节奏,恢复后能立刻接上)
    if (trayPollRunning && tray !== null) {
      trayPollTimer = setTimeout(() => {
        void trayTick();
      }, trayPollBusy ? TRAY_POLL_BUSY_MS : TRAY_POLL_IDLE_MS);
    }
  }
}
