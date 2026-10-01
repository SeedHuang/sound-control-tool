// 一次性脚本:生成托盘图标 desktop/assets/tray.png(32×32)。
//
// 为什么用手写 PNG:托盘图标只此一枚,不值得为一个静态资源引入 sharp/canvas 等依赖。
// node:zlib 是内置模块,足以做出一张合法的 PNG;脚本留在仓库即"这图标怎么来的"的说明,
// 避免出现无法追溯的二进制黑盒。
//
// 用法(仓库根或 desktop 目录均可):
//   node desktop/scripts/make-tray-icon.mjs
//
// 产物:desktop/assets/tray.png —— 底色 #1677ff,中央一个白色向下箭头(下载语义)。
// 图形是程序化绘制的:改这里的 W/H/颜色/箭头几何,重跑本脚本即可重新生成。

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const W = 32;
const H = 32;

// ── CRC32(PNG 每个 chunk 尾部都要)。Node 的 zlib 亦有 crc32,但版本要求偏高,
//    这里手写一张标准表,零外部依赖、各版本通用。 ──────────────────────────────
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** 组装一个 PNG chunk:长度(4) + 类型(4) + 数据 + CRC(4,覆盖类型+数据)。 */
function makeChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

// ── 像素:底 #1677ff,前景白,中央一个向下箭头 ────────────────────────────────
const BG = [0x16, 0x77, 0xff, 0xff];
const FG = [0xff, 0xff, 0xff, 0xff];

function inArrow(x, y) {
  // 箭杆:居中竖条
  if (x >= 13 && x <= 18 && y >= 6 && y <= 15) return true;
  // 箭头:等腰三角形,顶边 y=15 半宽 8,尖点 y=26 半宽 0
  if (y >= 15 && y <= 26) {
    const dy = y - 15; // 0..11
    const half = Math.round((8 * (11 - dy)) / 11); // 8 → 0
    return x >= 16 - half && x <= 15 + half;
  }
  return false;
}

const rowBytes = W * 4;
// 每行格式:1 字节 filter(0 = None) + W×4 字节 RGBA
const raw = Buffer.alloc(H * (rowBytes + 1));
for (let y = 0; y < H; y += 1) {
  const rowStart = y * (rowBytes + 1);
  raw[rowStart] = 0; // filter: None
  for (let x = 0; x < W; x += 1) {
    const color = inArrow(x, y) ? FG : BG;
    const off = rowStart + 1 + x * 4;
    raw[off] = color[0];
    raw[off + 1] = color[1];
    raw[off + 2] = color[2];
    raw[off + 3] = color[3];
  }
}

// IHDR:宽 高 位深=8 颜色类型=6(RGBA) 压缩=0 过滤=0 交错=0
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;
ihdr[9] = 6;
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), // PNG 魔数
  makeChunk('IHDR', ihdr),
  makeChunk('IDAT', deflateSync(raw)),
  makeChunk('IEND', Buffer.alloc(0)),
]);

const here = path.dirname(fileURLToPath(import.meta.url));
const outPath = path.join(here, '..', 'assets', 'tray.png');
mkdirSync(path.dirname(outPath), { recursive: true });
writeFileSync(outPath, png);

console.log(`[make-tray-icon] 已写出 ${outPath}（${png.length} 字节）`);

// 同步给 src/tray-icon.ts:那里内嵌了同一份 base64,作为"文件读不到时"的兜底
// (打包形态无法保证 assets/ 随包;内嵌副本才不会退化成空白图位)。
// 换图(改上面的几何/颜色)后,把下面这串整段粘回 tray-icon.ts 的 TRAY_ICON_PNG_BASE64。
console.log('');
console.log('[make-tray-icon] 请把下面这串粘回 desktop/src/tray-icon.ts 的 TRAY_ICON_PNG_BASE64:');
console.log(png.toString('base64'));
