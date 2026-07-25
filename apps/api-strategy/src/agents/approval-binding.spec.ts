import { describe, expect, it } from '@jest/globals';
import {
  canonicalizeApproval,
  computeApprovalHash,
  contextPackFingerprint,
  describeChangedFields,
  diffBindings,
  invalidateApproval,
  recordApproval,
  verifyApproval,
  type ApprovalBinding,
} from './approval-binding.js';

/*
 * P0-3. These tests ARE the audit's acceptance criteria, one describe block each:
 *
 *   - Editing one character invalidates approval.
 *   - Changing a recipient invalidates approval.
 *   - Regeneration invalidates approval.
 *   - Strategy-version drift invalidates approval.
 *   - The audit record can reproduce the exact approved payload.
 *
 * Plus the property that makes the whole thing trustworthy: EVERY field in
 * ApprovalBinding must be hash-bound, so a future field added to the interface
 * cannot silently become non-invalidating.
 */

const APPROVER = 'user-approver';
const AT = new Date('2026-07-25T18:00:00.000Z');

function binding(over: Partial<ApprovalBinding> = {}): ApprovalBinding {
  return {
    strategyId: 'S1',
    strategyVersionId: 'v-head',
    nodeId: 'N1',
    runId: 'R1',
    action: 'send',
    channel: 'outreach_record',
    subject: 'Please co-sign our FY27 appropriations letter',
    body: 'Dear office,\n\nWe would value your support on the FY27 request.\n\nRegards,\nCapiro',
    recipients: [
      { id: 'ct-1', name: 'Rep. A office', address: 'a@house.gov' },
      { id: 'ct-2', name: 'Rep. B office', address: 'b@house.gov' },
    ],
    attachments: [],
    templateVersion: 'execution-document-draft@v1',
    contextPackFingerprint: 'abc123',
    groundingStatus: 'ok',
    grounded: true,
    model: 'claude-sonnet-5',
    provider: 'anthropic',
    sendEnabled: false,
    ...over,
  };
}

const approved = (b = binding()) => recordApproval(b, APPROVER, AT);

describe('P0-3 acceptance: editing one character invalidates approval', () => {
  it('a single character in the body invalidates', () => {
    const rec = approved();
    const edited = binding({ body: binding().body + '.' });
    const v = verifyApproval(edited, rec);
    expect(v.valid).toBe(false);
    expect(v.changedFields).toEqual(['body']);
    expect(v.reason).toMatch(/the content changed after this was approved/i);
  });

  it('a WHITESPACE-only body edit still invalidates (the body is hashed verbatim)', () => {
    // Deliberately stricter than send-approval.ts's normalizing token: a
    // collapsing hash would tolerate edits that change what a recipient reads.
    const rec = approved();
    const v = verifyApproval(
      binding({ body: binding().body.replace('Dear office,', 'Dear  office,') }),
      rec,
    );
    expect(v.valid).toBe(false);
    expect(v.changedFields).toEqual(['body']);
  });

  it('a single character in the subject invalidates', () => {
    const rec = approved();
    const v = verifyApproval(binding({ subject: binding().subject + '!' }), rec);
    expect(v.valid).toBe(false);
    expect(v.changedFields).toEqual(['subject']);
  });

  it('an untouched payload stays valid', () => {
    expect(verifyApproval(binding(), approved())).toEqual({ valid: true, changedFields: [] });
  });
});

