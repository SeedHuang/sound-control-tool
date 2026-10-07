// Umi 4 运行时配置:rootContainer 包裹全部路由,antd 主题在此注入。
// 此前本项目**没有任何主题层**(antd 走默认浅色),CP2077 改造的第一块地基。
import { ConfigProvider } from 'antd';
import type { ReactNode } from 'react';
import { cyberTheme } from '@/setup/theme';

export function rootContainer(container: ReactNode) {
  return <ConfigProvider theme={cyberTheme}>{container}</ConfigProvider>;
}
