// web/src/pages/library.tsx(资料库 2026-09-30:Task 7 收敛为纯视频下载——产物类型 Radio/音频格式 Radio/音频批量下载流已移除,音频一律从剪辑获得,spec D4 修订;服务端 produce='audio' 管线保留休眠)
// 左列表持久化(imported_sources 表,parse 成功自动落库);点来源直接看缓存集数,不重新解析
import { Alert, Badge, Button, Card, Empty, Input, Modal, Progress, Radio, Space, Spin, Tag, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { apiGet, cancelJob, coverUrl, deleteImport, getImport, listImports, listMedia, logFe, mediaFileUrl, parseUrl, startDownload, subscribeJob, type ImportDetail, type ImportSource, type MediaItem } from '@/api';
import PageHeader from '@/components/PageHeader';
import SiteLogo from '@/components/SiteLogo';

export default function LibraryPage() {
  const [imports, setImports] = useState<ImportSource[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<ImportDetail | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [parsing, setParsing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [jobId, setJobId] = useState<number | null>(null);
  const [percent, setPercent] = useState(0);
  const [phase, setPhase] = useState<'download' | 'ingest'>('download'); // 进度条第二段:下载结束→登记素材中(2026-09-29 用户拍板)
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false); // 提交 in-flight 守卫
  // 视频下载流状态(2026-09-30 Task 4+5,方案 A:一次只选一集;Task 7 起页面唯一下载流):
  // videoHeight=清晰度档位(默认 480);videoSelectedIndex=网格单选的集;mediaList=已登记素材列表(D20 当前素材标记 + D19 默认选中/换集判定都靠它)
  const [videoHeight, setVideoHeight] = useState<360 | 480 | 720 | 1080>(480);
  const [videoSelectedIndex, setVideoSelectedIndex] = useState<number | null>(null);
  const [mediaList, setMediaList] = useState<MediaItem[]>([]);
  // 封面/视频共用位(Task 9)错误态:coverFailed=封面加载失败 → 灰底+SiteLogo 引导;videoFailed=素材流加载失败 → 回退封面态
  const [coverFailed, setCoverFailed] = useState(false);
  const [videoFailed, setVideoFailed] = useState(false);
  // 媒体版本计数器(2026-09-30 修复轮):服务端 upsert 替换素材不更新 created_at(repo/source-videos.ts 的
  // ON CONFLICT DO UPDATE 只更新 file_path/height/file_size/entry_index),换集/重下后 created_at 不变 →
  // 纯 created_at 版本串失效。本地计数器兜底:每次视频下载完成 +1,与 created_at 组成版本串,
  // 保证 <video> key/src 确定性变化(重新拉流)且错误态复位 effect 确定性触发。
  const [mediaRev, setMediaRev] = useState(0);

  const refreshImports = (): Promise<ImportSource[]> =>
    listImports().then((list) => { setImports(list); return list; });

  const selectSource = (id: number): void => {
    setSelectedId(id); setError(null); setDone(null);
    setCoverFailed(false); setVideoFailed(false); // 换来源 → 共用位错误态复位(Task 9)
    getImport(id)
      .then((d) => {
        setDetail(d);
        setVideoSelectedIndex(null); // 换来源 → 视频单选复位(与 setDetail 同批;「默认选中素材所在集」的 effect 会按新来源重新挑)
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
      onPhase: () => setPhase('ingest'), // 下载进程结束 → 第二段(登记素材)开始动
      onDone: (d) => {
        if (d.kind === 'video') {
          setDone(`《${d.title}》视频素材已下好`);
          // 媒体版本 +1(2026-09-30 修复轮):服务端 upsert 不更新 created_at,换集/重下后版本串变化靠它,
          // <video> key/src 随之变 → 重新拉流;videoFailed 复位 effect 挂它 → 重下后自动重试。
          setMediaRev((r) => r + 1);
          // 顺带修 M2:封面若因首帧 404 置了失败态,素材下载完成后复位重试。
          setCoverFailed(false);
          // 素材登记完成 → 刷新素材列表(D20 当前素材标记、默认选中都依赖它;2026-09-30 Task 4+5)
          listMedia().then((list) => setMediaList(list)).catch((e: unknown) => { logFe('error', `刷新素材列表失败: ${e instanceof Error ? e.message : String(e)}`); /* 拉失败不挡完成提示 */ });
          return;
        }
        // audio 分支保留(Task 7):服务端 produce='audio' 管线休眠但 API 仍可触发,音频下载完成事件仍可能到达,消息无害
        setDone(d.replaced ? `《${d.title}》已入库(库里原来那一份已替换)` : `《${d.title}》已入库`);
      },
      onStatus: (s) => { if (s.state === 'error' || s.state === 'cancelled') setError(s.message ?? s.state); },
    });
  }, [jobId]);

  // 拉素材列表(挂载时拉一次;D20 标记与默认选中靠它;Task 4+5;Task 7 去掉 produce 门——页面恒为视频)
  useEffect(() => {
    let alive = true;
    listMedia()
      .then((list) => { if (alive) setMediaList(list); })
      .catch((e: Error) => { if (alive) setError(e.message); });
    return () => { alive = false; };
    // 仅首挂载拉一次(onDone 里另有刷新)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 默认选中(Task 4+5):还没手动选过集且当前来源已有素材 → 自动选中素材所在集
  useEffect(() => {
    if (videoSelectedIndex !== null || detail === null) return;
    const mat = mediaList.find((m) => m.import_id === detail.id);
    if (mat !== undefined && mat.entry_index !== null) setVideoSelectedIndex(mat.entry_index);
  }, [videoSelectedIndex, detail, mediaList]);

  // 等待单个 job 终结的 Promise(视频下载流用它托住 busy 生命周期);resolve 前必清定时器。
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

  // ---- 视频下载流(2026-09-30 Task 4+5,方案 A:一次只选一集;点集=选中,点下载=下载/替换该集素材;Task 7 起为页面唯一下载流) ----
  // 当前素材行 + 它在哪一集(D20 标记 + D19 换集判定用);单视频素材/无素材 → undefined / entry_index=null → null。
  // 2026-09-30 终审修:素材行与集号拆开——存量素材(m1c 时代在合集来源上下载)entry_index 可为 NULL,
  // 此时是「素材行存在但集号未知」,不等于「无素材」,D19 判定要区分这两种情况
  const currentMaterial = detail === null ? undefined : mediaList.find((m) => m.import_id === detail.id);
  const currentMaterialEp = currentMaterial?.entry_index ?? null;

  // 媒体版本变化 → 共用位视频错误态复位(2026-09-30 修复轮改挂 mediaRev):重下载替换素材后 <video> 必须重新
  // 尝试,不能永久卡在上一次"素材文件丢失回退封面"的态。原挂 currentMaterial?.created_at,但服务端 upsert 替换
  // 素材不更新 created_at(repo/source-videos.ts:20-22)→ 换集/重下后不触发、永久卡回退态;改挂 mediaRev
  // (视频下载完成 onDone 里 +1)确定性复位,丢文件 → 重下 → 自动恢复。换来源走 selectSource 里的显式复位。
  useEffect(() => { setVideoFailed(false); }, [mediaRev]);

  // 真正提交视频下载;进度/完成/取消全走 jobId 订阅机器,waitJobEnd 托住 busy 生命周期
  const doDownloadVideo = async (entryIndex: number | null): Promise<void> => {
    if (detail === null) return;
    setBusy(true); setError(null); setDone(null); setPercent(0); setPhase('download');
    // 集标题:playlist 时按所选集从 entries 找;单视频/未找到 → 来源标题兜底
    const entry = detail.kind === 'playlist' && entryIndex !== null ? detail.entries?.find((e) => e.index === entryIndex) ?? null : null;
    logFe('info', `onDownloadVideo entry=${entryIndex ?? '(single)'} height=${videoHeight}`);
    try {
      const { jobId: jid } = await startDownload({
        url: detail.url,
        title: entry !== null ? entry.title : detail.title,
        entryIndex: entryIndex ?? undefined,
        collectionTitle: detail.kind === 'playlist' ? detail.title : undefined,
        produce: 'video',
        options: { videoHeight, format: 'mp3', entryIndices: entryIndex !== null ? [entryIndex] : undefined },
      });
      setJobId(jid);
      await waitJobEnd(jid);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); setJobId(null); }
  };

  // D19 下载判定链(Task 9 从 onDownloadVideo 抽出——工具栏"下载"与"点击集数"共用这一份,不复制第二份):
  // playlist 目标集必填;素材行存在且(集号未知 或 目标集 ≠ 当前素材集)→ 弹替换确认;首次下载/同集 → 直接下(服务端覆盖,不确认)。
  // 2026-09-30 终审修:原判定 `currentMaterialEp !== null && ...` 对「素材行存在但集号为 NULL」的存量素材跳过确认,
  // 而服务端此时仍会清空该来源剪辑工程 → 集号未知也必须弹;集号已知且相同(同集换清晰度)维持不弹。
  const requestDownloadVideo = (targetEp: number | null): void => {
    if (detail === null || busy) return;
    if (detail.kind === 'playlist') {
      if (targetEp === null) { setError('请先在网格中选择一集'); return; }
      if (currentMaterial !== undefined && (currentMaterialEp === null || targetEp !== currentMaterialEp)) {
        const segCount = imports.find((i) => i.id === detail.id)?.segment_count ?? 0;
        Modal.confirm({
          title: '替换视频素材？',
          content: currentMaterialEp !== null
            ? `当前素材是第 ${currentMaterialEp} 集，将下载第 ${targetEp} 集并替换（原素材文件会被删除）${segCount > 0 ? `，并清空该来源已保存的 ${segCount} 个剪辑点（它们对应的是第 ${currentMaterialEp} 集的画面）` : ''}。`
            : `当前素材未记录集数，将下载第 ${targetEp} 集并替换（原素材文件会被删除）${segCount > 0 ? `，已保存的 ${segCount} 个剪辑点将被清空` : ''}。`,
          okText: '下载并替换',
          okType: 'danger',
          cancelText: '取消',
          onOk: () => void doDownloadVideo(targetEp),
        });
        return;
      }
    }
    void doDownloadVideo(detail.kind === 'playlist' ? targetEp : null);
  };

  // 工具栏"下载"按钮(Task 9 语义不变):重下当前选中集(换清晰度场景——同集也重下,不弹确认),判定全在 requestDownloadVideo
  const onDownloadVideo = (): void => {
    if (detail === null) return;
    requestDownloadVideo(detail.kind === 'playlist' ? videoSelectedIndex : null);
  };

  // 点击集数卡片(Task 9):选中该集;点的不是当前素材所在集 → 走下载判定链(无素材直接下 / 换集或集号未知弹 D19);
  // 点的就是当前素材所在集 → 只选中,不重复下载(素材已在)。busy 时 requestDownloadVideo 内部守卫挡提交,选中仍更新。
  const onEntryClick = (index: number): void => {
    setVideoSelectedIndex(index);
    if (currentMaterial !== undefined && currentMaterialEp === index) return;
    requestDownloadVideo(index);
  };

  const onDeleteSource = (id: number): void => {
    Modal.confirm({
      title: '删除这个导入来源?',
      content: '会一并删除该来源的视频素材文件（已剪出的音频不受影响）。',
      okText: '删除', okType: 'danger', cancelText: '取消',
      onOk: async () => {
        await deleteImport(id);
        const list = await refreshImports();
        if (selectedId === id) { setDetail(null); setSelectedId(null); if (list.length > 0) selectSource(list[0]!.id); }
      },
    });
  };

  return (
    /* 高度锁死为布局内容区高度、overflow hidden:body 不滚,滚动全部收敛到内部容器;
       外层改纵向:顶部是页面头(PageHeader,下载控制在它的工具栏行里),下面才是「左列表 + 主区」的横向排布 */
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, overflow: 'hidden' }}>
      {/* 页面头(spec D2):① 来源 logo + 标题 ② 工具栏。
          工具栏 = 清晰度档位 Radio + 下载按钮 + 删除来源(2026-09-30 Task 7:资料库收敛为纯视频下载,
          产物类型 Radio/音频格式 Radio/音频批量下载已移除——音频一律从剪辑获得,spec D4 修订)。
          传 Fragment,让 PageHeader 工具栏行的 flex(gap:8 + wrap)直接排布各控件。 */}
      {/* 未选来源时不渲染页面头(2026-09-30 Task 8):导航 Tab 已常亮「资料库」,空态下再印一遍是重名;
          选中来源后 title=来源名,与 Tab 不重名,恢复渲染。空态页面 = 左列表 + 引导空态,无功能损失 */}
      {detail !== null && (
        <PageHeader
          icon={detail === null ? undefined : <SiteLogo site={detail.site} size={20} />}
          title={detail === null ? '资料库' : detail.title}
          meta={
            detail !== null && detail.duration_sec !== null
              ? `时长 ${Math.floor(detail.duration_sec / 60)} 分 ${Math.round(detail.duration_sec % 60)} 秒`
              : undefined
          }
          toolbar={
            <>
              {/* 清晰度档位(素材按档位下载;2026-09-30 Task 4+5 引入,Task 7 起常驻——不再有 audio/video 模式切换);
                  playlist 未选集时下载按钮禁用(无可下对象)。视频素材固定带 mp3 音轨(payload 硬编码 format:'mp3') */}
              {detail !== null && (
                <Radio.Group
                  value={videoHeight}
                  optionType="button"
                  options={[{ label: '360p', value: 360 }, { label: '480p', value: 480 }, { label: '720p', value: 720 }, { label: '1080p', value: 1080 }]}
                  onChange={(e) => setVideoHeight(e.target.value as 360 | 480 | 720 | 1080)}
                />
              )}
              {detail !== null && (
                <Button
                  type="primary"
                  onClick={onDownloadVideo}
                  loading={busy}
                  disabled={busy || (detail.kind === 'playlist' && videoSelectedIndex === null)}
                >
                  下载
                </Button>
              )}
              {/* 删除来源:danger(动作从 Card extra 上移,Task 3) */}
              {detail !== null && (
                <Button type="primary" danger onClick={() => onDeleteSource(detail.id)}>删除来源</Button>
              )}
            </>
          }
        />
      )}
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
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

        {/* 右:选中来源详情(占满内容区宽高;卡内只有集数网格一个滚动区,body 不滚)。
            集数网格 = 单选卡片(2026-09-30 Task 4+5,点集=选中,下载=下载/替换该集素材;Task 7 起为页面唯一网格)。
            旧「视频预览剪音频」面板已从资料库移除,剪辑功能 P4 于剪辑室详情页回归 */}
        <div style={{ flex: 1, minWidth: 0, padding: 16, display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}>
          {error !== null && <Alert type="error" showIcon message={error} style={{ marginBottom: 12, flexShrink: 0 }} />}
          {detail === null && error === null && <Empty description="从左侧选择一个来源,或点「+ 新导入」" style={{ marginTop: 80 }} />}
          {detail !== null && (
            <Card
              title={null}   /* 标题已抬到页面头(D2),卡里不再重复;下载/删除来源在页面头工具栏 */
              style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
              styles={{ body: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' } }}
            >
              {/* 封面/视频共用位(Task 9):解析后=封面,下载后同一位变视频预览,填掉主内容区的空白。
                  无素材 → 封面 <img>(onError 回退灰底+SiteLogo+引导文案);有素材 → <video controls>(封面退居 poster)。
                  cache-buster:素材替换后 mediaFileUrl(id) 恒定,<video> 会吃缓存不刷新——版本串用 created_at +
                  mediaRev 组合(2026-09-30 修复轮:服务端 upsert 不更新 created_at,换集/重下后纯 created_at 不变;
                  mediaRev 在视频下载完成 onDone 里 +1,保证版本串必变),&v= 强制重载(URL 已带 ?token=,
                  只能用 & 追加),key 同步随版本串变,素材更换时强制重建 <video> 元素(src 改属性在部分浏览器
                  不保证重新拉流)。 */}
              {detail !== null && (currentMaterial === undefined || videoFailed) && (
                coverFailed ? (
                  <div style={{ width: '100%', aspectRatio: '16 / 9', borderRadius: 8, background: '#fafafa', border: '1px dashed #d9d9d9', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, flexShrink: 0 }}>
                    <SiteLogo site={detail.site} size={32} />
                    <Typography.Text type="secondary">下载后此处显示视频预览</Typography.Text>
                  </div>
                ) : (
                  <img
                    src={coverUrl(detail.id)}
                    alt={detail.title}
                    onError={() => { setCoverFailed(true); logFe('debug', `library cover onError import=${detail.id} → 回退灰底引导`); }}
                    style={{ width: '100%', aspectRatio: '16 / 9', objectFit: 'cover', borderRadius: 8, display: 'block', background: '#000', flexShrink: 0 }}
                  />
                )
              )}
              {detail !== null && currentMaterial !== undefined && !videoFailed && (
                <video
                  key={`${currentMaterial.created_at}-${mediaRev}`}
                  controls
                  src={`${mediaFileUrl(detail.id)}&v=${encodeURIComponent(currentMaterial.created_at)}-${mediaRev}`}
                  poster={coverUrl(detail.id)}
                  onError={() => { setVideoFailed(true); setError('视频素材文件已丢失，请重新下载'); logFe('error', `library video onError import=${detail.id} → 回退封面态`); }}
                  style={{ width: '100%', aspectRatio: '16 / 9', background: '#000', borderRadius: 8, flexShrink: 0 }}
                />
              )}
              {/* 集数区 = 卡内唯一滚动区:标题固定在上,格子网格在本区内滚 */}
              {/* 单选网格(2026-09-30 Task 4+5 方案 A):一次只选一集,点卡片=选中,下载按钮提交选中集。
                  容器视觉沿用 auto-fit 网格;选中=蓝框(#1677ff)+蓝底(#e6f4ff);
                  当前素材所在集显示 D20「当前素材」标记;kind='single' 不渲染网格(档位+下载直下) */}
              {detail.kind === 'playlist' && detail.entries !== null && (
                <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, marginTop: 12 }}>
                  <Typography.Title level={5} style={{ marginTop: 0, flexShrink: 0 }}>集数({detail.entries.length})</Typography.Title>
                  <div style={{ display: 'block', width: '100%', flex: 1, minHeight: 0, overflowY: 'auto', paddingRight: 4 }}>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 8, width: '100%' }}>
                      {detail.entries.map((e) => {
                        const selected = videoSelectedIndex === e.index;
                        const isMaterial = currentMaterialEp === e.index;
                        return (
                          <div
                            key={e.index}
                            role="button"
                            tabIndex={0}
                            onClick={() => onEntryClick(e.index)}
                            onKeyDown={(ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); onEntryClick(e.index); } }}
                            style={{
                              minWidth: 0,
                              border: selected ? '1px solid #1677ff' : '1px solid #f0f0f0',
                              borderRadius: 8,
                              padding: '6px 10px',
                              background: selected ? '#e6f4ff' : 'transparent',
                              cursor: 'pointer',
                            }}
                          >
                            <Typography.Text ellipsis style={{ maxWidth: '100%' }} title={e.title}>{e.title}</Typography.Text>
                            {isMaterial && <Tag color="blue" style={{ marginInlineEnd: 0, marginTop: 2 }}>当前素材</Tag>}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              )}
              {jobId !== null && done === null && (
                <div style={{ marginTop: 16, flexShrink: 0 }}>
                  {/* 两段式进度条(2026-09-29 用户拍板):① 下载(蓝) ② 登记素材(绿)。
                      为什么必须分段:下载字节跑完 ≠ 素材已登记完——后端还要 ffprobe 测时长、改名、写库(实测约 4 秒),
                      这段没有可上报的百分比,所以第二段用 antd 的 active 动画表示「正在进行中」(不是假进度)。
                      之前只有一根条:它停在 100% 而库里还是空的,用户以为下好了就切走(真实踩的坑)。
                      strokeLinecap=butt 让两段并排时看起来是一根连续的条。 */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                    <Progress
                      percent={percent}
                      showInfo={false}
                      strokeColor="#1677ff"
                      strokeLinecap="butt"
                      status={phase === 'download' ? 'active' : undefined}
                      style={{ flex: 1, marginBottom: 0 }}
                    />
                    <Progress
                      percent={phase === 'ingest' ? 100 : 0}
                      showInfo={false}
                      strokeColor="#52c41a"
                      strokeLinecap="butt"
                      status={phase === 'ingest' ? 'active' : undefined}
                      style={{ flex: 1, marginBottom: 0 }}
                    />
                  </div>
                  <Space size={12} style={{ marginTop: 4 }}>
                    <Typography.Text style={{ fontSize: 12 }}>
                      <span style={{ color: '#1677ff' }}>① 下载</span> {phase === 'download' ? `${percent}%` : '完成'}
                    </Typography.Text>
                    <Typography.Text style={{ fontSize: 12 }}>
                      <span style={{ color: '#52c41a' }}>② 登记素材</span> {phase === 'ingest' ? '中…(正在登记视频素材,稍等)' : '待开始'}
                    </Typography.Text>
                  </Space>
                  <div style={{ marginTop: 8 }}>
                    <Button size="small" onClick={() => cancelJob(jobId)}>取消</Button>
                  </div>
                </div>
              )}
              {done !== null && <Alert type="success" showIcon message={done} style={{ marginTop: 16, flexShrink: 0 }} />}
            </Card>
          )}
        </div>
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
