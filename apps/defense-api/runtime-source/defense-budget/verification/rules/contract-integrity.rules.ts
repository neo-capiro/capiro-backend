/**
 * Workstream E1 — Contract integrity rule.
 *
 * Before verification rules: parse V1 artifact with Zod, run Phase 1
 * semantic validation, recompute artifact content SHA, require artifact
 * ID match, recompute summary, require no semantic errors.
 *
 * A schema/semantic error is blocking and produces REJECTED.
 */
import {
  parseDefenseBudgetExtractionArtifactV1,
  validateDefenseBudgetExtractionArtifactV1,
  computeArtifactContentSha256,
  computeArtifactSummary,
} from '../../contracts/extraction-artifact-v1.semantic.js';
import type { VerificationRuleV1, RuleResultV1 } from './rule-types.js';
import { passCheck, failCheck, makeDiscrepancy } from './rule-types.js';

export const CONTRACT_INTEGRITY_RULE: VerificationRuleV1 = {
  code: 'contract_integrity',
  name: 'Contract Integrity',
  version: 'defense_budget_verification_rule_v1',
  required: true,
  blocking: true,
  riskPoints: 100,

  execute(ctx): RuleResultV1 {
    const { input } = ctx;
    const runId = ctx.verificationRunId;
    const { artifact } = input;

    let parseOk = true;
    let parseError = '';
    try {
      parseDefenseBudgetExtractionArtifactV1(input.artifact);
    } catch (error) {
      parseOk = false;
      parseError = (error as Error).message;
    }

    if (!parseOk) {
      return {
        check: failCheck(
          CONTRACT_INTEGRITY_RULE,
          runId,
          [],
          [],
          [],
          `artifact schema parse failed: ${parseError}`,
        ),
        discrepancies: [
          makeDiscrepancy(
            'contract_integrity_parse_failure',
            'blocking',
            `artifact failed Zod schema parse: ${parseError}`,
            [],
            [],
            [],
          ),
        ],
      };
    }

    const recomputedSha = computeArtifactContentSha256(input.artifact);
    if (recomputedSha !== input.artifact.contentSha256) {
      return {
        check: failCheck(
          CONTRACT_INTEGRITY_RULE,
          runId,
          [],
          [],
          [],
          `content SHA mismatch: expected ${recomputedSha}, got ${input.artifact.contentSha256}`,
        ),
        discrepancies: [
          makeDiscrepancy(
            'contract_integrity_content_sha_mismatch',
            'blocking',
            `contentSha256 does not recompute: expected ${recomputedSha}`,
            [],
            [],
            [],
          ),
        ],
      };
    }

    const expectedId = `dbx1_${recomputedSha}`;
    if (input.artifact.artifactId !== expectedId) {
      return {
        check: failCheck(
          CONTRACT_INTEGRITY_RULE,
          runId,
          [],
          [],
          [],
          `artifactId mismatch: expected ${expectedId}, got ${input.artifact.artifactId}`,
        ),
        discrepancies: [
          makeDiscrepancy(
            'contract_integrity_artifact_id_mismatch',
            'blocking',
            `artifactId must be dbx1_<contentSha256>: expected ${expectedId}`,
            [],
            [],
            [],
          ),
        ],
      };
    }

    const recomputedSummary = computeArtifactSummary(input.artifact);
    if (JSON.stringify(recomputedSummary) !== JSON.stringify(input.artifact.summary)) {
      return {
        check: failCheck(
          CONTRACT_INTEGRITY_RULE,
          runId,
          [],
          [],
          [],
          `summary does not recompute: expected ${JSON.stringify(recomputedSummary)}`,
        ),
        discrepancies: [
          makeDiscrepancy(
            'contract_integrity_summary_mismatch',
            'blocking',
            'artifact summary does not recompute from contents',
            [],
            [],
            [],
          ),
        ],
      };
    }

    const semanticFindings = validateDefenseBudgetExtractionArtifactV1(input.artifact);
    const semanticErrors = semanticFindings.filter((finding) => finding.severity === 'error');
    if (semanticErrors.length > 0) {
      const messages = semanticErrors.map(
        (finding) => `${finding.code} at ${finding.path}: ${finding.message}`,
      );
      return {
        check: failCheck(
          CONTRACT_INTEGRITY_RULE,
          runId,
          [],
          [],
          [],
          `semantic validation errors: ${messages.join('; ')}`,
        ),
        discrepancies: semanticErrors.map((finding) =>
          makeDiscrepancy(
            `contract_integrity_${finding.code}`,
            'blocking',
            `${finding.code} at ${finding.path}: ${finding.message}`,
            [],
            [],
            [],
          ),
        ),
      };
    }

    return {
      check: passCheck(
        CONTRACT_INTEGRITY_RULE,
        runId,
        artifact.assertions.map((assertion) => assertion.assertionId).sort(),
        artifact.evidence.map((evidence) => evidence.evidenceId).sort(),
        [],
        'artifact schema, content SHA, artifact ID, summary, and semantic validation all passed',
      ),
      discrepancies: [],
    };
  },
};
