import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { MemoryRouter, useSearchParams } from 'react-router-dom';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { ResearchTab } from './ResearchTab.js';

const mocks = vi.hoisted(() => ({
  identity: 'tenant-a',
  enabled: true,
  role: 'user_admin',
  meLoading: false,
  get: vi.fn(),
  post: vi.fn(),
}));

vi.mock('../../../../lib/use-api.js', () => ({ useApi: () => mocks }));

vi.mock('../../../../lib/use-api-scope.js', () => ({ useApiScope: () => mocks.identity }));

vi.mock('../../../../lib/intel-feature-flags.js', () => ({
  useIntelFeatureEnabled: () => mocks.enabled,
}));

vi.mock('../../../../lib/me.js', () => ({
  useMe: () => ({
    data: mocks.meLoading ? undefined : { role: mocks.role },
    isLoading: mocks.meLoading,
  }),
}));

beforeEach(() => {
  sessionStorage.clear();
  mocks.get.mockReset();
  mocks.post.mockReset();
  mocks.identity = 'tenant-a';
  mocks.enabled = true;
  mocks.role = 'user_admin';
  mocks.meLoading = false;
  mocks.get.mockResolvedValue({ data: [] });
});

afterEach(cleanup);

test('a jurisdiction change resets incompatible bill sessions', async () => {
  mount('/legiwatch?tab=research&researchView=coverage&jurisdiction=US&session=119');
  expect(screen.getByRole('textbox', { name: 'Bill session' })).toHaveValue('119');
  fireEvent.change(screen.getByRole('combobox', { name: 'Jurisdiction' }), { target: { value: 'FL' } });
  expect(screen.getByRole('textbox', { name: 'Bill session' })).toHaveValue(String(new Date().getFullYear()));
  await waitFor(() => expect(mocks.get).toHaveBeenCalledWith(expect.stringContaining('jurisdiction=FL&sessionKey=' + new Date().getFullYear())));
});

test('a federal statute deep link does not request Florida material under a federal scope', async () => {
  mount('/legiwatch?tab=research&researchView=statutes&jurisdiction=US&session=119&researchQuery=395.003');
  expect(screen.getByText(/Statute and Constitution lookup is available for Florida/)).toBeTruthy();
  expect(screen.getByRole('button', { name: /^Search$/ })).toBeDisabled();
  expect(screen.getByRole('textbox', { name: 'Citation or title' })).toBeDisabled();
  expect(mocks.get.mock.calls.some(([url]) => url.includes('/references?'))).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Use Florida legal sources' }));
  expect(screen.getByRole('button', { name: /^Search$/ })).toBeEnabled();
  await waitFor(() => expect(mocks.get).toHaveBeenCalledWith(expect.stringContaining('/references?jurisdiction=FL')));
});

function Switch() {
  const [, set] = useSearchParams();
  return (
    <button
      onClick={() =>
        set({
          tab: 'research',
          researchView: 'bills',
          client: 'client-b',
          folder: 'folder-b',
          session: '2026',
        })
      }
    >
      Switch scope
    </button>
  );
}

