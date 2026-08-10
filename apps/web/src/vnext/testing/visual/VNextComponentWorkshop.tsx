import { useState, type ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { CapiroButton, CapiroIconButton } from '../../components/actions/index.js';
import { CapiroBadge } from '../../components/badges/index.js';
import { CapiroInput, CapiroSelect } from '../../components/fields/index.js';
import { CapiroMenu, CapiroTabs } from '../../components/menus/index.js';
import { CapiroCard } from '../../components/Surface.js';
import {
  CapiroTable,
  CapiroTableBody,
  CapiroTableCell,
  CapiroTableHead,
  CapiroTableHeaderCell,
  CapiroTableWrap,
} from '../../components/tables/index.js';
import { CapiroEmptyState, CapiroErrorState, CapiroSkeleton } from '../../components/feedback/index.js';
import { GlobalSearch } from '../../shell/GlobalSearch/index.js';
import { MeriLauncher } from '../../shell/MeriLauncher/index.js';
import { MailboxSyncStatusView } from '../../shell/MailboxSyncStatus/index.js';
import { CapiroSidebar } from '../../shell/Sidebar/index.js';
import { CapiroBrand, CapiroTopBar } from '../../shell/TopBar/index.js';
import { FOUNDATION_MAILBOX_STATES, FOUNDATION_SELECT_OPTIONS } from '../fixtures/foundation.js';

const navItems = [
  { id: 'dashboard', label: 'Dashboard', path: '/', icon: '⌂' },
  { id: 'portfolio', label: 'Portfolio', path: '/clients', icon: '◎' },
  { id: 'engagement', label: 'Engagement Manager', path: '/engagement', icon: '⌁' },
];

export function VNextComponentWorkshop() {
  const [activeTab, setActiveTab] = useState('overview');
  return (
    <MemoryRouter initialEntries={['/clients']}>
      <div className="capiro-vnext-root capiro-vnext-workshop">
        <header className="capiro-vnext-workshop__header">
          <p className="capiro-vnext-meta">vNext foundation · component workshop</p>
          <h1 className="capiro-vnext-heading">Capiro × Figma primitives</h1>
          <p className="capiro-vnext-body">Dev-only visual harness. No product screen is implemented here.</p>
        </header>

        <div className="capiro-vnext-workshop__grid">
          <WorkshopCard title="Actions">
            <div className="capiro-vnext-workshop__row">
              <CapiroButton variant="primary">Primary</CapiroButton>
              <CapiroButton variant="secondary">Secondary</CapiroButton>
              <CapiroButton variant="quiet">Quiet</CapiroButton>
              <CapiroButton disabled>Disabled</CapiroButton>
              <CapiroButton loading>Loading</CapiroButton>
              <CapiroIconButton label="More" icon="•••" />
            </div>
          </WorkshopCard>

          <WorkshopCard title="Fields">
            <div className="capiro-vnext-workshop__fields">
              <CapiroInput label="Client" placeholder="Search clients" helpText="Use the canonical client name." />
              <CapiroInput label="Program element" defaultValue="0605053A" error="Example validation state" />
              <CapiroSelect label="Jurisdiction" options={FOUNDATION_SELECT_OPTIONS} defaultValue="federal" />
            </div>
          </WorkshopCard>

          <WorkshopCard title="Badges and status">
            <div className="capiro-vnext-workshop__row">
              <CapiroBadge>Neutral</CapiroBadge>
              <CapiroBadge tone="success">Verified</CapiroBadge>
              <CapiroBadge tone="warning">Review</CapiroBadge>
              <CapiroBadge tone="danger">Blocked</CapiroBadge>
              <CapiroBadge tone="info">New</CapiroBadge>
            </div>
          </WorkshopCard>

          <WorkshopCard title="Tabs and menu">
            <CapiroTabs
              label="Example sections"
              items={[
                { id: 'overview', label: 'Overview' },
                { id: 'movement', label: 'Movement' },
                { id: 'proof', label: 'Sources & Proof' },
              ]}
              activeId={activeTab}
              onChange={setActiveTab}
            />
            <div style={{ height: 12 }} />
            <CapiroMenu
              label="Example menu"
              items={[
                { id: 'open', label: 'Open profile' },
                { id: 'copy', label: 'Copy link' },
                { id: 'disabled', label: 'Unavailable', disabled: true },
              ]}
            />
          </WorkshopCard>

          <WorkshopCard title="Shell controls">
            <CapiroTopBar
              brand={<CapiroBrand environmentLabel="workshop" />}
              search={<GlobalSearch onSubmit={() => undefined} />}
              actions={<MeriLauncher onLaunch={() => undefined} />}
            />
          </WorkshopCard>

          <WorkshopCard title="Navigation">
            <div style={{ height: 290, display: 'grid', gridTemplateColumns: '232px 1fr', overflow: 'hidden', borderRadius: 10 }}>
              <CapiroSidebar items={navItems} footer={<MailboxSyncStatusView status={FOUNDATION_MAILBOX_STATES[0]} />} />
              <div style={{ padding: 18, background: 'var(--capiro-color-bg-canvas)' }}>
                <p className="capiro-vnext-meta">Working surface</p>
              </div>
            </div>
          </WorkshopCard>

          <WorkshopCard title="Mailbox sync states">
            <div className="capiro-vnext-workshop__mailbox-grid">
              {FOUNDATION_MAILBOX_STATES.map((status) => (
                <MailboxSyncStatusView key={status.state} status={status} />
              ))}
            </div>
          </WorkshopCard>

          <WorkshopCard title="Table">
            <CapiroTableWrap>
              <CapiroTable>
                <CapiroTableHead>
                  <tr><CapiroTableHeaderCell>Program</CapiroTableHeaderCell><CapiroTableHeaderCell>Stage</CapiroTableHeaderCell><CapiroTableHeaderCell>Change</CapiroTableHeaderCell></tr>
                </CapiroTableHead>
                <CapiroTableBody>
                  <tr><CapiroTableCell>0605053A</CapiroTableCell><CapiroTableCell>HAC-D</CapiroTableCell><CapiroTableCell>−$22.7M</CapiroTableCell></tr>
                  <tr><CapiroTableCell>1507N2280</CapiroTableCell><CapiroTableCell>Request</CapiroTableCell><CapiroTableCell>Baseline</CapiroTableCell></tr>
                </CapiroTableBody>
              </CapiroTable>
            </CapiroTableWrap>
          </WorkshopCard>

          <WorkshopCard title="Loading, error and empty">
            <div className="capiro-vnext-workshop__states">
              <div><CapiroSkeleton width="85%" /><div style={{ height: 8 }} /><CapiroSkeleton width="62%" /></div>
              <CapiroErrorState description="The evidence source could not be loaded." />
              <CapiroEmptyState title="No movement yet" description="New budget-stage changes will appear here." />
            </div>
          </WorkshopCard>
        </div>
      </div>
    </MemoryRouter>
  );
}

function WorkshopCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <CapiroCard>
      <h2 className="capiro-vnext-heading" style={{ fontSize: 17, marginBottom: 14 }}>{title}</h2>
      {children}
    </CapiroCard>
  );
}
