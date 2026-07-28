// Engagement Phase 0 (plan §3.a3) — the send gate, exhaustively.
//
// isDraftVersionSendable() is the ONLY place sendability is decided, so this
// spec walks every (auditStatus × approvalStatus) pair rather than sampling.
// A regression here is a regression in the external-send trust boundary.

import { describe, expect, test } from '@jest/globals';
import {
  canTransitionOutreachDelivery,
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
});

describe('canTransitionOutreachDelivery — the full matrix (plan §g1)', () => {
  const ALL: OutreachDeliveryStatus[] = [
    'pending',
    'sending',
    'sent',
    'failed',
    'unknown',
    'skipped',
    'held',
  ];
  const ALLOWED: Array<[OutreachDeliveryStatus, OutreachDeliveryStatus]> = [
    ['pending', 'sending'],
    ['pending', 'skipped'],
    ['sending', 'sent'],
    ['sending', 'failed'],
    ['sending', 'unknown'],
  ];

  test('every named transition is allowed', () => {
    for (const [from, to] of ALLOWED) {
      expect(canTransitionOutreachDelivery(from, to)).toBe(true);
    }
  });

  test('every OTHER pair in the full cross product is forbidden — including every pair not named above', () => {
    const allowedSet = new Set(ALLOWED.map(([f, t]) => `${f}>${t}`));
    let checked = 0;
    for (const from of ALL) {
      for (const to of ALL) {
        checked++;
        const expectedAllowed = allowedSet.has(`${from}>${to}`);
        expect(canTransitionOutreachDelivery(from, to)).toBe(expectedAllowed);
      }
    }
    expect(checked).toBe(ALL.length * ALL.length); // 49 — proves the loop actually ran
  });

  test('no terminal status ever transitions anywhere, including back to itself', () => {
    for (const terminal of TERMINAL_DELIVERY_STATUSES) {
      for (const to of ALL) {
        expect(canTransitionOutreachDelivery(terminal, to)).toBe(false);
      }
    }
  });

  test('unknown never transitions — not even to sent — matching Open Decision §6.2', () => {
    for (const to of ALL) {
      expect(canTransitionOutreachDelivery('unknown', to)).toBe(false);
    }
  });

  test('sending never returns to pending', () => {
    expect(canTransitionOutreachDelivery('sending', 'pending')).toBe(false);
  });

  test('held versions get their own review subjectType, distinct from the legacy content key', () => {
    expect(OUTREACH_DRAFT_VERSION_SUBJECT_TYPE).toBe('outreach-draft-version');
    expect(OUTREACH_DRAFT_VERSION_SUBJECT_TYPE).not.toBe('outreach-draft');
  });
});
