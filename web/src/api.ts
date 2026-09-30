/** D3 唯一解析点:URL ?apiPort= 优先,非法或缺省回退 7310(浏览器独立开发场景) */
export function apiPort(): number {
  const raw = new URLSearchParams(window.location.search).get('apiPort');
  const n = raw ? Number(raw) : NaN;
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : 7310;
}

/** D12:URL ?apiToken=;缺失返回 null(浏览器独立开发时从 .sct/dev-port 读取后手填) */
export function apiToken(): string | null {
  const raw = new URLSearchParams(window.location.search).get('apiToken');
  return raw && raw.length > 0 ? raw : null;
}

export const API_BASE = `http://127.0.0.1:${apiPort()}`;

/** 业务错误:code 是后端 error.code(BAD_REQUEST/CONFLICT/INVALID_COOKIE/...),前端按 code 分支(如 CONFLICT → 覆盖确认弹窗) */
export class ApiError extends Error {
  constructor(message: string, public code?: string) { super(message); }
}

// ---- 诊断日志(2026-09-29 用户反馈:一个按钮看前后端日志) ----
// 前端环形缓冲(容量 200,丢最旧):api.ts 是唯一埋点点位,页面组件不感知。
export interface LogRow { ts: string; level: 'debug' | 'info' | 'error'; source: string; message: string }
const feLogs: LogRow[] = [];
const FE_LOG_CAP = 200;

// 上报通道:直连 fetch(不走 apiPost)——apiPost 失败时会调 logFe 记错误,若上报失败也走它会造成"失败→记日志→再上报→再失败"自旋。
function shipLogToBackend(level: LogRow['level'], message: string): void {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const token = apiToken();
  if (token) headers['x-sct-token'] = token;
  void fetch(`${API_BASE}/api/logs`, { method: 'POST', headers, body: JSON.stringify({ level, message }) }).catch(() => {
    /* 上报失败静默:本地缓冲仍在;server 没起时不刷屏不递归 */
  });
}

export function logFe(level: LogRow['level'], message: string): void {
  feLogs.push({ ts: new Date().toISOString(), level, source: 'web', message });
  if (feLogs.length > FE_LOG_CAP) feLogs.splice(0, feLogs.length - FE_LOG_CAP);
  shipLogToBackend(level, message); // 2026-09-29 用户拍板:前端所有操作日志同步上报后端,统一系统可查"当时发生了什么"
}

export function getFeLogs(): LogRow[] {
  return [...feLogs]; // 拷贝,防调用方直接改内部缓冲
}

/** 拉取后端诊断日志(GET /api/logs,环形缓冲最近 500 条) */
export async function fetchLogs(): Promise<LogRow[]> {
  const j = await apiGet<{ ok: boolean; logs: LogRow[] }>('/api/logs');
  return j.logs;
}

// ---- 剪辑室数据变更通知(2026-09-29 用户反馈:下载结束后切到剪辑室看不到刚下的文件) ----
// 真相:切页那一刻列表确实拉了,但后端「rename + ffprobe 测时长 + INSERT」还没跑完(实测差了 4 秒),
// 之后页面就不再刷新了 → 用户看到的是旧列表。这里放一个极小的进程内事件总线:
// 谁写完剪辑室数据就喊一声,剪辑室页订阅后自己重拉列表(页面开着也能立刻看到新条目)。
// 喊的时候若剪辑室页没打开,通知丢失也无妨——它每次挂载都会自己拉一次。
export type AudioChangedHandler = () => void;
const audioChangedHandlers = new Set<AudioChangedHandler>();
export function notifyAudioChanged(reason: string): void {
  logFe('info', `通知剪辑室刷新(${reason})`); // 诊断日志:日志页能看清"是谁触发的那次刷新"
  for (const fn of [...audioChangedHandlers]) fn();
}
export function onAudioChanged(fn: AudioChangedHandler): () => void {
  audioChangedHandlers.add(fn);
  return () => { audioChangedHandlers.delete(fn); };
}

