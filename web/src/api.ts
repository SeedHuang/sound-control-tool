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
  // status:HTTP 状态码(仅"服务端已回响应"的错误带;连不上/超时等本地错误为 undefined)。
  // 2026-10-01 追加"纯加字段"的原因:调用方要按"恰好 404"分支(如 getWork 判定作品不存在),
  // 而错误消息形如 `请求失败 ${status}:${path}`、path 里含作品 id —— 子串匹配会把 id=1404 的 500 误判成 404,
  // 所以把状态码单独挂出来,调用方判 err.status 即可,不再玩字符串。
  constructor(message: string, public code?: string, public status?: number) { super(message); }
}

/** 失败响应 → ApiError(apiPost / apiPut 共用,2026-10-02 从两处逐字相同的块里抽出来)。
 *  做三件事,顺序不能换:① 解析后端 `{ error: { code, message, next } }`(非 JSON/HTML 错误页也要兜住,不能抛裸 SyntaxError)
 *  ② 把 `error.next`——「下一步怎么办」的指引(spec §0.5)——拼进展示消息;③ 记一条前端日志后抛。
 *  为什么要抽:两处原本各自用 `??` 短路(只在 message 缺失时才拼 next),而 POST/PUT 的每一条业务错误都恒带 message
 *  → next 一次都到不了用户(2026-10-02 修)。同一段拼接过一次错就该只留一份,不然下次改一处忘了另一处。
 *  !base.includes 防同一句被拼两遍;空 next 不加「（）」尾巴;code 传给调用方按业务分支(CONFLICT → 覆盖确认弹窗)。 */
async function throwApiError(res: Response, path: string): Promise<never> {
  const j = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string; next?: string } } | null;
  const errBody = j?.error;
  const base = errBody?.message ?? `请求失败 ${res.status}:${path}`;
  const next = typeof errBody?.next === 'string' && errBody.next.trim() !== '' && !base.includes(errBody.next) ? errBody.next : '';
  const msg = next === '' ? base : `${base}（${next}）`;
  logFe('error', `请求失败 ${path}: ${msg}`); // 诊断日志:业务错误(400/409)也进前端面板
  throw new ApiError(msg, errBody?.code, res.status); // 追加真实状态码(纯加字段,调用方可不看)
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

/** timeoutMs 可选:默认仍是 10s(其它调用方行为不变);探测类慢接口可显式调大——见 getFormats:
 *  服务端探测超时是 15s,客户端若仍用 10s 会先 abort,慢视频明明服务端能探到却只看到降级四档 */
export async function apiGet<T>(path: string, timeoutMs = 10_000): Promise<T> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
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
    throw new ApiError(`请求失败 ${res.status}:${path}`, undefined, res.status); // 带上真实状态码,调用方按 err.status 判(不再子串匹配 message)
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
    // 业务错误(400/409)的解析、next 拼接、logFe、抛 ApiError 全在 throwApiError 里(与 apiPut 共用一份)
    if (!res.ok) await throwApiError(res, path);
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
  // videoHeight(spec D10,Task 4):档位来自前端实测 → 可能是 1056/1440/2160 等任意整数,类型放宽为 number;
  // 服务端已补校验(整数 144..4320,越界 400),前端只负责把实测值原样传下去
  options: { entryIndices?: number[]; section?: { start: number; end: number }; videoHeight?: number; format: 'mp3' | 'm4a' | 'wav'; quality?: string; force?: boolean };
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

/** 派生图地址（P4）：固定 1600 宽的波形 / 胶片条，服务端 ffmpeg 生成并按素材缓存（<数据目录>/derived/，D14）。
 *  取图口径同 mediaFileUrl —— <img> 带不了 header，只能走 query token；
 *  rev 版本串由调用方拼：素材被替换后 URL 不变，靠 rev 变化 + 服务端 no-store 双保险避免拿到上一集的图。
 *  这里**不写日志**：一页两张图、每次渲染都会取地址，逐条 logFe 只会把日志面板刷爆。
 *
 *  Spec B（2026-10-03）之后的现状：
 *  - `filmstripUrl`（下面）**仍是现役**：L0 总览接管了它 —— URL、文件名 `film-<id>.png`、语义全都不变。
 *  - `filmSegUrl` / `wavePeakUrl` 是 Spec B 新增的（分段缩略图 / 波形峰值 JSON）。
 *  - `waveformUrl`（legacy 波形 PNG）**前端已无调用方** —— 波形改成 fetch 峰值 + Canvas 自绘了。
 *    路由与服务端文件都保留（混跑兼容：老页面/老缓存引用它时仍能拿到图），**不是死代码**。 */
