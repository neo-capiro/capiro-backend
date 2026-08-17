import type { BudgetLineIdentityV1 } from '../../../contracts/extraction-artifact-v1.js';
import {
  defenseBudgetStageActionV1Schema,
  normalizeLegacyCommitteeStageActionV1,
  type DefenseBudgetStageActionV1,
} from './defense-budget-stage-action-v1.js';
import { verifyAppropriationsActionsV1 } from './appropriations-action-verifier-v1.js';
import { buildVerifiedStageActionProjectionPlanV1 } from './appropriations-action-projection-v1.js';

const PE: BudgetLineIdentityV1 = { lineKind: 'RDTE_PE', peCode: '0605053A' };
const PE2: BudgetLineIdentityV1 = { lineKind: 'RDTE_PE', peCode: '0603270A' };
const money = (value: string) => ({
  originalValue: value,
  originalUnit: 'millions' as const,
  valueMillions: value,
});
function action(overrides: Partial<DefenseBudgetStageActionV1> = {}): DefenseBudgetStageActionV1 {
  return defenseBudgetStageActionV1Schema.parse({
    schemaVersion: 'defense_budget_stage_action_v1',
    actionId: 'action-1',
    track: 'appropriations',
    stage: 'hac_d',
    authority: 'hacd_appropriations',
    vehicleClass: 'committee_report',
    actionType: 'increase',
    identity: PE,
    fiscalYear: 2027,
    amount: money('5'),
    signedValueMillions: '5',
    direction: 'increase',
    evidenceIds: ['e1'],
    languageEvidenceIds: [],
    directOrDerived: 'direct',
    ...overrides,
  });
}

