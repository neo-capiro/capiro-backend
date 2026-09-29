import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
 * two-column sessions rail is gone from Schedule), the sub-views are the
 * segmented Schedule/Recordings/Past hearings control with the public/private
 * legend chip, and the header set is the uniform 42px family with the shaded
 * Client dropdown. Pins the structure so a regression can't silently
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

  it('defaults bare /legiwatch to Updates', async () => {
    mount('/legiwatch');
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Updates' })).toBeTruthy());
    expect(screen.getByRole('tab', { name: /Updates/ })).toHaveAttribute('aria-selected', 'true');
  });

  const strip = () => within(screen.getByRole('tablist', { name: 'Primary sections' }));

  it('renders Committees as a primary tab and selects it on tab=committees', async () => {
    mount('/legiwatch?tab=committees');
    await waitFor(() =>
      expect(strip().getByRole('tab', { name: 'Committees' })).toHaveAttribute('aria-selected', 'true'),
    );
    const names = strip().getAllByRole('tab').map((t) => t.textContent ?? '');
    expect(names).toHaveLength(5);
    expect(names[3]).toBe('Committees');
    expect(screen.getByRole('combobox', { name: 'LegiWatch section' })).toHaveValue('committees');
  });

  it('keeps Research and News out of both tab strips', async () => {
    const { container } = mount('/legiwatch');
    await waitFor(() => expect(strip().getByRole('tab', { name: /Updates/ })).toBeTruthy());
    expect(strip().queryByRole('tab', { name: 'Research' })).toBeNull();
    expect(strip().queryByRole('tab', { name: 'News' })).toBeNull();
    expect(
      Array.from(container.querySelectorAll('.lw-tab--secondary')).map((b) => b.textContent),
    ).toEqual(['Florida Budget', 'Trends / Analytics']);
  });

  it('marks the secondary Florida Budget button active on tab=budget with no primary selected', async () => {
    mount('/legiwatch?tab=budget');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Florida Budget' })).toHaveClass('is-active'),
    );
    expect(strip().queryAllByRole('tab', { selected: true })).toHaveLength(0);
    expect(screen.getByRole('combobox', { name: 'More LegiWatch sections' })).toHaveValue('budget');
    expect(screen.getByRole('combobox', { name: 'LegiWatch section' })).toHaveValue('');
  });

  it('renders a tab=research deep link with ResearchTab and an extra active Research tab', async () => {
    mount('/legiwatch?tab=research');
    await waitFor(() =>
      expect(strip().getByRole('tab', { name: 'Research' })).toHaveAttribute('aria-selected', 'true'),
    );
    expect(strip().getAllByRole('tab')).toHaveLength(6);
    expect(await screen.findByRole('heading', { name: 'Research setup' })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'LegiWatch section' })).toHaveValue('research');
  });

  it('renders a tab=news deep link with its content and an extra active News tab', async () => {
    mount('/legiwatch?tab=news');
    await waitFor(() =>
      expect(strip().getByRole('tab', { name: 'News' })).toHaveAttribute('aria-selected', 'true'),
    );
    expect(await screen.findByText(/News monitoring is not enabled/)).toBeTruthy();
  });

  it('marks Updates selected for analytics without changing the analytics route', async () => {
    mount('/legiwatch?tab=analytics');
    await waitFor(() => expect(screen.getByRole('tab', { name: /Updates/ })).toHaveAttribute('aria-selected', 'true'));
    expect(screen.getByRole('button', { name: 'Trends / Analytics' })).toHaveClass('is-active');
  });

  it('provides compact labelled mobile selectors without changing route identities', async () => {
    mount('/legiwatch?tab=hearings');
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'LegiWatch section' })).toBeTruthy());

    expect(screen.getByRole('combobox', { name: 'LegiWatch section' })).toHaveValue('hearings');
    expect(screen.getByRole('combobox', { name: 'More LegiWatch sections' })).toHaveValue('');

    fireEvent.change(screen.getByRole('combobox', { name: 'More LegiWatch sections' }), { target: { value: 'analytics' } });
    expect(screen.getByRole('combobox', { name: 'More LegiWatch sections' })).toHaveValue('analytics');
    expect(screen.getByLabelText('Current navigation')).toHaveTextContent('tab=analytics');

    fireEvent.change(screen.getByRole('combobox', { name: 'LegiWatch section' }), { target: { value: 'bills' } });
    expect(screen.getByLabelText('Current navigation')).toHaveTextContent('tab=bills');
  });

  it('renders the uniform header control set with the shaded Client', async () => {
    mount();
    await waitFor(() => expect(screen.getByRole('button', { name: /search all legiwatch/i })).toBeTruthy());
    expect(screen.queryByRole('button', { name: /saved views/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /create watch/i })).toBeNull();
    expect(screen.getByRole('button', { name: /legiwatch settings/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /search all legiwatch/i })).toBeTruthy();
    // Client control is the shaded dropdown (not a native <select>).
    expect(screen.getByRole('button', { name: /client/i })).toBeTruthy();
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    expect(await screen.findByRole('dialog', { name: 'Search LegiWatch' })).toBeTruthy();
  });

  it('renders the Schedule/Recordings/Past hearings sub-tabs and the legend chip', async () => {
    mount();
    await waitFor(() => expect(screen.getByRole('tab', { name: /^schedule$/i })).toBeTruthy());
    expect(screen.getByRole('tab', { name: /recordings/i })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /past hearings/i })).toBeTruthy();
    expect(screen.getByText(/public record/i)).toBeTruthy();
    expect(screen.getByText(/your analysis/i)).toBeTruthy();
  });

  it("keeps client and folder scope while removing another tab's legacy search", async () => {
    mount(
      '/legiwatch?tab=hearings&client=c1&folder=f1&q=Rubin&offset=25&budgetProjectsQuery=housing',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Florida Budget' }));
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
    fireEvent.click(screen.getByRole('button', { name: /^Client/ }));
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
