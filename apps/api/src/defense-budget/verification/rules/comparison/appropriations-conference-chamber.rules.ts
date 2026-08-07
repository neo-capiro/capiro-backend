/** Phase 6 Workstream K — exact HAC-D/SAC-D -> appropriations conference reconciliation. */
import {
  APPROPRIATIONS_CONFERENCE_CHAMBER_POSITIONS_FIELD,
  appropriationsConferenceChamberPositionsV1Schema,
} from '../../../stages/appropriations/conference/appropriations-conference-facts-v1.js';
import {
  failCheck,
  makeDiscrepancy,
  notRunCheck,
  passCheck,
  skippedCheck,
  type VerificationRuleV1,
} from '../rule-types.js';
import { ReferenceArtifactIndexV1 } from './reference-artifact-index.js';

export const APPROPRIATIONS_CONFERENCE_CHAMBER_REFERENCE_RULE: VerificationRuleV1 = {
  code: 'appropriations_conference_chamber_reference',
  name: 'Appropriations conference chamber reference',
  version: 'defense_budget_verification_rule_v1',
  required: false,
  blocking: true,
  riskPoints: 40,
  execute(ctx) {
    const required = ctx.policy.requiredComparisonRules.includes(
      'appropriations_conference_chamber_reference',
    );
    if (!required) {
      return {
        check: skippedCheck(
          APPROPRIATIONS_CONFERENCE_CHAMBER_REFERENCE_RULE,
          ctx.verificationRunId,
          'rule not required',
        ),
        discrepancies: [],
      };
    }
    const facts = ctx.input.artifact.assertions.flatMap((assertion) => {
      if (
        assertion.assertionKind !== 'document_fact' ||
        assertion.fieldName !== APPROPRIATIONS_CONFERENCE_CHAMBER_POSITIONS_FIELD
      )
        return [];
      const parsed = appropriationsConferenceChamberPositionsV1Schema.safeParse(assertion.value);
      return parsed.success ? [{ assertion, value: parsed.data }] : [];
    });
    if (facts.length === 0) {
      return {
        check: notRunCheck(
          APPROPRIATIONS_CONFERENCE_CHAMBER_REFERENCE_RULE,
          ctx.verificationRunId,
          [],
          [],
          [],
          'no appropriations conference chamber-position facts',
          undefined,
          { required: true, blocking: true },
        ),
        discrepancies: [
          makeDiscrepancy(
            'appropriations_conference_chamber_fact_missing',
            'blocking',
            'conference position has no chamber reconciliation fact',
            [],
            [],
            [],
            {},
          ),
        ],
      };
    }
    if (ctx.input.referenceArtifactsFindings.some((finding) => finding.severity === 'blocking')) {
      return {
        check: notRunCheck(
          APPROPRIATIONS_CONFERENCE_CHAMBER_REFERENCE_RULE,
          ctx.verificationRunId,
          facts.map((item) => item.assertion.assertionId),
          [],
          [],
          'reference proof failed',
          undefined,
          { required: true, blocking: true },
        ),
        discrepancies: [],
      };
    }
    const index = ReferenceArtifactIndexV1.fromArtifacts(ctx.input.referenceArtifacts);
    const referenceArtifactIds = ctx.input.referenceArtifacts.map((artifact) => artifact.artifactId);
    const missing: string[] = [];
    const ambiguous: string[] = [];
    const mismatched: string[] = [];
    for (const fact of facts) {
      const identityKey = JSON.stringify(fact.value.identity);
      for (const chamber of [
        { field: 'hacDMark', printed: fact.value.hacd },
        { field: 'sacDMark', printed: fact.value.sacd },
      ] as const) {
        const match = index.lookupFunding(identityKey, fact.value.fiscalYear, chamber.field);
        if (match.kind === 'zero') {
          missing.push(`${fact.assertion.assertionId}:${chamber.field}`);
          continue;
        }
        if (match.kind === 'multiple') {
          ambiguous.push(`${fact.assertion.assertionId}:${chamber.field}`);
          continue;
        }
        if (
          chamber.printed.status === 'PRINTED' &&
          match.value.valueMillions !== chamber.printed.money.valueMillions
        ) {
          mismatched.push(`${fact.assertion.assertionId}:${chamber.field}`);
        }
      }
    }
    if (ambiguous.length > 0 || mismatched.length > 0) {
      const ids = [...ambiguous, ...mismatched];
      return {
        check: failCheck(
          APPROPRIATIONS_CONFERENCE_CHAMBER_REFERENCE_RULE,
          ctx.verificationRunId,
          facts.map((item) => item.assertion.assertionId),
          [],
          referenceArtifactIds,
          'ambiguous or mismatched HAC-D/SAC-D conference references',
          { ambiguous, mismatched },
          { required: true, blocking: true },
        ),
        discrepancies: ids.map((id) =>
          makeDiscrepancy(
            'appropriations_conference_reference_mismatch',
            'blocking',
            id,
            [],
            [],
            referenceArtifactIds,
            {},
          ),
        ),
      };
    }
    if (missing.length > 0) {
      return {
        check: notRunCheck(
          APPROPRIATIONS_CONFERENCE_CHAMBER_REFERENCE_RULE,
          ctx.verificationRunId,
          facts.map((item) => item.assertion.assertionId),
          [],
          referenceArtifactIds,
          `missing chamber comparisons: ${missing.join(', ')}`,
          { missing },
          { required: true, blocking: true },
        ),
        discrepancies: missing.map((id) =>
          makeDiscrepancy(
            'appropriations_conference_reference_missing',
            'review',
            id,
            [],
            [],
            referenceArtifactIds,
            {},
          ),
        ),
      };
    }
    return {
      check: passCheck(
        APPROPRIATIONS_CONFERENCE_CHAMBER_REFERENCE_RULE,
        ctx.verificationRunId,
        facts.map((item) => item.assertion.assertionId),
        facts.flatMap((item) => item.assertion.evidenceIds),
        referenceArtifactIds,
        'exact HAC-D and SAC-D references resolved; negotiated conference amount is source-defined',
        { reconciledFacts: facts.length },
        { required: true, blocking: true },
      ),
      discrepancies: [],
    };
  },
};
