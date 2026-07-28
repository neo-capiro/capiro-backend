/*
 * Phase 1 §4.6 — the strategy landing header keeps ONLY "New strategy".
 *
 * The Review / Execution / Context buttons are retired from this header (Watch
 * review moves into the editor panel). The tenant here has agenticMeri ON, which
 * is exactly the condition under which the old header rendered all three — so
 * their absence is a real assertion, not a vacuous one.
 *
 * The ROUTES behind them stay registered; that is pinned by
 * StrategyRoutes.registration.test.tsx.
 */
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { App } from 'antd';

const idle = { isLoading: false, isError: false, isSuccess: true, error: null };

const useChangeSetsSpy = vi.fn();
const useExecutionRunsSpy = vi.fn();

vi.mock('./api.js', () => ({
  useStrategies: () => ({ ...idle, data: [] }),
  useFirmPhases: () => ({ ...idle, data: [] }),
  // If the page still imported these, calling them would register here.
  useChangeSets: (...args: unknown[]) => {
    useChangeSetsSpy(...args);
    return { ...idle, data: [] };
  },
  useExecutionRuns: (...args: unknown[]) => {
    useExecutionRunsSpy(...args);
    return { ...idle, data: [] };
  },
  usePendingWatchCounts: () => ({ ...idle, data: {} }),
}));

vi.mock('../../lib/me.js', () => ({
  useMe: () => ({
    ...idle,
    data: {
      features: { strategyPlanner: true, strategyPlannerMeri: true, agenticMeri: true },
    },
  }),
}));

vi.mock('./clients-lite.js', () => ({
  useClientsLite: () => ({ ...idle, data: [] }),
  clientColor: () => '#2A57CE',
}));

vi.mock('./members.js', () => ({
  useTenantMembers: () => ({ ...idle, data: [] }),
  memberName: () => 'Neo Martinez',
  initialsOf: () => 'NM',
}));

// Stubbed so their transitive imports never load — neither is open here.
vi.mock('./GoalModal.js', () => ({ GoalModal: () => null }));
vi.mock('./FirmConfig.js', () => ({ FirmConfig: () => null }));

import { StrategyLibraryPage } from './StrategyLibraryPage.js';

beforeEach(() => {
  vi.clearAllMocks();
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

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/strategies']}>
      <App>
        <StrategyLibraryPage />
      </App>
    </MemoryRouter>,
  );
}

describe('strategy landing header', () => {
  test('has no Review, Execution or Context button', () => {
    renderPage();
    expect(screen.queryByRole('button', { name: /^review/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^execution/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^context/i })).toBeNull();
  });

  test('keeps the New strategy button', () => {
    renderPage();
    expect(screen.getByRole('button', { name: /new strategy/i })).toBeInTheDocument();
  });

  test('no longer fetches change-sets or execution runs for retired badges', () => {
    renderPage();
    expect(useChangeSetsSpy).not.toHaveBeenCalled();
    expect(useExecutionRunsSpy).not.toHaveBeenCalled();
  });

  test('still renders the page itself (heading + firm-phase setup)', () => {
    renderPage();
    expect(screen.getByRole('heading', { name: 'Strategies' })).toBeInTheDocument();
  });
});
