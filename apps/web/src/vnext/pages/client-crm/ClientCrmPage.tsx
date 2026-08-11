import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { useSearchParams } from 'react-router-dom';
import { CapiroButton } from '../../components/actions/index.js';
import { CapiroMenu, type CapiroMenuItem } from '../../components/menus/index.js';
import { openMeriWorkspaceWindow } from '../../../components/chat/meri-window.js';
import { initialsFor } from '../../adapters/legacy/useClientCrmOverviewModel.js';
import { ClientFillWithMeriDrawer } from './ClientFillWithMeriDrawer.js';
import { ClientCrmCapabilities } from './ClientCrmCapabilities.js';
import { ClientCrmOrganization } from './ClientCrmOrganization.js';
import { ClientCrmGovernment } from './ClientCrmGovernment.js';
import { ClientCrmHistory } from './ClientCrmHistory.js';
import { ClientCrmWork } from './ClientCrmWork.js';
import { ClientCrmIntelligence } from './ClientCrmIntelligence.js';
import { ClientCrmFiles } from './ClientCrmFiles.js';
import {
  applyCrmRoute,
  CRM_TAB_LABELS,
  INTELLIGENCE_VIEW_LABELS,
  RELATIONSHIP_VIEW_LABELS,
  resolveCrmRoute,
  type CrmSurface,
  type CrmView,
  type IntelligenceView,
} from './client-crm-routing.js';
import { ClientCrmOverview } from './ClientCrmOverview.js';
import type { Client } from '../../../pages/clients/clientTypes.js';
import './client-crm.css';

/**
 * Client CRM vNext (Figma page `906:2502`, contract `1244:4222`).
 *
 * The compact client header and the five primary tabs are constant across every
 * primary view — §4 requires the header stay stable during tab changes, so it
 * lives here and never remounts when the body swaps.
 *
 * The shell (TopBar, 232/72 navigation, context bar) is NOT rebuilt here. §9:
 * "Do not rebuild the app shell inside the client page. Mount the CRM body
 * inside the existing vNext shell." This component renders into
 * `.capiro-vnext-content`.
 */
export function ClientCrmPage({ client }: { client: Client }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const route = useMemo(() => resolveCrmRoute(searchParams), [searchParams]);

  // A legacy or malformed URL is rewritten to its canonical form with
  // `replace`, so Back does not step through the spelling the user never chose.
  useEffect(() => {
    if (!route.didNormalize) return;
    setSearchParams(applyCrmRoute(searchParams, { tab: route.tab, view: route.view }), {
      replace: true,
    });
  }, [route, searchParams, setSearchParams]);

  // Tab changes push, so Back returns to the previous tab (§2).
  const goTo = useCallback(
    (tab: CrmSurface, view?: CrmView | null) => {
      setSearchParams(applyCrmRoute(searchParams, { tab, view }));
    },
    [searchParams, setSearchParams],
  );

  const [fillOpen, setFillOpen] = useState(false);

  return (
    <div className="capiro-crm" data-tab={route.tab} data-view={route.view ?? undefined}>
      <ClientCrmHeader
        client={client}
        route={route}
        onNavigate={goTo}
        onFillWithMeri={() => setFillOpen(true)}
      />
      <ClientCrmBody client={client} route={route} onNavigate={goTo} />
      {/* Mounted only while open: the enrichment hook must not start polling —
          or hold a query subscription — for a drawer nobody has opened. */}
      {fillOpen ? (
        <ClientFillWithMeriDrawer
          clientId={client.id}
          clientName={client.name}
          open
          onClose={() => setFillOpen(false)}
        />
      ) : null}
    </div>
  );
}

/* ────────────────────────────── header (906:2751) ────────────────────────── */

/** Focus chips come from the client's own controlled vocabulary, never samples. */
function focusChipsFor(client: Client): string[] {
  const intake = (client.intakeData ?? {}) as Record<string, unknown>;
  const portfolio = Array.isArray(intake.portfolio) ? (intake.portfolio as string[]) : [];
  const tags = Array.isArray(intake.tags) ? (intake.tags as string[]) : [];
  return [...portfolio, ...tags].map((entry) => String(entry).trim()).filter(Boolean).slice(0, 4);
}

