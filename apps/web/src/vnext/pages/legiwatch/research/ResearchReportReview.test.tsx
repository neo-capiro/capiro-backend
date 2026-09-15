import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ResearchReportReview } from './ResearchReportReview.js';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  scope: 'tenant-a',
}));

vi.mock('../../../../lib/use-api.js', () => ({ useApi: () => mocks }));
vi.mock('../../../../lib/use-api-scope.js', () => ({ useApiScope: () => mocks.scope }));

const report = {
  id: 'report-a',
  name: 'Synthetic report A',
  version: 4,
  folderIds: ['folder-a'],
};
const run = {
  id: '3ebe79b6-19b8-4d63-bdd3-33b53020fbef',
  reportId: 'report-a',
  audience: 'internal',
  complete: true,
  generatedAt: '2026-09-10T12:00:00Z',
  cutoff: '2026-09-10',
  contentHash: 'b'.repeat(64),
  definitionVersion: 4,
  rendered: { html: '<p>Frozen</p>', text: 'Frozen synthetic report' },
};

beforeEach(() => {
  mocks.get.mockReset();
  mocks.post.mockReset();
  mocks.get.mockImplementation(async (url: string) => {
    if (url.endsWith('/reports')) return { data: [report] };
    if (url.includes('/runs/')) return { data: run };
    return { data: [] };
  });
});

afterEach(cleanup);

function mount(route = '/legiwatch?tab=research&client=client-a&folder=folder-a&source=committee') {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <MemoryRouter initialEntries={[route]}>
        <ResearchReportReview selectionId="selection-a" folderId="folder-a" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function approve() {
  mocks.post.mockImplementation(async (url: string) => {
    if (url.endsWith('/generate')) return { data: { id: 'base-run' } };
    if (url.endsWith('/preview'))
      return { data: { rendered: { text: 'Exact reviewed text' }, approvalHash: 'hash-a' } };
    if (url.endsWith('/approve')) return { data: { runId: run.id } };
    return { data: {} };
  });
  mount();
  fireEvent.change(await screen.findByLabelText('Saved report'), {
    target: { value: 'report-a' },
  });
  await screen.findByRole('option', { name: 'Synthetic report A' });
  fireEvent.change(screen.getByLabelText('Saved report'), { target: { value: 'report-a' } });
  fireEvent.click(screen.getByRole('button', { name: 'Preview exact research text' }));
  await screen.findByText('Exact reviewed text', undefined, { timeout: 8000 });
  fireEvent.click(screen.getByRole('button', { name: 'Approve this exact report version' }));
  await screen.findByText('Reviewed research saved as a new immutable report version.');
}

test('the reviewed-report link routes to the digest tab report library, not the hearing calendar', async () => {
  await approve();
  const href = screen.getByRole('link', { name: 'Open reviewed report' }).getAttribute('href')!;
  const url = new URL(href, 'http://local');
  expect(url.pathname).toBe('/legiwatch');
  expect(url.searchParams.get('tab')).toBe('digest');
  expect(url.searchParams.get('reportView')).toBe('reports');
  expect(url.searchParams.get('reportRun')).toBe(run.id);
});

test('the reviewed-report link preserves the live client, folder and source scope params', async () => {
  await approve();
  const href = screen.getByRole('link', { name: 'Open reviewed report' }).getAttribute('href')!;
  const url = new URL(href, 'http://local');
  expect(url.searchParams.get('client')).toBe('client-a');
  expect(url.searchParams.get('folder')).toBe('folder-a');
  expect(url.searchParams.get('source')).toBe('committee');
});

test('preview renders the exact current text of an existing saved run', async () => {
  mocks.post.mockImplementation(async (url: string) => {
    if (url.endsWith('/generate')) return { data: { id: run.id } };
    if (url.endsWith('/preview'))
      return {
        data: { rendered: { text: run.rendered!.text }, approvalHash: 'hash-b' },
      };
    return { data: {} };
  });
  mount();
  fireEvent.change(await screen.findByLabelText('Saved report'), {
    target: { value: 'report-a' },
  });
  await screen.findByRole('option', { name: 'Synthetic report A' });
  fireEvent.change(screen.getByLabelText('Saved report'), { target: { value: 'report-a' } });
  fireEvent.click(screen.getByRole('button', { name: 'Preview exact research text' }));
  await screen.findByText('Frozen synthetic report');
  expect(mocks.post).toHaveBeenCalledWith(
    '/intel-api/legiwatch/research/reports/preview',
    expect.objectContaining({ selectionId: 'selection-a', runId: run.id }),
  );
  await waitFor(() =>
    expect(screen.getByText(/Internal review only/)).toBeTruthy(),
  );
});
