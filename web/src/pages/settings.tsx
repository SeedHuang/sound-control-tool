import { Alert, Button, Card, Descriptions, Input, Modal, Typography, message } from 'antd';
import { useEffect, useState } from 'react';
import { ApiError, apiGet, apiPort, getCookieStatus, logFe, saveCookie, type CookieStatus } from '@/api';

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
          description="影响:相关获取功能不可用。请确认已安装并加入 PATH,或在设置中指定完整路径。"
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
            content: `${e.message}。要用新粘贴的覆盖吗?`,
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
    <div style={{ margin: 16 }}>
      {error && (
        <Alert
          type="error"
          showIcon
          message="无法连接本地服务"
          description={error}
          style={{ marginBottom: 16 }}
        />
      )}
      <Card title="设置" style={{ marginBottom: 16 }}>
        <Typography.Text>API 端口:{apiPort()}</Typography.Text>
        <Button style={{ float: 'right' }} loading={probing} onClick={() => void probe()}>
          重新探测
        </Button>
      </Card>
      <BinCard title="yt-dlp" bin={bins?.ytdlp ?? null} loading={loading} />
      <BinCard title="ffmpeg" bin={bins?.ffmpeg ?? null} loading={loading} />
      <CookieCard />
    </div>
  );
}
