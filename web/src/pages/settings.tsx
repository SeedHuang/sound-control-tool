import { Alert, Button, Card, Descriptions, Input, Modal, Space, Spin, Tooltip, Typography, message } from 'antd';
import { useEffect, useState } from 'react';
import { ApiError, apiGet, apiPort, clearServerLogs, getCookieStatus, getSettings, logFe, putSettings, saveCookie, type CookieStatus } from '@/api';
import { hasDesktopBridge, pickDirectory } from '@/desktop';

interface BinProbe {
  path: string | null;
  version: string | null;
}
interface BinsResult {
  ytdlp: BinProbe;
  ffmpeg: BinProbe;
}

function BinCard({ title, bin, loading }: { title: string; bin: BinProbe | null; loading: boolean }) {
  // loading 由父组件显式传入(仅请求进行中为 true),不再由 bin === null 推导
  if (loading) return <Card title={title} loading style={{ marginBottom: 16 }} />;
  if (!bin) {
    return (
      <Card title={title} style={{ marginBottom: 16 }}>
        <Alert type="error" showIcon message="暂无数据" description="探测未成功。请确认本地服务可用后点击「重新探测」。" />
      </Card>
    );
  }
  if (bin.path === null) {
    return (
      <Card title={title} style={{ marginBottom: 16 }}>
        <Alert
          type="error"
          showIcon
          message="未检测到"
          description="影响:下载、剪辑等相关功能不可用。请确认已安装并加入 PATH,或在设置中指定完整路径。"
        />
      </Card>
    );
  }
  return (
    <Card title={title} style={{ marginBottom: 16 }}>
      <Descriptions size="small" column={1}>
        <Descriptions.Item label="路径">{bin.path}</Descriptions.Item>
        <Descriptions.Item label="版本">
          {bin.version ?? <Typography.Text type="danger">已找到但版本探测失败</Typography.Text>}
        </Descriptions.Item>
      </Descriptions>
    </Card>
  );
}

interface Health {
  ok: boolean;
  sqlite: string | null;
  port: number;
}

/** 服务状态卡片(P5-T2,2026-09-30):从首页挪来 —— 首页改成仪表盘后「后端只剩一句 OK」无处安放,
 *  挪到设置页更合理(服务是否可用属于诊断/设置场景)。同一个 GET /api/health,成功/失败两态都用 antd 呈现。 */
function HealthCard() {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    logFe('info', 'SettingsPage HealthCard → GET /api/health'); // 诊断日志:开页留痕
    apiGet<Health>('/api/health').then(setHealth).catch((e: Error) => setError(e.message));
  }, []);
  // 按真实字段判定,而非拿到响应就无条件印成功
  const ok = health !== null && health.ok === true && health.sqlite !== null;
  return (
    <Card title="服务状态" style={{ marginBottom: 16 }}>
      {error !== null && <Alert type="error" showIcon message="无法连接本地服务" description={error} />}
      {error === null && health === null && <Spin />}
      {error === null && health !== null && ok && (
        <Typography.Text>后端 OK · SQLite 读写成功 · API 端口 {health.port}</Typography.Text>
      )}
      {error === null && health !== null && !ok && (
        <Alert
          type="error"
          showIcon
          message="后端异常"
          description={`health.ok=${String(health.ok)}, sqlite=${String(health.sqlite)}`}
        />
      )}
    </Card>
  );
}

// B 站 Cookie 卡片(2026-09-29 用户拍板):粘贴 → PUT /api/cookie 服务端保存 → yt-dlp --cookies 注入,解 B 站 412 风控
const COOKIE_PLACEHOLDER = [
  '推荐:F12 → 网络面板 → 刷新页面 → 随便点一个 www.bilibili.com 的请求 → 右键 Copy → Copy as cURL (bash),整条粘贴到这里。',
  '也支持:Get cookies.txt 插件导出的 Netscape 文本,或 cookie-editor 的 JSON。',
  '保存时会自动调 B 站接口校验登录态;已有未过期登录信息时会先询问是否覆盖。',
  '过期后(解析/下载报 412 或要求登录)重新导出覆盖即可。',
].join('\n');

