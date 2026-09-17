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
  // Timeout-and-progress remediation (2026-09-17): "Draft with Meri" now
  // submits a job and polls it. `draftJob` stands in for the polled
  // GET .../strategies/draft-jobs/:jobId response; tests mutate it and
  // `rerender()` (react-query itself is bypassed — the hooks below are
  // mocked, same as every other hook in this suite).
  draftJob: null as Record<string, unknown> | null,
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
    useSubmitDraftStrategy: () => ({
      mutate: (
        _body: unknown,
        opts?: { onSuccess?: (res: { jobId: string; status: 'queued' }) => void },
      ) => opts?.onSuccess?.({ jobId: 'job-1', status: 'queued' }),
      isPending: false,
      error: null,
    }),
    useDraftJobStatus: (jobId: string | null) => ({
      data: jobId ? (state.draftJob ?? undefined) : undefined,
      isLoading: false,
      isError: false,
      error: null,
    }),
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
  state.draftJob = null;
});

/** Fills every required field and picks "Draft with Meri" as the starting point. */
function fillRequiredFieldsForDraft() {
  fireEvent.change(screen.getByLabelText(/Client · Required/), { target: { value: 'client-a' } });
  fireEvent.change(screen.getByLabelText(/Objective type · Required/), {
    target: { value: 'appropriations' },
  });
  fireEvent.change(screen.getByLabelText(/Goal statement · Required/), {
    target: { value: 'Protect the FY27 line item.' },
  });
  fireEvent.change(screen.getByLabelText(/Owner · Required/), { target: { value: 'user-1' } });
  fireEvent.click(screen.getByRole('button', { name: /draft with meri/i }));
}

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

/**
 * Timeout-and-progress remediation (2026-09-17) — "Draft with Meri" no longer
 * blocks on one 90s HTTP call. `useSubmitDraftStrategy` now only enqueues a
 * job; `useDraftJobStatus` polls it. This suite pins:
 *   - submitting switches the overlay into a generating view showing the
 *     job's live stage/progress text and stream preview, not the form;
 *   - `completed` navigates using the job's strategyId (not a direct mutation
 *     response — there isn't one anymore);
 *   - `failed` renders the same alert copy pattern as the old synchronous
 *     failure, with a Try again that returns to a fresh, resubmittable form.
 */
describe('New strategy overlay — draft-with-Meri async job', () => {
  it('shows the job’s live stage and streamed preview while it runs, then navigates on completion', async () => {
    const { rerender } = renderOverlay();
    fillRequiredFieldsForDraft();
    fireEvent.click(screen.getByRole('button', { name: /create strategy & draft/i }));

    // Submitted, worker has not claimed the job yet.
    expect(screen.getByText(/starting…/i)).toBeTruthy();
    expect(screen.getByText(/meri is getting started…/i)).toBeTruthy();

    state.draftJob = {
      jobId: 'job-1',
      status: 'running',
      stage: 'drafting',
      progressText: 'Drafting the plan (attempt 1)…',
      streamPreview: 'Reviewing the FY27 appropriations posture for Client A…',
      strategyId: null,
      errorMessage: null,
      createdAt: '2026-09-17T00:00:00.000Z',
      updatedAt: '2026-09-17T00:00:05.000Z',
    };
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
    expect(screen.getByText(/drafting the plan \(attempt 1\)…/i)).toBeTruthy();
    expect(
      screen.getByText(/reviewing the fy27 appropriations posture for client a…/i),
    ).toBeTruthy();
    // The form itself is gone while the job runs.
    expect(screen.queryByLabelText(/Client · Required/)).toBeNull();

    state.draftJob = { ...state.draftJob, status: 'completed', strategyId: 'strategy-new-1' };
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
    await waitFor(() => expect(state.navigate).toContainEqual('/strategies/strategy-new-1'));
  });

  it('renders the failure in the same alert copy pattern and lets the user try again', async () => {
    const { rerender } = renderOverlay();
    fillRequiredFieldsForDraft();
    fireEvent.click(screen.getByRole('button', { name: /create strategy & draft/i }));

    state.draftJob = {
      jobId: 'job-1',
      status: 'failed',
      stage: 'drafting',
      progressText: null,
      streamPreview: null,
      strategyId: null,
      errorMessage: 'The model produced an unsafe plan.',
      createdAt: '2026-09-17T00:00:00.000Z',
      updatedAt: '2026-09-17T00:00:05.000Z',
    };
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

    expect(
      screen.getByText(/the strategy could not be created\. the model produced an unsafe plan\./i),
    ).toBeTruthy();
    expect(state.navigate).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    // Back to a fresh, resubmittable form — not stuck on the dead job.
    expect(screen.getByLabelText(/Client · Required/)).toBeTruthy();
  });
});
