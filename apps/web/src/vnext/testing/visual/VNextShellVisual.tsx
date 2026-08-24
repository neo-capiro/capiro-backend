import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { VNEXT_ROUTE_MANIFEST } from '../../adapters/routes/routeManifest.js';
import { AppShellUuiView } from '../../shell/AppShellUui/index.js';
import { DashboardVNextView } from '../../pages/dashboard/DashboardVNext.js';
import { StrategyLibraryVNext } from '../../pages/strategies/StrategyLibraryVNext.js';
import { StrategyEditorVNext } from '../../pages/strategies/StrategyEditorVNext.js';
// Normally imported once by VNextStrategiesRoutes (the module root, per that
// folder's BUILD-CONTRACT.md) — imported here too since the harness mounts
// the view directly and skips that router.
import '../../pages/strategies/strategies-tokens.css';
import { CongressionalStaffVNextView } from '../../pages/directory/CongressionalStaffVNext.js';
import { FOUNDATION_MAILBOX_STATES } from '../fixtures/foundation.js';
import { DASHBOARD_VISUAL_FIXTURE, DASHBOARD_STATE_FIXTURES } from '../fixtures/dashboard.js';
import {
  CONGRESSIONAL_STAFF_EMPTY_FIXTURE,
  CONGRESSIONAL_STAFF_VISUAL_FIXTURE,
} from '../fixtures/directory.js';
import { DIRECTORY_ROUTES } from '../../pages/directory/directory-routes.js';
import { ClientProfileShell } from '../../pages/client-crm/ClientProfileShell.js';
import { AccordionSection } from '../../pages/client-crm/AccordionSection.js';
import { DRAWER_META, drawerKeyForRoute } from '../../pages/client-crm/DrawerRail.js';
import { SegmentedTabs } from '../../pages/client-crm/portfolio-primitives.js';
import {
  RELATIONSHIP_VIEW_LABELS,
  INTELLIGENCE_VIEWS,
  type CrmSurface,
  type CrmView,
  type RelationshipView,
  type IntelligenceView,
} from '../../pages/client-crm/client-crm-routing.js';
import type { Client } from '../../../pages/clients/clientTypes.js';
import { ClientCrmOverviewProto } from '../../pages/client-crm/tabs/OverviewTab.js';
import { ClientCrmCapabilitiesProto } from '../../pages/client-crm/tabs/CapabilitiesTab.js';
import { ClientCrmOrganizationProto } from '../../pages/client-crm/tabs/RelationshipsOrgTab.js';
import { ClientCrmGovernmentProto } from '../../pages/client-crm/tabs/RelationshipsGovTab.js';
import { ClientCrmHistoryProto } from '../../pages/client-crm/tabs/RelationshipsHistoryTab.js';
import { ClientCrmAdvocacyMattersProto } from '../../pages/client-crm/tabs/AdvocacyMattersTab.js';
import { ClientCrmWorkProto } from '../../pages/client-crm/tabs/WorkTab.js';
import { ClientCrmIntelligenceProto } from '../../pages/client-crm/tabs/IntelligenceTab.js';
import { ClientCrmFilesProto } from '../../pages/client-crm/tabs/FilesTab.js';
import {
  CLIENT_CRM_VISUAL_CLIENT,
} from '../fixtures/client-crm.js';
import {
  PersonDrawer,
  TargetDrawer,
  StrategyDrawer,
  DataHealthDrawer,
  HierarchyModal,
  MoveToFolderModal,
  PfToast,
} from '../../pages/client-crm/portfolio-overlays.js';
import { PEOPLE, TARGETS, NODES, FOLDERS } from '../../pages/client-crm/portfolio-fixtures.js';
import '../../pages/client-crm/client-crm.css';
import '../../pages/client-crm/portfolio-proto.css';

/**
 * Clerk-free shell baseline. The nav model comes from the real route manifest so
 * the capture exercises the shipped navigation, but every data-backed control is
 * replaced by a fixture — this harness never calls the API.
 *
 * One shell (AppShellUui) for every screen, matching production as of 2026-08
 * — there is no longer a separate Capiro-native harness path to keep in sync;
 * VNextShellScaffold/CapiroSidebar/CapiroTopBar are retired from production
 * but still exist as files if a future session needs to compare against them.
 */