export function waveformUrl(importId: number, rev: string | number): string {
  const token = apiToken();
  return `${API_BASE}/api/media/${importId}/waveform?token=${encodeURIComponent(token ?? '')}&rev=${encodeURIComponent(String(rev))}`;
}
export function filmstripUrl(importId: number, rev: string | number): string {
  const token = apiToken();
  return `${API_BASE}/api/media/${importId}/filmstrip?token=${encodeURIComponent(token ?? '')}&rev=${encodeURIComponent(String(rev))}`;
}
/** Spec B 分段雪碧图：level 1/2（128s / 24s 窗）+ 段号。取图口径同 filmstripUrl —— query token。
 *  rev 的作用同 filmstripUrl：素材换源后 URL 不变，靠 rev + 服务端 no-store 双保险避免拿到上一集的段图。 */
export function filmSegUrl(importId: number, level: 1 | 2, seg: number, rev: string | number): string {
  const token = apiToken();
  return `${API_BASE}/api/media/${importId}/filmseg?level=${level}&seg=${seg}&token=${encodeURIComponent(token ?? '')}&rev=${encodeURIComponent(String(rev))}`;
}
/** Spec B 波形峰值 JSON：level 0 = 整片一张（不带段号），1/2 = 分段（带段号）。
 *  **不用 <img>**：前端 fetch 后用 Canvas 自绘（放大后能看到局部疏密，这是 D2 的全部目的）。 */
