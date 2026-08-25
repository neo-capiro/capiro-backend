import { useState } from 'react';
import { UIcon } from './portfolio-primitives.js';
import type { CrmSurface, CrmView } from './client-crm-routing.js';
import './drawer-rail.css';

/**
 * Phase 4 (vnext UI cleanup — client record restructuring).
 *
 * Sticky left rail of drawer triggers. Relationships / Work / Files /
 * Capabilities are directories, not narrative — long, filterable lists that
 * would dominate the record's main content stream — so they open in the
 * right-side `RecordDrawer` instead of rendering inline. Clicking a row calls
 * `onNavigate` exactly as the old six-tab strip's tab buttons did, so the URL
 * still updates and every existing bookmark still resolves the same way.
 *
 * Copy is static description, not a data claim (no fabricated counts — see
 * `feedback_build_grounded_in_real_data`), transcribed from the real
 * prototype's `DRAWERS` fixture. `DRAWER_META` is exported so
 * `ClientCrmPage.tsx` can reuse the exact same label/detail as the opened
 * `RecordDrawer`'s title/sub — one source of copy, not two to keep in sync.
 */

export interface DrawerRailRow {
  key: 'relationships' | 'work' | 'files' | 'capabilities';
  label: string;
  detail: string;
  icon: string;
  tab: CrmSurface;
  /** Default sub-view a drawer row opens into, for tabs that have one. */
  view?: CrmView;
}

export const DRAWER_META: readonly DrawerRailRow[] = [
  {
    key: 'relationships',
    label: 'Relationships',
    detail: 'Current targets from Strategies, the offices connected to this client, and the client organization.',
    icon: 'Users01',
    tab: 'relationships',
    view: 'organization',
  },
  {
    key: 'work',
    label: 'Work',
    detail: 'Live strategies and plan steps. Strategies owns the record.',
    icon: 'Target04',
    tab: 'work',
  },
  {
    key: 'files',
    label: 'Files',
    detail: 'Every attachment on this client and what it links to. A smart-linked file is a reference, never a copy.',
    icon: 'File04',
    tab: 'files',
  },
  {
    key: 'capabilities',
    label: 'Capabilities',
    detail: 'What the client does, and where that record creates budget fit. Every legislative, funding and district match reads from this.',
    icon: 'Grid01',
    tab: 'capabilities',
  },
];

/**
 * Single source of truth for "which (tab, view) opens a drawer, and which
 * one." Shared by `ClientProfileShell.tsx` (to highlight the open row) and
 * `ClientCrmPage.tsx` (to decide what the drawer renders) so the mapping is
 * declared once. `relationships` only resolves to a drawer key for
 * `organization`/`government` — `history`/`matters` are the promoted Timeline
 * / Advocacy history sections and must not reopen the drawer their content
 * used to live in.
 */
export function drawerKeyForRoute(tab: CrmSurface, view: CrmView | null): DrawerRailRow['key'] | null {
  if (tab === 'relationships') return view === 'history' || view === 'matters' ? null : 'relationships';
  if (tab === 'work' || tab === 'files' || tab === 'capabilities') return tab;
  return null;
}

export interface DrawerRailProps {
  /** The row whose drawer is currently open, for a persistent highlight — or
   *  `null` when no drawer is open (Overview / a promoted section). */
  activeKey?: DrawerRailRow['key'] | null;
  onNavigate: (tab: CrmSurface, view?: CrmView | null) => void;
}

export function DrawerRail({ activeKey = null, onNavigate }: DrawerRailProps) {
  return (
    <aside aria-label="Client record sections" className="cap-pf-drawer-rail">
      <div className="cap-pf-drawer-rail__card">
        {DRAWER_META.map((row) => (
          <DrawerRailButton
            key={row.key}
            row={row}
            active={activeKey === row.key}
            onClick={() => onNavigate(row.tab, row.view ?? null)}
          />
        ))}
      </div>
    </aside>
  );
}

function DrawerRailButton({
  row,
  active,
  onClick,
}: {
  row: DrawerRailRow;
  active: boolean;
  onClick: () => void;
}) {
  const [hover, setHover] = useState(false);
  const rowClass = ['cap-pf-drawer-rail__row', active ? 'cap-pf-drawer-rail__row--active' : hover ? 'cap-pf-drawer-rail__row--hover' : '']
    .filter(Boolean)
    .join(' ');
  return (
    <button
      type="button"
      data-testid={`drawer-rail-${row.key}`}
      aria-current={active ? 'true' : undefined}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className={rowClass}
    >
      <span aria-hidden className="cap-pf-drawer-rail__icon">
        <UIcon name={row.icon} size={20} />
      </span>
      <span className="cap-pf-drawer-rail__body">
        <span className="cap-pf-drawer-rail__label">{row.label}</span>
        <span className="cap-pf-drawer-rail__detail">{row.detail}</span>
      </span>
      <span className="cap-pf-drawer-rail__chevron" aria-hidden>
        <UIcon name="ChevronRight" size={16} />
      </span>
    </button>
  );
}
