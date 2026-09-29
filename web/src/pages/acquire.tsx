import { Alert, Button, Card, Checkbox, Input, Progress, Radio, Space, Spin, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { cancelJob, logFe, parseUrl, startDownload, subscribeJob, type ParseResponse } from '@/api';

export default function AcquirePage() {
  const [url, setUrl] = useState('');
  const [parsing, setParsing] = useState(false);
  const [parsed, setParsed] = useState<ParseResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checked, setChecked] = useState<number[]>([1]);
  const [format, setFormat] = useState<'mp3' | 'm4a' | 'wav'>('mp3');
  const [jobId, setJobId] = useState<number | null>(null);
  const [percent, setPercent] = useState(0);
  const [done, setDone] = useState<{ audioId: number; title: string } | null>(null);
  const [busy, setBusy] = useState(false); // P1-1:提交 in-flight 守卫 + 逐条串行中

  // jobId 变化时建立 EventSource 订阅;done/error 后关闭
  useEffect(() => {
    if (jobId === null) return;
    return subscribeJob(jobId, {
      onProgress: (p) => setPercent(Math.round(p.percent)),
      onDone: (d) => setDone({ audioId: d.audioId, title: d.title }),
      onStatus: (s) => { if (s.state === 'error' || s.state === 'cancelled') setError(s.message ?? s.state); },
    });
  }, [jobId]);

  // 等待单个 job 终结的 Promise(供逐条串行用);resolve 前必清定时器(P1-5)
  const waitJobEnd = (jid: number): Promise<'done' | 'error' | 'cancelled'> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => { close(); resolve('error'); }, 60_000); // 兜底:60s 无事件也放行
      const close = subscribeJob(jid, {
        onDone: () => { clearTimeout(timer); close(); resolve('done'); },
        onStatus: (s) => { if (s.state === 'error' || s.state === 'cancelled') { clearTimeout(timer); close(); resolve(s.state); } },
      });
    });

  const onParse = async () => {
    setParsing(true); setError(null); setParsed(null);
    // 诊断日志:用户点「解析」也要留痕,便于「点了没反应 / 卡死」时区分是前端没发还是后端没回
    logFe('info', `onParse url=${url.slice(0, 80)}`);
    try {
      const r = await parseUrl(url);
      setParsed(r);
      if (r.kind === 'playlist' && r.entries) setChecked([1]);
    } catch (e) { setError((e as Error).message); }
    finally { setParsing(false); }
  };

  // D8:合集多选逐条提交——每条一个 job,串行下载(单产物入库模型)
  const onDownload = async (force = false) => {
    if (!parsed || busy) return;
    // P2-8:合集全不勾选 → 直接提示,不空转
    if (parsed.kind === 'playlist' && parsed.entries && checked.length === 0) {
      setError('请至少勾选一个条目');
      return;
    }
    setBusy(true); setError(null); setDone(null); setPercent(0);
    // 诊断日志:用户点「下载」按 force/entries 区分留痕,排查「点了没响应」「合集丢条目」时一眼定位
    logFe('info', `onDownload force=${force} entries=${parsed.kind === 'playlist' ? checked.length : 1}`);
    try {
      const entries = parsed.kind === 'playlist' && parsed.entries ? checked : [0]; // [0] 表示非合集(不带 entryIndices)
      let lastDone: { audioId: number; title: string } | null = null;
      for (const entryIndex of entries) {
        setDone(null); // 每条开始前重置:合集多条时上一条 onDone 已置 done,避免进度/取消被隐藏而误报"已入库"
        const { jobId: jid } = await startDownload({
          url,
          title: entryIndex === 0 ? parsed.title : parsed.entries!.find((e) => e.index === entryIndex)?.title ?? parsed.title,
          durationSec: entryIndex === 0 ? parsed.duration_sec : undefined, // 合集条目 parse 无时长 → ffprobe 兜底
          options: {
            entryIndices: entryIndex === 0 ? undefined : [entryIndex],
            format,
            force,
          },
        });
        setJobId(jid);
        const end = await waitJobEnd(jid);
        if (end !== 'done') break; // 失败/取消:停止后续条目
        lastDone = { audioId: 0, title: entries.length === 1 ? '' : `条目 ${entryIndex} 完成` };
      }
      if (entries.length > 1 && lastDone) setDone({ audioId: 0, title: '全部条目下载完成' });
    } catch (e) { setError((e as Error).message); }
     finally { setBusy(false); setJobId(null); }
  };
  return (
    <Card title="URL 下载" style={{ margin: 16 }}>
      <Space.Compact style={{ width: '100%' }}>
        <Input value={url} placeholder="粘贴 B 站/YouTube/播客 URL" onChange={(e) => setUrl(e.target.value)} />
        <Button type="primary" onClick={onParse} loading={parsing}>解析</Button>
      </Space.Compact>
      {error && <Alert type="error" showIcon message="下载失败" description={error} style={{ marginTop: 12 }} />}
      {parsed && (
        <div style={{ marginTop: 16 }}>
          <Typography.Title level={5}>{parsed.title}</Typography.Title>
          {parsed.existing && !done && (
            <Alert type="warning" showIcon message={`库中已有《${parsed.existing.title}》`} action={<Button size="small" onClick={() => onDownload(true)}>仍下载</Button>} style={{ marginBottom: 8 }} />
          )}
          {parsed.kind === 'playlist' && parsed.entries && (
            <Checkbox.Group value={checked} onChange={(v) => setChecked(v as number[])}>
              <Space direction="vertical">
                {parsed.entries.map((e) => <Checkbox key={e.index} value={e.index}>{e.title}</Checkbox>)}
              </Space>
            </Checkbox.Group>
          )}
          <Radio.Group value={format} onChange={(e) => setFormat(e.target.value)} style={{ marginTop: 12 }}>
            <Radio value="mp3">mp3</Radio><Radio value="m4a">m4a</Radio><Radio value="wav">wav</Radio>
          </Radio.Group>
          <br />
          <Button type="primary" onClick={() => onDownload(false)} loading={busy} disabled={busy} style={{ marginTop: 12 }}>{parsed.existing ? '重新下载' : '下载'}</Button>
        </div>
      )}
      {jobId !== null && !done && (
        <div style={{ marginTop: 16 }}>
          <Progress percent={percent} status={percent >= 100 ? 'success' : 'active'} />
          <Space>
            <Button size="small" onClick={() => cancelJob(jobId)}>取消</Button>
          </Space>
        </div>
      )}
      {done && <Alert type="success" showIcon message={`完成：《${done.title}》已入库`} style={{ marginTop: 16 }} />}
      {parsing && <Spin style={{ marginTop: 16 }} />}
    </Card>
  );
}
