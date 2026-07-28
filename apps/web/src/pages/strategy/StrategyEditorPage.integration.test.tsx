/*
 * Phase 6 §4 (Web) — the cross-phase integration test around StrategyEditorPage.
 *
 * Every other strategy test in this directory mocks `./api.js` and asserts a
 * component in isolation. This one does the opposite: it fakes ONLY the axios
 * transport (`useApi`) and the identity/feature reads, then drives the REAL
 * page, header, panel, Watch panel, chat thread, composer, timeline and the
 * REAL api.ts hooks against a real QueryClient. That is the only way to catch
 * the class of defect Phase 6 exists to close — two phases that each pass their
 * own unit tests while disagreeing with each other at runtime (Phase 1's header
 * chip counting a different proposal set than Phase 4's panel, an accept that
 * writes the strategy cache but leaves the header stale, a dismissal the header
 * keeps showing).
 *
 * Scenario coverage (plan §3): A (new strategy, valid context), D (Watch first
 * run), E (single accept + stale-proposal reconciliation), F (accept all),
 * G (permanent dismissal), and the flag-off half of I.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { App } from 'antd';
import type {
  StrategyChatMessage,
  StrategyDetail,
  StrategyNode,
  WatchProposalCard,
  WatchReviewState,
} from './types.js';

const SID = 'strat-1';
const HEAD = 'v7';

// ---- the fake server ----------------------------------------------------------

interface Db {
  detail: StrategyDetail;
  watch: WatchReviewState;
  threads: Record<string, StrategyChatMessage[]>;
  missions: unknown[];
}

let db: Db;
/** Every request the page makes, in order — used to assert "nothing applied
 *  before Accept" and "exactly one call per user action". */
let calls: Array<{ method: string; url: string; body?: unknown }>;
/** Queued failures, keyed by URL suffix, for the stale-head (409) path. */
let failNext: Record<string, { status: number }>;

const node = (over: Partial<StrategyNode> & { id: string; title: string }): StrategyNode =>
  ({
    strategyId: SID,
    kind: 'action',
    subject: 'deliverable',
    note: null,
    ownerUserId: null,
    status: 'draft',
    startsOn: '2027-02-01',
    endsOn: '2027-02-20',
    openEnded: false,
    dependsOnIds: [],
    provenance: null,
    targetRef: null,
    meriAuthored: true,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    ...over,
  }) as StrategyNode;

const detail = (over: Partial<StrategyDetail> = {}): StrategyDetail => ({
  id: SID,
  clientId: 'client-1',
  title: 'FY27 plus-up',
  type: 'appropriations',
  goal: 'Secure the FY27 plus-up.',
  meriContext: null,
  meriSummary: null,
  draftedByMeri: true,
  targetDate: null,
  ownerUserId: 'user-1',
  createdByUserId: 'user-1',
  lastEditedByUserId: null,
  lastEditedAt: null,
  archivedAt: null,
  createdAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-01T00:00:00.000Z',
  nodes: [
    node({ id: 'n1', title: 'Coalition sign-on letter' }),
    node({ id: 'n2', title: 'Markup defense memo', startsOn: '2027-03-01', endsOn: '2027-03-15' }),
  ],
  artifacts: [],
  violations: [],
  groundingHealth: null,
  ...over,
});

const proposal = (over: Partial<WatchProposalCard> & { id: string }): WatchProposalCard => ({
  watchKey: `key-${over.id}`,
  strategyVersionId: HEAD,
  sourceLabel: 'Dependency check',
  sourceDate: '2026-07-20',
  badges: [],
  title: 'Plan check',
  proposal: 'Retime to 2027-04-01 – 2027-04-15',
  impact: 'moves one later step',
  why: 'This step starts before the step it depends on finishes.',
  risk: 'medium',
  recheckStatus: null,
  ...over,
});

