/*
 * Phase 4 §9.15 — the strategy-library weekly nudge, matched to the
 * prototype's exact pill (accent-soft chip, accent border, 6px dot, "N
 * proposed change(s) to review"), driven by the aggregate pending-counts
 * endpoint (one query, not one per row — pinned by api.ts itself; this file
 * only pins the row's rendering contract).
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { App } from 'antd';
import type { StrategyListItem } from './types.js';

const idle = { isLoading: false, isError: false, isSuccess: true, error: null };

const strategies: StrategyListItem[] = [
  {
    id: 's1',
    clientId: 'c1',
    title: 'FY27 authorization plan',
    type: 'authorization',
    ownerUserId: 'u1',
    createdByUserId: 'u1',
    lastEditedByUserId: null,
    lastEditedAt: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    nodeCount: 4,
  },
  {
    id: 's2',
    clientId: 'c1',
    title: 'Coalition outreach plan',
    type: 'coalition',
    ownerUserId: 'u1',
    createdByUserId: 'u1',
    lastEditedByUserId: null,
    lastEditedAt: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    nodeCount: 2,
  },
];

let pendingCounts: Record<string, number> = {};

vi.mock('./api.js', () => ({
  useStrategies: () => ({ ...idle, data: strategies }),
  useFirmPhases: () => ({ ...idle, data: [{ id: 'f1' }] }),
  usePendingWatchCounts: () => ({ ...idle, data: pendingCounts }),
}));

vi.mock('../../lib/me.js', () => ({
  useMe: () => ({
    ...idle,
    data: { features: { strategyPlanner: true, strategyPlannerMeri: true, agenticMeri: true, strategyWatcher: true } },
  }),
}));

vi.mock('./clients-lite.js', () => ({
  useClientsLite: () => ({ ...idle, data: [{ id: 'c1', name: 'Brightdefense' }] }),
  clientColor: () => '#2A57CE',
}));

vi.mock('./members.js', () => ({
  useTenantMembers: () => ({ ...idle, data: [] }),
  memberName: () => 'Neo Martinez',
  initialsOf: () => 'NM',
}));

vi.mock('./GoalModal.js', () => ({ GoalModal: () => null }));
vi.mock('./FirmConfig.js', () => ({ FirmConfig: () => null }));

import { StrategyLibraryPage } from './StrategyLibraryPage.js';

function renderPage() {
  return render(
    <MemoryRouter>
      <App>
        <div className="sp-root">
          <StrategyLibraryPage />
        </div>
      </App>
    </MemoryRouter>,
  );
}

describe('strategy library weekly nudge (§9.15)', () => {
  test('a strategy with open Watch proposals shows the exact prototype copy, singular', () => {
    pendingCounts = { s1: 1 };
    renderPage();
    const nudges = screen.getAllByTestId('sp-library-watch-nudge');
    expect(nudges).toHaveLength(1);
    expect(nudges[0]).toHaveTextContent('1 proposed change to review');
  });

  test('pluralizes for more than one', () => {
    pendingCounts = { s1: 5 };
    renderPage();
    expect(screen.getByTestId('sp-library-watch-nudge')).toHaveTextContent('5 proposed changes to review');
  });

  test('a strategy with nothing pending shows no nudge at all', () => {
    pendingCounts = { s1: 0 };
    renderPage();
    expect(screen.queryByTestId('sp-library-watch-nudge')).toBeNull();
  });

  test('each row nudges independently off the same aggregate map', () => {
    pendingCounts = { s1: 2, s2: 1 };
    renderPage();
    expect(screen.getAllByTestId('sp-library-watch-nudge')).toHaveLength(2);
    expect(screen.getByText('2 proposed changes to review')).toBeTruthy();
    expect(screen.getByText('1 proposed change to review')).toBeTruthy();
  });

  test('clicking the row still opens the strategy (the nudge is not a separate control)', () => {
    pendingCounts = { s1: 1 };
    renderPage();
    // The nudge itself renders no button/link — the whole row is the click target.
    expect(screen.getByTestId('sp-library-watch-nudge').closest('button, a')).toBeNull();
  });
});
