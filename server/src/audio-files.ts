// server/src/audio-files.ts
// 2026-09-29 新增:DELETE /api/audio/:id 用——按 DB 记录删磁盘文件
// 设计原则:
// 1. 文件缺失(ENOENT)不算错,只 log info——DB 行已删就够了,不要让接口因磁盘抖动失败
// 2. 其它 unlink 错误(权限等)log warn 也不 throw——DB 已删就是用户期望的"删了"语义
// 3. 路径从 repo.get(id).file_path 读,绝不在路由层手写路径拼接
import { unlinkSync } from 'node:fs';
import type { AudioItemsRepo } from './db/repo/audio-items.js';
import { pushLog } from './logs.js';

export function deleteAudioFile(audioId: number, audioRepo: AudioItemsRepo): { deleted: boolean; path: string | null } {
  const row = audioRepo.get(audioId);
  if (!row) return { deleted: false, path: null }; // 行不存在 → 无文件可删,记一笔
  try {
    unlinkSync(row.file_path);
    pushLog('info', 'audio.delete', `id=${audioId} unlinked=${row.file_path}`);
    return { deleted: true, path: row.file_path };
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') {
      pushLog('info', 'audio.delete', `id=${audioId} missing=${row.file_path} (DB 行删除照常进行)`);
      return { deleted: false, path: row.file_path };
    }
    pushLog('info', 'audio.delete', `id=${audioId} unlink-fail code=${e.code ?? '?'} path=${row.file_path} (DB 行删除照常进行)`);
    return { deleted: false, path: row.file_path };
  }
}