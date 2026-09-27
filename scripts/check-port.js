// 端口预检:被占即退出 1(spec 0.3"web dev 端口固定 8000"约定的 fail-fast 落实)。
// 背景:实测 max dev 在端口被占时静默换端口,导致 electron 按 8000 约定加载错页面。
const net = require('node:net');

const port = Number(process.argv[2]);
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  console.error(`[check-port] 非法端口:${process.argv[2]}`);
  process.exit(1);
}

const srv = net.createServer();
srv.once('error', () => {
  console.error(`[check-port] 端口 ${port} 已被占用——max dev 会静默换端口导致 electron 加载错页面,已按约定直接失败。请释放端口或关闭占用者。`);
  process.exit(1);
});
srv.listen(port, '127.0.0.1', () => {
  srv.close(() => {
    console.log(`[check-port] 端口 ${port} 空闲`);
    process.exit(0);
  });
});
