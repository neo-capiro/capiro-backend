import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OutreachV3SessionEnvelope } from '../../../pages/engagement/outreach/v3/contracts.js';
import {
  OUTREACH_BUILDER_STEP_SUBLINES,
  OUTREACH_BUILDER_STEP_TITLES,
  outreachBuilderPrimaryLabel,
} from './outreach-campaign-flow.js';
import { OutreachDraftsStep, outreachDraftRows } from './outreach-step-drafts.js';

/**
 * The Drafts step is the best-wired surface in the builder: all four draft
 * tools hit real endpoints, and the version the user sees is the one the server
 * returned. These tests exist mostly to keep it that way — every assertion
 * about a version number is an assertion that no local counter crept back in
 * (the prototype's `refine()` bumped a counter without changing the draft), and
 * the approval test pins the one deliberate addition to the prototype: leaving
 * the step approves the exact versions the reader was shown, because the
 * server's preflight blocks on DRAFT_NOT_EXACTLY_APPROVED and the prototype
 * ships no approve control at all.
 */

const {
  api,
  listDraftsMock,
  reviseMock,
  refineMock,
  approveMock,
  getVersionMock,
} = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn() },
  listDraftsMock: vi.fn(),
  reviseMock: vi.fn(),
  refineMock: vi.fn(),
  approveMock: vi.fn(),
  getVersionMock: vi.fn(),
}));

vi.mock('../../../lib/use-api.js', () => ({ useApi: () => api }));
vi.mock('./engagement-api.js', async () => {
  const actual = await vi.importActual<typeof import('./engagement-api.js')>('./engagement-api.js');
  return {
    ...actual,
    listOutreachV3Drafts: listDraftsMock,
    reviseOutreachV3Draft: reviseMock,
    refineOutreachV3Draft: refineMock,
    approveOutreachV3Draft: approveMock,
    getOutreachV3DraftVersion: getVersionMock,
  };
});

function version(over: Record<string, unknown> = {}) {
  return {
    id: 'version-1',
    artifactId: 'draft-1',
    outreachRecordId: 'record-1',
    version: 1,
    sourceVersionId: null,
    generationKey: 'v3:session-1:target:target-a',
    recipientKey: 'target-a',
    audienceKind: 'individual',
    subject: 'FY27 Ground Robotics — where the autonomy provision landed',
    body: 'Bottom line\n\nSix sessions in the next seven days.',
    contentHash: 'hash-1',
    generationStatus: 'ready',
    auditStatus: 'pass',
    approvalStatus: 'unapproved',
    auditDecision: null,
    auditChecks: [],
    reviewRequestId: null,
    provider: 'openai',
    model: 'test',
    promptSpecVersion: 'v1',
    sendable: false,
    createdAt: '2026-08-28T12:00:00.000Z',
    ...over,
  };
}

function artifact(over: Record<string, unknown> = {}) {
  return {
    id: 'draft-1',
    outreachRecordId: 'record-1',
    generationKey: 'v3:session-1:target:target-a',
    recipientKey: 'target-a',
    audienceKind: 'individual',
    currentVersion: 1,
    current: version(),
    history: [],
    ...over,
  };
}

function target(over: Record<string, unknown> = {}) {
  return {
    targetKey: 'target-a',
    locator: { kind: 'directory_member', id: 'm1' },
    displayName: 'Rep. Jane Smith',
    title: 'Ranking Member · Cyber, IT & Innovation',
    organization: '2245 Rayburn',
    email: 'jane@example.gov',
    clientId: null,
    roleStatus: 'current',
    emailStatus: 'available',
    snapshotHash: 'snap-1',
    jurisdiction: {
      governmentLevel: 'federal',
      chamber: 'house',
      state: 'VA',
      district: '11',
      committees: [],
      issueAreas: [],
    },
    ...over,
  };
}

function envelope(over: {
  targets?: unknown[];
  targetSpecificRefs?: unknown[];
}): OutreachV3SessionEnvelope {
  return {
    session: { id: 'session-1' },
    currentStateVersion: 4,
    specHash: 'spec',
    readiness: {},
    pendingProposalCount: 0,
    spec: {
      schemaVersion: 'outreach_campaign_spec_v1',
      goal: { goal: 'Send a client update', objective: null, topic: 'FY27', desiredOutcome: null, ask: { mode: 'undecided', text: null }, whyNow: null },
      sponsor: { kind: 'undecided', label: null, clientRefs: [] },
      targeting: {
        criteria: null,
        selectedTargetRefs: over.targets ?? [target()],
        rejectedRecommendationRefs: [],
      },
      delivery: { pattern: 'personalized_separate', personalization: 'high' },
      context: {
        requiredPolicyRefs: [],
        writingGuidanceRefs: [],
        campaignFactRefs: [],
        targetSpecificRefs: over.targetSpecificRefs ?? [],
        groupSafeRefs: [],
        excludedRefs: [],
      },
      strategy: { campaignAngle: null, tone: null, length: 'standard', customLengthInstruction: null },
    },
  } as unknown as OutreachV3SessionEnvelope;
}

