// 剪辑点列表的**单行**（spec D7/D8，2026-10-09 用户反馈图 8/图 9）。
// 两处改动：
//   ① 排序从「上移/下移按钮」换成**拖拽**（dnd-kit sortable）。只有左侧把手能拖（不整行拖）——
//      整行拖会与行内的拖边微调把手打架，用户想微调某段时会误触发整行搬家。
//   ② 列宽固定：序列/时间段/时长/删除按钮各自定宽，只有标签框自适应 —— 解决跨行对不齐。
// ⚠️ 本组件是**纯展示 + 事件回调**，不碰任何业务逻辑（增删改排序由父组件 setSegs 统一走）。
import { DeleteOutlined, HolderOutlined, PauseOutlined, PlayCircleOutlined } from '@ant-design/icons';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Button, Input, Tooltip, Typography, type InputRef } from 'antd';
import { useRef, useState } from 'react';
import { cyberColors, cyberFontStack } from '@/setup/theme';
import { fmtTime, fmtTimeMs, parseTimeMs } from '@/time';
import './segment-row.css';

/**
 * 起止时间框（2026-10-13 spec §4.2）：可输入 + 上下按钮 ±16 毫秒。
 *
 * ⚠️ **为什么输入框用 draft state**：用户键入过程中会逐字符改值（想把 `01:23.456` 改成 `01:30.000`，
 *   中途会出现 `01:23.4`、`01:23.`、`01:2` …）。若每次 onChange 都提交，value 被父组件 state 反灌
 *   会把输入内容抢走（刚敲下 `01:2` 就被 clamp 后的值替换，根本敲不完）。故：键入期间由 draft 接管，
 *   失焦或回车才提交。
 *
 * ⚠️ **clamp 与吸附不在这里做**：全在父组件的 clampSegTime（统一判定处）。本组件只负责
 *   「收集用户输入 → 交给父组件」—— 本仓已为「同一判定散在多处必然漂移」留过教训（addBlockReason 的旧事）。
 */
