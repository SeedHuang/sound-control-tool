// S1 无任何 IPC（spec D7）；本切片新增第一条：导出目录相关（spec D7）。
// 只暴露两个**能力**，不暴露任意路径执行——渲染进程给的是"要打开的目录"，校验在主进程做。
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('sct', {
  revealPath: (absolutePath: string): Promise<{ ok: boolean; message?: string }> =>
    ipcRenderer.invoke('sct:reveal-path', absolutePath),
  pickDirectory: (): Promise<string | null> => ipcRenderer.invoke('sct:pick-directory'),
  // 托盘「显示下载器」→ 渲染进程(spec D14/§0.3)。方向是本进程 ← 主进程"推"事件,
  // 所以只能是 ipcRenderer.on 订阅、返回取消订阅函数(不是 invoke——没有返回值可拿)。
  onOpenDownloader: (cb: () => void): (() => void) => {
    const h = (): void => cb();
    ipcRenderer.on('sct:open-downloader', h);
    return () => ipcRenderer.removeListener('sct:open-downloader', h);
  },
});
