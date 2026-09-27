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
