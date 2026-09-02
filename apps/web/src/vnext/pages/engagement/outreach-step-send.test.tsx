import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OutreachV3SessionEnvelope } from '../../../pages/engagement/outreach/v3/contracts.js';
import {
  OUTREACH_BUILDER_STEP_SUBLINES,
  OUTREACH_BUILDER_STEP_TITLES,
} from './outreach-campaign-flow.js';
import {
  OutreachSendStep,
  type OutreachSendStepProps,
  outreachPreflightHeading,
} from './outreach-step-send.js';

/**
 * The Send step is the one place in the builder that can do something
 * irreversible, so the properties under test are mostly refusals: no send
 * without a preflight verdict, no send without the confirmation dialog, and no
 * preflight verdict that outlives the settings it was computed against.
 */
const { getCalls, postCalls, responses, api } = vi.hoisted(() => {
  const getCalls: string[] = [];
  const postCalls: Array<{ url: string; body?: unknown }> = [];
  const responses: Record<string, unknown> = {};
  const api = {
    get: vi.fn(async (url: string) => {
      getCalls.push(url);
      if (url.includes('/drafts')) return { data: responses.drafts };
      if (url.includes('/generation/plan')) return { data: responses.plan };
      if (url.includes('/send/settings')) return { data: responses.settings };
      if (url.includes('/attachments')) return { data: responses.attachments };
      if (url.includes('/templates/provenance')) return { data: responses.provenance };
      if (url.includes('/send/intents/')) return { data: responses.intent };
      if (url.includes('outreach-reply-candidates')) return { data: responses.replies ?? [] };
      return { data: null };
    }),
    put: vi.fn(async (url: string, body?: unknown) => {
      postCalls.push({ url, body });
      if (url.includes('/send/settings')) {
        responses.settings = {
          schemaVersion: 'v1',
          senderConnectionId: 'conn-1',
          appendSignature: true,
          attachmentIds: [],
          settingsHash: 'settings-hash-saved',
          stateVersion: 4,
          updatedAt: new Date(0).toISOString(),
        };
        return { data: { settings: responses.settings, idempotent: false, invalidatedDraftVersionIds: [], invalidationFailures: [] } };
      }
      return { data: null };
    }),
    post: vi.fn(async (url: string, body?: unknown) => {
      postCalls.push({ url, body });
      if (url.includes('/send/preflight')) return { data: responses.preflight };
      return { data: { intentId: 'intent-1', deduped: false, preflight: responses.preflight } };
    }),
  };
  return { getCalls, postCalls, responses, api };
});

vi.mock('../../../lib/use-api.js', () => ({ useApi: () => api }));

function target(over: Record<string, unknown> = {}) {
  return {
    targetKey: 'directory_member:m1',
    locator: { kind: 'directory_member', id: 'm1' },
    displayName: 'Rep. Jane Smith',
    title: 'Ranking Member',
    organization: '2245 Rayburn',
    email: 'jane.smith@mail.house.gov',
    clientId: null,
    roleStatus: 'current',
    emailStatus: 'available',
    snapshotHash: 'hash-1',
    jurisdiction: {
      governmentLevel: 'federal',
      chamber: 'house',
      state: 'CA',
      district: '12',
      committees: [],
      issueAreas: [],
    },
    ...over,
  };
}

function envelope(targets: Array<Record<string, unknown>>): OutreachV3SessionEnvelope {
  return {
    session: { id: 'session-1' },
    currentStateVersion: 4,
    specHash: 'spec-hash-1',
    readiness: {},
    pendingProposalCount: 0,
    spec: {
      schemaVersion: 'outreach_campaign_spec_v1',
      goal: { goal: 'Send a client update', topic: 'FY27 mark-up', objective: null },
      sponsor: { kind: 'firm', label: 'Capiro · firm', clientRefs: [] },
      targeting: { criteria: null, selectedTargetRefs: targets, rejectedRecommendationRefs: [] },
      delivery: { pattern: 'personalized_separate', personalization: 'high' },
      context: {
        requiredPolicyRefs: [],
        writingGuidanceRefs: [],
        campaignFactRefs: [],
        targetSpecificRefs: [],
        groupSafeRefs: [],
        excludedRefs: [],
      },
      strategy: { campaignAngle: null, tone: null, length: 'standard', customLengthInstruction: null },
    },
  } as unknown as OutreachV3SessionEnvelope;
}

