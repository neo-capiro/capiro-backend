import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
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
