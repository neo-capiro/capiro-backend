import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  orgId: 'org-a' as string | null,
  userId: 'user-a' as string | null,
  impersonatedTenantSlug: null as string | null,
  api: { get: vi.fn() },
  listMeriSavedPrompts: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('@clerk/clerk-react', () => ({
  useAuth: () => ({ orgId: mocks.orgId, userId: mocks.userId }),
}));
vi.mock('../../lib/use-api.js', () => ({ useApi: () => mocks.api }));
vi.mock('../../state/impersonation.js', () => ({
  useImpersonation: () => ({ actAsTenantSlug: mocks.impersonatedTenantSlug }),
}));
vi.mock('../components/feedback/toast.js', () => ({
  useCapiroToast: () => mocks.toast,
}));
vi.mock('./meri-vnext-api.js', () => ({
  listMeriSavedPrompts: mocks.listMeriSavedPrompts,
}));

import { MeriStartWork } from './MeriStartWork.js';

const CONTROLLER = {
  selectedClientValue: '',
  clients: [],
} as unknown as Parameters<typeof MeriStartWork>[0]['controller'];

function renderStartWork(
  controller: Parameters<typeof MeriStartWork>[0]['controller'] = CONTROLLER,
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const onFillIntent = vi.fn();
  const view = render(
    <QueryClientProvider client={queryClient}>
      <MeriStartWork controller={controller} onFillIntent={onFillIntent} />
    </QueryClientProvider>,
  );
  return { onFillIntent, view };
}

describe('MeriStartWork live catalog', () => {
  beforeEach(() => {
    mocks.orgId = 'org-a';
    mocks.userId = 'user-a';
    mocks.impersonatedTenantSlug = null;
    mocks.toast.success.mockReset();
    mocks.api.get.mockReset();
    mocks.listMeriSavedPrompts.mockReset();
    mocks.api.get.mockResolvedValue({
      data: {
        enabled: true,
        skills: [
          {
            id: 'portfolio_changes',
            label: 'Portfolio Changes',
            description: 'What moved across clients.',
            starterPrompt: 'Summarise portfolio changes.',
            quickAction: true,
            requiresClient: false,
          },
          {
            id: 'client_changes',
            label: 'Client Changes',
            description: 'What moved for one client.',
            starterPrompt: 'What changed for {{clientName}}?',
            quickAction: true,
            requiresClient: true,
          },
        ],
      },
    });
    mocks.listMeriSavedPrompts.mockResolvedValue([
      { id: 'p1', title: 'HAC-D prep', body: 'Prepare me for HAC-D.' },
    ]);
  });

  test('renders the server skill catalog instead of fixture cards', async () => {
    renderStartWork();
    expect(await screen.findByRole('button', { name: /Portfolio Changes/ })).toBeTruthy();
    expect(screen.getByText('What moved across clients.')).toBeTruthy();
    expect(screen.queryByText('Research a company')).toBeNull();
    await waitFor(() =>
      expect(mocks.api.get).toHaveBeenCalledWith('/api/clio/v3/skills'),
    );
  });

  test('fills the composer from a saved prompt and never auto-sends', async () => {
    const { onFillIntent } = renderStartWork();
    fireEvent.click(screen.getByRole('tab', { name: 'PROMPTS' }));
    fireEvent.click(await screen.findByRole('button', { name: /HAC-D prep/ }));
    expect(onFillIntent).toHaveBeenCalledWith('Prepare me for HAC-D.');
    expect(mocks.listMeriSavedPrompts).toHaveBeenCalled();
  });

  test('blocks a client-scoped skill until a client is selected', async () => {
    renderStartWork();
    fireEvent.click(await screen.findByRole('button', { name: /Client Changes/ }));
    expect(mocks.toast.success).toHaveBeenCalledWith(
      'Pick a client scope first — this one works on a single client.',
    );
  });

  test('hydrates a client-scoped skill with the selected client name', async () => {
    const { onFillIntent } = renderStartWork({
      selectedClientValue: 'c-1',
      clients: [{ id: 'c-1', name: 'Lockheed Martin' }],
    } as unknown as Parameters<typeof MeriStartWork>[0]['controller']);
    fireEvent.click(await screen.findByRole('button', { name: /Client Changes/ }));
    expect(onFillIntent).toHaveBeenCalledWith('What changed for Lockheed Martin?');
  });
});
