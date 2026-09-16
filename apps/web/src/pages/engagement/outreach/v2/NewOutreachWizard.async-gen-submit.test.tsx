// Regression for the async generation submit path (features.outreachAsyncGen):
// submitGenerateJobs used to submit jobs WITHOUT ensureDraftRecord()/
// outreachRecordId, so under versioned outreach the worker's
// generateBatchEmails rejected every item before any AI call
// ("outreachRecordId is required: ...") and the wizard rendered a reasonless
// placeholder. These tests pin the sync-parity contract:
//   - the protected draft record is created exactly ONCE before submission;
//   - outreachRecordId + per-slot generationKeys ride the job submit;
//   - a record-create failure submits NO job and surfaces the save error.
//
// Same mocking pattern as NewOutreachWizard.step5-empty-context.test.tsx:
// a record hydrated at the pool step; clicking Continue lands on Generate &
// Review where the auto-generate effect runs — but with outreachAsyncGen on
// it must go through the async job submit, not generate-batch.

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { NewOutreachWizard } from './NewOutreachWizard.js';
import type { OutreachRecord } from '../../OutreachView.js';

function setupBrowserMocks() {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
  class ResizeObserverMock {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', ResizeObserverMock);
}
setupBrowserMocks();

vi.mock('@clerk/clerk-react', () => ({
  useUser: () => ({ user: { fullName: 'Test User', firstName: 'Test', lastName: 'User' } }),
}));

vi.mock('../../../../lib/me.js', () => ({
  useMe: () => ({
    data: {
      user: { id: 'u1', clerkUserId: 'c1', email: 'a@x.com', firstName: 'A', lastName: 'B' },
      tenant: { id: 't1', slug: 'acme', name: 'Acme' },
      role: 'user_admin',
      billingAdmin: false,
      features: { versionedOutreach: true, outreachAsyncGen: true },
    },
    isLoading: false,
  }),
}));

const apiGetMock = vi.fn(async (url: string) => {
  if (url === '/api/engagement/attachments') return { data: [] };
  if (url === '/api/engagement/outreach/templates') return { data: [] };
  if (url === '/api/engagement/outreach/context-library') {
    return { data: { documents: [], debriefs: [], preps: [] } };
  }
  if (url === '/api/engagement/outreach/insights') return { data: {} };
  if (url.startsWith('/api/engagement/mail-threads')) return { data: [] };
  if (url.startsWith('/api/program-elements')) return { data: { data: [] } };
  if (url.endsWith('/draft-artifacts')) return { data: [] };
  if (url === '/api/engagement/outreach/jobs/job-1') return { data: jobResponse };
  return { data: {} };
});

// POST /api/engagement/outreach creates the protected record.
let createRecordSucceeds = true;
// The GET /outreach/jobs/:id response body — tests swap this to drive the
// poller through a real settle. Shape matches OutreachJobResponse exactly.
let jobResponse: {
  job: { id: string; status: 'queued' | 'running' | 'partial' | 'complete' | 'failed' | 'canceled' };
  items: Array<{
    id: string;
    recipientKey: string;
    status: 'pending' | 'claimed' | 'generating' | 'done' | 'failed' | 'sending' | 'sent' | 'skipped' | 'held';
    result: Record<string, unknown> | null;
    error: string | null;
    attempt: number;
  }>;
};
const apiPostMock = vi.fn(async (url: string, _body?: unknown) => {
  if (url === '/api/engagement/outreach') {
    if (!createRecordSucceeds) {
      throw Object.assign(
        new Error('property audienceType should not exist'),
        {
          response: {
            status: 400,
            data: { message: 'property audienceType should not exist' },
          },
        },
      );
    }
    return { data: { id: 'rec-created-1' } };
  }
  if (url === '/api/engagement/outreach/jobs/generate') {
    return { data: { jobId: 'job-1', deduped: false } };
  }
  if (url === '/api/engagement/outreach/generate-batch') {
    return { data: { results: [] } };
  }
  return { data: {} };
});

vi.mock('../../../../lib/use-api.js', () => ({
  useApi: () => ({
    get: apiGetMock,
    post: apiPostMock,
    put: vi.fn(async () => ({ data: {} })),
    patch: vi.fn(async () => ({ data: {} })),
    delete: vi.fn(async () => ({ data: {} })),
  }),
}));

function renderWizard(initialRecord: OutreachRecord | null, draftIdOverride?: string | null) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AntApp>
        <NewOutreachWizard
          clients={[]}
          selectedClientId={null}
          aiConfigured={true}
          emailConnected={true}
          sendFrom="me@example.com"
          sendableInboxes={[]}
          onCancel={() => {}}
          onComplete={() => {}}
          initialRecord={initialRecord}
          initialDraftId={draftIdOverride !== undefined ? draftIdOverride : (initialRecord?.id ?? null)}
        />
      </AntApp>
    </QueryClientProvider>,
  );
}