function SegTimeBox({
  value, edge, index, disabled, disabledReason, onSelect, onCommit,
}: {
  value: number;
  edge: 'start' | 'end';
  index: number;
  disabled: boolean;
  /** 禁用原因（本仓约定 D13：禁用要给出可见原因）。有值且 disabled 时用 Tooltip 展示。 */
  disabledReason?: string;
  onSelect: () => void;
  onCommit: (sec: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const inputRef = useRef<InputRef>(null);
  /** 这次聚焦是 step() 程序发起的（用于跳过 onSelect 选行）。见 onFocus 处注释。 */
  const focusingByStep = useRef(false);
  // 非键入态显示 mm:ss.mmm —— 看得见毫秒，16ms 的步进才看得出变化（spec D4）
  const shown = draft ?? fmtTimeMs(value);
  const commit = (raw: string): void => {
    setDraft(null);
    const t = parseTimeMs(raw); // 支持 mm:ss.mmm / ss.mmm / 纯数字
    if (t !== null) onCommit(t);
    // t === null（敲了非法内容）→ 什么都不做，draft 清空后自动回显真值。
    //   不弹错误、不保留草稿：用户敲错一个字符不该被拦下（spec D7）。
  };
  // 步进：±16 毫秒。**键盘 ↑/↓ 与鼠标点 ▴▾ 走的是同一个函数**（spec D5）。
  // ⚠️ 步进后**主动把焦点放回输入框**：这样连点 ▴ 不用重新点输入框、方向键也能接着用。
  //   用 setTimeout(0) 而不是直接 focus()：直接调会早于 React 把新值渲染进 DOM，
  //   光标可能落在旧文本的末尾（表现为「焦点到了但位置不对」）。
  const step = (deltaSec: number): void => {
    // 2026-10-13 review bug·medium：步进前先取正在敲的草稿——否则 ▴▾/方向键会把
    //   未回车的内容直接丢掉（setDraft(null) 清空、从已提交的 value 步进），
    //   用户刚敲的字凭空消失，数值从旧的已提交值跳（Firefox/Safari 点按钮不 blur 输入框也能踩到）。
    const typed = draft === null ? null : parseTimeMs(draft);
    setDraft(null);
    onCommit((typed ?? value) + deltaSec);
    focusingByStep.current = true;
    window.setTimeout(() => {
      inputRef.current?.focus();
      // 焦点事件是同步派发的，这里再撤标记即可（留一帧余量防 antd 异步派发）
      window.setTimeout(() => { focusingByStep.current = false; }, 0);
    }, 0);
  };
  const btn = (deltaSec: number, label: string, glyph: string) => (
    <span className="sr-time-step sr-no-drag">
      <button
        type="button"
        className="sr-time-step-btn"
        disabled={disabled}
        aria-label={`${label} ${Math.round(Math.abs(deltaSec) * 1000)} 毫秒`}
        title={`${label} ${Math.round(Math.abs(deltaSec) * 1000)} 毫秒（快捷键 ↑↓）`}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => { e.stopPropagation(); step(deltaSec); }}
      >{glyph}</button>
    </span>
  );
  return (
    // ⚠️ Tooltip 直接包根 span（DOM 元素，可被 antd Tooltip 附加）；disabledReason 为空时无提示、不影响布局。
    <Tooltip title={disabledReason ?? ''}>
    <span className="sr-time-box sr-no-drag" style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
      {btn(-0.016, `第 ${index + 1} 段${edge === 'start' ? '开始' : '结束'}时间减`, '▾')}
      <Input
        ref={inputRef}
        className="sr-time"
        size="small"
        value={shown}
        disabled={disabled}
        aria-label={`第 ${index + 1} 段${edge === 'start' ? '开始' : '结束'}时间（上下方向键调整 16 毫秒）`}
        // ⚠️ onFocus 只在「用户自己点进来 / Tab 进来」时选中整行；
        //   step() 里程序 focus() 也会触发它 —— 那会让「点一下 ▴」整行闪红，属打扰。
        //   用 focusingByStep 挡掉程序性聚焦。
        onFocus={() => { if (!focusingByStep.current) onSelect(); }}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={(e) => commit(e.target.value)}
        onPressEnter={(e) => commit((e.target as HTMLInputElement).value)}
        // ⚠️ **键盘 ↑/↓ = ±16 毫秒**（spec D5）。antd Input 会把 ↑/↓ 绑给自己的增减，
        //   这里抢过来自己处理：onKeyDown 里 preventDefault 后不再冒泡给 antd，
        //   所以 antd 那套「±1」不会叠加执行。
        // ⚠️ Shift/Alt 加修饰键时不拦截（留给系统/输入法；也避免 Shift+↑ 这类组合行为诡异）。
        onKeyDown={(e) => {
          if (disabled) return;
          if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
          if (e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return;
          e.preventDefault();     // 阻止 antd Input 的默认增减
          e.stopPropagation();    // 不让它冒泡到行/列表的快捷键处理
          step(e.key === 'ArrowUp' ? 0.016 : -0.016);
        }}
      />
      {btn(0.016, `第 ${index + 1} 段${edge === 'start' ? '开始' : '结束'}时间加`, '▴')}
    </span>
    </Tooltip>
  );
}

export interface SortableSegmentRowProps {
  index: number;
  /** 同一组起止时间里本段是第几个（父组件用 useMemo 算出）。**只有 segKey 需要它**，
   *  别拿 index 当 occurrence 用 —— 下标会随重排变化，id 变了就触发库的重测与补间动画（见 segKey 注释）。 */
  occurrence: number;
  seg: { start_sec: number; end_sec: number; label: string | null };
  selected: boolean;
  readOnly: boolean;
  /** 序号框是否播一次 RGB 色散。**只在本行序号刚刚变化的那一次为 true**——
   *  若让它长时间为 true，动画会在后续任何重渲染时重播（CSS animation 在 class 还在时就一直在跑/重跑）。 */
  glitch: boolean;
  /** 第几次色散（全局递增，每次 flashIndex 自增）。**用作序号框的 React key**——
   *  CSS animation 只在元素挂上 class 那一刻开播，class 名不变就不会重播。
   *  而「把 1↔2 换回来」这种输入两次 flash 的 id 集合完全相同，class 全程没掉过 → 第二次零反馈；
   *  靠 key 递增强制重建元素 → animation 从头播，**且不依赖任何时序**（不靠「先清空再下一帧加回」）。
   *  代价：每次 flash 重建**所有行**的序号框（DOM 节点只有 4 个 span，可忽略），行为上看不出来。 */
  glitchSeq: number;
  onSelect: (index: number) => void;
  onDelete: (index: number) => void;
  onLabelChange: (index: number, label: string) => void;
  /**
   * 改起止时间。**传进来的是用户想要的值，clamp 与吸附全在父组件做**（clampSegTime），
   * 行内不重复判定 —— 本仓已为「同一个判定散在多处必然漂移」留过教训（addBlockReason 三份判定的旧事）。
   * @param nextSec 用户输入/步进给出的秒数（可能越界，由父组件夹）
   */
  onTimeChange: (index: number, edge: 'start' | 'end', nextSec: number) => void;
  /** 段播放按钮点击（Task 5）。**只读态禁用**（spec D13）：只读 = 资料已删除 / 没有视频素材 → 无源可播。 */
  onPlaySegment: (index: number) => void;
  /** 该段是否正在播放（决定按钮图标与行高亮）。 */
  playing: boolean;
  /** 只读原因文案（父组件算出）。播放按钮置灰时用它做 Tooltip。 */
  readOnlyMsg: string | null;
  /** 时间编辑器是否禁用（父组件算：duration 未就绪时为 true）。与 readOnly 分开——只禁时间，不禁删除/排序/标签。 */
  timeDisabled: boolean;
  /** timeDisabled 的可见原因（D13）。非 null 时作 SegTimeBox 的 Tooltip，别让禁用控件「灰得没理由」。 */
  timeDisabledMsg: string | null;
}

/**
 * 段行的 dnd-kit id。**父组件的 SortableContext items 与 onDragEnd 反查必须用这个函数**，
 * 不要在各处手写模板字符串 —— 三处各写一份时任何一处漂移，dnd-kit 会静默认不出行、排序落到错误的行上。
 *
 * `occurrence` = **同一组起止时间里，这个段是第几个**（由父组件用 `segOccurrences` 算出，不是数组下标）。
 *
 * ⚠️ **为什么 id 里绝不能带数组下标**（2026-10-09 用户实测报的现象，根因已定位到库源码）：
 *   带下标时，`arrayMove` 换位后**每一行的 id 都变了** → dnd-kit 的
 *   `itemsHaveChanged = !itemsEqual(items, previousItemsRef.current)`
 *   （node_modules/@dnd-kit/sortable/dist/sortable.esm.js:313）为真 → 触发
 *   `measureDroppableContainers(items)` 重新量（:317-319）+ `useDerivedTransform`
 *   （:546）再补一段 transition。表现：**数据已换位（看起来对），但动画又播了一遍 1↔2 对调**。
 *   即「放下后多闪一次交换动画」。dnd-kit 内部按 `active.id` 反查位置（:310
 *   `items.indexOf(active.id)`），id 必须跨重排稳定。
 *
 *⚠️ 为什么不用纯 `${start}-${end}`：会撞键。addSegment 的 start/end 全由播放头推出
 *   （current 起、固定 10 秒长），「同一位置打点两次」会产出两段起止完全相同的段 → id 相同 →
 *   `onDragEnd` 的 findIndex 返回**第一个**匹配 → 拖错行。
 *   加 occurrence 后「同一渲染内唯一」恒成立，且它跟着**数据**而不是位置走，重排时不变。
 */
export const segKey = (seg: { start_sec: number; end_sec: number }, occurrence: number): string =>
  `${seg.start_sec}-${seg.end_sec}#${occurrence}`;

export default function SortableSegmentRow({
  index, occurrence, seg, selected, readOnly, readOnlyMsg, timeDisabled, timeDisabledMsg, glitch, glitchSeq,
  onSelect, onDelete, onLabelChange, onTimeChange, onPlaySegment, playing,
}: SortableSegmentRowProps) {
  // id = 起止时间 + occurrence。**不要改成数组下标** —— 判据与踩坑见上方 segKey 的注释：
  //   下标随重排变化会让 id 全变，dnd-kit 判定「位置又变了」→ 放下瞬间多播一遍交换动画（用户实测报过）。
  //   也不要用纯起止时间（会撞键：同一位置打点两次会产出两段起止相同的段）。
  // 为什么不给 EditSeg 加自增 id：改数据结构会牵连保存格式（PUT segments 的字段集），
  //   代价远大于收益；id 只活在渲染期，不必持久化。
  const segId = segKey(seg, occurrence);
  // ⚠️ `disabled: readOnly` 是**行为**上的禁用，与原来的「上移/下移」按钮 disabled={readOnly} 同口径：
  //   只读态下保存已灰，拖拽排序同样是改数据 → 必须一并禁掉，否则用户能改却存不进。
  // isDragging 直接取 useSortable 的返回值（2026-10-09 审查第 2 轮）：它内部就是「本行是否正被拖」的真值，
  //   不必由父组件传 prop，也不必另加 activeId state —— segment-row.css 的 .is-dragging 规则由此变活。
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: segId, disabled: readOnly });

  // 2026-10-13 review style·low：播放按钮 Tooltip 文案提为变量，避免嵌套三元（项目规则禁）。
  // readOnly 时 readOnlyMsg 由父页保证非空（readOnly = readOnlyMsg !== null），与删除按钮同款口径。
  let playTitle: string | null;
  if (readOnly) playTitle = readOnlyMsg;
  else playTitle = playing ? '停止播放这一段' : '播放这一段';

  return (
    <div
      ref={setNodeRef}
      className={`sr-row${isDragging ? ' is-dragging' : ''}${playing ? ' is-playing' : ''}`}
      onClick={() => onSelect(index)}
      style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px',
        background: selected ? cyberColors.redSoft : 'transparent',
        border: `1px solid ${selected ? cyberColors.borderRed : cyberColors.borderWhite}`,
        transform: CSS.Transform.toString(transform),
        transition,
        // ⚠️ 拖起的行必须抬到同层之上（2026-10-09 审查第 9 轮 low）：拖拽时其它行也各自带 transform，
        //   各自形成层叠上下文，同层内按 DOM 顺序绘制 → **后**面的兄弟会盖住被拖的行（它DOM 在前）。
        //   症状：拖拽中该行看起来从「被挤开的那一行」底下滑过去，与 .is-dragging 的半透明叠在一起更明显。
        //   flex 子项即便 position:static，z-index 非 auto 也会建层叠上下文，故这样写即生效。
        zIndex: isDragging ? 1 : 0,
        borderRadius: 0,
      }}
    >
      {/* 拖拽把手：attributes/listeners **只挂这里**，行本身不挂 → 只有抓把手才拖得动。
          只读态换 not-allowed 光标并给 aria-disabled，让「为什么拖不动」看得见。 */}
      <span
        ref={setActivatorNodeRef}
        className={`sr-handle sr-no-drag${readOnly ? ' sr-disabled' : ''}`}
        {...attributes}
        {...listeners}
        // ⚠️ setActivatorNodeRef 挂在**激活元素**（把手）上，不是整行（2026-10-09 审查第 9 轮 low）：
        //   dnd-kit 用它量拖拽起始rect（core.esm.js:2732 遍历 activatorNode/node）。
        //   不挂也能跑（core.esm.js:2727 会回退到 node），但那量的是**整行**的矩形，
        //   而把手只占24px 宽 → 起始基准偏大，拖拽起手会有一顿挫的错位感。
        // 放在 attributes 之后：dnd-kit 的 attributes 自带 aria-disabled，写在前面会被它覆盖（TS2783）
        aria-disabled={readOnly}
        aria-label={`拖动第 ${index + 1} 段调整顺序`}
      >
        <HolderOutlined />
      </span>

      {/* 序号框：段序变化时**唯一**做动画的元素（2026-10-09 用户定案：整行动画太吵，只动序号框）。
          三层叠出RGB 色散：红残影 / 蓝残影 / 本体。glitch 由父组件在「序号真的变了」那一轮传 true。
          ⚠️ 原来是 antd<Tag color="blue">，换成手写是为了拿到这三层结构；配色保持一致（半透明青底 + 青字）。 */}
      <span className="sr-index sr-no-drag" style={{ display: 'flex' }}>
        {/* ⚠️ 残影与噪点层必须 aria-hidden（2026-10-10 审查 low）：辅助技术**不理会 opacity:0**，
            同一个序号在 DOM 里出现三份 → 读屏会把「第 3 段」播报成三遍。噪点层是纯装饰（无文本），
            一并标上是为了让「这三层都不是内容」这件事在标记上自洽。 */}
        {/* ⚠️ key={glitchSeq} 是「动画能重播」的唯一保证（2026-10-10 审查 low）：
            class 名不变时 React 不写 DOM，CSS animation 不会重新开播 —— 表现是「第二次换位没动画」。
            序号框内部只有 4 个 span，重建成本可忽略；不能改成改 class 名（is-glitch→is-glitch-2 之类），
            那会让 CSS 选择器与 class 名互相绑死，且「改名能否触发重播」取决于浏览器是否重启同名动画 —— 不确定，别走这条路。 */}
        <span key={glitchSeq} className={`sr-no${glitch ? ' is-glitch' : ''}`}>
          <span className="sr-no-noise" aria-hidden="true" />
          <span className="sr-no-ghost sr-no-ghost-r" aria-hidden="true">{index + 1}</span>
          <span className="sr-no-ghost sr-no-ghost-b" aria-hidden="true">{index + 1}</span>
          <span className="sr-no-num">{index + 1}</span>
        </span>
      </span>

      {/* 起止时间：可编辑输入框 + 上下按钮 ±16 毫秒（2026-10-13 spec §4.2）。
          替换掉原来的纯文本 `.sr-span`。**时长列仍在右边、仍用 fmtTime 到秒** ——
          时长是概览信息不需要毫秒，且它与两个可编辑框是不同语义区。 */}
      <SegTimeBox
        value={seg.start_sec}
        edge="start"
        index={index}
        disabled={readOnly || timeDisabled}
        disabledReason={timeDisabled ? (timeDisabledMsg ?? undefined) : undefined}
        onSelect={() => onSelect(index)}
        onCommit={(sec) => onTimeChange(index, 'start', sec)}
      />
      <span className="sr-time-sep sr-no-drag" aria-hidden="true">→</span>
      <SegTimeBox
        value={seg.end_sec}
        edge="end"
        index={index}
        disabled={readOnly || timeDisabled}
        disabledReason={timeDisabled ? (timeDisabledMsg ?? undefined) : undefined}
        onSelect={() => onSelect(index)}
        onCommit={(sec) => onTimeChange(index, 'end', sec)}
      />

      <Typography.Text className="sr-dur" type="secondary" style={{ fontSize: 12, fontFamily: cyberFontStack, color: cyberColors.cyan }}>
        时长 {fmtTime(seg.end_sec - seg.start_sec)}
      </Typography.Text>

      <Input
        className="sr-label sr-no-drag"
        size="small"
        placeholder="标签（可空）"
        value={seg.label ?? ''}
        maxLength={100}
        disabled={readOnly}
        onFocus={() => onSelect(index)}
        onChange={(e) => onLabelChange(index, e.target.value)}
      />

      {/* 单段播放：播这一段（spec D10）。⚠️ 必须 stopPropagation —— 行的 onClick 会 setSelected(index)，
          不拦会同时触发选中（与删除按钮同款理由，见下方 onDelete 的注释）。
          ⚠️ 只读态**禁用**（spec D13）：只读 = 资料已删除 / 没有视频素材（studio-detail.tsx:1038-1042）
          → <video> 没有源可播。判据是「有没有源可播」，不是「改不改数据」。与 playSegment 里的守卫同口径。
          ⚠️ readOnly 由父页 readOnly = readOnlyMsg !== null 推出 → readOnly 为真时 readOnlyMsg 必非空，
          `?? '资料不可用'` 是运行期死代码（2026-10-13 review maintainability·medium，与删除按钮同款口径）。 */}
      <Tooltip title={playTitle}>
        {/* 包 span：antd Tooltip 对 disabled 按钮收不到鼠标事件（与下方删除按钮同款） */}
        <span className="sr-play sr-no-drag" style={{ display: 'flex' }}>
          <Button
            size="small"
            type="text"
            icon={playing ? <PauseOutlined /> : <PlayCircleOutlined />}
            disabled={readOnly}
            aria-label={playing ? `停止播放第 ${index + 1} 段` : `播放第 ${index + 1} 段`}
            onClick={(e) => { e.stopPropagation(); onPlaySegment(index); }}
            style={{ color: playing ? cyberColors.red : cyberColors.cyan }}
          />
        </span>
      </Tooltip>

      <Tooltip title={readOnly ? readOnlyMsg : '删除这一段'}>
        {/* 包 span：antd Tooltip 对 disabled 按钮收不到鼠标事件 */}
        <span className="sr-del sr-no-drag" style={{ display: 'flex' }}>
          <Button
            size="small"
            type="text"
            icon={<DeleteOutlined />}
            disabled={readOnly}
            aria-label={`删除第 ${index + 1} 段`}
            // ⚠️ 必须 stopPropagation（2026-10-09 审查第 8 轮 low）：行的 onClick 会 setSelected(index)，
            //   而 removeSegment 刚置 selected=null —— 不拦住的话这个排队中的 setSelected 会把高亮
            //   改到index 上，而删完该行已前移，index 现在指向**下一段** → 「删掉一行，高亮跳到另一行」。
            onClick={(e) => { e.stopPropagation(); onDelete(index); }}
            style={{ color: cyberColors.red }}
          />
        </span>
      </Tooltip>
    </div>
  );
}