function mount(
  route = '/legiwatch?tab=research&researchView=bills&client=client-a&folder=folder-a&session=2026',
) {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <MemoryRouter initialEntries={[route]}>
        <ResearchTab />
        <Switch />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const result = (id: string) => ({
  items: [
    {
      id,
      billId: 'FL-2026-HB7',
      sessionKey: '2026',
      kind: 'amendment',
      title: 'Published amendment',
      publishedDate: '2026-01-01',
      isCurrent: false,
      sourceUrl: 'https://www.flsenate.gov/',
      excerpt: { quote: id },
    },
  ],
  coverage: { complete: false, reason: 'partial' },
});

test('unwraps authenticated HTTP responses and shows exact historical document matches', async () => {
  mocks.post.mockResolvedValue({ data: result('Original amendment phrase') });
  mount();
  expect(await screen.findByText('Original amendment phrase')).toBeTruthy();
  expect(screen.getByText(/Historical extraction/)).toBeTruthy();
  expect(mocks.post.mock.calls[0]![1]).toMatchObject({
    clientId: 'client-a',
    folderId: 'folder-a',
    sessionKey: '2026',
  });
});

test('late search from a previous client cannot populate the new view', async () => {
  let resolveOld!: (v: unknown) => void;
  mocks.post.mockImplementation((_url, body) =>
    body.clientId === 'client-a'
      ? new Promise((resolve) => {
          resolveOld = resolve;
        })
      : Promise.resolve({ data: result('New client evidence') }),
  );
  mount();
  fireEvent.click(screen.getByText('Switch scope'));
  expect(await screen.findByText('New client evidence')).toBeTruthy();
  resolveOld({ data: result('Old client evidence') });
  await waitFor(() => expect(screen.queryByText('Old client evidence')).toBeNull());
});

test('disabled research gives a setup state without requesting source or private data', () => {
  mocks.enabled = false;
  mount();
  expect(screen.getByText('Research setup')).toBeTruthy();
  expect(mocks.get).not.toHaveBeenCalled();
  expect(mocks.post).not.toHaveBeenCalled();
});

test('standard users do not see the administrator-only imported setup view', async () => {
  mocks.role = 'standard_user';
  mocks.post.mockResolvedValue({ data: { items: [] } });
  mount();

  expect(await screen.findByRole('button', { name: 'Bills' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Review imported setup' })).toBeNull();
  expect(mocks.get.mock.calls.some(([url]) => String(url).includes('/research/imports?'))).toBe(
    false,
  );
});

test('standard-user imported-setup deep links fall back to Bills without requesting imports', async () => {
  mocks.role = 'standard_user';
  mocks.post.mockResolvedValue({ data: { items: [] } });
  mount('/legiwatch?tab=research&researchView=imports&session=2026');

  expect(
    await screen.findByText(
      'Imported setup review is available to workspace administrators. Research opened in Bills instead.',
    ),
  ).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Bills' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.queryByRole('button', { name: 'Review imported setup' })).toBeNull();
  expect(mocks.get.mock.calls.some(([url]) => String(url).includes('/research/imports?'))).toBe(
    false,
  );
  await waitFor(() =>
    expect(mocks.post).toHaveBeenCalledWith(
      '/intel-api/legiwatch/research/search',
      expect.objectContaining({ sessionKey: '2026' }),
    ),
  );
});

test('imported setup does not request protected data while the current role is loading', () => {
  mocks.meLoading = true;
  mount('/legiwatch?tab=research&researchView=imports&session=2026');

  expect(screen.getByText('Checking administrator access to imported setup review…')).toBeTruthy();
  expect(mocks.get).not.toHaveBeenCalled();
  expect(mocks.post).not.toHaveBeenCalled();
});

test('tenant administrators can open imported setup and request its review data', async () => {
  mocks.role = 'user_admin';
  mocks.get.mockResolvedValue({ data: { memberships: [], rules: [] } });
  mount('/legiwatch?tab=research&researchView=imports&session=2026');

  expect(await screen.findByRole('button', { name: 'Review imported setup' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await waitFor(() =>
    expect(mocks.get).toHaveBeenCalledWith(
      expect.stringContaining('/intel-api/legiwatch/research/imports?'),
    ),
  );
  expect(screen.queryByText(/Research opened in Bills instead/)).toBeNull();
});

test('reopened comparison requests both pinned revisions and keeps client scope', async () => {
  mocks.post.mockResolvedValue({
    data: { changes: [], warning: 'Text comparison is not legal effect.' },
  });
  mount(
    '/legiwatch?tab=research&researchView=compare&session=2026&client=client-a&folder=folder-a&left=left-id&leftRevision=hash-a&right=right-id&rightRevision=hash-b',
  );
  expect(await screen.findByText('Text comparison is not legal effect.')).toBeTruthy();
  expect(mocks.post).toHaveBeenCalledWith(
    '/intel-api/legiwatch/research/compare',
    expect.objectContaining({
      leftId: 'left-id',
      leftRevision: 'hash-a',
      rightId: 'right-id',
      rightRevision: 'hash-b',
      clientId: 'client-a',
    }),
  );
});

test('a lost Workspace acknowledgement can be recovered after remount with the same request', async () => {
  const route =
    '/legiwatch?tab=research&researchView=compare&session=2026&left=left-id&leftRevision=hash-a&right=right-id&rightRevision=hash-b';
  const comparison = {
    left: {
      id: 'left-id',
      revision: 'hash-a',
      sessionKey: '2026',
      sourceUrl: 'https://www.flsenate.gov/left/PDF',
    },
    right: { id: 'right-id', revision: 'hash-b', sessionKey: '2026' },
    changes: [
      {
        kind: 'removed',
        text: 'Original source passage',
        left: { locator: 'page:91', start: 0, end: 23 },
        right: null,
      },
    ],
  };
  let lost = true;
  mocks.post.mockImplementation(async (url) => {
    if (url.endsWith('/drafts')) {
      if (lost) {
        lost = false;
        throw new Error('Acknowledgement lost');
      }
      return { data: { selectionId: 'selection-id', draft: { draftId: 'draft-id' } } };
    }
    return { data: comparison };
  });
  const first = mount(route);
  const analysis = await screen.findByLabelText('Capiro analysis for review');
  fireEvent.change(analysis, { target: { value: 'Keep my source interpretation.' } });
  fireEvent.click(screen.getByText('Save cited research draft'));
  await screen.findByText(/Retry the same unchanged selection/);
  const original = mocks.post.mock.calls.find((c) => c[0].endsWith('/drafts'))![1];
  first.unmount();
  mount(route);
  expect(
    ((await screen.findByLabelText('Capiro analysis for review')) as HTMLTextAreaElement).value,
  ).toBe('Keep my source interpretation.');
  expect(screen.getByText('Left source · page:91').getAttribute('href')).toBe(
    'https://www.flsenate.gov/left/PDF#page=91',
  );
  fireEvent.click(screen.getByText('Save cited research draft'));
  await screen.findByText('Open saved research draft');
  const replay = mocks.post.mock.calls.filter((c) => c[0].endsWith('/drafts'))[1]![1];
  expect(replay).toEqual(original);
});

test('the right bill picker sends an explicit independent session and pinned revision', async () => {
  const left = {
    id: 'left-id',
    revision: 'hash-a',
    billId: 'left-bill',
    sessionKey: '2026',
    kind: 'text',
    publishedDate: '2026-01-01',
  };
  const right = {
    id: 'prior-id',
    revision: 'prior-hash',
    billId: 'prior-bill',
    sessionKey: '2025',
    kind: 'text',
    publishedDate: '2025-01-01',
  };
  mocks.get.mockImplementation(async (url) => ({
    data: url.includes('/versions?')
      ? { versions: [url.includes('billId=prior-bill') ? right : left] }
      : [],
  }));
  mocks.post.mockImplementation(async (url) => ({
    data: url.endsWith('/search')
      ? {
          items: [
            {
              ...right,
              billIdentifier: 'HB 11',
              billTitle: 'Earlier bill',
              excerpt: { quote: 'Retained text' },
            },
          ],
        }
      : { changes: [], warning: 'Cross-session comparison' },
  }));
  mount(
    '/legiwatch?tab=research&researchView=bills&session=2026&bill=left-bill&left=left-id&leftRevision=hash-a&rightPicker=true&rightSession=2025',
  );
  await screen.findByRole('option', { name: 'HB 11 · Earlier bill' });
  fireEvent.change(await screen.findByLabelText('Right bill'), { target: { value: 'prior-bill' } });
  await waitFor(() =>
    expect(screen.getByLabelText('Right version').textContent).toContain('2025-01-01'),
  );
  fireEvent.change(screen.getByLabelText('Right version'), { target: { value: 'prior-id' } });
  fireEvent.click(screen.getByText('Compare selected versions'));
  await screen.findByText('Cross-session comparison');
  expect(mocks.post).toHaveBeenCalledWith(
    '/intel-api/legiwatch/research/compare',
    expect.objectContaining({
      leftId: 'left-id',
      leftRevision: 'hash-a',
      rightId: 'prior-id',
      rightRevision: 'prior-hash',
      rightSessionKey: '2025',
      allowCrossBill: true,
    }),
  );
});

test('comparison controls and version fetches stay within bill views while the pinned pair survives navigation', async () => {
  mocks.get.mockImplementation(async (url: string) => ({
    data: url.includes('/versions?')
      ? {
          versions: [
            { id: 'left-id', revision: 'hash-a', kind: 'text', title: 'Introduced' },
            { id: 'right-id', revision: 'hash-b', kind: 'text', title: 'Enrolled' },
          ],
        }
      : { rows: [], receipts: [] },
  }));
  mocks.post.mockResolvedValue({ data: { changes: [], items: [] } });
  mount(
    '/legiwatch?tab=research&researchView=compare&leftBill=bill-a&left=left-id&leftRevision=hash-a&right=right-id&rightRevision=hash-b&rightPicker=true&client=client-a&folder=folder-a',
  );
  expect(await screen.findByLabelText('Left version')).toBeTruthy();
  const versionCalls = () =>
    mocks.get.mock.calls.filter(([url]) => url.includes('/versions?')).length;
  const initialCalls = versionCalls();
  for (const label of ['Statutes & Constitution', 'Rules & deadlines', 'Source coverage']) {
    fireEvent.click(screen.getByRole('button', { name: label }));
    await waitFor(() => expect(screen.queryByLabelText('Left version')).toBeNull());
    expect(screen.queryByLabelText('Right version')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Compare selected versions' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Choose the right bill' })).toBeNull();
    expect(versionCalls()).toBe(initialCalls);
  }
  fireEvent.click(screen.getByRole('button', { name: 'Bills' }));
  expect(await screen.findByLabelText('Left version')).toHaveValue('left-id');
  expect(screen.getByLabelText('Right version')).toHaveValue('right-id');
  fireEvent.click(screen.getByRole('button', { name: 'Compare selected versions' }));
  await waitFor(() =>
    expect(mocks.post).toHaveBeenCalledWith(
      '/intel-api/legiwatch/research/compare',
      expect.objectContaining({
        leftRevision: 'hash-a',
        rightRevision: 'hash-b',
        clientId: 'client-a',
        folderId: 'folder-a',
      }),
    ),
  );
});