export async function apiGet<T>(path: string): Promise<T> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 10_000);
  let res: Response;
  try {
    const headers: Record<string, string> = {};
    const token = apiToken();
    if (token) headers['x-sct-token'] = token; // D12:受保护路由要求 token
    res = await fetch(`${API_BASE}${path}`, { headers, signal: ctl.signal });
  } catch (err) {
    logFe('error', `请求失败 ${path}: ${err instanceof Error ? err.message : '网络错误'}`); // 诊断日志:连不上也要在面板可见
    throw new ApiError(`无法连接本地服务(apiPort=${apiPort()})。请确认 server 进程已启动(pnpm dev:server)。`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    logFe('error', `请求失败 ${path}: ${res.status}`); // 诊断日志:HTTP 非 2xx 留痕
    throw new ApiError(`请求失败 ${res.status}:${path}`);
  }
  // 非 JSON 响应(HTML 错误页/代理页)不再是裸 SyntaxError,统一包装为 ApiError
  try {
    return (await res.json()) as T;
  } catch {
    logFe('error', `请求失败 ${path}: 响应不是合法 JSON`); // 诊断日志:代理页/错误页留痕
    throw new ApiError(`响应不是合法 JSON:${path}`);
  }
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const token = apiToken();
  if (token) headers['x-sct-token'] = token;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 10_000);
  try {
    const res = await fetch(`${API_BASE}${path}`, { method: 'POST', headers, body: JSON.stringify(body), signal: ctl.signal });
    if (!res.ok) {
      const j = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string; next?: string } } | null;
      const msg = j?.error?.message ?? `请求失败 ${res.status}:${path}${j?.error?.next ? `。${j.error.next}` : ''}`;
      logFe('error', `请求失败 ${path}: ${msg}`); // 诊断日志:业务错误(400/409)也进前端面板
      // code 要带上:调用方按 code 分支(如 DUPLICATE → 弹「重新下载并替换」确认,2026-09-29)
      throw new ApiError(msg, j?.error?.code);
    }
    return (await res.json()) as T;
  } finally { clearTimeout(timer); }
}

// spec §0.3 接口契约:parse 返回 kind/title/duration_sec/entries/existing;2026-09-29 增 import_id(解析成功自动落库的来源行 id)
export interface ParseResponse {
  ok: boolean; kind: 'single' | 'playlist'; title: string; duration_sec?: number;
  entries?: { index: number; title: string }[];
  existing?: { audioId: number; title: string };
  import_id?: number;
}
export interface DownloadPayload {
  url: string;
  title?: string;
  durationSec?: number;
  entryIndex?: number;      // 合集第几集(1 起);单视频不传(2026-09-29 用户拍板:剪辑室要显示第几集)
  collectionTitle?: string; // 所属合集标题;单视频不传
  options: { entryIndices?: number[]; section?: { start: number; end: number }; videoHeight?: 360 | 480 | 720 | 1080; format: 'mp3' | 'm4a' | 'wav'; quality?: string; force?: boolean };
  produce?: 'audio' | 'video'; // 产物类型(2026-09-29 spec m1c-video-clip):video=下完整视频素材(带音轨),缺省 audio=抽音轨
}

export async function parseUrl(url: string): Promise<ParseResponse> {
  const r = await apiPost<ParseResponse>('/api/ytdlp/parse', { url });
  logFe('info', `解析成功 ${r.kind}`); // 诊断日志:解析结果留痕(合集条目数在 message 外,面板看 kind 即可定位)
  return r;
}

export async function startDownload(payload: DownloadPayload): Promise<{ ok: boolean; jobId: number }> {
  const r = await apiPost<{ ok: boolean; jobId: number }>('/api/ytdlp/download', payload);
  logFe('info', `下载已提交 jobId=${r.jobId}`); // 诊断日志:提交留痕,与后端 job created 行可对账
  return r;
}

// ---- 视频素材(2026-09-29 spec m1c-video-clip:视频当"带画面的时间标尺",只用于定位,不进剪辑室) ----
export interface MediaItem {
  import_id: number; url: string; title: string; site: string;
  entry_index: number | null;     // 合集第几集(1 起);单视频素材 → null(2026-09-30 P2:资料库单选一集下载/D19 默认选中用)
  height: number | null;          // 下载时选的档位(不是实测分辨率)
  file_size: number | null;
  created_at: string;
}

export async function listMedia(): Promise<MediaItem[]> {
  const r = await apiGet<{ ok: boolean; media: MediaItem[] }>('/api/media');
  return r.media;
}

