// 标题内联编辑（2026-10-09 用户要求）：文本态显示作品名 + 编辑图标，**双击**或点图标 → 输入框；
//   输入框右侧内嵌「扫描光带」保存动画（不是 spinner）；回车或失焦即提交；提交完成收回文本态。
//   父组件只需给 value + onSave —— 动画三态、成功/失败反馈、退出时机都在这里，不外泄。
import { EditOutlined } from '@ant-design/icons';
import { Input, Tooltip, type InputRef } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { cyberColors, cyberFontStack } from '@/setup/theme';
import './EditableTitle.css';

/** 动画三态：idle 待命（不出动画）/ saving 提交中（光带扫）/ done 已存（横线淡出 → 落勾） */
type Phase = 'idle' | 'saving' | 'done';

/** saving 至少显示这么久：本机 PUT 通常 20~60ms 就回，动画一帧就过 → 用户只看到「闪一下」，
 *  等于没有反馈（用户反馈「没有动」的第 1 条）。下限保证「扫」这个动作肉眼可见。
 *  ⚠️ 必须是 CSS 里et-sweep 往返周期（0.2s+0.2s）的**整数倍**，否则收回输入框时光带停在半路。 */
const MIN_SAVING_MS = 800;
/** done 至少显示这么久：横线淡出 0.14s + 勾描线（延后 0.2s 起、0.3s 长）= 0.5s 画完，
 *  再留 0.12s 让「已成」的印象停住再收回。 */
const MIN_DONE_MS = 620;

const sleep = (ms: number): Promise<void> => new Promise((r) => window.setTimeout(r, ms));

export interface EditableTitleProps {
  /** 已保存的值（null = 服务端存的是无名字） */
  value: string | null;
  /** 无名字时文本态显示的占位文案 */
  placeholder: string;
  /** 只读态（资料已删 / 无素材）：完全不可编辑 */
  disabled?: boolean;
  /** 提交。resolve = 成功，reject = 失败（失败时**不收回**输入框，让用户能改完再试）。
   *  传 null 表示「清空名字」（用户把输入框删空了），与服务端口径一致。 */
  onSave: (next: string | null) => Promise<void>;
  /** 文本态最大宽度（px）：超出省略号。防止超长作品名把右侧工具栏按钮挤到溢出。
   *  必须**大于**编辑态输入框的 460px（EditableTitle.css）—— 文本区是可读区，输入框只是改字的地方。 */
  maxWidth?: number;
}

/** 「扫描光带」保存动画。20px 高，藏在输入框 suffix 里；纯 CSS 动画（见 EditableTitle.css） */
function SaveGlyph({ phase }: { phase: Phase }) {
  return (
    <span className={`et-save is-${phase}`} aria-hidden="true">
      <span className="et-save-track"><span className="et-save-fill" /></span>
      <span className="et-save-scan" />
      <svg className="et-save-check" viewBox="0 0 24 24">
        <path d="M5 12.5l4.5 4.5L19 7.5" />
      </svg>
    </span>
  );
}

