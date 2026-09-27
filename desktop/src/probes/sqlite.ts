/** D2 spike(C1):验证项②(Electron 主进程动态 import server 完整入口 + node:sqlite 往返)。手工运行 pnpm probe:sqlite */
import { app } from 'electron';
import os from 'node:os';
import path from 'node:path';
import { probeHealth, type ServerModule } from '../shared/server-contract.js';

app.whenReady().then(async () => {
  let failures = 0;
  try {
    const server = (await import('@sct/server')) as unknown as ServerModule;
    const s = await server.createServer({
      port: 7399,
      dbPath: ':memory:',
      tempDir: path.join(os.tmpdir(), 'sct-probe-sqlite'),
    });
    // M6:用返回的实际端口(createServer 遇占用会递增,硬编码 7399 会打到无关进程)
    const ok = await probeHealth(s.port, 3000);
    console.log(`② Electron 内 import server + node:sqlite 往返: ${ok ? 'OK' : 'FAIL'} port=${s.port}`);
    if (!ok) failures++;
    await s.close();
  } catch (e) {
    console.error('② FAIL:', e);
    failures++;
  }
  console.log('① 原生模块 rebuild 已随 C1 移除(node:sqlite 零原生模块);③ 由 pnpm probe:sqlite:node 验证');
  console.log(failures === 0 ? '=== probe:sqlite PASS ===' : `=== probe:sqlite FAIL(${failures}) ===`);
  app.exit(failures === 0 ? 0 : 1);
});