/**
 * `AppShellUuiView` renders the real `NotificationBell`, which runs its own
 * `useNotifications()` query rather than reading the injected `notifications`
 * view-model. That needs a QueryClient in context or the tree throws. Retries
 * and refetches are off so the harness stays offline and deterministic; the
 * query fails immediately against the stubbed (token-less) client and the bell
 * renders its real "unavailable" state.
 */
const harnessQueryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, refetchOnWindowFocus: false, refetchInterval: false, gcTime: Infinity },
    mutations: { retry: false },
  },
});

const visualRoutes = VNEXT_ROUTE_MANIFEST.filter((route) => route.id !== 'settings');
const settingsRoute = VNEXT_ROUTE_MANIFEST.find((route) => route.id === 'settings') ?? null;

const fixtureIdentity = {
  loading: false,
  unavailable: false,
  name: 'Neo Martinez',
  role: 'VP Government Affairs',
  email: 'neo@capiro.ai',
  initials: 'NM',
  imageUrl: null,
};

const fixtureNotifications = {
  loading: false,
  unavailable: false,
  unread: 3,
  showBadge: true,
  badgeLabel: '3',
};

export type VNextVisualScreen =
  | 'empty'
  | 'dashboard'
  | 'client-crm'
  | 'congressional-staff'
  | 'congressional-staff-empty'
  | 'strategies'
  | 'strategies-empty'
  | 'strategy-editor';

/**
 * Each screen renders at the route it actually ships on, so the sidebar's
 * current-item state is exercised, not faked.
 *
 * `/clients` carries `clientId` because the vNext interception requires a param
 * the app does not otherwise set — see `1a0b000c`, where its absence meant the
 * CRM surface never rendered at all.
 */
const SCREEN_ROUTES: Record<VNextVisualScreen, string> = {
  empty: '/clients?clientId=visual-fixture',
  dashboard: '/',
  'client-crm': '/clients?clientId=visual-fixture',
  'congressional-staff': DIRECTORY_ROUTES.congressionalStaff,
  'congressional-staff-empty': DIRECTORY_ROUTES.congressionalStaff,
  strategies: '/strategies',
  'strategies-empty': '/strategies',
  'strategy-editor': '/strategies/7f1c9a20-4d3e-4b8a-9c21-6e0f5a8b1d34',
};