describe('P0-3 acceptance: changing a recipient invalidates approval', () => {
  it('adding a recipient invalidates', () => {
    const rec = approved();
    const v = verifyApproval(
      binding({
        recipients: [
          ...binding().recipients,
          { id: 'ct-3', name: 'Rep. C office', address: 'c@house.gov' },
        ],
      }),
      rec,
    );
    expect(v.valid).toBe(false);
    expect(v.changedFields).toEqual(['recipients']);
  });

  it('removing a recipient invalidates', () => {
    const rec = approved();
    const v = verifyApproval(binding({ recipients: [binding().recipients[0]!] }), rec);
    expect(v.valid).toBe(false);
    expect(v.changedFields).toEqual(['recipients']);
  });

  it('swapping a recipient IDENTITY invalidates even when the display name matches', () => {
    const rec = approved();
    const v = verifyApproval(
      binding({
        recipients: [
          { id: 'ct-999', name: 'Rep. A office', address: 'a@house.gov' },
          binding().recipients[1]!,
        ],
      }),
      rec,
    );
    expect(v.valid).toBe(false);
    expect(v.changedFields).toEqual(['recipients']);
  });

  it('changing only the ADDRESS invalidates — the same person at a new address is a new send', () => {
    const rec = approved();
    const v = verifyApproval(
      binding({
        recipients: [
          { id: 'ct-1', name: 'Rep. A office', address: 'different@house.gov' },
          binding().recipients[1]!,
        ],
      }),
      rec,
    );
    expect(v.valid).toBe(false);
    expect(v.changedFields).toEqual(['recipients']);
  });

  it('REORDERING recipients does NOT invalidate — order carries no meaning', () => {
    const rec = approved();
    const reversed = binding({ recipients: [...binding().recipients].reverse() });
    expect(verifyApproval(reversed, rec).valid).toBe(true);
  });

  it('address casing and padding are not material', () => {
    const rec = approved();
    const v = verifyApproval(
      binding({
        recipients: [
          { id: 'ct-1', name: 'Rep. A office', address: '  A@House.gov ' },
          binding().recipients[1]!,
        ],
      }),
      rec,
    );
    expect(v.valid).toBe(true);
  });
});

describe('P0-3 acceptance: regeneration invalidates approval', () => {
  it('a different model invalidates even when the prose is identical', () => {
    const rec = approved();
    const v = verifyApproval(binding({ model: 'claude-opus-5' }), rec);
    expect(v.valid).toBe(false);
    expect(v.changedFields).toEqual(['model']);
  });

  it('falling back to deterministic content invalidates', () => {
    // The dangerous case: generation failed, the shell was substituted, and the
    // reviewer's approval of grounded prose must not carry over to a placeholder.
    const rec = approved();
    const v = verifyApproval(binding({ grounded: false, model: null }), rec);
    expect(v.valid).toBe(false);
    expect(v.changedFields.sort()).toEqual(['grounded', 'model']);
  });

  it('a template version bump invalidates', () => {
    const rec = approved();
    const v = verifyApproval(binding({ templateVersion: 'execution-document-draft@v2' }), rec);
    expect(v.valid).toBe(false);
    expect(v.changedFields).toEqual(['templateVersion']);
  });

  it('a context-pack refresh invalidates', () => {
    const rec = approved();
    const v = verifyApproval(binding({ contextPackFingerprint: 'def456' }), rec);
    expect(v.valid).toBe(false);
    expect(v.changedFields).toEqual(['contextPackFingerprint']);
  });

  it('a grounding-health change invalidates', () => {
    const rec = approved();
    const v = verifyApproval(binding({ groundingStatus: 'conflicted' }), rec);
    expect(v.valid).toBe(false);
    expect(v.changedFields).toEqual(['groundingStatus']);
  });
});

describe('P0-3 acceptance: strategy-version drift invalidates approval', () => {
  it('a moved plan head invalidates', () => {
    const rec = approved();
    const v = verifyApproval(binding({ strategyVersionId: 'v-newer' }), rec);
    expect(v.valid).toBe(false);
    expect(v.changedFields).toEqual(['strategyVersionId']);
    expect(v.reason).toMatch(/plan version changed/i);
  });

  it('a different node invalidates', () => {
    const rec = approved();
    const v = verifyApproval(binding({ nodeId: 'N2' }), rec);
    expect(v.valid).toBe(false);
    expect(v.changedFields).toEqual(['nodeId']);
  });

  it('an approval from ANOTHER run never satisfies this one', () => {
    const rec = approved(binding({ runId: 'R-other' }));
    const v = verifyApproval(binding({ runId: 'R1' }), rec);
    expect(v.valid).toBe(false);
    expect(v.reason).toMatch(/different run/i);
    expect(v.reason).toMatch(/no standing or prior approval/i);
  });
});

