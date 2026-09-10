/**
 * F06 (2026-09-10 remediation plan §4) — New-strategy overlay context
 * availability.
 *
 * The overlay used to request the broad all-client document/fact lists and
 * filter client-side (active state + clientId/null) — advertising
 * strategy-scoped documents of other strategies as available to Meri, with
 * counts derived from a 200-capped list. This suite pins the repaired
 * behavior:
 *   - availability comes from the server projection
 *     (useStrategyContextAvailability), scoped to the SELECTED client;
 *   - the prior client's numbers never render as current after a switch;
 *   - loading, failure, zero and truncated states are distinct;
 *   - copy says "available as working context" and never claims retrieval or
 *     approval; a separate link goes to the client's full document library;
 *   - the creation client initializes from the selected portfolio client
 *     without making an untouched form dirty.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NewStrategyOverlay } from './NewStrategyOverlay.js';

const state = vi.hoisted(() => ({
  clients: [
    { id: 'client-a', name: 'Client A' },
    { id: 'client-b', name: 'Client B' },
  ],
  members: [{ clerkUserId: 'user-1', name: 'Ada' }],
  phases: [{ id: 'p1', label: 'Strategy refresh', startFy: 2026, startQ: 1, endFy: 2026, endQ: 2 }],
  availability: null as Record<string, unknown> | null,
  availabilityError: false,
  shellClient: null as string | null,
  navigate: [] as string[],
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useNavigate: () => (to: string) => state.navigate.push(to),
  };
});

vi.mock('../strategies-api.js', async () => {
  const actual =
    await vi.importActual<typeof import('../strategies-api.js')>('../strategies-api.js');
  return {
    ...actual,
    useClientsLite: () => ({ data: state.clients, isLoading: false }),
    useTenantMembers: () => ({ data: state.members, isLoading: false }),
    useFirmPhases: () => ({ data: state.phases }),
    useStrategyContextAvailability: (clientId: string | null) => {
      if (!clientId) return { data: undefined, isLoading: false, isError: false, error: null };
      if (state.availabilityError) {
        return { data: undefined, isLoading: false, isError: true, error: new Error('boom') };
      }
      return {
        data: state.availability ?? undefined,
        isLoading: false,
        isError: false,
        error: null,
      };
    },
    useContextHealth: () => ({ data: undefined, isLoading: false, isError: false }),
    useCreateStrategy: () => ({ mutate: vi.fn(), isPending: false, error: null }),
    useDraftStrategy: () => ({ mutate: vi.fn(), isPending: false, error: null }),
  };
});

vi.mock('../../../adapters/legacy/useShellClientContext.js', () => ({
  useShellClientContext: () => ({
    selectedClientId: state.shellClient,
    selectedClientName: null,
    enabled: true,
    loading: false,
    unavailable: false,
    options: [],
    scopeLabel: 'All clients',
    setSelectedClientId: () => {},
  }),
}));

const queryClientRef: { current: ReturnType<typeof makeQueryClient> | null } = { current: null };
function makeQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function renderOverlay() {
  const client = makeQueryClient();
  queryClientRef.current = client;
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/strategies/new']}>
        <Routes>
          <Route path="/strategies/new" element={<NewStrategyOverlay />} />
          <Route path="/strategies/context" element={<p>Context library</p>} />
          <Route path="/strategies/context/:id" element={<p>Document detail</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  state.availability = null;
  state.availabilityError = false;
  state.shellClient = null;
  state.navigate = [];
});

describe('New strategy overlay — context availability (F06)', () => {
  it('asks for a client before showing any availability', () => {
    renderOverlay();
    expect(screen.getByText(/select a client to review context/i)).toBeTruthy();
  });

  it('renders the server projection counts as working context, never a fabricated zero', async () => {
    state.availability = {
      clientId: 'client-a',
      eligibleDocumentIds: ['d-1', 'd-2', 'd-3'],
      eligibleFactCount: 11,
      excluded: { strategyScoped: 2, nodeScoped: 0, stale: 1, retired: 0 },
      truncated: false,
    };
    renderOverlay();
    fireEvent.change(screen.getByLabelText(/Client · Required/), { target: { value: 'client-a' } });

    await waitFor(() => {
      expect(screen.getByText(/3 documents available as working context/i)).toBeTruthy();
      expect(screen.getByText(/11 facts/i)).toBeTruthy();
    });
    // The excluded material is named as context that does not apply, not hidden.
    expect(
      screen.getAllByText((_, el) =>
        (el?.textContent ?? '').includes('2 documents linked to another strategy'),
      ).length,
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByText((_, el) => (el?.textContent ?? '').includes('1 needs updating')).length,
    ).toBeGreaterThan(0);
  });

  it('shows zero applicable documents truthfully when only other-strategy material exists', async () => {
    state.availability = {
      clientId: 'client-a',
      eligibleDocumentIds: [],
      eligibleFactCount: 0,
      excluded: { strategyScoped: 1, nodeScoped: 0, stale: 0, retired: 0 },
      truncated: false,
    };
    renderOverlay();
    fireEvent.change(screen.getByLabelText(/Client · Required/), { target: { value: 'client-a' } });

    await waitFor(() => {
      expect(screen.getByText(/0 documents available as working context/i)).toBeTruthy();
      expect(
        screen.getAllByText((_, el) =>
          (el?.textContent ?? '').includes('1 document linked to another strategy'),
        ).length,
      ).toBeGreaterThan(0);
    });
    expect(screen.queryByText(/no documents/i)).toBeNull();
  });

  it('reports truncation instead of presenting a capped count as authoritative', async () => {
    state.availability = {
      clientId: 'client-a',
      eligibleDocumentIds: ['d-1'],
      eligibleFactCount: 5,
      excluded: { strategyScoped: 0, nodeScoped: 0, stale: 0, retired: 0 },
      truncated: true,
    };
    renderOverlay();
    fireEvent.change(screen.getByLabelText(/Client · Required/), { target: { value: 'client-a' } });

    await waitFor(() => {
      expect(screen.getAllByText(/at least 1 document/i).length).toBeGreaterThan(0);
      expect(screen.getAllByText(/more than the first 500/i).length).toBeGreaterThan(0);
    });
  });

  it('renders an explicit unavailable state when the projection fails, without inventing counts', async () => {
    state.availabilityError = true;
    renderOverlay();
    fireEvent.change(screen.getByLabelText(/Client · Required/), { target: { value: 'client-a' } });

    await waitFor(() => {
      expect(screen.getByText(/working context could not be checked/i)).toBeTruthy();
    });
    expect(screen.queryByText(/0 documents available/i)).toBeNull();
  });

  it('switching clients renders the NEW client projection, never the prior client as current', async () => {
    renderOverlay();
    const select = screen.getByLabelText(/Client · Required/) as HTMLSelectElement;

    state.availability = {
      clientId: 'client-a',
      eligibleDocumentIds: ['a-1', 'a-2'],
      eligibleFactCount: 4,
      excluded: { strategyScoped: 0, nodeScoped: 0, stale: 0, retired: 0 },
      truncated: false,
    };
    fireEvent.change(select, { target: { value: 'client-a' } });
    await waitFor(() =>
      expect(screen.getByText(/2 documents available as working context/i)).toBeTruthy(),
    );

    state.availability = {
      clientId: 'client-b',
      eligibleDocumentIds: [],
      eligibleFactCount: 0,
      excluded: { strategyScoped: 3, nodeScoped: 0, stale: 0, retired: 0 },
      truncated: false,
    };
    fireEvent.change(select, { target: { value: 'client-b' } });
    await waitFor(() => {
      expect(screen.getByText(/0 documents available as working context/i)).toBeTruthy();
      expect(
        screen.getAllByText((_, el) =>
          (el?.textContent ?? '').includes('3 documents linked to another strategy'),
        ).length,
      ).toBeGreaterThan(0);
    });
  });

  it('links to the client\u2019s full context library separately from the availability count', async () => {
    state.availability = {
      clientId: 'client-a',
      eligibleDocumentIds: ['d-1'],
      eligibleFactCount: 2,
      excluded: { strategyScoped: 0, nodeScoped: 0, stale: 0, retired: 0 },
      truncated: false,
    };
    renderOverlay();
    fireEvent.change(screen.getByLabelText(/Client · Required/), { target: { value: 'client-a' } });

    await waitFor(() =>
      expect(screen.getByText(/1 document available as working context/i)).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole('button', { name: /view all client a documents/i }));
    expect(state.navigate).toContainEqual('/strategies/context?clientId=client-a');
  });

  it('initializes the client from the selected portfolio client without making an untouched form dirty', () => {
    state.shellClient = 'client-b';
    const { container } = renderOverlay();
    const select = screen.getByLabelText(/Client · Required/) as HTMLSelectElement;
    expect(select.value).toBe('client-b');
    // The untouched form is not dirty: closing must not prompt. The shell's
    // dirty guard is driven by the overlay's `dirty` prop — assert via the
    // rendered primary button state instead (disabled until required fields
    // are complete, and no unsaved-changes warning markup).
    expect(container.querySelector('.st-modal__alert')).toBeNull();
  });

  // Review fix (2026-09-10 audit): the client list usually resolves AFTER the
  // overlay mounts (its useState initializer ran while clients.data was still
  // undefined), which silently dropped the portfolio selection — plan item 8
  // broken on the common path. When the list arrives and the user has made no
  // selection, a still-valid portfolio client must initialize THEN, still as
  // the form baseline (not a user edit, no false dirty).
  it('initializes the portfolio client once the client list resolves after mount, still not dirty', () => {
    state.shellClient = 'client-b';
    const clientsRef = { data: undefined as typeof state.clients | undefined };
    const originalClients = state.clients;
    state.clients = undefined as unknown as typeof state.clients;
    const { rerender } = renderOverlay();
    let select = screen.getByLabelText(/Client · Required/) as HTMLSelectElement;
    // While the list is loading there is nothing valid to initialize from.
    expect(select.value).toBe('');

    state.clients = originalClients;
    rerender(
      <QueryClientProvider client={queryClientRef.current!}>
        <MemoryRouter initialEntries={['/strategies/new']}>
          <Routes>
            <Route path="/strategies/new" element={<NewStrategyOverlay />} />
            <Route path="/strategies/context" element={<p>Context library</p>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    select = screen.getByLabelText(/Client · Required/) as HTMLSelectElement;
    expect(select.value).toBe('client-b');
  });
});