const BLOCKED = target({
  targetKey: 'directory_member:m4',
  displayName: 'Rep. Caleb Hart',
  email: null,
  emailStatus: 'missing',
});

function check(over: Record<string, unknown> = {}) {
  return {
    key: 'recipient_addresses',
    label: 'Recipient addresses verified',
    detail: '1 of 1 resolved from the Directory',
    state: 'pass',
    ...over,
  };
}

function preflight(over: Record<string, unknown> = {}) {
  return {
    eligible: true,
    testMode: false,
    blockers: [],
    checks: [
      check(),
      check({ key: 'exact_version', label: 'Exact-version approval', detail: 'Pinned', state: 'pass' }),
      check({ key: 'sponsor_scope', label: 'Sponsor scope', detail: 'Capiro · firm', state: 'pass' }),
    ],
    draftVersionIds: ['version-1'],
    excludedGenerationKeys: [],
    plan: null,
    settings: null,
    draftResults: [],
    ...over,
  };
}

function renderStep(over: Record<string, unknown> = {}) {
  const toast = vi.fn();
  const onNext = vi.fn();
  const applyCommands = vi.fn(async () => ({}));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const props = {
    sessionId: 'session-1',
    session: envelope([target()]),
    campaignType: 'send_update' as const,
    busy: false,
    applyCommands,
    toast,
    onNext,
    primaryLabel: 'Send 1 email',
    senderLabel: 'Microsoft 365 · neo@capiro.ai',
    senderConnectionId: 'conn-1',
    onOpenDrafts: vi.fn(),
    ...over,
  };
  const result = render(
    <div className="capiro-vnext-root">
      <div className="engagement-vnext">
        {/* MemoryRouter: the step's follow-up seeding calls useNavigate. */}
        <MemoryRouter>
          <QueryClientProvider client={qc}>
            <OutreachSendStep {...(props as unknown as OutreachSendStepProps)} />
          </QueryClientProvider>
        </MemoryRouter>
      </div>
    </div>,
  );
  return { ...result, toast, onNext };
}

function summaryValue(key: string): string {
  const row = screen.getByText(key).closest('.ocb-kv__row');
  return within(row as HTMLElement).getAllByText(/.+/).at(-1)?.textContent ?? '';
}

async function runPreflight() {
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Run the checks' })).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Run the checks' }));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Run them again' })).toBeInTheDocument(),
  );
}

