// Bug reports (2026-09-03):
//   (1) resuming a saved draft at Generate & Review silently regenerates
//       every email instead of showing what was saved;
//   (2) "Upload a file" in that step's Attachments panel does nothing.
//
// Bug (2) is UNRESOLVED as of this file. An initial IAM root-cause theory
// (engagement-api's promoted task role missing kms:Encrypt/GenerateDataKey
// on the assets bucket's CMK) was drafted and then FALSIFIED by a live
// drift check: the real deployed bucket is SSE-S3 (AES256), not SSE-KMS as
// the CDK source declares (confirmed CloudFormation drift, not yet
// reconciled) — so that fix would have been a no-op against the actual
// live bucket and was deliberately NOT shipped. This file keeps a thin
// end-to-end smoke test for the upload flow's CLIENT side only (confirms
// the wizard still drives presign -> S3 POST -> confirm correctly); it does
// NOT assert anything about the still-open server-side root cause.
//
// Bug (1) root cause (proven against live CloudWatch logs + DB rows,
// 2026-09-03): metadata.generatedByKey is a CLIENT-WRITTEN cache that only
// updates on an explicit "Save as draft" click or ensureDraftRecord()'s
// generation-START save (itself an EMPTY map, written before any draft
// exists). A user who never re-saved after generation completed resumes to
// a record whose generatedByKey is still `{}` — even though the server's
// outreach_draft_artifacts/versions tables hold real, generated content —
// so every slot reads as "missing" and the wizard silently regenerates the
// whole campaign. Fix: on resume, fetch the real
// GET .../:id/draft-artifacts list and let it win over the stale cache
// before the auto-generate effect ever runs.
//
// Mounts the real NewOutreachWizard against a resumed OutreachRecord shaped
// exactly like what saveDraftMutation persists (metadata.generatedByKey +
// metadata.targets), same mocking pattern as engagement-url-state.test.tsx
// (useMe / useApi mocked, real component tree, real effects).

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
      // Live production config: ENGAGEMENT_VERSIONED_OUTREACH=true on both
      // capiro-dev-api and capiro-dev-engagement-api (checked 2026-09-03).
      features: { versionedOutreach: true, outreachAsyncGen: false },
    },
    isLoading: false,
  }),
}));

// The server-authoritative draft-artifacts list for the resumed record.
// Real generated content EXISTS server-side (matching the live production
// rows found during forensics) even though the record's cached
// metadata.generatedByKey (below, in savedDraftRecord) is empty/stale.
const draftArtifactsMock = vi.fn(async () => ({
  data: [
    {
      id: 'artifact-1',
      outreachRecordId: 'rec-1',
      generationKey: 'individual:rec-a',
      recipientKey: 'rec-a',
      audienceKind: 'individual',
      currentVersion: 1,
      current: {
        id: 'v-1',
        artifactId: 'artifact-1',
        version: 1,
        subject: 'Real saved subject',
        body: 'Real saved body from the server',
        generationStatus: 'generated',
        auditStatus: 'passed',
        approvalStatus: 'not_required',
        sendable: true,
      },
      history: [],
    },
  ],
}));