/**
 * Exported so the Clerk-free visual harness can compose the header with a
 * fixture-fed body and capture the full 1600×1000 screen without an API.
 */
export function ClientCrmHeader({
  client,
  route,
  onNavigate,
  onFillWithMeri = () => undefined,
}: {
  client: Client;
  route: { tab: CrmSurface };
  onNavigate: (tab: CrmSurface, view?: CrmView | null) => void;
  onFillWithMeri?: () => void;
}) {
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const chips = focusChipsFor(client);
  const isActive = (client.status ?? '').toLowerCase() === 'active';

  // §6: Left/Right/Home/End move focus *and* selection; Enter/Space activate.
  // Selection follows focus here, so the arrow keys already activate; Enter and
  // Space are handled by the native button.
  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const last = CRM_TAB_LABELS.length - 1;
    let next: number | null = null;
    if (event.key === 'ArrowRight') next = index === last ? 0 : index + 1;
    else if (event.key === 'ArrowLeft') next = index === 0 ? last : index - 1;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = last;
    if (next == null) return;
    const target = CRM_TAB_LABELS[next];
    if (!target) return;
    event.preventDefault();
    tabRefs.current[next]?.focus();
    onNavigate(target.key);
  };

  return (
    <header className="capiro-crm__header">
      <div className="capiro-crm__identity">
        <div className="capiro-crm__mark" aria-hidden>
          {client.logoUrl ? <img src={client.logoUrl} alt="" /> : initialsFor(client.name)}
        </div>
        <h1 className="capiro-crm__name" title={client.name}>
          {client.name}
        </h1>
        <span className="capiro-crm__pill capiro-crm__pill--filled">
          <span className="capiro-crm__pill-dot" aria-hidden />
          {isActive ? 'Active client' : (client.status ?? 'Unknown status')}
        </span>

        <span className="capiro-crm__identity-spacer" />

        <span className="capiro-crm__owner">
          <span className="capiro-crm__meta">Account owner</span>
          {/* No owner column exists on Client — see the contract audit. Showing a
              name here would invent product logic from placeholder copy. */}
          <span className="capiro-crm__owner-value capiro-crm__owner-value--empty">Not tracked</span>
        </span>

        {/* §14: enrichment, never the chat drawer. `askMeriAboutClient` and
            `setChatOpen` are deliberately not imported by this file. */}
        <CapiroButton variant="primary" size="compact" onClick={onFillWithMeri}>
          Fill with Meri
        </CapiroButton>

        <ClientCrmMoreMenu client={client} onNavigate={onNavigate} />
      </div>

      <div className="capiro-crm__focus">
        <p className="capiro-crm__meta">Focus</p>
        {chips.length === 0 ? (
          <span className="capiro-crm__pill">No focus areas set</span>
        ) : (
          chips.map((chip, index) => (
            <span
              key={chip}
              className={`capiro-crm__pill${index === 0 ? ' capiro-crm__pill--filled' : ''}`}
              title={chip}
            >
              {chip}
            </span>
          ))
        )}
      </div>

      <div className="capiro-crm__tabs" role="tablist" aria-label="Client sections">
        {CRM_TAB_LABELS.map((tab, index) => {
          const selected = route.tab === tab.key;
          return (
            <button
              key={tab.key}
              ref={(node) => {
                tabRefs.current[index] = node;
              }}
              type="button"
              role="tab"
              id={`capiro-crm-tab-${tab.key}`}
              aria-selected={selected}
              aria-controls={`capiro-crm-panel-${tab.key}`}
              tabIndex={selected ? 0 : -1}
              className="capiro-crm__tab"
              onClick={() => onNavigate(tab.key)}
              onKeyDown={(event) => onTabKeyDown(event, index)}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
    </header>
  );
}

/**
 * Overflow menu. §13 and §14: the capability surface and any separate "Ask
 * Meri" action stay reachable from here now that neither is a primary tab.
 */
function ClientCrmMoreMenu({
  client,
  onNavigate,
}: {
  client: Client;
  onNavigate: (tab: CrmSurface, view?: CrmView | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDocument = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocument);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocument);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const items: CapiroMenuItem[] = [
    {
      id: 'capabilities',
      label: 'Capabilities',
      onSelect: () => {
        setOpen(false);
        onNavigate('capabilities');
      },
    },
    {
      id: 'ask-meri',
      label: 'Ask Meri about this client',
      // Kept as a SEPARATE action from Fill with Meri, per §14's last line.
      onSelect: () => {
        setOpen(false);
        openMeriWorkspaceWindow();
      },
    },
    {
      id: 'data-health',
      label: 'Data health',
      onSelect: () => {
        setOpen(false);
        onNavigate('overview');
      },
    },
  ];

  return (
    <div className="capiro-crm__more-wrap" ref={wrapRef}>
      <button
        type="button"
        className="capiro-crm__more"
        aria-label={`More actions for ${client.name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        ⋯
      </button>
      {open ? (
        <div className="capiro-crm__more-menu">
          <CapiroMenu items={items} label={`More actions for ${client.name}`} />
        </div>
      ) : null}
    </div>
  );
}

/* ───────────────────────────────── body ──────────────────────────────────── */

function ClientCrmBody({
  client,
  route,
  onNavigate,
}: {
  client: Client;
  route: { tab: CrmSurface; view: CrmView | null };
  onNavigate: (tab: CrmSurface, view?: CrmView | null) => void;
}) {
  const views =
    route.tab === 'relationships'
      ? RELATIONSHIP_VIEW_LABELS
      : route.tab === 'intelligence'
        ? INTELLIGENCE_VIEW_LABELS
        : null;

  return (
    <div
      role="tabpanel"
      id={`capiro-crm-panel-${route.tab}`}
      aria-labelledby={`capiro-crm-tab-${route.tab}`}
      tabIndex={0}
      className="capiro-crm__panel"
    >
      {views ? (
        <div className="capiro-crm__subtabs" role="tablist" aria-label={`${route.tab} views`}>
          {views.map((view) => (
            <button
              key={view.key}
              type="button"
              role="tab"
              aria-selected={route.view === view.key}
              tabIndex={route.view === view.key ? 0 : -1}
              className="capiro-crm__subtab"
              onClick={() => onNavigate(route.tab, view.key as CrmView)}
            >
              {view.label}
            </button>
          ))}
        </div>
      ) : null}

      <ClientCrmSurface client={client} route={route} />
    </div>
  );
}

function ClientCrmSurface({
  client,
  route,
}: {
  client: Client;
  route: { tab: CrmSurface; view: CrmView | null };
}) {
  if (route.tab === 'overview') return <ClientCrmOverview client={client} />;
  // §13 — the capability surface has no vNext design yet, but every field and
  // its advocacy history must stay editable. This mounts the canonical drawer.
  if (route.tab === 'capabilities') return <ClientCrmCapabilities client={client} />;
  if (route.tab === 'relationships') {
    if (route.view === 'government') return <ClientCrmGovernment client={client} />;
    if (route.view === 'history') return <ClientCrmHistory client={client} />;
    return <ClientCrmOrganization client={client} />;
  }
  if (route.tab === 'work') return <ClientCrmWork client={client} />;
  if (route.tab === 'intelligence') {
    return (
      <ClientCrmIntelligence
        client={client}
        view={(route.view ?? 'overview') as IntelligenceView}
      />
    );
  }
  if (route.tab === 'files') return <ClientCrmFiles client={client} />;
  return <NotYetImplemented tab={route.tab} view={route.view} />;
}

/**
 * A surface whose Figma screen exists but whose vNext implementation has not
 * landed yet. Deliberately explicit rather than blank: the contract's whole
 * posture is that an honest "not here" beats a plausible-looking stand-in.
 */
function NotYetImplemented({ tab, view }: { tab: CrmSurface; view: CrmView | null }): ReactNode {
  return (
    <div className="capiro-crm__body">
      <div className="capiro-crm__card">
        <div className="capiro-crm__card-head">
          <h2 className="capiro-crm__card-title">Not yet implemented in vNext</h2>
        </div>
        <p className="capiro-crm__foot">
          The <strong>{tab}</strong>
          {view ? ` / ${view}` : ''} surface has an approved Figma screen but no vNext
          implementation on this branch yet. The canonical client profile still owns this data —
          no records are hidden or lost.
        </p>
      </div>
    </div>
  );
}