export function VNextShellVisual({
  collapsed,
  screen = 'empty',
  crmTab = 'overview',
  intelView = 'legislative',
  relView = 'organization',
  crmOverlay,
  openSections,
  attnState,
}: {
  collapsed?: boolean;
  screen?: VNextVisualScreen;
  crmTab?: CrmSurface;
  intelView?: IntelligenceView;
  relView?: RelationshipView;
  crmOverlay?: 'person' | 'target' | 'strategy' | 'health' | 'hierarchy' | 'move' | 'toast';
  /** Phase 4: forces additional record sections open on top of whichever one
   *  `crmTab`/`relView`/`intelView` already targets — e.g. `['timeline',
   *  'advocacy']` to capture the whole section stack expanded at once, since
   *  only one route-target section auto-expands at a time otherwise (same as
   *  production — see `ClientCrmSectionsFixture` below). */
  openSections?: readonly ClientCrmSectionId[];
  /** Forces Needs Attention into one of the six named states (754:2885) —
   * ModuleStateView is shared across all four modules, so this exercises the
   * same render path every module's state block uses. Dashboard-only. */
  attnState?: keyof typeof DASHBOARD_STATE_FIXTURES;
}) {
  const dashboardModel =
    attnState && DASHBOARD_STATE_FIXTURES[attnState]
      ? DASHBOARD_STATE_FIXTURES[attnState]
      : DASHBOARD_VISUAL_FIXTURE;

  // Phase 4: the same (tab, view) shape ClientCrmPage derives from the URL via
  // resolveCrmRoute — built directly from the fixture props here since this
  // harness has no real route to parse. Drives DrawerRail/AccordionSection
  // exactly as production does, so relView='history'|'matters' now expands
  // the Timeline/Advocacy section instead of opening the drawer.
  const crmRoute: { tab: CrmSurface; view: CrmView | null } =
    crmTab === 'relationships'
      ? { tab: 'relationships', view: relView }
      : crmTab === 'intelligence'
        ? { tab: 'intelligence', view: intelView }
        : { tab: crmTab, view: null };
  const crmDrawerKey = drawerKeyForRoute(crmRoute.tab, crmRoute.view);
  const crmDrawerRow = crmDrawerKey ? DRAWER_META.find((row) => row.key === crmDrawerKey) : undefined;

  return (
    <QueryClientProvider client={harnessQueryClient}>
      <MemoryRouter initialEntries={[SCREEN_ROUTES[screen]]}>
        <div className="capiro-vnext-root">
        <AppShellUuiView
          navigation={{ primary: visualRoutes, settings: settingsRoute, loading: false }}
          identity={fixtureIdentity}
          notifications={fixtureNotifications}
          mailboxStatus={FOUNDATION_MAILBOX_STATES[0]}
          scopeLabel="All clients"
          onNavigate={() => undefined}
          onSignOut={() => undefined}
          onOpenProfile={() => undefined}
          initialCollapsed={collapsed}
        >
          {screen === 'client-crm' ? (
            // Client CRM — Portfolio prototype shell (Phase 4: drawer rail +
            // accordion-section stack, mirroring ClientCrmPage.tsx's own
            // ClientCrmBody/ClientCrmDrawerBody split).
            <ClientProfileShell
              client={CLIENT_CRM_VISUAL_CLIENT}
              tab={crmRoute.tab}
              view={crmRoute.view}
              onNavigate={() => undefined}
              onFillWithMeri={() => undefined}
              onDataHealth={() => undefined}
              // Harness-only values so the captured frame still carries the
              // breadcrumb freshness, the gap chip, the focus "Add" affordance
              // and the archive menu item that the Figma frame shows. In the
              // product these come from the real source reads and the viewer's
              // role (ClientCrmPage); this file is the offline capture harness
              // and is never mounted as product code.
              refreshedLabel="2 hours ago"
              profileGapCount={1}
              canEditFocus
              canArchive
              onArchive={() => undefined}
              drawerContent={
                crmDrawerRow ? (
                  <ClientCrmDrawerBodyFixture client={CLIENT_CRM_VISUAL_CLIENT} tab={crmRoute.tab} relView={relView} />
                ) : null
              }
              drawerTitle={crmDrawerRow?.label}
              drawerSub={crmDrawerRow?.detail}
              onCloseDrawer={() => undefined}
            >
              <ClientCrmSectionsFixture client={CLIENT_CRM_VISUAL_CLIENT} route={crmRoute} openSections={openSections} />
            </ClientProfileShell>
          ) : screen === 'dashboard' ? (
            <DashboardVNextView model={dashboardModel} />
          ) : screen === 'congressional-staff' ? (
            <CongressionalStaffVNextView model={CONGRESSIONAL_STAFF_VISUAL_FIXTURE} />
          ) : screen === 'congressional-staff-empty' ? (
            <CongressionalStaffVNextView model={CONGRESSIONAL_STAFF_EMPTY_FIXTURE} />
          ) : screen === 'strategies' || screen === 'strategies-empty' ? (
            // .capiro-strategies normally comes from VNextStrategiesRoutes' wrapper
            // div, not StrategyLibraryVNext itself — reproduced here since the
            // harness mounts the view directly, skipping that route shell.
            <div className="capiro-strategies" data-module="strategies">
              <StrategyLibraryVNext />
            </div>
          ) : screen === 'strategy-editor' ? (
            <div className="capiro-strategies" data-module="strategies">
              <Routes>
                <Route path="/strategies/:strategyId" element={<StrategyEditorVNext />} />
              </Routes>
            </div>
          ) : (
            <div className="capiro-vnext-foundation-banner" style={{ margin: 20 }}>
              shell baseline · product screens intentionally absent
            </div>
          )}
          {/* Portfolio prototype overlays (segment §12), mounted over the shell for capture. */}
          {screen === 'client-crm' && crmOverlay === 'person' ? (
            <PersonDrawer person={personFixture('sb')} onClose={() => undefined} />
          ) : null}
          {screen === 'client-crm' && crmOverlay === 'target' ? (
            <TargetDrawer target={targetFixture('t1')} onClose={() => undefined} />
          ) : null}
          {screen === 'client-crm' && crmOverlay === 'strategy' ? (
            <StrategyDrawer nodes={strategyNodeFixture()} onClose={() => undefined} />
          ) : null}
          {screen === 'client-crm' && crmOverlay === 'health' ? (
            <DataHealthDrawer onClose={() => undefined} onResolveGap={() => undefined} />
          ) : null}
          {screen === 'client-crm' && crmOverlay === 'hierarchy' ? (
            <HierarchyModal onClose={() => undefined} />
          ) : null}
          {screen === 'client-crm' && crmOverlay === 'move' ? (
            <MoveToFolderModal count={3} folders={folderFixture()} onClose={() => undefined} onMove={() => undefined} />
          ) : null}
          {screen === 'client-crm' && crmOverlay === 'toast' ? (
            <PfToast message="Meri proposed 7 field changes for review" onDone={() => undefined} />
          ) : null}
        </AppShellUuiView>
        </div>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

/* ── Client CRM body fixtures (Phase 4: drawer rail + accordion mirror) ──────
 * ClientCrmPage.tsx computes its accordion stack and drawer body inline via
 * two module-private functions (`ClientCrmBody`/`ClientCrmDrawerBody`) built
 * from `sectionForRoute`/`SECTION_COPY`, also private. Reused below where
 * exported (`AccordionSection`, `DRAWER_META`, `drawerKeyForRoute`); rebuilt
 * verbatim where not, so this harness keeps rendering the identical
 * structure production does instead of drifting back out of sync.
 */

type ClientCrmSectionId = 'overview' | 'timeline' | 'advocacy' | 'intelligence';

const CLIENT_CRM_SECTION_COPY: Record<ClientCrmSectionId, { title: string; sub?: string }> = {
  overview: { title: 'Overview' },
  timeline: {
    title: 'Timeline',
    sub: 'The shared institutional record of what happened between your firm and this client.',
  },
  advocacy: {
    title: 'Advocacy history',
    sub: 'What this client asked for, and what happened. Submissions are recorded against the capability they support.',
  },
  intelligence: {
    title: 'Intelligence',
    sub: 'Four domains read from the client-intelligence surface.',
  },
};

function sectionForCrmRoute(route: { tab: CrmSurface; view: CrmView | null }): ClientCrmSectionId | null {
  if (route.tab === 'overview') return 'overview';
  if (route.tab === 'relationships' && route.view === 'history') return 'timeline';
  if (route.tab === 'relationships' && route.view === 'matters') return 'advocacy';
  if (route.tab === 'intelligence') return 'intelligence';
  return null;
}

/** Mirrors ClientCrmPage.tsx's private `ClientCrmBody` — the always-mounted
 *  Overview/Timeline/Advocacy history/Intelligence accordion stack. Overview
 *  plus whichever section `route` targets start expanded, same as production;
 *  `openSections` (harness-only) forces additional ones open on top of that. */
function ClientCrmSectionsFixture({
  client,
  route,
  openSections,
}: {
  client: Client;
  route: { tab: CrmSurface; view: CrmView | null };
  openSections?: readonly ClientCrmSectionId[];
}) {
  const [expanded, setExpanded] = useState<ReadonlySet<ClientCrmSectionId>>(() => {
    const target = sectionForCrmRoute(route);
    return new Set<ClientCrmSectionId>(['overview', ...(openSections ?? []), ...(target ? [target] : [])]);
  });

  const toggle = (id: ClientCrmSectionId) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <>
      <AccordionSection
        id="cap-pf-section-overview"
        title={CLIENT_CRM_SECTION_COPY.overview.title}
        sub={CLIENT_CRM_SECTION_COPY.overview.sub}
        open={expanded.has('overview')}
        onToggle={() => toggle('overview')}
      >
        <ClientCrmOverviewProto
          client={client}
          onEditProfile={() => undefined}
          onOpenFederalFootprint={() => undefined}
          onOpenWork={() => undefined}
          onOpenIntelligence={() => undefined}
        />
      </AccordionSection>

      <AccordionSection
        id="cap-pf-section-timeline"
        title={CLIENT_CRM_SECTION_COPY.timeline.title}
        sub={CLIENT_CRM_SECTION_COPY.timeline.sub}
        open={expanded.has('timeline')}
        onToggle={() => toggle('timeline')}
      >
        <ClientCrmHistoryProto client={client} />
      </AccordionSection>

      <AccordionSection
        id="cap-pf-section-advocacy"
        title={CLIENT_CRM_SECTION_COPY.advocacy.title}
        sub={CLIENT_CRM_SECTION_COPY.advocacy.sub}
        open={expanded.has('advocacy')}
        onToggle={() => toggle('advocacy')}
      >
        <ClientCrmAdvocacyMattersProto client={client} />
      </AccordionSection>

      <AccordionSection
        id="cap-pf-section-intelligence"
        title={CLIENT_CRM_SECTION_COPY.intelligence.title}
        sub={CLIENT_CRM_SECTION_COPY.intelligence.sub}
        open={expanded.has('intelligence')}
        onToggle={() => toggle('intelligence')}
      >
        {/* Intelligence is one always-expanded stack of all four domains now
            (not a single `intelView`-selected panel) — see IntelligenceDomainStack
            in ClientCrmPage.tsx, reproduced here since it too is module-private. */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 32 }}>
          {INTELLIGENCE_VIEWS.map((view, index) => (
            <div key={view} style={index > 0 ? { paddingTop: 32, borderTop: '1px solid #E8E5DF' } : undefined}>
              <ClientCrmIntelligenceProto client={client} view={view} />
            </div>
          ))}
        </div>
      </AccordionSection>
    </>
  );
}

