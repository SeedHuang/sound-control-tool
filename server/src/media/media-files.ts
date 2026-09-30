// server/src/media/media-files.ts
// 视频素材在磁盘上的落盘/删除(spec m1c-video-clip §0.4)。
// 覆盖语义集中在这里,路由层与 finalize 都只调它 —— 散开写必然出现"这里清了旧图、那里忘了"。
import { existsSync, mkdirSync, readdirSync, renameSync, unlinkSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pushLog } from '../logs.js';

/** 素材文件名前缀:一个来源一份,重下即覆盖 */
function prefixOf(importId: number): string { return `media-${importId}.`; }

/** 该来源名下现有的素材文件(可能多个扩展名) */
export function findVideoFiles(mediaDir: string, importId: number): string[] {
  try {
    return readdirSync(mediaDir).filter((f) => f.startsWith(prefixOf(importId))).sort().map((f) => join(mediaDir, f));
  } catch {
    return []; // 目录还没建过 → 没有素材,不算错
  }
}

/** 单份素材路径(取排序第一个);没有 → null */
export function findVideoFile(mediaDir: string, importId: number): string | null {
  return findVideoFiles(mediaDir, importId)[0] ?? null;
}

export type PlaceResult = { ok: true; path: string } | { ok: false; reason: 'busy' | 'io'; message: string };

/** registeredPath 是否真的是 mediaDir 下、由本工具 join 出来的名字(防路径逃逸:拼出来的才许删) */
function isOwnMediaPath(mediaDir: string, p: string): boolean {
  return join(mediaDir, basename(p)) === p;
}

/**
 * 把刚下好的临时视频搬进素材目录。
 * 关键点(spec §0.4 + D15,fix R6):
 * 1. 规范名 media-<id>.<ext> 已被占用、但不是该来源当前登记的 file_path → 那是**用户手工放的文件**,
 *    改用序号名,绝不覆盖;序号查找途中撞上我们登记的旧文件 → 允许覆盖它(重下落回自己名下)
 * 2. rename 失败(Windows 上文件被 <video>/ffmpeg 占用 → EPERM/EBUSY/EACCES)= **本体失败**,必须报错。
 *    静默失败最坏:用户以为换了清晰度,其实还是旧的
 * 3. 落盘成功后只清"登记过的那个旧文件"(换扩展名 webm→mp4 不留残骸)。
 *    **绝不按前缀扫删** —— media-<id>. 前缀下可能有用户手工文件,扫删就是不可逆数据丢失(D15)
 */
export function placeVideo(opts: {
  tmpPath: string; mediaDir: string; importId: number; ext: string;
  /** 该 importId 当前在 source_videos 登记的 file_path;null = 从未登记过 */
  registeredPath: string | null; exists?: (p: string) => boolean; rename?: (from: string, to: string) => void;
}): PlaceResult {
  const exists = opts.exists ?? existsSync;
  const doRename = opts.rename ?? renameSync;
  const prefix = prefixOf(opts.importId);
  try {
    mkdirSync(opts.mediaDir, { recursive: true });
  } catch { /* 建不出来让下面的 rename 自己报错 */ }
  let dest = join(opts.mediaDir, `${prefix}${opts.ext}`);
  if (exists(dest) && dest !== opts.registeredPath) {
    // D15:规范名不是我们登记的那个 → 只准另起序号名。n 递增途中命中登记的旧文件则停在它上面(覆盖自己的产物)
    let n = 2;
    let candidate = join(opts.mediaDir, `${prefix}${n}.${opts.ext}`);
    while (exists(candidate) && candidate !== opts.registeredPath) {
      n += 1;
      candidate = join(opts.mediaDir, `${prefix}${n}.${opts.ext}`);
    }
    dest = candidate;
    if (dest !== opts.registeredPath) {
      pushLog('info', 'media', `目标已存在且非本工具登记文件,改用序号名 import=${opts.importId} dest=${dest}`);
    }
  }
  try {
    doRename(opts.tmpPath, dest);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    const busy = err.code === 'EPERM' || err.code === 'EBUSY' || err.code === 'EACCES';
    pushLog('error', 'media', `素材落盘失败 import=${opts.importId} code=${err.code ?? '?'} dest=${dest} kind=${busy ? 'busy' : 'io'}`);
    return busy
      ? { ok: false, reason: 'busy', message: '该视频正在被播放/处理，请先关闭预览再重试' }
      : { ok: false, reason: 'io', message: `素材落盘失败（${err.code ?? '未知错误'}）` };
  }
  // 清旧:只删登记过的那一个文件。失败只记日志 —— 这是"删附属",不影响本体(spec §0.4 第 4 条)
  const registered = opts.registeredPath;
  if (registered !== null && registered !== dest && isOwnMediaPath(opts.mediaDir, registered)) {
    try {
      unlinkSync(registered);
      pushLog('info', 'media', `清掉旧素材 import=${opts.importId} path=${registered}`);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') {
        // 已经不在了 → 与 deleteVideoFiles「ENOENT 算删掉」同口径,降为 info(批4 Minor:不该记 error)
        pushLog('info', 'media', `清旧素材:文件已不在(ENOENT) import=${opts.importId} path=${registered}`);
      } else {
        pushLog('error', 'media', `清旧素材失败 import=${opts.importId} path=${registered}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  return { ok: true, path: dest };
}

/** 删该来源的素材文件。删不掉只记日志(与 DELETE /api/audio/:id 同款语义:DB 行删了就算"删了") */
export function deleteVideoFiles(mediaDir: string, importId: number): { deleted: string[]; failed: string[] } {
  const deleted: string[] = [];
  const failed: string[] = [];
  for (const full of findVideoFiles(mediaDir, importId)) {
    try {
      unlinkSync(full);
      deleted.push(full);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') continue; // 已经不在了 → 等价于删掉了
      failed.push(full);
      pushLog('error', 'media', `删素材失败 import=${importId} path=${full} code=${err.code ?? '?'}`);
    }
  }
  return { deleted, failed };
}
