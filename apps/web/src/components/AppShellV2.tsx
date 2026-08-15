// Global app shell v2 — a faithful build of "Capiro App Shell v2 (standalone).html"
// gated to the capiro-internal tenant only. Two persistent bands (54px global nav
// + 40px tenant/client/data context) replace the legacy left sider. The page
// region below scrolls. All controls wire to real app behaviour; decorative
// mockup-only affordances are omitted, never faked.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useClerk, useUser } from '@clerk/clerk-react';
import { useQuery } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import type { MeResponse } from '../lib/me.js';
import { useApi } from '../lib/use-api.js';
import { useIntelFeatureFlags } from '../lib/intel-feature-flags.js';
import { ROLE_RANK, type TenantRole } from '@capiro/shared';
import { openMeriWorkspaceWindow } from './chat/meri-window.js';
import { useClientFilter } from '../state/client-filter.js';
import { useNotifications } from '../pages/workspace/api.js';
import { getProgramElementSummary } from '../pages/program-element/api.js';
import type { Client } from '../pages/clients/clientTypes.js';

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
  children?: V2NavLeaf[];
  tourId?: string;
}

interface BrandingResponse {
  name: string;
  logoUrl?: string | null;
}

/* ── Nav model (mirrors the production NAV sections, mockup ordering) ──── */

const PRIMARY: V2NavLeaf[] = [
  { key: 'dashboard', label: 'Dashboard', path: '/', tourId: 'Dashboard' },
  { key: 'engagement', label: 'Engagement', path: '/engagement', tourId: 'Engagement' },
  { key: 'portfolio', label: 'Portfolio', path: '/clients', tourId: 'Portfolio' },
  { key: 'workspace', label: 'Workspace', path: '/workspace', tourId: 'Workspace' },
];

const INTELLIGENCE: V2NavLeaf[] = [
  { key: 'radar', label: 'LegiWatch', path: '/legiwatch' },
  { key: 'intelligence', label: 'Data Explorer', path: '/explorer' },
  {
    key: 'federal-spending',
    label: 'Federal Spending',
    path: '/intelligence/federal-spending',
  },
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
    tag: 'FLAG',
    featureFlag: 'funding_opportunities',
  },
  { key: 'knowledge-graph', label: 'Knowledge Graph', path: '/intelligence/graph' },
  { key: 'program-elements', label: 'Program Elements', path: '/program-elements' },
];

const MORE: V2NavLeaf[] = [
  {
    key: 'strategies',
    label: 'Strategies',
    path: '/strategies',
    tag: 'FLAG',
    meFeature: 'strategyPlanner',
  },
  { key: 'actions', label: 'Action Board', path: '/actions' },
  { key: 'portal', label: 'Client Portal', path: '/portal' },
  { key: 'analyst-console', label: 'Analyst Console', path: '/admin/analyst-console', tag: 'ADMIN', minRole: 'capiro_admin' as TenantRole },
];

