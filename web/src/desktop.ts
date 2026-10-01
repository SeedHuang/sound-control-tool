// 桌面壳桥接的**唯一**出入口（spec D7/D8）：别处不许直接摸 window.sct——
// 这样"没有 Electron 时怎么办"只在一处回答（浏览器直连模式下 window.sct 为 undefined）。
import { logFe } from '@/api';

interface SctBridge {
  revealPath(absolutePath: string): Promise<{ ok: boolean; message?: string }>;
  pickDirectory(): Promise<string | null>;
  /** 托盘「显示下载器」的订阅入口(spec D14);返回取消订阅函数 */
  onOpenDownloader(cb: () => void): () => void;
}
declare global {
  interface Window { sct?: SctBridge }
}

/** 桥是否存在（而非"窗口是否存在"）：只认 pickDirectory 是可调用的函数，
 *  浏览器直连模式下 window.sct 为 undefined → 一律返回 false，调用方据此禁用按钮。 */
export function hasDesktopBridge(): boolean {
  return typeof window !== 'undefined' && typeof window.sct?.pickDirectory === 'function';
}

/** 调原生目录选择器；无桥/异常都返回 null（异常写 logFe，不静默）。 */
export async function pickDirectory(): Promise<string | null> {
  if (!hasDesktopBridge()) return null;
  try {
    return await window.sct!.pickDirectory();
  } catch (e) {
    logFe('error', `pickDirectory 失败: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/** 让系统打开该目录；无桥返回可展示的 message（而不是抛错），异常同样收敛成失败对象。 */
export async function revealPath(p: string): Promise<{ ok: boolean; message?: string }> {
  if (!hasDesktopBridge()) return { ok: false, message: '仅桌面应用内可用' };
  try {
    return await window.sct!.revealPath(p);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logFe('error', `revealPath 失败: ${message}`);
    return { ok: false, message };
  }
}

/** 订阅"打开下载器"事件（托盘菜单触发，spec D14）。
 *  无桥（浏览器直连）返回一个**空的取消订阅函数**——调用方不必写分支，也不抛异常。
 *  订阅本身失败同样降级成空函数并 logFe（不静默），返回值恒可用于 cleanup。 */
export function onOpenDownloader(cb: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.sct?.onOpenDownloader !== 'function') return () => {};
  try {
    return window.sct.onOpenDownloader(cb);
  } catch (e) {
    logFe('error', `订阅打开下载器失败: ${e instanceof Error ? e.message : String(e)}`);
    return () => {};
  }
}