function renderStep(
  over: Partial<Parameters<typeof OutreachDraftsStep>[0]> & {
    session?: OutreachV3SessionEnvelope;
  } = {},
) {
  const toast = vi.fn();
  const onNext = vi.fn();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const result = render(
    <QueryClientProvider client={qc}>
      <OutreachDraftsStep
        sessionId="session-1"
        session={over.session ?? envelope({})}
        campaignType="send_update"
        busy={false}
        applyCommands={vi.fn()}
        toast={toast}
        onNext={onNext}
        primaryLabel={outreachBuilderPrimaryLabel('drafts', 'send_update')}
        {...over}
      />
    </QueryClientProvider>,
  );
  return { ...result, toast, onNext };
}

describe('OutreachDraftsStep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listDraftsMock.mockResolvedValue([artifact()]);
    reviseMock.mockResolvedValue(version({ id: 'version-2', version: 2 }));
    refineMock.mockResolvedValue(version({ id: 'version-3', version: 2 }));
    approveMock.mockResolvedValue({ approvalStatus: 'approved' });
    getVersionMock.mockResolvedValue(version());
  });

  describe('the copy the prototype promises', () => {
    it('keeps the step title, subline and primary-button label verbatim', async () => {
      expect(OUTREACH_BUILDER_STEP_TITLES.drafts).toBe('Review one draft per recipient');
      expect(OUTREACH_BUILDER_STEP_SUBLINES.drafts).toBe(
        'Each draft is an immutable version. Editing creates a new version; approval is pinned to the exact version you read.',
      );
      expect(outreachBuilderPrimaryLabel('drafts', 'send_update')).toBe('Continue to send');

      renderStep();
      expect(await screen.findByRole('button', { name: 'Continue to send' })).toBeInTheDocument();
    });

    it('labels the rail, the tools and the note block exactly as the prototype does', async () => {
      renderStep();
      expect(await screen.findByText('Draft tools')).toBeInTheDocument();
      expect(screen.getByText('Recipients')).toBeInTheDocument();
      for (const label of ['Edit text', 'Edit with Meri', 'Change tone', 'Regenerate']) {
        expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
      }
      expect(screen.getByText('Subject')).toBeInTheDocument();
      expect(screen.getByText('Personal note used')).toBeInTheDocument();
      expect(screen.getByText('No personal note for this recipient.')).toBeInTheDocument();
    });
  });

  describe('the recipient rail', () => {
    it('names each recipient from the spec, not from the raw locator key', async () => {
      listDraftsMock.mockResolvedValue([
        artifact(),
        artifact({
          id: 'draft-2',
          recipientKey: 'target-b',
          currentVersion: 2,
          current: version({ id: 'version-b', artifactId: 'draft-2', version: 2, recipientKey: 'target-b' }),
        }),
      ]);
      renderStep({
        session: envelope({
          targets: [
            target(),
            target({ targetKey: 'target-b', displayName: 'Priya Anand', title: 'Legislative Director', organization: null }),
          ],
        }),
      });

      // Twice for the open recipient: once in the rail, once in the reader head.
      expect(await screen.findAllByText('Rep. Jane Smith')).toHaveLength(2);
      expect(screen.getByText('Priya Anand')).toBeInTheDocument();
      expect(screen.getByText('Legislative Director')).toBeInTheDocument();
      // Rail state is derived from the SERVER version, never a local counter.
      expect(screen.getByText('Ready for your read')).toBeInTheDocument();
      expect(screen.getByText('Edited · new version')).toBeInTheDocument();
      // V1 twice: the rail row and the reader's own chip for the open draft.
      expect(screen.getAllByText('V1')).toHaveLength(2);
      expect(screen.getAllByText('V2')).toHaveLength(1);
    });

    it('opens the clicked recipient and closes any open tool', async () => {
      listDraftsMock.mockResolvedValue([
        artifact(),
        artifact({
          id: 'draft-2',
          recipientKey: 'target-b',
          current: version({ id: 'version-b', artifactId: 'draft-2', recipientKey: 'target-b', body: 'Priya body' }),
        }),
      ]);
      renderStep({
        session: envelope({
          targets: [target(), target({ targetKey: 'target-b', displayName: 'Priya Anand' })],
        }),
      });

      fireEvent.click(await screen.findByRole('button', { name: /Change tone/ }));
      expect(screen.getByLabelText('New tone')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: /Priya Anand/ }));
      expect(screen.queryByLabelText('New tone')).not.toBeInTheDocument();
      expect(screen.getByText('Priya body')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Priya Anand/ })).toHaveAttribute(
        'aria-current',
        'true',
      );
    });

    it('shows the Note pill only for a recipient who has a personal note', async () => {
      renderStep({
        session: envelope({
          targetSpecificRefs: [
            {
              contextKey: 'ctx-1',
              locator: {
                source: 'manual',
                text: 'Personal note for Rep. Jane Smith. Apply this note only to this recipient’s draft: Mention the May briefing.',
              },
              contextClass: 'target_specific',
              scope: { kind: 'target', targetKey: 'target-a' },
              title: 'Personal note — Rep. Jane Smith',
              summary: '',
            },
          ],
        }),
      });

      expect(await screen.findByText('Note')).toBeInTheDocument();
      // The stored text is addressed to the writer; the reader sees the note.
      expect(screen.getByText('Mention the May briefing.')).toBeInTheDocument();
    });
  });

  describe('the draft tools', () => {
    it('Edit text saves a new version through reviseOutreachV3Draft and toasts the server version', async () => {
      const { toast } = renderStep();
      fireEvent.click(await screen.findByRole('button', { name: 'Edit text' }));

      const editor = screen.getByLabelText('Draft body');
      // Typing alone must not touch the draft — the prototype's live write is
      // what made "Save as new version" meaningless.
      fireEvent.change(editor, { target: { value: 'Rewritten body' } });
      expect(reviseMock).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole('button', { name: 'Save as new version' }));
      await waitFor(() => expect(reviseMock).toHaveBeenCalledTimes(1));
      expect(reviseMock.mock.calls[0]?.[1]).toBe('session-1');
      expect(reviseMock.mock.calls[0]?.[2]).toBe('draft-1');
      expect(reviseMock.mock.calls[0]?.[3]).toMatchObject({
        baseVersionId: 'version-1',
        body: 'Rewritten body',
        editKind: 'manual',
      });
      await waitFor(() =>
        expect(toast).toHaveBeenCalledWith('Text edit saved · Rep. Jane Smith now at V2'),
      );
    });

    it('Edit with Meri refuses an empty instruction and sends the typed one', async () => {
      const { toast } = renderStep();
      fireEvent.click(await screen.findByRole('button', { name: /Edit with Meri/ }));
      expect(
        screen.getByText(
          'The approved subject line, recipient, sponsor facts, personal note and ask are preserved. No new facts are introduced.',
        ),
      ).toBeInTheDocument();

      const create = screen.getByRole('button', { name: 'Create new version' });
      expect(create).toBeDisabled();

      fireEvent.change(screen.getByLabelText('Tell Meri what to change'), {
        target: { value: 'Shorten the second paragraph.' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Create new version' }));

      await waitFor(() => expect(refineMock).toHaveBeenCalledTimes(1));
      expect(String(refineMock.mock.calls[0]?.[3]?.instruction)).toContain(
        'Shorten the second paragraph.',
      );
      await waitFor(() =>
        expect(toast).toHaveBeenCalledWith('Meri created a new version · Rep. Jane Smith now at V2'),
      );
    });

    it('Change tone offers the prototype six and applies the chosen one as a refine', async () => {
      const { toast } = renderStep();
      fireEvent.click(await screen.findByRole('button', { name: /Change tone/ }));

      const select = screen.getByLabelText('New tone') as HTMLSelectElement;
      expect([...select.options].map((option) => option.value)).toEqual([
        'Professional',
        'Warm',
        'Concise',
        'Direct',
        'Persuasive',
        'Conversational',
      ]);

      fireEvent.change(select, { target: { value: 'Concise' } });
      fireEvent.click(screen.getByRole('button', { name: 'Apply to new version' }));

      await waitFor(() => expect(refineMock).toHaveBeenCalledTimes(1));
      expect(String(refineMock.mock.calls[0]?.[3]?.instruction)).toContain('concise tone');
      await waitFor(() =>
        expect(toast).toHaveBeenCalledWith('Concise tone applied · Rep. Jane Smith now at V2'),
      );
    });

    it('Regenerate refines from the approved packet', async () => {
      const { toast } = renderStep();
      fireEvent.click(await screen.findByRole('button', { name: /Regenerate/ }));

      await waitFor(() => expect(refineMock).toHaveBeenCalledTimes(1));
      expect(String(refineMock.mock.calls[0]?.[3]?.instruction)).toContain(
        'Regenerate this recipient',
      );
      await waitFor(() =>
        expect(toast).toHaveBeenCalledWith(
          'Regenerated from the approved packet · Rep. Jane Smith now at V2',
        ),
      );
    });

    it('surfaces a failed tool instead of pretending a version was created', async () => {
      refineMock.mockRejectedValue(new Error('Refine service unavailable'));
      const { toast } = renderStep();
      fireEvent.click(await screen.findByRole('button', { name: /Regenerate/ }));

      expect(await screen.findByRole('alert')).toHaveTextContent('Refine service unavailable');
      expect(toast).not.toHaveBeenCalled();
    });
  });

  describe('leaving the step', () => {
    it('approves the exact current versions, then advances', async () => {
      listDraftsMock.mockResolvedValue([
        artifact(),
        artifact({
          id: 'draft-2',
          recipientKey: 'target-b',
          current: version({ id: 'version-b', artifactId: 'draft-2', recipientKey: 'target-b' }),
        }),
      ]);
      const { onNext } = renderStep({
        session: envelope({
          targets: [target(), target({ targetKey: 'target-b', displayName: 'Priya Anand' })],
        }),
      });

      fireEvent.click(await screen.findByRole('button', { name: 'Continue to send' }));
      await waitFor(() => expect(onNext).toHaveBeenCalledTimes(1));
      expect(approveMock.mock.calls.map((call) => call[2])).toEqual(['version-1', 'version-b']);
    });

    it('does not advance when an approval fails', async () => {
      approveMock.mockRejectedValue(new Error('Draft version is stale'));
      const { onNext } = renderStep();

      fireEvent.click(await screen.findByRole('button', { name: 'Continue to send' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('Draft version is stale');
      expect(onNext).not.toHaveBeenCalled();
    });

    it('skips a version the server already reports as approved', async () => {
      listDraftsMock.mockResolvedValue([
        artifact({ current: version({ approvalStatus: 'approved' }) }),
      ]);
      const { onNext } = renderStep();

      fireEvent.click(await screen.findByRole('button', { name: 'Continue to send' }));
      await waitFor(() => expect(onNext).toHaveBeenCalledTimes(1));
      expect(approveMock).not.toHaveBeenCalled();
    });
  });

  describe('empty and partial states', () => {
    it('says nothing has been generated rather than showing an em dash over a full card', async () => {
      listDraftsMock.mockResolvedValue([]);
      renderStep();

      expect(
        await screen.findByText(
          'No drafts yet. Accept the packet on the review step to generate one draft per recipient.',
        ),
      ).toBeInTheDocument();
      expect(screen.queryByText('Draft tools')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Continue to send' })).not.toBeInTheDocument();
    });

    it('reads an artifact with no current version out of its history and refuses to edit it', async () => {
      listDraftsMock.mockResolvedValue([
        artifact({
          current: null,
          currentVersion: 2,
          history: [
            { id: 'version-old', version: 1, generationStatus: 'ready', auditStatus: 'pass', approvalStatus: 'unapproved', createdAt: '2026-08-28T11:00:00.000Z' },
            { id: 'version-new', version: 2, generationStatus: 'failed', auditStatus: 'pass', approvalStatus: 'unapproved', createdAt: '2026-08-28T12:00:00.000Z' },
          ],
        }),
      ]);
      getVersionMock.mockResolvedValue(version({ id: 'version-new', version: 2, body: 'Recovered body' }));
      renderStep();

      expect(await screen.findByText('Recovered body')).toBeInTheDocument();
      expect(getVersionMock.mock.calls[0]?.[2]).toBe('version-new');
      expect(screen.getByRole('button', { name: 'Edit text' })).toBeDisabled();
      expect(
        screen.getByText(
          '1 recipient has no generated version yet, so nothing can be approved or sent for them.',
        ),
      ).toBeInTheDocument();
    });
  });

  describe('outreachDraftRows', () => {
    it('falls back to the raw recipient key when no target resolves', () => {
      const rows = outreachDraftRows(
        [artifact({ recipientKey: 'target-z', current: version({ recipientKey: 'target-z' }) }) as never],
        envelope({}),
      );
      expect(rows[0]?.name).toBe('target-z');
      expect(rows[0]?.role).toBe('');
    });

    it('names a shared-thread draft after the people actually on it', () => {
      const rows = outreachDraftRows(
        [
          artifact({
            recipientKey: 'shared:abc',
            audienceKind: 'group',
            current: version({ recipientKey: 'shared:abc', audienceKind: 'group' }),
          }) as never,
        ],
        envelope({
          targets: [target(), target({ targetKey: 'target-b', displayName: 'Priya Anand' })],
        }),
      );
      expect(rows[0]?.name).toBe('Rep. Jane Smith · Priya Anand');
      expect(rows[0]?.note).toBe('');
    });
  });
});
