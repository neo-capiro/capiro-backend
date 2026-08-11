import type { ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';

export interface CapiroNavItemModel {
  id: string;
  label: string;
  path: string;
  icon?: ReactNode;
  /** Additional route prefixes that keep this item visually current. */
  activePrefixes?: readonly string[];
}

export function CapiroNavItem({
  item,
  collapsed = false,
}: {
  item: CapiroNavItemModel;
  collapsed?: boolean;
}) {
  const location = useLocation();
  const groupCurrent = item.activePrefixes?.some((prefix) =>
    location.pathname === prefix || location.pathname.startsWith(`${prefix}/`),
  );
  return (
    <NavLink
      to={item.path}
      className={`capiro-vnext-nav-item${groupCurrent ? ' is-group-current' : ''}`}
      aria-label={collapsed ? item.label : undefined}
      title={collapsed ? item.label : undefined}
    >
      {item.icon ? <span className="capiro-vnext-nav-item__icon" aria-hidden="true">{item.icon}</span> : null}
      <span className="capiro-vnext-nav-item__label">{item.label}</span>
      {item.activePrefixes ? <span className="capiro-vnext-nav-item__chevron" aria-hidden="true">›</span> : null}
      {groupCurrent ? <span className="capiro-vnext-nav-item__rail" aria-hidden="true" /> : null}
    </NavLink>
  );
}

export function CapiroSubmenu({
  label,
  items,
}: {
  label: string;
  items: CapiroNavItemModel[];
}) {
  return (
    <details>
      <summary className="capiro-vnext-nav-item">{label}</summary>
      <div style={{ paddingLeft: 10 }}>
        {items.map((item) => <CapiroNavItem key={item.id} item={item} />)}
      </div>
    </details>
  );
}

export function CapiroSidebar({
  items,
  footer,
  label = 'Navigation',
  collapsed = false,
}: {
  items: CapiroNavItemModel[];
  footer?: ReactNode;
  label?: string;
  collapsed?: boolean;
}) {
  return (
    <aside
      className={`capiro-vnext-sidebar${collapsed ? ' capiro-vnext-sidebar--collapsed' : ''}`}
      aria-label="Primary navigation"
    >
      <div className="capiro-vnext-sidebar__label">{label}</div>
      <nav className="capiro-vnext-sidebar__nav">
        {items.map((item) => <CapiroNavItem key={item.id} item={item} collapsed={collapsed} />)}
      </nav>
      {footer ? <div className="capiro-vnext-sidebar__footer">{footer}</div> : null}
    </aside>
  );
}