describe('P0-3: the send-policy binding', () => {
  it('an approval granted while sending was DISABLED does not carry into an enabled world', () => {
    // The whole reason sendEnabled is bound: flipping the Stage-H switch must not
    // silently promote every historic approval into a send authorisation.
    const rec = approved(binding({ sendEnabled: false }));
    const v = verifyApproval(binding({ sendEnabled: true }), rec);
    expect(v.valid).toBe(false);
    expect(v.changedFields).toEqual(['sendEnabled']);
    expect(v.reason).toMatch(/send policy changed/i);
  });

  it('approving to STAGE does not authorise a SEND', () => {
    const rec = approved(binding({ action: 'stage' }));
    const v = verifyApproval(binding({ action: 'send' }), rec);
    expect(v.valid).toBe(false);
    expect(v.changedFields).toEqual(['action']);
  });
});

describe('P0-3 acceptance: the audit record reproduces the exact approved payload', () => {
  it('stores the full binding verbatim, not just its hash', () => {
    const b = binding();
    const rec = approved(b);
    // Byte-identical body and subject — a hash alone proves a match but
    // reproduces nothing.
    expect(rec.binding.body).toBe(b.body);
    expect(rec.binding.subject).toBe(b.subject);
    expect(rec.binding.recipients).toEqual(b.recipients);
    expect(rec.binding).toEqual(b);
  });

  it('records who approved and when', () => {
    const rec = approved();
    expect(rec.approvedByUserId).toBe(APPROVER);
    expect(rec.approvedAt).toBe(AT.toISOString());
    expect(rec.status).toBe('approved');
  });

  it('the stored payload re-hashes to the stored hash', () => {
    const rec = approved();
    expect(computeApprovalHash(rec.binding)).toBe(rec.contentHash);
  });

  it('invalidation PRESERVES the original binding (history is not rewritten)', () => {
    const b = binding();
    const rec = approved(b);
    const drifted = binding({ body: 'something else entirely' });
    const v = verifyApproval(drifted, rec);
    const dead = invalidateApproval(rec, v, new Date('2026-07-25T19:00:00.000Z'));

    expect(dead.status).toBe('invalidated');
    expect(dead.invalidatedReason).toMatch(/content changed/i);
    expect(dead.changedFields).toEqual(['body']);
    // The approved payload is still exactly reproducible after invalidation.
    expect(dead.binding).toEqual(b);
    expect(dead.contentHash).toBe(rec.contentHash);
    expect(dead.approvedByUserId).toBe(APPROVER);
  });

  it('an invalidated approval never verifies again, even against its own payload', () => {
    const b = binding();
    const dead = invalidateApproval(
      approved(b),
      { valid: false, reason: 'the content changed', changedFields: ['body'] },
      AT,
    );
    const v = verifyApproval(b, dead);
    expect(v.valid).toBe(false);
    expect(v.reason).toMatch(/content changed/i);
  });
});

describe('P0-3: no approval at all', () => {
  it('a missing approval is not valid', () => {
    expect(verifyApproval(binding(), null).valid).toBe(false);
    expect(verifyApproval(binding(), null).reason).toMatch(/no approval on record/i);
    expect(verifyApproval(binding(), undefined).valid).toBe(false);
  });
});

