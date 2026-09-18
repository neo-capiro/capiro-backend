import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, beforeEach, test, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { FundingOpportunitiesPage } from './FundingOpportunitiesPage.js';
import {
  fundingOpportunitiesV2DefaultRoute,
  createReferenceFixtureApi,
  referenceFixtureMapping,
  type FixtureApi,
} from '../../testing/visual/funding-opportunities-v2-fixture-api.js';
import { opportunityQueryKeys } from './opportunity-query-cache.js';
import { FUNDING_CLIENT_PICKER_EVENT } from './funding-client-picker-seam.js';
import { referenceOpportunityRows } from '../../testing/visual/funding-opportunities-v2-reference-data.js';

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  feature: { enabled: true, ready: true },
}));

vi.mock('../../../lib/use-api.js', () => ({ useApi: () => mocks.api() }));
vi.mock('../../../lib/intel-feature-flags.js', () => ({ useIntelFeature: () => mocks.feature }));
vi.mock('../../../lib/me.js', () => ({
  useMe: () => ({
    data: {
      user: { id: '11111111-1111-4111-8111-111111111111' },
      role: 'user_admin',
      tenant: { slug: 'capiro-internal' },
    },
  }),
}));
vi.mock('../../components/feedback/toast.js', () => ({
  useCapiroToast: () => ({ success: mocks.success, error: mocks.error }),
}));

function LocationProbe() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <output data-testid="location">
        {location.pathname}
        {location.search}
      </output>
      <button onClick={() => navigate(-1)}>History back</button>
      <button onClick={() => navigate(1)}>History forward</button>
    </>
  );
}

function mount(
  initialEntry = fundingOpportunitiesV2DefaultRoute,
  api = createReferenceFixtureApi(),
) {
  mocks.api.mockReturnValue(api);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route
            path="/intelligence/opportunities"
            element={
              <>
                <FundingOpportunitiesPage />
                <LocationProbe />
              </>
            }
          />
          <Route
            path="/intelligence/opportunities/:source/:sourceRecordId"
            element={
              <>
                <FundingOpportunitiesPage />
                <LocationProbe />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.feature.enabled = true;
  mocks.feature.ready = true;
  window.history.scrollRestoration = 'manual';
});

