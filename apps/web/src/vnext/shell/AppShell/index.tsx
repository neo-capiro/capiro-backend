import { useMemo, useState, type ReactNode } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import {
  ApartmentOutlined,
  CalendarOutlined,
  DashboardOutlined,
  FolderOpenOutlined,
  IdcardOutlined,
  RadarChartOutlined,
  SettingOutlined,
  StarOutlined,
} from '@ant-design/icons';
import { WorkspaceNotificationBell } from '../../../components/WorkspaceNotificationBell.js';
import { useIntelFeatureFlags } from '../../../lib/intel-feature-flags.js';
import { useMe } from '../../../lib/me.js';
import { CapiroTopBar, CapiroBrand } from '../TopBar/index.js';
import { GlobalSearch } from '../GlobalSearch/index.js';
import { MeriLauncher } from '../MeriLauncher/index.js';
import { MailboxSyncStatus } from '../MailboxSyncStatus/index.js';
import { CapiroSidebar, type CapiroNavItemModel } from '../Sidebar/index.js';

const INTELLIGENCE_PATHS = [
  '/explorer',
  '/legiwatch',
  '/program-elements',
  '/intelligence/opportunities',
  '/intelligence/district-nexus',
] as const;

/**
 * The production vNext shell for os.capiro.ai. It is derived from the canonical
 * App Shell Figma frames (722:2502 expanded, 723:2530 collapsed) and keeps the
 * shared route tree/business logic below it. No duplicate app routes live here.
 */
export function VNextShellScaffold({ children }: { children: ReactNode }) {
  const me = useMe();
  const intelFlags = useIntelFeatureFlags();
  const navigate = useNavigate();
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(false);

  const displayName =
    [me.data?.user.firstName, me.data?.user.lastName].filter(Boolean).join(' ') ||
    me.data?.user.email ||
    'Account';
  const displayTitle = me.data?.user.title || 'Government affairs';
  const initials = displayName
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0] ?? '')
    .join('')
    .toUpperCase() || 'C';

  const navItems = useMemo<CapiroNavItemModel[]>(() => {
    const rows: CapiroNavItemModel[] = [
      { id: 'dashboard', label: 'Dashboard', path: '/', icon: <DashboardOutlined /> },
      { id: 'portfolio', label: 'Portfolio', path: '/clients', icon: <ApartmentOutlined /> },
      {
        id: 'engagement',
        label: 'Engagement Manager',
        path: '/engagement',
        icon: <CalendarOutlined />,
      },
      { id: 'workspace', label: 'Workspace', path: '/workspace', icon: <FolderOpenOutlined /> },
    ];
    if (me.data?.features.strategyPlanner) {
      rows.push({ id: 'strategies', label: 'Strategies', path: '/strategies', icon: <StarOutlined /> });
    }
    rows.push(
      { id: 'directory', label: 'Directory', path: '/directory', icon: <IdcardOutlined /> },
      {
        id: 'intelligence',
        label: 'Intelligence',
        path: '/explorer',
        icon: <RadarChartOutlined />,
        activePrefixes: INTELLIGENCE_PATHS,
      },
    );
    return rows;
  }, [me.data?.features.strategyPlanner]);

  const intelligenceCurrent = INTELLIGENCE_PATHS.some(
    (prefix) => location.pathname === prefix || location.pathname.startsWith(`${prefix}/`),
  );

  return (
    <div className={`capiro-vnext-shell${collapsed ? ' capiro-vnext-shell--collapsed' : ''}`}>
      <CapiroTopBar
        brand={
          <Link className="capiro-vnext-brand-link" to="/" aria-label="Capiro home">
            <CapiroBrand />
          </Link>
        }
        search={<GlobalSearch />}
        actions={
          <>
            <MeriLauncher />
            <span className="capiro-vnext-notifications"><WorkspaceNotificationBell /></span>
            <button
              type="button"
              className="capiro-vnext-profile"
              onClick={() => navigate('/settings/personal')}
              aria-label={`Open profile for ${displayName}`}
            >
              <span className="capiro-vnext-profile__avatar">{initials}</span>
              <span className="capiro-vnext-profile__copy">
                <span className="capiro-vnext-profile__name">{displayName}</span>
                <span className="capiro-vnext-profile__title">{displayTitle}</span>
              </span>
            </button>
          </>
        }
      />

      <CapiroSidebar
        items={navItems}
        collapsed={collapsed}
        footer={
          <>
            <MailboxSyncStatus />
            <NavLink className="capiro-vnext-nav-item" to="/settings">
              <span className="capiro-vnext-nav-item__icon" aria-hidden="true"><SettingOutlined /></span>
              <span className="capiro-vnext-nav-item__label">Settings</span>
            </NavLink>
            <button
              type="button"
              className="capiro-vnext-collapse-control"
              aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
              onClick={() => setCollapsed((value) => !value)}
            >
              <span aria-hidden="true">{collapsed ? '›' : '‹'}</span>
              <span>{collapsed ? 'Expand' : 'Collapse navigation'}</span>
            </button>
          </>
        }
      />

      <main className="capiro-vnext-content">
        {intelligenceCurrent ? (
          <IntelligenceContextBar
            showFunding={Boolean(intelFlags.data?.funding_opportunities)}
            showDistrict={Boolean(intelFlags.data?.district_nexus_v2)}
          />
        ) : null}
        {children}
      </main>
    </div>
  );
}

function IntelligenceContextBar({
  showFunding,
  showDistrict,
}: {
  showFunding: boolean;
  showDistrict: boolean;
}) {
  const links = [
    { label: 'Data Explorer', to: '/explorer' },
    { label: 'LegiWatch', to: '/legiwatch' },
    { label: 'Program Elements', to: '/program-elements' },
    ...(showFunding ? [{ label: 'Funding Opportunities', to: '/intelligence/opportunities' }] : []),
    ...(showDistrict ? [{ label: 'District Nexus', to: '/intelligence/district-nexus' }] : []),
  ];
  return (
    <nav className="capiro-vnext-contextbar" aria-label="Intelligence navigation">
      <span className="capiro-vnext-contextbar__label">Intelligence</span>
      {links.map((link) => (
        <NavLink key={link.to} to={link.to} className="capiro-vnext-contextbar__item">
          {link.label}
        </NavLink>
      ))}
    </nav>
  );
}
