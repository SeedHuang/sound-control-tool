// server/src/ytdlp/bili-login.ts(保存 Cookie 时在线校验 B 站登录态——用户 2026-09-29 拍板「要做有效性校验」)
// 用 B 站官方 nav 接口:游客请求也返回 code=0 + isLogin=false,登录 Cookie 返回 isLogin=true + uname。
// fetchImpl 可注入(测试不发真网);网络失败 requestOk=false(与「Cookie 坏了」区分,调用方自行决定放行与否)。
const NAV_API = 'https://api.bilibili.com/x/web-interface/nav';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export interface BiliLoginResult {
  requestOk: boolean; // 请求链路本身是否成功(false = 网络/风控问题,不代表 Cookie 坏)
  isLogin: boolean;
  uname?: string;
  reason?: string; // requestOk=true 且 isLogin=false 时的原因;requestOk=false 时的错误摘要
}

export async function validateBiliLogin(cookieHeader: string, timeoutMs = 8000, fetchImpl: typeof fetch = fetch): Promise<BiliLoginResult> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(NAV_API, {
      headers: { cookie: cookieHeader, 'user-agent': UA, referer: 'https://www.bilibili.com/' },
      signal: ctl.signal,
    });
    if (!res.ok) return { requestOk: false, isLogin: false, reason: `nav API HTTP ${res.status}` };
    const j = (await res.json().catch(() => null)) as { code?: number; data?: { isLogin?: boolean; uname?: string; mid?: number } } | null;
    if (j === null || typeof j.code !== 'number' || j.data === undefined) {
      return { requestOk: false, isLogin: false, reason: 'nav API 响应不是预期 JSON' };
    }
    if (!j.data.isLogin) return { requestOk: true, isLogin: false, reason: 'Cookie 有效但未登录(游客身份或已失效)' };
    return { requestOk: true, isLogin: true, uname: j.data.uname };
  } catch (e) {
    return { requestOk: false, isLogin: false, reason: `校验请求失败: ${e instanceof Error ? e.message : String(e)}` };
  } finally {
    clearTimeout(timer);
  }
}
