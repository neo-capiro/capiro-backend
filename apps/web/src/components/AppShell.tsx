import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { ChatDrawer } from './chat/ChatDrawer.js';
import { MeriOverlay } from './chat/MeriOverlay.js';
import { WorkspaceNotificationBell } from './WorkspaceNotificationBell.js';
import { QuickLogButton } from './QuickLog.js';
import {
  AimOutlined,
  ApartmentOutlined,
  FolderOpenOutlined,
  CalendarOutlined,
  CheckOutlined,
  DashboardOutlined,
  DownOutlined,
  FundOutlined,
  IdcardOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  QuestionCircleOutlined,
  RadarChartOutlined,
  DeploymentUnitOutlined,
  SearchOutlined,
  SettingOutlined,
  SyncOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { useClerk, useUser } from '@clerk/clerk-react';
import { ROLE_RANK, type TenantRole } from '@capiro/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  App as AntApp,
  Avatar,
  Dropdown,
  Input,
  Layout,
  Menu,
  Popover,
  Typography,
  type MenuProps,
} from 'antd';
import { useMe } from '../lib/me.js';
import { useApi } from '../lib/use-api.js';
import { useIntelFeatureFlags } from '../lib/intel-feature-flags.js';
import { OnboardingGates, START_TOUR_EVENT } from './onboarding/OnboardingGates.js';
import { TrialBanner } from './onboarding/TrialBanner.js';
import { useClientFilter } from '../state/client-filter.js';
import { useImpersonation } from '../state/impersonation.js';
import type { Client } from '../pages/clients/clientTypes.js';

const { Header, Sider, Content } = Layout;

interface NavItem {
  key: AppSection;
  label: string;
  /** Leaf items navigate to a path; group items (with children) omit it. */
  path?: string;
  icon: ReactNode;
  nested?: boolean;
  disabled?: boolean;
  /** When set, the item is only shown to callers at or above this role. */
  minRole?: TenantRole;
  /** When set, the item is only shown when this feature flag is enabled for the tenant. */
  featureFlag?: string;
  /** Product-tour anchor: rendered as `data-tour` on the nav label so the
   * onboarding DashboardTour (prototype OB_TOUR nav keys) can spotlight it. */
  tourId?: string;
  /** Sub-items rendered as an expandable submenu (e.g. the Program Elements group). */
  children?: NavItem[];
}

type AppSection =
  | 'home'
  | 'clients'
  | 'engagement'
  | 'workspace'
  | 'planner'
  | 'intelligence'
  | 'knowledge-graph'
  | 'actions'
  | 'reviews'
  | 'pe-group'
  | 'program-elements'
  | 'radar'
  | 'hearing-watch'
  | 'analyst-console'
  | 'directory'
  | 'stakeholders'
  | 'collaborators'
  | 'portal'
  | 'settings'
  | 'help'
  | 'not-found';

interface PageConfig {
  key: AppSection;
  title: string;
  showClientDropdown: boolean;
}

interface IntegrationConnection {
  id: string;
  provider: 'microsoft_365' | 'google_workspace' | 'imap_caldav' | 'manual';
  accountEmail: string | null;
  displayName: string | null;
  status: 'needs_configuration' | 'connected' | 'error' | 'disabled';
  lastSyncAt: string | null;
}

interface BrandingResponse {
  id: string;
  slug: string;
  name: string;
  logoS3Key: string | null;
  logoContentType: string | null;
  logoUploadedAt: string | null;
  logoUrl?: string | null;
}

