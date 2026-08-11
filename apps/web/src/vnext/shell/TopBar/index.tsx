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
      <div className="capiro-vnext-topbar__search">{search}</div>
      <div className="capiro-vnext-topbar__actions">{actions}</div>
    </header>
  );
}

/**
 * Figma shell brand (expanded 722:2502). The product wordmark is the existing
 * repository asset; no short-lived Figma asset URL is shipped to production.
 */
export function CapiroBrand({ environmentLabel }: { environmentLabel?: string }) {
  return (
    <span className="capiro-vnext-brand">
      <img className="capiro-vnext-brand-wordmark" src="/logo.png" alt="Capiro" />
      {environmentLabel ? <span className="capiro-vnext-brand-meta">{environmentLabel}</span> : null}
    </span>
  );
}
