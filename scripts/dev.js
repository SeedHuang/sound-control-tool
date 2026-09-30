/**
 * dev 编排器(2026-09-30):根治「electron 按写死端口把别人家 dev server 页面装进我们窗口」的老坑。
 *
 * 事故链(2026-09-30 实测,参照项目 bilibili_favorite_manager 的 dev server 占 8000 时):
 *   check-port 通过 → Umi 绑定前端口被抢 → Umi 静默顺延(用户实测落到 8002)
 *   → electron 仍等写死的 8000 → 旧判定"任意 <500 响应就算就绪" → 加载到参照项目的页面。
 *
 * 本脚本的信任锚:
 *   1. web 端口由**本脚本**挑定(空闲探测,被占 +1 顺延);
 *   2. 从 Umi stdout 解析实际监听端口做**二次确认**(被顺延时以 stdout 为准并告警);
 *   3. HTTP 就绪后才写 `.sct/dev-web-port` —— 该文件**只由本脚本写**、每次启动先清旧文件,
 *      electron 主进程(desktop/src/main.ts resolveDevWebPort)只信它,绝不回退写死端口。
 *
 * 流程:
 *   server(spawn,自身仍写 .sct/dev-port 供 electron 握手,不变)
 *   → 挑 web 端口 → web(spawn,umi --port N) → stdout 解析实际端口
 *   → 单一定时器轮询 HTTP 就绪 → 写 dev-web-port → electron(spawn)
 *   → electron 退出 / SIGINT / SIGTERM → taskkill /T /F 杀全树
 *
 * 已知约束:
 * - 「Local: http://localhost:<port>」是 Umi 的打印文案而非官方 API,Umi 大版本升级可能需改
 *   PORT_MATCH;解析不到时 60s 响亮报错退出,绝不静默回退写死端口(那会回到加载错页面的老路)。
 * - 进程树清理仅 Windows 完备(taskkill /T /F);本项目仅出 Windows 包,POSIX 分支尽力而为。
 * - 轮询必须单一定时器 + launched 标志:timeout/error 都会走下一轮询,递归 setTimeout 会
 *   累积并行等待链,就绪瞬间拉起多个 Electron(system-c-cleaner dev.js v1 实测踩坑)。
 */
const { spawn, execSync } = require('node:child_process');
const net = require('node:net');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const PORT_FILE = path.join(ROOT, '.sct', 'dev-web-port');
const WEB_PORT_FIRST = 8000;      // 首选 web 端口(沿用旧约定;被占自动 +1)
const WEB_PORT_MAX_TRIES = 10;    // 从首选起最多试 10 个
const PORT_TIMEOUT_MS = 60_000;   // 从 web stdout 解析到端口的总时限
const READY_TIMEOUT_MS = 120_000; // 端口确认后、HTTP 就绪的时限(无 MFSU 缓存的冷编译可能 >1 分钟)
const POLL_INTERVAL_MS = 500;

// 编排器自身的关键步骤全留痕(对齐 .trae/rules/electron-dev-must-log.md;经 [orch] 前缀进终端)
const log = (tag, msg) => console.log(`[${tag}] ${msg}`);
const logErr = (tag, msg) => console.error(`[${tag}] ${msg}`);

let exiting = false;        // exitAll 幂等守卫
let launched = false;       // electron 已拉起(HTTP 就绪回调只生效一次)
let webPortConfirmed = null; // 从 web stdout 解析出的实际端口(null=尚未确认)
const children = [];        // { name, child } —— 退出时逐个杀树

function spawnChild(name, args, onLine) {
  log(name, `spawn: pnpm ${args.join(' ')}`);
  const child = spawn('pnpm', args, { cwd: ROOT, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push({ name, child });
  pipeLines(name, child, onLine);
  return child;
}

/** 逐行转发子进程输出(带 [name] 前缀),每行回调 onLine */
function pipeLines(name, child, onLine) {
  let rest = '';
  const feed = (d) => {
    rest += d.toString().replace(/\r/g, '');
    const lines = rest.split('\n');
    rest = lines.pop();
    for (const line of lines) {
      console.log(`[${name}] ${line}`);
      if (onLine) onLine(line);
    }
  };
  child.stdout.on('data', feed);
  child.stderr.on('data', feed);
  child.on('exit', () => { if (rest) console.log(`[${name}] ${rest}`); });
}

function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore' });
    } else {
      process.kill(pid, 'SIGTERM');
    }
  } catch { /* 进程可能已退出 */ }
}

function exitAll(code) {
  if (exiting) return;
  exiting = true;
  log('orch', `退出(code=${code}),清理子进程树…`);
  for (const { child } of children) killTree(child.pid);
  children.length = 0;
  process.exit(code);
}

process.on('exit', () => { for (const { child } of children) killTree(child.pid); });
process.on('SIGINT', () => exitAll(130));
process.on('SIGTERM', () => exitAll(143));

/** 空闲端口探测:能 listen 即空闲(resolve);EADDRINUSE 等错误 reject */
function probePort(port) {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve()));
  });
}

