/*
 * Phase 4 §9 — the in-editor Watch panel, matched pixel-for-pixel against the
 * prototype's WatchPanel (extracted from its bundled JSX, not approximated).
 * Items 1 (chip states), 2's chip-click plumbing, 16, and 18 are covered by
 * pre-existing StrategyHeader.test.tsx / StrategyLibraryPage.landing-header
 * .test.tsx / StrategyRoutes.registration.test.tsx / ReviewQueue.firm-runs
 * .test.tsx, which this phase leaves passing unmodified. Items 9/13 (cache
 * invalidation) live in ../api.watch.test.tsx against the real hooks. This
 * file covers everything else: the panel's own rendering and interaction
 * contract, mocking ../api.js so no network/QueryClient wiring is exercised
 * here (that IS exercised — for real — in api.watch.test.tsx).
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { App } from 'antd';
import type { WatchProposalCard, WatchReviewState } from '../types.js';

// jsdom does not implement scrollIntoView — same polyfill idiom used
// throughout this codebase's other ref.scrollIntoView() components.
if (!HTMLElement.prototype.scrollIntoView) {
  HTMLElement.prototype.scrollIntoView = vi.fn();
}

const revalidateMutate = vi.fn();
const acceptMutate = vi.fn();
const dismissMutate = vi.fn();
const acceptAllMutate = vi.fn();
const createMissionMutate = vi.fn();
const updateMissionMutate = vi.fn();

let stateData: WatchReviewState | undefined;
let revalidatePending = false;
let acceptPending = false;
let dismissPending = false;
let acceptAllPending = false;
let createMissionPending = false;
let updateMissionPending = false;

vi.mock('../api.js', () => ({
  useWatchReviewState: () => ({ isLoading: false, data: stateData }),
  useRevalidateWatch: () => ({ mutate: revalidateMutate, isPending: revalidatePending }),
  useAcceptWatchProposal: () => ({ mutate: acceptMutate, isPending: acceptPending }),
  useDismissWatchProposal: () => ({ mutate: dismissMutate, isPending: dismissPending }),
  useAcceptAllWatchProposals: () => ({ mutate: acceptAllMutate, isPending: acceptAllPending }),
  useCreateMission: () => ({ mutate: createMissionMutate, isPending: createMissionPending }),
  useUpdateMission: () => ({ mutate: updateMissionMutate, isPending: updateMissionPending }),
}));

import { StrategyWatchPanel } from './StrategyWatchPanel.js';

function proposal(over: Partial<WatchProposalCard> & { id: string }): WatchProposalCard {
  return {
    watchKey: 'k1',
    strategyVersionId: 'v1',
    sourceLabel: 'Dependency check',
    sourceDate: null,
    badges: [],
    title: 'Markup defense runs before the hearing it depends on',
    proposal: 'Retime to next quarter',
    impact: '1 step re-timed',
    why: 'Meri compared this plan against the legislative calendar, the PPBE reference, your firm phases and each step’s dependencies.',
    risk: 'low',
    recheckStatus: null,
    ...over,
  };
}

function watchState(over: Partial<WatchReviewState> = {}): WatchReviewState {
  return {
    strategyId: 'strat-1',
    headVersionId: 'v1',
    mission: { id: 'm1', state: 'active', cadence: 'weekly', lastRunAt: null, nextRunAt: null },
    pendingCount: 0,
    proposals: [],
    lastRecheck: null,
    ...over,
  };
}

function renderPanel(props: { focus?: boolean; onFocused?: () => void } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const view = render(
    <QueryClientProvider client={qc}>
      <App>
        <div className="sp-root">
          <StrategyWatchPanel strategyId="strat-1" focus={props.focus} onFocused={props.onFocused} />
        </div>
      </App>
    </QueryClientProvider>,
  );
  return { ...view, qc };
}

beforeEach(() => {
  stateData = undefined;
  revalidatePending = false;
  acceptPending = false;
  dismissPending = false;
  acceptAllPending = false;
  createMissionPending = false;
  updateMissionPending = false;
  for (const fn of [
    revalidateMutate,
    acceptMutate,
    dismissMutate,
    acceptAllMutate,
    createMissionMutate,
    updateMissionMutate,
  ]) {
    fn.mockReset();
  }
});

// ---- §9.3 zero-state copy and Pause/Resume/Check controls -----------------

describe('zero-state (§9.3)', () => {
  test('watching + nothing pending: exact prototype copy, Pause + Check now', () => {
    stateData = watchState({ mission: { id: 'm1', state: 'active', cadence: 'weekly', lastRunAt: null, nextRunAt: null } });
    renderPanel();
    expect(screen.getByTestId('sp-watch-panel')).toHaveTextContent(
      'Nothing to review — last check found no conflicts with the calendars, your firm phases, or step dependencies.',
    );
    expect(screen.getByRole('button', { name: 'Pause for this strategy' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Check now' })).toBeTruthy();
  });

  test('paused: exact prototype copy, Resume only (no Check now)', () => {
    stateData = watchState({ mission: { id: 'm1', state: 'paused', cadence: 'weekly', lastRunAt: null, nextRunAt: null } });
    renderPanel();
    expect(screen.getByTestId('sp-watch-panel')).toHaveTextContent(
      "Paused for this strategy. Meri won't check it against calendar changes.",
    );
    expect(screen.getByRole('button', { name: 'Resume watching' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Check now' })).toBeNull();
  });

  test('Pause sends state: paused for the existing mission', () => {
    stateData = watchState({ mission: { id: 'm1', state: 'active', cadence: 'weekly', lastRunAt: null, nextRunAt: null } });
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Pause for this strategy' }));
    expect(updateMissionMutate).toHaveBeenCalledWith(
      { id: 'm1', input: { state: 'paused' } },
      expect.anything(),
    );
  });

  test('Resume sends state: active AND rewrites cadence to weekly (§7 — explicit resume is the one allowed rewrite)', () => {
    stateData = watchState({ mission: { id: 'm1', state: 'paused', cadence: 'daily', lastRunAt: null, nextRunAt: null } });
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Resume watching' }));
    expect(updateMissionMutate).toHaveBeenCalledWith(
      { id: 'm1', input: { state: 'active', cadence: 'weekly', nextRunAt: expect.any(String) } },
      expect.anything(),
    );
  });

  test('no mission yet: Resume watching creates one with cadence weekly (§7 — new missions default to weekly)', () => {
    stateData = watchState({ mission: null });
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Resume watching' }));
    expect(createMissionMutate).toHaveBeenCalledWith(
      { strategyId: 'strat-1', name: 'Keep this strategy on track', cadence: 'weekly' },
      expect.anything(),
    );
  });

  test('Check now triggers revalidate', () => {
    stateData = watchState();
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Check now' }));
    expect(revalidateMutate).toHaveBeenCalled();
  });
});

// ---- §9.4 pending summary pluralization ------------------------------------

describe('pending summary pluralization (§9.4)', () => {
  test('singular', () => {
    stateData = watchState({ pendingCount: 1, proposals: [proposal({ id: 'p1' })] });
    renderPanel();
    expect(screen.getByTestId('sp-watch-panel')).toHaveTextContent('1 proposed change for your review');
  });

  test('plural', () => {
    stateData = watchState({
      pendingCount: 2,
      proposals: [proposal({ id: 'p1' }), proposal({ id: 'p2', watchKey: 'k2' })],
    });
    renderPanel();
    expect(screen.getByTestId('sp-watch-panel')).toHaveTextContent('2 proposed changes for your review');
  });
});

// ---- §9.5 372px scroller + pinned footer structure -------------------------

describe('372px card scroller and pinned footer (§9.5)', () => {
  test('the card list caps at 372px and scrolls; the footer sits after it, not inside it', () => {
    stateData = watchState({ pendingCount: 1, proposals: [proposal({ id: 'p1' })] });
    renderPanel();
    const scroller = screen.getByTestId('sp-watch-scroller');
    expect(scroller).toHaveStyle({ maxHeight: '372px', overflowY: 'auto' });
    expect(within(scroller).queryByText(/Nothing is applied until you accept/)).toBeNull();
    expect(screen.getByText(/Nothing is applied until you accept/)).toBeTruthy();
  });

  test('the footer shows Accept all with the exact pending count and the explanatory copy', () => {
    stateData = watchState({
      pendingCount: 2,
      proposals: [proposal({ id: 'p1' }), proposal({ id: 'p2', watchKey: 'k2' })],
    });
    renderPanel();
    expect(screen.getByRole('button', { name: 'Accept all 2' })).toBeTruthy();
    expect(screen.getByText(/After each accept Meri re-checks the rest against the updated plan/)).toBeTruthy();
  });
});

// ---- §9.6 card fields + badges ----------------------------------------------

describe('card fields and badges (§9.6)', () => {
  test('source + date, title, proposal body, and Accept/Dismiss/Why controls', () => {
    stateData = watchState({
      pendingCount: 1,
      proposals: [proposal({ id: 'p1', sourceLabel: 'Legislative calendar', sourceDate: '2026-07-24' })],
    });
    renderPanel();
    expect(screen.getByText(/Legislative calendar/)).toBeTruthy();
    expect(screen.getByText('Markup defense runs before the hearing it depends on')).toBeTruthy();
    expect(screen.getByText('Retime to next quarter')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Accept' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Why?' })).toBeTruthy();
  });

  test('dependency category renders the Out of order badge', () => {
    stateData = watchState({ pendingCount: 1, proposals: [proposal({ id: 'p1', badges: ['out_of_order'] })] });
    renderPanel();
    expect(screen.getByText('Out of order')).toBeTruthy();
  });

  test('an updated recheck status renders the Updated badge and the exact reassurance line', () => {
    stateData = watchState({
      pendingCount: 1,
      proposals: [proposal({ id: 'p1', badges: ['updated'], recheckStatus: 'updated' })],
    });
    renderPanel();
    expect(screen.getByText('Updated')).toBeTruthy();
    expect(
      screen.getByText('Re-checked against your last accept — still valid, timing recalculated.'),
    ).toBeTruthy();
  });

  test('a badge with no prototype treatment (critical/high_risk) renders no extra chip', () => {
    stateData = watchState({ pendingCount: 1, proposals: [proposal({ id: 'p1', badges: ['critical'] })] });
    renderPanel();
    expect(screen.queryByText('Out of order')).toBeNull();
    expect(screen.queryByText('Updated')).toBeNull();
    expect(screen.queryByText(/critical/i)).toBeNull();
  });
});

// ---- §9.7 Why expand/collapse ------------------------------------------------

describe('Why expand/collapse (§9.7)', () => {
  test('Why reveals the server why + impact + the static recheck reminder; Hide collapses it', () => {
    stateData = watchState({
      pendingCount: 1,
      proposals: [proposal({ id: 'p1', why: 'Compared against the legislative calendar.', impact: '1 step re-timed' })],
    });
    renderPanel();
    expect(screen.queryByText(/Compared against the legislative calendar/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Why?' }));
    expect(screen.getByText(/Compared against the legislative calendar/)).toBeTruthy();
    expect(screen.getByText(/1 step re-timed/)).toBeTruthy();
    expect(screen.getByText(/the remaining proposals are re-checked against the new plan/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Hide' }));
    expect(screen.queryByText(/Compared against the legislative calendar/)).toBeNull();
  });
});

// ---- §9.8 rechecking disables every action -----------------------------------

describe('rechecking disables actions (§9.8)', () => {
  test('Accept, Dismiss, Accept all, Pause, and Check now are all disabled while a recheck is in flight', () => {
    revalidatePending = true;
    stateData = watchState({ pendingCount: 1, proposals: [proposal({ id: 'p1' })] });
    renderPanel();
    expect(screen.getByRole('button', { name: 'Accept' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Accept all/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Pause for this strategy' })).toBeDisabled();
    const scroller = screen.getByTestId('sp-watch-scroller');
    expect(scroller).toHaveStyle({ opacity: '0.55' });
  });

  test('cards stay visible (non-actionable, not hidden) while rechecking', () => {
    acceptPending = true;
    stateData = watchState({ pendingCount: 1, proposals: [proposal({ id: 'p1' })] });
    renderPanel();
    expect(screen.getByText('Markup defense runs before the hearing it depends on')).toBeTruthy();
    expect(screen.getByText('Re-checking…')).toBeTruthy();
  });
});

// ---- §9.10 stale-head reconciles instead of navigating -----------------------

describe('stale-head recovery (§9.10)', () => {
  test('a 409 on accept triggers revalidate instead of an error dead-end', () => {
    stateData = watchState({ pendingCount: 1, proposals: [proposal({ id: 'p1' })] });
    acceptMutate.mockImplementation((_id, opts) => {
      opts.onError({ response: { status: 409 } });
    });
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }));
    expect(revalidateMutate).toHaveBeenCalled();
  });

  test('a 409 on accept-all also reconciles via revalidate, never a navigation', () => {
    stateData = watchState({
      pendingCount: 2,
      headVersionId: 'v9',
      proposals: [proposal({ id: 'p1' }), proposal({ id: 'p2', watchKey: 'k2' })],
    });
    acceptAllMutate.mockImplementation((_input, opts) => {
      opts.onError({ response: { status: 409 } });
    });
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Accept all 2' }));
    expect(revalidateMutate).toHaveBeenCalled();
  });
});

// ---- §9.11 dropped / deleted-target is calm, not an error --------------------

describe('dropped-proposal notice (§9.11)', () => {
  test('a deleted-target drop renders as a calm, non-red, dismissible line — never a red error', () => {
    stateData = watchState({ pendingCount: 1, proposals: [proposal({ id: 'p1' })] });
    acceptMutate.mockImplementation((_id, opts) => {
      opts.onSuccess({
        strategy: {},
        state: watchState({ pendingCount: 0, proposals: [] }),
        recheck: {
          state: 'complete',
          elapsedMs: 1,
          unchanged: [],
          updated: [],
          dropped: [{ watchKey: 'k9', reason: 'The step this was about is no longer in the plan.', targetDeleted: true }],
        },
      });
    });
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }));

    const notice = screen.getByRole('status');
    expect(notice).toHaveTextContent('The step this was about is no longer in the plan.');
    expect(notice).not.toHaveStyle({ color: 'var(--critical)' });
    expect(notice.style.background).not.toMatch(/FDECEC|FCEDE6/);
    // Phase 6 §4 (a11y): renamed from the bare "Dismiss" this shared with a
    // proposal's own Dismiss button — the two are now distinguishable by name.
    fireEvent.click(within(notice).getByRole('button', { name: 'Dismiss this notice' }));
    expect(screen.queryByRole('status')).toBeNull();
  });
});

// ---- §9.12 Accept all sends the exact visible ids + current version ---------

describe('Accept all payload (§9.12)', () => {
  test('sends the visible proposal ids in order and the current headVersionId', () => {
    stateData = watchState({
      headVersionId: 'v7',
      pendingCount: 2,
      proposals: [proposal({ id: 'p1', watchKey: 'k1' }), proposal({ id: 'p2', watchKey: 'k2' })],
    });
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Accept all 2' }));
    expect(acceptAllMutate).toHaveBeenCalledWith(
      { expectedVersionId: 'v7', proposalIds: ['p1', 'p2'] },
      expect.anything(),
    );
  });
});

// ---- §9.14 permanent dismiss removes the card --------------------------------

describe('permanent dismiss (§9.14)', () => {
  test('dismiss removes the card once the server confirms — never optimistically', () => {
    stateData = watchState({ pendingCount: 1, proposals: [proposal({ id: 'p1' })] });
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    // Not removed yet — the mock has not invoked onSuccess.
    expect(screen.getByText('Markup defense runs before the hearing it depends on')).toBeTruthy();
    expect(dismissMutate).toHaveBeenCalledWith('p1', expect.anything());
  });
});

// ---- §9.17 no strategy-scoped navigation from Watch --------------------------

describe('no strategy-scoped review navigation (§9.17)', () => {
  test('nothing in the panel links or routes to the separate review queue', () => {
    stateData = watchState({ pendingCount: 1, proposals: [proposal({ id: 'p1' })] });
    const { container } = renderPanel();
    expect(container.innerHTML).not.toMatch(/agents\/review/);
    expect(screen.queryByText(/awaiting review/i)).toBeNull();
  });
});

// ---- §9.19 vocabulary ---------------------------------------------------------

describe('vocabulary (§9.19)', () => {
  test('no visible copy or accessible name says "rail"', () => {
    stateData = watchState({ pendingCount: 1, proposals: [proposal({ id: 'p1', badges: ['out_of_order', 'updated'] })] });
    const { container } = renderPanel();
    expect(container.textContent ?? '').not.toMatch(/rail/i);
    for (const el of Array.from(container.querySelectorAll('[aria-label],[title]'))) {
      expect(`${el.getAttribute('aria-label') ?? ''} ${el.getAttribute('title') ?? ''}`).not.toMatch(/rail/i);
    }
  });
});

// ---- §9.2 chip-click focus behavior (the panel's half of the contract) ------

describe('focus/highlight from the header chip (§9.2)', () => {
  test('becoming focused scrolls into view, glows, acknowledges via onFocused, and invokes revalidation', () => {
    stateData = watchState();
    const onFocused = vi.fn();
    renderPanel({ focus: true, onFocused });
    expect(onFocused).toHaveBeenCalledTimes(1);
    expect(revalidateMutate).toHaveBeenCalled();
    expect(screen.getByTestId('sp-watch-panel')).toHaveStyle({ boxShadow: '0 0 0 4px var(--accent-glow)' });
  });
});