export default function EditableTitle({ value, placeholder, disabled = false, onSave, maxWidth = 560 }: EditableTitleProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const inputRef = useRef<InputRef | null>(null);
  // 在途守卫：回车提交到收回输入框之间，输入框**仍在**（成功才收回），这段时间里
  //   再按回车、或成功 setEditing(false) 让输入框卸载时浏览器补发的 blur，都会再调一次 commit
  //   → 同一个名字发两次 PUT（同名无害，但不同名时后一次用旧 value 校验会漏拦，且白白多一次往返）。
  const inFlight = useRef(false);
  // 本次编辑会话已「收尾」的标记：成功路径是 setEditing(false) 卸载输入框，浏览器会在卸载时补发 blur，
  //   而那一刻 inFlight 已被复位 → 守卫漏放，会再跑一次 commit（值已相同故不发 PUT，但仍是一次多余渲染，
  //   且若这中间父组件改了 value 就会误判）。置位后只由 enterEdit 复位。
  const closing = useRef(false);
  //⚠️ 这里**不要**加「组件是否还活着」的 ref（2026-10-09 踩过）：React 18 开发模式会
  //   「挂载 → 立刻卸载 → 再挂载」，`useEffect(() => () => { alive.current = false }, [])`
  //   的清理函数在那次**假卸载**时就把标记永久置假 → 之后 commit 里每道 `if (!alive) return`
  //   都直接退出 → 动画永远走不到 done、框也永远不收回（用户反馈「还是没看见动画」）。
  //   同款坑见 TaskDrawer.tsx 的 alive 注释（那边能用是因为请求就在 effect 内发起，本组件不行）。
  //   真的卸载后 setState 只是 React 警告、不崩溃，代价远小于「动画卡死」这个真 bug，故不设防。

  const enterEdit = (): void => {
    if (disabled) return;
    closing.current = false; // 复位：上一轮已收尾的标记不能带进这一轮
    inFlight.current = false;
    setDraft(value ?? '');
    setPhase('idle');
    setEditing(true);
  };

  // 进入编辑态后立刻全选：改名场景下「选中→打字」比「逐字删」快一个数量级
  useEffect(() => {
    if (!editing) return;
    const el = inputRef.current;
    if (el === null) return;
    el.focus();
    el.select();
  }, [editing]);

  const commit = async (): Promise<void> => {
    // 双重守卫：在飞（连按回车 / 保存期间被 disabled 触发的失焦） 或 本次会话已收尾（卸载补发的失焦）
    if (inFlight.current || closing.current) return;
    const next = draft.trim();
    // 与已存值相同：不发请求、不播动画，直接收回（否则每次点进点出都白跑一趟 PUT）
    if (next === (value ?? '')) {
      closing.current = true;
      setEditing(false);
      return;
    }
    inFlight.current = true;
    setPhase('saving');
    const startedAt = Date.now();
    try {
      await onSave(next === '' ? null : next);
    } catch {
      inFlight.current = false;
      setPhase('idle'); // 失败：留在输入框里，用户的字还在，可改完重试（父组件已弹错误 toast）
      // closing 保持 false —— 这次会话没结束，用户还要在这儿继续改
      return;
    }
    // saving 补足下限：本机 PUT 常在 60ms 内回，不补足动画只播一帧 → 用户看到的是「闪一下」
    const savingLeft = MIN_SAVING_MS - (Date.now() - startedAt);
    if (savingLeft > 0) await sleep(savingLeft);
    // 输入框**全程不卸载**，动画在框内播完再收回（2026-10-09 修：原来先收框、再在文本态补 1.6s 动画，
    //   用户反馈「输入框都消失了他还在」—— 过程都没了，只剩一个勾，读不出是「存成功了」还是「加载中」）
    setPhase('done');
    await sleep(MIN_DONE_MS);
    closing.current = true; // 必须在卸载输入框**之前**置位，见 closing 的注释
    inFlight.current = false;
    setEditing(false);
  };

  if (!editing) {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
        <span
          onDoubleClick={enterEdit}
          style={{
            maxWidth,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            cursor: disabled ? 'default' : 'text',
            color: value != null && value !== '' ? cyberColors.textPrimary : cyberColors.textMuted,
          }}
        >
          {value != null && value !== '' ? value : placeholder}
        </span>
        {disabled !== true && (
          <Tooltip title="改名">
            <button type="button" className="et-edit ant-btn" aria-label="改名" onClick={enterEdit}>
              <EditOutlined />
            </button>
          </Tooltip>
        )}
        {/* 文本态**不挂动画**（2026-10-09 修）：动画现在全程在输入框内播完才收回。
            原来在这里补一个 1.6s 的对勾，等于「框没了、勾还在」，用户反馈「输入框都消失了他还在」——
            反馈脱离了它描述的过程，就只剩一个孤立的符号，读不出含义。 */}
      </span>
    );
  }

  return (
    <Input
      ref={inputRef}
      className="et-input"
      size="small"
      value={draft}
      placeholder="给这个作品起个名"
      /* 保存期间禁掉：① 连按回车由 inFlight 拦，但禁掉更省一次无效渲染
         ② 让用户明确「这 ~1.5 秒是系统在做，不是没点上」 */
      disabled={disabled || phase !== 'idle'}
      maxLength={100}
      onChange={(e) => setDraft(e.target.value)}
      onPressEnter={() => { void commit(); }}
      onBlur={() => { void commit(); }}
      style={{ fontFamily: cyberFontStack }}
      suffix={<SaveGlyph phase={phase} />}
    />
  );
}