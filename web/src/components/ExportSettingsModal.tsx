// 导出设置对话框（spec D5，2026-10-09 用户反馈图 6）。
// 为什么从常驻搬进对话框：那 4 组控件常驻正文占一整块、离导出按钮又远，而它是低频操作。
// **本组件只管收参数并回调，不调任何接口** —— 导出逻辑（含 SSE 进度）留在父组件，
//   否则这份「进度只发一次」的逻辑会被复制两份。
import { Modal, Radio, Space, Tooltip, Typography } from 'antd';

export interface ExportSettingsModalProps {
  open: boolean;
  onClose: () => void;
  readOnly: boolean;
  /** 只读原因（可空）。本组件**独立**于父页面推导，`readOnly` 为真而本值为空是可能的
   *  （父页面目前恰好用 `readOnly = readOnlyMsg !== null`，但那是它的内部实现，不是本组件的契约）——
   *  故下面 Tooltip 里的 `?? 默认说明` 兜底是真会走到的，别当死代码删。
   *  对照：studio-detail.tsx 的 addBlockReason 里那个 `??` 恒不生效（那里 readOnly 由 readOnlyMsg 推出），两者性质不同。 */
  readOnlyMsg: string | null;
  kind: 'audio' | 'video' | 'videoAn';
  onKindChange: (v: 'audio' | 'video' | 'videoAn') => void;
  mode: 'separate' | 'merge';
  onModeChange: (v: 'separate' | 'merge') => void;
  format: 'mp3' | 'm4a' | 'wav';
  onFormatChange: (v: 'mp3' | 'm4a' | 'wav') => void;
  /** 确认导出。**只负责收参数后回调**，不自己调接口 —— 导出逻辑留父组件 */
  onConfirm: () => void;
}

export default function ExportSettingsModal({
  open, onClose, readOnly, readOnlyMsg,
  kind, onKindChange, mode, onModeChange, format, onFormatChange, onConfirm,
}: ExportSettingsModalProps) {
  return (
    <Modal
      title="导出"
      open={open}
      onCancel={onClose}
      okText="开始导出"
      cancelText="取消"
      okButtonProps={{ disabled: readOnly }}
      onOk={onConfirm}
    >
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <div>
          <Typography.Text strong>导出内容</Typography.Text>
          <Tooltip title={readOnlyMsg ?? '导出什么：音频（mp3/m4a/wav）或视频（mp4）'}>
            <span>
              <Radio.Group
                value={kind}
                onChange={(e) => onKindChange(e.target.value as 'audio' | 'video' | 'videoAn')}
                options={[
                  { label: '音频', value: 'audio' },
                  { label: '视频（带音轨）', value: 'video' },
                  { label: '视频（纯视频）', value: 'videoAn' },
                ]}
                disabled={readOnly}
              />
            </span>
          </Tooltip>
        </div>

        <div>
          <Typography.Text strong>怎么切段</Typography.Text>
          <Tooltip title={readOnlyMsg ?? '每一段单独成一个文件，还是全部合成一个'}>
            <span>
              <Radio.Group
                value={mode}
                onChange={(e) => onModeChange(e.target.value as 'separate' | 'merge')}
                options={[{ label: '分多段', value: 'separate' }, { label: '合并成一段', value: 'merge' }]}
                disabled={readOnly}
              />
            </span>
          </Tooltip>
        </div>

        {/* 格式仅音频导出需要（服务端对视频固定 mp4）；切走时 state 不重置 → 切回不丢上次选择 */}
        {kind === 'audio' && (
          <div>
            <Typography.Text strong>格式</Typography.Text>
            <Tooltip title={readOnlyMsg ?? '导出成什么格式'}>
              <span>
                <Radio.Group
                  value={format}
                  onChange={(e) => onFormatChange(e.target.value as 'mp3' | 'm4a' | 'wav')}
                  options={[{ label: 'mp3', value: 'mp3' }, { label: 'm4a', value: 'm4a' }, { label: 'wav', value: 'wav' }]}
                  disabled={readOnly}
                />
              </span>
            </Tooltip>
          </div>
        )}

        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          导出的是当前界面上的剪辑段，不会自动保存
        </Typography.Text>
      </Space>
    </Modal>
  );
}