const PROFILE_ITEMS: { label: string; tag?: string; path?: string; action?: 'signout' | 'profile' }[] = [
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
  const rootRef = useRef<HTMLDivElement | null>(null);

  const role = me.role;
  const closeAll = () => {
    setOpenMenu(null);
    setSearchOpen(false);
  };

  // Ctrl+J opens/focuses the Meri window; Ctrl+K opens search; Esc closes menus.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = (e.key || '').toLowerCase();
      if ((e.metaKey || e.ctrlKey) && k === 'j') {
        e.preventDefault();
        openMeriWorkspaceWindow();
      }
      if ((e.metaKey || e.ctrlKey) && k === 'k') {
        e.preventDefault();
        setOpenMenu(null);
        setSearchOpen(true);
      }
      if (k === 'escape') closeAll();
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
        .filter((c) => c.status !== 'archived')
        .sort((a, b) => a.name.localeCompare(b.name)),
    [clients.data],
  );
  const selectedClient = visibleClients.find((c) => c.id === selectedClientId) ?? null;

  const branding = useQuery<BrandingResponse | null>({
    queryKey: ['branding'],
    queryFn: async () => (await api.get<BrandingResponse | null>('/api/tenant-admin/branding')).data,
    staleTime: 240_000,
  });

  const peSummary = useQuery({
    queryKey: ['program-element-summary'],
    queryFn: () => getProgramElementSummary(api),
    staleTime: 300_000,
  });

  const unread = notifications.data?.unread ?? 0;
  const tenantName = branding.data?.name ?? me.tenant.name;
  const displayName =
    user?.fullName ||
    [me.user.firstName, me.user.lastName].filter(Boolean).join(' ') ||
    me.user.email ||
    'Account';
  const displayTitle = me.user.title ?? null;
  const requestFy = peSummary.data?.latestRequestFy ?? null;

  const isVisible = (n: V2NavLeaf) =>
    (!n.minRole || (role != null && ROLE_RANK[role] >= ROLE_RANK[n.minRole])) &&
    (!n.featureFlag || Boolean(intelFlags.data?.[n.featureFlag])) &&
    (!n.meFeature || Boolean(me.features?.[n.meFeature]));

  const section = sectionFor(location.pathname);

  // The all-client Dashboard must never carry an invisible client scope. Clear
  // any persisted selection on entry so a hidden filter can't affect the data.
  useEffect(() => {
    if (section === 'dashboard' && selectedClientId) {
      setSelectedClientId(null);
    }
  }, [section, selectedClientId, setSelectedClientId]);

  const go = (path?: string) => {
    closeAll();
    if (path) navigate(path);
  };

  const initialsText = initials(displayName);
  // The profile chip shows the user's real photo when one is available (Clerk
  // avatar), falling back to initials — same source as the legacy shell.
  const profileImageUrl = user?.imageUrl || null;
  const clientMark = selectedClient
    ? initials(selectedClient.name)
    : 'AC';

  const searchResults = useMemo(() => {
    const query = q.trim().toLowerCase();
    const pool: { kind: string; title: string; href: string }[] = visibleClients.map((c) => ({
      kind: 'CLIENT',
      title: c.name,
      href: `/clients/${c.id}`,
    }));
    if (!query) return pool.slice(0, 6);
    return pool.filter((r) => r.title.toLowerCase().includes(query)).slice(0, 8);
  }, [q, visibleClients]);

  return (
    <div className="v2-shell" ref={rootRef}>
      {/* ── Band 1 · global product navigation (54px) ─────────────────── */}
      <header className="v2-band1">
        <div className="v2-band1-left">
          <Link to="/" className="v2-brand" aria-label="Capiro home" onClick={closeAll}>
            <img src="/logo.png" alt="Capiro" className="v2-brand-logo" />
          </Link>

          <nav className="v2-nav" aria-label="Primary">
            {PRIMARY.map((n) => (
              <button
                key={n.key}
                type="button"
                className={`v2-nav-item${section === n.key ? ' is-active' : ''}`}
                onClick={() => go(n.path)}
              >
                <span data-tour={n.tourId}>{n.label}</span>
                {n.key === 'portfolio' && visibleClients.length > 0 ? (
                  <span className="v2-nav-count">{visibleClients.length}</span>
                ) : null}
              </button>
            ))}

            <NavMenu
              id="intel"
              label="Intelligence"
              active={section === 'intelligence'}
              open={openMenu === 'intel'}
              onToggle={() => setOpenMenu(openMenu === 'intel' ? null : 'intel')}
              items={INTELLIGENCE.filter(isVisible)}
              onPick={go}
              activePath={location.pathname}
            />
            <NavMenu
              id="more"
              label="More"
              active={false}
              open={openMenu === 'more'}
              onToggle={() => setOpenMenu(openMenu === 'more' ? null : 'more')}
              items={MORE.filter(isVisible)}
              onPick={go}
              activePath={location.pathname}
            />
          </nav>
        </div>

        <div className="v2-band1-right">
          {/* Global search */}
          <div className="v2-search-wrap">
            <button
              type="button"
              className={`v2-search${searchOpen ? ' is-open' : ''}`}
              onClick={() => {
                setOpenMenu(null);
                setSearchOpen((v) => !v);
              }}
              aria-label="Global search"
            >
              <SearchIcon />
              <span className="v2-search-text">Search bills, agencies, stakeholders</span>
            </button>
            {searchOpen ? (
              <div className="v2-pop v2-search-pop" role="dialog" aria-label="Search">
                <div className="v2-search-pop-head">
                  <SearchIcon muted />
                  <input
                    autoFocus
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    placeholder="Search bills, agencies, stakeholders"
                    aria-label="Global search"
                    className="v2-search-input"
                  />
                </div>
                {searchResults.map((r) => (
                  <button
                    key={r.href + r.title}
                    type="button"
                    className="v2-search-row"
                    onClick={() => go(r.href)}
                  >
                    <span className="v2-search-kind">{r.kind}</span>
                    <span className="v2-search-title">{r.title}</span>
                  </button>
                ))}
                <div className="v2-search-foot">
                  SCOPED TO {(selectedClient?.name ?? 'All clients').toUpperCase()} · ENTER TO OPEN
                </div>
              </div>
            ) : null}
          </div>

          {/* Notifications */}
          <button
            type="button"
            className="v2-icon-btn"
            aria-label="Notifications"
            onClick={() => navigate('/?notifications=1')}
          >
            <BellIcon />
            {unread > 0 ? <span className="v2-bell-count">{unread}</span> : null}
          </button>

          {/* Meri launcher — opens/focuses the separate Meri window */}
          <button
            type="button"
            className="v2-meri"
            title="Open Meri in its own window — Ctrl+J"
            aria-label="Open the Meri window"
            onClick={() => openMeriWorkspaceWindow()}
            data-tour="Meri"
          >
            <span className="v2-meri-glyph" aria-hidden />
            <span className="v2-meri-label">MERI</span>
            <ExtIcon />
          </button>

          {/* Profile */}
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
              <span className="v2-profile-name">{displayName}</span>
              <CaretIcon />
            </button>
            {openMenu === 'profile' ? (
              <div className="v2-pop v2-profile-pop" role="menu">
                <div className="v2-profile-head">
                  <div className="v2-profile-head-name">{displayName}</div>
                  {displayTitle ? <div className="v2-profile-head-title">{displayTitle}</div> : null}
                </div>
                {PROFILE_ITEMS.map((p) => (
                  <button
                    key={p.label}
                    type="button"
                    role="menuitem"
                    className={`v2-menu-row${p.action === 'signout' ? ' is-signout' : ''}`}
                    onClick={() => {
                      closeAll();
                      if (p.action === 'signout') void signOut({ redirectUrl: '/sign-in' });
                      else if (p.action === 'profile') openUserProfile();
                      else if (p.path) navigate(p.path);
                      else message.info('Keyboard shortcuts: Ctrl+J Meri · Ctrl+K search · Esc close');
                    }}
                  >
                    <span className="v2-menu-label">{p.label}</span>
                    {p.tag ? <span className="v2-menu-tag">{p.tag}</span> : null}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      </header>

      {/* ── Band 2 · tenant · client · data context (40px) ────────────── */}
      <div className="v2-band2">
        <span className="v2-band2-eyebrow">TENANT</span>
        <span className="v2-band2-tenant">{tenantName}</span>

        {/* Dashboard is an all-client command view: no client scope control,
            and no separator introducing one. Other sections keep it. */}
        {section !== 'dashboard' ? (
          <>
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
                  {visibleClients.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      role="option"
                      aria-selected={selectedClientId === c.id}
                      className={`v2-menu-row${selectedClientId === c.id ? ' is-current' : ''}`}
                      onClick={() => {
                        setSelectedClientId(c.id);
                        closeAll();
                      }}
                    >
                      <span className="v2-menu-label">{c.name}</span>
                      {selectedClientId === c.id ? <span className="v2-menu-check">✓</span> : null}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          </>
        ) : null}

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
              <DataRow
                k="WATCHED"
                v={peSummary.data ? String(peSummary.data.watched) : '—'}
              />
              <button type="button" className="v2-data-link" onClick={() => go('/program-elements')}>
                Open Program Elements →
              </button>
            </div>
          ) : null}
        </div>
      </div>

      {/* Click-catcher to close any open menu */}
      {openMenu || searchOpen ? <div className="v2-scrim" onClick={closeAll} aria-hidden /> : null}
    </div>
  );
}

/* ── Sub-components ────────────────────────────────────────────────────── */

function NavMenu({
  id,
  label,
  active,
  open,
  onToggle,
  items,
  onPick,
  activePath,
}: {
  id: string;
  label: string;
  active: boolean;
  open: boolean;
  onToggle: () => void;
  items: V2NavLeaf[];
  onPick: (path?: string) => void;
  activePath: string;
}) {
  if (!items.length && id === 'intel') return null;
  return (
    <div className="v2-nav-menu-wrap">
      <button
        type="button"
        className={`v2-nav-item${active ? ' is-active' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={onToggle}
      >
        <span>{label}</span>
        <CaretIcon />
      </button>
      {open ? (
        <div className="v2-pop v2-nav-pop" role="menu">
          {items.map((it) => (
            <button
              key={it.key}
              type="button"
              role="menuitem"
              className={`v2-menu-row${it.path && activePath.startsWith(it.path) ? ' is-current' : ''}`}
              onClick={() => onPick(it.path)}
            >
              <span className="v2-menu-label">{it.label}</span>
              {it.tag ? <span className="v2-menu-tag">{it.tag}</span> : null}
            </button>
          ))}
          {items.length === 0 ? (
            <div className="v2-menu-empty">No items available for your role.</div>
          ) : null}
        </div>
      ) : null}
    </div>
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

/* ── Route → section mapping ───────────────────────────────────────────── */

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
  )
    return 'intelligence';
  return 'more';
}

function initials(value: string): string {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'C';
  if (parts.length === 1) return parts[0]?.slice(0, 2).toUpperCase() || 'C';
  return `${parts[0]?.[0] ?? ''}${parts[1]?.[0] ?? ''}`.toUpperCase() || 'C';
}

/* ── Inline icons (mockup strokes) ─────────────────────────────────────── */

function SearchIcon({ muted }: { muted?: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke={muted ? '#8792A3' : 'currentColor'}
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
      width="10"
      height="10"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ opacity: 0.65 }}
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
      style={{ opacity: 0.5 }}
      aria-hidden
    >
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    </svg>
  );
}