const watch = (over: Partial<WatchReviewState> = {}): WatchReviewState => ({
  strategyId: SID,
  headVersionId: HEAD,
  mission: { id: 'm1', state: 'active', cadence: 'weekly', lastRunAt: '2026-07-20T00:00:00.000Z', nextRunAt: null },
  pendingCount: 0,
  proposals: [],
  lastRecheck: null,
  ...over,
});

const chat = (over: Partial<StrategyChatMessage> & { id: string }): StrategyChatMessage => ({
  strategyId: SID,
  nodeId: null,
  role: 'meri',
  kind: 'message',
  body: 'A tight FY27 push.',
  attachments: [],
  action: null,
  state: 'active',
  createdByUserId: null,
  createdAt: '2026-07-27T00:00:00.000Z',
  ...over,
});

function httpError(status: number) {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, data: { message: 'stale' } },
    isAxiosError: true,
  });
}

const get = vi.fn(async (url: string) => {
  calls.push({ method: 'GET', url });
  if (url.startsWith(`/strategy-api/strategies/${SID}/conversations`)) {
    const nodeId = new URL(`http://x${url}`).searchParams.get('nodeId');
    return { data: db.threads[nodeId ?? 'strategy'] ?? [] };
  }
  if (url === `/strategy-api/strategies/${SID}`) return { data: db.detail };
  if (url === '/strategy-api/reference-calendars') {
    return { data: { congress: [], ppbeLanes: [], ppbeCurrentPhases: [], source: {} } };
  }
  if (url === '/strategy-api/firm-phases') return { data: [] };
  if (url.startsWith('/strategy-api/agents/missions')) return { data: db.missions };
  if (url === `/strategy-api/agents/watch/strategies/${SID}`) return { data: db.watch };
  throw new Error(`unrouted GET ${url}`);
});

const post = vi.fn(async (url: string, body?: unknown) => {
  calls.push({ method: 'POST', url, body });
  const queued = Object.entries(failNext).find(([suffix]) => url.endsWith(suffix));
  if (queued) {
    delete failNext[queued[0]];
    throw httpError(queued[1].status);
  }
  if (url.endsWith('/revalidate')) {
    db.watch = { ...db.watch, lastRecheck: { state: 'complete', elapsedMs: 12, unchanged: [], updated: [], dropped: [] } };
    return { data: db.watch };
  }
  if (url.endsWith('/accept')) {
    const id = url.split('/').at(-2)!;
    const remaining = db.watch.proposals.filter((p) => p.id !== id);
    db.watch = { ...db.watch, proposals: remaining, pendingCount: remaining.length };
    return {
      data: {
        strategy: db.detail,
        state: db.watch,
        recheck: {
          state: 'complete',
          elapsedMs: 40,
          unchanged: remaining.map((p) => ({ watchKey: p.watchKey, newProposalId: p.id })),
          updated: [],
          dropped: [{ watchKey: 'key-gone', reason: 'The step this was about is no longer in the plan.', targetDeleted: true }],
        },
      },
    };
  }
  if (url.endsWith('/accept-all')) {
    db.watch = { ...db.watch, proposals: [], pendingCount: 0 };
    return {
      data: {
        strategy: db.detail,
        state: db.watch,
        recheck: { state: 'complete', elapsedMs: 55, unchanged: [], updated: [], dropped: [] },
      },
    };
  }
  if (url.endsWith('/dismiss')) {
    const id = url.split('/').at(-2)!;
    const remaining = db.watch.proposals.filter((p) => p.id !== id);
    db.watch = { ...db.watch, proposals: remaining, pendingCount: remaining.length };
    return { data: db.watch };
  }
  if (url.endsWith('/assistant')) {
    const created = node({ id: 'n9', title: 'Coalition sign-on letter II' });
    db.detail = { ...db.detail, nodes: [...db.detail.nodes, created] };
    db.threads.strategy = [
      ...(db.threads.strategy ?? []),
      chat({ id: 'u1', role: 'user', body: (body as { instruction: string }).instruction }),
      chat({
        id: 'm2',
        body: 'Added a second coalition letter.',
        action: { type: 'open_node', nodeId: 'n9', title: 'Coalition sign-on letter II' },
      }),
    ];
    return { data: { reply: 'Added a second coalition letter.', strategy: db.detail } };
  }
  throw new Error(`unrouted POST ${url}`);
});

