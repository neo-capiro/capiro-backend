import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BriefingHistory } from './BriefingHistory.js';
import { BriefingWorkspace } from './BriefingWorkspace.js';
import { basketKey } from './evidence-api.js';
const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('../../../../lib/use-api.js', () => ({ useApi: () => api }));
vi.mock('../../../../lib/use-api-scope.js', () => ({ useApiScope: () => 'tenant:actor' }));
vi.mock('../../../../lib/intel-feature-flags.js', () => ({ useIntelFeatureEnabled: () => true }));
beforeEach(() => {
  api.get.mockReset();
  api.post.mockReset();
  sessionStorage.clear();
});
afterEach(cleanup);
function mount(child: React.ReactNode) {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <MemoryRouter initialEntries={['/legiwatch?tab=digest&folder=folder']}>{child}</MemoryRouter>
    </QueryClientProvider>,
  );
}
test('prepared editions survive a new session and older pages keep scope and use canonical editor links', async () => {
  const review = vi.fn();
  api.get.mockImplementation(async (url: string) => ({
    data: {
      items: [
        {
          id: url.includes('cursor=next') ? 'two' : 'one',
          selectionId: 'selection',
          title: 'Original title',
          createdAt: '2026-09-14T10:00:00Z',
          state: 'prepared',
          draft: {
            draftId: url.includes('cursor=next') ? 'older-draft' : 'new-draft',
            title: url.includes('cursor=next') ? 'Older edition' : 'Edited edition',
          },
        },
      ],
      nextCursor: url.includes('cursor=next') ? null : 'next',
      draftLookupState: 'available',
    },
  }));
  mount(<BriefingHistory client="client" folder="folder" onReview={review} />);
  expect(await screen.findByText('Edited edition')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Open draft' })).toHaveAttribute(
    'href',
    '/workspace/new-draft',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Review edition' }));
  expect(review).toHaveBeenCalledWith(
    expect.objectContaining({
      selectionId: 'selection',
      draft: expect.objectContaining({ draftId: 'new-draft' }),
    }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Load older editions' }));
  expect(await screen.findByText('Older edition')).toBeTruthy();
  expect(api.get).toHaveBeenLastCalledWith(
    expect.stringMatching(/clientId=client&folderId=folder&limit=20&cursor=next/),
  );
  expect(screen.queryByRole('button', { name: 'Load older editions' })).toBeNull();
});
test('scheduled history shows held and skipped receipts without inventing draft links', async () => {
  api.get
    .mockRejectedValueOnce(new Error('unavailable'))
    .mockResolvedValue({
      data: {
        items: [
          {
            id: 'held',
            state: 'held',
            reason: 'News monitor source window incomplete',
            definitionVersion: 5,
            createdAt: '2026-09-14T10:00:00Z',
          },
        ],
        nextCursor: null,
        draftLookupState: 'available',
      },
    });
  mount(<BriefingHistory client="" folder="folder" configurationId="config" onReview={vi.fn()} />);
  expect(await screen.findByRole('alert')).toHaveTextContent('Edition history could not be loaded');
  fireEvent.click(screen.getByRole('button', { name: 'Retry history' }));
  expect(await screen.findByText('News monitor source window incomplete')).toBeTruthy();
  expect(screen.queryByRole('link', { name: 'Open draft' })).toBeNull();
  expect(api.get).toHaveBeenLastCalledWith(
    expect.stringContaining('/configurations/config/occurrences?'),
  );
});
test('exact edition review displays the server HTML in a sandbox and sends its approval hash unchanged', async () => {
  sessionStorage.setItem(
    basketKey('tenant:actor', '', 'folder') + ':draft',
    JSON.stringify({
      saved: { selectionId: 'selection', draft: { draftId: 'draft' } },
      reportId: 'report',
    }),
  );
  api.get.mockImplementation(async (url: string) => ({
    data: url.endsWith('/folders')
      ? [{ id: 'folder', clientId: null, name: 'Private folder' }]
      : url.endsWith('/reports')
        ? [{ id: 'report', folderIds: ['folder'], name: 'Daily report' }]
        : url.includes('/configurations')
          ? { configurations: [] }
          : { items: [], nextCursor: null },
  }));
  const html = '<h1>Edited edition</h1><p>Approved <strong>human edits</strong></p>';
  api.post.mockImplementation(async (url: string) => ({
    data: url.endsWith('/preview')
      ? {
          rendered: { html, text: 'Edited edition Approved human edits' },
          audience: 'internal',
          deliveryState: 'internal_review_only',
          approvalHash: 'exact-reviewed-hash',
        }
      : { runId: 'run' },
  }));
  mount(<BriefingWorkspace />);
  fireEvent.click(await screen.findByRole('button', { name: 'Preview edited edition' }));
  const frame = await screen.findByTitle('Exact edited edition preview');
  expect(frame).toHaveAttribute('sandbox', '');
  expect(frame).toHaveAttribute('srcdoc', html);
  expect(screen.getByRole('link', { name: /Open editable Workspace draft/ })).toHaveAttribute(
    'href',
    '/workspace/draft',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Approve this edition' }));
  await waitFor(() =>
    expect(api.post).toHaveBeenLastCalledWith(
      expect.stringContaining('/briefings/approve'),
      expect.objectContaining({
        approvalHash: 'exact-reviewed-hash',
        selectionId: 'selection',
        audience: 'internal',
      }),
    ),
  );
});
