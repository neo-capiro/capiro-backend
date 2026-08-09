// Premium global app shell for capiro-internal.
//
// The visual source of truth is the Capiro Figma master Shell/Premium. This
// component intentionally stays tenant-gated by AppShell.tsx so legacy tenants
// retain the existing sidebar shell. Real navigation, search, notifications,
// Meri-window launch, profile actions, client scope, and data context remain
// wired to production behavior.
import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useClerk, useUser } from '@clerk/clerk-react';
import { useQuery } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
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

/* ── Types ─────────────────────────────────────────────────────────────── */

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
  tourId?: string;
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

/* ── Navigation model ──────────────────────────────────────────────────── */

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
  {
    key: 'funding-opportunities',
    label: 'Funding Opportunities',
    path: '/intelligence/opportunities',
    featureFlag: 'funding_opportunities',
  },
  { key: 'knowledge-graph', label: 'Knowledge Graph', path: '/intelligence/graph' },
  { key: 'program-elements', label: 'Program Elements', path: '/program-elements' },
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

/* ── Component ─────────────────────────────────────────────────────────── */

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

  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [q, setQ] = useState('');

  const role = me.role;
  const section = sectionFor(location.pathname);

  const closeAll = () => {
    setOpenMenu(null);
    setSearchOpen(false);
  };

  // Ctrl+J opens/focuses Meri; Ctrl/Cmd+K opens global search; Esc closes menus.
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
      if (key === 'escape') {
        setOpenMenu(null);
        setSearchOpen(false);
      }
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

  // Reuse the HomePage query key so the shell's SIGNALS chip and dashboard share
  // one cache entry rather than introducing another source of truth.
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
  const clientMark = selectedClient ? initials(selectedClient.name) : 'AC';

  const isVisible = (item: V2NavLeaf) =>
    (!item.minRole || (role != null && ROLE_RANK[role] >= ROLE_RANK[item.minRole])) &&
    (!item.featureFlag || Boolean(intelFlags.data?.[item.featureFlag])) &&
    (!item.meFeature || Boolean(me.features?.[item.meFeature]));

  const intelligenceItems = INTELLIGENCE.filter(isVisible);
  const moreItems = MORE.filter(isVisible);
  const fundingEnabled = intelligenceItems.some((item) => item.key === 'funding-opportunities');

  const go = (path?: string) => {
    closeAll();
    if (path) navigate(path);
  };

  const searchResults = useMemo(() => {
    const query = q.trim().toLowerCase();
    const pool: { kind: string; title: string; href: string }[] = visibleClients.map((client) => ({
      kind: 'CLIENT',
      title: client.name,
      href: `/clients/${client.id}`,
    }));
    if (!query) return pool.slice(0, 6);
    return pool.filter((result) => result.title.toLowerCase().includes(query)).slice(0, 8);
  }, [q, visibleClients]);

  const refreshedLabel = dashboardSignals.dataUpdatedAt
    ? `REFRESHED ${formatRefreshTime(dashboardSignals.dataUpdatedAt)}`
    : dashboardSignals.isLoading
      ? 'REFRESHING…'
      : 'REFRESHED —';

  return (
    <div className={`v2-shell premium-shell${section === 'dashboard' ? ' is-dashboard' : ''}`}>
      {/* ── Band 1 · premium global navigation ─────────────────────────── */}
      <header className="v2-band1">
        <div className="v2-band1-left">
          <button type="button" className="v2-brand" aria-label="Capiro home" onClick={() => go('/')}>
            <span className="v2-brand-wordmark">CAPIRO</span>
            <span className="v2-brand-environment">INTERNAL</span>
          </button>

          <nav className="v2-nav" aria-label="Primary navigation">
            <TopNavButton
              label="Home"
              active={location.pathname === '/'}
              onClick={() => go('/')}
              tourId="Dashboard"
            />
            <TopNavButton
              label="Clients"
              active={location.pathname.startsWith('/clients')}
              onClick={() => go('/clients')}
              tourId="Portfolio"
            />
            <NavMenu
              id="intel"
              label="Intelligence"
              active={isIntelligenceActive(location.pathname)}
              open={openMenu === 'intel'}
              onToggle={() => setOpenMenu(openMenu === 'intel' ? null : 'intel')}
              items={intelligenceItems}
              onPick={go}
              activePath={location.pathname}
            />
            <TopNavButton
              label="Program Elements"
              active={location.pathname.startsWith('/program-elements')}
              onClick={() => go('/program-elements')}
            />
            {fundingEnabled ? (
              <TopNavButton
                label="Funding"
                active={location.pathname.startsWith('/intelligence/opportunities')}
                onClick={() => go('/intelligence/opportunities')}
              />
            ) : null}
            <TopNavButton
              label="Engagement"
              active={location.pathname.startsWith('/engagement')}
              onClick={() => go('/engagement')}
              tourId="Engagement"
            />
            <TopNavButton
              label="Workspace"
              active={location.pathname.startsWith('/workspace')}
              onClick={() => go('/workspace')}
              tourId="Workspace"
            />
            <NavMenu
              id="more"
              label="More"
              active={section === 'directory' || section === 'more'}
              open={openMenu === 'more'}
              onToggle={() => setOpenMenu(openMenu === 'more' ? null : 'more')}
              items={moreItems}
              onPick={go}
              activePath={location.pathname}
              quiet
            />
          </nav>
        </div>

        <div className="v2-band1-right">
          <div className="v2-search-wrap">
            <span className="v2-search-label">GLOBAL SEARCH</span>
            <button
              type="button"
              className={`v2-search${searchOpen ? ' is-open' : ''}`}
              onClick={() => {
                setOpenMenu(null);
                setSearchOpen((value) => !value);
              }}
              aria-label="Global search"
            >
              <SearchIcon />
              <span className="v2-search-text">Search clients, issues, programs, people…</span>
              <span className="v2-search-shortcut">⌘K</span>
            </button>
            {searchOpen ? (
              <div className="v2-pop v2-search-pop" role="dialog" aria-label="Search">
                <div className="v2-search-pop-head">
                  <SearchIcon muted />
                  <input
                    autoFocus
                    value={q}
                    onChange={(event) => setQ(event.target.value)}
                    placeholder="Search clients, issues, programs, people…"
                    aria-label="Global search"
                    className="v2-search-input"
                  />
                </div>
                {searchResults.map((result) => (
                  <button
                    key={result.href + result.title}
                    type="button"
                    className="v2-search-row"
                    onClick={() => go(result.href)}
                  >
                    <span className="v2-search-kind">{result.kind}</span>
                    <span className="v2-search-title">{result.title}</span>
                  </button>
                ))}
                {searchResults.length === 0 ? (
                  <div className="v2-menu-empty">No matching clients found.</div>
                ) : null}
                <div className="v2-search-foot">
                  {section === 'dashboard'
                    ? 'ALL-CLIENT SEARCH · ENTER TO OPEN'
                    : `SCOPED TO ${(selectedClient?.name ?? 'All clients').toUpperCase()} · ENTER TO OPEN`}
                </div>
              </div>
            ) : null}
          </div>

          <button
            type="button"
            className="v2-meri"
            title="Open Meri in its own window — Ctrl+J"
            aria-label="Open the Meri window"
            onClick={() => openMeriWorkspaceWindow()}
            data-tour="Meri"
          >
            <span className="v2-meri-signature" aria-hidden />
            <span className="v2-meri-label">Open Meri</span>
            <ExtIcon />
          </button>

          <button
            type="button"
            className="v2-icon-btn"
            aria-label="Notifications"
            onClick={() => navigate('/?notifications=1')}
          >
            <BellIcon />
            {unread > 0 ? <span className="v2-bell-count">{unread > 99 ? '99+' : unread}</span> : null}
          </button>

          <div className="v2-profile-wrap">
            <button
              type="button"
              className="v2-profile"
              onClick={() => setOpenMenu(openMenu === 'profile' ? null : 'profile')}
              aria-label={`Open account menu for ${displayName}`}
            >
              <span className="v2-profile-avatar" aria-hidden>
                {profileImageUrl ? (
                  <img src={profileImageUrl} alt="" className="v2-profile-avatar-img" />
                ) : (
                  initialsText
                )}
              </span>
              <span className="v2-profile-copy">
                <span className="v2-profile-name">{profileName}</span>
                {displayTitle ? <span className="v2-profile-title">{displayTitle}</span> : null}
              </span>
            </button>
            {openMenu === 'profile' ? (
              <div className="v2-pop v2-profile-pop" role="menu">
                <div className="v2-profile-head">
                  <div className="v2-profile-head-name">{displayName}</div>
                  {displayTitle ? <div className="v2-profile-head-title">{displayTitle}</div> : null}
                </div>
                {PROFILE_ITEMS.map((item) => (
                  <button
                    key={item.label}
                    type="button"
                    role="menuitem"
                    className={`v2-menu-row${item.action === 'signout' ? ' is-signout' : ''}`}
                    onClick={() => {
                      closeAll();
                      if (item.action === 'signout') void signOut({ redirectUrl: '/sign-in' });
                      else if (item.action === 'profile') openUserProfile();
                      else if (item.path) navigate(item.path);
                      else message.info('Keyboard shortcuts: Ctrl+J Meri · Ctrl+K search · Esc close');
                    }}
                  >
                    <span className="v2-menu-label">{item.label}</span>
                    {item.tag ? <span className="v2-menu-tag">{item.tag}</span> : null}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </div>
        <span className="v2-signature-rail" aria-hidden />
      </header>

      {/* ── Band 2 · contextual operating rail ─────────────────────────── */}
      <div className="v2-band2">
        {section === 'dashboard' ? (
          <>
            <ContextChip label="JURISDICTION" value="Federal" />
            <ContextChip label="BUDGET YEAR" value={requestFy ? `FY${requestFy}` : '—'} />
            <ContextChip
              label="SIGNALS"
              value={
                dashboardSignals.isError
                  ? 'Unavailable'
                  : dashboardSignals.isLoading
                    ? 'Checking…'
                    : `${overnightSignals} overnight`
              }
            />
            <span className="v2-band2-flex" />
            <span className="v2-dashboard-refreshed">{refreshedLabel}</span>
            <span className="v2-dashboard-customize-space" aria-hidden />
          </>
        ) : (
          <>
            <span className="v2-band2-eyebrow">TENANT</span>
            <span className="v2-band2-tenant">{me.tenant.name}</span>
            <span className="v2-band2-sep" aria-hidden />
            <span className="v2-band2-eyebrow">CLIENT</span>

            <div className="v2-client-wrap">
              <button
                type="button"
                className="v2-client"
                aria-haspopup="listbox"
                onClick={() => setOpenMenu(openMenu === 'client' ? null : 'client')}
              >
                <span className="v2-client-mark">{clientMark}</span>
                <span className="v2-client-name">{selectedClient?.name ?? 'All clients'}</span>
                <CaretIcon />
              </button>
              {openMenu === 'client' ? (
                <div className="v2-pop v2-client-pop" role="listbox">
                  <button
                    type="button"
                    className={`v2-menu-row${!selectedClient ? ' is-current' : ''}`}
                    onClick={() => {
                      setSelectedClientId(null);
                      closeAll();
                    }}
                  >
                    <span className="v2-menu-label">All clients</span>
                    {!selectedClient ? <span className="v2-menu-check">✓</span> : null}
                  </button>
                  {visibleClients.map((client) => (
                    <button
                      key={client.id}
                      type="button"
                      role="option"
                      aria-selected={selectedClientId === client.id}
                      className={`v2-menu-row${selectedClientId === client.id ? ' is-current' : ''}`}
                      onClick={() => {
                        setSelectedClientId(client.id);
                        closeAll();
                      }}
                    >
                      <span className="v2-menu-label">{client.name}</span>
                      {selectedClientId === client.id ? <span className="v2-menu-check">✓</span> : null}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>

            <span className="v2-band2-flex" />
            <div className="v2-data-wrap">
              <button
                type="button"
                className={`v2-data${openMenu === 'data' ? ' is-open' : ''}`}
                onClick={() => setOpenMenu(openMenu === 'data' ? null : 'data')}
              >
                {requestFy ? `FY${requestFy} · ACTIVE` : 'DATA CONTEXT'}
              </button>
              {openMenu === 'data' ? (
                <div className="v2-pop v2-data-pop" role="dialog" aria-label="Active data context">
                  <div className="v2-data-head">ACTIVE DATA CONTEXT</div>
                  <DataRow k="FISCAL YEAR" v={requestFy ? `FY${requestFy}` : '—'} strong />
                  <DataRow
                    k="TRACKED PES"
                    v={peSummary.data ? String(peSummary.data.tracked) : '—'}
                    strong
                  />
                  <DataRow k="WATCHED" v={peSummary.data ? String(peSummary.data.watched) : '—'} />
                  <button type="button" className="v2-data-link" onClick={() => go('/program-elements')}>
                    Open Program Elements →
                  </button>
                </div>
              ) : null}
            </div>
          </>
        )}
      </div>

      {openMenu || searchOpen ? <div className="v2-scrim" onClick={closeAll} aria-hidden /> : null}
    </div>
  );
}

/* ── Sub-components ────────────────────────────────────────────────────── */

function TopNavButton({
  label,
  active,
  onClick,
  tourId,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  tourId?: string;
}) {
  return (
    <button
      type="button"
      className={`v2-nav-item${active ? ' is-active' : ''}`}
      onClick={onClick}
    >
      <span data-tour={tourId}>{label}</span>
    </button>
  );
}

function NavMenu({
  id,
  label,
  active,
  open,
  onToggle,
  items,
  onPick,
  activePath,
  quiet = false,
}: {
  id: string;
  label: string;
  active: boolean;
  open: boolean;
  onToggle: () => void;
  items: V2NavLeaf[];
  onPick: (path?: string) => void;
  activePath: string;
  quiet?: boolean;
}) {
  if (!items.length) return null;
  return (
    <div className="v2-nav-menu-wrap">
      <button
        type="button"
        className={`v2-nav-item${active ? ' is-active' : ''}${quiet ? ' is-quiet' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={onToggle}
      >
        <span>{label}</span>
        <CaretIcon />
      </button>
      {open ? (
        <div className="v2-pop v2-nav-pop" role="menu">
          {items.map((item) => (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              className={`v2-menu-row${item.path && activePath.startsWith(item.path) ? ' is-current' : ''}`}
              onClick={() => onPick(item.path)}
            >
              <span className="v2-menu-label">{item.label}</span>
              {item.tag ? <span className="v2-menu-tag">{item.tag}</span> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ContextChip({ label, value }: { label: string; value: string }) {
  return (
    <span className="v2-context-chip">
      <span className="v2-context-label">{label}</span>
      <span className="v2-context-value">{value}</span>
    </span>
  );
}

function DataRow({ k, v, strong }: { k: string; v: string; strong?: boolean }) {
  return (
    <div className="v2-data-row">
      <span className="v2-data-k">{k}</span>
      <span className={strong ? 'v2-data-v is-strong' : 'v2-data-v'}>{v}</span>
    </div>
  );
}

/* ── Route helpers ─────────────────────────────────────────────────────── */

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

/* ── Inline icons ──────────────────────────────────────────────────────── */

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

function ExtIcon() {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    </svg>
  );
}