/** 素材视频流地址:<video> 走 Range 请求,和 audioFileUrl 同款(query token) */
export function mediaFileUrl(importId: number): string {
  const token = apiToken();
  logFe('debug', `mediaFileUrl import=${importId} token=${token ? 'query' : 'none'}`);
  return `${API_BASE}/api/media/${importId}/file?token=${encodeURIComponent(token ?? '')}`;
}

export async function deleteMedia(importId: number): Promise<{ ok: boolean; deleted: number }> {
  logFe('info', `deleteMedia import=${importId}`);
  return apiDelete<{ ok: boolean; deleted: number }>(`/api/media/${importId}`);
}

export async function clipMedia(
  importId: number,
  payload: { start: number; end: number; format: 'mp3' | 'm4a' | 'wav'; quality?: string; title?: string },
): Promise<{ ok: boolean; jobId: number }> {
  logFe('info', `clipMedia import=${importId} ${payload.start}-${payload.end}s format=${payload.format}`);
  return apiPost<{ ok: boolean; jobId: number }>(`/api/media/${importId}/clip`, payload);
}

export async function cancelJob(jobId: number): Promise<{ ok: boolean }> {
  // 诊断日志:用户操作关键按钮也要落痕(否则面板只有后端 job cancelled,看不到"前端触发"那一下)
  logFe('info', `cancelJob jobId=${jobId}`);
  return apiPost<{ ok: boolean }>(`/api/jobs/${jobId}/cancel`, {});
}

export async function retryJob(jobId: number): Promise<{ ok: boolean; jobId: number }> {
  // 诊断日志:重试是「明知会失败仍提交」的高风险操作,前端必须留痕便于与后端对账
  logFe('info', `retryJob jobId=${jobId}`);
  const r = await apiPost<{ ok: boolean; jobId: number }>(`/api/jobs/${jobId}/retry`, {});
  logFe('info', `retryJob jobId=${jobId} → newJobId=${r.jobId}`);
  return r;
}

export async function listAudio(): Promise<AudioRow[]> {
  return apiGet<AudioRow[]>('/api/audio');
}
export interface AudioRow {
  id: number; title: string; source_type: string; format: string; duration_sec: number | null; created_at: string;
  source_url: string | null;      // 原视频地址(后端返回;剪辑室展示 + 可点开)
  site: string;                   // 平台标识(bilibili/youtube/other,后端由 source_url 反查)→ 剪辑室显示 logo
  entry_index: number | null;     // 合集第几集;单视频/录制 → null
  collection_title: string | null; // 所属合集标题;非合集 → null
}

export function audioFileUrl(id: number): string {
  const token = apiToken();
  // 诊断日志:记下 audio 标签请求 URL(去 token 尾段,凭据不全打)+ token 来源(query/无),
  // CORS 排查时一眼看清「这次 audio 请求有没有带 token」「origin 该不该让服务器放行」
  const src = token ? 'query' : 'none';
  // 级别 debug(2026-09-29):每个 <audio> 元素渲染都会调它,一屏十几条 —— 只在排查 CORS/token 时才想看,
  // 归到「调试」档,日志面板默认折叠,需要时一键展开
  logFe('debug', `audioFileUrl id=${id} token=${src}`);
  return `${API_BASE}/api/audio/${id}/file?token=${encodeURIComponent(token ?? '')}`;
}

/** 作品封面地址(2026-09-29):图片本体由服务端落到本地(covers/),不直连外网图床,断网/防盗链都不怕。
 *  这里**不写日志**——一屏十几张卡片,每张都 logFe 会把日志面板刷爆(封面请求本身也不值得逐条记)。 */
export function coverUrl(importId: number): string {
  const token = apiToken();
  return `${API_BASE}/api/imports/${importId}/cover?token=${encodeURIComponent(token ?? '')}`;
}

/** done 事件联合类型(spec m1c-video-clip):audio=进剪辑室(下载与剪辑共用;旧下载事件无 kind 字段 → 按缺省 audio 读);
 *  video=视频素材就位(importId 即来源 id,拿它拼 /api/media/:id/file 流地址;fileSize 为素材字节数) */
