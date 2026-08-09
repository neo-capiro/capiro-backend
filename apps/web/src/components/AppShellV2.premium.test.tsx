import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MeResponse } from '../lib/me.js';
import { AppShellV2, sectionFor } from './AppShellV2.js';

const mocks = vi.hoisted(() => ({
  pathname: '/',
  navigate: vi.fn(),
  setSelectedClientId: vi.fn(),
  openMeriWorkspaceWindow: vi.fn(),
}));

vi.mock('react-router-dom', () => ({
  useLocation: () => ({ pathname: mocks.pathname }),
  useNavigate: () => mocks.navigate,
}));

vi.mock('@clerk/clerk-react', () => ({
  useClerk: () => ({
    signOut: vi.fn(),
    openUserProfile: vi.fn(),
  }),
  useUser: () => ({
    user: {
      fullName: 'Neo Martinez',
      firstName: 'Neo',
      imageUrl: null,
    },
  }),
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: ({ queryKey }: { queryKey: unknown[] }) => {
    switch (queryKey[0]) {
      case 'clients':
        return {
          data: [
            { id: 'client-1', name: 'Overland AI', status: 'active' },
            { id: 'client-2', name: 'Boresight', status: 'active' },
          ],
          isLoading: false,
          isError: false,
          dataUpdatedAt: 0,
        };
      case 'program-element-summary':
        return {
          data: { latestRequestFy: 2027, tracked: 12, watched: 4 },
          isLoading: false,
          isError: false,
          dataUpdatedAt: 0,
        };
      case 'intel-changes-tracked':
        return {
          data: [{ detectedAt: new Date().toISOString() }],
          isLoading: false,
          isError: false,
          dataUpdatedAt: Date.now(),
        };
      default:
        return { data: undefined, isLoading: false, isError: false, dataUpdatedAt: 0 };
    }
  },
}));

vi.mock('antd', () => ({
  App: {
    useApp: () => ({ message: { info: vi.fn() } }),
  },
}));

vi.mock('../lib/use-api.js', () => ({ useApi: () => ({ get: vi.fn() }) }));
vi.mock('../lib/intel-feature-flags.js', () => ({
  useIntelFeatureFlags: () => ({
    data: {
      funding_opportunities: true,
      district_nexus_v2: true,
    },
  }),
}));
vi.mock('../state/client-filter.js', () => ({
  useClientFilter: () => ({
    selectedClientId: 'client-1',
    setSelectedClientId: mocks.setSelectedClientId,
  }),
}));
vi.mock('../pages/workspace/api.js', () => ({
  useNotifications: () => ({ data: { unread: 2 } }),
}));
vi.mock('../pages/program-element/api.js', () => ({
  getProgramElementSummary: vi.fn(),
}));
vi.mock('./chat/meri-window.js', () => ({
  openMeriWorkspaceWindow: () => mocks.openMeriWorkspaceWindow(),
}));

const me = {
  tenant: { id: 'tenant-1', name: 'Capiro Internal', slug: 'capiro-internal' },
  user: {
    firstName: 'Neo',
    lastName: 'Martinez',
    email: 'neo@example.com',
    title: 'CTO',
  },
  role: 'capiro_admin',
  features: { strategyPlanner: true },
} as unknown as MeResponse;

describe('Quiet Authority AppShellV2 contract', () => {
  beforeEach(() => {
    mocks.pathname = '/';
    mocks.navigate.mockReset();
    mocks.setSelectedClientId.mockReset();
    mocks.openMeriWorkspaceWindow.mockReset();
    window.localStorage.clear();
    window.history.replaceState({}, '', '/');
  });

  it('renders the latest left navigation and porcelain top-bar controls', () => {
    render(<AppShellV2 me={me} />);

    expect(screen.getByRole('navigation')).toBeInTheDocument();
    expect(screen.getByText('Home')).toBeInTheDocument();
    expect(screen.getByText('Clients')).toBeInTheDocument();
    expect(screen.getByText('Intelligence')).toBeInTheDocument();
    expect(screen.getByText('Program Elements')).toBeInTheDocument();
    expect(screen.getByText('Funding Opportunities')).toBeInTheDocument();
    expect(screen.getByText('Engagement')).toBeInTheDocument();
    expect(screen.getByText('Workspace')).toBeInTheDocument();
    expect(screen.getByText('Knowledge & Memory')).toBeInTheDocument();
    expect(screen.getByText('Settings')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Global search' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Notifications' })).toBeInTheDocument();
  });

  it('defaults the dashboard to the collapsed rail and allows an explicit expand', () => {
    render(<AppShellV2 me={me} />);

    const toggle = screen.getByRole('button', { name: 'Expand navigation' });
    expect(toggle).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(screen.getByRole('button', { name: 'Collapse navigation' })).toBeInTheDocument();
    expect(window.localStorage.getItem('capiro:quiet-authority-nav-collapsed')).toBe('false');
  });

  it('never renders a client picker on the all-client dashboard and clears hidden scope', async () => {
    render(<AppShellV2 me={me} />);

    expect(screen.queryByText('CLIENT')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Client scope:/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open the Meri window' })).not.toBeInTheDocument();

    await waitFor(() => expect(mocks.setSelectedClientId).toHaveBeenCalledWith(null));
  });

  it('keeps client context and Meri on client-specific workflows', () => {
    mocks.pathname = '/engagement';
    window.history.replaceState({}, '', '/engagement');
    render(<AppShellV2 me={me} />);

    expect(screen.getByText('CLIENT')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Client scope: Overland AI/i })).toBeInTheDocument();
    expect(screen.getByText('JURISDICTION')).toBeInTheDocument();
    expect(screen.getByText('BUDGET YEAR')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open the Meri window' })).toHaveTextContent('Meri');
  });

  it('keeps route classification stable for existing shell behavior', () => {
    expect(sectionFor('/')).toBe('dashboard');
    expect(sectionFor('/clients/client-1')).toBe('portfolio');
    expect(sectionFor('/engagement')).toBe('engagement');
    expect(sectionFor('/workspace')).toBe('workspace');
    expect(sectionFor('/program-elements/0605053A')).toBe('intelligence');
    expect(sectionFor('/intelligence/opportunities')).toBe('intelligence');
    expect(sectionFor('/directory')).toBe('directory');
    expect(sectionFor('/settings')).toBe('more');
  });
});