describe('OutreachSendStep', () => {
  beforeEach(() => {
    getCalls.length = 0;
    postCalls.length = 0;
    responses.drafts = [
      {
        id: 'draft-1',
        outreachRecordId: 'record-1',
        generationKey: 'gen-1',
        recipientKey: 'directory_member:m1',
        audienceKind: 'individual',
        currentVersion: 2,
        current: { id: 'version-1', version: 2 },
        history: [],
      },
    ];
    responses.plan = {
      planVersion: 'v1',
      sessionId: 'session-1',
      stateVersion: 4,
      specHash: 'spec-hash-1',
      planHash: 'plan-hash-1',
      deliveryPattern: 'personalized_separate',
      slots: [
        {
          generationKey: 'gen-1',
          audienceKind: 'individual',
          recipients: [
            { targetKey: 'directory_member:m1', displayName: 'Rep. Jane Smith', email: 'j@x.gov' },
          ],
        },
      ],
      representativeSampleKeys: [],
      eligible: true,
      blockers: [],
    };
    responses.settings = {
      schemaVersion: 'v1',
      senderConnectionId: 'conn-1',
      appendSignature: true,
      attachmentIds: ['att-1'],
      settingsHash: 'settings-hash-1',
      stateVersion: 4,
      updatedAt: '2026-08-28T10:00:00.000Z',
    };
    responses.attachments = [
      { id: 'att-1', fileName: 'capability-statement.pdf', contentType: 'application/pdf', byteSize: 10 },
    ];
    responses.provenance = { templateName: 'Hearings & markup week-ahead', versionNumber: 3 };
    responses.preflight = preflight();
    api.get.mockClear();
    api.post.mockClear();
  });

  it('carries the prototype step copy on the flow module and the primary label from its props', async () => {
    expect(OUTREACH_BUILDER_STEP_TITLES.send).toBe('Before this goes out');
    expect(OUTREACH_BUILDER_STEP_SUBLINES.send).toBe(
      'Read what will happen, test it on yourself, then run fresh checks. Capiro creates one durable send record.',
    );
    renderStep();
    // The eyebrow repeats the step title — deliberate in the prototype.
    expect(screen.getByText('Before this goes out')).toBeInTheDocument();
    expect(screen.getByText('What will happen')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send 1 email' })).toBeInTheDocument();
  });

  it('fills all six summary rows from real campaign data', async () => {
    renderStep();
    await waitFor(() => expect(summaryValue('Format')).toContain('Hearings & markup week-ahead'));

    expect(summaryValue('How many')).toBe('1 email, one person');
    expect(summaryValue('From')).toBe('Microsoft 365 · neo@capiro.ai');
    expect(summaryValue('When')).toBe('Straight away, spread steadily');
    expect(summaryValue('Format')).toBe('Standard email · Hearings & markup week-ahead');
    expect(summaryValue('Signature')).toBe('Append your current Capiro signature');
    expect(summaryValue('Attachments')).toBe('capability-statement.pdf');
  });

  it('states the honest unknowns rather than the prototype mock values', async () => {
    responses.settings = null;
    responses.provenance = null;
    renderStep({ senderLabel: null });

    await waitFor(() => expect(summaryValue('Format')).toBe('Standard email · No template'));
    expect(summaryValue('From')).toBe('No mailbox connected');
    expect(summaryValue('Signature')).toBe('Not set');
    expect(summaryValue('Attachments')).toBe('Not set');
  });

  it('shows the schedule caveat and rewrites the When row when Schedule is chosen', () => {
    renderStep();
    fireEvent.click(screen.getByRole('radio', { name: /Schedule/ }));

    expect(
      screen.getByText(
        'Scheduling is shown here, but the server contract creates immediate send intents only. Keep “Send now” selected to send safely.',
      ),
    ).toBeInTheDocument();
    expect(summaryValue('When')).toBe('Scheduled — server creates immediate intents only');
  });

  it('rewrites the When row for the quick pacing choice', () => {
    renderStep();
    fireEvent.click(screen.getByRole('radio', { name: /Quick/ }));
    expect(summaryValue('When')).toBe(
      'Straight away, as quickly as provider policy allows',
    );
  });

  it('creates a real test send and reports it once', async () => {
    const { toast } = renderStep();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Send a test to me' })).toBeEnabled(),
    );
    expect(screen.getByRole('combobox')).toHaveValue('gen-1');
    expect(screen.getByRole('option', { name: 'Rep. Jane Smith · V2' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Send a test to me' }));

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Send another test' })).toBeInTheDocument(),
    );
    expect(screen.getByText('Test send created')).toBeInTheDocument();
    expect(toast).toHaveBeenCalledWith('Test send created · your mailbox only');
    const call = postCalls.find((entry) => entry.url.includes('/send/test'));
    expect(call?.body).toMatchObject({ testGenerationKey: 'gen-1' });
  });

  it('refuses to offer a test send when no draft exists yet', async () => {
    responses.drafts = [];
    renderStep();

    await waitFor(() =>
      expect(
        screen.getByText(
          'No drafts yet. Generate the drafts first — a test send goes out as one exact version.',
        ),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByRole('button', { name: 'Send a test to me' })).not.toBeInTheDocument();
  });

  it('renders the server’s real checks and counts them honestly', async () => {
    responses.preflight = preflight({
      checks: [
        check({ key: 'a', label: 'Recipient addresses verified', detail: '1 of 1 resolved', state: 'pass' }),
        check({ key: 'b', label: 'Mailbox connection', detail: 'Token expires in 3 days', state: 'review' }),
      ],
    });
    const { toast } = renderStep();
    expect(screen.getByText('Not checked for the current versions.')).toBeInTheDocument();

    await runPreflight();

    expect(screen.getByText('Two checks, using fresh server reads')).toBeInTheDocument();
    expect(screen.getByText(/· 2 checks$/)).toBeInTheDocument();
    // Only the row needing attention renders, so the footnote stays true.
    expect(screen.getByText('Mailbox connection')).toBeInTheDocument();
    expect(screen.queryByText('Recipient addresses verified')).not.toBeInTheDocument();
    expect(
      screen.getByText('Showing what needs attention. The remaining checks passed.'),
    ).toBeInTheDocument();
    expect(toast).toHaveBeenCalledWith('Preflight run against the current exact versions');
  });

  it('never says fourteen unless the server returned fourteen checks', () => {
    expect(outreachPreflightHeading(14)).toBe('Fourteen checks, using fresh server reads');
    expect(outreachPreflightHeading(3)).toBe('Three checks, using fresh server reads');
    expect(outreachPreflightHeading(1)).toBe('One check, using fresh server reads');
    expect(outreachPreflightHeading(null)).toBe('Checks, using fresh server reads');
  });

  it('invalidates the preflight verdict when the choice it was computed against changes', async () => {
    renderStep({ session: envelope([target(), BLOCKED]) });
    await runPreflight();
    expect(screen.getByText(/^Last checked /)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('radio', { name: /Wait and send everyone together/ }));

    expect(screen.getByText('Not checked for the current versions.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Run the checks' })).toBeInTheDocument();
    expect(screen.getByText('Run preflight first.')).toBeInTheDocument();
  });

  it('holds the send behind the gate reasons, in the prototype’s order', async () => {
    renderStep({ session: envelope([target(), BLOCKED]), primaryLabel: 'Send 1 email' });

    expect(screen.getByText('Run preflight first.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send 1 email' })).toBeDisabled();

    // The held-out card is driven by the spec's own unsendable targets.
    expect(screen.getByText('1 recipient is not ready')).toBeInTheDocument();
    expect(
      screen.getByText('They are held out of this send and receive nothing.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Rep. Caleb Hart')).toBeInTheDocument();

    // One preflight run is now enough. This used to demand a held-out
    // acknowledgement checkbox and then a SECOND preflight run, because ticking
    // the box changed the preflight input. The box only ever told the server
    // what the client already knew — held-out recipients are dropped from the
    // envelope server-side either way — so it added two clicks and a round-trip
    // without changing who received mail.
    await runPreflight();
    expect(
      screen.getByText('The confirmation dialog is the only real-send trigger.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send 1 email' })).toBeEnabled();
    expect(
      screen.queryByRole('checkbox', { name: /I understand those recipients/ }),
    ).not.toBeInTheDocument();
  });

  it('keeps the campaign blocked when the user waits for everyone', async () => {
    renderStep({ session: envelope([target(), BLOCKED]) });
    fireEvent.click(screen.getByRole('radio', { name: /Wait and send everyone together/ }));
    expect(screen.getByText('The campaign stays blocked until they are ready.')).toBeInTheDocument();
    expect(
      screen.queryByRole('checkbox', { name: /I understand those recipients/ }),
    ).not.toBeInTheDocument();

    await runPreflight();
    expect(
      screen.getByText(
        'With this choice one blocked recipient keeps the whole campaign from sending.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send 1 email' })).toBeDisabled();
  });

  it('refuses to send while the server says the campaign is not eligible', async () => {
    responses.preflight = preflight({ eligible: false, checks: [check({ state: 'blocked', label: 'Draft approval' })] });
    renderStep();
    await runPreflight();

    expect(
      screen.getByText('Resolve the blocking checks or hold eligible recipients out.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send 1 email' })).toBeDisabled();
  });

  it('makes the confirmation dialog the only real-send trigger', async () => {
    const { toast, onNext } = renderStep();
    await runPreflight();

    fireEvent.click(screen.getByRole('button', { name: 'Send 1 email' }));
    expect(postCalls.some((call) => call.url.includes('/send/intent'))).toBe(false);
    expect(await screen.findByText('Send 1 email now?')).toBeInTheDocument();

    const dialog = within(screen.getByRole('dialog'));
    fireEvent.click(dialog.getByRole('button', { name: 'Send 1 email' }));
    await waitFor(() =>
      expect(postCalls.some((call) => call.url.includes('/send/intent'))).toBe(true),
    );
    expect(toast).toHaveBeenCalledWith('One durable send record created · 1 queued');
    expect(onNext).toHaveBeenCalled();
  });

  it('lets the user back out of the confirmation without sending', async () => {
    renderStep();
    await runPreflight();
    fireEvent.click(screen.getByRole('button', { name: 'Send 1 email' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Go back' }));

    await waitFor(() => expect(screen.queryByText('Send 1 email now?')).not.toBeInTheDocument());
    expect(postCalls.some((call) => call.url.includes('/send/intent'))).toBe(false);
  });

  describe('OutreachSendStep — a group is one email, not one each', () => {
    function groupPlan() {
      return {
        ...(responses.plan as Record<string, unknown>),
        deliveryPattern: 'shared_thread',
        slots: [
          {
            generationKey: 'gen-shared',
            audienceKind: 'group',
            recipients: [
              { targetKey: 'directory_member:m1', displayName: 'Rep. Jane Smith', email: 'j@x.gov' },
              { targetKey: 'directory_member:m2', displayName: 'Sen. Mark Reyes', email: 'm@x.gov' },
            ],
          },
        ],
      };
    }

    it('says one shared email everyone can see, not one email per person', async () => {
      responses.plan = groupPlan();
      renderStep({
        session: envelope([target(), target({ targetKey: 'directory_member:m2', displayName: 'Sen. Mark Reyes', email: 'm@x.gov' })]),
      });

      await waitFor(() =>
        expect(summaryValue('How many')).toBe('2 recipients, one shared email everyone can see'),
      );
      // The button counts emails. Calling it "Send 2 emails" is the promise of
      // privacy this campaign shape cannot keep.
      expect(await screen.findByRole('button', { name: 'Send 1 email' })).toBeInTheDocument();
    });

    it('does not promise a blocked recipient receives nothing from a shared email', async () => {
      responses.plan = groupPlan();
      renderStep({ session: envelope([target(), BLOCKED]) });

      expect(
        await screen.findByText(
          'They stay on this shared email. A group cannot hold one recipient out of a message the others receive.',
        ),
      ).toBeInTheDocument();
    });
  });

  describe('OutreachSendStep — after the send', () => {
    it('saves the send settings the summary names before checking against them', async () => {
      // The panel states the sender, signature and attachments as settled. A
      // campaign with no saved settings would otherwise be checked against
      // nothing while the screen says otherwise.
      responses.settings = null;
      renderStep();
      await runPreflight();

      const settingsWrite = postCalls.findIndex((call) => call.url.includes('/send/settings'));
      const preflightRun = postCalls.findIndex((call) => call.url.includes('/send/preflight'));
      expect(settingsWrite).toBeGreaterThanOrEqual(0);
      expect(preflightRun).toBeGreaterThan(settingsWrite);
      expect(postCalls[settingsWrite]?.body).toMatchObject({
        senderConnectionId: 'conn-1',
        appendSignature: true,
        attachmentIds: [],
      });
      // And the verdict survives the save it triggered — a fingerprint taken
      // before the write would have discarded the run that just happened.
      expect(screen.getByRole('button', { name: 'Run them again' })).toBeInTheDocument();
    });

    it('replaces the setup form with the real send record once an intent exists', async () => {
      responses.intent = {
        id: 'intent-1',
        status: 'sending',
        totals: { total: 1, sent: 0 },
        deliveries: [],
        startedAt: new Date(0).toISOString(),
      };
      const { toast } = renderStep();
      await runPreflight();
      fireEvent.click(screen.getByRole('button', { name: 'Send 1 email' }));
      const dialog = within(await screen.findByRole('dialog'));
      fireEvent.click(dialog.getByRole('button', { name: 'Send 1 email' }));

      await waitFor(() => expect(toast).toHaveBeenCalled());
      // Progress, not a screen that still offers to send.
      expect(await screen.findByText('Sending now')).toBeInTheDocument();
      await waitFor(() =>
        expect(screen.queryByRole('button', { name: 'Send 1 email' })).not.toBeInTheDocument(),
      );
    });

    it('shows the results once the provider reaches a terminal state', async () => {
      responses.intent = {
        id: 'intent-1',
        status: 'complete',
        totals: { total: 1, sent: 1, failed: 0, unknown: 0, skipped: 0, held: 0 },
        deliveries: [
          {
            id: 'delivery-1',
            generationKey: 'gen-1',
            recipientKey: 'directory_member:m1',
            status: 'sent',
            attempt: 1,
            to: [{ name: 'Rep. Jane Smith', email: 'j@x.gov' }],
            cc: [],
            bcc: [],
            subject: 'FY27 mark-up',
            acceptedAt: new Date(0).toISOString(),
          },
        ],
        startedAt: new Date(0).toISOString(),
      };
      renderStep();
      await runPreflight();
      fireEvent.click(screen.getByRole('button', { name: 'Send 1 email' }));
      const dialog = within(await screen.findByRole('dialog'));
      fireEvent.click(dialog.getByRole('button', { name: 'Send 1 email' }));

      expect(await screen.findByText('1 left cleanly.')).toBeInTheDocument();
      // The guarantee the prototype's toast-and-stop cannot make.
      expect(
        screen.getByText(
          'Provider outcomes remain explicit. Unknown is never silently treated as delivered, and nothing retries itself.',
        ),
      ).toBeInTheDocument();
    });
  });
});
