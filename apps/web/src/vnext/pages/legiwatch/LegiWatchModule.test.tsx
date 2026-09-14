import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@clerk/clerk-react', () => ({
  useAuth: () => ({ isLoaded: true, orgId: 'org-test', userId: 'user-test' }),
}));
import { LegiWatchModule } from './LegiWatchModule.js';

/**
 * v2 prototype restyle — the Hearings landing against the current main tip.
 * The Schedule sub-view runs the calendar the full content width (the old
 * two-column My Sessions rail is gone from Schedule), the sub-views are the
 * segmented Schedule/My Sessions/Archive control with the public/private
 * legend chip, and the header set is the uniform 42px family with the shaded
 * Client lens dropdown. Pins the structure so a regression can't silently
 * restore the rail or drop a control.
 */

const getMock = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/use-api.js', () => ({
  useApi: () => ({ get: getMock }),
}));

function apiShape(url: string): unknown {
  if (url === '/api/clients') return [{ id: 'c1', name: 'Overland AI', status: 'active' }];
  if (url === '/intel-api/feature-flags') return { hearing_watch: true, tracker_v2: true };
  // Canonical week calendar (PR A path).
  if (url.includes('/api/legiwatch/live-hearings/calendar')) return { items: [], total: 0 };
  if (url.includes('/intel-api/clients/')) return { items: [], total: 0, page: 1, pages: 1 };
  if (url.includes('/intel-api/tracker/watchlists/')) return { topics: [{ id: 't1' }] };
  return { items: [], total: 0, page: 1, pages: 1 };
}

function LocationProbe() {
  return <output aria-label="Current navigation">{useLocation().search}</output>;
}

function mount(entry = '/legiwatch?tab=hearings') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[entry]}>
        <LegiWatchModule />
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('LegiWatchModule — Hearings landing (v2 restyle)', () => {
  beforeEach(() => {
    getMock.mockReset();
    getMock.mockImplementation(async (url: string) => ({ data: apiShape(url) }));
  });

  it('renders the uniform header control set with the shaded Client lens', async () => {
    mount();
    await waitFor(() => expect(screen.getByRole('button', { name: /saved views/i })).toBeTruthy());
    expect(screen.getByRole('button', { name: /create watch/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /legiwatch settings/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /search legiwatch/i })).toBeTruthy();
    // Client lens is the shaded dropdown (not a native <select>).
    expect(screen.getByRole('button', { name: /client lens/i })).toBeTruthy();
  });

  it('renders the Schedule/My Sessions/Archive sub-tabs and the legend chip', async () => {
    mount();
    await waitFor(() => expect(screen.getByRole('tab', { name: /^schedule$/i })).toBeTruthy());
    expect(screen.getByRole('tab', { name: /my sessions/i })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /archive/i })).toBeTruthy();
    expect(screen.getByText(/public record/i)).toBeTruthy();
    expect(screen.getByText(/your analysis/i)).toBeTruthy();
  });

  it("keeps client and folder scope while removing another tab's legacy search", async () => {
    mount(
      '/legiwatch?tab=hearings&client=c1&folder=f1&q=Rubin&offset=25&budgetProjectsQuery=housing',
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Budget' }));
    const params = new URLSearchParams(
      screen.getByLabelText('Current navigation').textContent ?? '',
    );
    expect(params.get('tab')).toBe('budget');
    expect(params.get('client')).toBe('c1');
    expect(params.get('folder')).toBe('f1');
    expect(params.get('budgetProjectsQuery')).toBe('housing');
    expect(params.has('q')).toBe(false);
    expect(params.has('offset')).toBe(false);
  });

  it('returns scoped result lists to their first page when the client changes', async () => {
    mount(
      '/legiwatch?tab=news&folder=old-folder&newsArticlesQuery=Clarity&newsArticlesOffset=50&budgetProjectsOffset=25&researchCursor=old-cursor',
    );
    await waitFor(() => expect(getMock).toHaveBeenCalledWith('/api/clients'));
    fireEvent.click(screen.getByRole('button', { name: /Client lens/ }));
    fireEvent.click(await screen.findByRole('option', { name: /Overland AI/ }));
    const params = new URLSearchParams(
      screen.getByLabelText('Current navigation').textContent ?? '',
    );
    expect(params.get('client')).toBe('c1');
    expect(params.has('folder')).toBe(false);
    expect(params.has('researchCursor')).toBe(false);
    expect(params.get('newsArticlesQuery')).toBe('Clarity');
    expect(params.has('newsArticlesOffset')).toBe(false);
    expect(params.has('budgetProjectsOffset')).toBe(false);
  });
});
