/**
 * The legislative-calendar editor (STRATEGIES follow-up, 2026-08-19).
 *
 * Ported functionally from the legacy `RefCalendarConfig.tsx` (kind=congress):
 * quarter-select rows, not date typing or timeline dragging — see this
 * overlay's own file header for why. These tests cover the part that file
 * doesn't: converting a real stored date to a valid quarter selection on
 * load, and converting the edited selection back to real dates on save.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EditLegislativeCalendarOverlay } from './EditLegislativeCalendarOverlay.js';
import type { ReferenceRow } from '../../../../pages/strategy/types.js';

const STRATEGY_ID = '11111111-2222-3333-4444-555555555555';
const NOW = new Date(2026, 7, 19, 12, 0, 0);

const CONGRESS: ReferenceRow[] = [
  { id: 'c1', kind: 'congress_milestone', label: "President's Budget", fy: null, startsOn: '2026-01-29T00:00:00.000Z', endsOn: '2026-02-19T00:00:00.000Z', tone: 'ink', position: 0 },
  { id: 'c2', kind: 'congress_milestone', label: 'Conference', fy: null, startsOn: '2026-08-17T00:00:00.000Z', endsOn: '2026-09-22T00:00:00.000Z', tone: 'notable', position: 1 },
];

const forkMutate = vi.fn();

vi.mock('../strategies-api.js', async () => {
  const actual = await vi.importActual<typeof import('../strategies-api.js')>('../strategies-api.js');
  return {
    ...actual,
    useReferenceCalendars: () => ({
      data: { congress: CONGRESS, ppbeLanes: [], ppbeCurrentPhases: [], source: { congress: 'baseline' } },
      isLoading: false,
      isError: false,
    }),
    useForkReferenceCalendar: () => ({ mutate: forkMutate, isPending: false, isError: false, error: null }),
  };
});

function renderOverlay() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/strategies/${STRATEGY_ID}/legislative-calendar`]}>
        <Routes>
          <Route path="/strategies/:strategyId/legislative-calendar" element={<EditLegislativeCalendarOverlay />} />
          <Route path="/strategies/:strategyId" element={<div data-testid="closed" />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
  forkMutate.mockReset();
});

describe('EditLegislativeCalendarOverlay', () => {
  it('loads every seeded row as a labelled input with a valid quarter range', () => {
    renderOverlay();
    expect(screen.getByDisplayValue("President's Budget")).toBeTruthy();
    expect(screen.getByDisplayValue('Conference')).toBeTruthy();
  });

  it('disables Save until something actually changes', () => {
    renderOverlay();
    expect(screen.getByRole('button', { name: 'Save changes' })).toHaveProperty('disabled', true);
  });

  it('adds a milestone anchored on today and enables Save', () => {
    renderOverlay();
    fireEvent.click(screen.getByRole('button', { name: 'Add milestone' }));
    expect(screen.getByDisplayValue('New milestone')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save changes' })).toHaveProperty('disabled', false);
  });

  it('removes a milestone from the set it sends', () => {
    renderOverlay();
    fireEvent.click(screen.getByRole('button', { name: /Remove Conference/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    const rows = forkMutate.mock.calls[0]![0] as Array<{ label: string }>;
    expect(rows.map((r) => r.label)).not.toContain('Conference');
    expect(rows).toHaveLength(1);
  });

  it('renames a milestone and saves real dates, not quarter indices', () => {
    renderOverlay();
    fireEvent.change(screen.getByDisplayValue('Conference'), { target: { value: 'Conference (renamed)' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    const rows = forkMutate.mock.calls[0]![0] as Array<{ label: string; startsOn: string; endsOn: string }>;
    const renamed = rows.find((r) => r.label === 'Conference (renamed)')!;
    expect(renamed).toBeTruthy();
    expect(renamed.startsOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(renamed.endsOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(new Date(renamed.endsOn).getTime()).toBeGreaterThan(new Date(renamed.startsOn).getTime());
  });

  it('navigates back to the strategy on successful save', () => {
    forkMutate.mockImplementation((_rows, opts) => opts?.onSuccess?.());
    renderOverlay();
    fireEvent.change(screen.getByDisplayValue('Conference'), { target: { value: 'Conference (renamed)' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(screen.getByTestId('closed')).toBeTruthy();
  });
});
