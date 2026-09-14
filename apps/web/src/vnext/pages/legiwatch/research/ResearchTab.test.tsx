import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { MemoryRouter, useSearchParams } from 'react-router-dom';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { ResearchTab } from './ResearchTab.js';

const mocks = vi.hoisted(() => ({
  identity: 'tenant-a',
  enabled: true,
  get: vi.fn(),
  post: vi.fn(),
}));

vi.mock('../../../../lib/use-api.js', () => ({ useApi: () => mocks }));

vi.mock('../../../../lib/use-api-scope.js', () => ({ useApiScope: () => mocks.identity }));

vi.mock('../../../../lib/intel-feature-flags.js', () => ({
  useIntelFeatureEnabled: () => mocks.enabled,
}));

beforeEach(() => {
  mocks.get.mockReset();
  mocks.post.mockReset();
  mocks.identity = 'tenant-a';
  mocks.enabled = true;
});

afterEach(cleanup);

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
