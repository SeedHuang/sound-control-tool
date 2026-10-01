// 「打开导出目录」的**唯一**动作（spec D7/D8/D11）：工具栏按钮与导出成功绿条里的按钮共用它，
// 避免两处各写一份"取目录 + 调桥 + 报错"。
import { getSettings, logFe } from '@/api';
import { hasDesktopBridge, revealPath } from './desktop';

/** 取实际生效的导出目录（output_dir_resolved，由服务端算好）再交给系统打开。
 *  无桥 → 直接失败（不静默）；拿不到目录/打开失败 → 都收敛成 { ok:false, message } 并留 logFe。 */
export async function openExportDir(): Promise<{ ok: boolean; dir: string; message?: string }> {
  if (!hasDesktopBridge()) return { ok: false, dir: '', message: '仅桌面应用内可用' };
  let dir = '';
  try {
    const s = await getSettings();
    dir = s.output_dir_resolved ?? '';
    if (dir === '') return { ok: false, dir, message: '拿不到导出目录' };
    const r = await revealPath(dir);
    logFe(r.ok ? 'info' : 'error', `打开导出目录 ${dir} → ${r.ok ? 'ok' : (r.message ?? '失败')}`);
    return { ok: r.ok, dir, message: r.message };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logFe('error', `打开导出目录失败: ${message}`);
    return { ok: false, dir, message };
  }
}