/** 状态行:条数 + 登录有效期(离线解析 SESSDATA;在线校验只在保存时做一次) */
function cookieStatusText(s: CookieStatus | null): string {
  if (s === null) return '状态未知(本地服务未连接)';
  if (!s.set) return '未设置';
  if (s.expired === true) return `已保存(${s.count} 条)·登录已过期,请重新导出`;
  if (s.sessdataExpiry !== null) return `已保存(${s.count} 条)·登录有效期至 ${new Date(s.sessdataExpiry * 1000).toLocaleDateString('zh-CN')}`;
  return `已保存(${s.count} 条)·有效期未知`;
}

function CookieCard() {
  const [status, setStatus] = useState<CookieStatus | null>(null);
  const [content, setContent] = useState('');
  const [saving, setSaving] = useState(false);

  const refresh = (): Promise<void> =>
    getCookieStatus()
      .then((s) => setStatus(s))
      .catch(() => setStatus(null)); // 拉取失败静默显示未设置(顶部已有连接错误提示;Cookie 是增强,不能挡设置页)

  useEffect(() => {
    void refresh();
  }, []);

  const doSave = (force: boolean): Promise<void> => {
    logFe('info', `CookieCard.save length=${content.length}${force ? ' force' : ''}`);
    return saveCookie(content, force)
      .then((r) => {
        message.success(r.uname !== null ? `已保存并验证登录(${r.uname})` : r.verified ? '已保存' : '已保存(在线校验未通过:网络原因)');
        setContent(''); // 保存成功清空输入框,凭据不留在页面
        return refresh();
      })
      .catch((e: unknown) => {
        // 409 CONFLICT = 已有未过期登录信息(用户拍板:提示而不是默默覆盖)→ 弹窗确认后带 force 重发
        if (e instanceof ApiError && e.code === 'CONFLICT') {
          Modal.confirm({
            title: '已存在有效的登录信息',
            // 后端 error.next 已含操作指引(「点『仍然覆盖』」),apiPut 会把它拼进 e.message(spec §0.5)。
            // 这里**不再自己追加问句**——否则弹窗里会出现两句"下一步怎么办"(重复指引)。
            content: e.message,
            okText: '仍然覆盖',
            cancelText: '取消',
            onOk: () => doSave(true),
          });
          return;
        }
        message.error(e instanceof Error ? e.message : String(e));
      })
      .finally(() => setSaving(false));
  };
  const save = (): void => {
    if (content.trim().length === 0 || saving) return;
    setSaving(true);
    void doSave(false);
  };

  return (
    <Card title="B 站 Cookie" style={{ marginBottom: 16 }}>
      <Typography.Paragraph type="secondary">
        {cookieStatusText(status)}
      </Typography.Paragraph>
      <Input.TextArea
        rows={8}
        value={content}
        placeholder={COOKIE_PLACEHOLDER}
        onChange={(e) => setContent(e.target.value)}
      />
      <Button type="primary" style={{ marginTop: 12 }} loading={saving} disabled={content.trim().length === 0} onClick={save}>
        保存 Cookie
      </Button>
    </Card>
  );
}

/**
 * 日志卡片(2026-09-29 用户拍板):清空入口从「诊断日志抽屉」搬到这里。
 * 抽屉只负责"看"(排查时随手翻),破坏性操作统一放设置页 —— 并且必须二次确认(仓库规则:危险操作必须二次确认)。
 */
