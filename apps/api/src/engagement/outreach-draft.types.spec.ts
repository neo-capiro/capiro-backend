// Engagement Phase 0 (plan §3.a3) — the send gate, exhaustively.
//
// isDraftVersionSendable() is the ONLY place sendability is decided, so this
// spec walks every (auditStatus × approvalStatus) pair rather than sampling.
// A regression here is a regression in the external-send trust boundary.

import { describe, expect, test } from '@jest/globals';
import {
  isDeliveryAutoRetryable,
  isDraftVersionSendable,
  OUTREACH_DRAFT_VERSION_SUBJECT_TYPE,
  TERMINAL_DELIVERY_STATUSES,
  type DraftApprovalStatus,
  type DraftAuditStatus,
  type OutreachDeliveryStatus,
} from './outreach-draft.types.js';

const AUDIT: DraftAuditStatus[] = [
  'not_required',
  'pending',
  'passed',
  'warning',
  'held',
  'unavailable',
];
const APPROVAL: DraftApprovalStatus[] = ['not_required', 'pending', 'approved', 'rejected'];

/** The spec's policy, written independently of the implementation. */
function expected(auditStatus: DraftAuditStatus, approvalStatus: DraftApprovalStatus): boolean {
  if (approvalStatus === 'pending' || approvalStatus === 'rejected') return false;
  return auditStatus === 'not_required' || auditStatus === 'passed' || auditStatus === 'warning';
}

describe('isDraftVersionSendable — full matrix', () => {
  for (const auditStatus of AUDIT) {
    for (const approvalStatus of APPROVAL) {
      const want = expected(auditStatus, approvalStatus);
      test(`audit=${auditStatus} approval=${approvalStatus} → ${want ? 'sendable' : 'BLOCKED'}`, () => {
        expect(isDraftVersionSendable({ auditStatus, approvalStatus })).toBe(want);
      });
    }
  }
});

describe('isDraftVersionSendable — the invariants that matter', () => {
  test('not_required audit is sendable (auditor off for this tenant)', () => {
    expect(
      isDraftVersionSendable({ auditStatus: 'not_required', approvalStatus: 'not_required' }),
    ).toBe(true);
  });

  test('passed audit is sendable', () => {
    expect(isDraftVersionSendable({ auditStatus: 'passed', approvalStatus: 'not_required' })).toBe(
      true,
    );
  });

  test('warning audit is sendable UNLESS a reviewer rejected it', () => {
    expect(isDraftVersionSendable({ auditStatus: 'warning', approvalStatus: 'not_required' })).toBe(
      true,
    );
    expect(isDraftVersionSendable({ auditStatus: 'warning', approvalStatus: 'rejected' })).toBe(
      false,
    );
  });

  test('held is NEVER sendable on approval alone — approval must also flip audit to passed', () => {
    // The exact state a reviewer's approval must NOT leave behind.
    expect(isDraftVersionSendable({ auditStatus: 'held', approvalStatus: 'approved' })).toBe(false);
    // What approveVersion() actually writes on the same immutable row.
    expect(isDraftVersionSendable({ auditStatus: 'passed', approvalStatus: 'approved' })).toBe(true);
  });

  test('a pending audit blocks — a committed version is not sendable before its verdict', () => {
    for (const approvalStatus of APPROVAL) {
      expect(isDraftVersionSendable({ auditStatus: 'pending', approvalStatus })).toBe(false);
    }
  });

  test('unavailable blocks under every approval state (enforce-mode fail-closed)', () => {
    for (const approvalStatus of APPROVAL) {
      expect(isDraftVersionSendable({ auditStatus: 'unavailable', approvalStatus })).toBe(false);
    }
  });

  test('a pending approval blocks under every audit state', () => {
    for (const auditStatus of AUDIT) {
      expect(isDraftVersionSendable({ auditStatus, approvalStatus: 'pending' })).toBe(false);
    }
  });

  test('a rejected approval blocks under every audit state', () => {
    for (const auditStatus of AUDIT) {
      expect(isDraftVersionSendable({ auditStatus, approvalStatus: 'rejected' })).toBe(false);
    }
  });

  test('an UNRECOGNIZED audit status fails closed (future status must opt in)', () => {
    const rogue = { auditStatus: 'brand_new_status', approvalStatus: 'approved' } as unknown as {
      auditStatus: DraftAuditStatus;
      approvalStatus: DraftApprovalStatus;
    };
    expect(isDraftVersionSendable(rogue)).toBe(false);
  });
});

describe('delivery status contracts', () => {
  test('unknown is terminal and is NOT auto-retryable (at-most-once)', () => {
    expect(TERMINAL_DELIVERY_STATUSES).toContain('unknown');
    expect(isDeliveryAutoRetryable('unknown')).toBe(false);
  });

  test('no delivery status is ever auto-retryable — retry is a NEW intent, chosen by a human', () => {
    const all: OutreachDeliveryStatus[] = [
      'pending',
      'sending',
      'sent',
      'failed',
      'unknown',
      'skipped',
      'held',
    ];
    for (const s of all) expect(isDeliveryAutoRetryable(s)).toBe(false);
  });

  test('pending/sending are the only non-terminal statuses', () => {
    expect(TERMINAL_DELIVERY_STATUSES).not.toContain('pending');
    expect(TERMINAL_DELIVERY_STATUSES).not.toContain('sending');
    expect([...TERMINAL_DELIVERY_STATUSES].sort()).toEqual(
      ['failed', 'held', 'sent', 'skipped', 'unknown'].sort(),
    );
  });

  test('held versions get their own review subjectType, distinct from the legacy content key', () => {
    expect(OUTREACH_DRAFT_VERSION_SUBJECT_TYPE).toBe('outreach-draft-version');
    expect(OUTREACH_DRAFT_VERSION_SUBJECT_TYPE).not.toBe('outreach-draft');
  });
});
