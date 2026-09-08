import { StrictMode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { setGlobalClientFilter, useClientFilter } from '../../../state/client-filter.js';
import { VNextEngagementRoutes } from './VNextEngagementRoutes.js';

const getMock = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/use-api.js', () => ({ useApi: () => ({ get: getMock }) }));
vi.mock('./VNextOutreachClassic.js', () => ({ VNextOutreachClassic: () => null }));
vi.mock('./VNextReportsTracker.js', () => ({ VNextReportsTracker: () => null }));
vi.mock('./VNextMeetingsWorkspace.js', () => ({
  VNextMeetingsWorkspace: ({ clientId }: { clientId: string | null }) => <div data-testid="meetings-scope">{clientId ?? 'all'}</div>,
}));

function NavigationHarness() {
  const location = useLocation();
  const navigate = useNavigate();
  const { selectedClientId } = useClientFilter();
  return <>
    <output data-testid="location">{location.pathname}{location.search}</output>
    <output data-testid="global-scope">{selectedClientId ?? 'all'}</output>
    <button onClick={() => navigate('/engagement/meeting-library')}>Open Library</button>
    <button onClick={() => navigate('/engagement/meeting-library?client=c-overland&type=notes&page=3')}>Open saved Library link</button>
    <button onClick={() => navigate(-1)}>Browser Back</button>
    <button onClick={() => navigate(1)}>Browser Forward</button>
  </>;
}

function renderRoutes(entry = '/engagement/meeting-library') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(<StrictMode><QueryClientProvider client={queryClient}>
    <MemoryRouter initialEntries={[entry]}>
      <VNextEngagementRoutes />
      <NavigationHarness />
    </MemoryRouter>
  </QueryClientProvider></StrictMode>);
}

function libraryRequests() {
  return getMock.mock.calls.filter(([url]) => url === '/api/engagement/meetings/library')
    .map(([, options]) => options.params as Record<string, unknown>);
}

function locationParams() {
  return new URLSearchParams((screen.getByTestId('location').textContent ?? '').split('?')[1]);
}

async function expectScope(clientId: string | null, name: string) {
  await waitFor(() => {
    expect(screen.getByRole('combobox')).toHaveValue(clientId ?? '');
    expect(screen.getByRole('button', { name: 'Filter by client' })).toHaveTextContent(name);
    expect(screen.getByTestId('global-scope')).toHaveTextContent(clientId ?? 'all');
    expect(locationParams().get('client')).toBe(clientId ?? '');
    expect(screen.getByText(`Materials for ${clientId ?? 'all'}`)).toBeInTheDocument();
  });
}

