import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MeResponse } from '../lib/me.js';
import { AppShellV2, sectionFor } from './AppShellV2.js';

let pathname = '/';
const navigate = vi.fn();
const setSelectedClientId = vi.fn();
const openMeriWorkspaceWindow = vi.fn();

vi.mock('react-router-dom', () => ({
  useLocation: () => ({ pathname }),
  useNavigate: () => navigate,
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
    setSelectedClientId,
  }),
}));
vi.mock('../pages/workspace/api.js', () => ({
  useNotifications: () => ({ data: { unread: 2 } }),
}));
vi.mock('../pages/program-element/api.js', () => ({
  getProgramElementSummary: vi.fn(),
}));
vi.mock('./chat/meri-window.js', () => ({
  openMeriWorkspaceWindow: () => openMeriWorkspaceWindow(),
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

describe('premium AppShellV2 contract', () => {
  beforeEach(() => {
    pathname = '/';
    navigate.mockReset();
    setSelectedClientId.mockReset();
    openMeriWorkspaceWindow.mockReset();
  });

  it('renders the premium top navigation and colored Meri launcher affordance', () => {
    render(<AppShellV2 me={me} />);

    expect(screen.getByText('CAPIRO')).toBeInTheDocument();
    expect(screen.getByText('Home')).toBeInTheDocument();
    expect(screen.getByText('Clients')).toBeInTheDocument();
    expect(screen.getByText('Intelligence')).toBeInTheDocument();
    expect(screen.getByText('Program Elements')).toBeInTheDocument();
    expect(screen.getByText('Funding')).toBeInTheDocument();
    expect(screen.getByText('Engagement')).toBeInTheDocument();
    expect(screen.getByText('Workspace')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open the Meri window' })).toHaveTextContent(
      'Open Meri',
    );
  });

  it('uses dashboard context chips and never renders the client picker on Home', async () => {
    render(<AppShellV2 me={me} />);

    expect(screen.getByText('JURISDICTION')).toBeInTheDocument();
    expect(screen.getByText('Federal')).toBeInTheDocument();
    expect(screen.getByText('BUDGET YEAR')).toBeInTheDocument();
    expect(screen.getByText('FY2027')).toBeInTheDocument();
    expect(screen.getByText('SIGNALS')).toBeInTheDocument();
    expect(screen.getByText('1 overnight')).toBeInTheDocument();
    expect(screen.queryByText('CLIENT')).not.toBeInTheDocument();

    await waitFor(() => expect(setSelectedClientId).toHaveBeenCalledWith(null));
  });

  it('keeps the real client scope control on client-specific workflows', () => {
    pathname = '/engagement';
    render(<AppShellV2 me={me} />);

    expect(screen.getByText('CLIENT')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Overland AI/i })).toBeInTheDocument();
    expect(screen.queryByText('JURISDICTION')).not.toBeInTheDocument();
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