describe('P0-3: EVERY bound field is hash-bound (regression guard)', () => {
  /*
   * The property that makes this module trustworthy: adding a field to
   * ApprovalBinding must make it invalidating. This walks every key on a real
   * binding, perturbs it, and asserts BOTH that the hash moves and that
   * diffBindings names it — so a new field that someone forgets to add to the
   * canonical serialization or the diff fails here rather than silently
   * becoming approval-transparent.
   */
  const perturb: Record<string, unknown> = {
    strategyId: 'S-other',
    strategyVersionId: 'v-other',
    nodeId: 'N-other',
    runId: 'R-other',
    action: 'stage',
    channel: 'workspace_draft',
    subject: 'different subject',
    body: 'different body',
    recipients: [{ id: 'zz', name: 'Someone Else', address: 'z@z.gov' }],
    attachments: ['att-1'],
    templateVersion: 'other@v9',
    contextPackFingerprint: 'other-fp',
    groundingStatus: 'degraded',
    grounded: false,
    model: 'other-model',
    provider: 'other-provider',
    sendEnabled: true,
  };

  it('covers every key on ApprovalBinding', () => {
    expect(Object.keys(perturb).sort()).toEqual(Object.keys(binding()).sort());
  });

  it.each(Object.keys(perturb))(
    'changing %s changes the hash and is named by the diff',
    (field) => {
      const base = binding();
      const mutated = { ...base, [field]: perturb[field] } as ApprovalBinding;

      expect(computeApprovalHash(mutated)).not.toBe(computeApprovalHash(base));
      expect(diffBindings(base, mutated)).toContain(field);
      expect(verifyApproval(mutated, approved(base)).valid).toBe(false);
    },
  );
});

describe('canonicalizeApproval / hashing mechanics', () => {
  it('is stable across key insertion order', () => {
    const a = binding();
    const reordered = JSON.parse(JSON.stringify(a)) as ApprovalBinding;
    expect(canonicalizeApproval(reordered)).toBe(canonicalizeApproval(a));
  });

  it('de-duplicates identical recipients', () => {
    const dup = binding({ recipients: [binding().recipients[0]!, binding().recipients[0]!] });
    const single = binding({ recipients: [binding().recipients[0]!] });
    expect(computeApprovalHash(dup)).toBe(computeApprovalHash(single));
  });

  it('treats attachments as an unordered set', () => {
    const a = binding({ attachments: ['x', 'y'] });
    const b = binding({ attachments: ['y', 'x'] });
    expect(computeApprovalHash(a)).toBe(computeApprovalHash(b));
  });

  it('an added attachment invalidates', () => {
    const rec = approved(binding({ attachments: ['x'] }));
    expect(verifyApproval(binding({ attachments: ['x', 'y'] }), rec).valid).toBe(false);
  });
});

describe('describeChangedFields', () => {
  it('renders plain words, not field names', () => {
    expect(describeChangedFields(['body'])).toBe('the content');
    expect(describeChangedFields(['strategyVersionId'])).toBe('the plan version');
    expect(describeChangedFields(['body', 'recipients'])).toBe('the content and recipients');
    expect(describeChangedFields(['body', 'recipients', 'subject'])).toBe(
      'the content, recipients and subject',
    );
  });

  it('handles the empty case', () => {
    expect(describeChangedFields([])).toBe('nothing');
  });
});

describe('contextPackFingerprint', () => {
  it('is stable for the same inputs regardless of order', () => {
    const a = contextPackFingerprint({
      groundingStatus: 'ok',
      missingRequired: ['02_positions', '01_profile'],
      citedFactRefs: ['fact:b', 'fact:a'],
    });
    const b = contextPackFingerprint({
      groundingStatus: 'ok',
      missingRequired: ['01_profile', '02_positions'],
      citedFactRefs: ['fact:a', 'fact:b'],
    });
    expect(a).toBe(b);
  });

  it('changes when the cited facts change (a context refresh must invalidate)', () => {
    const before = contextPackFingerprint({ groundingStatus: 'ok', citedFactRefs: ['fact:a'] });
    const after = contextPackFingerprint({
      groundingStatus: 'ok',
      citedFactRefs: ['fact:a', 'fact:c'],
    });
    expect(before).not.toBe(after);
  });

  it('changes when an open material conflict appears', () => {
    const clean = contextPackFingerprint({ groundingStatus: 'ok' });
    const conflicted = contextPackFingerprint({
      groundingStatus: 'ok',
      openMaterialConflictIds: ['cf-1'],
    });
    expect(clean).not.toBe(conflicted);
  });
});
