import { theme } from 'antd';

/** CP2077 UI Kit 提取的色板：UI Kit - CP2077 (Community)
 *  与参照实现 system-c-cleaner/src/setup/theme.tsx 逐值一致 */
export const cyberColors = {
  bgLayout: '#0E0E17',
  bgContainer: '#161616',
  bgElevated: '#1A1A26',
  red: '#F75049',
  cyan: '#5EF6FF',
  green: '#1DED83',
  yellow: '#F0B537',
  orange: '#FB932E',
  blue: '#2570D4',
  purple: '#9D2BF5',
  contrast: '#D6D0D0',
  textPrimary: '#F0F0F0',
  textSecondary: 'rgba(255, 255, 255, 0.6)',
  textMuted: 'rgba(255, 255, 255, 0.4)',
  borderCyan: 'rgba(94, 246, 255, 0.3)',
  borderRed: 'rgba(247, 80, 73, 0.5)',
  borderWhite: 'rgba(255, 255, 255, 0.08)',
  hoverRed: 'rgba(247, 80, 73, 0.08)',
  cyanSoft: 'rgba(94, 246, 255, 0.1)',
  redSoft: 'rgba(247, 80, 73, 0.15)',
} as const;

/** CP2077 数字/英文标题字体栈（组件内联使用；antd token 用完整回退栈） */
export const cyberFontStack = "'Rajdhani', sans-serif";

/** antd v5 深色主题 token（对齐 CP2077 UI Kit） */
export const cyberTheme = {
  algorithm: theme.darkAlgorithm,
  token: {
    colorPrimary: cyberColors.red,
    colorInfo: cyberColors.cyan,
    colorLink: cyberColors.cyan,
    colorSuccess: cyberColors.green,
    colorWarning: cyberColors.yellow,
    colorError: cyberColors.red,
    colorBgLayout: cyberColors.bgLayout,
    colorBgContainer: cyberColors.bgContainer,
    colorBgElevated: cyberColors.bgElevated,
    colorBorder: cyberColors.borderWhite,
    colorBorderSecondary: cyberColors.borderWhite,
    colorText: cyberColors.textPrimary,
    colorTextSecondary: cyberColors.textSecondary,
    colorTextTertiary: cyberColors.textMuted,
    borderRadius: 0,
    fontSize: 14,
    fontFamily:
      "'Rajdhani', -apple-system, 'Segoe UI', 'Microsoft YaHei', 'PingFang SC', sans-serif",
    controlHeight: 36,
  },
  components: {
    Menu: {
      darkItemBg: 'transparent',
      darkItemSelectedBg: cyberColors.red,
      darkItemColor: cyberColors.textSecondary,
      darkItemHoverColor: cyberColors.textPrimary,
      itemBorderRadius: 0,
    },
    Table: {
      headerBg: cyberColors.bgElevated,
      headerBorderRadius: 0,
      rowHoverBg: cyberColors.hoverRed,
    },
    Button: { primaryShadow: 'none' },
    Modal: { contentBg: cyberColors.bgContainer, headerBg: cyberColors.bgContainer },
    Card: { colorBgContainer: cyberColors.bgContainer },
  },
};
