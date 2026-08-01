import { describe, expect, it } from '@jest/globals';
import { buildAssuredClaimLedger, type AssuredEvidence } from './claim-ledger';
import {
  CANONICAL_FEEDBACK_REASON_CODES,
  createFeedbackFixtureCandidate,
  isFeedbackReason,
  normalizeFeedbackReason,
  reviewFeedbackFixtureCandidate,
} from './feedback-fixtures';
import { planGovernmentAffairsEvidence } from './evidence-plan';
import { resolveGovernmentAffairsOperatingFrame } from './operating-frame';
import {
  CAPIRO_APPROVED_GENERIC_POLICY_PACK,
  DISABLED_LEGAL_POLICY_EXAMPLES,
  POLICY_PACK_ACTIONS,
  policyPackRulesHash,
  policyPackRulesMatchHash,
  simulatePolicyPack,
  type PolicySelectionContext,
} from './policy-pack';
import { assurePreToolPersist } from './risk-gate';

const AUTHORITATIVE: AssuredEvidence = {
  id: 'formb:get_bill_status:hr-1234',
  sourceType: 'get_bill_status',
  sourceId: 'hr-1234',
  evidenceClass: 'official_action_vote_status',
  primary: true,
  authoritative: true,
  requirementIds: [],
};

function planFor(request: string) {
  return planGovernmentAffairsEvidence({
    request,
    frame: resolveGovernmentAffairsOperatingFrame({ request }),
    surface: 'chat',
  });
}

describe('assurePreToolPersist', () => {
  it('blocks the WRITE (not just the display) on an unsupported high-risk claim', () => {
    const ledger = buildAssuredClaimLedger(
      [
        {
          text: 'H.R. 1234 was enacted into law on July 1.',
          type: 'fact',
          category: 'enactment',
        },
      ],
      [],
    );
    const result = assurePreToolPersist({
      surface: 'memo',
      plan: planFor('did hr 1234 become public law'),
      ledger,
      subject: 'The policy memo',
    });
    expect(result.allowPersist).toBe(false);
    expect(result.gate.decision).toBe('hold');
    // The refusal must state that NOTHING was written — a "could not release"
    // wording would let the model imply a saved-but-hidden artifact.
    expect(result.refusal).toContain('was NOT created, saved, or persisted');
    expect(result.refusal).toContain('Nothing was written.');
    expect(result.refusal).toContain('The policy memo');
  });

  it('allows the write when the high-risk claim resolves to authoritative evidence', () => {
    const ledger = buildAssuredClaimLedger(
      [
        {
          text: 'H.R. 1234 passed the House on July 1.',
          type: 'fact',
          category: 'bill_status',
          sourceIds: [AUTHORITATIVE.id],
        },
      ],
      [AUTHORITATIVE],
    );
    const result = assurePreToolPersist({
      surface: 'chat',
      plan: {
        ...planFor('hr 1234 status'),
        // Isolate the ledger behaviour from plan-completeness blockers.
        requiredRequirementIds: [],
        incomplete: false,
      },
      ledger,
    });
    expect(result.allowPersist).toBe(true);
    expect(result.refusal).toBe('');
  });

  it('still persists a deliver_with_flags artifact — flags travel with it', () => {
    const ledger = buildAssuredClaimLedger([], []);
    const result = assurePreToolPersist({
      surface: 'chat',
      plan: { ...planFor('general background on the committee'), requiredRequirementIds: [] },
      ledger,
      findings: [
        { check: 'X1', severity: 'high', span: 'x', detail: 'advisory only' },
        { check: 'X2', severity: 'low', span: 'y', detail: 'advisory only' },
      ],
    });
    expect(result.gate.decision).toBe('deliver_with_flags');
    expect(result.allowPersist).toBe(true);
  });
});

