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
