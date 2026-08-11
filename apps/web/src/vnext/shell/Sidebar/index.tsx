import { useRef, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import type { VNextRouteDefinition } from '../../adapters/routes/routeManifest.js';
import { SHELL_NAV_DESCRIPTIONS } from '../nav-content.js';
import { useShellOverlay, type ShellOverlayId } from '../overlay-manager.js';

export interface CapiroNavItemModel {
  id: string;
  label: string;
  path: string;
  icon?: ReactNode;
}

/**
 * Nav glyphs are literal Unicode characters set in the body font — NOT icon
 * artwork. `Pattern/Shell/AppNavigation vNext` (`1126:2638`) authors each one as
 * a text node in Hanken Grotesk Medium, and Neo confirmed against the master
 * that this is intentional: there is no icon font or vector set behind them.
 *
 * This previously mapped each glyph onto a lucide-react icon "because the
 * project convention is stroked SVG icons". That substitution is exactly what
 * breaks pixel parity, so it is reverted. **Do not swap these for
 * lucide/phosphor/SVG artwork** — the character *is* the design.
 *
 * Sizes are per-slot and deliberate: 17px for the main nav glyphs inside the
 * 32px icon treatment, 16px for the subnav chevron, 15px for mailbox.
 *
 * Settings is the one exception and is absent here on purpose: Figma gives it a
 * real exported asset (`Icon / Clients`, `1126:2600`), not a glyph.
 */
const NAV_GLYPHS: Readonly<Record<string, string>> = {
  dashboard: '⌂',
  portfolio: '◎',
  'engagement-manager': '⌁',
  workspace: '▦',
  strategies: '◇',
  directory: '☷',
  intelligence: '⌕',
};

const SUBMENU_OVERLAY_IDS: Readonly<Record<string, ShellOverlayId>> = {
  directory: 'directory',
  intelligence: 'intelligence',
};

const SUBMENU_HEADERS: Readonly<Record<string, { eyebrow: string; description: string }>> = {
  directory: { eyebrow: 'DIRECTORY', description: 'People and institutional contacts' },
  intelligence: { eyebrow: 'INTELLIGENCE', description: 'Signals, programs and analysis' },
};

function NavIcon({ id }: { id: string }) {
  const glyph = NAV_GLYPHS[id];
  return (
    <span className="capiro-vnext-nav-item__icon" aria-hidden="true">
      {glyph ?? null}
    </span>
  );
}

export function CapiroNavItem({ item }: { item: CapiroNavItemModel }) {
  return (
    <NavLink
      to={item.path}
      end={item.path === '/'}
      className={({ isActive }) =>
        `capiro-vnext-nav-item${isActive ? ' capiro-vnext-nav-item--current' : ''}`
      }
    >
      {item.icon ? (
        <span className="capiro-vnext-nav-item__icon" aria-hidden="true">{item.icon}</span>
      ) : (
        <NavIcon id={item.id} />
      )}
      <span className="capiro-vnext-nav-item__label">{item.label}</span>
    </NavLink>
  );
}

/**
 * Directory / Intelligence flyout (`820:2624`, `727:2580`). Destinations without
 * a registered canonical route render as an explicit unavailable entry — the
 * shell never links to a URL that does not exist.
 */
function SidebarFlyout({
  route,
  collapsed,
}: {
  route: VNextRouteDefinition;
  collapsed: boolean;
}) {
  const overlayId = SUBMENU_OVERLAY_IDS[route.id]!;
  const { isOpen, containerRef, toggle, close } = useShellOverlay(overlayId);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const location = useLocation();
  const header = SUBMENU_HEADERS[route.id];
  const children = route.children ?? [];

  const hasCurrentChild = children.some(
    (child) => child.path && location.pathname.startsWith(child.path),
  );

  return (
    <div className="capiro-vnext-nav-group" ref={containerRef}>
      <button
        ref={triggerRef}
        type="button"
        className={`capiro-vnext-nav-item capiro-vnext-nav-item--trigger${
          hasCurrentChild ? ' capiro-vnext-nav-item--current' : ''
        }`}
        aria-expanded={isOpen}
        aria-haspopup="menu"
        onClick={() => toggle(triggerRef.current)}
      >
        <NavIcon id={route.id} />
        <span className="capiro-vnext-nav-item__label">{route.label}</span>
        <span className="capiro-vnext-nav-item__chevron" aria-hidden="true">
          {'›'}
        </span>
      </button>

      {isOpen ? (
        <div
          className="capiro-vnext-flyout capiro-elevation-widget"
          role="menu"
          aria-label={route.label}
          data-collapsed={collapsed || undefined}
        >
          {header ? (
            <div className="capiro-vnext-flyout__header">
              <p className="capiro-vnext-flyout__eyebrow">{header.eyebrow}</p>
              <p className="capiro-vnext-flyout__description">{header.description}</p>
            </div>
          ) : null}

          {children.map((child) =>
            child.path ? (
              <NavLink
                key={child.id}
                role="menuitem"
                to={child.path}
                className="capiro-vnext-flyout__item"
                onClick={close}
              >
                <span className="capiro-vnext-flyout__item-copy">
                  <span className="capiro-vnext-flyout__name">{child.label}</span>
                  {SHELL_NAV_DESCRIPTIONS[child.id] ? (
                    <span className="capiro-vnext-flyout__meta">
                      {SHELL_NAV_DESCRIPTIONS[child.id]}
                    </span>
                  ) : null}
                </span>
                <span className="capiro-vnext-flyout__chevron" aria-hidden="true">
                  {'›'}
                </span>
              </NavLink>
            ) : (
              <div
                key={child.id}
                role="menuitem"
                aria-disabled="true"
                className="capiro-vnext-flyout__item capiro-vnext-flyout__item--unavailable"
              >
                <span className="capiro-vnext-flyout__item-copy">
                  <span className="capiro-vnext-flyout__name">{child.label}</span>
                  <span className="capiro-vnext-flyout__meta">
                    {SHELL_NAV_DESCRIPTIONS[child.id] ?? child.label}
                  </span>
                </span>
                <span className="capiro-vnext-flyout__tag">Not available</span>
              </div>
            ),
          )}
        </div>
      ) : null}
    </div>
  );
}

/** Legacy grouping used by the foundation phase; kept for the component workshop. */
export function CapiroSubmenu({
  label,
  items,
}: {
  label: string;
  items: CapiroNavItemModel[];
}) {
  return (
    <details className="capiro-vnext-nav-group">
      <summary className="capiro-vnext-nav-item">{label}</summary>
      <div className="capiro-vnext-nav-group__items">
        {items.map((item) => <CapiroNavItem key={item.id} item={item} />)}
      </div>
    </details>
  );
}

export function CapiroSidebar({
  routes = [],
  items,
  footer,
  label = 'NAVIGATION',
  collapsed = false,
  onToggleCollapsed,
}: {
  routes?: readonly VNextRouteDefinition[];
  items?: CapiroNavItemModel[];
  footer?: ReactNode;
  label?: string;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
}) {
  return (
    <aside
      className="capiro-vnext-sidebar"
      aria-label="Primary navigation"
      data-collapsed={collapsed || undefined}
    >
      {!collapsed ? <div className="capiro-vnext-sidebar__label">{label}</div> : null}

      <nav className="capiro-vnext-sidebar__nav">
        {routes.map((route) =>
          route.children?.length ? (
            <SidebarFlyout key={route.id} route={route} collapsed={collapsed} />
          ) : route.path ? (
            <CapiroNavItem
              key={route.id}
              item={{ id: route.id, label: route.label, path: route.path }}
            />
          ) : null,
        )}
        {items?.map((item) => <CapiroNavItem key={item.id} item={item} />)}
      </nav>

      <div className="capiro-vnext-sidebar__footer">
        {footer}
        {onToggleCollapsed ? (
          <button
            type="button"
            className="capiro-vnext-collapse capiro-elevation-control"
            onClick={onToggleCollapsed}
            aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
          >
            <span aria-hidden="true" className="capiro-vnext-collapse__chevron">
              {collapsed ? '›' : '‹'}
            </span>
            {!collapsed ? (
              <span className="capiro-vnext-collapse__label">Collapse navigation</span>
            ) : null}
          </button>
        ) : null}
      </div>
    </aside>
  );
}
