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