const NAV: NavItem[] = [
  {
    key: 'home',
    label: 'Dashboard',
    path: '/',
    icon: <DashboardOutlined />,
    tourId: 'Dashboard',
  },
  {
    key: 'engagement',
    label: 'Engagement',
    path: '/engagement',
    icon: <CalendarOutlined />,
    tourId: 'Engagement',
  },
  {
    key: 'clients',
    label: 'Portfolio',
    path: '/clients',
    icon: <ApartmentOutlined />,
    tourId: 'Portfolio',
  },
  {
    key: 'workspace',
    label: 'Workspace',
    path: '/workspace',
    icon: <FolderOpenOutlined />,
    tourId: 'Workspace',
  },
  {
    key: 'directory',
    label: 'Directory',
    path: '/directory',
    icon: <IdcardOutlined />,
    tourId: 'Directory',
  },
  // §3.3 reviewer queue (/reviews) is deliberately NOT surfaced in the nav —
  // deep-link only, per Ninja 2026-07-13 (matches the Actions-board convention).
  // The route stays registered in App.tsx.
  // Intelligence group (kept LAST in the nav): Radar (the unified Tracker +
  // Hearing Watch surface) first, then the Intelligence Center (live Explorer)
  // plus Program Elements nested beneath it. The former PE sub-items (Action
  // Board, Analyst Console) and the legacy Hearing Watch list page remain
  // routable by deep-link but are not surfaced. Planner and Collaborators stay
  // hidden.
  {
    key: 'pe-group',
    label: 'Intelligence',
    icon: <RadarChartOutlined />,
    tourId: 'Intelligence',
    children: [
      {
        key: 'radar',
        label: 'LegiWatch',
        path: '/legiwatch',
        icon: <AimOutlined />,
      },
      {
        key: 'intelligence',
        label: 'Data Explorer',
        path: '/explorer',
        icon: <RadarChartOutlined />,
      },
      {
        key: 'knowledge-graph',
        label: 'Knowledge Graph',
        path: '/intelligence/graph',
        icon: <DeploymentUnitOutlined />,
      },
      {
        key: 'program-elements',
        label: 'Program Elements',
        path: '/program-elements',
        icon: <FundOutlined />,
      },
    ],
  },
];

