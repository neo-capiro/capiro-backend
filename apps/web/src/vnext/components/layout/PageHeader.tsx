import React from 'react';
import './page-layout.css';

interface CapiroPageHeaderProps {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  breadcrumb?: React.ReactNode;
  actions?: React.ReactNode;
  tabs?: React.ReactNode;
  contextBadge?: React.ReactNode;
  className?: string;
}

export function CapiroPageHeader({
  title,
  subtitle,
  breadcrumb,
  actions,
  tabs,
  contextBadge,
  className,
}: CapiroPageHeaderProps) {
  return (
    <div className={['capiro-page-header', className].filter(Boolean).join(' ')}>
      {(breadcrumb || contextBadge) && (
        <div className="capiro-page-header__meta">
          {breadcrumb}
          {contextBadge}
        </div>
      )}
      <div className="capiro-page-header__title-row">
        <h1 className="capiro-page-header__title">{title}</h1>
        {actions && <div className="capiro-page-header__actions">{actions}</div>}
      </div>
      {subtitle && <p className="capiro-page-header__subtitle">{subtitle}</p>}
      {tabs && <div className="capiro-page-header__tabs">{tabs}</div>}
    </div>
  );
}

export default CapiroPageHeader;
