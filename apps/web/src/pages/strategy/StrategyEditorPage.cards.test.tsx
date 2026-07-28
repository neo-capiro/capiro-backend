/*
 * Phase 2 §5 Step 8 — the two redundant page cards are gone.
 *
 * The blue "Meri drafted this plan" card is replaced by the panel's persistent
 * note, and the amber "Drafted on partial information" card by the `context_gap`
 * message the draft endpoint now persists into the strategy thread. The harder
 * conflicted banner deliberately stays until Phase 5 ships its repair flow —
 * pinned here so removing it early is a conscious act, not a drive-by.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { App } from 'antd';

const idle = { isLoading: false, isError: false, isSuccess: true, error: null };

const groundingHealth = {
  degraded: { status: 'degraded' as const, missingRequired: ['strategy_brief'], omittedOptional: [] },
  conflicted: {
    status: 'conflicted' as const,
    missingRequired: [],
    omittedOptional: [],
    openMaterialConflicts: [
      { id: 'c1', factAId: 'a', factBId: 'b', factA: 'Ceiling is $40M', factB: 'Ceiling is $25M' },
    ],
  },
};

let health: (typeof groundingHealth)[keyof typeof groundingHealth] | null = null;

const strategy = () => ({
  id: 'strat-1',
  clientId: 'client-1',
  title: 'FY27 plus-up',
  type: 'appropriations',
  goal: 'Secure the plus-up.',
  meriContext: null,
  meriSummary: 'A tight FY27 push.',
  // The blue card's own trigger — it must stay gone even when this is true.
  draftedByMeri: true,
  targetDate: null,
  ownerUserId: 'user-1',
  createdByUserId: 'user-1',
  lastEditedByUserId: null,
  lastEditedAt: null,
  archivedAt: null,
  createdAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-01T00:00:00.000Z',
  nodes: [],
  artifacts: [],
  groundingHealth: health,
});

vi.mock('./api.js', () => ({
  useStrategy: () => ({ ...idle, data: strategy() }),
  useReferenceCalendars: () => ({ ...idle, data: { congress: [], ppbeLanes: [], ppbeCurrentPhases: [], source: {} } }),
  useFirmPhases: () => ({ ...idle, data: [] }),
  useAddNode: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateNode: () => ({ mutate: vi.fn(), isPending: false }),
  usePlanExecution: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useMissions: () => ({ ...idle, data: [], refetch: vi.fn() }),
  useCreateMission: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUpdateMission: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useChangeSets: () => ({ ...idle, data: [] }),
}));
vi.mock('@clerk/clerk-react', () => ({ useUser: () => ({ user: { id: 'user-1' } }) }));
vi.mock('../../lib/me.js', () => ({
  useMe: () => ({ ...idle, data: { features: { strategyPlanner: true, strategyPlannerMeri: true } } }),
}));
vi.mock('../../lib/use-api.js', () => ({ useApi: () => ({ get: vi.fn(), post: vi.fn() }) }));
vi.mock('./clients-lite.js', () => ({
  useClientsLite: () => ({ ...idle, data: [{ id: 'client-1', name: 'Brightdefense' }] }),
  clientColor: () => '#2A57CE',
}));
vi.mock('./members.js', () => ({
  useTenantMembers: () => ({ ...idle, data: [] }),
  memberName: () => 'Neo Martinez',
  initialsOf: () => 'NM',
}));
vi.mock('./StrategyTimeline.js', () => ({ StrategyTimeline: () => <div>timeline</div> }));
vi.mock('./NodeRail.js', () => ({ StrategyMeriPanel: () => <div>panel</div> }));
vi.mock('./HistoryModal.js', () => ({ HistoryModal: () => null }));
vi.mock('./FirmConfig.js', () => ({ FirmConfig: () => null }));
vi.mock('./RefCalendarConfig.js', () => ({ RefCalendarConfig: () => null }));
vi.mock('./ExportView.js', () => ({ ExportView: () => null }));

import { StrategyEditorPage } from './StrategyEditorPage.js';

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/strategies/strat-1']}>
      <App>
        <div className="sp-root">
          <Routes>
            <Route path="/strategies/:id" element={<StrategyEditorPage />} />
          </Routes>
        </div>
      </App>
    </MemoryRouter>,
  );
}

describe('the removed page cards', () => {
  test('the blue drafted-plan card no longer renders for a Meri-drafted plan', () => {
    health = null;
    renderPage();
    expect(screen.queryByText(/Meri drafted this plan from your goal/i)).toBeNull();
    expect(screen.queryByText(/ask Meri to change anything from the rail/i)).toBeNull();
  });

  test('the amber partial-information card no longer renders on degraded grounding', () => {
    health = groundingHealth.degraded;
    renderPage();
    expect(screen.queryByText(/Drafted on partial information/i)).toBeNull();
    // ...and with it goes the leak of the Steward's internal template key.
    expect(document.body.textContent ?? '').not.toContain('strategy_brief');
  });

  test('the conflicted banner still renders (Phase 5 owns its replacement)', () => {
    health = groundingHealth.conflicted;
    renderPage();
    expect(screen.getByText(/Drafted with unresolved context conflicts/i)).toBeTruthy();
  });
});
