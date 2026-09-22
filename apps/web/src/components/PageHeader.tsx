import type { ReactNode } from 'react';

/**
 * 页面头部：标题 + 说明 + 右侧动作区。
 *
 * 抽成组件而不是各页写 div：后台系统里标题字号、与内容区的间距必须一致，
 * 否则 20 个页面会有 20 种"看起来差 2px"的排版。
 */
export interface PageHeaderProps {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
}

export function PageHeader({ title, subtitle, actions }: PageHeaderProps) {
  return (
    <div className="pageHeader">
      <div>
        <h1 className="pageTitle">{title}</h1>
        {subtitle && <div className="pageSubtitle">{subtitle}</div>}
      </div>
      {actions && <div className="pageActions">{actions}</div>}
    </div>
  );
}

export default PageHeader;