describe('feedback reason vocabulary reconciliation', () => {
  it('accepts every LIVE apps/api code (the drift that used to throw)', () => {
    // Mirrors apps/api/src/meri/meri-feedback.helpers.ts FEEDBACK_REASON_CODES.
    const liveCodes = [
      'factually_wrong',
      'outdated',
      'wrong_client_context',
      'missed_source',
      'unsupported_claim',
      'too_generic',
      'bad_recommendation',
      'wrong_tone_or_format',
      'compliance_concern',
      'tool_or_action_failed',
    ] as const;
    for (const code of liveCodes) {
      expect(isFeedbackReason(code)).toBe(true);
      expect(normalizeFeedbackReason(code)).toBe(code);
    }
    // Every canonical code here must be a live code and vice versa, so the two
    // lists cannot silently drift apart again.
    expect([...CANONICAL_FEEDBACK_REASON_CODES].sort()).toEqual([...liveCodes].sort());
  });

  it('still accepts the legacy meriv2-core spellings, normalized to canonical', () => {
    expect(normalizeFeedbackReason('wrong_tone_format')).toBe('wrong_tone_or_format');
    expect(normalizeFeedbackReason('tool_action_failed')).toBe('tool_or_action_failed');
  });

  it('creates a candidate from a live-spelling-only thumbs-down instead of throwing', () => {
    const candidate = createFeedbackFixtureCandidate({
      reasonCodes: ['wrong_tone_or_format', 'tool_or_action_failed'],
      surface: 'chat',
      createdByUserId: 'user-1',
    });
    expect(candidate.reasonCodes).toEqual(['wrong_tone_or_format', 'tool_or_action_failed']);
    expect(candidate.status).toBe('pending_review');
  });

  it('collapses an alias and its canonical form to ONE code', () => {
    const candidate = createFeedbackFixtureCandidate({
      reasonCodes: ['wrong_tone_format', 'wrong_tone_or_format'],
      surface: 'chat',
      createdByUserId: 'user-1',
    });
    expect(candidate.reasonCodes).toEqual(['wrong_tone_or_format']);
  });

  it('rejects unrecognized codes and never auto-accepts feedback as golden truth', () => {
    expect(normalizeFeedbackReason('made_up')).toBeNull();
    expect(() =>
      createFeedbackFixtureCandidate({
        reasonCodes: ['made_up' as never],
        surface: 'chat',
        createdByUserId: 'user-1',
      }),
    ).toThrow(/valid feedback reason/i);

    const candidate = createFeedbackFixtureCandidate({
      reasonCodes: ['factually_wrong'],
      surface: 'chat',
      createdByUserId: 'user-1',
    });
    expect(() =>
      reviewFeedbackFixtureCandidate(candidate, {
        decision: 'accept',
        reviewerUserId: 'reviewer-1',
        reviewReason: 'reproduced',
        anonymizationVersion: '',
        datasetVersion: 'ga-goldens-v1.1.0',
      }),
    ).toThrow(/anonymized/i);
  });
});

describe('policy pack persistence helpers', () => {
  const context: PolicySelectionContext = {
    tenantId: 't1',
    actorUserId: 'u1',
    actorRole: 'user_admin',
    jurisdiction: 'federal',
    tool: 'send_email',
    channel: 'email',
    recipientType: 'government',
    at: '2026-07-29T00:00:00.000Z',
  };

  it('hashes the decision-bearing rule material, not the lifecycle metadata', () => {
    const hash = policyPackRulesHash(CAPIRO_APPROVED_GENERIC_POLICY_PACK);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(policyPackRulesMatchHash(CAPIRO_APPROVED_GENERIC_POLICY_PACK, hash)).toBe(true);
    // Review/publish attribution and changelog churn must NOT change the hash.
    expect(
      policyPackRulesHash({
        ...CAPIRO_APPROVED_GENERIC_POLICY_PACK,
        publishedByUserId: 'someone-else',
        changelog: [
          ...CAPIRO_APPROVED_GENERIC_POLICY_PACK.changelog,
          { at: '2026-07-29T00:00:00.000Z', actorUserId: 'u1', note: 'republished' },
        ],
      }),
    ).toBe(hash);
  });

  it('detects an out-of-band rule edit (tamper evidence for a persisted row)', () => {
    const tampered = {
      ...CAPIRO_APPROVED_GENERIC_POLICY_PACK,
      rules: CAPIRO_APPROVED_GENERIC_POLICY_PACK.rules.map((rule) =>
        rule.id === 'send.requires_approval' ? { ...rule, outcome: 'PASS' as const } : rule,
      ),
    };
    expect(
      policyPackRulesMatchHash(tampered, policyPackRulesHash(CAPIRO_APPROVED_GENERIC_POLICY_PACK)),
    ).toBe(false);
  });

  it('stamps every simulation as simulated so it can never read as enforcement', () => {
    const decision = simulatePolicyPack(CAPIRO_APPROVED_GENERIC_POLICY_PACK, context);
    expect(decision.simulated).toBe(true);
    expect(decision.outcome).toBe('WARN');
    expect(decision.ruleId).toBe('send.requires_approval');
  });

  it('never lets a disabled legal example simulate a substantive rule', () => {
    for (const example of DISABLED_LEGAL_POLICY_EXAMPLES) {
      const decision = simulatePolicyPack(example, context);
      expect(decision.simulated).toBe(true);
      // Zero rules ⇒ the fail-safe fallback, never a PASS.
      expect(decision.ruleId).toBeNull();
      expect(decision.outcome).toBe('WARN');
    }
  });

  it('enumerates exactly the actions the append-only event ledger accepts', () => {
    expect([...POLICY_PACK_ACTIONS]).toEqual([
      'create',
      // A revision of an existing draft is its own ledger action; the policy-pack
      // service records it when a pack is revised before review.
      'revise',
      'submit_review',
      'review',
      'approve',
      'publish',
      'retire',
      'rollback',
      'simulate',
    ]);
  });
});