const apiGetMock = vi.fn(async (url: string) => {
  if (url === '/api/engagement/attachments') return { data: [] };
  if (url === '/api/engagement/outreach/templates') return { data: [] };
  if (url === '/api/engagement/outreach/context-library') {
    return { data: { documents: [], debriefs: [], preps: [] } };
  }
  if (url === '/api/engagement/outreach/insights') return { data: {} };
  if (url.endsWith('/draft-artifacts')) return draftArtifactsMock();
  return { data: {} };
});
const apiPostMock = vi.fn(async (url: string, _body?: unknown) => {
  if (url === '/api/engagement/outreach/generate-batch') {
    return { data: { results: [] } };
  }
  if (url === '/api/engagement/attachments/upload-url') {
    return { data: { url: 'https://s3.test/upload', fields: {}, s3Key: 'k1' } };
  }
  if (url === '/api/engagement/attachments/confirm') {
    return { data: { id: 'att-1' } };
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

// jsdom has no real fetch; the upload step PUTs bytes straight to the
// presigned S3 URL via the global fetch, bypassing `useApi()` entirely.
const fetchMock = vi.fn(async () => ({ ok: true, status: 204 }) as Response);
vi.stubGlobal('fetch', fetchMock);

function renderWizard(initialRecord: OutreachRecord | null) {
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
          initialDraftId={initialRecord?.id ?? null}
        />
      </AntApp>
    </QueryClientProvider>,
  );
}

/** A saved draft record whose CACHED metadata.generatedByKey is empty/stale
 *  — matching the exact live production shape found in forensics: the
 *  record was last saved at generation-START (ensureDraftRecord's empty-map
 *  write) and never saved again after generation completed, even though
 *  real content exists server-side (see draftArtifactsMock above). */
function savedDraftRecordWithStaleCache(): OutreachRecord {
  return {
    id: 'rec-1',
    clientId: null,
    meetingId: null,
    type: 'campaign',
    status: 'draft',
    title: 'My Campaign',
    subject: null,
    body: null,
    recipients: [{ id: 'rec-a', name: 'Jane Staffer', email: 'jane@house.gov' }],
    recipientCount: 1,
    stats: null,
    metadata: {
      lastStep: 5,
      lastStepId: 'generate',
      tone: 'professional',
      templateId: null,
      perRecipientEmails: [],
      // The stale cache: empty, exactly like the live "test" / "FY27 NDAA
      // Update" records found in production CloudWatch + DB forensics.
      generatedByKey: {},
      contextItems: [],
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
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    client: null,
    meeting: null,
  } as unknown as OutreachRecord;
}

describe('Resuming a saved draft at Generate & Review', () => {
  beforeEach(() => {
    apiPostMock.mockClear();
    apiGetMock.mockClear();
    draftArtifactsMock.mockClear();
  });

  test('submits the full three-person and two-person groups when generating real wizard drafts', async () => {
    draftArtifactsMock.mockResolvedValueOnce({ data: [] });
    const record = savedDraftRecordWithStaleCache();
    record.metadata = {
      ...(record.metadata as Record<string, unknown>),
      targets: [
        {
          key: 'group-a',
          audienceId: 'saved-a',
          type: 'group',
          name: 'First group',
          cc: [],
          bcc: [],
          recipients: ['a@example.test', 'b@example.test', 'c@example.test'].map((email) => ({
            email,
          })),
        },
        {
          key: 'group-b',
          audienceId: 'saved-b',
          type: 'group',
          name: 'Second group',
          cc: [],
          bcc: [],
          recipients: ['d@example.test', 'e@example.test'].map((email) => ({ email })),
        },
      ],
    };
    renderWizard(record);
    await waitFor(() =>
      expect(
        apiPostMock.mock.calls.filter(([url]) => url.endsWith('/generate-batch')),
      ).toHaveLength(2),
    );
    const payloads = apiPostMock.mock.calls
      .filter(([url]) => url.endsWith('/generate-batch'))
      .map(
        ([, body]) =>
          body as {
            recipients: Array<{ groupMembers: Array<{ email: string }>; generationKeys: string[] }>;
          },
      );
    expect(
      payloads.map((payload) => payload.recipients[0]!.groupMembers.map((member) => member.email)),
    ).toEqual([
      ['a@example.test', 'b@example.test', 'c@example.test'],
      ['d@example.test', 'e@example.test'],
    ]);
    expect(payloads.map((payload) => payload.recipients[0]!.generationKeys)).toEqual([
      ['group:saved-a'],
      ['group:saved-b'],
    ]);
  });

  test('does NOT call generate-batch when the cache is stale but the server has real content — backfills from draft-artifacts instead', async () => {
    renderWizard(savedDraftRecordWithStaleCache());

    // Resume lands directly on Generate & Review (lastStepId).
    await waitFor(() => expect(screen.getByText('Generate & review')).toBeTruthy());

    // The backfill fetch must actually happen.
    await waitFor(() =>
      expect(apiGetMock.mock.calls.some(([url]) => String(url).endsWith('/draft-artifacts'))).toBe(
        true,
      ),
    );

    // The real server-saved subject must appear — proof the backfill won
    // over the stale empty cache. Subject renders as an <Input value=...>,
    // not text content, so getByDisplayValue (not getByText) is required.
    await waitFor(() => expect(screen.getByDisplayValue('Real saved subject')).toBeTruthy());

    // Give any effect-driven generation a moment to fire if it's going to.
    await new Promise((r) => setTimeout(r, 50));

    const generateCalls = apiPostMock.mock.calls.filter(
      ([url]) => url === '/api/engagement/outreach/generate-batch',
    );
    expect(generateCalls).toHaveLength(0);
  });

  test('DOES auto-generate when a resumed draft truly has no content anywhere (cache empty AND server has no artifacts)', async () => {
    // A draft saved before Generate was ever run (e.g. saved from
    // Recipients) has recipients/targets but no generatedByKey entries AND
    // no server-side draft-artifacts rows — this case must still
    // auto-generate once, or the step would be permanently blank.
    draftArtifactsMock.mockResolvedValueOnce({ data: [] });
    const record = savedDraftRecordWithStaleCache();

    renderWizard(record);
    await waitFor(() => expect(screen.getByText('Generate & review')).toBeTruthy());

    await waitFor(() =>
      expect(
        apiPostMock.mock.calls.some(([url]) => url === '/api/engagement/outreach/generate-batch'),
      ).toBe(true),
    );
  });

  test('a resumed draft whose cache already matches the server is shown as-is, not regenerated (no regression on the already-working case)', async () => {
    const record = savedDraftRecordWithStaleCache();
    (record.metadata as Record<string, unknown>).generatedByKey = {
      'individual:rec-a': {
        subject: 'Hello',
        body: 'Hello there',
        status: 'ready',
        artifactId: 'artifact-1',
        versionId: 'v-1',
        version: 1,
        generationStatus: 'generated',
        auditStatus: 'passed',
        approvalStatus: 'not_required',
        sendable: true,
      },
    };
    // draft-artifacts reports the SAME version id the cache already has —
    // the backfill's skip-on-matching-versionId branch means the cached text
    // ("Hello") is left standing untouched, not overwritten by whatever
    // draft-artifacts happens to report for a different version.
    renderWizard(record);
    await waitFor(() => expect(screen.getByText('Generate & review')).toBeTruthy());
    await waitFor(() => expect(screen.getByDisplayValue('Hello')).toBeTruthy());

    await new Promise((r) => setTimeout(r, 50));
    const generateCalls = apiPostMock.mock.calls.filter(
      ([url]) => url === '/api/engagement/outreach/generate-batch',
    );
    expect(generateCalls).toHaveLength(0);
  });
});

describe('Uploading an attachment in Generate & Review', () => {
  beforeEach(() => {
    apiPostMock.mockClear();
    fetchMock.mockClear();
  });

  test('recognizes a supported file with an empty browser MIME type, then includes it in Send', async () => {
    const { container } = renderWizard(savedDraftRecordWithStaleCache());
    await waitFor(() => expect(screen.getByText('Generate & review')).toBeTruthy());
    const file = new File(['briefing'], 'brief.docx', { type: '' });
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [file] } });
    await waitFor(() =>
      expect(apiPostMock.mock.calls.some(([url]) => url.endsWith('/attachments/confirm'))).toBe(
        true,
      ),
    );
    const upload = apiPostMock.mock.calls.find(([url]) => url.endsWith('/attachments/upload-url'))!;
    const confirm = apiPostMock.mock.calls.find(([url]) => url.endsWith('/attachments/confirm'))!;
    const expectedType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    expect(upload[1]).toMatchObject({ contentType: expectedType });
    expect(confirm[1]).toMatchObject({ contentType: expectedType });
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Review Emails' }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Review Emails' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Confirm Send' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Send' }));
    await waitFor(() =>
      expect(apiPostMock.mock.calls.some(([url]) => url.endsWith('/send-intents'))).toBe(true),
    );
    expect(apiPostMock.mock.calls.find(([url]) => url.endsWith('/send-intents'))![1]).toMatchObject(
      {
        draftVersionIds: ['v-1'],
        attachmentIds: ['att-1'],
        testMode: false,
      },
    );
  });

  test('keeps Continue disabled until both concurrent uploads finish', async () => {
    let finishFirst!: (response: Response) => void;
    let finishSecond!: (response: Response) => void;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finishFirst = resolve;
        }),
    );
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finishSecond = resolve;
        }),
    );
    const { container } = renderWizard(savedDraftRecordWithStaleCache());
    await waitFor(() => expect(screen.getByText('Generate & review')).toBeTruthy());
    fireEvent.change(container.querySelector('input[type="file"]')!, {
      target: {
        files: [
          new File(['a'], 'first.pdf', { type: 'application/pdf' }),
          new File(['b'], 'second.pdf', { type: 'application/pdf' }),
        ],
      },
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(
      (screen.getByRole('button', { name: 'Review Emails' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    await act(async () => {
      finishFirst({ ok: true, status: 204 } as Response);
    });
    await waitFor(() => expect(screen.getByText(/Uploading 1 attachment/)).toBeTruthy());
    expect(
      (screen.getByRole('button', { name: 'Review Emails' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    await act(async () => {
      finishSecond({ ok: true, status: 204 } as Response);
    });
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Review Emails' }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
  });

  test('an upload failure stays visible and blocks continuing until explicitly removed', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 403 } as Response);
    const { container } = renderWizard(savedDraftRecordWithStaleCache());
    await waitFor(() => expect(screen.getByText('Generate & review')).toBeTruthy());
    fireEvent.change(container.querySelector('input[type="file"]')!, {
      target: { files: [new File(['a'], 'failed.pdf', { type: 'application/pdf' })] },
    });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Remove failed files' })).toBeTruthy(),
    );
    expect(
      (screen.getByRole('button', { name: 'Review Emails' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(apiPostMock.mock.calls.some(([url]) => url.endsWith('/send-intents'))).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Remove failed files' }));
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Review Emails' }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
  });

  test('a chosen file reaches the presigned-upload flow end to end (client side only; server-side root cause for bug 2 is still open)', async () => {
    const { container } = renderWizard(savedDraftRecordWithStaleCache());
    await waitFor(() => expect(screen.getByText('Generate & review')).toBeTruthy());
    expect(screen.getByText('Upload a file')).toBeTruthy();
    // The attachments picker renders a plain, visually-hidden
    // <input type="file"> that the "Upload a file" button clicks
    // programmatically (react-aria-components has no Upload primitive of its
    // own) — locate it the way a user's file picker would ultimately
    // populate it, without coupling to either implementation's DOM shape.
    const fileInput = container.querySelector('input[type="file"]');
    expect(fileInput).toBeTruthy();

    const file = new File(['hello'], 'brief.pdf', { type: 'application/pdf' });
    fireEvent.change(fileInput as HTMLInputElement, { target: { files: [file] } });

    await waitFor(() =>
      expect(
        apiPostMock.mock.calls.some(([url]) => url === '/api/engagement/attachments/upload-url'),
      ).toBe(true),
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await waitFor(() =>
      expect(
        apiPostMock.mock.calls.some(([url]) => url === '/api/engagement/attachments/confirm'),
      ).toBe(true),
    );
  });
});
