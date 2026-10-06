import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { MemoryRouter, useSearchParams } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { EvidenceTab } from './EvidenceTab.js';
import { CitationPicker } from './CitationPicker.js';
const mocks = vi.hoisted(() => ({ enabled: true, get: vi.fn(), post: vi.fn() }));
vi.mock('../../../../lib/use-api.js', () => ({ useApi: () => mocks }));
vi.mock('../../../../lib/use-api-scope.js', () => ({
  useApiScope: () => 'synthetic-tenant:actor',
}));
vi.mock('../../../../lib/intel-feature-flags.js', () => ({
  useIntelFeatureEnabled: () => mocks.enabled,
}));
beforeEach(() => {
  sessionStorage.clear();
  mocks.get.mockReset();
  mocks.post.mockReset();
  mocks.enabled = true;
  mocks.post.mockResolvedValue({ data: {} });
  mocks.get.mockImplementation(async (url: string) => ({
    data: url.endsWith('/folders')
      ? [{ id: 'folder', name: 'Private scope', clientId: null }]
      : url.includes('/monitors')
        ? { monitors: [] }
        : { items: [], coverage: [] },
  }));
});
afterEach(cleanup);
test('publisher day precision keeps its calendar day and does not claim a release time', async () => {
  mocks.get.mockImplementation(async (url: string) => ({
    data: url.endsWith('/folders')
      ? []
      : url.includes('/monitors')
        ? { monitors: [] }
        : {
            items: [
              {
                id: 'day',
                title: 'Official DHS release',
                publisher: 'www.dhs.gov',
                published_at: '2026-10-05T00:00:00Z',
                publication_precision: 'day',
              },
            ],
            coverage: [],
          },
  }));
  // Emulate an Eastern viewer independently of the test machine's timezone.
  // Native formatting without the UTC day override would show October 4.
  const dateFormat = vi.spyOn(Date.prototype, 'toLocaleDateString').mockImplementation(function (
    this: Date,
    optionsLocale,
    options,
  ) {
    return new Intl.DateTimeFormat(optionsLocale ?? 'en-US', {
      timeZone: 'America/New_York',
      ...options,
    }).format(this);
  });
  try {
    expect(
      new Date('2026-10-05T00:00:00Z').toLocaleDateString('en-US', { dateStyle: 'medium' }),
    ).toBe('Oct 4, 2026');
    mount(<EvidenceTab lane="news" />);
    expect(await screen.findByText('Published Oct 5, 2026 · Time not stated')).toBeTruthy();
    expect(screen.queryByText(/Published Oct 4/)).toBeNull();
    expect(screen.queryByText(/Publication date not stated/)).toBeNull();
  } finally {
    dateFormat.mockRestore();
  }
});
test('publisher coverage distinguishes static qualification from retained reporting and missing intake receipt', async () => {
  mocks.get.mockImplementation(async (url: string) => ({
    data: url.endsWith('/folders')
      ? []
      : url.includes('/monitors')
        ? { monitors: [] }
        : {
            items: [],
            coverage: [
              {
                id: 'p',
                publisher: 'Politico',
                source_group: 'florida_regional',
                status: 'unavailable',
                retained: {
                  articles: 3,
                  fullTextArticles: 0,
                  latestPublishedAt: '2026-10-05T12:00:00Z',
                  latestObservedAt: '2026-10-06T12:00:00Z',
                },
              },
            ],
          },
  }));
  mount(<EvidenceTab lane="news" />);
  expect(await screen.findByText(/Coverage qualification: Not qualified/)).toBeTruthy();
  expect(screen.getByText('Latest intake: Receipt not available')).toBeTruthy();
  expect(screen.queryByText(/Succeeded at last check/)).toBeNull();
  expect(screen.getByText(/3 retained articles · 0 with full text/)).toBeTruthy();
  expect(
    screen.getByText(/do not establish complete regional coverage or a healthy feed/),
  ).toBeTruthy();
});
test('publisher coverage shows endpoint failures separately from successful intake and static regional qualification', async () => {
  mocks.get.mockImplementation(async (url: string) => ({
    data: url.endsWith('/folders')
      ? []
      : url.includes('/monitors')
        ? { monitors: [] }
        : {
            items: [],
            coverage: [
              {
                id: 'h',
                publisher: 'The Hill',
                status: 'unavailable',
                source_group: 'national',
                intake: {
                  status: 'succeeded',
                  feeds: [
                    {
                      url: 'https://thehill.com/feed/',
                      status: 'succeeded',
                      observedAt: '2026-10-06T12:00:00Z',
                    },
                  ],
                },
              },
              {
                id: 'p',
                publisher: 'Politico',
                status: 'unavailable',
                source_group: 'florida',
                intake: {
                  status: 'failed',
                  feeds: [
                    {
                      url: 'https://rss.politico.com/politics-news.xml',
                      status: 'failed',
                      observedAt: '2026-10-06T12:00:00Z',
                      reason: 'Politics endpoint HTTP 403',
                    },
                    {
                      url: 'https://rss.politico.com/congress.xml',
                      status: 'failed',
                      observedAt: '2026-10-06T12:00:00Z',
                      reason: 'Congress endpoint HTTP 503',
                    },
                  ],
                },
              },
              {
                id: 'w',
                publisher: 'WUSF',
                status: 'partial',
                intake: { status: 'succeeded', feeds: [] },
              },
              {
                id: 'u',
                publisher: 'Unconfigured newspaper',
                status: 'unavailable',
                intake: { status: 'no_verified_endpoint', feeds: [] },
              },
            ],
          },
  }));
  mount(<EvidenceTab lane="news" />);
  expect(await screen.findAllByText('Latest intake: Succeeded at last check')).toHaveLength(2);
  expect(screen.getByText(/Politics endpoint HTTP 403/)).toBeTruthy();
  expect(screen.getByText(/Congress endpoint HTTP 503/)).toBeTruthy();
  expect(screen.getByText('Latest intake: No verified intake endpoint')).toBeTruthy();
  expect(screen.getAllByText(/Coverage qualification: Not qualified/)).toHaveLength(3);
  expect(screen.getByText(/Coverage qualification: Partial/)).toBeTruthy();
});
test('calendar navigation has no irrelevant fiscal filters or fabricated project schedule', async () => {
  mount(<EvidenceTab lane="budget" />, '/legiwatch?tab=budget&budgetView=calendar');
  expect(screen.getByText(/A project-specific budget schedule is not available/)).toBeTruthy();
  expect(screen.queryByLabelText('Fiscal year')).toBeNull();
  expect(screen.queryByLabelText('Search project title or request identity')).toBeNull();
  expect(mocks.get.mock.calls.some(([url]) => url.includes('/budget?'))).toBe(false);
});
test('budget update emptiness is specific to the selected fiscal year and session', async () => {
  mount(
    <EvidenceTab lane="budget" />,
    '/legiwatch?tab=budget&budgetView=updates&fiscalYear=2025-26&budgetSession=2025',
  );
  expect(
    await screen.findByText(/No retained budget updates for fiscal year 2025-26, session 2025/),
  ).toBeTruthy();
  expect(screen.queryByLabelText('Search project title or request identity')).toBeNull();
  expect(screen.queryByText(/No qualified fiscal documents/)).toBeNull();
});
test('budget document labels are readable and clearing filters resets every field together', async () => {
  mocks.get.mockImplementation(async (url: string) => ({
    data: url.endsWith('/folders')
      ? []
      : {
          projects: [],
          documents: [
            {
              id: 'd',
              title: 'Published appropriation',
              chamber: 'house',
              stage: 'chamber_proposal',
              role: 'appropriation',
              fiscal_year: '2025-26',
              session_key: '2025',
              complete: true,
            },
          ],
        },
  }));
  mount(
    <EvidenceTab lane="budget" />,
    '/legiwatch?tab=budget&budgetView=documents&fiscalYear=2025-26&budgetSession=2025',
  );
  expect(await screen.findByText('House · Chamber proposal')).toBeTruthy();
  expect(screen.getByText(/FY 2025-26 · Session 2025 · Appropriation/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
  await waitFor(() =>
    expect((screen.getByLabelText('Fiscal year') as HTMLInputElement).value).toBe('2026-27'),
  );
  expect((screen.getByLabelText('Legislative session') as HTMLSelectElement).value).toBe('');
});
function mount(child: React.ReactNode, route = '/legiwatch?tab=news&folder=folder') {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <MemoryRouter initialEntries={[route]}>{child}</MemoryRouter>
    </QueryClientProvider>,
  );
}
test('a disabled lane does not retrieve evidence', () => {
  mocks.enabled = false;
  mount(<EvidenceTab lane="news" />);
  expect(screen.getByText(/not enabled/)).toBeTruthy();
  expect(mocks.get).not.toHaveBeenCalled();
});
test('no retained matches disclose coverage without claiming no activity', async () => {
  mount(<EvidenceTab lane="news" />);
  expect(await screen.findByText(/No retained articles match/)).toBeTruthy();
  expect(mocks.get.mock.calls.some(([url]) => url.includes('folderId=folder'))).toBe(true);
});
test('tracking sends the displayed optimistic version and explicit folder', async () => {
  mocks.get.mockImplementation(async (url: string) => ({
    data: url.endsWith('/folders')
      ? [{ id: 'folder', name: 'Private scope', clientId: null }]
      : url.includes('/monitors')
        ? { monitors: [] }
        : {
            items: [
              {
                id: 'article',
                title: 'Published source',
                publisher: 'Publisher',
                tracking_version: 3,
                saved: true,
              },
            ],
            coverage: [],
          },
  }));
  mount(<EvidenceTab lane="news" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));
  await waitFor(() =>
    expect(mocks.post).toHaveBeenCalledWith(
      expect.stringContaining('/track'),
      expect.objectContaining({
        folderId: 'folder',
        kind: 'news',
        sourceId: 'article',
        expectedVersion: 3,
        removed: true,
      }),
    ),
  );
});
test('citation review selects a page and rejects text absent from that page', async () => {
  const choose = vi.fn();
  mocks.get.mockResolvedValue({
    data: {
      revision: 'v1',
      sections: [
        { locator: 'pdf-index:89', text: 'ASHA operating allocation 20,500.' },
        { locator: 'pdf-index:91', text: 'ASHA capital allocation 29,500.' },
      ],
    },
  });
  mount(
    <CitationPicker
      source={{ kind: 'budget', id: 'document', revision: 'v1', title: 'Chapter law' }}
      client=""
      folder="folder"
      onChoose={choose}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Choose cited passage' }));
  const section = await screen.findByLabelText('Source section');
  fireEvent.change(section, { target: { value: 'pdf-index:91' } });
  fireEvent.change(screen.getByLabelText(/Exact excerpt/), {
    target: { value: 'Invented amount' },
  });
  expect(
    (screen.getByRole('button', { name: 'Use this exact passage' }) as HTMLButtonElement).disabled,
  ).toBe(true);
  fireEvent.change(screen.getByLabelText(/Exact excerpt/), { target: { value: '29,500' } });
  fireEvent.click(screen.getByRole('button', { name: 'Use this exact passage' }));
  expect(choose).toHaveBeenCalledWith(
    expect.objectContaining({ locator: 'pdf-index:91', quote: '29,500', start: 24, end: 30 }),
  );
});

// --- Confirmed native-browser regressions (native-budget-scope/report.json) ---

const amount = (id: string, projectId: string, chamber: string, minorUnits: string) => ({
  id,
  observation: {
    id,
    projectId,
    chamber,
    stage: 'proposed',
    fund: 'Synthetic QA fund',
    basis: 'total',
    state: 'amount',
    minorUnits,
    sourceRevision: `rev-${id}`,
    fiscalYear: '2026-27',
  },
});
const budgetPayload = (projectId: string, prefix: string) => ({
  notice: 'Selected publisher evidence.',
  projects: [{ id: projectId, title: `Synthetic QA Budget ${prefix}`, fiscal_year: '2026-27' }],
  amounts: [
    amount(`${prefix}-amt1`, projectId, 'House', '10000'),
    amount(`${prefix}-amt2`, projectId, 'Senate', '15000'),
  ],
  documents: [],
  events: [],
});
function mockBudgetApi() {
  mocks.get.mockImplementation(async (url: string) => ({
    data: url.endsWith('/folders')
      ? [{ id: 'folder', name: 'Client folder', clientId: 'client-a' }]
      : url.includes('/budget?')
        ? url.includes('projectId=project-a')
          ? budgetPayload('project-a', 'a')
          : url.includes('projectId=project-b')
            ? budgetPayload('project-b', 'b')
            : {
                notice: '',
                projects: [
                  { id: 'project-a', title: 'Synthetic QA Budget A', fiscal_year: '2026-27' },
                  { id: 'project-b', title: 'Synthetic QA Budget B', fiscal_year: '2026-27' },
                ],
                amounts: [],
                documents: [],
                events: [],
              }
        : { items: [], coverage: [] },
  }));
  mocks.post.mockImplementation(async (url: string, body: Record<string, unknown>) => {
    if (url.includes('/budget/compare')) {
      if (!body.leftRevision || !body.rightRevision)
        throw new Error('EXACT_BUDGET_REVISIONS_REQUIRED');
      return {
        data: {
          comparable: true,
          reasons: [],
          deltaMinorUnits: '5000',
          percentage: '50.00%',
          left: { id: body.leftId, chamber: 'House', stage: 'proposed', fiscalYear: '2026-27' },
          right: { id: body.rightId, chamber: 'Senate', stage: 'proposed', fiscalYear: '2026-27' },
        },
      };
    }
    return { data: {} };
  });
}

test('all-clients folder selector retains accessible client-bound folders', async () => {
  mocks.get.mockImplementation(async (url: string) => ({
    data: url.endsWith('/folders')
      ? [
          { id: 'private-folder', name: 'Private scope', clientId: null },
          { id: 'client-folder', name: 'Client bound folder', clientId: 'client-a' },
          { id: 'archived-folder', name: 'Archived', clientId: null, archived: true },
        ]
      : url.includes('/monitors')
        ? { monitors: [] }
        : { items: [], coverage: [] },
  }));
  mount(<EvidenceTab lane="news" />, '/legiwatch?tab=news');
  const select = (await screen.findByLabelText('Folder')) as HTMLSelectElement;
  await waitFor(() => expect(select.options.length).toBe(3));
  const values = Array.from(select.options).map((o) => o.value);
  expect(values).toEqual(['', 'private-folder', 'client-folder']);
});

test('changing project clears stale observation selections and disables compare', async () => {
  mockBudgetApi();
  mount(<EvidenceTab lane="budget" />, '/legiwatch?tab=budget&project=project-a');
  const leftSelect = (await screen.findByLabelText('Left observation')) as HTMLSelectElement;
  const rightSelect = (await screen.findByLabelText('Right observation')) as HTMLSelectElement;
  await waitFor(() => expect(leftSelect.options.length).toBe(3));
  fireEvent.change(leftSelect, { target: { value: 'a-amt1' } });
  fireEvent.change(rightSelect, { target: { value: 'a-amt2' } });
  expect((screen.getByRole('button', { name: 'Compare' }) as HTMLButtonElement).disabled).toBe(
    false,
  );
  fireEvent.click(screen.getByRole('button', { name: 'All projects' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Synthetic QA Budget B' }));
  const nextLeft = (await screen.findByLabelText('Left observation')) as HTMLSelectElement;
  const nextRight = (await screen.findByLabelText('Right observation')) as HTMLSelectElement;
  await waitFor(() => expect(nextLeft.value).toBe(''));
  expect(nextRight.value).toBe('');
  expect((screen.getByRole('button', { name: 'Compare' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  expect(mocks.post.mock.calls.some(([url]) => url.includes('/budget/compare'))).toBe(false);
});

test('changing fiscal year clears the old comparison result', async () => {
  mockBudgetApi();
  mount(<EvidenceTab lane="budget" />, '/legiwatch?tab=budget&project=project-a');
  const leftSelect = (await screen.findByLabelText('Left observation')) as HTMLSelectElement;
  const rightSelect = (await screen.findByLabelText('Right observation')) as HTMLSelectElement;
  await waitFor(() => expect(leftSelect.options.length).toBe(3));
  fireEvent.change(leftSelect, { target: { value: 'a-amt1' } });
  fireEvent.change(rightSelect, { target: { value: 'a-amt2' } });
  fireEvent.click(screen.getByRole('button', { name: 'Compare' }));
  expect(await screen.findByText(/Change: \$50\.00 · 50\.00%/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Fiscal year'), { target: { value: '2027-28' } });
  await waitFor(() => expect(screen.queryByText(/Change: \$50\.00 · 50\.00%/)).toBeNull());
  expect(leftSelect.value).toBe('');
  expect(rightSelect.value).toBe('');
});

test('a comparison finishing after a scope switch does not surface under the new scope', async () => {
  mockBudgetApi();
  let resolveCompare: ((v: unknown) => void) | undefined;
  mocks.post.mockImplementation(async (url: string, body: Record<string, unknown>) =>
    url.includes('/budget/compare')
      ? new Promise((resolve) => {
          resolveCompare = resolve;
        })
      : { data: {} },
  );
  mount(<EvidenceTab lane="budget" />, '/legiwatch?tab=budget&project=project-a');
  const leftSelect = (await screen.findByLabelText('Left observation')) as HTMLSelectElement;
  const rightSelect = (await screen.findByLabelText('Right observation')) as HTMLSelectElement;
  await waitFor(() => expect(leftSelect.options.length).toBe(3));
  fireEvent.change(leftSelect, { target: { value: 'a-amt1' } });
  fireEvent.change(rightSelect, { target: { value: 'a-amt2' } });
  fireEvent.click(screen.getByRole('button', { name: 'Compare' }));
  await waitFor(() => expect(resolveCompare).toBeTruthy());
  fireEvent.change(screen.getByLabelText('Fiscal year'), { target: { value: '2027-28' } });
  resolveCompare!({
    data: {
      comparable: true,
      reasons: [],
      deltaMinorUnits: '5000',
      percentage: '50.00%',
      left: { id: 'a-amt1', chamber: 'House', stage: 'proposed', fiscalYear: '2026-27' },
      right: { id: 'a-amt2', chamber: 'Senate', stage: 'proposed', fiscalYear: '2026-27' },
    },
  });
  await waitFor(() => expect(screen.queryByText(/Change: \$50\.00 · 50\.00%/)).toBeNull());
});

test('a valid comparison survives an unrelated refetch with an unchanged selection', async () => {
  mockBudgetApi();
  mount(<EvidenceTab lane="budget" />, '/legiwatch?tab=budget&project=project-a');
  const leftSelect = (await screen.findByLabelText('Left observation')) as HTMLSelectElement;
  const rightSelect = (await screen.findByLabelText('Right observation')) as HTMLSelectElement;
  await waitFor(() => expect(leftSelect.options.length).toBe(3));
  fireEvent.change(leftSelect, { target: { value: 'a-amt1' } });
  fireEvent.change(rightSelect, { target: { value: 'a-amt2' } });
  fireEvent.click(screen.getByRole('button', { name: 'Compare' }));
  expect(await screen.findByText(/Change: \$50\.00 · 50\.00%/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Search project title or request identity'), {
    target: { value: 'ASHA' },
  });
  await waitFor(() =>
    expect(
      mocks.get.mock.calls.some(([url]) => url.includes('/budget?') && url.includes('q=ASHA')),
    ).toBe(true),
  );
  expect(screen.getByText(/Change: \$50\.00 · 50\.00%/)).toBeTruthy();
});

// --- Root review: scope ownership must include the chosen amount ids/revisions ---

test('changing an amount selection after a successful compare clears the prior result', async () => {
  mockBudgetApi();
  mount(<EvidenceTab lane="budget" />, '/legiwatch?tab=budget&project=project-a');
  const leftSelect = (await screen.findByLabelText('Left observation')) as HTMLSelectElement;
  const rightSelect = (await screen.findByLabelText('Right observation')) as HTMLSelectElement;
  await waitFor(() => expect(leftSelect.options.length).toBe(3));
  fireEvent.change(leftSelect, { target: { value: 'a-amt1' } });
  fireEvent.change(rightSelect, { target: { value: 'a-amt2' } });
  fireEvent.click(screen.getByRole('button', { name: 'Compare' }));
  expect(await screen.findByText(/Change: \$50\.00 · 50\.00%/)).toBeTruthy();
  // The displayed result belongs to the a-amt1/a-amt2 operands. Changing either
  // selection must drop it; the project/fiscal-year scope did not change.
  fireEvent.change(rightSelect, { target: { value: '' } });
  await waitFor(() => expect(screen.queryByText(/Change: \$50\.00 · 50\.00%/)).toBeNull());
  expect((screen.getByRole('button', { name: 'Compare' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
});

test('a comparison finishing after the amount selection changed is not applied', async () => {
  mockBudgetApi();
  let resolveCompare: ((v: unknown) => void) | undefined;
  mocks.post.mockImplementation(async (url: string, body: Record<string, unknown>) =>
    url.includes('/budget/compare')
      ? new Promise((resolve) => {
          resolveCompare = resolve;
        })
      : { data: {} },
  );
  mount(<EvidenceTab lane="budget" />, '/legiwatch?tab=budget&project=project-a');
  const leftSelect = (await screen.findByLabelText('Left observation')) as HTMLSelectElement;
  const rightSelect = (await screen.findByLabelText('Right observation')) as HTMLSelectElement;
  await waitFor(() => expect(leftSelect.options.length).toBe(3));
  fireEvent.change(leftSelect, { target: { value: 'a-amt1' } });
  fireEvent.change(rightSelect, { target: { value: 'a-amt2' } });
  fireEvent.click(screen.getByRole('button', { name: 'Compare' }));
  await waitFor(() => expect(resolveCompare).toBeTruthy());
  // Change the operands while the request is in flight; the former amounts'
  // response must not surface once it resolves.
  fireEvent.change(leftSelect, { target: { value: 'a-amt2' } });
  resolveCompare!({
    data: {
      comparable: true,
      reasons: [],
      deltaMinorUnits: '5000',
      percentage: '50.00%',
      left: { id: 'a-amt1', chamber: 'House', stage: 'proposed', fiscalYear: '2026-27' },
      right: { id: 'a-amt2', chamber: 'Senate', stage: 'proposed', fiscalYear: '2026-27' },
    },
  });
  await waitFor(() => expect(screen.queryByText(/Change: \$50\.00 · 50\.00%/)).toBeNull());
});

test('a late action error after a scope change is not surfaced', async () => {
  mockBudgetApi();
  let rejectCompare: ((e: unknown) => void) | undefined;
  mocks.post.mockImplementation(async (url: string, body: Record<string, unknown>) =>
    url.includes('/budget/compare')
      ? new Promise((_, reject) => {
          rejectCompare = reject;
        })
      : { data: {} },
  );
  mount(<EvidenceTab lane="budget" />, '/legiwatch?tab=budget&project=project-a');
  const leftSelect = (await screen.findByLabelText('Left observation')) as HTMLSelectElement;
  const rightSelect = (await screen.findByLabelText('Right observation')) as HTMLSelectElement;
  await waitFor(() => expect(leftSelect.options.length).toBe(3));
  fireEvent.change(leftSelect, { target: { value: 'a-amt1' } });
  fireEvent.change(rightSelect, { target: { value: 'a-amt2' } });
  fireEvent.click(screen.getByRole('button', { name: 'Compare' }));
  await waitFor(() => expect(rejectCompare).toBeTruthy());
  // The scope is abandoned before the rejection arrives; its error belongs to
  // the old selection and must not appear under the new one.
  fireEvent.change(screen.getByLabelText('Fiscal year'), { target: { value: '2027-28' } });
  rejectCompare!(new Error('EXACT_BUDGET_REVISIONS_REQUIRED'));
  await waitFor(() => expect(screen.queryByText(/EXACT_BUDGET_REVISIONS_REQUIRED/)).toBeNull());
});

test('a scope collision across concatenated parts still clears state', async () => {
  // Under the old join('') key, scope [a, bc] and [ab, c] were identical. Drive
  // a real scope change (project switch) and assert the stale result is gone;
  // the JSON-tuple key can never equate two different scopes.
  mockBudgetApi();
  mount(<EvidenceTab lane="budget" />, '/legiwatch?tab=budget&project=project-a');
  const leftSelect = (await screen.findByLabelText('Left observation')) as HTMLSelectElement;
  const rightSelect = (await screen.findByLabelText('Right observation')) as HTMLSelectElement;
  await waitFor(() => expect(leftSelect.options.length).toBe(3));
  fireEvent.change(leftSelect, { target: { value: 'a-amt1' } });
  fireEvent.change(rightSelect, { target: { value: 'a-amt2' } });
  fireEvent.click(screen.getByRole('button', { name: 'Compare' }));
  expect(await screen.findByText(/Change: \$50\.00 · 50\.00%/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'All projects' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Synthetic QA Budget B' }));
  await waitFor(() => expect(screen.queryByText(/Change: \$50\.00 · 50\.00%/)).toBeNull());
});

function EvidenceNavigation() {
  const [params, setParams] = useSearchParams();
  return (
    <>
      <button
        onClick={() => {
          const next = new URLSearchParams(params);
          next.set('tab', params.get('tab') === 'budget' ? 'news' : 'budget');
          setParams(next);
        }}
      >
        Switch evidence lane
      </button>
      <output aria-label="Current evidence URL">{params.toString()}</output>
      <EvidenceTab lane={params.get('tab') === 'budget' ? 'budget' : 'news'} />
    </>
  );
}

test('news, personnel, registrations, and budget keep separate search text and pagination with client scope', async () => {
  mount(
    <EvidenceNavigation />,
    '/legiwatch?tab=news&client=client-a&folder=folder&q=Clarity&offset=50',
  );
  expect(await screen.findByLabelText('Search retained coverage')).toHaveValue('Clarity');
  await waitFor(() =>
    expect(screen.getByLabelText('Current evidence URL').textContent).toContain(
      'newsArticlesQuery=Clarity',
    ),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Personnel changes' }));
  expect(await screen.findByLabelText('Person, firm or principal')).toHaveValue('');
  fireEvent.change(screen.getByLabelText('Person, firm or principal'), {
    target: { value: 'Morgan' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Registrations' }));
  expect(screen.getByLabelText('Person, firm or principal')).toHaveValue('');
  fireEvent.change(screen.getByLabelText('Person, firm or principal'), {
    target: { value: 'Rubin' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Switch evidence lane' }));
  expect(await screen.findByLabelText('Search project title or request identity')).toHaveValue('');
  fireEvent.change(screen.getByLabelText('Search project title or request identity'), {
    target: { value: 'ASHA' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Switch evidence lane' }));
  expect(await screen.findByLabelText('Person, firm or principal')).toHaveValue('Rubin');
  fireEvent.click(screen.getByRole('button', { name: 'Personnel changes' }));
  expect(screen.getByLabelText('Person, firm or principal')).toHaveValue('Morgan');
  fireEvent.click(screen.getByRole('button', { name: 'Coverage' }));
  expect(screen.getByLabelText('Search retained coverage')).toHaveValue('Clarity');
  const url = new URLSearchParams(screen.getByLabelText('Current evidence URL').textContent!);
  expect(url.get('client')).toBe('client-a');
  expect(url.get('folder')).toBe('folder');
  expect(url.get('newsArticlesOffset')).toBe('50');
  expect(url.has('q')).toBe(false);
  expect(url.has('offset')).toBe(false);
  await waitFor(() =>
    expect(
      mocks.get.mock.calls.some(
        ([url]) =>
          url.includes('/budget?') && url.includes('q=ASHA') && url.includes('clientId=client-a'),
      ),
    ).toBe(true),
  );
  expect(
    mocks.get.mock.calls.some(([url]) => url.includes('/budget?') && url.includes('q=Rubin')),
  ).toBe(false);
});
