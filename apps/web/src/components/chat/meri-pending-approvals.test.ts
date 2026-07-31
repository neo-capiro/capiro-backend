import { describe, expect, it } from 'vitest';
import {
  describeApprovalOutcome,
  describeApprovalResult,
  outstandingApprovals,
  upsertProposal,
} from './meri-pending-approvals.js';
import type { PendingApproval } from './useMeriChatController.js';

const card = (over: Partial<PendingApproval> = {}): PendingApproval => ({
  proposalId: 'p1',
  status: 'proposed',
  tool: 'update_client_profile',
  preview: {
    label: 'Update client profile',
    riskTier: 'high',
    leavesFirm: false,
    reversible: true,
    fields: {},
    counts: {},
    reason: 'Requires approval',
  },
  expiresAt: '2026-07-28T01:00:00.000Z',
  reason: 'Requires approval',
  riskTier: 'high',
  policyCode: 'crm_mutation',
  policy: {
    source: 'static',
    mode: 'warn',
    packKey: 'capiro-generic-action-approval',
    packVersion: '1',
    binding: 'policy-binding',
    decisionHash: 'policy-decision-hash',
    contextHash: 'policy-context-hash',
    decision: 'WARN',
    jurisdiction: 'federal',
    channel: 'crm',
    recipientType: null,
  },
  attemptCount: 0,
  resultSummary: null,
  createdAt: '2026-07-28T00:45:00.000Z',
  updatedAt: '2026-07-28T00:45:00.000Z',
  ...over,
});

describe('outstandingApprovals', () => {
  it('counts only rows still awaiting a decision — not executing, not resolved', () => {
    const cards = [
      card({ proposalId: 'a', status: 'proposed' }),
      card({ proposalId: 'b', status: 'succeeded' }),
      card({ proposalId: 'c', status: 'failed_retryable' }),
      card({ proposalId: 'd', status: 'executing' }),
      card({ proposalId: 'e', status: 'proposed' }),
      card({ proposalId: 'f', status: 'blocked' }),
      card({ proposalId: 'g', status: 'expired' }),
      card({ proposalId: 'h', status: 'outcome_unknown' }),
    ];
    // failed_retryable is offered its own explicit Retry action, not folded
    // into "Approve all" or the header count — retrying is a deliberate,
    // per-card decision, not a bulk one.
    expect(outstandingApprovals(cards).map((c) => c.proposalId)).toEqual(['a', 'e']);
  });
});

describe('upsertProposal', () => {
  it('appends a genuinely new proposal by id', () => {
    const next = upsertProposal([], card({ proposalId: 'new' }));
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ proposalId: 'new', status: 'proposed' });
  });

  it('survives across turns: an unrelated new proposal never drops the old one', () => {
    // The whole old bug this replaces: a second turn used to wipe the first
    // turn's cards. Each proposal now has its own permanent server identity.
    const first = upsertProposal([], card({ proposalId: 'a' }));
    const second = upsertProposal(first, card({ proposalId: 'b' }));
    expect(second.map((c) => c.proposalId)).toEqual(['a', 'b']);
  });

  it('replaces the existing row in place when the same proposalId recurs (e.g. after approve/dismiss)', () => {
    const prev = [card({ proposalId: 'a', status: 'proposed' }), card({ proposalId: 'b' })];
    const updated = card({ proposalId: 'a', status: 'succeeded', resultSummary: { ok: true } });
    const next = upsertProposal(prev, updated);
    expect(next).toHaveLength(2);
    expect(next[0]).toEqual(updated);
    expect(next[1]).toMatchObject({ proposalId: 'b', status: 'proposed' });
  });

  it('never mutates the input array (pure)', () => {
    const prev = [card({ proposalId: 'a' })];
    const next = upsertProposal(prev, card({ proposalId: 'a', status: 'succeeded' }));
    expect(prev[0]?.status).toBe('proposed');
    expect(next).not.toBe(prev);
  });
});

describe('describeApprovalResult', () => {
  it('surfaces the new client id so the follow-up profile fill can address it', () => {
    // create_client mints a UUID only the server knows. Without this the model
    // re-derives one from the display name — which is how "BryceTech" was
    // proposed as a clientId and the follow-up update was dead on arrival.
    // This reads from the bounded resultSummary the server sends — never the
    // raw tool result.
    const detail = describeApprovalResult({
      ok: true,
      client: { id: 'a3f1c2d4-0000-4000-8000-000000000001', name: 'BryceTech' },
    });
    expect(detail).toBe('BryceTech (id a3f1c2d4-0000-4000-8000-000000000001)');
  });

  it('reports what a profile update actually wrote, not just that it ran', () => {
    const detail = describeApprovalResult({
      ok: true,
      clientName: 'Ballard Partners',
      counts: { fieldsWritten: 2, peopleCreated: 1 },
    });
    expect(detail).toBe('Ballard Partners — 2 fields, 1 person');
  });

  it('returns null when there is nothing worth saying', () => {
    expect(describeApprovalResult(null)).toBeNull();
    expect(describeApprovalResult('sent')).toBeNull();
    expect(describeApprovalResult({ ok: true })).toBeNull();
  });
});

describe('describeApprovalOutcome', () => {
  it('describes success using the bounded result summary', () => {
    const p = card({
      status: 'succeeded',
      resultSummary: { ok: true, clientName: 'Acme', counts: { fieldsWritten: 1 } },
    });
    expect(describeApprovalOutcome(p)).toBe('succeeded — Acme — 1 field');
  });

  it('describes success with no notable detail', () => {
    const p = card({ status: 'succeeded', resultSummary: { ok: true } });
    expect(describeApprovalOutcome(p)).toBe('succeeded');
  });

  it('marks failed_retryable as retryable, distinct from a terminal failure', () => {
    const retryable = card({
      status: 'failed_retryable',
      error: { code: 'transient_failure', message: 'temporarily unavailable' },
    });
    expect(describeApprovalOutcome(retryable)).toBe(
      'failed, can retry — temporarily unavailable',
    );
    const terminal = card({
      status: 'failed_terminal',
      error: { code: 'http_400', message: 'clientId not found' },
    });
    expect(describeApprovalOutcome(terminal)).toBe('failed — clientId not found');
  });

  it('never phrases outcome_unknown as success and explicitly warns against retrying', () => {
    const p = card({ status: 'outcome_unknown' });
    const outcome = describeApprovalOutcome(p);
    expect(outcome).not.toMatch(/succeed/i);
    expect(outcome).toMatch(/do not retry/i);
  });

  it('surfaces the block/expiry reason without implying the action ran', () => {
    expect(describeApprovalOutcome(card({ status: 'blocked', reason: 'Policy now blocks this' }))).toBe(
      'blocked — Policy now blocks this',
    );
    expect(describeApprovalOutcome(card({ status: 'expired' }))).toBe('expired before it could run');
  });
});
