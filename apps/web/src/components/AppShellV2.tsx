// Capiro internal application shell — Quiet Authority v3.
//
// The visual source of truth is the latest Capiro Design System v3 shell:
// 64px porcelain top bar, 232px expanded / 72px collapsed mist navigation,
// centered global search, restrained elevation, and Instrument Sans product UI.
// This remains tenant-gated by AppShell.tsx; legacy tenants keep the existing
// Ant Design sidebar shell. Navigation, search, notifications, Meri, profile,
// feature gates, client scope, and data context remain wired to production data.

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useClerk, useUser } from '@clerk/clerk-react';
import { useQuery } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import {
  ApartmentOutlined,
  CalendarOutlined,
  DashboardOutlined,
  DeploymentUnitOutlined,
  FileSearchOutlined,
  FolderOpenOutlined,
  FundOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  MoreOutlined,
  RadarChartOutlined,
  SettingOutlined,
} from '@ant-design/icons';
import { ROLE_RANK, type TenantRole } from '@capiro/shared';
import type { MeResponse } from '../lib/me.js';
import { useApi } from '../lib/use-api.js';
import { useIntelFeatureFlags } from '../lib/intel-feature-flags.js';
import { openMeriWorkspaceWindow } from './chat/meri-window.js';
import { useClientFilter } from '../state/client-filter.js';
import { useNotifications } from '../pages/workspace/api.js';
import { getProgramElementSummary } from '../pages/program-element/api.js';
import type { Client } from '../pages/clients/clientTypes.js';
import './app-shell-premium.css';
import './app-shell-quiet-authority.css';

type V2Section =
  | 'dashboard'
  | 'engagement'
  | 'portfolio'
  | 'workspace'
  | 'intelligence'
  | 'directory'
  | 'more';

interface V2NavLeaf {
  key: string;
  label: string;
  path?: string;
  tag?: string;
  minRole?: TenantRole;
  featureFlag?: string;
  meFeature?: keyof MeResponse['features'];
}

interface DashboardSignal {
  detectedAt: string;
}

interface ProfileItem {
  label: string;
  tag?: string;
  path?: string;
  action?: 'signout' | 'profile';
}

const INTELLIGENCE: V2NavLeaf[] = [
  { key: 'legiwatch', label: 'LegiWatch', path: '/legiwatch' },
  { key: 'explorer', label: 'Data Explorer', path: '/explorer' },
  { key: 'federal-spending', label: 'Federal Spending', path: '/intelligence/federal-spending' },
  {
    key: 'district-nexus',
    label: 'District Nexus',
    path: '/intelligence/district-nexus',
    tag: 'FLAG',
    featureFlag: 'district_nexus_v2',
  },
  { key: 'knowledge-graph', label: 'Knowledge Graph', path: '/intelligence/graph' },
];

const MORE: V2NavLeaf[] = [
  { key: 'directory', label: 'Directory', path: '/directory' },
  {
    key: 'strategies',
    label: 'Strategies',
    path: '/strategies',
    tag: 'FLAG',
    meFeature: 'strategyPlanner',
  },
  { key: 'actions', label: 'Action Board', path: '/actions' },
  { key: 'portal', label: 'Client Portal', path: '/portal' },
  {
    key: 'analyst-console',
    label: 'Analyst Console',
    path: '/admin/analyst-console',
    tag: 'ADMIN',
    minRole: 'capiro_admin' as TenantRole,
  },
];

const PROFILE_ITEMS: ProfileItem[] = [
  { label: 'Profile', action: 'profile' },
  { label: 'Preferences', path: '/settings' },
  { label: 'Settings', path: '/settings' },
  { label: 'Integrations', path: '/settings/integrations' },
  { label: 'Keyboard shortcuts', tag: 'CTRL /' },
  { label: 'Help & support', path: '/help' },
  { label: 'Sign out', action: 'signout' },
];

const NAV_COLLAPSE_KEY = 'capiro:quiet-authority-nav-collapsed';

