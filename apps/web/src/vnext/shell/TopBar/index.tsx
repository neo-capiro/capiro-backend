import type { ReactNode } from 'react';

export function CapiroTopBar({
  brand,
  search,
  actions,
}: {
  brand: ReactNode;
  search?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="capiro-vnext-topbar">
      <div className="capiro-vnext-topbar__brand">{brand}</div>
      <div>{search}</div>
      <div className="capiro-vnext-topbar__actions">{actions}</div>
    </header>
  );
}

export function CapiroBrand({ environmentLabel = 'vNext' }: { environmentLabel?: string }) {
  return (
    <>
      <span className="capiro-vnext-brand-mark" aria-hidden="true">C</span>
      <span className="capiro-vnext-brand-copy">
        <span className="capiro-vnext-brand-name">Capiro</span>
        <span className="capiro-vnext-brand-meta">{environmentLabel}</span>
      </span>
    </>
  );
}