export function AppShell() {
  const api = useApi();
  const me = useMe();
  const qc = useQueryClient();
  const { message } = AntApp.useApp();
  const { signOut, openUserProfile } = useClerk();
  const { user } = useUser();
  const location = useLocation();
  const navigate = useNavigate();
  const { actAsTenantSlug, end: endImpersonation } = useImpersonation();
  const { selectedClientId, setSelectedClientId, clearClientFilter } = useClientFilter();
  const previousSection = useRef<AppSection | null>(null);
  const [lastManualSyncAt, setLastManualSyncAt] = useState<string | null>(null);
  const [workflowLocked, setWorkflowLocked] = useState(false);
  const [navCollapsed, setNavCollapsed] = useState(false);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ locked?: boolean }>).detail;
      setWorkflowLocked(Boolean(detail?.locked));
    };
    window.addEventListener('capiro:workflow-lock', handler);
    return () => window.removeEventListener('capiro:workflow-lock', handler);
  }, []);

  const displayName =
    user?.fullName ||
    [me.data?.user.firstName, me.data?.user.lastName].filter(Boolean).join(' ') ||
    me.data?.user.email ||
    user?.primaryEmailAddress?.emailAddress ||
    'Account';
  const displayTitle = me.data?.user.title ?? null;

  const page = useMemo(() => pageConfigFor(location.pathname), [location.pathname]);

  const clients = useQuery<Client[]>({
    queryKey: ['clients'],
    queryFn: async () => (await api.get<Client[]>('/api/clients')).data,
    enabled: Boolean(me.data),
    staleTime: 60_000,
  });

  const branding = useQuery<BrandingResponse | null>({
    queryKey: ['branding'],
    queryFn: async () =>
      (await api.get<BrandingResponse | null>('/api/tenant-admin/branding')).data,
    enabled: Boolean(me.data),
    staleTime: 240_000,
    refetchInterval: 240_000,
  });

  const visibleClients = useMemo(
    () =>
      (clients.data ?? [])
        .filter((client) => client.status !== 'archived')
        .sort((left, right) => left.name.localeCompare(right.name)),
    [clients.data],
  );
  const selectedClient = visibleClients.find((client) => client.id === selectedClientId) ?? null;

  useEffect(() => {
    if (previousSection.current && previousSection.current !== page.key) {
      clearClientFilter();
    }
    previousSection.current = page.key;
  }, [clearClientFilter, page.key]);

  useEffect(() => {
    if (!selectedClientId || clients.isLoading) return;
    if (!visibleClients.some((client) => client.id === selectedClientId)) {
      clearClientFilter();
    }
  }, [clearClientFilter, clients.isLoading, selectedClientId, visibleClients]);

  const integrationConnections = useQuery<IntegrationConnection[]>({
    queryKey: ['engagement-integrations'],
    queryFn: async () =>
      (await api.get<IntegrationConnection[]>('/api/engagement/integrations')).data,
    enabled: Boolean(me.data),
    staleTime: 30_000,
  });

  const connectedInboxConnections = useMemo(
    () =>
      (integrationConnections.data ?? []).filter(
        (connection) =>
          connection.provider === 'microsoft_365' && connection.status === 'connected',
      ),
    [integrationConnections.data],
  );

  const syncInbox = useMutation({
    mutationFn: async (_options?: { silent?: boolean }) => {
      if (!connectedInboxConnections.length) {
        throw new Error('Connect your inbox before syncing.');
      }
      const syncWindow = defaultInboxSyncWindow();
      for (const connection of connectedInboxConnections) {
        await api.post(
          `/api/engagement/integrations/microsoft/${connection.id}/calendar-window`,
          undefined,
          { params: { from: syncWindow.from, to: syncWindow.to } },
        );
        await api.post(`/api/engagement/integrations/microsoft/${connection.id}/sync`, undefined, {
          params: { calendar: 'false', mail: 'true' },
        });
      }
    },
    onSuccess: (_data, options) => {
      setLastManualSyncAt(new Date().toISOString());
      if (!options?.silent) message.success('Inbox synced');
      qc.invalidateQueries({ queryKey: ['engagement-integrations'] });
      qc.invalidateQueries({ queryKey: ['engagement-meetings'] });
      qc.invalidateQueries({ queryKey: ['engagement-calendar-meetings'] });
      qc.invalidateQueries({ queryKey: ['engagement-mail-threads'] });
      qc.invalidateQueries({ queryKey: ['engagement-client-context'] });
      qc.invalidateQueries({ queryKey: ['engagement-report'] });
      qc.invalidateQueries({ queryKey: ['command-meetings'] });
      qc.invalidateQueries({ queryKey: ['command-tasks'] });
      qc.invalidateQueries({ queryKey: ['command-mail-threads'] });
      qc.invalidateQueries({ queryKey: ['client-meetings'] });
      qc.invalidateQueries({ queryKey: ['client-mail-threads'] });
    },
    onError: (err, options) => {
      if (!options?.silent) message.error(errorMessage(err));
    },
  });

  useEffect(() => {
    if (!connectedInboxConnections.length) return undefined;
    syncInbox.mutate({ silent: true });
    const timer = window.setInterval(() => syncInbox.mutate({ silent: true }), 15 * 60_000);
    return () => window.clearInterval(timer);
  }, [connectedInboxConnections.length, syncInbox.mutate]);

  useEffect(() => {
    const handler = () => {
      if (!connectedInboxConnections.length) {
        navigate('/settings/integrations');
        return;
      }
      syncInbox.mutate({ silent: false });
    };
    window.addEventListener('capiro:sync-inbox', handler);
    return () => window.removeEventListener('capiro:sync-inbox', handler);
  }, [connectedInboxConnections.length, navigate, syncInbox]);

  // Counts pulled from caches already populated above. We don't fire new
  // queries just to show a chip, if the page hasn't loaded them yet,
  // the chip is hidden until the data arrives.
  const navCounts = useMemo<Partial<Record<AppSection, number>>>(() => {
    return {
      clients: visibleClients.length || undefined,
    };
  }, [visibleClients.length]);

  const role = me.data?.role;
  const intelFlags = useIntelFeatureFlags();
  const items = useMemo(() => {
    // Role-gated nav entries (e.g. capiro_admin Analyst Console) are an
    // affordance only; the API's RolesGuard is the security boundary.
    const isVisible = (n: NavItem) =>
      (!n.minRole || (role != null && ROLE_RANK[role] >= ROLE_RANK[n.minRole])) &&
      (!n.featureFlag || Boolean(intelFlags.data?.[n.featureFlag]));

    const buildLeaf = (n: NavItem) => {
      const count = navCounts[n.key];
      const labelInner = (
        <span className="app-nav-label-row" data-tour={n.tourId}>
          <span className="app-nav-label-text">{n.label}</span>
          {count != null && count > 0 ? (
            <span className="app-nav-count num" aria-label={`${count} items`}>
              {count > 99 ? '99+' : count}
            </span>
          ) : null}
        </span>
      );
      return {
        key: n.key,
        icon: n.icon,
        title: n.label,
        disabled: n.disabled,
        className:
          [n.nested ? 'app-nav-item--nested' : '', n.disabled ? 'app-nav-item--disabled' : '']
            .filter(Boolean)
            .join(' ') || undefined,
        label:
          n.disabled || !n.path ? (
            labelInner
          ) : (
            <Link
              to={n.path}
              style={{ color: 'inherit' }}
              onClick={(event) => {
                if (!workflowLocked) return;
                event.preventDefault();
                message.info('Cancel or complete the outreach workflow before navigating away.');
              }}
            >
              {labelInner}
            </Link>
          ),
      };
    };

    const result: NonNullable<MenuProps['items']> = [];
    for (const n of NAV) {
      if (!isVisible(n)) continue;
      if (n.key === 'clients') {
        result.push({ type: 'divider' });
      }
      if (n.children) {
        const kids = n.children.filter(isVisible);
        if (!kids.length) continue;
        result.push({
          key: n.key,
          icon: n.icon,
          title: n.label,
          label: (
            <span className="app-nav-label-row" data-tour={n.tourId}>
              <span className="app-nav-label-text">{n.label}</span>
            </span>
          ),
          children: kids.map(buildLeaf),
        });
      } else {
        result.push(buildLeaf(n));
      }
    }
    return result;
  }, [message, navCounts, role, workflowLocked, intelFlags.data]);

  const selectedKey = page.key === 'not-found' ? 'home' : page.key;

  const accountMenu: MenuProps = {
    items: [
      { key: 'profile', label: 'Profile' },
      { key: 'logout', label: 'Log out' },
    ],
    onClick: ({ key }) => {
      if (key === 'profile') {
        openUserProfile();
        return;
      }
      void signOut({ redirectUrl: '/sign-in' });
    },
  };

  return (
    <>
      <Layout className="app-shell">
        <Sider
          width={272}
          collapsedWidth={72}
          collapsed={navCollapsed}
          trigger={null}
          className="app-shell-sider"
        >
          <nav className="app-shell-nav" aria-label="Primary navigation">
            <div className="app-shell-brand-row">
              <button
                className="app-shell-brand"
                type="button"
                onClick={() => {
                  if (workflowLocked) {
                    message.info(
                      'Cancel or complete the outreach workflow before navigating away.',
                    );
                    return;
                  }
                  navigate('/clients');
                }}
                aria-label="Go to Clients"
              >
                {navCollapsed ? (
                  <span className="app-shell-logo-mark">C</span>
                ) : (
                  <img src="/logo.png" alt="Capiro" className="app-shell-logo" />
                )}
              </button>
              <button
                className="app-shell-collapse"
                type="button"
                aria-label={navCollapsed ? 'Expand navigation' : 'Collapse navigation'}
                onClick={() => setNavCollapsed((value) => !value)}
              >
                {navCollapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
              </button>
            </div>

            <Menu
              theme="dark"
              mode="inline"
              selectedKeys={[selectedKey]}
              defaultOpenKeys={['pe-group']}
              items={items}
              inlineCollapsed={navCollapsed}
              inlineIndent={24}
              className="app-nav-menu"
            />

            <div className="app-shell-bottom">
              <SyncInboxControl
                connections={connectedInboxConnections}
                loading={integrationConnections.isLoading}
                queryError={integrationConnections.isError}
                syncing={syncInbox.isPending}
                syncError={syncInbox.isError}
                lastManualSyncAt={lastManualSyncAt}
                onClick={() => {
                  if (!connectedInboxConnections.length) {
                    navigate('/settings/integrations');
                    return;
                  }
                  syncInbox.mutate({ silent: false });
                }}
              />

              <Link
                to="/settings"
                className={`app-bottom-nav-item${selectedKey === 'settings' ? ' is-active' : ''}`}
                onClick={(event) => {
                  if (!workflowLocked) return;
                  event.preventDefault();
                  message.info('Cancel or complete the outreach workflow before navigating away.');
                }}
              >
                <SettingOutlined />
                <span>Settings</span>
              </Link>

              {/* Onboarding v1 (Flow 2B.4): re-open the product tour from any
                  page. Visible to ALL tenants (harmless); only onboarding
                  tenants auto-launch it. Navigates to the Dashboard first,
                  then starts at step 1. */}
              <button
                type="button"
                className="app-bottom-nav-item"
                onClick={() => {
                  if (workflowLocked) {
                    message.info(
                      'Cancel or complete the outreach workflow before navigating away.',
                    );
                    return;
                  }
                  navigate('/');
                  window.dispatchEvent(new Event(START_TOUR_EVENT));
                }}
              >
                <QuestionCircleOutlined />
                <span>Help &amp; product tour</span>
              </button>

              <Link
                to="/help"
                className={`app-bottom-nav-item${selectedKey === 'help' ? ' is-active' : ''}`}
                onClick={(event) => {
                  if (!workflowLocked) return;
                  event.preventDefault();
                  message.info('Cancel or complete the outreach workflow before navigating away.');
                }}
              >
                <QuestionCircleOutlined />
                <span>Help</span>
              </Link>
            </div>
          </nav>
        </Sider>

        <Layout className="app-main-layout">
          <Header className="app-topbar">
            <TopbarTenantBrand
              logoUrl={branding.data?.logoUrl ?? null}
              name={branding.data?.name ?? me.data?.tenant.name ?? 'Capiro'}
            />
            <TopbarSearch />
            <span className="app-topbar-spacer" />
            <QuickLogButton />
            <WorkspaceNotificationBell />
            <button
              className="app-topbar-icon-button"
              type="button"
              aria-label="Open settings"
              onClick={() => {
                if (workflowLocked) {
                  message.info('Cancel or complete the outreach workflow before navigating away.');
                  return;
                }
                navigate('/settings');
              }}
            >
              <SettingOutlined />
            </button>
            <Dropdown menu={accountMenu} trigger={['click']} placement="bottomRight">
              <button
                className="app-topbar-account"
                type="button"
                aria-label={`Open account menu for ${displayName}`}
              >
                <Avatar size={36} src={user?.imageUrl || undefined} icon={<UserOutlined />}>
                  {initials(displayName)}
                </Avatar>
                <span className="app-topbar-account-stack">
                  <span className="app-topbar-account-name">{displayName}</span>
                  {displayTitle ? (
                    <span className="app-topbar-account-title">{displayTitle}</span>
                  ) : null}
                </span>
              </button>
            </Dropdown>
          </Header>

          {/* Onboarding v1 (Flow 3): persistent free-trial strip under the top
              bar on every screen. Renders null unless onboardingFlowVersion===1
              AND status==='trialing' — legacy tenants see zero change. */}
          <TrialBanner />

          {page.showClientDropdown && selectedClient ? (
            <ClientContextBanner client={selectedClient} onClear={clearClientFilter} />
          ) : null}

          <Content className="app-content">
            {me.error ? (
              <Alert
                type="error"
                message="Could not load your profile"
                description={(me.error as Error).message}
                className="app-content-alert"
              />
            ) : null}
            {actAsTenantSlug ? (
              <Alert
                type="info"
                showIcon
                closable
                message="Impersonation active"
                description={`You are viewing ${actAsTenantSlug}.`}
                onClose={endImpersonation}
                className="app-content-alert"
              />
            ) : null}
            {/* Onboarding v1 gate chain (setup gate → personal email/calendar
                gate → tour). Renders children untouched for legacy tenants. */}
            <OnboardingGates>
              <Outlet />
            </OnboardingGates>
          </Content>
        </Layout>
      </Layout>
      {me.data?.features.meriDockUndockUi ? (
        <MeriOverlay selectedClientName={selectedClient?.name ?? null} />
      ) : (
        <ChatDrawer selectedClientName={selectedClient?.name ?? null} />
      )}
    </>
  );
}