describe('Meeting Library shares the global client scope', () => {
  beforeEach(() => {
    setGlobalClientFilter(null);
    getMock.mockReset();
    getMock.mockImplementation(async (url: string, options?: { params: Record<string, unknown> }) => {
      if (url === '/api/clients') return { data: [
        { id: 'c-acme', name: 'Acme Corp', status: 'active' },
        { id: 'c-overland', name: 'Overland AI', status: 'active' },
        { id: 'c-archived', name: 'Previous Client', status: 'archived' },
      ] };
      if (url === '/api/engagement/meetings/library') {
        const scope = options?.params.clientId ?? 'all';
        return { data: { data: [{
          id: `meeting-${scope}`, subject: `Materials for ${scope}`, startsAt: '2026-09-08T14:00:00Z',
          visibility: 'private', preps: [], debriefs: [], notesApproved: true,
          client: null,
        }], total: 75, page: options?.params.page, limit: 25 } };
      }
      throw new Error(`Unexpected GET ${url}`);
    });
  });
  afterEach(() => { cleanup(); setGlobalClientFilter(null); });

  test('bare Library entry inherits the selected client before any library request', async () => {
    setGlobalClientFilter('c-acme');
    renderRoutes('/engagement/meetings');
    fireEvent.click(screen.getByRole('button', { name: 'Open Library' }));
    await expectScope('c-acme', 'Acme Corp');
    expect(libraryRequests().length).toBeGreaterThan(0);
    expect(libraryRequests().every((request) => request.clientId === 'c-acme')).toBe(true);
  });

  test.each([
    ['c-archived', 'Previous Client'],
    ['c-missing', 'Selected client'],
  ])('a saved scope for %s never displays All clients', async (clientId, label) => {
    renderRoutes(`/engagement/meeting-library?client=${clientId}`);
    await expectScope(clientId, label);
    expect(libraryRequests().every((request) => request.clientId === clientId)).toBe(true);
  });

  test('header selection updates rows and Library control, preserves filters, and resets page', async () => {
    renderRoutes('/engagement/meeting-library?client=c-acme&type=notes&vis=shared&q=budget&page=3');
    await expectScope('c-acme', 'Acme Corp');
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'c-overland' } });
    await expectScope('c-overland', 'Overland AI');
    expect(locationParams().get('type')).toBe('notes');
    expect(locationParams().get('vis')).toBe('shared');
    expect(locationParams().get('q')).toBe('budget');
    expect(locationParams().has('page')).toBe(false);
    expect(libraryRequests().at(-1)).toMatchObject({ clientId: 'c-overland', page: 1, artifactType: 'notes', search: 'budget' });
  });

  test('Library selector updates the global header and keeps that scope on Meetings', async () => {
    renderRoutes('/engagement/meeting-library?client=c-acme&page=3');
    await expectScope('c-acme', 'Acme Corp');
    fireEvent.click(screen.getByRole('button', { name: 'Filter by client' }));
    fireEvent.click(screen.getByRole('button', { name: 'Overland AI' }));
    await expectScope('c-overland', 'Overland AI');
    expect(locationParams().has('page')).toBe(false);
    fireEvent.click(screen.getAllByRole('button', { name: 'Meetings' })[0]!);
    expect(screen.getByTestId('meetings-scope')).toHaveTextContent('c-overland');
  });

  test('an explicit deep link overrides a prior scope immediately and survives reload', async () => {
    setGlobalClientFilter('c-acme');
    const initial = renderRoutes('/engagement/meeting-library?client=c-overland&type=notes&page=3');
    await expectScope('c-overland', 'Overland AI');
    expect(libraryRequests().every((request) => request.clientId === 'c-overland' && request.page === 3)).toBe(true);
    const url = screen.getByTestId('location').textContent!;
    initial.unmount();
    setGlobalClientFilter(null);
    renderRoutes(url);
    await expectScope('c-overland', 'Overland AI');
    expect(locationParams().get('page')).toBe('3');
  });

  test('All clients is explicit and survives Back and Forward despite another active scope', async () => {
    renderRoutes('/engagement/meeting-library?client=c-acme');
    await expectScope('c-acme', 'Acme Corp');
    fireEvent.click(screen.getByRole('button', { name: 'Filter by client' }));
    fireEvent.click(screen.getByRole('button', { name: 'All clients' }));
    await expectScope(null, 'All clients');
    expect(libraryRequests().at(-1)).not.toHaveProperty('clientId');
    fireEvent.click(screen.getByRole('button', { name: 'Open saved Library link' }));
    await expectScope('c-overland', 'Overland AI');
    fireEvent.click(screen.getByRole('button', { name: 'Browser Back' }));
    await expectScope(null, 'All clients');
    fireEvent.click(screen.getByRole('button', { name: 'Browser Forward' }));
    await expectScope('c-overland', 'Overland AI');
    expect(locationParams().get('page')).toBe('3');
  });

  test('a shared shell filter change updates Library without being reverted by its existing URL', async () => {
    renderRoutes('/engagement/meeting-library?client=c-acme&page=3&vis=private');
    await expectScope('c-acme', 'Acme Corp');
    act(() => setGlobalClientFilter('c-overland'));
    await expectScope('c-overland', 'Overland AI');
    expect(locationParams().has('page')).toBe(false);
    expect(locationParams().get('vis')).toBe('private');
    act(() => setGlobalClientFilter(null));
    await expectScope(null, 'All clients');
  });
});