describe('Phase 6 Workstream J typed appropriations actions', () => {
  it('preserves increase and decrease as separate actions', () => {
    const result = verifyAppropriationsActionsV1({
      actions: [
        action(),
        action({
          actionId: 'action-2',
          actionType: 'decrease',
          amount: money('2'),
          signedValueMillions: '-2',
          direction: 'decrease',
        }),
      ],
    });
    expect(result.status).toBe('PASS');
    expect(result.preservedActionCount).toBe(2);
    expect(result.silentlyNettedActionCount).toBe(0);
  });

  it('accepts an exact transfer pair with source and destination', () => {
    const result = verifyAppropriationsActionsV1({
      actions: [
        action({
          actionId: 'out',
          actionType: 'transfer_out',
          identity: undefined,
          sourceIdentity: PE,
          destinationIdentity: PE2,
          transferGroupId: 't1',
          amount: money('3'),
          signedValueMillions: '-3',
          direction: 'out',
        }),
        action({
          actionId: 'in',
          actionType: 'transfer_in',
          identity: undefined,
          sourceIdentity: PE,
          destinationIdentity: PE2,
          transferGroupId: 't1',
          amount: money('3'),
          signedValueMillions: '3',
          direction: 'in',
        }),
      ],
    });
    expect(result.status).toBe('PASS');
  });

  it('blocks a one-sided transfer', () => {
    const result = verifyAppropriationsActionsV1({
      actions: [
        action({
          actionType: 'transfer_out',
          identity: undefined,
          sourceIdentity: PE,
          destinationIdentity: PE2,
          transferGroupId: 't1',
          amount: money('3'),
          signedValueMillions: '-3',
          direction: 'out',
        }),
      ],
    });
    expect(result.status).toBe('BLOCKED');
    expect(result.findings.some((finding) => finding.code === 'transfer_pair_incomplete')).toBe(true);
  });

  it('requires rescissions to remain negative', () => {
    const invalid = {
      ...action(),
      actionType: 'rescission',
      signedValueMillions: '5',
      direction: 'decrease',
    };
    const result = verifyAppropriationsActionsV1({ actions: [invalid] });
    expect(result.status).toBe('BLOCKED');
    expect(result.findings[0]?.code).toBe('action_schema_invalid');
  });

  it('keeps undistributed/package-wide actions out of line identity', () => {
    const item = action({
      actionType: 'undistributed_adjustment',
      identity: undefined,
      packageScope: 'TITLE II',
      signedValueMillions: '-4',
      amount: money('4'),
      direction: 'decrease',
    });
    expect(item.identity).toBeUndefined();
    expect(item.packageScope).toBe('TITLE II');
  });

  it('blocks sign, direction, and signed-magnitude mismatches', () => {
    expect(
      verifyAppropriationsActionsV1({
        actions: [
          {
            ...action(),
            actionType: 'decrease',
            signedValueMillions: '5',
            direction: 'decrease',
          },
        ],
      }).status,
    ).toBe('BLOCKED');
    expect(
      verifyAppropriationsActionsV1({
        actions: [{ ...action(), direction: 'decrease' }],
      }).status,
    ).toBe('BLOCKED');
    expect(
      verifyAppropriationsActionsV1({
        actions: [{ ...action(), signedValueMillions: '6' }],
      }).status,
    ).toBe('BLOCKED');
  });

  it('rejects an invalid money unit at the contract boundary', () => {
    expect(() =>
      defenseBudgetStageActionV1Schema.parse({
        ...action(),
        amount: { originalValue: '5', originalUnit: 'billions', valueMillions: '5000' },
      }),
    ).toThrow();
  });

  it('verifies baseline + change = after exactly and preserves printed units', () => {
    const result = verifyAppropriationsActionsV1({
      actions: [action({ baseline: money('100'), after: money('105') })],
    });
    expect(result.status).toBe('PASS');
    const bad = verifyAppropriationsActionsV1({
      actions: [action({ baseline: money('100'), after: money('106') })],
    });
    expect(bad.status).toBe('BLOCKED');
    expect(bad.findings.some((finding) => finding.code === 'baseline_change_after_mismatch')).toBe(
      true,
    );
    const wrongUnit = verifyAppropriationsActionsV1({
      actions: [
        action({
          baseline: money('100'),
          after: { originalValue: '105000', originalUnit: 'thousands', valueMillions: '105' },
        }),
      ],
    });
    expect(wrongUnit.findings.some((finding) => finding.code === 'baseline_change_after_unit_mismatch')).toBe(true);
  });

  it('requires action/report-language evidence to intersect', () => {
    const item = action({ languageEvidenceIds: ['e1'] });
    expect(
      verifyAppropriationsActionsV1({
        actions: [item],
        languageFacts: [
          {
            languageFactId: 'l1',
            stage: 'hac_d',
            sourceDocumentId: 'doc',
            sourceSha256: 'a'.repeat(64),
            text: 'The Committee directs...',
            evidenceIds: ['e1'],
            actionIds: ['action-1'],
          },
        ],
      }).status,
    ).toBe('PASS');
    expect(
      verifyAppropriationsActionsV1({
        actions: [item],
        languageFacts: [
          {
            languageFactId: 'l1',
            stage: 'hac_d',
            sourceDocumentId: 'doc',
            sourceSha256: 'a'.repeat(64),
            text: 'The Committee directs...',
            evidenceIds: ['other'],
            actionIds: ['action-1'],
          },
        ],
      }).status,
    ).toBe('BLOCKED');
  });

  it('normalizes legacy H/I committee actions into the stricter magnitude contract', () => {
    const normalized = normalizeLegacyCommitteeStageActionV1({
      schemaVersion: 'defense_budget_stage_action_v1',
      actionId: 'legacy-decrease',
      track: 'appropriations',
      stage: 'hac_d',
      authority: 'hacd_appropriations',
      actionType: 'decrease',
      identity: PE,
      fiscalYear: 2027,
      amount: {
        originalValue: '-5',
        originalUnit: 'millions',
        valueMillions: '-5',
      },
      signedValueMillions: '-5',
      evidenceIds: ['e1'],
      direct: true,
    });
    expect(normalized.amount).toMatchObject({ originalValue: '5', valueMillions: '5' });
    expect(normalized.signedValueMillions).toBe('-5');
    expect(normalized.direction).toBe('decrease');
  });

  it('creates one candidate per verified action and never an absolute funding mark', () => {
    const verified = verifyAppropriationsActionsV1({
      actions: [
        action(),
        action({
          actionId: 'action-2',
          actionType: 'decrease',
          amount: money('2'),
          signedValueMillions: '-2',
          direction: 'decrease',
        }),
      ],
    });
    const plan = buildVerifiedStageActionProjectionPlanV1(verified);
    expect(plan.candidates).toHaveLength(2);
    expect(plan.canonicalWriteAllowed).toBe(false);
    expect(plan.budgetActionWriteAllowed).toBe(false);
    expect(JSON.stringify(plan)).not.toMatch(/"field":"(hacDMark|sacDMark|conference|enacted)"/);
  });
});
