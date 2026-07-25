/*
 * P0-3 web contract: the approval screen must show the EXACT payload and every
 * disclosure, and approving must bind to the hash the reviewer actually saw.
 *
 * The audited defect was that a reviewer approved a title/target/action label
 * while the content behind it could change. Fixing the server is half of it; if
 * the screen doesn't show the real recipient, the real subject, the real body and
 * the warnings, the reviewer still cannot know what they are authorising.
 *
 * The safety invariant pinned here: for a SEND decision the grant control stays
 * DISABLED. A working button labelled "approve this send" while nothing can send
 * would itself be a misleading success state.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { App } from 'antd';
import type { ExecutionRun, RunApprovalStatus } from '../types.js';

const idle = { isLoading: false, isError: false, isSuccess: true, error: null };

let runsData: ExecutionRun[] = [];
let approvalData: RunApprovalStatus | undefined;
const approveMutate = vi.fn();
const rejectMutate = vi.fn();

vi.mock('../api.js', () => ({
  useExecutionRuns: () => ({ ...idle, data: runsData }),
  useExecuteRun: () => ({ mutate: vi.fn(), isPending: false }),
  useResumeRun: () => ({ mutate: vi.fn(), isPending: false }),
  useStrategies: () => ({ ...idle, data: [] }),
  // P0-2 recovery controls are covered by their own suite; keep them inert here.
  useRunPolicy: () => ({ ...idle, data: undefined }),
  useCancelRun: () => ({ mutate: vi.fn(), isPending: false }),
  useRetryRun: () => ({ mutate: vi.fn(), isPending: false }),
  useMarkRunFailed: () => ({ mutate: vi.fn(), isPending: false }),
  useReconcileRun: () => ({ mutate: vi.fn(), isPending: false }),
  useResolveReservation: () => ({ mutate: vi.fn(), isPending: false }),
  // P0-3
  useApprovalStatus: () => ({ ...idle, data: approvalData }),
  useApproveExactDraft: () => ({ mutate: approveMutate, isPending: false }),
  useRejectApproval: () => ({ mutate: rejectMutate, isPending: false }),
}));

vi.mock('../clients-lite.js', () => ({
  useClientsLite: () => ({ ...idle, data: [] }),
}));

import { ExecutionReview, SEND_DISABLED_COPY } from './ExecutionReview.js';

const HASH = 'a'.repeat(64);

function run(over: Partial<ExecutionRun> = {}): ExecutionRun {
  return {
    id: 'exec-1',
    missionId: 'm-1',
    strategyId: 'strat-1',
    state: 'ready_for_review',
    trigger: 'manual',
    waitingReason: null,
    error: null,
    summary: 'Prepare the FY27 one-pager',
    tasks: [],
    startedAt: null,
    finishedAt: null,
    createdAt: '2026-07-25T10:00:00.000Z',
    ...over,
  };
}

function approval(over: Partial<RunApprovalStatus> = {}): RunApprovalStatus {
  return {
    runId: 'exec-1',
    state: 'ready_for_review',
    action: 'stage',
    effect: 'stages internally',
    sendEnabled: false,
    contentHash: HASH,
    binding: {
      strategyId: 'strat-1',
      strategyVersionId: 'v-head-1234',
      nodeId: 'node-1',
      runId: 'exec-1',
      action: 'stage',
      channel: 'workspace_draft',
      subject: 'FY27 one-pager',
      body: 'Line one of the draft.\nLine two of the draft.',
      recipients: [
        { id: 'ct-1', name: 'Rep. Jane Smith (D, CA, House)', address: 'jane@house.gov' },
      ],
      attachments: [],
      templateVersion: 'execution-document-draft@v1',
      contextPackFingerprint: 'fp-1',
      groundingStatus: 'ok',
      grounded: true,
      model: 'claude-sonnet-5',
      provider: 'anthropic',
      sendEnabled: false,
    },
    approval: null,
    approvalValid: false,
    approvalInvalidReason: null,
    changedFields: [],
    warnings: {
      fallbackContent: false,
      groundingStatus: 'ok',
      openMaterialConflicts: [],
      missingRequiredContext: [],
      versionDrift: false,
      pinnedVersionId: null,
      headVersionId: 'v-head-1234',
      changedSinceReview: false,
    },
    ...over,
  };
}

function renderReview() {
  return render(
    <MemoryRouter>
      <App>
        <ExecutionReview />
      </App>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  approveMutate.mockReset();
  rejectMutate.mockReset();
  runsData = [run()];
  approvalData = approval();
});

describe('P0-3 approval screen shows the exact payload', () => {
  test('shows the exact recipient, not a subject category', () => {
    renderReview();
    expect(screen.getByText(/Exact recipients \(1\)/)).toBeTruthy();
    expect(screen.getByText(/Rep\. Jane Smith \(D, CA, House\)/)).toBeTruthy();
    expect(screen.getByText(/jane@house\.gov/)).toBeTruthy();
  });

  test('shows the exact subject and the full content', () => {
    renderReview();
    expect(screen.getByText('Exact subject')).toBeTruthy();
    expect(screen.getByText('FY27 one-pager')).toBeTruthy();
    expect(screen.getByText(/Line one of the draft/)).toBeTruthy();
  });

  test('discloses what the approval is bound to, including the content hash', () => {
    renderReview();
    expect(
      screen.getByText(/Any change to the recipients, subject, content, plan version/),
    ).toBeTruthy();
    expect(screen.getByText(HASH.slice(0, 12))).toBeTruthy();
    expect(screen.getByText('execution-document-draft@v1')).toBeTruthy();
    expect(screen.getByText('claude-sonnet-5')).toBeTruthy();
  });

  test('states plainly whether approving stages or sends', () => {
    renderReview();
    expect(screen.getByText('Approving STAGES internally')).toBeTruthy();
  });

  test('warns that no recipient resolved rather than showing an empty list', () => {
    approvalData = approval({
      binding: { ...approval().binding, recipients: [] },
    });
    renderReview();
    expect(screen.getByText(/No recipient resolved/)).toBeTruthy();
  });
});

describe('P0-3 approving binds to the hash the reviewer saw', () => {
  test('approve posts the CURRENT contentHash', () => {
    renderReview();
    fireEvent.click(screen.getByRole('button', { name: /Approve exact draft/ }));
    expect(approveMutate.mock.calls[0]![0]).toEqual({ id: 'exec-1', contentHash: HASH });
  });

  test('an already-approved payload disables re-approval and says so', () => {
    approvalData = approval({
      approval: {
        contentHash: HASH,
        binding: approval().binding,
        approvedByUserId: 'u1',
        approvedAt: '2026-07-25T11:00:00.000Z',
        status: 'approved',
      },
      approvalValid: true,
    });
    renderReview();
    const btn = screen.getByRole('button', { name: /^Approved$/ }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(screen.getByText(/Approved .* · hash/)).toBeTruthy();
  });

  test('Request changes and Reject are offered and record a reason', () => {
    renderReview();
    fireEvent.click(screen.getByRole('button', { name: /Request changes/ }));
    expect(rejectMutate.mock.calls[0]![0]).toMatchObject({ id: 'exec-1' });
    expect(String(rejectMutate.mock.calls[0]![0].reason)).toMatch(/changes requested/i);

    rejectMutate.mockReset();
    fireEvent.click(screen.getByRole('button', { name: /^Reject$/ }));
    expect(String(rejectMutate.mock.calls[0]![0].reason)).toMatch(/rejected/i);
  });
});

describe('P0-3 required disclosures', () => {
  test('fallback content carries the audit-specified warning', () => {
    approvalData = approval({
      binding: { ...approval().binding, grounded: false, model: null },
      warnings: { ...approval().warnings, fallbackContent: true },
    });
    renderReview();
    expect(
      screen.getByText(
        /Generated content was unavailable\. This draft uses fallback content and requires completion before use\./,
      ),
    ).toBeTruthy();
  });

  test('plan-version drift is disclosed', () => {
    approvalData = approval({
      warnings: { ...approval().warnings, versionDrift: true, pinnedVersionId: 'v-old' },
    });
    renderReview();
    expect(screen.getByText(/The plan changed since this run was prepared/)).toBeTruthy();
  });

  test('unresolved conflicts are named, both sides', () => {
    approvalData = approval({
      warnings: {
        ...approval().warnings,
        openMaterialConflicts: [
          {
            id: 'cf-1',
            factAId: 'f1',
            factBId: 'f2',
            factA: 'Budget is $4M',
            factB: 'Budget is $6M',
          },
        ],
      },
    });
    renderReview();
    expect(screen.getByText(/1 unresolved context conflict/)).toBeTruthy();
    expect(screen.getByText(/Budget is \$4M/)).toBeTruthy();
    expect(screen.getByText(/Budget is \$6M/)).toBeTruthy();
  });

  test('degraded grounding and missing context are disclosed', () => {
    approvalData = approval({
      warnings: {
        ...approval().warnings,
        groundingStatus: 'degraded',
        missingRequiredContext: ['01_client_profile'],
      },
    });
    renderReview();
    expect(screen.getByText(/missing context: 01_client_profile/)).toBeTruthy();
  });

  test('a changed-since-review payload is badged AND names the fields that moved', () => {
    approvalData = approval({
      approval: {
        contentHash: 'b'.repeat(64),
        binding: approval().binding,
        approvedByUserId: 'u1',
        approvedAt: '2026-07-25T11:00:00.000Z',
        status: 'invalidated',
        invalidatedReason: 'the content and recipients changed after this was approved',
        changedFields: ['body', 'recipients'],
      },
      approvalValid: false,
      approvalInvalidReason: 'the content and recipients changed after this was approved',
      changedFields: ['body', 'recipients'],
      warnings: { ...approval().warnings, changedSinceReview: true },
    });
    renderReview();

    expect(screen.getByText('Changed since review')).toBeTruthy();
    expect(screen.getByText(/A prior approval no longer applies/)).toBeTruthy();
    expect(screen.getByText(/body, recipients/)).toBeTruthy();
  });

  test('a clean payload shows none of the warnings', () => {
    renderReview();
    expect(screen.queryByText(/fallback content/)).toBeNull();
    expect(screen.queryByText(/The plan changed since/)).toBeNull();
    expect(screen.queryByText(/unresolved context conflict/)).toBeNull();
    expect(screen.queryByText('Changed since review')).toBeNull();
  });
});

describe('P0-3 send decisions keep the Stage-H boundary', () => {
  beforeEach(() => {
    runsData = [run({ state: 'waiting_for_input', waitingReason: 'awaiting send approval' })];
    approvalData = approval({
      state: 'waiting_for_input',
      action: 'send',
      effect: 'sends externally',
      binding: { ...approval().binding, action: 'send', channel: 'outreach_record' },
    });
  });

  test('says plainly that approving would SEND externally', () => {
    renderReview();
    expect(screen.getByText('Approving SENDS externally')).toBeTruthy();
  });

  test('the grant control is DISABLED and cannot fire', () => {
    renderReview();
    const btns = screen
      .getAllByRole('button', { name: /Approve exact draft/ })
      .map((b) => b as HTMLButtonElement);
    expect(btns.length).toBeGreaterThan(0);
    for (const b of btns) {
      expect(b.disabled).toBe(true);
      fireEvent.click(b);
    }
    expect(approveMutate).not.toHaveBeenCalled();
  });

  test('the Stage-H reason is shown', () => {
    renderReview();
    expect(screen.getAllByText(SEND_DISABLED_COPY).length).toBeGreaterThan(0);
  });

  test('sendEnabled is never true on the panel data', () => {
    renderReview();
    expect(approvalData!.sendEnabled).toBe(false);
    expect(approvalData!.binding.sendEnabled).toBe(false);
  });
});

describe('P0-3 panel placement', () => {
  test('is absent mid-flight, where there is nothing to approve', () => {
    runsData = [run({ state: 'executing' })];
    renderReview();
    expect(screen.queryByText('Approval')).toBeNull();
  });

  test('is present on an approved run', () => {
    runsData = [run({ state: 'approved' })];
    approvalData = approval({ state: 'approved' });
    renderReview();
    expect(screen.getByText('Approval')).toBeTruthy();
  });
});
