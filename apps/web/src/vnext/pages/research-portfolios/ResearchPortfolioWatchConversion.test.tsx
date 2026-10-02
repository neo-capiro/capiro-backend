import { ChangesAndSubscriptions, DurableOutputs } from './ResearchPortfolioAnalyticsPanel.js';
import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
const authority = vi.hoisted(() => ({ userId: 'actor-a', orgId: 'tenant-a' }));
const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('@clerk/clerk-react', () => ({ useAuth: () => authority }));
vi.mock('../../../lib/use-api.js', () => ({ useApi: () => api }));
vi.mock('../../../state/impersonation.js', () => ({
  useImpersonation: () => ({ actAsTenantSlug: null }),
}));
const portfolio: any = {
  id: 'portfolio-a',
  revision: 4,
  name: 'Owned',
  myRole: 'owner',
  lifecycle: 'active',
  clientLinks: [{ clientId: 'client-a', clientName: 'Owned destination' }],
};
const watchId = '11111111-1111-4111-8111-111111111111';
const preview = {
  portfolioId: portfolio.id,
  expectedRevision: 4,
  previewHash: 'a'.repeat(64),
  legacyWatches: 2,
  convertibleWatches: 1,
  alreadyConverted: 0,
  limitations: ['Legacy watches stay unchanged'],
  previewItems: [
    {
      watchId,
      userId: 'actor-a',
      channel: 'in_app',
      legacyKind: 'program_element',
      targetKind: 'program_element',
      targetId: '0604115A',
      active: false,
      reason: 'convertible',
      willConvert: true,
    },
    {
      watchId: '22222222-2222-4222-8222-222222222222',
      userId: 'actor-a',
      channel: 'in_app',
      legacyKind: 'program_element',
      targetKind: 'program_element',
      targetId: 'outside-member',
      active: false,
      reason: 'not_included_member',
      willConvert: false,
    },
  ],
};
const oldApiPreview = {
  portfolioId: portfolio.id,
  legacyWatches: 0,
  convertibleWatches: 0,
  alreadyConverted: 0,
  previewItems: [],
};
const receipt = {
  portfolioId: portfolio.id,
  idempotencyKey: 'echo-original',
  revision: 5,
  convertedCount: 1,
  skippedCount: 0,
  limitations: ['Dormant only; no notifications sent'],
};
const job: any = {
  id: 'job-a',
  status: 'completed',
  attemptCount: 1,
  updatedAt: '2026-09-28T00:00:00Z',
  artifact: { id: 'artifact-a', fileName: 'owned.csv', contentHash: 'a'.repeat(64), byteSize: 5 },
};
let client: QueryClient;
let previewPayload: unknown;
let previewFailure: unknown | null;
let applyFailure: unknown | null;
let applyResponse: unknown | null;
function tree(outputs = false) {
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter>
        {outputs ? (
          <DurableOutputs portfolio={portfolio} />
        ) : (
          <ChangesAndSubscriptions portfolio={portfolio} />
        )}
      </MemoryRouter>
    </QueryClientProvider>
  );
}
function applyCalls() {
  return api.post.mock.calls.filter((call) => String(call[0]).endsWith('/watch-conversion/apply'));
}
function outputCalls() {
  return api.post.mock.calls.filter((call) => String(call[0]).endsWith('/outputs'));
}
function filingCalls() {
  return api.post.mock.calls.filter((call) => String(call[0]).endsWith('/client-files'));
}
function captured(calls: any[][], index: number) {
  const value = calls[index];
  if (!value) throw Error('Missing captured POST');
  return value[1];
}
async function select() {
  fireEvent.click(screen.getByRole('button', { name: 'Preview my legacy watches' }));
  await screen.findByLabelText('Convert legacy watch for PE 0604115A');
  fireEvent.click(screen.getByLabelText('Convert legacy watch for PE 0604115A'));
  fireEvent.click(
    screen.getByLabelText('I confirm creating dormant watches without sending notifications.'),
  );
}
beforeEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
  authority.userId = 'actor-a';
  authority.orgId = 'tenant-a';
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  previewPayload = preview;
  previewFailure = null;
  applyFailure = null;
  applyResponse = null;
  api.get.mockReset().mockImplementation(async (url: string) => ({
    data: url.endsWith('/changes')
      ? { items: [], nextCursor: null }
      : url.includes('/output-jobs/')
        ? job
        : [],
  }));
  api.post.mockReset().mockImplementation(async (url: string, body?: any) => {
    if (url.endsWith('/watch-conversion/preview')) {
      if (previewFailure) {
        const error = previewFailure;
        previewFailure = null;
        throw error;
      }
      return { data: previewPayload };
    }
    if (url.endsWith('/watch-conversion/apply')) {
      if (applyFailure) {
        const error = applyFailure;
        applyFailure = null;
        throw error;
      }
      const data = applyResponse ?? { ...receipt, idempotencyKey: body?.idempotencyKey };
      applyResponse = null;
      return { data };
    }
    return {
      data: url.endsWith('/client-files')
        ? {
            id: 'receipt-file',
            attachmentName: 'Owned.csv',
            scanStatus: 'clean',
            openPath: '/clients',
          }
        : job,
    };
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
describe('explicit dormant watch conversion and closed-session recovery', () => {
  it('shows an unavailable state and sends no conversion against an older API preview', async () => {
    previewPayload = oldApiPreview;
    render(tree());
    fireEvent.click(screen.getByRole('button', { name: 'Preview my legacy watches' }));
    expect(await screen.findByText(/Watch conversion is unavailable/)).toHaveAttribute(
      'role',
      'alert',
    );
    expect(screen.getByRole('button', { name: 'Create selected dormant watches' })).toBeDisabled();
    expect(
      screen.getByLabelText('I confirm creating dormant watches without sending notifications.'),
    ).toBeDisabled();
    expect(applyCalls()).toHaveLength(0);
  });
  it('previews on request, requires selected eligible rows and explicit dormant confirmation, and sends exact DTO', async () => {
    render(tree());
    expect(api.post).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Create selected dormant watches' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Preview my legacy watches' }));
    await screen.findByLabelText('Convert legacy watch for PE 0604115A');
    expect(screen.getByLabelText('Convert legacy watch for PE outside-member')).toBeDisabled();
    fireEvent.click(screen.getByLabelText('Convert legacy watch for PE 0604115A'));
    expect(screen.getByRole('button', { name: 'Create selected dormant watches' })).toBeDisabled();
    fireEvent.click(
      screen.getByLabelText('I confirm creating dormant watches without sending notifications.'),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Create selected dormant watches' }));
    await screen.findByText('Created 1 dormant watches; skipped 0. No notifications were sent.');
    expect(captured(applyCalls(), 0)).toEqual({
      idempotencyKey: expect.any(String),
      expectedRevision: 4,
      previewHash: preview.previewHash,
      selectedWatchIds: [watchId],
    });
    expect(
      api.get.mock.calls.filter((call) => String(call[0]).endsWith('/subscriptions')).length,
    ).toBeGreaterThan(1);
  });
  it('does not POST Apply when a current preview is cached but the API has rolled back', async () => {
    render(tree());
    await select();
    previewPayload = oldApiPreview;
    fireEvent.click(screen.getByRole('button', { name: 'Create selected dormant watches' }));
    await screen.findByText('Watch conversion was not sent. Review a fresh preview and retry.');
    expect(applyCalls()).toHaveLength(0);
    expect(localStorage.length).toBe(0);
  });
  it('does not POST Apply when the fresh preview request fails', async () => {
    render(tree());
    await select();
    previewFailure = { response: { status: 503 } };
    fireEvent.click(screen.getByRole('button', { name: 'Create selected dormant watches' }));
    await screen.findByText('Watch conversion was not sent. Review a fresh preview and retry.');
    expect(applyCalls()).toHaveLength(0);
    expect(localStorage.length).toBe(0);
  });
  it('does not POST Apply when the fresh revision or preview hash changed', async () => {
    render(tree());
    await select();
    previewPayload = { ...preview, previewHash: 'b'.repeat(64) };
    fireEvent.click(screen.getByRole('button', { name: 'Create selected dormant watches' }));
    await screen.findByText('Watch conversion was not sent. Review a fresh preview and retry.');
    expect(applyCalls()).toHaveLength(0);
    expect(localStorage.length).toBe(0);
  });
  it('keeps original selection/hash/revision/key after uncertain response and session close without autosend', async () => {
    const first = render(tree());
    await select();
    applyFailure = { response: { status: 503 } };
    fireEvent.click(screen.getByRole('button', { name: 'Create selected dormant watches' }));
    await waitFor(() => expect(applyCalls()).toHaveLength(1));
    const original = captured(applyCalls(), 0);
    first.unmount();
    sessionStorage.clear();
    previewPayload = oldApiPreview;
    render(tree());
    await screen.findByRole('button', { name: 'Reconcile exact watch conversion' });
    expect(applyCalls()).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Reconcile exact watch conversion' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Preview my legacy watches' }));
    expect(await screen.findByText(/Watch conversion is unavailable/)).toHaveAttribute(
      'role',
      'alert',
    );
    expect(screen.getByRole('button', { name: 'Reconcile exact watch conversion' })).toBeDisabled();
    expect(applyCalls()).toHaveLength(1);
    previewPayload = preview;
    fireEvent.click(screen.getByRole('button', { name: 'Preview my legacy watches' }));
    await screen.findByLabelText('Convert legacy watch for PE 0604115A');
    expect(screen.getByRole('button', { name: 'Reconcile exact watch conversion' })).toBeEnabled();
    previewPayload = oldApiPreview;
    fireEvent.click(screen.getByRole('button', { name: 'Reconcile exact watch conversion' }));
    await screen.findByText(/Watch conversion is unconfirmed/);
    expect(applyCalls()).toHaveLength(1);
    expect(JSON.parse(localStorage.getItem(localStorage.key(0) ?? '') ?? 'null')).toEqual(original);
    previewPayload = preview;
    fireEvent.click(screen.getByRole('button', { name: 'Reconcile exact watch conversion' }));
    await screen.findByText('Created 1 dormant watches; skipped 0. No notifications were sent.');
    expect(captured(applyCalls(), 1)).toEqual(original);
  });
  it('retains unknown selection after a later definitive rejection', async () => {
    const first = render(tree());
    await select();
    applyFailure = { response: { status: 503 } };
    fireEvent.click(screen.getByRole('button', { name: 'Create selected dormant watches' }));
    await waitFor(() => expect(applyCalls()).toHaveLength(1));
    const original = captured(applyCalls(), 0);
    first.unmount();
    render(tree());
    fireEvent.click(screen.getByRole('button', { name: 'Preview my legacy watches' }));
    await screen.findByLabelText('Convert legacy watch for PE 0604115A');
    applyFailure = { response: { status: 422 } };
    fireEvent.click(
      await screen.findByRole('button', { name: 'Reconcile exact watch conversion' }),
    );
    await screen.findByText(/Watch conversion is unconfirmed/);
    expect(captured(applyCalls(), 1)).toEqual(original);
    expect(screen.getByRole('button', { name: 'Reconcile exact watch conversion' })).toBeEnabled();
  });
  it('retains the exact request if an older API returns a bodyless no-op receipt', async () => {
    render(tree());
    await select();
    applyResponse = { portfolioId: portfolio.id, convertedCount: 0, skippedCount: 0 };
    fireEvent.click(screen.getByRole('button', { name: 'Create selected dormant watches' }));
    await screen.findByText(/Watch conversion is unconfirmed/);
    expect(applyCalls()).toHaveLength(1);
    expect(screen.queryByText(/Created 0 dormant watches/)).not.toBeInTheDocument();
    expect(localStorage.length).toBe(1);
  });
  it('storage quota stops conversion before POST', async () => {
    render(tree());
    await select();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw Error('quota');
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create selected dormant watches' }));
    await screen.findByText(/No conversion was sent/);
    expect(applyCalls()).toHaveLength(0);
  });
  it('actor scope switch hides old retained selection and cannot reconcile another actor operation', async () => {
    const view = render(tree());
    await select();
    applyFailure = { response: { status: 503 } };
    fireEvent.click(screen.getByRole('button', { name: 'Create selected dormant watches' }));
    await waitFor(() => expect(applyCalls()).toHaveLength(1));
    const previewCallsBeforeActorSwitch = api.post.mock.calls.filter((call) =>
      String(call[0]).endsWith('/watch-conversion/preview'),
    ).length;
    authority.userId = 'actor-b';
    view.rerender(tree());
    expect(
      screen.queryByRole('button', { name: 'Reconcile exact watch conversion' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Convert legacy watch for PE 0604115A')).not.toBeInTheDocument();
    expect(
      api.post.mock.calls.filter((call) => String(call[0]).endsWith('/watch-conversion/preview')),
    ).toHaveLength(previewCallsBeforeActorSwitch);
  });
  it('viewer can inspect own preview but cannot send a conversion', async () => {
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <ChangesAndSubscriptions portfolio={{ ...portfolio, myRole: 'viewer' }} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Preview my legacy watches' }));
    await screen.findByLabelText('Convert legacy watch for PE 0604115A');
    expect(screen.getByLabelText('Convert legacy watch for PE 0604115A')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Create selected dormant watches' })).toBeDisabled();
    expect(applyCalls()).toHaveLength(0);
  });
  it('output creation survives closed-session loss and explicitly retries original durable identity', async () => {
    api.post.mockRejectedValueOnce({ response: { status: 503 } });
    const first = render(tree(true));
    fireEvent.click(screen.getByRole('button', { name: 'Build CSV' }));
    await waitFor(() => expect(outputCalls()).toHaveLength(1));
    const original = captured(outputCalls(), 0);
    first.unmount();
    sessionStorage.clear();
    render(tree(true));
    fireEvent.click(await screen.findByRole('button', { name: 'Retry exact CSV request' }));
    await screen.findByText('Job job-a');
    expect(captured(outputCalls(), 1)).toEqual(original);
  });
  it('client filing survives closed-session loss without a replacement write identity', async () => {
    const first = render(tree(true));
    fireEvent.click(screen.getByRole('button', { name: 'Build CSV' }));
    await screen.findByText('Job job-a');
    api.post.mockRejectedValueOnce({ response: { status: 503 } });
    fireEvent.click(screen.getByRole('button', { name: /Save exact file/ }));
    await waitFor(() => expect(filingCalls()).toHaveLength(1));
    const original = captured(filingCalls(), 0);
    first.unmount();
    sessionStorage.clear();
    render(tree(true));
    await screen.findByText('Job job-a');
    expect(filingCalls()).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Reconcile exact client filing' }));
    await screen.findByText(/Saved as Owned.csv/);
    expect(captured(filingCalls(), 1)).toEqual(original);
  });
});
