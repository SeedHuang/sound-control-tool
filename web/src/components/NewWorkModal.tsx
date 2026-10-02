// web/src/components/NewWorkModal.tsx
// 新建作品(spec clip-works D15):列「可剪的资料」(has_video=true)→ 选中 → POST /api/projects → 跳编辑页。
// 注意:has_video 只能保证「素材行在」,保证不了「文件还在」(文件可能被外部删了)——挡在前端的是假闸门,
// 所以创建失败必须把服务端的 error.next 原样显示出来(apiPost 已经拼好,这里不重写措辞)。
import { Alert, Button, Empty, Modal, Spin, Typography, message } from 'antd';
import { useNavigate } from '@umijs/max';
import { useEffect, useRef, useState } from 'react';
import { createWork, coverUrl, listImports, logFe, type ImportSource } from '@/api';
import SiteLogo, { siteColor } from './SiteLogo';

export interface NewWorkModalProps {
  open: boolean;
  onClose: () => void;
  /** 创建成功:回新作品 id(调用方负责跳 /studio/:id) */
  onCreated: (projectId: number) => void;
}

/** 一条可剪资料:封面 + 标题 + 「素材:第 N 集」+「用这个剪辑」。creating 非 null 时是本条在提交中 */
function ImportRow({ imp, creating, disabled, onCreate }: {
  imp: ImportSource;
  creating: boolean;
  disabled: boolean;
  onCreate: (imp: ImportSource) => void;
}): JSX.Element {
  const [coverBroken, setCoverBroken] = useState(false);
  const tint = siteColor(imp.site);
  // material_entry_index 是「这份素材在合集里的第几集」;单视频/存量数据可能为 null 或非整数
  // → 用 Number.isInteger 判定,拿不到就不显示这一段(别渲染出「第 null 集」)
  const ep = Number.isInteger(imp.material_entry_index) ? (imp.material_entry_index as number) : null;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0', borderBottom: '1px solid rgba(5,5,5,0.06)' }}>
      {/* 封面:有来源记录就试取图,取不到回退品牌纯色底 + SiteLogo(与作品卡 WorkCard 同款口径) */}
      <div style={{ width: 96, flexShrink: 0, aspectRatio: '16 / 9', borderRadius: 6, background: tint.bg, overflow: 'hidden' }}>
        {!coverBroken ? (
          <img
            src={coverUrl(imp.id)}
            alt=""
            loading="lazy"
            onError={() => setCoverBroken(true)}
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          />
        ) : (
          <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <SiteLogo site={imp.site} size={28} />
          </div>
        )}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <Typography.Text strong ellipsis={{ tooltip: imp.title }} style={{ display: 'block' }}>{imp.title}</Typography.Text>
        {ep !== null && (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>素材：第 {ep} 集</Typography.Text>
        )}
      </div>
      <Button type="primary" loading={creating} disabled={disabled && !creating} onClick={() => onCreate(imp)}>
        用这个剪辑
      </Button>
    </div>
  );
}

export default function NewWorkModal({ open, onClose, onCreated }: NewWorkModalProps) {
  const navigate = useNavigate();
  const [list, setList] = useState<ImportSource[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // in-flight 守卫:正在提交的那条 id(按钮转圈 + 其余按钮禁用),防连点建出两个作品
  const [creatingId, setCreatingId] = useState<number | null>(null);
  // 弹层是否还开着:用户在创建请求在途时按了 Esc / 点 X,回来后不该再把用户拽进编辑页(作品照样建好,
  // 用户下次进剪辑室能看到)。用 ref 而不是 state——onCreate 的 await 之后要立刻读到当前值。
  const openRef = useRef(open);
  useEffect(() => { openRef.current = open; }, [open]);

  // 关闭 / 创建成功后都要清干净,下次打开是干净的(否则会看到上次的资料列表和转圈按钮)
  const reset = (): void => {
    setList([]);
    setLoading(false);
    setError(null);
    setCreatingId(null);
  };

  // 拉可剪资料列表。抽成函数是为了让「重试」按钮能复用同一条路径(失败时用户只有一条 Alert,
  // 没有出口就只能关掉重开)。alive 由调用方给:effect 用它防卸载后 setState,重试按钮传 true 常量。
  const reload = (alive: () => boolean): void => {
    setLoading(true);
    listImports()
      .then((rows) => {
        if (!alive()) return;
        setList(rows.filter((r) => r.has_video)); // 「可剪」= 已登记视频素材(spec D15)
        setError(null);
      })
      .catch((e: unknown) => {
        if (!alive()) return;
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
        logFe('error', `新建作品弹层拉资料列表失败: ${msg}`);
      })
      .finally(() => { if (alive()) setLoading(false); });
  };

  useEffect(() => {
    if (!open) { reset(); return undefined; }
    let alive = true;
    reload(() => alive);
    return () => { alive = false; };
    // 只随 open 变化:弹层开着时不去后台轮询,用户看到的是打开那一刻的库(失败后由「重试」显式重拉)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const onCreate = async (imp: ImportSource): Promise<void> => {
    if (creatingId !== null) return; // 防连点:已有一条在提交
    setCreatingId(imp.id);
    logFe('info', `打开新建作品弹层选资料 import=${imp.id}`);
    try {
      const w = await createWork(imp.id);
      logFe('info', `新建作品成功 import=${imp.id} 作品=${w.id}`);
      if (!openRef.current) {
        // 弹层已被用户关掉:作品建好了,但不劫持导航(否则用户会在别的页面上被自己拽走)
        logFe('info', `新建作品成功但弹层已关闭,不自动跳转 import=${imp.id} 作品=${w.id}`);
        return;
      }
      reset();
      onCreated(w.id);
    } catch (e) {
      // 不重写措辞:apiPost 已把服务端 error.message + error.next 拼好,原样给用户
      const msg = e instanceof Error ? e.message : String(e);
      logFe('error', `新建作品失败 import=${imp.id}: ${msg}`);
      message.error(msg);
      setCreatingId(null);
    }
  };

  const onGoLibrary = (): void => {
    logFe('info', '新建作品空态 → 去资料库下载');
    onClose();
    navigate('/library');
  };

  return (
    <Modal title="新建作品" open={open} footer={null} onCancel={onClose} width={640}>
      {error !== null && (
        <Alert
          type="error"
          showIcon
          message={error}
          action={<Button size="small" onClick={() => reload(() => true)}>重试</Button>}
          style={{ marginBottom: 12 }}
        />
      )}
      {loading && <div style={{ textAlign: 'center', padding: '24px 0' }}><Spin /></div>}
      {!loading && list.length === 0 && error === null && (
        <Empty description="还没有可剪的视频素材">
          <Button type="primary" onClick={onGoLibrary}>去资料库下载</Button>
        </Empty>
      )}
      {!loading && list.length > 0 && (
        <div style={{ maxHeight: 360, overflowY: 'auto', paddingRight: 4 }}>
          {list.map((imp) => (
            <ImportRow
              key={imp.id}
              imp={imp}
              creating={creatingId === imp.id}
              disabled={creatingId !== null}
              onCreate={(x) => void onCreate(x)}
            />
          ))}
        </div>
      )}
    </Modal>
  );
}