describe('mounted Funding Opportunities v2 integration', () => {
  test('queryless route requests the all-opportunities catalog contract', async () => {
    const api = createReferenceFixtureApi();
    const get = vi.spyOn(api, 'get');
    mount('/intelligence/opportunities', api);
    await screen.findByText(referenceOpportunityRows[0]!.title);

    const searchUrl = get.mock.calls
      .map(([url]) => String(url))
      .find((url) => url.startsWith('/api/intelligence/opportunities/v2/search?'));
    expect(searchUrl).toBeDefined();
    const params = new URLSearchParams(searchUrl!.split('?')[1]);
    expect(params.get('mode')).toBe('all');
    expect(params.get('clientId')).toBe('');
  });

  test('renders a typed fixture row, cancels a pending keyword debounce on client change, and does not replay it', async () => {
    mount('/intelligence/opportunities?client=overland&mode=matched');
    expect(await screen.findByText(referenceOpportunityRows[0]!.title)).toBeInTheDocument();
    const keyword = screen.getByRole('textbox', { name: 'Keyword search' });
    fireEvent.change(keyword, { target: { value: 'stale keyword' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Overland AI' })[0]!);
    const client = await screen.findByRole('button', { name: /Aperture/ });
    fireEvent.click(client);
    await new Promise((resolve) => window.setTimeout(resolve, 350));
    expect(screen.getByTestId('location')).toHaveTextContent('client=aperture');
    await new Promise((resolve) => window.setTimeout(resolve, 350));
    const afterClientChange = new URL(
      screen.getByTestId('location').textContent!,
      'https://test.invalid',
    );
    expect(afterClientChange.searchParams.get('query')).not.toBe('stale keyword');
  });

  test('shows a matched count only for the same client and criteria, not an all-mode catalog total', async () => {
    mount('/intelligence/opportunities?client=overland&mode=matched');
    await screen.findByText(referenceOpportunityRows[0]!.title);
    fireEvent.click(screen.getAllByRole('button', { name: 'Overland AI' })[0]!);
    const matchedDialog = await screen.findByRole('dialog', { name: 'Choose a client' });
    expect(within(matchedDialog).getByRole('button', { name: /Overland AI/ })).toHaveTextContent(
      '6 matched',
    );
    expect(
      within(matchedDialog).getByRole('button', { name: /Aperture Defense/ }),
    ).toHaveTextContent('?');
    fireEvent.click(within(matchedDialog).getByRole('button', { name: 'Close' }));
    fireEvent.click(screen.getByRole('button', { name: 'All opportunities' }));
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('mode=all'));
    fireEvent.click(screen.getAllByRole('button', { name: 'Overland AI' })[0]!);
    const allDialog = await screen.findByRole('dialog', { name: 'Choose a client' });
    expect(within(allDialog).getByRole('button', { name: /Overland AI/ })).toHaveTextContent('?');
  });

  test('opens the custom sort menu, selects an option, and closes with Escape restoring focus', async () => {
    mount('/intelligence/opportunities?client=overland&mode=matched');
    await screen.findByText(referenceOpportunityRows[0]!.title);
    const sort = screen.getByRole('button', { name: 'Sort' });
    sort.focus();
    fireEvent.click(sort);
    const menu = await screen.findByRole('listbox', { name: 'Sort' });
    expect(menu).toHaveTextContent('Deadline — soonest first');
    fireEvent.click(within(menu).getByRole('option', { name: 'Title' }));
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('sort=title'));
    expect(sort).toHaveTextContent('Title');
    fireEvent.click(sort);
    const keyboardMenu = screen.getByRole('listbox', { name: 'Sort' });
    const selected = within(keyboardMenu).getByRole('option', { name: 'Title' });
    selected.focus();
    fireEvent.keyDown(selected, { key: 'ArrowDown' });
    expect(screen.getByRole('listbox', { name: 'Sort' })).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent('sort=title');
    fireEvent.keyDown(document.activeElement!, { key: 'Enter' });
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('sort=posted'));
    fireEvent.click(sort);
    const cancelMenu = screen.getByRole('listbox', { name: 'Sort' });
    fireEvent.keyDown(within(cancelMenu).getByRole('option', { name: 'Posted date' }), {
      key: 'ArrowUp',
    });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('listbox', { name: 'Sort' })).not.toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent('sort=posted');
    expect(sort).toHaveFocus();
  });

  test('keeps builder eligibility single-valued and filter close/Any agency changes immediately', async () => {
    mount('/intelligence/opportunities?client=overland&mode=matched');
    await screen.findByText(referenceOpportunityRows[0]!.title);
    fireEvent.click(screen.getByRole('button', { name: 'the client meets stated eligibility' }));
    fireEvent.click(screen.getByRole('button', { name: 'Needs review' }));
    expect(screen.getByLabelText(/Show me/i)).toHaveTextContent(
      /where the client needs eligibility review/,
    );
    const eligibility = new URLSearchParams(
      screen.getByTestId('location').textContent!.split('?')[1],
    );
    expect(eligibility.getAll('eligibility')).toEqual(['needs_review']);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(screen.getByRole('button', { name: /Filters/ }));
    const filters = await screen.findByRole('dialog', { name: 'Filters' });
    fireEvent.click(within(filters).getByRole('button', { name: 'Required' }));
    expect(screen.getByTestId('location')).toHaveTextContent('costShare=required');
    fireEvent.click(within(filters).getByRole('button', { name: 'Department of the Army' }));
    fireEvent.click(within(filters).getByRole('button', { name: 'Any agency' }));
    expect(filters).toBeInTheDocument();
    expect(screen.getByTestId('location')).not.toHaveTextContent('agency=army');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Filters' })).not.toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent('costShare=required');
  });

  test('preserves Pursuit origin, criteria, exact identity, and browser Back/Forward through detail', async () => {
    mount('/intelligence/opportunities?client=overland&mode=matched');
    await screen.findByText(referenceOpportunityRows[0]!.title);
    fireEvent.click(screen.getByRole('tab', { name: /Pursuit/ }));
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('tab=pursuit'));
    fireEvent.click(screen.getAllByRole('button', { name: 'List' }).at(-1)!);
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('board=list'));
    const pursuitTitle = await screen.findByRole('button', {
      name: /Autonomous Ground Systems Integration/,
    });
    const pursuitRow =
      referenceOpportunityRows.find((item) => item.title === pursuitTitle.textContent) ??
      referenceOpportunityRows.find((item) => item.title.includes('Autonomous Ground Systems'))!;
    const expectedSourceRecordId = referenceFixtureMapping.rowIdsByReferenceId[pursuitRow.id]!;
    fireEvent.click(pursuitTitle);
    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent('/intelligence/opportunities/'),
    );
    expect(
      decodeURIComponent(
        screen.getByTestId('location').textContent!.split('/').at(-1)!.split('?')[0]!,
      ),
    ).toBe(expectedSourceRecordId);
    const detailUrl = screen.getByTestId('location').textContent!;
    fireEvent.click(screen.getByRole('button', { name: 'History back' }));
    await waitFor(() =>
      expect(screen.getByTestId('location').textContent).toMatch(
        /^\/intelligence\/opportunities\?/,
      ),
    );
    expect(screen.getByTestId('location')).toHaveTextContent('tab=pursuit');
    expect(screen.getByTestId('location')).toHaveTextContent('board=list');
    expect(screen.getByTestId('location')).toHaveTextContent('client=overland');
    fireEvent.click(screen.getByRole('button', { name: 'History forward' }));
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent(detailUrl));
    fireEvent.click(await screen.findByRole('button', { name: 'Back to results' }));
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('tab=pursuit'));
    expect(screen.getByTestId('location')).toHaveTextContent('board=list');
  });

  test('applies the second readable saved search, keeps identity while edited, and clears invalid identity from URL', async () => {
    mount('/intelligence/opportunities?client=overland&mode=matched');
    await screen.findByText(referenceOpportunityRows[0]!.title);
    fireEvent.click(screen.getByRole('button', { name: /Saved searches 4/ }));
    const saved = await screen.findByRole('dialog', { name: 'Saved searches' });
    expect(saved).toHaveTextContent('Army sustainment recompetes');
    const secondSearch =
      saved.querySelector('.fo-saved-card:nth-of-type(2)') ??
      [...saved.querySelectorAll('.fo-saved-card')].find((card) =>
        card.textContent?.includes('Army sustainment recompetes'),
      );
    expect(secondSearch).toBeTruthy();
    fireEvent.click(secondSearch!.querySelector('button')!);
    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent('savedSearchId=s2'),
    );
    expect(
      screen.getByRole('button', { name: /Saved: Army sustainment recompetes/ }),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: 'Keyword search' }), {
      target: { value: 'edited criteria' },
    });
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Keyword search' }), { key: 'Enter' });
    expect(screen.getByTestId('location')).toHaveTextContent('savedSearchId=s2');
    expect(
      screen.getByRole('button', { name: /Saved: Army sustainment recompetes/ }),
    ).toHaveTextContent('Criteria changed');
  });

  test('clears an inaccessible saved-search identity from canonical URL state', async () => {
    mount('/intelligence/opportunities?client=halcyon&mode=all&savedSearchId=s2');
    await screen.findByText(referenceOpportunityRows[0]!.title);
    await waitFor(() =>
      expect(screen.getByTestId('location')).not.toHaveTextContent('savedSearchId='),
    );
    expect(screen.getByTestId('location')).toHaveTextContent('client=halcyon');
  });

  test('a shell client-picker event opens this same canonical chooser and keeps cancellation local', async () => {
    mount('/intelligence/opportunities?client=overland&mode=matched&query=typed');
    await screen.findByText(referenceOpportunityRows[0]!.title);
    const trigger = screen.getAllByRole('button', { name: 'Overland AI' })[0]!;
    trigger.focus();
    await act(async () => window.dispatchEvent(new Event(FUNDING_CLIENT_PICKER_EVENT)));
    const dialog = await screen.findByRole('dialog', { name: 'Choose a client' });
    expect(within(dialog).getByRole('button', { name: /Overland AI/ })).toBeInTheDocument();
    fireEvent.keyDown(dialog.firstElementChild!, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Choose a client' })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(screen.getByTestId('location')).toHaveTextContent('client=overland');
    expect(screen.getByTestId('location')).toHaveTextContent('query=typed');
  });

  test('cached matched count is withdrawn after the same-key refresh fails', async () => {
    const fixture = createReferenceFixtureApi();
    let failSearch = false;
    const get = vi.fn((url: string, config?: Parameters<typeof fixture.get>[1]) => {
      if (failSearch && url.startsWith('/api/intelligence/opportunities/v2/search?')) {
        return Promise.reject(new Error('refresh failed'));
      }
      return fixture.get(url, config);
    });
    mocks.api.mockReturnValue({ ...fixture, get });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/intelligence/opportunities?client=overland&mode=matched']}>
          <Routes>
            <Route
              path="/intelligence/opportunities"
              element={
                <>
                  <FundingOpportunitiesPage />
                  <LocationProbe />
                </>
              }
            />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await screen.findByText(referenceOpportunityRows[0]!.title);
    fireEvent.click(screen.getAllByRole('button', { name: 'Overland AI' })[0]!);
    const firstDialog = await screen.findByRole('dialog', { name: 'Choose a client' });
    expect(within(firstDialog).getByRole('button', { name: /Overland AI/ })).toHaveTextContent(
      '6 matched',
    );
    fireEvent.click(within(firstDialog).getByRole('button', { name: 'Close' }));
    failSearch = true;
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['funding-opportunities-v2'] });
    });
    await waitFor(() =>
      expect(screen.getByText('Opportunities could not be loaded')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getAllByRole('button', { name: 'Overland AI' })[0]!);
    const failedDialog = await screen.findByRole('dialog', { name: 'Choose a client' });
    expect(within(failedDialog).getByRole('button', { name: /Overland AI/ })).toHaveTextContent(
      '?',
    );
  });

  test('source-health loading is not styled as an error and successful rows preserve provider and timestamp', async () => {
    const fixture = createReferenceFixtureApi();
    let resolveHealth!: (value: { data: unknown }) => void;
    const healthPending = new Promise<{ data: unknown }>((resolve) => {
      resolveHealth = resolve;
    });
    const get = vi.fn(<T,>(
      url: string,
      config?: Parameters<FixtureApi['get']>[1],
    ): Promise<{ data: T }> =>
      url === '/api/intelligence/opportunities/v2/sources'
        ? (healthPending as Promise<{ data: T }>)
        : fixture.get<T>(url, config),
    ) as FixtureApi['get'];
    mount('/intelligence/opportunities?client=overland&mode=matched', { ...fixture, get });
    const loading = await screen.findByRole('button', { name: 'SOURCE HEALTH LOADING' });
    expect(loading.className).toContain('fo-v2-health-pill--loading');
    expect(loading.className).not.toContain('fo-v2-health-pill--error');
    const response = await fixture.get<{ sources: unknown[]; generatedAt: string }>(
      '/api/intelligence/opportunities/v2/sources',
    );
    await act(async () => resolveHealth(response));
    const current = (await screen.findAllByRole('button', { name: /SOURCES CURRENT/ }))[0]!;
    expect(current).toHaveTextContent('SOURCES CURRENT');
    fireEvent.click(current);
    const drawer = await screen.findByRole('dialog', { name: 'Source health' });
    expect(drawer).toHaveTextContent('SAM.gov');
    expect(drawer).toHaveTextContent('LAST RUN');
    expect(drawer).toHaveTextContent('Current');
  });

  test('disabled Funding feature does not query source health', async () => {
    mocks.feature.enabled = false;
    const fixture = createReferenceFixtureApi();
    const get = vi.fn(<T,>(
      url: string,
      config?: Parameters<FixtureApi['get']>[1],
    ): Promise<{ data: T }> => fixture.get<T>(url, config)) as FixtureApi['get'];
    mount('/intelligence/opportunities', { ...fixture, get });
    expect(
      await screen.findByText('Funding Opportunities is not enabled for this workspace.'),
    ).toBeInTheDocument();
    expect(get).not.toHaveBeenCalledWith('/api/intelligence/opportunities/v2/sources');
  });

  test('cancelling client selection does not replay a pending pursue intent', async () => {
    const fixture = createReferenceFixtureApi();
    const post = vi.spyOn(fixture, 'post');
    mocks.api.mockReturnValue(fixture);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/intelligence/opportunities?mode=all']}>
          <Routes>
            <Route path="/intelligence/opportunities" element={<FundingOpportunitiesPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await screen.findByText(referenceOpportunityRows[0]!.title);
    fireEvent.click(screen.getAllByRole('button', { name: 'Pursue' })[0]!);
    const dialog = await screen.findByRole('dialog', { name: 'Choose a client' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(dialog).not.toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Select a client' })[0]!);
    const reopened = await screen.findByRole('dialog', { name: 'Choose a client' });
    fireEvent.click(within(reopened).getByText('Aperture Defense').closest('button')!);
    await new Promise((resolve) => window.setTimeout(resolve, 50));
    expect(post.mock.calls.filter(([url]) => String(url).endsWith('/action'))).toHaveLength(0);
  });

  test('cancelling the shell client chooser preserves the underlying Quick record', async () => {
    const api = createReferenceFixtureApi();
    const post = vi.spyOn(api, 'post');
    mount('/intelligence/opportunities?mode=all', api);
    await screen.findByText(referenceOpportunityRows[0]!.title);
    fireEvent.click(screen.getAllByRole('button', { name: 'Quick details' })[0]!);
    const quick = await screen.findByRole('dialog', { name: referenceOpportunityRows[0]!.title });
    await act(async () => window.dispatchEvent(new Event(FUNDING_CLIENT_PICKER_EVENT)));
    const chooser = await screen.findByRole('dialog', { name: 'Choose a client' });
    fireEvent.click(within(chooser).getByRole('button', { name: 'Close' }));
    expect(chooser).not.toBeInTheDocument();
    expect(quick).toBeInTheDocument();
    expect(quick).toHaveTextContent(referenceOpportunityRows[0]!.title);
    expect(post).not.toHaveBeenCalled();
  });

  test('explicit client choice pursues the original record exactly once', async () => {
    const api = createReferenceFixtureApi();
    const post = vi.spyOn(api, 'post');
    mount('/intelligence/opportunities?mode=all', api);
    await screen.findByText(referenceOpportunityRows[0]!.title);
    fireEvent.click(screen.getAllByRole('button', { name: 'Pursue' })[0]!);
    const chooser = await screen.findByRole('dialog', { name: 'Choose a client' });
    fireEvent.click(within(chooser).getByRole('button', { name: /Aperture Defense/ }));
    const row = referenceOpportunityRows[0]!;
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(
        `/api/intelligence/clients/aperture/opportunities/${row.source}/${referenceFixtureMapping.rowIdsByReferenceId[row.id]}/action`,
        { intent: 'pursuit' },
      ),
    );
    expect(post.mock.calls.filter(([url]) => String(url).endsWith('/action'))).toHaveLength(1);
  });

  test('owner roster failure retries, then persists one scoped owner change and refreshes dependent views', async () => {
    const api = createReferenceFixtureApi();
    const originalGet = api.get.bind(api);
    let rosterReads = 0;
    vi.spyOn(api, 'get').mockImplementation(async (url, ...args) => {
      if (url === '/api/tenant-members' && ++rosterReads === 1)
        throw new Error('Roster unavailable');
      return originalGet(url, ...args);
    });
    const patch = vi.spyOn(api, 'patch');
    const invalidation = vi.spyOn(QueryClient.prototype, 'invalidateQueries');
    mount('/intelligence/opportunities?client=overland&mode=matched', api);
    await screen.findByText(referenceOpportunityRows[0]!.title);
    fireEvent.click(screen.getAllByRole('button', { name: 'More actions' })[0]!);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Assign owner' }));
    const dialog = await screen.findByRole('dialog', { name: 'Assign owner' });
    await within(dialog).findByText('Team members could not be loaded.');
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(patch).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Retry team members' }));
    const owner = await within(dialog).findByRole('combobox', { name: 'Owner' });
    const selectedId = (within(owner).getAllByRole('option')[1] as HTMLOptionElement).value;
    fireEvent.change(owner, { target: { value: selectedId } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    const row = referenceOpportunityRows[0]!;
    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch).toHaveBeenCalledWith(
      `/api/intelligence/clients/overland/opportunities/${row.source}/${referenceFixtureMapping.rowIdsByReferenceId[row.id]}`,
      { ownerUserId: selectedId },
    );
    expect(rosterReads).toBe(2);
    for (const key of [
      'funding-opportunities-v2',
      'funding-opportunity-v2-detail',
      'funding-opportunity-pipeline',
      'funding-opportunities-v2-saved',
      'engagement-tasks',
    ]) {
      expect(invalidation).toHaveBeenCalledWith({ queryKey: [key] });
    }
    invalidation.mockRestore();
  });
});