/** Mirrors ClientCrmPage.tsx's private `ClientCrmDrawerBody` — the
 *  Relationships/Work/Files/Capabilities content that opens in `RecordDrawer`.
 *  Relationships' history/matters views never reach here (`drawerKeyForRoute`
 *  returns null for them): those promote to the Timeline/Advocacy sections
 *  above instead. */
function ClientCrmDrawerBodyFixture({
  client,
  tab,
  relView,
}: {
  client: Client;
  tab: CrmSurface;
  relView: RelationshipView;
}) {
  if (tab === 'capabilities') return <ClientCrmCapabilitiesProto client={client} />;
  if (tab === 'work') return <ClientCrmWorkProto client={client} />;
  if (tab === 'files') return <ClientCrmFilesProto client={client} />;

  const relationshipViews = RELATIONSHIP_VIEW_LABELS.filter((v) => v.key === 'organization' || v.key === 'government');
  const view: RelationshipView = relView === 'government' ? 'government' : 'organization';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <SegmentedTabs ariaLabel="Relationships view" options={relationshipViews} value={view} onChange={() => undefined} />
      {view === 'government' ? <ClientCrmGovernmentProto client={client} /> : <ClientCrmOrganizationProto client={client} />}
    </div>
  );
}

/* ── Overlay fixture adapters (map prototype fixtures → overlay prop shapes) ── */

