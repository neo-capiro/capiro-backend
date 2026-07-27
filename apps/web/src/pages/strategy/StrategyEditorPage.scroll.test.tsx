/*
 * Phase 1 §4.11 — opening a strategy starts at the top of the plan.
 *
 * The distinction that matters: a STRATEGY change resets the editor's vertical
 * scroll, but selecting a node (which re-renders this page and opens the panel)
 * must not — otherwise clicking a step halfway down the timeline would yank the
 * view back to the top.
 *
 * Also pinned here: the editor owns VERTICAL scroll only. Horizontal belongs to
 * the timeline's grid scroller, so this container is overflowX:hidden — that is
 * what keeps the document itself from growing a horizontal scrollbar.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { App } from 'antd';

const idle = { isLoading: false, isError: false, isSuccess: true, error: null };

const strategyFor = (id: string) => ({
  id,
  clientId: 'client-1',
  title: `Strategy ${id}`,
  type: 'appropriations',
  goal: 'Secure the plus-up.',
  meriContext: null,
  meriSummary: null,
  draftedByMeri: false,
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
});

vi.mock('./api.js', () => ({
  useStrategy: (id: string | null) => ({ ...idle, data: strategyFor(id ?? 'none') }),
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
  useMe: () => ({
    ...idle,
    data: {
      features: {
        strategyPlanner: true,
        strategyPlannerMeri: true,
        agenticMeri: true,
        strategyWatcher: true,
      },
    },
  }),
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

// Heavy children stubbed. The timeline stub exposes a node-selection trigger so
// the "selecting a node must not reset scroll" case is exercised for real.
vi.mock('./StrategyTimeline.js', () => ({
  StrategyTimeline: ({ onSelectNode }: { onSelectNode: (id: string) => void }) => (
    <button onClick={() => onSelectNode('node-1')}>select-node</button>
  ),
}));
vi.mock('./NodeRail.js', () => ({ EditorRail: () => <div>panel</div> }));
vi.mock('./HistoryModal.js', () => ({ HistoryModal: () => null }));
vi.mock('./FirmConfig.js', () => ({ FirmConfig: () => null }));
vi.mock('./RefCalendarConfig.js', () => ({ RefCalendarConfig: () => null }));
vi.mock('./ExportView.js', () => ({ ExportView: () => null }));

import { StrategyEditorPage } from './StrategyEditorPage.js';

function NavHelper() {
  const navigate = useNavigate();
  return <button onClick={() => navigate('/strategies/strat-b')}>go-to-b</button>;
}

beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

function renderEditor() {
  const utils = render(
    <MemoryRouter initialEntries={['/strategies/strat-a']}>
      <App>
        <NavHelper />
        <Routes>
          <Route path="/strategies/:id" element={<StrategyEditorPage />} />
        </Routes>
      </App>
    </MemoryRouter>,
  );
  const scroller = document.querySelector('[data-sp-scroll]') as HTMLElement;
  expect(scroller).not.toBeNull();
  return { ...utils, scroller };
}

describe('editor vertical scroll', () => {
  test('owns vertical scroll only — horizontal is the grid viewport’s', () => {
    const { scroller } = renderEditor();
    expect(scroller.style.overflowY).toBe('auto');
    expect(scroller.style.overflowX).toBe('hidden');
    expect(scroller.style.minWidth).toBe('0px');
    expect(scroller.style.minHeight).toBe('0px');
  });

  test('changing the strategy id resets scrollTop to 0', () => {
    const { scroller } = renderEditor();
    scroller.scrollTop = 640;
    expect(scroller.scrollTop).toBe(640);

    fireEvent.click(screen.getByRole('button', { name: 'go-to-b' }));

    // same mounted component, new :id ⇒ the reset effect runs
    const after = document.querySelector('[data-sp-scroll]') as HTMLElement;
    expect(after.scrollTop).toBe(0);
    expect(screen.getByTestId('sp-header-title')).toHaveTextContent('Strategy strat-b');
  });

  test('selecting a node opens the panel WITHOUT resetting scrollTop', () => {
    const { scroller } = renderEditor();
    scroller.scrollTop = 640;

    fireEvent.click(screen.getByRole('button', { name: 'select-node' }));

    expect(screen.getByText('panel')).toBeInTheDocument();
    expect((document.querySelector('[data-sp-scroll]') as HTMLElement).scrollTop).toBe(640);
  });

  test('the header renders the goal from the loaded strategy', () => {
    renderEditor();
    expect(screen.getByTestId('sp-header-goal')).toHaveAttribute('title', 'Secure the plus-up.');
  });
});