function LogsCard() {
  const [clearing, setClearing] = useState(false);
  const confirmClear = (): void => {
    Modal.confirm({
      title: '清空全部日志?',
      content: '将清空后端内存日志,并删除已按天/小时落盘的日志文件。',
      okText: '清空',
      okType: 'danger',
      cancelText: '取消',
      onOk: () => {
        setClearing(true);
        return clearServerLogs()
          .then((r) => {
            message.success(`已清空(内存 ${r.clearedEntries} 条,删除文件 ${r.deletedFiles.length} 个)`);
            logFe('info', `日志已清空 clearedEntries=${r.clearedEntries} deletedFiles=${r.deletedFiles.length}`);
          })
          .catch((e: unknown) => message.error(e instanceof Error ? e.message : String(e)))
          .finally(() => setClearing(false));
      },
    });
  };
  return (
    <Card title="日志" style={{ marginBottom: 16 }}>
      <Typography.Paragraph type="secondary">
        清空后端内存日志,并删除已按天/小时落盘的日志文件。看日志请点右上角「日志」按钮。
      </Typography.Paragraph>
      <Button danger loading={clearing} onClick={confirmClear}>
        清空所有日志
      </Button>
    </Card>
  );
}

/** 数据与备份说明卡(2026-10-01 spec clip-works §0.10 第 7 条):老库首次升级会生成 sct.db.bak-* 备份,
 *  且新版本改过表结构 —— 旧版本打不开升级后的库。这两件事用户不知道会误删备份 / 误降级,设置页补一句。 */
function DatabaseCard() {
  return (
    <Card title="数据与备份" style={{ marginBottom: 16 }}>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
        升级后首次启动,若数据库需要迁移(如旧版本的剪辑数据),会自动在数据库同目录生成一份
        sct.db.bak-日期时间 备份文件(只生成一次,日志里有完整路径)。新版本改过数据库结构,旧版本打不开升级后的库
        —— 确认新版本一切正常之前,请保留这份备份。
      </Typography.Paragraph>
    </Card>
  );
}

/** 导出目录卡片（spec D1/D2/D4/D5/D8）：留空 = 用应用数据目录（与改造前一致）。
 *  两种"没 Electron"的情况都禁用「浏览…」并给提示，而不是点了没反应。 */
function ExportDirCard() {
  const [value, setValue] = useState('');
  const [resolved, setResolved] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [picking, setPicking] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const bridge = hasDesktopBridge();

  const load = (): Promise<void> => {
    setLoading(true);
    return getSettings()
      .then((s) => { setValue(s.output_dir ?? ''); setResolved(s.output_dir_resolved ?? ''); setErr(null); })
      .catch((e: Error) => setErr(e.message))
      .finally(() => setLoading(false));
  };
  useEffect(() => { void load(); }, []);

  // 「浏览…」只回填输入框，落库仍靠「保存」——避免"选一下就偷偷改了设置"。
  const browse = async (): Promise<void> => {
    setPicking(true);
    try {
      const p = await pickDirectory();
      if (p !== null) setValue(p);
    } finally { setPicking(false); }
  };

  const save = (): void => {
    setSaving(true);
    void putSettings({ output_dir: value.trim() })
      .then(() => { message.success('已保存'); return load(); })
      .catch((e: unknown) => message.error(e instanceof Error ? e.message : String(e)))
      .finally(() => setSaving(false));
  };

  return (
    <Card title="导出目录" style={{ marginBottom: 16 }} loading={loading}>
      {err !== null && <Alert type="error" showIcon message="读取设置失败" description={err} style={{ marginBottom: 12 }} />}
      <Space.Compact style={{ width: '100%' }}>
        <Input
          value={value}
          placeholder="留空 = 用应用数据目录"
          onChange={(e) => setValue(e.target.value)}
        />
        <Tooltip title={bridge ? '选择文件夹' : '仅桌面应用内可用'}>
          <span><Button loading={picking} disabled={!bridge} onClick={() => void browse()}>浏览…</Button></span>
        </Tooltip>
        <Button type="primary" loading={saving} onClick={save}>保存</Button>
      </Space.Compact>
      <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>
        导出产物会直接写入这个目录（剪辑室里照样能看到、能试听）。留空时默认：{resolved || '（读取中）'}
      </Typography.Paragraph>
    </Card>
  );
}

/** 下载保护设置(spec D17):并发数 / 请求间隔 / 限速。
 *  三项都是"保护类",放同一张卡;只影响**下载**任务(剪辑/导出不受影响,spec D18)。
 *  三项一起 PUT:同属一组设置,改完一次保存更省事——拆开会让用户改一个跑一次。 */