/** A draft saved at the Context Builder step, one individual recipient. */
function savedRecordAtPoolStep(): OutreachRecord {
  return {
    id: 'rec-1',
    clientId: null,
    meetingId: null,
    type: 'campaign',
    status: 'draft',
    title: 'QA generation verification',
    subject: null,
    body: null,
    recipients: [{ id: 'rec-a', name: 'Synthetic QA', email: 'qa-generation@example.com' }],
    recipientCount: 1,
    stats: null,
    metadata: {
      lastStep: 5,
      lastStepId: 'pool',
      tone: 'professional',
      templateId: null,
      perRecipientEmails: [],
      generatedByKey: {},
      contextItems: [],
      mainIdea: 'Ask whether they would like to schedule a product walkthrough next week.',
      attachmentIds: [],
      targets: [
        {
          key: 't1',
          type: 'individual',
          recipients: [
            { id: 'rec-a', name: 'Synthetic QA', email: 'qa-generation@example.com' },
          ],
          cc: [],
          bcc: [],
        },
      ],
      collisionResolution: null,
    },
    lastStep: 5,
    sentAt: null,
    openedInEmailAt: null,
    createdAt: '2026-09-16T00:00:00.000Z',
    updatedAt: '2026-09-16T00:00:00.000Z',
    client: null,
    meeting: null,
  } as unknown as OutreachRecord;
}

