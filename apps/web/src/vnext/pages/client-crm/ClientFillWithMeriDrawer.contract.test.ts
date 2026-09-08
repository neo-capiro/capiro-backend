import { createElement } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClientFillWithMeriDrawer } from './ClientFillWithMeriDrawer.js';
import type { FillFinding, FillRun } from '../../adapters/legacy/useClientFillWithMeri.js';

const getMock = vi.hoisted(() => vi.fn());
const postMock = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/use-api.js', () => ({ useApi: () => ({ get: getMock, post: postMock }) }));
const baseRun = {
  id: 'run-1',
  clientId: 'client-1',
  status: 'completed',
  requestedSources: [],
  sourceStates: {},
  summary: {},
  error: null,
  startedAt: '2026-09-01T12:00:00Z',
  completedAt: '2026-09-01T12:01:00Z',
  findings: [],
} satisfies FillRun;
const proposal = (overrides: Partial<FillFinding> = {}): FillFinding => ({
  id: 'finding-1',
  runId: 'run-1',
  kind: 'profile_field',
  targetKey: 'description',
  source: 'client_document',
  factKind: 'fact',
  currentValue: null,
  proposedValue: 'Communications systems',
  evidence: [],
  confidence: 0.9,
  status: 'pending',
  appliedAt: null,
  createdAt: '2026-09-01T12:00:00Z',
  ...overrides,
});
function renderDrawer(run: FillRun | null = null) {
  getMock.mockImplementation(async (url: string) => ({
    data: url.endsWith('/advocacy-matters') ? [] : run,
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(ClientFillWithMeriDrawer, {
        clientId: 'client-1',
        clientName: 'L3 Harris',
        open: true,
        onClose: vi.fn(),
      }),
    ),
  );
  return { ...view, client };
}
beforeEach(() => {
  getMock.mockReset();
  postMock.mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Client Fill with Meri document and review contracts', () => {
  it('uploads and confirms a document before starting its attachment-scoped review', async () => {
    const storage = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('fetch', storage);
    postMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/upload-url'))
        return {
          data: { url: 'https://storage.example/upload', fields: {}, s3Key: 'document.pdf' },
        };
      if (url.endsWith('/confirm')) return { data: { id: 'attachment-1' } };
      return { data: { ...baseRun, status: 'running' } };
    });
    const { container } = renderDrawer();
    await screen.findByRole('button', { name: 'Add a capability document' });
    expect(postMock).not.toHaveBeenCalled();
    fireEvent.change(container.querySelector('input[type="file"]')!, {
      target: {
        files: [new File(['Capability details'], 'document.pdf', { type: 'application/pdf' })],
      },
    });
    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith('/api/clients/client-1/fill-with-meri/runs', {
        attachmentId: 'attachment-1',
      }),
    );
    expect(postMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/engagement/attachments/upload-url',
      '/api/engagement/attachments/confirm',
      '/api/clients/client-1/fill-with-meri/runs',
    ]);
    expect(storage).toHaveBeenCalledWith(
      'https://storage.example/upload',
      expect.objectContaining({ method: 'POST', body: expect.any(FormData) }),
    );
  });
  it('does not start a review when the document upload fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false })),
    );
    postMock.mockResolvedValue({
      data: { url: 'https://storage.example/upload', fields: {}, s3Key: 'document.pdf' },
    });
    const { container } = renderDrawer();
    await screen.findByRole('button', { name: 'Add a capability document' });
    fireEvent.change(container.querySelector('input[type="file"]')!, {
      target: { files: [new File(['x'], 'document.pdf')] },
    });
    expect(await screen.findByText('Storage rejected the upload')).toBeInTheDocument();
    expect(postMock).toHaveBeenCalledTimes(1);
  });
  it('retries the persisted attachment instead of silently launching a website review', async () => {
    postMock.mockResolvedValue({ data: baseRun });
    renderDrawer({
      ...baseRun,
      status: 'failed',
      sourceStates: { client_document: { status: 'failed', attachmentId: 'original-document' } },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith('/api/clients/client-1/fill-with-meri/runs', {
        attachmentId: 'original-document',
      }),
    );
  });
  it('does not retry a document review whose original attachment is unavailable', async () => {
    renderDrawer({
      ...baseRun,
      status: 'failed',
      sourceStates: { client_document: { status: 'failed' } },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(
      await screen.findByText(/The original document is no longer available for retry\./),
    ).toBeInTheDocument();
    expect(postMock).not.toHaveBeenCalled();
  });
  it('starts website research only after the user requests it', async () => {
    postMock.mockResolvedValue({ data: baseRun });
    renderDrawer();
    await screen.findByRole('button', { name: 'Start the review' });
    expect(postMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Review source settings'));
    fireEvent.change(screen.getByLabelText('Company website'), {
      target: { value: 'https://example.org' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Start the review' }));
    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith('/api/clients/client-1/fill-with-meri/runs', {
        website: 'https://example.org',
      }),
    );
  });
  it('keeps proposals staged until Apply and refreshes advocacy after saving', async () => {
    postMock.mockResolvedValue({ data: { applied: 1, failed: 0 } });
    const { client } = renderDrawer({ ...baseRun, findings: [proposal()] });
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    fireEvent.click(await screen.findByRole('button', { name: 'Accept' }));
    expect(postMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Apply 1 update' }));
    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith(
        '/api/clients/client-1/fill-with-meri/runs/run-1/apply',
        { findingIds: ['finding-1'] },
      ),
    );
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['client-advocacy-matters', 'client-1'] });
  });
  it('shows informational context without offering to apply it', async () => {
    renderDrawer({
      ...baseRun,
      findings: [
        proposal({
          status: 'informational',
          source: 'public_web',
          proposedValue: 'Related company context',
        }),
      ],
    });
    expect(await screen.findByText('Related company context')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Apply 0 updates' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Accept' })).not.toBeInTheDocument();
    expect(postMock).not.toHaveBeenCalled();
  });
  it('groups advocacy outcomes for review without claiming advocacy caused them', async () => {
    postMock.mockResolvedValue({ data: {} });
    renderDrawer({
      ...baseRun,
      findings: [
        proposal({
          kind: 'advocacy_outcome',
          targetKey: 'outcome',
          source: 'lda',
          proposedValue: { title: 'Funding change' },
        }),
      ],
    });
    expect(
      await screen.findByRole('button', { name: /Advocacy\s*1 to review/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "This may be a related outcome. Applying it does not claim the client's advocacy caused it.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Attach to Matter' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Not advocacy' }));
    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith(
        '/api/clients/client-1/fill-with-meri/findings/finding-1/reject',
        { reason: 'Not advocacy (reviewed in Fill with Meri)' },
      ),
    );
  });
});