export function AppShellV2({ me }: { me: MeResponse }) {
  const api = useApi();
  const navigate = useNavigate();
  const location = useLocation();
  const { message } = AntApp.useApp();
  const { signOut, openUserProfile } = useClerk();
  const { user } = useUser();
  const intelFlags = useIntelFeatureFlags();
  const { selectedClientId, setSelectedClientId } = useClientFilter();
  const notifications = useNotifications();

  const section = sectionFor(location.pathname);
  const role = me.role;
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [q, setQ] = useState('');
  const [navCollapsed, setNavCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    const persisted = window.localStorage.getItem(NAV_COLLAPSE_KEY);
    if (persisted != null) return persisted === 'true';
    return window.location.pathname === '/';
  });

  const closeAll = () => {
    setOpenMenu(null);
    setSearchOpen(false);
  };

  const showContextBar = section === 'portfolio' || section === 'engagement';

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (window.localStorage.getItem(NAV_COLLAPSE_KEY) == null) {
      setNavCollapsed(section === 'dashboard');
    }
  }, [section]);

  useEffect(() => {
    const root = document.querySelector<HTMLElement>('.v2-root');
    if (!root) return undefined;
    root.dataset.shellVersion = '3';
    root.dataset.navCollapsed = String(navCollapsed);
    root.dataset.shellContext = String(showContextBar);
    return () => {
      delete root.dataset.shellVersion;
      delete root.dataset.navCollapsed;
      delete root.dataset.shellContext;
    };
  }, [navCollapsed, showContextBar]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const key = (event.key || '').toLowerCase();
      if ((event.metaKey || event.ctrlKey) && key === 'j') {
        event.preventDefault();
        openMeriWorkspaceWindow();
      }
      if ((event.metaKey || event.ctrlKey) && key === 'k') {
        event.preventDefault();
        setOpenMenu(null);
        setSearchOpen(true);
      }
      if (key === 'escape') closeAll();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const clients = useQuery<Client[]>({
    queryKey: ['clients'],
    queryFn: async () => (await api.get<Client[]>('/api/clients')).data,
    staleTime: 60_000,
  });
  const visibleClients = useMemo(
    () =>
      (clients.data ?? [])
        .filter((client) => client.status !== 'archived')
        .sort((left, right) => left.name.localeCompare(right.name)),
    [clients.data],
  );
  const selectedClient = visibleClients.find((client) => client.id === selectedClientId) ?? null;

  const peSummary = useQuery({
    queryKey: ['program-element-summary'],
    queryFn: () => getProgramElementSummary(api),
    staleTime: 300_000,
  });

  const dashboardSignals = useQuery<DashboardSignal[]>({
    queryKey: ['intel-changes-tracked'],
    queryFn: async () => {
      const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      return (
        await api.get<DashboardSignal[]>('/api/intelligence/changes', { params: { since } })
      ).data;
    },
    enabled: section === 'dashboard',
    staleTime: 2 * 60 * 1000,
  });

  const overnightSignals = useMemo(() => {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    return (dashboardSignals.data ?? []).filter(
      (signal) => new Date(signal.detectedAt).getTime() >= cutoff,
    ).length;
  }, [dashboardSignals.data]);

  // Dashboard is an all-client command view. Never allow a persisted hidden
  // client filter to affect the data while the client picker is absent.
  useEffect(() => {
    if (section === 'dashboard' && selectedClientId) {
      setSelectedClientId(null);
    }
  }, [section, selectedClientId, setSelectedClientId]);

  const unread = notifications.data?.unread ?? 0;
  const displayName =
    user?.fullName ||
    [me.user.firstName, me.user.lastName].filter(Boolean).join(' ') ||
    me.user.email ||
    'Account';
  const profileName = user?.firstName || me.user.firstName || displayName.split(/\s+/)[0] || 'Account';
  const displayTitle = me.user.title ?? null;
  const profileImageUrl = user?.imageUrl || null;
  const requestFy = peSummary.data?.latestRequestFy ?? null;
  const initialsText = initials(displayName);

  const isVisible = (item: V2NavLeaf) =>
    (!item.minRole || (role != null && ROLE_RANK[role] >= ROLE_RANK[item.minRole])) &&
    (!item.featureFlag || Boolean(intelFlags.data?.[item.featureFlag])) &&
    (!item.meFeature || Boolean(me.features?.[item.meFeature]));

  const intelligenceItems = INTELLIGENCE.filter(isVisible);
  const moreItems = MORE.filter(isVisible);
  const fundingEnabled = Boolean(intelFlags.data?.funding_opportunities);

  const go = (path?: string) => {
    closeAll();
    if (path) navigate(path);
  };

  const toggleNav = () => {
    const next = !navCollapsed;
    setNavCollapsed(next);
    try {
      window.localStorage.setItem(NAV_COLLAPSE_KEY, String(next));
    } catch {
      // Navigation remains usable even when storage is unavailable.
    }
  };

  const searchResults = useMemo(() => {
    const query = q.trim().toLowerCase();
    const pool: { kind: string; title: string; href: string }[] = [
      ...visibleClients.map((client) => ({
        kind: 'CLIENT',
        title: client.name,
        href: `/clients/${client.id}`,
      })),
      { kind: 'WORKSPACE', title: 'LegiWatch', href: '/legiwatch' },
      { kind: 'WORKSPACE', title: 'Program Elements', href: '/program-elements' },
      { kind: 'WORKSPACE', title: 'Funding Opportunities', href: '/intelligence/opportunities' },
      { kind: 'WORKSPACE', title: 'Engagement', href: '/engagement' },
      { kind: 'WORKSPACE', title: 'Workspace', href: '/workspace' },
    ];
    if (!query) return pool.slice(0, 8);
    return pool.filter((result) => result.title.toLowerCase().includes(query)).slice(0, 10);
  }, [q, visibleClients]);

  const refreshedLabel = dashboardSignals.dataUpdatedAt
    ? `REFRESHED ${formatRefreshTime(dashboardSignals.dataUpdatedAt)}`
    : dashboardSignals.isLoading
      ? 'REFRESHING…'
      : 'REFRESHED —';

  const intelligenceActive = isIntelligenceActive(location.pathname);
  const settingsActive =
    location.pathname.startsWith('/settings') && !location.pathname.startsWith('/settings/memory');
  const moreActive =
    location.pathname.startsWith('/directory') ||
    location.pathname.startsWith('/strategies') ||
    location.pathname.startsWith('/actions') ||
    location.pathname.startsWith('/portal') ||
    location.pathname.startsWith('/admin/analyst-console');

  return (
    <div
      className={`v2-shell quiet-authority-shell${
        navCollapsed ? ' is-collapsed' : ''
      }${section === 'dashboard' ? ' is-dashboard' : ''}${showContextBar ? ' has-context' : ''}`}
    >
      <header className="qa-topbar">
        <div className="qa-topbar-anchor" aria-hidden />
        <button type="button" className="qa-home-hit" aria-label="Capiro home" onClick={() => go('/')}>
          <span className="qa-visually-hidden">Capiro</span>
        </button>

        <div className="qa-topbar-main">
          <div className="qa-search-wrap">
            <span className="qa-search-label">GLOBAL SEARCH</span>
            <button
              type="button"
              className={`qa-search${searchOpen ? ' is-open' : ''}`}
              onClick={() => {
                setOpenMenu(null);
                setSearchOpen((value) => !value);
              }}
              aria-label="Global search"
            >
              <SearchIcon />
              <span className="qa-search-text">Search clients, issues, programs, people…</span>
              <span className="qa-search-shortcut">⌘K</span>
            </button>
            {searchOpen ? (
              <div className="qa-pop qa-search-pop" role="dialog" aria-label="Search">
                <div className="qa-search-pop-head">
                  <SearchIcon muted />
                  <input
                    autoFocus
                    value={q}
                    onChange={(event) => setQ(event.target.value)}
                    placeholder="Search clients, issues, programs, people…"
                    aria-label="Global search"
                    className="qa-search-input"
                  />
                </div>
                {searchResults.map((result) => (
                  <button
                    key={`${result.kind}-${result.href}-${result.title}`}
                    type="button"
                    className="qa-pop-row"
                    onClick={() => go(result.href)}
                  >
                    <span className="qa-search-result-kind">{result.kind}</span>
                    <span className="qa-pop-label">{result.title}</span>
                  </button>
                ))}
                {searchResults.length === 0 ? (
                  <div className="qa-pop-row" aria-disabled>
                    No matching results.
                  </div>
                ) : null}
                <div className="qa-search-foot">
                  {section === 'dashboard'
                    ? `ALL-CLIENT SEARCH · ${overnightSignals} OVERNIGHT SIGNALS`
                    : `SCOPED TO ${(selectedClient?.name ?? 'All clients').toUpperCase()}`}
                </div>
              </div>
            ) : null}
          </div>

          <div className="qa-topbar-actions">
            {section !== 'dashboard' ? (
              <button
                type="button"
                className="qa-meri"
                title="Open Meri in its own window — Ctrl+J"
                aria-label="Open the Meri window"
                onClick={() => openMeriWorkspaceWindow()}
                data-tour="Meri"
              >
                <span className="qa-meri-dot" aria-hidden />
                <span>Meri</span>
              </button>
            ) : null}

            <button
              type="button"
              className="qa-icon-btn"
              aria-label="Notifications"
              onClick={() => navigate('/?notifications=1')}
            >
              <BellIcon />
              {unread > 0 ? <span className="qa-bell-count">{unread > 99 ? '99+' : unread}</span> : null}
            </button>

            <div className="qa-profile-wrap">
              <button
                type="button"
                className="qa-profile"
                onClick={() => setOpenMenu(openMenu === 'profile' ? null : 'profile')}
                aria-label={`Open account menu for ${displayName}`}
              >
                <span className="qa-profile-avatar" aria-hidden>
                  {profileImageUrl ? <img src={profileImageUrl} alt="" /> : initialsText}
                </span>
                <span className="qa-profile-copy">
                  <span className="qa-profile-name">{profileName}</span>
                  {displayTitle ? <span className="qa-profile-title">{displayTitle}</span> : null}
                </span>
              </button>
              {openMenu === 'profile' ? (
                <div className="qa-pop qa-profile-pop" role="menu">
                  <div className="qa-profile-head">
                    <div className="qa-profile-head-name">{displayName}</div>
                    {displayTitle ? <div className="qa-profile-head-title">{displayTitle}</div> : null}
                  </div>
                  {PROFILE_ITEMS.map((item) => (
                    <button
                      key={item.label}
                      type="button"
                      role="menuitem"
                      className={`qa-pop-row${item.action === 'signout' ? ' is-signout' : ''}`}
                      onClick={() => {
                        closeAll();
                        if (item.action === 'signout') void signOut({ redirectUrl: '/sign-in' });
                        else if (item.action === 'profile') openUserProfile();
                        else if (item.path) navigate(item.path);
                        else message.info('Keyboard shortcuts: Ctrl+J Meri · Ctrl+K search · Esc close');
                      }}
                    >
                      <span className="qa-pop-label">{item.label}</span>
                      {item.tag ? <span className="qa-pop-tag">{item.tag}</span> : null}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </header>

      <aside className="qa-sidebar" aria-label="Primary navigation">
        <div className="qa-sidebar-label">WORKSPACE</div>
        <nav className="qa-nav" aria-label="Primary navigation">
          <ShellNavLink
            label="Home"
            icon={<DashboardOutlined />}
            active={location.pathname === '/'}
            collapsed={navCollapsed}
            onClick={() => go('/')}
            tourId="Dashboard"
          />
          <ShellNavLink
            label="Clients"
            icon={<ApartmentOutlined />}
            active={location.pathname.startsWith('/clients')}
            collapsed={navCollapsed}
            onClick={() => go('/clients')}
            tourId="Portfolio"
          />
          <ShellNavMenu
            id="intel"
            label="Intelligence"
            icon={<RadarChartOutlined />}
            active={intelligenceActive}
            collapsed={navCollapsed}
            open={openMenu === 'intel'}
            onToggle={() => {
              setSearchOpen(false);
              setOpenMenu(openMenu === 'intel' ? null : 'intel');
            }}
            items={intelligenceItems}
            activePath={location.pathname}
            onPick={go}
            tourId="Intelligence"
          />
          <ShellNavLink
            label="Program Elements"
            icon={<FundOutlined />}
            active={location.pathname.startsWith('/program-elements')}
            collapsed={navCollapsed}
            onClick={() => go('/program-elements')}
          />
          {fundingEnabled ? (
            <ShellNavLink
              label="Funding Opportunities"
              icon={<FileSearchOutlined />}
              active={location.pathname.startsWith('/intelligence/opportunities')}
              collapsed={navCollapsed}
              onClick={() => go('/intelligence/opportunities')}
            />
          ) : null}
          <ShellNavLink
            label="Engagement"
            icon={<CalendarOutlined />}
            active={location.pathname.startsWith('/engagement')}
            collapsed={navCollapsed}
            onClick={() => go('/engagement')}
            tourId="Engagement"
          />
          <ShellNavLink
            label="Workspace"
            icon={<FolderOpenOutlined />}
            active={location.pathname.startsWith('/workspace')}
            collapsed={navCollapsed}
            onClick={() => go('/workspace')}
            tourId="Workspace"
          />
          <ShellNavLink
            label="Knowledge & Memory"
            icon={<DeploymentUnitOutlined />}
            active={location.pathname.startsWith('/settings/memory')}
            collapsed={navCollapsed}
            onClick={() => go('/settings/memory')}
          />
        </nav>

        <div className="qa-sidebar-footer">
          {moreItems.length ? (
            <ShellNavMenu
              id="more"
              label="More"
              icon={<MoreOutlined />}
              active={moreActive}
              collapsed={navCollapsed}
              open={openMenu === 'more'}
              onToggle={() => {
                setSearchOpen(false);
                setOpenMenu(openMenu === 'more' ? null : 'more');
              }}
              items={moreItems}
              activePath={location.pathname}
              onPick={go}
            />
          ) : null}
          <ShellNavLink
            label="Settings"
            icon={<SettingOutlined />}
            active={settingsActive}
            collapsed={navCollapsed}
            onClick={() => go('/settings')}
          />
          <button
            type="button"
            className="qa-collapse"
            onClick={toggleNav}
            aria-label={navCollapsed ? 'Expand navigation' : 'Collapse navigation'}
            title={navCollapsed ? 'Expand navigation' : 'Collapse navigation'}
          >
            {navCollapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
          </button>
        </div>
      </aside>

      {showContextBar ? (
        <div className="qa-contextbar">
          <div className="qa-profile-wrap">
            <button
              type="button"
              className="qa-context-client"
              onClick={() => setOpenMenu(openMenu === 'client' ? null : 'client')}
              aria-label={`Client scope: ${selectedClient?.name ?? 'All clients'}`}
            >
              <span className="qa-context-k">CLIENT</span>
              <span className="qa-context-v">{selectedClient?.name ?? 'All clients'}</span>
              <CaretIcon />
            </button>
            {openMenu === 'client' ? (
              <div className="qa-pop qa-client-pop" role="listbox">
                <button
                  type="button"
                  className={`qa-pop-row${!selectedClient ? ' is-current' : ''}`}
                  onClick={() => {
                    setSelectedClientId(null);
                    closeAll();
                  }}
                >
                  <span className="qa-pop-label">All clients</span>
                  {!selectedClient ? <span className="qa-pop-check">✓</span> : null}
                </button>
                {visibleClients.map((client) => (
                  <button
                    key={client.id}
                    type="button"
                    role="option"
                    aria-selected={selectedClientId === client.id}
                    className={`qa-pop-row${selectedClientId === client.id ? ' is-current' : ''}`}
                    onClick={() => {
                      setSelectedClientId(client.id);
                      closeAll();
                    }}
                  >
                    <span className="qa-pop-label">{client.name}</span>
                    {selectedClientId === client.id ? <span className="qa-pop-check">✓</span> : null}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <ContextChip label="JURISDICTION" value="Federal" />
          <ContextChip label="BUDGET YEAR" value={requestFy ? `FY${requestFy}` : '—'} />
          <span className="qa-context-spacer" />
          <span className="qa-context-refreshed">
            {section === 'dashboard' ? refreshedLabel : 'LIVE CONTEXT'}
          </span>
        </div>
      ) : null}

      {openMenu || searchOpen ? <div className="qa-scrim" onClick={closeAll} aria-hidden /> : null}
    </div>
  );
}

function ShellNavLink({
  label,
  icon,
  active,
  collapsed,
  onClick,
  tourId,
}: {
  label: string;
  icon: ReactNode;
  active: boolean;
  collapsed: boolean;
  onClick: () => void;
  tourId?: string;
}) {
  return (
    <div className="qa-nav-wrap">
      <button
        type="button"
        className={`qa-nav-item${active ? ' is-active' : ''}`}
        onClick={onClick}
        aria-current={active ? 'page' : undefined}
        aria-label={collapsed ? label : undefined}
        title={collapsed ? label : undefined}
      >
        <span className="qa-nav-icon" aria-hidden>{icon}</span>
        <span className="qa-nav-label" data-tour={tourId}>{label}</span>
      </button>
    </div>
  );
}

function ShellNavMenu({
  id,
  label,
  icon,
  active,
  collapsed,
  open,
  onToggle,
  items,
  activePath,
  onPick,
  tourId,
}: {
  id: string;
  label: string;
  icon: ReactNode;
  active: boolean;
  collapsed: boolean;
  open: boolean;
  onToggle: () => void;
  items: V2NavLeaf[];
  activePath: string;
  onPick: (path?: string) => void;
  tourId?: string;
}) {
  if (!items.length) return null;
  return (
    <div className="qa-nav-wrap">
      <button
        type="button"
        className={`qa-nav-item${active ? ' is-active' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={collapsed ? label : undefined}
        title={collapsed ? label : undefined}
        onClick={onToggle}
      >
        <span className="qa-nav-icon" aria-hidden>{icon}</span>
        <span className="qa-nav-label" data-tour={tourId}>{label}</span>
        <span className="qa-nav-caret" aria-hidden><CaretIcon /></span>
      </button>
      {open ? (
        <div className="qa-pop qa-nav-pop" role="menu" aria-label={`${label} navigation`}>
          {items.map((item) => (
            <button
              key={`${id}-${item.key}`}
              type="button"
              role="menuitem"
              className={`qa-pop-row${item.path && activePath.startsWith(item.path) ? ' is-current' : ''}`}
              onClick={() => onPick(item.path)}
            >
              <span className="qa-pop-label">{item.label}</span>
              {item.tag ? <span className="qa-pop-tag">{item.tag}</span> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ContextChip({ label, value }: { label: string; value: string }) {
  return (
    <span className="qa-context-chip">
      <span className="qa-context-k">{label}</span>
      <span className="qa-context-v">{value}</span>
    </span>
  );
}

export function sectionFor(pathname: string): V2Section {
  if (pathname === '/') return 'dashboard';
  if (pathname.startsWith('/engagement')) return 'engagement';
  if (pathname.startsWith('/clients')) return 'portfolio';
  if (pathname.startsWith('/workspace')) return 'workspace';
  if (pathname.startsWith('/directory')) return 'directory';
  if (
    pathname.startsWith('/legiwatch') ||
    pathname.startsWith('/radar') ||
    pathname.startsWith('/explorer') ||
    pathname.startsWith('/intelligence') ||
    pathname.startsWith('/program-elements')
  ) {
    return 'intelligence';
  }
  return 'more';
}

function isIntelligenceActive(pathname: string): boolean {
  return (
    sectionFor(pathname) === 'intelligence' &&
    !pathname.startsWith('/program-elements') &&
    !pathname.startsWith('/intelligence/opportunities')
  );
}

function initials(value: string): string {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'C';
  if (parts.length === 1) return parts[0]?.slice(0, 2).toUpperCase() || 'C';
  return `${parts[0]?.[0] ?? ''}${parts[1]?.[0] ?? ''}`.toUpperCase() || 'C';
}

function formatRefreshTime(timestamp: number): string {
  return new Date(timestamp)
    .toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    .toUpperCase();
}

function SearchIcon({ muted }: { muted?: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke={muted ? '#8792a3' : 'currentColor'}
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}

function BellIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
    </svg>
  );
}

function CaretIcon() {
  return (
    <svg
      width="9"
      height="9"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}