describe('Async generation submit (outreachAsyncGen + versionedOutreach)', () => {
  beforeEach(() => {
    apiPostMock.mockClear();
    apiGetMock.mockClear();
    createRecordSucceeds = true;
    // Default: an immediately-terminal failed job with one item for rec-a —
    // individual tests override for success/settle scenarios.
    jobResponse = {
      job: { id: 'job-1', status: 'failed' },
      items: [
        {
          id: 'it-1',
          recipientKey: 'rec-a',
          status: 'failed',
          result: null,
          error: 'outreachRecordId is required: a draft must be saved before it can be generated.',
          attempt: 1,
        },
      ],
    };
  });

  test('creates the protected record ONCE before submitting the job with outreachRecordId + generationKeys', async () => {
    // draftId null: no record id yet, so ensureDraftRecord must CREATE one —
    // exactly the new-campaign situation the live canary reproduced.
    renderWizard(savedRecordAtPoolStep(), null);
    await waitFor(() => expect(screen.getByText('Add context from your sources')).toBeTruthy());
    const continueBtn = await waitFor(() => {
      const btn = screen.getByRole('button', { name: /Continue/ }) as HTMLButtonElement;
      expect(btn).toBeTruthy();
      return btn;
    });
    await waitFor(() => expect(continueBtn.disabled).toBe(false));
    fireEvent.click(continueBtn);

    // The async job submit must happen (NOT the sync generate-batch).
    await waitFor(() =>
      expect(
        apiPostMock.mock.calls.some(([url]) => url === '/api/engagement/outreach/jobs/generate'),
      ).toBe(true),
    );

    // The protected record was created exactly once, BEFORE the job submit.
    const recordCalls = apiPostMock.mock.calls.filter(([url]) => url === '/api/engagement/outreach');
    expect(recordCalls).toHaveLength(1);
    const recordIdx = apiPostMock.mock.calls.findIndex(
      ([url]) => url === '/api/engagement/outreach',
    );
    const jobIdx = apiPostMock.mock.calls.findIndex(
      ([url]) => url === '/api/engagement/outreach/jobs/generate',
    );
    expect(recordIdx).toBeGreaterThanOrEqual(0);
    expect(jobIdx).toBeGreaterThan(recordIdx);

    // The job body carries the record id and per-slot generationKeys.
    const jobBody = apiPostMock.mock.calls.find(
      ([url]) => url === '/api/engagement/outreach/jobs/generate',
    )?.[1] as Record<string, unknown>;
    expect(jobBody?.outreachRecordId).toBe('rec-created-1');
    const recipients = jobBody?.recipients as Array<Record<string, unknown>>;
    expect(recipients).toHaveLength(1);
    expect(recipients[0]!.generationKeys).toEqual(['individual:rec-a']);

    // The sync endpoint was NOT used.
    expect(
      apiPostMock.mock.calls.some(([url]) => url === '/api/engagement/outreach/generate-batch'),
    ).toBe(false);
  });

  test('submits NO job when the record cannot be created — the save error is surfaced instead', async () => {
    createRecordSucceeds = false;
    renderWizard(savedRecordAtPoolStep(), null);
    await waitFor(() => expect(screen.getByText('Add context from your sources')).toBeTruthy());
    const continueBtn = await waitFor(() => {
      const btn = screen.getByRole('button', { name: /Continue/ }) as HTMLButtonElement;
      expect(btn).toBeTruthy();
      return btn;
    });
    await waitFor(() => expect(continueBtn.disabled).toBe(false));
    fireEvent.click(continueBtn);

    // The record-create attempt actually happened, and the error was surfaced.
    await waitFor(() =>
      expect(
        apiPostMock.mock.calls.some(([url]) => url === '/api/engagement/outreach'),
      ).toBe(true),
    );
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        'Could not create the protected draft record, so generation was not started',
      ),
    );

    // No retry loop: after the rejected save settles, give any effect-driven
    // submission a real chance to (wrongly) fire, then assert none did.
    await new Promise((r) => setTimeout(r, 250));
    expect(
      apiPostMock.mock.calls.some(([url]) => url === '/api/engagement/outreach/jobs/generate'),
    ).toBe(false);
    expect(
      apiPostMock.mock.calls.some(([url]) => url === '/api/engagement/outreach/generate-batch'),
    ).toBe(false);
    // And no record-create retry loop either.
    expect(
      apiPostMock.mock.calls.filter(([url]) => url === '/api/engagement/outreach').length,
    ).toBeLessThanOrEqual(1);
  });

  test('a failed job item surfaces the worker error in the draft banner (end-to-end)', async () => {
    renderWizard(savedRecordAtPoolStep(), null);
    const continueBtn = await waitFor(() => {
      const btn = screen.getByRole('button', { name: /Continue/ }) as HTMLButtonElement;
      expect(btn).toBeTruthy();
      return btn;
    });
    await waitFor(() => expect(continueBtn.disabled).toBe(false));
    fireEvent.click(continueBtn);

    // The job was submitted and the poller fetched the (terminal) job state.
    await waitFor(() =>
      expect(
        apiGetMock.mock.calls.some(([url]) => url === '/api/engagement/outreach/jobs/job-1'),
      ).toBe(true),
    );

    // THE regression: the failure banner shows the worker's persisted error
    // verbatim instead of the generic reasonless copy.
    await waitFor(() =>
      expect(
        screen.getByText(/outreachRecordId is required: a draft must be saved before it can be generated\./),
      ).toBeTruthy(),
    );
    expect(screen.getByText("This draft couldn't be generated")).toBeTruthy();

    // Let the job settle (terminal status → polling stops, no teardown timers).
    await new Promise((r) => setTimeout(r, 250));
  });
});