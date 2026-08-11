import { NavLink } from 'react-router-dom';
import { Grid3x3, House, MoreHorizontal, Search, Target } from 'lucide-react';
import type { VNextRouteDefinition } from '../../adapters/routes/routeManifest.js';

/**
 * Mobile bottom navigation (Figma `759:2693`).
 *
 * Five 78×63 tabs: Home, Clients, Intel, Work, More. Figma draws the tabs as
 * font glyphs; the project convention is stroked lucide icons, matched by shape
 * to the same destinations the sidebar uses.
 *
 * Destinations resolve against the route manifest, so a tab whose canonical
 * route is not registered is dropped rather than linking to a dead URL.
 */
const TAB_ICONS = {
  dashboard: House,
  portfolio: Target,
  intelligence: Search,
  workspace: Grid3x3,
} as const;

const TABS: ReadonlyArray<{ id: keyof typeof TAB_ICONS; label: string }> = [
  { id: 'dashboard', label: 'Home' },
  { id: 'portfolio', label: 'Clients' },
  { id: 'intelligence', label: 'Intel' },
  { id: 'workspace', label: 'Work' },
];

export function MobileBottomNav({
  routes,
  onOpenMore,
}: {
  routes: readonly VNextRouteDefinition[];
  onOpenMore: () => void;
}) {
  const byId = new Map(routes.map((route) => [route.id, route]));

  return (
    <nav className="capiro-vnext-bottomnav" aria-label="Primary navigation">
      {TABS.map((tab) => {
        const route = byId.get(tab.id);
        // Intelligence is a group in the sidebar; fall back to its first child.
        const path = route?.path ?? route?.children?.find((child) => child.path)?.path;
        if (!path) return null;
        const Icon = TAB_ICONS[tab.id];
        return (
          <NavLink
            key={tab.id}
            to={path}
            end={path === '/'}
            className={({ isActive }) =>
              `capiro-vnext-bottomnav__tab${isActive ? ' capiro-vnext-bottomnav__tab--current' : ''}`
            }
          >
            <span className="capiro-vnext-bottomnav__glyph" aria-hidden="true">
              <Icon size={18} strokeWidth={1.7} />
            </span>
            <span className="capiro-vnext-bottomnav__label">{tab.label}</span>
          </NavLink>
        );
      })}

      <button type="button" className="capiro-vnext-bottomnav__tab" onClick={onOpenMore}>
        <span className="capiro-vnext-bottomnav__glyph" aria-hidden="true">
          <MoreHorizontal size={18} strokeWidth={1.7} />
        </span>
        <span className="capiro-vnext-bottomnav__label">More</span>
      </button>
    </nav>
  );
}
