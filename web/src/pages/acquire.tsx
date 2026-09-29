// web/src/pages/acquire.tsx(获取页 2026-09-29 重构:左侧导入来源列表 + 新导入弹窗 + 主区横排集数网格)
// 左列表持久化(imported_sources 表,parse 成功自动落库);点来源直接看缓存集数,不重新解析
import { Alert, Badge, Button, Card, Checkbox, Empty, Input, Modal, Progress, Radio, Space, Spin, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { apiGet, cancelJob, deleteImport, getImport, listImports, logFe, parseUrl, startDownload, subscribeJob, type ImportDetail, type ImportSource } from '@/api';
import SiteLogo from '@/components/SiteLogo';

export default function AcquirePage() {
  const [imports, setImports] = useState<ImportSource[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<ImportDetail | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [parsing, setParsing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checked, setChecked] = useState<number[]>([]);
  const [format, setFormat] = useState<'mp3' | 'm4a' | 'wav'>('mp3');
  const [jobId, setJobId] = useState<number | null>(null);
  const [percent, setPercent] = useState(0);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false); // 提交 in-flight 守卫 + 逐条串行中

  const refreshImports = (): Promise<ImportSource[]> =>
    listImports().then((list) => { setImports(list); return list; });

  const selectSource = (id: number): void => {
    setSelectedId(id); setError(null); setDone(null);
    getImport(id)
      .then((d) => {
        setDetail(d);
        setChecked(d.kind === 'playlist' && d.entries !== null && d.entries.length > 0 ? [d.entries[0]!.index] : []);
      })
      .catch((e: Error) => setError(e.message));
  };

  useEffect(() => {
    void refreshImports().then((list) => { if (list.length > 0) selectSource(list[0]!.id); });
    // 仅首挂载拉一次列表
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // jobId 变化时建立 EventSource 订阅;done/error 后关闭
  useEffect(() => {
    if (jobId === null) return undefined;
    return subscribeJob(jobId, {
      onProgress: (p) => setPercent(Math.round(p.percent)),
      onDone: (d) => setDone(`《${d.title}》已入库`),
      onStatus: (s) => { if (s.state === 'error' || s.state === 'cancelled') setError(s.message ?? s.state); },
    });
  }, [jobId]);

  // 等待单个 job 终结的 Promise(供逐条串行用);resolve 前必清定时器。
  // 2026-09-29 修复(用户拍板):兜底定时器此前只计一次、不随进度重置——超过 60s 的正常下载
  // 会被误判 error 中断整批。现按注释本意"60s 无任何事件才放行":进度事件续期,
  // 只有 SSE 真断连或服务端卡死(60s 零事件)才兜底放行。
  const waitJobEnd = (jid: number): Promise<'done' | 'error' | 'cancelled'> =>
    new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const arm = (): void => {
        clearTimeout(timer);
        timer = setTimeout(() => { close(); resolve('error'); }, 60_000); // 60s 零事件(SSE 断连/卡死)才兜底
      };
      arm();
      const close = subscribeJob(jid, {
        onProgress: arm, // 有进度就续期——正常下载无论多长都不会被误杀
        onDone: () => { clearTimeout(timer); close(); resolve('done'); },
        onStatus: (s) => { if (s.state === 'error' || s.state === 'cancelled') { clearTimeout(timer); close(); resolve(s.state); } },
      });
    });

  // 弹窗内解析:成功 → server 已自动落库 → 关弹窗 → 刷新左列表 → 选中新来源
  const onParseInModal = async (): Promise<void> => {
    setParsing(true); setError(null);
    logFe('info', `onParse url=${url.slice(0, 80)}`);
    try {
      const r = await parseUrl(url);
      setModalOpen(false); setUrl('');
      const list = await refreshImports();
      if (r.import_id !== undefined) selectSource(r.import_id);
      else if (list.length > 0) selectSource(list[0]!.id);
    } catch (e) { setError((e as Error).message); }
    finally { setParsing(false); }
  };

  // D8:合集多选逐条提交——每条一个 job,串行下载(单产物入库模型)。
  // 2026-09-29 修复(用户拍板):单条失败不再中断整批——失败条目记入 failed 继续下一条,
  // 结束后汇总"成功 N/失败 M"。此前任一条 error 都会 break,一条卡住整批报废;
  // 用户主动取消(cancelled)仍停整批——那是"别下了"的意思,不是失败。
  const onDownload = async (force = false): Promise<void> => {
    if (detail === null || busy) return;
    const isPlaylist = detail.kind === 'playlist' && detail.entries !== null;
    if (isPlaylist && checked.length === 0) { setError('请至少勾选一个条目'); return; }
    setBusy(true); setError(null); setDone(null); setPercent(0);
    logFe('info', `onDownload force=${force} entries=${isPlaylist ? checked.length : 1}`);
    const failed: string[] = [];
    try {
      const targets = isPlaylist ? checked : [0]; // [0] = 单视频(不带 entryIndices)
      for (const entryIndex of targets) {
        setDone(null); // 每条开始前重置,避免上一条 onDone 的成功提示误报
        // 合集条目的「第几集 + 所属合集」随下载一起落库(2026-09-29 用户拍板:音频库要显示第几集/集名)
        const entry = entryIndex === 0 ? null : detail.entries?.find((e) => e.index === entryIndex) ?? null;
        try {
          const { jobId: jid } = await startDownload({
            url: detail.url,
            title: entry === null ? detail.title : entry.title,
            durationSec: entryIndex === 0 ? detail.duration_sec ?? undefined : undefined, // 合集条目无时长 → ffprobe 兜底
            entryIndex: entryIndex === 0 ? undefined : entryIndex,
            collectionTitle: detail.kind === 'playlist' ? detail.title : undefined,
            options: {
              entryIndices: entryIndex === 0 ? undefined : [entryIndex],
              format,
              force,
            },
          });
          setJobId(jid);
          const end = await waitJobEnd(jid);
          if (end === 'cancelled') break; // 用户主动取消 → 停整批(不是失败)
          if (end !== 'done') {
            failed.push(`条目 ${entryIndex}`);
            continue; // 单条 error 跳过继续,不再 break
          }
        } catch (e) {
          failed.push(`条目 ${entryIndex}: ${(e as Error).message}`);
          continue; // 提交阶段失败(网络/409 等)同样跳过继续
        }
      }
      if (targets.length === 1) {
        if (failed.length > 0) setError(failed[0] ?? '下载失败'); // 单视频失败沿用原报错体验
      } else if (failed.length === 0) {
        setDone(`全部 ${targets.length} 条下载完成`);
      } else {
        setDone(`下载完成 ${targets.length - failed.length}/${targets.length},失败:${failed.slice(0, 3).join('、')}${failed.length > 3 ? ' 等' : ''}`);
      }
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); setJobId(null); }
  };

  const onDeleteSource = (id: number): void => {
    Modal.confirm({
      title: '删除这个导入来源?',
      content: '只移除左列表条目,不影响已下载到音频库的文件。',
      okText: '删除', okType: 'danger', cancelText: '取消',
      onOk: async () => {
        await deleteImport(id);
        const list = await refreshImports();
        if (selectedId === id) { setDetail(null); setSelectedId(null); if (list.length > 0) selectSource(list[0]!.id); }
      },
    });
  };

  return (
    /* 高度锁死为布局内容区高度、overflow hidden:body 不滚,滚动全部收敛到内部容器 */
    <div style={{ display: 'flex', height: '100%', minHeight: 0, overflow: 'hidden' }}>
      {/* 左:导入来源列表(持久化;项 = 站点 logo + 标题 + 条目数徽标) */}
      <div style={{ width: 240, flexShrink: 0, borderRight: '1px solid #f0f0f0', display: 'flex', flexDirection: 'column' }}>
        <Button type="primary" onClick={() => { setUrl(''); setError(null); setModalOpen(true); }} style={{ margin: 8 }}>+ 新导入</Button>
        <div style={{ overflowY: 'auto', flex: 1, minHeight: 0 }}>
          {imports.map((it) => (
            <div
              key={it.id}
              onClick={() => selectSource(it.id)}
              style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', cursor: 'pointer', background: selectedId === it.id ? '#e6f4ff' : 'transparent' }}
            >
              <SiteLogo site={it.site} />
              <Typography.Text ellipsis style={{ flex: 1 }} title={it.title}>{it.title}</Typography.Text>
              <Badge count={it.entry_count} overflowCount={999} color="#1677ff" />
            </div>
          ))}
          {imports.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无导入" style={{ marginTop: 40 }} />}
        </div>
      </div>

      {/* 右:选中来源详情(占满内容区宽高;卡内只有集数网格一个滚动区,body 不滚) */}
      <div style={{ flex: 1, minWidth: 0, padding: 16, display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}>
        {error !== null && <Alert type="error" showIcon message={error} style={{ marginBottom: 12, flexShrink: 0 }} />}
        {detail === null && error === null && <Empty description="从左侧选择一个来源,或点「+ 新导入」" style={{ marginTop: 80 }} />}
        {detail !== null && (
          <Card
            title={<Space><SiteLogo site={detail.site} size={18} /><span>{detail.title}</span></Space>}
            extra={(
              <Space wrap size={8}>
                {/* 音频格式 + 下载 + 删除来源(2026-09-29 用户拍板:两个按钮统一为同一种类型——都走实心 primary,
                    删除保留 danger 红;此前「删除来源」是小号 text 按钮,与下载按钮视觉上不是一路) */}
                <Radio.Group value={format} onChange={(e) => setFormat(e.target.value)}>
                  <Radio value="mp3">mp3</Radio><Radio value="m4a">m4a</Radio><Radio value="wav">wav</Radio>
                </Radio.Group>
                <Button type="primary" onClick={() => onDownload(false)} loading={busy} disabled={busy}>
                  {detail.kind === 'playlist' ? `下载(${checked.length})` : '下载'}
                </Button>
                <Button type="primary" danger onClick={() => onDeleteSource(detail.id)}>删除来源</Button>
              </Space>
            )}
            style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
            styles={{ body: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' } }}
          >
            {detail.duration_sec !== null && (
              <Typography.Text type="secondary" style={{ flexShrink: 0 }}>
                时长 {Math.floor(detail.duration_sec / 60)} 分 {Math.round(detail.duration_sec % 60)} 秒
              </Typography.Text>
            )}
            {/* 集数区 = 卡内唯一滚动区:标题固定在上,格子网格在本区内滚 */}
            {detail.kind === 'playlist' && detail.entries !== null && (
              <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, marginTop: 12 }}>
                <Typography.Title level={5} style={{ marginTop: 0, flexShrink: 0 }}>集数({detail.entries.length})</Typography.Title>
                {/* display:block 覆盖 antd 默认的 inline-block —— 否则内层 grid 按内容宽度收缩,
                    表现就是「几集挤在左边、离右边滚动条很远」(2026-09-29 用户反馈) */}
                <Checkbox.Group
                  value={checked}
                  onChange={(v) => setChecked(v as number[])}
                  style={{ display: 'block', width: '100%', flex: 1, minHeight: 0, overflowY: 'auto', paddingRight: 4 }}
                >
                  {/* 自适应网格(2026-09-29 用户拍板,替换原「一行固定 5 列」):auto-fit + minmax(160px,1fr)——
                      列数随容器宽度自动增减,剩余空间摊平到每格,格子永远铺满整行(不出现右侧空白);
                      窄窗自动降列,标题过长用 ellipsis 截断 */}
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 8, width: '100%' }}>
                    {detail.entries.map((e) => (
                      <Checkbox
                        key={e.index}
                        value={e.index}
                        style={{ marginInlineEnd: 0, minWidth: 0, border: '1px solid #f0f0f0', borderRadius: 8, padding: '6px 10px' }}
                      >
                        <Typography.Text ellipsis style={{ maxWidth: '100%' }} title={e.title}>{e.title}</Typography.Text>
                      </Checkbox>
                    ))}
                  </div>
                </Checkbox.Group>
              </div>
            )}
            {jobId !== null && done === null && (
              <div style={{ marginTop: 16, flexShrink: 0 }}>
                <Progress percent={percent} status={percent >= 100 ? 'success' : 'active'} />
                <Button size="small" onClick={() => cancelJob(jobId)}>取消</Button>
              </div>
            )}
            {done !== null && <Alert type="success" showIcon message={done} style={{ marginTop: 16, flexShrink: 0 }} />}
          </Card>
        )}
      </div>

      {/* 新导入弹窗:URL 输入 + 解析;成功自动关弹窗,新来源进左列表并选中 */}
      <Modal title="新导入" open={modalOpen} footer={null} onCancel={() => { setModalOpen(false); setError(null); }}>
        <Space.Compact style={{ width: '100%' }}>
          <Input autoFocus value={url} placeholder="粘贴 B 站/YouTube/播客 URL" onChange={(e) => setUrl(e.target.value)} onPressEnter={() => void onParseInModal()} />
          <Button type="primary" onClick={() => void onParseInModal()} loading={parsing}>解析</Button>
        </Space.Compact>
        {parsing && <Spin style={{ marginTop: 12 }} />}
        {error !== null && <Alert type="error" showIcon message={error} style={{ marginTop: 12 }} />}
      </Modal>
    </div>
  );
}
