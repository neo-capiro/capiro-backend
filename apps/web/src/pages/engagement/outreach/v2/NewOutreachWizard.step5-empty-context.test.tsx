// Step 5 (Context Builder) regression — "Continue must work with empty context".
//
// Defect (2026-09-16, signed-in reproduction on an auto-started failed campaign):
// canAdvance gated the 'pool' step on at least one selected context item, so a
// campaign with a main idea but no pool ticks was dead-ended at step 5 — and on
// a resumed failed generation that gate blocked the only path forward.
//
// This mounts the REAL NewOutreachWizard resumed at the pool step with
// contextItems: [] and asserts:
//   1. the Continue button is enabled with zero context selected;
//   2. clicking it advances to Generate & Review;
//   3. the auto-generate effect fires the real generate-batch POST with the
//      correct request — contextItems: [] included, main idea preserved.
//
// Same mocking pattern as NewOutreachWizard.resume-and-upload.test.tsx.

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
      features: { versionedOutreach: true, outreachAsyncGen: false },
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
  return { data: {} };
});
const apiPostMock = vi.fn(async (url: string, _body?: unknown) => {
  if (url === '/api/engagement/outreach/generate-batch') {
    return { data: { results: [] } };
  }
  return { data: { id: 'rec-1' } };
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
          sendableInboxes={[
            { id: 'inbox-1', provider: 'microsoft_365', accountEmail: 'me@example.com' } as never,
          ]}
          onCancel={() => {}}
          onComplete={() => {}}
          initialRecord={initialRecord}
          initialDraftId={draftIdOverride !== undefined ? draftIdOverride : (initialRecord?.id ?? null)}
        />
      </AntApp>
    </QueryClientProvider>,
  );
}

/** A draft saved at the Context Builder step with NO context items selected. */
function savedRecordAtPoolStep(): OutreachRecord {
  return {
    id: 'rec-1',
    clientId: null,
    meetingId: null,
    type: 'campaign',
    status: 'draft',
    title: 'FY27 Outreach',
    subject: null,
    body: null,
    recipients: [{ id: 'rec-a', name: 'Jane Staffer', email: 'jane@house.gov' }],
    recipientCount: 1,
    stats: null,
    metadata: {
      lastStep: 5,
      lastStepId: 'pool',
      tone: 'professional',
      templateId: null,
      perRecipientEmails: [],
      generatedByKey: {},
      // The defect: zero context selected, main idea carried the campaign.
      contextItems: [],
      mainIdea: 'Request a meeting about the FY27 defense appropriation.',
      attachmentIds: [],
      targets: [
        {
          key: 't1',
          type: 'individual',
          recipients: [{ id: 'rec-a', name: 'Jane Staffer', email: 'jane@house.gov' }],
          cc: [],
          bcc: [],
        },
      ],
      collisionResolution: null,
    },
    lastStep: 5,
    sentAt: null,
    openedInEmailAt: null,
    createdAt: '2026-09-10T00:00:00.000Z',
    updatedAt: '2026-09-10T00:00:00.000Z',
    client: null,
    meeting: null,
  } as unknown as OutreachRecord;
}

describe('Step 5 Context Builder with empty context', () => {
  beforeEach(() => {
    apiPostMock.mockClear();
    apiGetMock.mockClear();
    // Restore the default (permissive) implementation: a previous test's
    // mockImplementation rejection must not poison this describe's other cases.
    apiPostMock.mockImplementation(async (url: string, _body?: unknown) => {
      if (url === '/api/engagement/outreach/generate-batch') {
        return { data: { results: [] } };
      }
      return { data: { id: 'rec-1' } };
    });
  });

  test('a record-create failure on the sync path surfaces the wrapped reason on the draft, not a generic placeholder', async () => {
    // draftId null so ensureDraftRecord must CREATE the record — the exact
    // path a new campaign takes before its first generation.
    apiPostMock.mockImplementation(async (url: string) => {
      if (url === '/api/engagement/outreach') {
        throw Object.assign(new Error('property audienceType should not exist'), {
          response: {
            status: 400,
            data: { message: 'property audienceType should not exist' },
          },
        });
      }
      return { data: { id: 'rec-1' } };
    });
    renderWizard(savedRecordAtPoolStep(), null);
    const continueBtn = await waitFor(() => {
      const btn = screen.getByRole('button', { name: /Continue/ }) as HTMLButtonElement;
      expect(btn).toBeTruthy();
      return btn;
    });
    await waitFor(() => expect(continueBtn.disabled).toBe(false));
    fireEvent.click(continueBtn);

    // The failure banner carries the wrapped preflight reason verbatim.
    await waitFor(() =>
      expect(
        screen.getByText(/Could not create the protected draft record, so generation was not started/),
      ).toBeTruthy(),
    );
    const generateStep = screen.getByText('Generate & review').closest('div');
    expect(generateStep?.textContent).toContain('property audienceType should not exist');

    // No generation POST was ever made (the preflight blocked it).
    expect(
      apiPostMock.mock.calls.some(([url]) => url === '/api/engagement/outreach/generate-batch'),
    ).toBe(false);
  });

  test('Continue is enabled with zero context, advances, and generation sends contextItems: []', async () => {
    renderWizard(savedRecordAtPoolStep());

    // The honest optional-copy note is visible on the pool step.
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Add context' })).toBeTruthy());
    expect(screen.getByText(/Context is optional/)).toBeTruthy();

    // THE defect: Continue must be enabled with an empty context pool.
    const continueBtn = await waitFor(() => {
      const btn = screen.getByRole('button', { name: /Continue/ }) as HTMLButtonElement;
      expect(btn).toBeTruthy();
      return btn;
    });
    await waitFor(() => expect(continueBtn.disabled).toBe(false));

    fireEvent.click(continueBtn);

    // Advances to Generate & Review, where the auto-generate effect fires.
    await waitFor(() => expect(screen.getByText('Generate & review')).toBeTruthy());
    await waitFor(() => {
      expect(
        apiPostMock.mock.calls.some(([url]) => url === '/api/engagement/outreach/generate-batch'),
      ).toBe(true);
    });

    // The generate request is CORRECT: empty context travels as [], and the
    // main idea from step 4 is preserved as the primary driver.
    const generateCall = apiPostMock.mock.calls.find(
      ([url]) => url === '/api/engagement/outreach/generate-batch',
    )!;
    const body = generateCall[1] as {
      contextItems: unknown[];
      mainIdea?: string;
      recipients: Array<{ generationKeys?: string[] }>;
    };
    expect(body.contextItems).toEqual([]);
    expect(body.mainIdea).toBe('Request a meeting about the FY27 defense appropriation.');
    expect(body.recipients[0]!.generationKeys).toEqual(['individual:rec-a']);
  });
});
