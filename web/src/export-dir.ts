// 「打开导出目录」与「打开成品所在目录」的**唯一**动作出口（spec D7/D8/D11）：
// 工具栏按钮、成品行图标共用它，避免多处各写一份"取目录 + 调桥 + 报错"。
import { getSettings, logFe } from '@/api';
import { hasDesktopBridge, revealPath } from './desktop';

/** 让系统打开一个**目录**：无桥 → 可展示的 message（不静默）；打开失败 → 收敛成 { ok:false, message } 并留痕。
 *  ⚠️ 桌面桥的 reveal-path 只接受目录（主进程校验 isDirectory()），所以调用方必须传目录、不能传文件路径。 */
export async function revealDir(dir: string): Promise<{ ok: boolean; message?: string }> {
  if (!hasDesktopBridge()) return { ok: false, message: '仅桌面应用内可用' };
  try {
    const r = await revealPath(dir);
    logFe(r.ok ? 'info' : 'error', `打开目录 ${dir} → ${r.ok ? 'ok' : (r.message ?? '失败')}`);
    return r;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logFe('error', `打开目录失败: ${message}`);
    return { ok: false, message };
  }
}

/** 取实际生效的导出目录（output_dir_resolved，由服务端算好）再交给系统打开。 */
export async function openExportDir(): Promise<{ ok: boolean; dir: string; message?: string }> {
  if (!hasDesktopBridge()) return { ok: false, dir: '', message: '仅桌面应用内可用' };
  let dir = '';
  try {
    const s = await getSettings();
    dir = s.output_dir_resolved ?? '';
    if (dir === '') return { ok: false, dir, message: '拿不到导出目录' };
    const r = await revealDir(dir);
    return { ok: r.ok, dir, message: r.message };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logFe('error', `打开导出目录失败: ${message}`);
    return { ok: false, dir, message };
  }
}