export function wavePeakUrl(importId: number, level: 0 | 1 | 2, seg: number, rev: string | number): string {
  const token = apiToken();
  const segPart = level === 0 ? '' : `&seg=${seg}`;
  return `${API_BASE}/api/media/${importId}/wavepeak?level=${level}${segPart}&token=${encodeURIComponent(token ?? '')}&rev=${encodeURIComponent(String(rev))}`;
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

// ---- 剪辑作品 / 导出（2026-10-01 spec clip-works：旧「工程」语义整组改名「作品」）----
// 为什么改名:import_id 不再唯一——同一个资料可以有多件作品(1:N),「工程」这个词连同 1:1 的暗示一起丢掉,
// 统一叫「作品」,避免后面把「project 到底是资料还是作品」的歧义漏下去。
// 段:编辑期只有 start/end/label;服务端落库后才带 id/sort_order(PUT 按数组顺序定 sort_order)
export interface ClipSegmentDTO { id?: number; start_sec: number; end_sec: number; label?: string | null; sort_order?: number }
// 作品墙一张卡的数据(逐字对齐服务端 server/src/db/repo/clip-projects.ts 的 WorkSummaryRow)
export interface WorkSummaryDTO {
  id: number; import_id: number; name: string | null; updated_at: string;
  segment_count: number; product_count: number; total_sec: number;
  first_segment: { start_sec: number; end_sec: number } | null;
  source: { title: string; site: string; kind: string; has_video: boolean } | null; // null = 资料已删
  latest_product_id: number | null; // 最新一条成品的 id(hover 预览"只有音频的卡"要播它);没有成品 → null
  latest_product_kind: 'audio' | 'video' | null; // 最新一条成品的类型(逐字对齐 server WorkSummaryRow,2026-10-02 N1 T4):hover 预览按它分流 <audio>/<video>;没有成品 → null
}
export interface WorkDetailDTO { id: number; import_id: number; name: string | null; updated_at: string; segments: ClipSegmentDTO[] }

/** 作品列表（作品墙/首页复用）：后端 `{ ok, projects }`，键名仍是 projects，前端只按数组用 */
export function listWorks(): Promise<WorkSummaryDTO[]> {
  return apiGet<{ ok: boolean; projects: WorkSummaryDTO[] }>('/api/projects').then((r) => r.projects);
}
/** 新建作品（spec D15）：入参是**资料 id**，回新作品详情（含服务端定的默认名与空段） */
export function createWork(importId: number): Promise<WorkDetailDTO> {
  logFe('info', `createWork import=${importId}`);
  return apiPost<{ ok: boolean; project: WorkDetailDTO }>('/api/projects', { importId }).then((r) => r.project);
}
/** GET /api/projects/:id：作品不存在时后端回 404（NOT_FOUND）→ 这里收敛成 null（正常态，不是错误；见 T3 审查跨任务项）。
 *  其它错误（网络/500）照常抛出，不静默吞。 */
export async function getWork(projectId: number): Promise<WorkDetailDTO | null> {
  try {
    const r = await apiGet<{ ok: boolean; project: WorkDetailDTO }>(`/api/projects/${projectId}`);
    return r.project;
  } catch (err) {
    // 404 = 作品已被删除（后端 error.next 会写"该作品已被删除，无法保存"）。
    // 判据必须是"HTTP 状态码恰好等于 404"：apiGet 的错误消息形如 `请求失败 ${status}:${path}`，而 path 里含作品 id——
    // 作品 id 本身带 "404"(如 1404) 时，500/网络错误的消息也会命中子串 '404'，会被误判成"作品不存在"→
    // 静默吞掉真实错误 → 页面渲染成空编辑器（用户可能以为"这作品没剪辑点"而覆盖保存）。故改判 err.status（apiGet 已挂真实状态码）。
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}
/** PUT 全量替换（服务端包事务 D18）；返回保存后的作品（含服务端定的 sort_order 顺序） */
export function putWork(projectId: number, body: { name: string | null; segments: { start_sec: number; end_sec: number; label?: string | null }[] }): Promise<WorkDetailDTO> {
  logFe('info', `putWork project=${projectId} 段数=${body.segments.length}`);
  return apiPut<{ ok: boolean; project: WorkDetailDTO }>(`/api/projects/${projectId}`, body).then((r) => r.project);
}
/** DELETE 作品（幂等；连带删该作品的成品 DB 行 + 磁盘文件，不删素材本身）。deleted_products = 连带删掉的成品数 */
export function deleteWork(projectId: number): Promise<{ ok: boolean; deleted: number; deleted_products: number }> {
  logFe('info', `deleteWork project=${projectId}`);
  return apiDelete<{ ok: boolean; deleted: number; deleted_products: number }>(`/api/projects/${projectId}`);
}
/** 导出：segments 必传（D15，以请求体为准，不读 DB 作品、不自动保存）；起 job + 走 SSE 订阅进度。
 *  2026-10-02 N1(spec video-export):导出内容三选 → mediaKind('audio' 缺省/'video')+ videoAn(纯视频,仅 video 有意义);
 *  format 联合随之加 'mp4'(video 分支固定传,服务端校验 video 必为 mp4)。老调用不传 mediaKind → 服务端按 audio,零回归。 */
export function exportWork(projectId: number, body: { mode: 'separate' | 'merge'; format: 'mp3' | 'm4a' | 'wav' | 'mp4'; mediaKind?: 'audio' | 'video'; videoAn?: boolean; quality?: string; segments: { start_sec: number; end_sec: number; label?: string | null }[] }): Promise<{ ok: boolean; jobId: number }> {
  logFe('info', `exportWork project=${projectId} mode=${body.mode} format=${body.format} mediaKind=${body.mediaKind ?? 'audio'}${body.mediaKind === 'video' ? ` videoAn=${body.videoAn === true}` : ''} 段数=${body.segments.length}`);
  return apiPost<{ ok: boolean; jobId: number }>(`/api/projects/${projectId}/export`, body);
}
/** 某作品的成品列表（spec D17：GET /api/audio?project=<作品id> → 裸数组；过滤落在服务端）。
 *  成品 = source_type='edit' 且 source_work_id 指向该作品的行。 */
export function listProducts(projectId: number): Promise<AudioRow[]> {
  return apiGet<AudioRow[]>(`/api/audio?project=${projectId}`);
}
/** 剪辑室 hover 预览默认静音开关（spec clip-works D12）：读设置键，**键缺失视为静音**（默认 '1'）。 */
export async function getPreviewMuted(): Promise<boolean> {
  const s = await getSettings();
  return (s['studio_preview_muted'] ?? '1') !== '0';
}
/** 写静音开关：'1' = 静音（默认），'0' = 出声。putSettings 内部已记日志，这里再记一条"用户动作"便于面板对账。 */
export async function setPreviewMuted(muted: boolean): Promise<void> {
  logFe('info', `setPreviewMuted ${muted ? '静音' : '出声'}`);
  await putSettings({ studio_preview_muted: muted ? '1' : '0' });
}

// ---- 首页仪表盘(P5-T2,spec §0.3「其它」):GET /api/home → 两块 Top3 ----
// 形状逐字对齐后端 server/src/db/repo/home.ts 的 HomeEditingRow / HomeRecentRow。
// 注意:editing 的作品 id 字段叫 project_id(渲染子集),与 /api/projects 的 WorkSummaryRow 用 `id` 不同名——别混用。
export interface HomeEditingRow { import_id: number; project_id: number; name: string | null; site: string; updated_at: string; segment_count: number }
export interface HomeRecentRow { import_id: number; title: string; site: string; latest_audio_id: number; created_at: string }
export interface HomeData { editing: HomeEditingRow[]; recent: HomeRecentRow[] }

/** 首页数据(editing / recent 各最多 3 条;服务端已按来源去重、排除无来源条目) */
export function getHome(): Promise<HomeData> {
  return apiGet<{ ok: boolean; editing: HomeEditingRow[]; recent: HomeRecentRow[] }>('/api/home').then((r) => ({ editing: r.editing, recent: r.recent }));
}

// ---- 在途任务列表(spec download-queue-tray §0.3「新增：任务列表」,2026-09-30)----
// 抽屉与托盘都要「队列全貌」(D9/D11),而单任务 SSE 只盯一个 job,做不到。故新增这条轮询接口。
// 字段名/类型严格对齐服务端 server/src/media/jobs-routes.ts 的返回:不自己加字段、不改名。
export interface ActiveJob {
  id: number;
  kind: string;                                  // ytdlp_video / ytdlp_download / ffmpeg_clip / ffmpeg_export
  status: 'pending' | 'running';                 // pending = 排队中, running = 进行中
  progress: number;
  title: string;
  subtitle: string | null;                       // 合集才有的「第 N 集」,单视频为 null
  message: string | null;
  createdAt: string;
}
/** 下载批次分数(D16):口径由服务端统一,前端不各算一遍 */
export interface DownloadBatch { total: number; done: number; running: number; queued: number }

/** 在途任务(下载/剪辑/导出)+ 下载批次分数(spec D9/D16)。
 *  抽屉每 1s(在途非空)/ 5s(空闲)轮询它;失败由调用方 logFe + 抽屉内 Alert 呈现(D10)。 */
export function listActiveJobs(): Promise<{ ok: boolean; jobs: ActiveJob[]; downloads: DownloadBatch }> {
  return apiGet('/api/jobs?active=1');
}

export async function cancelJob(jobId: number): Promise<{ ok: boolean }> {
  // 诊断日志:用户操作关键按钮也要落痕(否则面板只有后端 job cancelled,看不到"前端触发"那一下)
  logFe('info', `cancelJob jobId=${jobId}`);
  return apiPost<{ ok: boolean }>(`/api/jobs/${jobId}/cancel`, {});
}

export interface AudioRow {
  id: number; title: string; source_type: string; format: string; duration_sec: number | null; created_at: string;
  source_url: string | null;      // 原视频地址(后端返回;剪辑室展示 + 可点开)
  site: string;                   // 平台标识(bilibili/youtube/other,后端由 source_url 反查)→ 剪辑室显示 logo
  entry_index: number | null;     // 合集第几集;单视频/录制 → null
  collection_title: string | null; // 所属合集标题;非合集 → null
  source_import_id: number | null; // 2026-10-01 spec audio-lineage D1:来源 id(无来源 → null);血缘/展示字段(剪辑室已按作品分卡,不再按它归并 —— spec clip-works)
  source_work_id: number | null;   // 2026-10-01 spec clip-works D4:成品归属的作品 id(指向 clip_projects.id);非成品 → null
  // 2026-10-02 N1(spec video-export):成品类型与分辨率。**可选** = 老服务端混跑兜底(字段缺失时使用处按 (p.media_kind ?? 'audio') 兜,spec D5.5)
  media_kind?: 'audio' | 'video';  // 展示层分流 <audio>/<video> 的唯一依据
  width?: number | null;           // 视频宽(像素);音频/未知 → null
  height?: number | null;          // 视频高(像素) → 成品行分辨率徽标(如 2160p)
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

/** done 事件联合类型(spec m1c-video-clip + 2026-10-02 N1):audio=音频成品就位(下载/剪辑/导出共用;旧事件无 kind 字段 → 按缺省 audio 读);
 *  video 有**两个来源**,字段不重叠 → 合并一个变体,除 kind/title 外全部可选:
 *   · 素材下载完成(m1c):importId 即来源 id,拿它拼 /api/media/:id/file 流地址;fileSize 为素材字节数
 *   · 视频**导出**完成(N1 T3,服务端 ffmpeg-export.ts):audioId 字段名刻意沿用 = 成品行 id(不破坏读法),format 恒 'mp4',
 *     count 语义同音频(separate=段数,merge=1)→ studio-detail 的文案判据 `typeof d.count === 'number'` 在整个 union 上可直接取 */
export type DoneEvent =
  // count:P4 一次导出多条（separate 模式）时的条数（plan C-2）;单条导出/下载不返回该字段
  | { kind?: 'audio'; audioId: number; title: string; format: string; replaced?: boolean; count?: number }
  | { kind: 'video'; title: string; importId?: number; filePath?: string; height?: number | null; fileSize?: number; audioId?: number; format?: string; replaced?: boolean; count?: number };

export function subscribeJob(jobId: number, handlers: {
  onProgress?: (p: { percent: number }) => void;
  onPhase?: (p: { phase: 'ingest' }) => void; // 阶段信号(2026-09-29):下载进程结束、开始入库 → 进度条切第二段
  onDone?: (d: DoneEvent) => void; // replaced:本次是覆盖下载(旧的那份已删);kind==='video' = 素材下载完成(importId)或视频导出完成(audioId,N1)
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
  // 业务错误的解析、next 拼接、logFe、抛 ApiError 全在 throwApiError 里(与 apiPost 共用一份)。
  // 注意:apiPut 无超时控制(没有 AbortController),apiPost 有——这是既有差异,本次不动。
  if (!res.ok) await throwApiError(res, path);
  return (await res.json()) as T;
}

/** GET /api/settings:白名单键 + 计算字段 output_dir_resolved(导出目录实际生效值,spec D11)。
 *  这里返回 Record<string,string> 而非具体形状:白名单键会随服务端演进,前端只按遇到的键取用。 */
export function getSettings(): Promise<Record<string, string>> {
  return apiGet<Record<string, string>>('/api/settings');
}

/** PUT /api/settings:值必须是字符串(服务端约束);失败时 apiPut 已把后端 error.message/error.next 拼进错误消息 */
export function putSettings(patch: Record<string, string>): Promise<{ ok: boolean }> {
  logFe('info', `putSettings ${Object.keys(patch).join(',')}`);
  return apiPut<{ ok: boolean }>('/api/settings', patch);
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
/** DELETE 语义:无 body;错误处理与 apiPost/apiPut 同款(throwApiError:解析 error.next 拼进展示消息、code/状态码上抛)。
 *  注意:apiDelete 保留自己的 10s AbortController 超时,apiPut 没有——既有差异,不动(T8,2026-10-02 统一错误块)。 */
export async function apiDelete<T>(path: string): Promise<T> {
  const headers: Record<string, string> = {};
  const token = apiToken();
  if (token) headers['x-sct-token'] = token;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 10_000);
  try {
    const res = await fetch(`${API_BASE}${path}`, { method: 'DELETE', headers, signal: ctl.signal });
    // 业务错误的解析、next 拼接、logFe、抛 ApiError 全在 throwApiError 里(与 apiPost/apiPut 共用一份)
    if (!res.ok) await throwApiError(res, path);
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
  has_project: boolean;           // 已有剪辑作品(2026-09-30 P2 对齐服务端)
  segment_count: number;          // 已保存剪辑点数(D19 替换确认文案的条件句用)
  material_entry_index: number | null; // 这份素材是合集里的第几集(2026-09-30 P3-T1 对齐服务端);单视频/无素材 → null
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

/** 可用清晰度探测(spec D6/D6a,Task 4):GET /api/imports/:id/formats?entry=<n>。
 *  服务端保证不报错——探测失败/超时会回固定四档 + fallback:true(前端据此静默降级)。
 *  返回的是**实测高度**(B 站实测形如 [1056,704,470],不规整),标签归一由界面负责(见 library.tsx 的 tierLabel);
 *  Radio 的 value 必须用实测值,下载才能精确命中该路流。
 *  entry 仅合集需要(第几集,1 起);单视频不传。 */
export function getFormats(importId: number, entry?: number): Promise<{ ok: boolean; heights: number[]; fallback: boolean }> {
  const q = entry !== undefined ? `?entry=${entry}` : '';
  // 20s > 服务端探测超时 15s:慢视频(B 站大合集)探测可能接近 15s,客户端若用默认 10s 会先 abort,
  // 明明服务端能探到、用户却只看到降级四档(第二次进入命中服务端缓存才正常)
  return apiGet<{ ok: boolean; heights: number[]; fallback: boolean }>(`/api/imports/${importId}/formats${q}`, 20_000);
}

// ---- 日志清空(2026-09-29 用户拍板:日志要可删除) ----
/** DELETE /api/logs[?day=]:清空后端内存日志 + 删除落盘文件;day=YYYY-MM-DD 只清该天,缺省全清 */
export async function clearServerLogs(day?: string): Promise<{ ok: boolean; clearedEntries: number; deletedFiles: string[]; failedFiles: string[] }> {
  logFe('info', `clearServerLogs day=${day ?? '(all)'}`); // 本地缓冲也留痕
  return apiDelete(`/api/logs${day ? `?day=${encodeURIComponent(day)}` : ''}`);
}
