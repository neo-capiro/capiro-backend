import { cleanup, render, screen } from '@testing-library/react';

import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { ImportReview } from './ImportReview.js';

const mocks = vi.hoisted(() => ({
  identity: 'tenant-a',
  get: vi.fn(),
  post: vi.fn(),
}));

vi.mock('../../../../lib/use-api.js', () => ({ useApi: () => mocks }));

vi.mock('../../../../lib/use-api-scope.js', () => ({ useApiScope: () => mocks.identity }));

beforeEach(() => {
  mocks.get.mockReset();
  mocks.post.mockReset();
  mocks.get.mockResolvedValue({ data: [] });
});

afterEach(cleanup);

const scope = {
  jurisdiction: 'FL',
  sessionKey: '2026',
  folderId: 'folder-a',
  clientId: 'client-a',
};

const rule = (id: string) => ({
  id,
  version: 1,
  sourceHash: 'hash-' + id,
  sourceId: 'source-' + id,
  interpretedName: 'Alert ' + id,
});

function mount(rules: any[], rows: any[] = []) {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <ImportReview rows={rows} rules={rules} scope={scope} refresh={async () => {}} />
    </QueryClientProvider>,
  );
}

test('empty rules response renders an honest empty heading, not a fabricated count', async () => {
  mount([]);
  expect(await screen.findByRole('heading', { name: 'No source alert definitions' })).toBeTruthy();
  expect(screen.queryByText(/Six source alert definitions/)).toBeNull();
  expect(screen.queryByText(/^\d+ source alert/)).toBeNull();
});

test('a single rule uses the singular heading', async () => {
  mount([rule('r1')]);
  expect(
    await screen.findByRole('heading', { name: '1 source alert definition' }),
  ).toBeTruthy();
});

test('multiple rules use the plural heading with the actual count', async () => {
  mount([rule('r1'), rule('r2'), rule('r3')]);
  expect(
    await screen.findByRole('heading', { name: '3 source alert definitions' }),
  ).toBeTruthy();
});