export type DoneEvent =
  | { kind?: 'audio'; audioId: number; title: string; format: string; replaced?: boolean }
  | { kind: 'video'; importId: number; title: string; filePath: string; height: number | null; fileSize: number };

export function subscribeJob(jobId: number, handlers: {
  onProgress?: (p: { percent: number }) => void;
  onPhase?: (p: { phase: 'ingest' }) => void; // 阶段信号(2026-09-29):下载进程结束、开始入库 → 进度条切第二段
  onDone?: (d: DoneEvent) => void; // replaced:本次是覆盖下载(旧的那份已删);kind==='video' 为视频素材分支
  onStatus?: (s: { state: string; message?: string }) => void;
  onError?: (msg: string) => void;
}): () => void {
  const token = apiToken();
  const es = new EventSource(`${API_BASE}/api/jobs/${jobId}/events?token=${encodeURIComponent(token ?? '')}`);
  es.addEventListener('progress', (e) => handlers.onProgress?.(JSON.parse((e as MessageEvent).data)));
  es.addEventListener('phase', (e) => handlers.onPhase?.(JSON.parse((e as MessageEvent).data)));
  es.addEventListener('done', (e) => handlers.onDone?.(JSON.parse((e as MessageEvent).data)));
  es.addEventListener('status', (e) => {
    const s = JSON.parse((e as MessageEvent).data) as { state: string; message?: string };
    handlers.onStatus?.(s);
    if (s.state === 'error' || s.state === 'cancelled') { handlers.onError?.(s.message ?? s.state); es.close(); }
    if (s.state === 'done') es.close();
  });
  es.onerror = () => {
    logFe('error', 'SSE 连接中断'); // 诊断日志:SSE 断连是跨进程问题高发点(CORS 缺头修复前也在这里现形)
    handlers.onError?.('连接中断');
    es.close();
  };
  return () => es.close();
}

// ---- B 站 Cookie(2026-09-29 用户拍板):设置页粘贴 → PUT /api/cookie → server 保存 → yt-dlp --cookies 注入 ----
// 2026-09-29 增:server 保存时双重校验(SESSDATA 结构 + B 站 nav 在线验登录);已有未过期登录信息 → 409 CONFLICT
export interface CookieStatus {
  ok: boolean; set: boolean; length: number;
  count: number;                 // 解析出的 cookie 条数
  sessdataExpiry: number | null; // SESSDATA 过期 unix 秒(无登录凭据 → null)
  expired: boolean | null;       // null = 无法判定(无 SESSDATA)
}
export interface CookieSaveResult { ok: boolean; count: number; verified: boolean; uname: string | null }

/** PUT 语义(与 apiPost 同款错误处理;/api/cookie 等写接口用) */
export async function apiPut<T>(path: string, body: unknown): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const token = apiToken();
  if (token) headers['x-sct-token'] = token;
  const res = await fetch(`${API_BASE}${path}`, { method: 'PUT', headers, body: JSON.stringify(body) });
  if (!res.ok) {
    const j = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string; next?: string } } | null;
    const msg = j?.error?.message ?? `请求失败 ${res.status}:${path}${j?.error?.next ? `。${j.error.next}` : ''}`;
    logFe('error', `请求失败 ${path}: ${msg}`); // 诊断日志:业务错误(400/409)也进前端面板
    throw new ApiError(msg, j?.error?.code);
  }
  return (await res.json()) as T;
}

/** GET /api/cookie:只回元数据(count/有效期);Cookie 内容永不回传 UI(server 端键不在 settings 白名单) */
export function getCookieStatus(): Promise<CookieStatus> {
  return apiGet<CookieStatus>('/api/cookie');
}

/** PUT /api/cookie:保存 Cookie(服务端结构+在线双重校验);409 CONFLICT = 已有未过期登录信息,需 force=true 覆盖 */
export async function saveCookie(content: string, force = false): Promise<CookieSaveResult> {
  // 诊断日志:Cookie 是凭据操作,记长度不记全文(凭据不出日志)
  logFe('info', `saveCookie length=${content.length}${force ? ' force' : ''}`);
  const r = await apiPut<CookieSaveResult>('/api/cookie', { content, force });
  logFe('info', `saveCookie ok count=${r.count} verified=${r.verified}`);
  return r;
}

