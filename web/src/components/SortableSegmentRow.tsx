// 剪辑点列表的**单行**（spec D7/D8，2026-10-09 用户反馈图 8/图 9）。
// 两处改动：
//   ① 排序从「上移/下移按钮」换成**拖拽**（dnd-kit sortable）。只有左侧把手能拖（不整行拖）——
//      整行拖会与行内的拖边微调把手打架，用户想微调某段时会误触发整行搬家。
//   ② 列宽固定：序列/时间段/时长/删除按钮各自定宽，只有标签框自适应 —— 解决跨行对不齐。
// ⚠️ 本组件是**纯展示 + 事件回调**，不碰任何业务逻辑（增删改排序由父组件 setSegs 统一走）。
import { DeleteOutlined, HolderOutlined } from '@ant-design/icons';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Button, Input, Tag, Tooltip, Typography } from 'antd';
import { cyberColors, cyberFontStack } from '@/setup/theme';
import { fmtTime } from '@/time';
import './segment-row.css';

export interface SortableSegmentRowProps {
  index: number;
  seg: { start_sec: number; end_sec: number; label: string | null };
  selected: boolean;
  readOnly: boolean;
  onSelect: (index: number) => void;
  onDelete: (index: number) => void;
  onLabelChange: (index: number, label: string) => void;
}

/**
 * 段行的 dnd-kit id。**父组件的 SortableContext items 与 onDragEnd 反查必须用这个函数**，
 *不要在各处手写模板字符串 —— 三处各写一份时任何一处漂移，dnd-kit 会静默认不出行、排序落到错误的行上。
 */
export const segKey = (seg: { start_sec: number; end_sec: number }, index: number): string =>
  `${seg.start_sec}-${seg.end_sec}-${index}`;

export default function SortableSegmentRow({
  index, seg, selected, readOnly,
  onSelect, onDelete, onLabelChange,
}: SortableSegmentRowProps) {
  // ⚠️ id 用「起止时间 + 当前下标」而非**纯**数组下标，也不用纯起止时间（判据见上方 segKey 的注释处）：
//   ① 纯下标：删中间行后下标整体前移，而 dnd-kit 缓存的仍是旧下标 → 落位算错。
//   ② 纯起止时间（2026-10-09 审查第 1 轮 medium 修复前的老写法）：**会撞键**。
//      addSegment 的 start/end 全由播放头推出（current 起、固定 10 秒长），所以
//      「同一位置打点两次」或「同一处双击两次」会产出两段起止完全相同的段 → id 相同 →
//      dnd-kit 分不清是哪一行，onDragEnd 的 findIndex 还会返回**第一个**匹配 → 拖错行。
//      加下标后缀后「一次渲染内唯一」恒成立，撞键不可能；而下标只在增删/排序后变
//      （那些都发生在拖拽手势**之外**），不影响拖拽过程中 id 的稳定性。
//   为什么不给 EditSeg 加自增 id：改数据结构会牵连保存格式（PUT segments 的字段集），
//      代价远大于收益；id 只活在渲染期，不必持久化。
  // React 自己的渲染 key 仍用 index（在父组件 map 上），两套 key 别混。
  const segId = segKey(seg, index);
  // ⚠️ `disabled: readOnly` 是**行为**上的禁用，与原来的「上移/下移」按钮 disabled={readOnly} 同口径：
  //   只读态下保存已灰，拖拽排序同样是改数据 → 必须一并禁掉，否则用户能改却存不进。
  // isDragging 直接取 useSortable 的返回值（2026-10-09 审查第 2 轮）：它内部就是「本行是否正被拖」的真值，
  //   不必由父组件传 prop，也不必另加 activeId state —— segment-row.css 的 .is-dragging 规则由此变活。
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: segId, disabled: readOnly });

  return (
    <div
      ref={setNodeRef}
      className={`sr-row${isDragging ? ' is-dragging' : ''}`}
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

      <span className="sr-index sr-no-drag" style={{ display: 'flex' }}>
        <Tag color="blue" style={{ marginInlineEnd: 0, borderRadius: 0, fontFamily: cyberFontStack }}>{index + 1}</Tag>
      </span>

      <Typography.Text className="sr-span" style={{ fontFamily: cyberFontStack, color: cyberColors.cyan }}>
        {fmtTime(seg.start_sec)} - {fmtTime(seg.end_sec)}
      </Typography.Text>

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

      <Tooltip title={readOnly ? '只读态不能删除' : '删除这一段'}>
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