function TopbarTenantBrand({ logoUrl, name }: { logoUrl: string | null; name: string }) {
  return (
    <div className="app-topbar-tenant-brand" aria-label={`Current company: ${name}`}>
      <span className="app-topbar-tenant-logo">
        {logoUrl ? <img src={logoUrl} alt={`${name} logo`} /> : initials(name)}
      </span>
      <span className="app-topbar-tenant-name">{name}</span>
    </div>
  );
}

/**
 * Global keyword search in the top bar. Debounced calls to /api/search across
 * all ingested federal datasets (bills, awards, LDA filings, hearings, SEC/FARA,
 * GAO/CRS, dockets, intel, state bills, federal register). Keyword/substring
 * match — no embeddings. Results render in a dropdown; clicking one navigates
 * to its explorer route when available.
 */
interface GlobalSearchResult {
  category: string;
  id: string;
  title: string;
  subtitle?: string | null;
  date?: string | null;
  href?: string | null;
}
interface GlobalSearchResponse {
  query: string;
  total: number;
  results: GlobalSearchResult[];
  byCategory: Record<string, number>;
}

const SEARCH_CATEGORY_LABELS: Record<string, string> = {
  bill: 'Bill',
  award: 'Federal award',
  lda_filing: 'LDA filing',
  hearing: 'Hearing',
  sec_filing: 'SEC filing',
  fara_registration: 'FARA',
  gao_report: 'GAO report',
  crs_report: 'CRS report',
  regulatory_docket: 'Reg. docket',
  intel_article: 'Intel',
  state_bill: 'State bill',
  federal_register: 'Fed. Register',
};