vi.mock('../../lib/use-api.js', () => ({
  useApi: () => ({ get, post, patch: vi.fn(), delete: vi.fn() }),
}));
vi.mock('@clerk/clerk-react', () => ({ useUser: () => ({ user: { id: 'user-1' } }) }));
vi.mock('./clients-lite.js', () => ({
  useClientsLite: () => ({ isLoading: false, isError: false, isSuccess: true, data: [{ id: 'client-1', name: 'Brightdefense' }] }),
  clientColor: () => '#2A57CE',
}));
vi.mock('./members.js', () => ({
  useTenantMembers: () => ({ isLoading: false, isError: false, isSuccess: true, data: [] }),
  memberName: () => 'Neo Martinez',
  initialsOf: () => 'NM',
}));
vi.mock('./client-targets-lite.js', () => ({
  useClientTargetsLite: () => ({ isLoading: false, isSuccess: true, data: [] }),
  targetDisplayLabel: () => 'Target',
}));

let features: Record<string, boolean>;
vi.mock('../../lib/me.js', () => ({
  useMe: () => ({ isLoading: false, isError: false, isSuccess: true, data: { features } }),
}));

import { StrategyEditorPage } from './StrategyEditorPage.js';

function renderEditor() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/strategies/${SID}`]}>
        <App>
          <div className="sp-root">
            <Routes>
              <Route path="/strategies/:id" element={<StrategyEditorPage />} />
            </Routes>
          </div>
        </App>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...view, qc };
}

/** The editor renders a loading line until the strategy GET resolves. */
async function renderLoadedEditor() {
  const view = renderEditor();
  await screen.findByTestId('sp-header');
  return view;
}

const openPanel = () => fireEvent.click(screen.getByRole('button', { name: /Ask Meri/ }));
const watchPanel = () => screen.getByTestId('sp-watch-panel');

beforeEach(() => {
  // jsdom implements neither of these; the Watch panel's focus effect and the
  // thread's auto-scroll both call them.
  Element.prototype.scrollIntoView = vi.fn();
  db = { detail: detail(), watch: watch(), threads: {}, missions: [] };
  calls = [];
  failNext = {};
  features = {
    strategyPlanner: true,
    strategyPlannerMeri: true,
    agenticMeri: true,
    strategyWatcher: true,
  };
  get.mockClear();
  post.mockClear();
});

// ── Scenario A — new strategy, valid full context ──────────────────────────────

describe('Scenario A — the editor shell', () => {
  test('the header ends Watch → Export → History → Ask Meri, and the page offers no global Meri, Review, Execution or Context control', async () => {
    await renderLoadedEditor();
    const row2 = screen.getByTestId('sp-header-row2');
    const labels = within(row2)
      .getAllByRole('button')
      .map((b) => (b.getAttribute('aria-label') ?? b.textContent ?? '').trim());
    expect(labels.slice(-4)).toEqual([
      expect.stringContaining('Watching'),
      'Export',
      'History',
      'Ask Meri',
    ]);
    for (const forbidden of [/^Review$/i, /^Execution$/i, /^Context$/i, /review queue/i]) {
      expect(screen.queryByRole('button', { name: forbidden })).toBeNull();
    }
  });

  test('opening the panel shows the persistent drafted note and the strategy thread — no warning cards above the timeline', async () => {
    db.threads.strategy = [chat({ id: 'm1', body: 'A tight FY27 push, front-loaded before markup.' })];
    await renderLoadedEditor();
    openPanel();

    expect(await screen.findByTestId('sp-drafted-note')).toBeTruthy();
    expect(await screen.findByTestId('sp-chat-thread')).toHaveTextContent('front-loaded before markup');
    // Phase 5 §8: no page-level warning stack survives anywhere in the editor.
    expect(screen.queryByText(/Drafted on partial information/i)).toBeNull();
    expect(screen.queryByText(/realism check/i)).toBeNull();
  });

  test('a send that adds a step stays in the strategy thread and offers an Open link; Open switches to that step’s own history', async () => {
    await renderLoadedEditor();
    openPanel();

    const input = await screen.findByPlaceholderText('Ask Meri to change anything…');
    fireEvent.change(input, { target: { value: 'Add a second coalition letter' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    const assistantCall = await waitFor(() => {
      const c = calls.find((x) => x.url.endsWith('/assistant'));
      expect(c).toBeTruthy();
      return c!;
    });
    expect(assistantCall.body).toMatchObject({ scope: 'strategy', instruction: 'Add a second coalition letter' });

    // The reply lands in the STRATEGY thread, and nothing auto-navigated.
    const open = await screen.findByRole('button', { name: /Open “Coalition sign-on letter II”/ });
    expect(screen.getByPlaceholderText('Ask Meri to change anything…')).toBeTruthy();

    // The step thread is a separate fetch with its own persisted history.
    db.threads.n9 = [chat({ id: 's1', nodeId: 'n9', body: 'This step is scheduled for April.' })];
    fireEvent.click(open);
    await waitFor(() =>
      expect(screen.getByTestId('sp-chat-thread')).toHaveTextContent('This step is scheduled for April.'),
    );
    expect(screen.getByTestId('sp-chat-thread')).not.toHaveTextContent('Added a second coalition letter.');
    expect(screen.getByPlaceholderText('Ask Meri to change this step…')).toBeTruthy();
    expect(calls.some((c) => c.method === 'GET' && c.url.includes('nodeId=n9'))).toBe(true);
  });

  test('a chat send does not start a full-strategy refetch loop (Phase 6 §5)', async () => {
    await renderLoadedEditor();
    openPanel();
    await screen.findByPlaceholderText('Ask Meri to change anything…');
    const before = calls.filter((c) => c.url === `/strategy-api/strategies/${SID}`).length;

    const input = screen.getByPlaceholderText('Ask Meri to change anything…');
    fireEvent.change(input, { target: { value: 'Add a second coalition letter' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await screen.findByRole('button', { name: /Open “Coalition sign-on letter II”/ });
    await new Promise((r) => setTimeout(r, 50));

    // The assistant response is written STRAIGHT into the detail cache
    // (api.ts setQueryData), so the send costs zero extra strategy GETs — a
    // refetch-on-invalidate loop here would re-render the timeline on every
    // reply.
    const after = calls.filter((c) => c.url === `/strategy-api/strategies/${SID}`).length;
    expect(after).toBe(before);
  });

  test('Shift+Enter never sends', async () => {
    await renderLoadedEditor();
    openPanel();
    const input = await screen.findByPlaceholderText('Ask Meri to change anything…');
    fireEvent.change(input, { target: { value: 'not yet' } });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(calls.some((c) => c.url.endsWith('/assistant'))).toBe(false);
  });

  test('closing the panel returns to the timeline and re-opening restores the thread', async () => {
    db.threads.strategy = [chat({ id: 'm1', body: 'A tight FY27 push.' })];
    await renderLoadedEditor();
    openPanel();
    await screen.findByTestId('sp-panel-body');

    fireEvent.click(screen.getByRole('button', { name: 'Close the panel' }));
    await waitFor(() => expect(screen.queryByTestId('sp-panel-body')).toBeNull());

    openPanel();
    expect(await screen.findByTestId('sp-chat-thread')).toHaveTextContent('A tight FY27 push.');
  });
});

// ── Scenario D — Watch first run ───────────────────────────────────────────────

describe('Scenario D — the Watch chip and the first check', () => {
  test('the header chip count is the panel’s authoritative count, not the raw proposed-change-set list', async () => {
    db.watch = watch({
      pendingCount: 2,
      proposals: [proposal({ id: 'cs-1' }), proposal({ id: 'cs-2' })],
    });
    await renderLoadedEditor();

    const chip = await screen.findByTestId('sp-header-watch');
    await waitFor(() => expect(chip).toHaveTextContent('2'));
    // The chip must not be sourced from /agents/change-sets any more: that list
    // still contains stale-head and deleted-target rows the panel filters out.
    expect(calls.some((c) => c.url.includes('/agents/change-sets'))).toBe(false);

    fireEvent.click(chip);
    const panel = await screen.findByTestId('sp-watch-panel');
    expect(panel).toHaveTextContent('2 proposed changes for your review');
  });

  test('clicking the chip opens the in-editor panel and revalidates — it never navigates to a review page', async () => {
    db.watch = watch({ pendingCount: 1, proposals: [proposal({ id: 'cs-1' })] });
    await renderLoadedEditor();
    fireEvent.click(await screen.findByTestId('sp-header-watch'));

    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/revalidate'))).toBe(true),
    );
    expect(screen.getByTestId('sp-watch-panel')).toBeTruthy();
    expect(window.location.pathname).toBe('/');
  });

  test('an Out of order proposal sorts first and shows source, date, proposal, Why and impact — and applies nothing before Accept', async () => {
    db.watch = watch({
      pendingCount: 2,
      proposals: [
        proposal({
          id: 'cs-1',
          badges: ['out_of_order'],
          title: 'Markup defense memo starts before the letter lands',
          sourceLabel: 'Dependency check',
          sourceDate: '2026-07-20',
        }),
        proposal({ id: 'cs-2', title: 'Overdue step', sourceLabel: 'Calendar check' }),
      ],
    });
    await renderLoadedEditor();
    openPanel();

    const cards = within(await screen.findByTestId('sp-watch-scroller')).getAllByText(/starts before|Overdue step/);
    expect(cards[0]!.textContent).toContain('Markup defense memo starts before the letter lands');
    expect(watchPanel()).toHaveTextContent('Out of order');
    expect(watchPanel()).toHaveTextContent('Dependency check');
    expect(watchPanel()).toHaveTextContent('Retime to 2027-04-01 – 2027-04-15');

    fireEvent.click(within(watchPanel()).getAllByRole('button', { name: 'Why?' })[0]!);
    expect(watchPanel()).toHaveTextContent('This step starts before the step it depends on finishes.');
    expect(watchPanel()).toHaveTextContent('moves one later step');

    // Nothing has been applied: no accept/accept-all POST has been made.
    expect(calls.some((c) => c.method === 'POST' && /accept/.test(c.url))).toBe(false);
  });
});

// ── Scenario E — single accept + reconciliation ────────────────────────────────

describe('Scenario E — accept one', () => {
  test('accept sends exactly one request, blocks every action while re-checking, and reports a dropped deleted-target calmly', async () => {
    db.watch = watch({
      pendingCount: 2,
      proposals: [proposal({ id: 'cs-1' }), proposal({ id: 'cs-2', title: 'Second finding' })],
    });
    await renderLoadedEditor();
    openPanel();
    await screen.findByTestId('sp-watch-panel');

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const original = post.getMockImplementation()!;
    post.mockImplementationOnce(async (url: string, body?: unknown) => {
      await gate;
      return original(url, body);
    });

    fireEvent.click(within(watchPanel()).getAllByRole('button', { name: 'Accept' })[0]!);

    // While the accept + server-side recheck is in flight the whole panel is
    // inert — no second accept, no dismiss, no accept-all can be fired.
    await waitFor(() => expect(watchPanel()).toHaveTextContent('Re-checking…'));
    for (const name of ['Accept', 'Dismiss', /Accept all/]) {
      for (const b of within(watchPanel()).getAllByRole('button', { name: name as string | RegExp })) {
        expect(b).toBeDisabled();
      }
    }

    release();
    await waitFor(() => expect(watchPanel()).toHaveTextContent('1 proposed change for your review'));
    expect(calls.filter((c) => c.method === 'POST' && c.url.endsWith('/accept'))).toHaveLength(1);

    // The deleted-target drop is a calm status line, never a red error card.
    const dropped = within(watchPanel()).getByText('The step this was about is no longer in the plan.');
    expect(dropped.closest('[role="status"]')).toBeTruthy();
  });

  test('the header chip follows the accept without a manual refresh', async () => {
    db.watch = watch({ pendingCount: 2, proposals: [proposal({ id: 'cs-1' }), proposal({ id: 'cs-2' })] });
    await renderLoadedEditor();
    openPanel();
    await screen.findByTestId('sp-watch-panel');
    await waitFor(() => expect(screen.getByTestId('sp-header-watch')).toHaveTextContent('2'));

    fireEvent.click(within(watchPanel()).getAllByRole('button', { name: 'Accept' })[0]!);
    await waitFor(() => expect(screen.getByTestId('sp-header-watch')).toHaveTextContent('1'));
  });

  test('a stale-head 409 reconciles in place instead of dead-ending in an error', async () => {
    db.watch = watch({ pendingCount: 1, proposals: [proposal({ id: 'cs-1' })] });
    await renderLoadedEditor();
    openPanel();
    await screen.findByTestId('sp-watch-panel');
    failNext['/accept'] = { status: 409 };

    fireEvent.click(within(watchPanel()).getByRole('button', { name: 'Accept' }));

    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/revalidate'))).toBe(true),
    );
    expect(screen.queryByText(/Could not accept this proposal/i)).toBeNull();
  });
});

// ── Scenario F — accept all ────────────────────────────────────────────────────

describe('Scenario F — accept all', () => {
  test('sends ONE request carrying the expected head and the exact on-screen proposal ids', async () => {
    db.watch = watch({
      pendingCount: 3,
      proposals: [proposal({ id: 'cs-1' }), proposal({ id: 'cs-2' }), proposal({ id: 'cs-3' })],
    });
    await renderLoadedEditor();
    openPanel();
    await screen.findByTestId('sp-watch-panel');

    fireEvent.click(within(watchPanel()).getByRole('button', { name: 'Accept all 3' }));

    await waitFor(() => expect(watchPanel()).toHaveTextContent('Nothing to review'));
    const batch = calls.filter((c) => c.url.endsWith('/accept-all'));
    expect(batch).toHaveLength(1);
    expect(batch[0]!.body).toEqual({ expectedVersionId: HEAD, proposalIds: ['cs-1', 'cs-2', 'cs-3'] });
    // One batch — never one accept per proposal.
    expect(calls.filter((c) => c.url.endsWith('/accept'))).toHaveLength(0);
  });
});

// ── Scenario G — permanent dismissal ───────────────────────────────────────────

describe('Scenario G — dismissal', () => {
  test('a dismissed proposal leaves both the panel and the header count immediately', async () => {
    db.watch = watch({ pendingCount: 1, proposals: [proposal({ id: 'cs-1', title: 'Overdue step' })] });
    await renderLoadedEditor();
    openPanel();
    await screen.findByTestId('sp-watch-panel');
    await waitFor(() => expect(screen.getByTestId('sp-header-watch')).toHaveTextContent('1'));

    fireEvent.click(within(watchPanel()).getByRole('button', { name: 'Dismiss' }));

    await waitFor(() => expect(watchPanel()).toHaveTextContent('Nothing to review'));
    expect(screen.getByTestId('sp-header-watch')).not.toHaveTextContent('1');
    expect(screen.queryByText('Overdue step')).toBeNull();
  });
});

// ── Scenario I — flags off ─────────────────────────────────────────────────────

describe('Scenario I — existing capabilities with the flags off', () => {
  test('with strategyWatcher off there is no chip and no Watch request; with Meri off manual editing survives', async () => {
    features = { strategyPlanner: true, strategyPlannerMeri: false, agenticMeri: false, strategyWatcher: false };
    await renderLoadedEditor();

    expect(screen.queryByTestId('sp-header-watch')).toBeNull();
    expect(calls.some((c) => c.url.includes('/agents/watch/'))).toBe(false);
    expect(screen.getByRole('button', { name: /Add step/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Edit panel/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Ask Meri/ })).toBeNull();
  });
});