function DownloadCard() {
  const [limit, setLimit] = useState('1');
  const [sleep, setSleep] = useState('0');
  const [rate, setRate] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const load = (): Promise<void> => {
    setLoading(true);
    return getSettings()
      .then((s) => {
        setLimit(s.max_concurrent_downloads ?? '1');
        setSleep(s.download_sleep_seconds ?? '0');
        setRate(s.download_limit_rate ?? '');
        setErr(null);
      })
      .catch((e: Error) => setErr(e.message))
      .finally(() => setLoading(false));
  };
  useEffect(() => { void load(); }, []);
  const save = (): void => {
    setSaving(true);
    void putSettings({ max_concurrent_downloads: limit, download_sleep_seconds: sleep, download_limit_rate: rate })
      .then(() => { message.success('已保存'); return load(); })
      // 后端 400 的 next(下一步指引)由 apiPut 拼进 e.message,这里直接展示即可
      .catch((e: unknown) => message.error(e instanceof Error ? e.message : String(e)))
      .finally(() => setSaving(false));
  };
  return (
    <Card title="下载" style={{ marginBottom: 16 }} loading={loading}>
      {err !== null && <Alert type="error" showIcon message="读取设置失败" description={err} style={{ marginBottom: 12 }} />}
      <Space direction="vertical" style={{ width: '100%' }}>
        <div>
          <Typography.Text>同时下载数（1–5）</Typography.Text>
          <Input value={limit} onChange={(e) => setLimit(e.target.value)} style={{ width: 120 }} />
        </div>
        <div>
          <Typography.Text>请求间隔秒数（0–10，0 = 不间隔；对合集批量最有效）</Typography.Text>
          <Input value={sleep} onChange={(e) => setSleep(e.target.value)} style={{ width: 120 }} />
        </div>
        <div>
          <Typography.Text>限速（留空 = 不限；如 500K / 1.5M）</Typography.Text>
          <Input value={rate} onChange={(e) => setRate(e.target.value)} style={{ width: 160 }} placeholder="留空 = 不限" />
        </div>
        <Button type="primary" loading={saving} onClick={save}>保存</Button>
      </Space>
    </Card>
  );
}

export default function SettingsPage() {
  const [bins, setBins] = useState<BinsResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [probing, setProbing] = useState(false);

  const probe = (): Promise<void> => {
    if (probing) return Promise.resolve(); // in-flight 守卫,避免并发探测竞态
    setProbing(true);
    setLoading(true);
    return apiGet<BinsResult>('/api/bins/probe')
      .then((r) => {
        setBins(r);
        setError(null);
      })
      .catch((e: Error) => {
        setError(e.message);
        setBins(null);
      })
      .finally(() => {
        setLoading(false);
        setProbing(false);
      });
  };

  useEffect(() => {
    void probe();
  }, []);

  return (
    /* 设置页自管滚动(spec D3):锁死高度 + 自己滚,不再依赖布局的内容区 */
    <div style={{ boxSizing: 'border-box', height: '100%', minHeight: 0, overflowY: 'auto', padding: 16 }}>
      {error && (
        <Alert
          type="error"
          showIcon
          message="无法连接本地服务"
          description={error}
          style={{ marginBottom: 16 }}
        />
      )}
      <HealthCard />
      <DownloadCard />
      <ExportDirCard />
      <Card style={{ marginBottom: 16 }}>
        <Typography.Text>API 端口:{apiPort()}</Typography.Text>
        <Button style={{ float: 'right' }} loading={probing} onClick={() => void probe()}>
          重新探测
        </Button>
      </Card>
      <BinCard title="yt-dlp" bin={bins?.ytdlp ?? null} loading={loading} />
      <BinCard title="ffmpeg" bin={bins?.ffmpeg ?? null} loading={loading} />
      <CookieCard />
      <LogsCard />
      <DatabaseCard />
    </div>
  );
}
