import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';

export interface CapiroNavItemModel {
  id: string;
  label: string;
  path: string;
  icon?: ReactNode;
}

export function CapiroNavItem({ item }: { item: CapiroNavItemModel }) {
  return (
    <NavLink to={item.path} className="capiro-vnext-nav-item">
      {item.icon ? <span aria-hidden="true">{item.icon}</span> : null}
      <span>{item.label}</span>
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
}: {
  items: CapiroNavItemModel[];
  footer?: ReactNode;
  label?: string;
}) {
  return (
    <aside className="capiro-vnext-sidebar" aria-label="Primary navigation">
      <div className="capiro-vnext-sidebar__label">{label}</div>
      <nav>
        {items.map((item) => <CapiroNavItem key={item.id} item={item} />)}
      </nav>
      {footer ? <div className="capiro-vnext-sidebar__footer">{footer}</div> : null}
    </aside>
  );
}