/** 从首选端口起找空闲端口;全占返回 null(调用方响亮退出) */
async function pickWebPort() {
  for (let i = 0; i < WEB_PORT_MAX_TRIES; i++) {
    const port = WEB_PORT_FIRST + i;
    try {
      await probePort(port);
      log('orch', `web 端口选定 ${port}${i > 0 ? `(首选 ${WEB_PORT_FIRST} 被占,顺延 ${i} 个)` : ''}`);
      return port;
    } catch (e) {
      log('orch', `端口 ${port} 被占(EADDRINUSE),试下一个`);
      if (e && e.code !== 'EADDRINUSE') throw e;
    }
  }
  return null;
}

/** 单一定时器轮询 HTTP 就绪;就绪后恰好多做一件事:写端口文件 + 拉起 electron */
function waitHttpReady(port) {
  const startedAt = Date.now();
  const timer = setInterval(() => {
    if (exiting || launched) { clearInterval(timer); return; }
    if (Date.now() - startedAt > READY_TIMEOUT_MS) {
      clearInterval(timer);
      logErr('orch', `端口 ${port} 在 ${READY_TIMEOUT_MS / 1000}s 内 HTTP 未就绪,退出`);
      exitAll(1);
      return;
    }
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 2000 }, (res) => {
      res.resume();
      if (res.status >= 500) return; // 5xx 视为未就绪,交下一轮询
      clearInterval(timer);
      if (launched || exiting) return;
      launched = true;
      try {
        fs.mkdirSync(path.dirname(PORT_FILE), { recursive: true });
        fs.writeFileSync(PORT_FILE, JSON.stringify({ port }), 'utf8');
        log('orch', `web 就绪(HTTP ${res.status}),已写 ${PORT_FILE} = {"port":${port}}`);
      } catch (e) {
        logErr('orch', `写端口文件失败:${e instanceof Error ? e.message : String(e)}`);
        exitAll(1);
        return;
      }
      spawnChild('electron', ['--filter', '@sct/desktop', 'dev']);
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => {});
  }, POLL_INTERVAL_MS);
}

async function main() {
  // 0. 清掉上一轮的端口文件:它只对"本轮 web"有效,残留会让 electron 读到旧端口
  try {
    fs.unlinkSync(PORT_FILE);
    log('orch', `已清理旧端口文件 ${PORT_FILE}`);
  } catch (e) {
    if (e.code !== 'ENOENT') logErr('orch', `清理旧端口文件失败(继续):${e instanceof Error ? e.message : String(e)}`);
  }

  // 1. server(自身写 .sct/dev-port 供 electron 握手,链路不变)
  const serverChild = spawnChild('server', ['--filter', '@sct/server', 'dev']);
  serverChild.on('exit', (code) => {
    if (!exiting && !launched) {
      logErr('orch', `server 提前退出(code=${code ?? 'null'}),关闭全部`);
      exitAll(code ?? 1);
    }
  });

  // 2. 挑 web 空闲端口
  const chosen = await pickWebPort();
  if (chosen === null) {
    logErr('orch', `${WEB_PORT_FIRST}~${WEB_PORT_FIRST + WEB_PORT_MAX_TRIES - 1} 全被占用,退出。请释放端口后重试。`);
    exitAll(1);
    return;
  }

  // 3. web(umi --port chosen);stdout 解析实际端口做二次确认,被顺延时以实际为准
  const webChild = spawnChild('web', ['--filter', '@sct/web', 'dev', '--port', String(chosen)], (line) => {
    if (webPortConfirmed || launched) return;
    const m = /Local:\s*http:\/\/(?:localhost|127\.0\.0\.1):(\d+)/.exec(line)
      || /(?:localhost|127\.0\.0\.1):(\d+)/.exec(line);
    if (!m) return;
    const parsed = Number(m[1]);
    if (!Number.isInteger(parsed) || parsed <= 0 || parsed >= 65536) return;
    webPortConfirmed = parsed;
    if (parsed !== chosen) {
      logErr('orch', `警告:web 实际监听 ${parsed},与我们指定的 ${chosen} 不一致(绑定竞态被顺延)。以实际端口为准。`);
    } else {
      log('orch', `web 实际监听端口确认:${parsed}(与指定一致)`);
    }
    waitHttpReady(parsed);
  });
  webChild.on('exit', (code) => {
    if (!exiting && !launched) {
      logErr('orch', `web dev 提前退出(code=${code ?? 'null'}),关闭全部`);
      exitAll(code ?? 1);
    }
  });

  // 4. 解析不到端口的总时限:响亮失败,绝不回退写死端口
  setTimeout(() => {
    if (!webPortConfirmed && !exiting) {
      logErr('orch', `${PORT_TIMEOUT_MS / 1000}s 内未从 web 输出解析到端口。` +
        '可能原因:Umi 输出格式变更(应含 "Local: http://localhost:<port>")或 dev server 启动失败。退出。');
      exitAll(1);
    }
  }, PORT_TIMEOUT_MS);
}

main().catch((e) => {
  logErr('orch', `编排器异常:${e instanceof Error ? e.message : String(e)}`);
  exitAll(1);
});