function personFixture(id: keyof typeof PEOPLE) {
  const p = PEOPLE[id] as { init: string; name: string; title: string; level: string; meta: string; email: string; phone: string; levelFull: string; reports: string; override?: boolean; note: string };
  return {
    level: p.level,
    levelFull: p.levelFull,
    init: p.init,
    name: p.name,
    title: p.title,
    meta: p.meta,
    email: p.email,
    phone: p.phone,
    location: 'Seattle, WA',
    reports: p.reports,
    placement: (p.override ? 'Manual override' : 'Auto-placed') as 'Manual override' | 'Auto-placed',
    note: p.note,
  };
}

function targetFixture(id: string) {
  const t = (TARGETS as Array<Record<string, unknown>>).find((x) => x.id === id) as Record<string, any>;
  return {
    kind: t.kind as 'person' | 'org',
    init: t.init,
    name: t.name,
    role: t.role,
    disposition: t.disposition,
    dispTone: 'success' as const,
    confirm: t.confirm,
    strategy: t.strategy,
    ask: t.ask,
    next: t.next,
    why: t.why as Array<[string, string]>,
  };
}

function strategyNodeFixture() {
  return (NODES as Array<Record<string, any>>).map((n) => ({
    mark: n.mark,
    kind: n.kind,
    title: n.title,
    init: n.init,
    date: n.date,
    status: n.status,
    tone: n.ui,
  }));
}

function folderFixture() {
  return (FOLDERS as Array<Record<string, any>>).map((f) => ({
    label: f.label,
    depth: f.depth,
    count: f.count,
  }));
}