function TopbarSearch() {
  const api = useApi();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Debounce the query (250ms) so we don't fire a request per keystroke.
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(query.trim()), 250);
    return () => window.clearTimeout(t);
  }, [query]);

  const { data, isFetching } = useQuery({
    queryKey: ['global-search', debounced],
    queryFn: async () =>
      (await api.get<GlobalSearchResponse>(`/api/search?q=${encodeURIComponent(debounced)}`)).data,
    enabled: debounced.length >= 2,
    staleTime: 30_000,
  });

  // Close the dropdown on outside click.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const results = data?.results ?? [];
  const showDropdown = open && debounced.length >= 2;

  const onSelect = (r: GlobalSearchResult) => {
    setOpen(false);
    setQuery('');
    if (r.href) navigate(r.href);
  };

  return (
    <div ref={containerRef} className="app-topbar-search-wrap" style={{ position: 'relative' }}>
      <form
        className="app-topbar-search"
        role="search"
        onSubmit={(e) => e.preventDefault()}
        aria-label="Global search"
      >
        <SearchOutlined className="app-topbar-search-icon" aria-hidden />
        <input
          type="search"
          className="app-topbar-search-input"
          placeholder="Search bills, agencies, stakeholders…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          aria-label="Search across all data"
        />
        <span className="app-topbar-search-hint" aria-hidden>
          ⌘K
        </span>
      </form>
      {showDropdown && (
        <div
          className="app-topbar-search-results"
          role="listbox"
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            left: 0,
            right: 0,
            maxHeight: 420,
            overflowY: 'auto',
            background: 'var(--surface-1, #fff)',
            border: '1px solid var(--border-2, #e5e7eb)',
            borderRadius: 8,
            boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
            zIndex: 1200,
          }}
        >
          {isFetching && results.length === 0 ? (
            <div style={{ padding: '12px 14px', fontSize: 13, color: 'var(--text-3, #6b7280)' }}>
              Searching…
            </div>
          ) : results.length === 0 ? (
            <div style={{ padding: '12px 14px', fontSize: 13, color: 'var(--text-3, #6b7280)' }}>
              No matches for “{debounced}”
            </div>
          ) : (
            results.map((r) => (
              <button
                key={`${r.category}:${r.id}`}
                type="button"
                role="option"
                aria-selected={false}
                onClick={() => onSelect(r)}
                style={{
                  display: 'flex',
                  width: '100%',
                  gap: 10,
                  alignItems: 'baseline',
                  padding: '8px 14px',
                  background: 'transparent',
                  border: 'none',
                  borderBottom: '1px solid var(--border-1, #f1f5f9)',
                  textAlign: 'left',
                  cursor: r.href ? 'pointer' : 'default',
                }}
              >
                <span
                  style={{
                    flex: '0 0 auto',
                    fontSize: 10.5,
                    textTransform: 'uppercase',
                    letterSpacing: 0.3,
                    color: 'var(--text-3, #6b7280)',
                    minWidth: 84,
                  }}
                >
                  {SEARCH_CATEGORY_LABELS[r.category] ?? r.category}
                </span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span
                    style={{
                      display: 'block',
                      fontSize: 13.5,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {r.title}
                  </span>
                  {r.subtitle && (
                    <span
                      style={{
                        display: 'block',
                        fontSize: 12,
                        color: 'var(--text-3, #6b7280)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {r.subtitle}
                    </span>
                  )}
                </span>
                {r.date && (
                  <span
                    style={{ flex: '0 0 auto', fontSize: 11.5, color: 'var(--text-3, #9ca3af)' }}
                  >
                    {r.date}
                  </span>
                )}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function ClientDropdown({
  clients,
  selectedClient,
  selectedClientId,
  loading,
  onSelect,
  onNavigateToClients,
}: {
  clients: Client[];
  selectedClient: Client | null;
  selectedClientId: string | null;
  loading: boolean;
  onSelect: (clientId: string | null) => void;
  onNavigateToClients: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const searchable = clients.length > 10;
  const normalizedSearch = search.trim().toLowerCase();
  const filteredClients = normalizedSearch
    ? clients.filter((client) => client.name.toLowerCase().includes(normalizedSearch))
    : clients;

  const handleSelect = (clientId: string | null) => {
    onSelect(clientId);
    setOpen(false);
  };

  const content = (
    <div
      className="app-client-menu"
      onClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <button
        className="app-client-menu-row-button"
        type="button"
        onClick={() => handleSelect(null)}
      >
        <span>All Clients</span>
        {!selectedClientId ? <CheckOutlined /> : null}
      </button>
      <span className="app-client-menu-divider" />
      {searchable ? (
        <Input
          allowClear
          autoFocus
          className="app-client-menu-search"
          placeholder="Search clients..."
          prefix={<SearchOutlined />}
          size="small"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        />
      ) : null}
      <div className="app-client-menu-list">
        {clients.length ? (
          filteredClients.length ? (
            filteredClients.map((client) => (
              <button
                className="app-client-menu-row-button"
                key={client.id}
                type="button"
                onClick={() => handleSelect(client.id)}
              >
                <span className="app-client-menu-name">
                  <Avatar size={22} src={client.logoUrl || undefined} alt={`${client.name} logo`}>
                    {initials(client.name)}
                  </Avatar>
                  <span>{client.name}</span>
                </span>
                {selectedClientId === client.id ? <CheckOutlined /> : null}
              </button>
            ))
          ) : (
            <Typography.Text className="app-client-menu-empty" type="secondary">
              No matching clients
            </Typography.Text>
          )
        ) : (
          <button
            className="app-client-menu-empty-button"
            type="button"
            onClick={onNavigateToClients}
          >
            No clients yet - add one in the Clients section
          </button>
        )}
      </div>
    </div>
  );

  return (
    <Popover
      arrow={false}
      content={content}
      open={open}
      overlayClassName="app-client-popover"
      placement="bottomLeft"
      trigger="click"
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (nextOpen) setSearch('');
      }}
    >
      <button className="app-client-dropdown-trigger" type="button">
        {selectedClient ? (
          <>
            <Avatar
              size={24}
              src={selectedClient.logoUrl || undefined}
              alt={`${selectedClient.name} logo`}
            >
              {initials(selectedClient.name)}
            </Avatar>
            <span>{selectedClient.name}</span>
          </>
        ) : (
          <span>{loading ? 'Loading clients...' : 'All Clients'}</span>
        )}
        <DownOutlined />
      </button>
    </Popover>
  );
}

function ClientContextBanner({ client, onClear }: { client: Client; onClear: () => void }) {
  return (
    <div className="app-client-context-banner">
      <span className="app-client-context-label">Viewing:</span>
      <Avatar size={22} src={client.logoUrl || undefined} alt={`${client.name} logo`}>
        {initials(client.name)}
      </Avatar>
      <strong>{client.name}</strong>
      <span aria-hidden="true">·</span>
      <button type="button" onClick={onClear}>
        Clear filter
      </button>
      <span className="app-client-context-spacer" />
      <span className="app-client-context-count">Showing data for 1 client</span>
    </div>
  );
}

function PageActions({ page }: { page: AppSection }) {
  void page;
  return null;
}

function SyncInboxControl({
  connections,
  loading,
  queryError,
  syncing,
  syncError,
  lastManualSyncAt,
  onClick,
}: {
  connections: IntegrationConnection[];
  loading: boolean;
  queryError: boolean;
  syncing: boolean;
  syncError: boolean;
  lastManualSyncAt: string | null;
  onClick: () => void;
}) {
  const connected = connections.length > 0;
  const lastSyncAt = latestSyncAt(connections, lastManualSyncAt);
  const status = syncStatus({ connected, loading, queryError, syncing, syncError, lastSyncAt });

  return (
    <button className="app-sync-control" type="button" onClick={onClick}>
      {status.dot ? <span className={`app-sync-dot app-sync-dot--${status.dot}`} /> : null}
      <span>
        <span className="app-sync-label">{status.label}</span>
        {status.text ? <span className="app-sync-status">{status.text}</span> : null}
      </span>
      <SyncOutlined className="app-sync-icon" />
    </button>
  );
}

function syncStatus({
  connected,
  loading,
  queryError,
  syncing,
  syncError,
  lastSyncAt,
}: {
  connected: boolean;
  loading: boolean;
  queryError: boolean;
  syncing: boolean;
  syncError: boolean;
  lastSyncAt: string | null;
}): { label: string; text: string; dot: 'green' | 'yellow' | 'red' | null } {
  if (loading) return { label: 'Connect inbox', text: '', dot: null };
  if (!connected && !queryError) return { label: 'Connect inbox', text: '', dot: null };
  if (syncing) return { label: 'Sync Inbox', text: 'Syncing inbox...', dot: 'yellow' };
  if (queryError || syncError) {
    return {
      label: connected ? 'Sync Inbox' : 'Connect inbox',
      text: 'Sync failed - tap to retry',
      dot: 'red',
    };
  }
  return { label: 'Sync Inbox', text: lastSyncText(lastSyncAt), dot: 'green' };
}

function pageKeyFor(pathname: string): AppSection {
  if (pathname === '/') return 'home';
  if (pathname.startsWith('/clients')) return 'clients';
  if (pathname.startsWith('/engagement')) return 'engagement';
  if (pathname.startsWith('/workspace')) return 'workspace';
  if (pathname.startsWith('/actions')) return 'actions';
  if (pathname.startsWith('/reviews')) return 'reviews';
  // LegiWatch (canonical /legiwatch; /radar kept as a redirect for live deep-links).
  if (pathname.startsWith('/legiwatch') || pathname.startsWith('/radar')) return 'radar';
  // Knowledge Graph has its own nav entry — match its specific route BEFORE the
  // general /intelligence prefix, otherwise it falls through to 'intelligence'
  // (Data Explorer) and the wrong child highlights.
  if (pathname.startsWith('/intelligence/graph')) return 'knowledge-graph';
  // Only the live hearing ROOM still lives here (the list redirects to Radar).
  // Highlight Radar: 'hearing-watch' is no longer a nav item, and the room is a
  // Radar child surface now (P4 review finding).
  if (pathname.startsWith('/intelligence/hearing-watch')) return 'radar';
  if (pathname.startsWith('/explorer') || pathname.startsWith('/intelligence'))
    return 'intelligence';
  if (pathname.startsWith('/admin/analyst-console')) return 'analyst-console';
  if (pathname.startsWith('/program-elements')) return 'program-elements';
  if (pathname.startsWith('/directory')) return 'directory';
  if (pathname.startsWith('/portal')) return 'portal';
  if (pathname.startsWith('/settings')) return 'settings';
  if (pathname.startsWith('/help')) return 'help';
  return 'not-found';
}

function pageConfigFor(pathname: string): PageConfig {
  const key = pageKeyFor(pathname);
  const titleByKey: Record<AppSection, string> = {
    home: 'Dashboard',
    clients: 'Portfolio',
    engagement: 'Engagement',
    workspace: 'Workspace',
    planner: 'Planner',
    intelligence: 'Intelligence Center',
    'knowledge-graph': 'Knowledge Graph',
    actions: 'Action Board',
    reviews: 'Review Queue',
    'pe-group': 'Program Elements',
    'program-elements': 'Program Elements',
    radar: 'LegiWatch',
    'hearing-watch': 'Hearing Watch',
    'analyst-console': 'Analyst Console',
    directory: 'Directory',
    stakeholders: 'Stakeholders',
    collaborators: 'Collaborators',
    portal: 'Client Portal',
    settings: 'Settings',
    help: 'Help',
    'not-found': 'Not found',
  };
  const showClientDropdown = key === 'engagement';
  return { key, title: titleByKey[key], showClientDropdown };
}

function latestSyncAt(
  connections: IntegrationConnection[],
  lastManualSyncAt: string | null,
): string | null {
  const timestamps = [...connections.map((connection) => connection.lastSyncAt), lastManualSyncAt]
    .filter((value): value is string => Boolean(value))
    .map((value) => new Date(value).getTime())
    .filter((value) => Number.isFinite(value));
  if (!timestamps.length) return null;
  return new Date(Math.max(...timestamps)).toISOString();
}

function lastSyncText(value: string | null): string {
  if (!value) return 'Not yet synced';
  const diffMs = Math.max(0, Date.now() - new Date(value).getTime());
  const diffMinutes = Math.floor(diffMs / 60_000);
  if (diffMinutes < 1) return 'Last synced: just now';
  if (diffMinutes < 60) return `Last synced: ${diffMinutes} min ago`;
  const diffHours = Math.floor(diffMinutes / 60);
  return `Last synced: ${diffHours} ${diffHours === 1 ? 'hour' : 'hours'} ago`;
}

function defaultInboxSyncWindow(): { from: string; to: string } {
  const from = new Date();
  from.setHours(0, 0, 0, 0);
  const to = new Date(from);
  to.setDate(to.getDate() + 14);
  return { from: from.toISOString(), to: to.toISOString() };
}

function initials(value: string): string {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'C';
  if (parts.length === 1) return parts[0]?.slice(0, 2).toUpperCase() || 'C';
  return `${parts[0]?.[0] ?? ''}${parts[1]?.[0] ?? ''}`.toUpperCase() || 'C';
}

function errorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'response' in error) {
    const data = (error as { response?: { data?: { message?: unknown } } }).response?.data;
    if (typeof data?.message === 'string') return data.message;
    if (Array.isArray(data?.message)) return data.message.join(', ');
  }
  return error instanceof Error ? error.message : 'Request failed';
}