// ---- 音频删除(2026-09-29 用户拍板):audio list 每行删除按钮 → DELETE /api/audio/:id ----
/** DELETE 语义:无 body(与 apiPut/apiPost 共用 ApiError + logFe) */
export async function apiDelete<T>(path: string): Promise<T> {
  const headers: Record<string, string> = {};
  const token = apiToken();
  if (token) headers['x-sct-token'] = token;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 10_000);
  try {
    const res = await fetch(`${API_BASE}${path}`, { method: 'DELETE', headers, signal: ctl.signal });
    if (!res.ok) {
      const j = (await res.json().catch(() => null)) as { error?: { message?: string; next?: string } } | null;
      const msg = j?.error?.message ?? `请求失败 ${res.status}:${path}${j?.error?.next ? `。${j.error.next}` : ''}`;
      logFe('error', `请求失败 ${path}: ${msg}`);
      throw new ApiError(msg);
    }
    return (await res.json()) as T;
  } finally { clearTimeout(timer); }
}

/** 删除音频:返回后端 { ok, deleted } —— deleted 表示磁盘文件是否真删掉(缺文件时为 false,但接口仍 200) */
export async function deleteAudio(audioId: number): Promise<{ ok: boolean; deleted: boolean }> {
  // 诊断日志:删除是不可逆操作,前后端都要记。deleted=false 不是错误(后端会 log 说明文件缺失)
  logFe('info', `deleteAudio id=${audioId}`);
  const r = await apiDelete<{ ok: boolean; deleted: boolean }>(`/api/audio/${audioId}`);
  logFe('info', `deleteAudio id=${audioId} deleted=${r.deleted}`);
  return r;
}

// ---- 导入来源(2026-09-29 用户拍板:parse 成功自动落库,资料库左列表持久化) ----
// 注意(2026-09-29 评审修):服务端 /api/imports 还会回 thumbnail / has_cover,前端**刻意不声明、不使用** ——
// 卡片渲不渲染 <img> 不看 has_cover(那样"还没抓过图"的来源就永远没机会触发服务端抓取),
// 而是有来源记录就渲染、取不到由 onError 回退纯色卡片(见 studio.tsx 的 WorkCard)。将来要用再加回契约。
export interface ImportSource {
  id: number; url: string; title: string; site: string; kind: 'single' | 'playlist';
  entry_count: number; created_at: string;
  has_video: boolean;             // 该来源已登记视频素材(2026-09-30 P2 对齐服务端 /api/imports)
  has_project: boolean;           // 已有剪辑工程(2026-09-30 P2 对齐服务端)
  segment_count: number;          // 已保存剪辑点数(D19 替换确认文案的条件句用)
}
export interface ImportDetail extends Omit<ImportSource, 'entry_count'> { duration_sec: number | null; entries: { index: number; title: string }[] | null }

/** 左列表(新→旧;轻量,不带 entries) */
export async function listImports(): Promise<ImportSource[]> {
  const r = await apiGet<{ ok: boolean; imports: ImportSource[] }>('/api/imports');
  return r.imports;
}

/** 来源详情(含集数缓存——点左列表秒开,不重新解析) */
export async function getImport(id: number): Promise<ImportDetail> {
  const r = await apiGet<{ ok: boolean; import: ImportDetail }>(`/api/imports/${id}`);
  return r.import;
}

/** 删除左列表条目(不影响已下载音频) */
export async function deleteImport(id: number): Promise<void> {
  logFe('info', `deleteImport id=${id}`);
  await apiDelete(`/api/imports/${id}`);
}

// ---- 日志清空(2026-09-29 用户拍板:日志要可删除) ----
/** DELETE /api/logs[?day=]:清空后端内存日志 + 删除落盘文件;day=YYYY-MM-DD 只清该天,缺省全清 */
export async function clearServerLogs(day?: string): Promise<{ ok: boolean; clearedEntries: number; deletedFiles: string[]; failedFiles: string[] }> {
  logFe('info', `clearServerLogs day=${day ?? '(all)'}`); // 本地缓冲也留痕
  return apiDelete(`/api/logs${day ? `?day=${encodeURIComponent(day)}` : ''}`);
}
