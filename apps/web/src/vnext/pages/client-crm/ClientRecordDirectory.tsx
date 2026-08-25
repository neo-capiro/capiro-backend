import { UIcon } from './portfolio-primitives.js';
import type { CrmSurface, CrmView } from './client-crm-routing.js';
import './client-record-directory.css';

export type ClientDirectoryKey =
  | 'timeline'
  | 'advocacy'
  | 'intelligence'
  | 'capabilities'
  | 'relationships'
  | 'work'
  | 'files';

export interface ClientDirectoryRow {
  key: ClientDirectoryKey;
  label: string;
  detail: string;
  description: string;
  icon: string;
  tab: CrmSurface;
  view?: CrmView;
  drawer: boolean;
}

/**
 * The prototype has one directory, in this exact order. Timeline, Advocacy
 * history and Intelligence replace the main record surface. The remaining
 * four rows are directories and open the existing accessible record drawer.
 */
export const CLIENT_DIRECTORY_ROWS: readonly ClientDirectoryRow[] = [
  {
    key: 'timeline',
    label: 'Timeline',
    detail: 'Client activity',
    description: 'The shared institutional record of what happened between your firm and this client.',
    icon: 'Clock',
    tab: 'relationships',
    view: 'history',
    drawer: false,
  },
  {
    key: 'advocacy',
    label: 'Advocacy history',
    detail: 'Matters and outcomes',
    description: 'What this client asked for, and what happened. Submissions are recorded against the capability they support.',
    icon: 'FlipBackward',
    tab: 'relationships',
    view: 'matters',
    drawer: false,
  },
  {
    key: 'intelligence',
    label: 'Intelligence',
    detail: '4 domains',
    description: 'Four domains read from the client-intelligence surface.',
    icon: 'Eye',
    tab: 'intelligence',
    view: 'legislative',
    drawer: false,
  },
  {
    key: 'capabilities',
    label: 'Capabilities',
    detail: 'Capability areas and awards',
    description: 'What the client does, and where that record creates budget fit. Every legislative, funding and district match reads from this.',
    icon: 'Grid01',
    tab: 'capabilities',
    drawer: true,
  },
  {
    key: 'relationships',
    label: 'Relationships',
    detail: 'Government targets and people',
    description: 'Current targets from Strategies, the offices connected to this client, and the client organization.',
    icon: 'Users01',
    tab: 'relationships',
    view: 'organization',
    drawer: true,
  },
  {
    key: 'work',
    label: 'Work',
    detail: 'Strategies and plan steps',
    description: 'Live strategies and plan steps. Strategies owns the record.',
    icon: 'Target04',
    tab: 'work',
    drawer: true,
  },
  {
    key: 'files',
    label: 'Files',
    detail: 'Client documents',
    description: 'Every attachment on this client and what it links to. A smart-linked file is a reference, never a copy.',
    icon: 'File04',
    tab: 'files',
    drawer: true,
  },
];

export const DRAWER_META = CLIENT_DIRECTORY_ROWS.filter((row) => row.drawer);

export function activeDirectoryKey(tab: CrmSurface, view: CrmView | null): ClientDirectoryKey {
  if (tab === 'relationships') {
    if (view === 'matters') return 'advocacy';
    if (view === 'history') return 'timeline';
    return 'relationships';
  }
  if (tab === 'intelligence') return 'intelligence';
  if (tab === 'capabilities' || tab === 'work' || tab === 'files') return tab;
  // Plain client opens and old explicit Overview links land on the prototype's
  // lead surface without destroying the old URL contract.
  return 'timeline';
}

export function drawerKeyForRoute(tab: CrmSurface, view: CrmView | null): ClientDirectoryKey | null {
  const key = activeDirectoryKey(tab, view);
  return CLIENT_DIRECTORY_ROWS.find((row) => row.key === key)?.drawer ? key : null;
}

export function ClientRecordDirectory({
  tab,
  view,
  onNavigate,
}: {
  tab: CrmSurface;
  view: CrmView | null;
  onNavigate: (tab: CrmSurface, view?: CrmView | null) => void;
}) {
  const active = activeDirectoryKey(tab, view);
  return (
    <aside aria-label="Client record directories" className="cap-pf-record-directory">
      <div className="cap-pf-record-directory__eyebrow">Directories</div>
      <div className="cap-pf-record-directory__list">
        {CLIENT_DIRECTORY_ROWS.map((row) => (
          <button
            key={row.key}
            type="button"
            data-testid={`client-directory-${row.key}`}
            aria-current={active === row.key ? 'page' : undefined}
            className={
              active === row.key
                ? 'cap-pf-record-directory__row cap-pf-record-directory__row--active'
                : 'cap-pf-record-directory__row'
            }
            onClick={() => onNavigate(row.tab, row.view ?? null)}
          >
            <span className="cap-pf-record-directory__icon" aria-hidden>
              <UIcon name={row.icon} size={18} color={active === row.key ? '#294E68' : '#667085'} />
            </span>
            <span className="cap-pf-record-directory__copy">
              <span className="cap-pf-record-directory__label">{row.label}</span>
              <span className="cap-pf-record-directory__detail">{row.detail}</span>
            </span>
          </button>
        ))}
      </div>
    </aside>
  );
}
