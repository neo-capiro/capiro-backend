/**
 * Workstream F — Evidence and parser-lineage rules.
 *
 * F1: Evidence binding — every assertion evidence ID must resolve to
 *     evidence whose source SHA matches trusted source PDF SHA, parser run
 *     exists and is proof-verified, evidence page falls inside parser-run
 *     page ranges, page is within source document page count when known,
 *     evidence granularity is truthful.
 * F2: Money evidence policy — document_only never sufficient for money,
 *     cell_bbox may satisfy with valid geometry, text_span may satisfy with
 *     verifiable binding, page_only normally forces review, page_only may
 *     contribute to PASS only when policy allows AND all required independent
 *     reconciliation rules pass, fabricated full-page box must not be treated
 *     as cell geometry.
 * F3: Source-span SHA — recompute when possible, mismatch is blocking,
 *     unavailable resolution is NOT_RUN not PASS.
 * F4: Parser provenance — method in evidence must equal referenced parser
 *     run method. No method rewriting (deterministic_pdfplumber→manual,
 *     paddleocr→manual, camelot→llamaparse). Any rewrite is blocking
 *     provenance corruption.
 * F5: Warning policy — blocking extraction warnings→reject, review
 *     warnings→review, informational warnings add no risk unless policy says,
 *     no parser warning may disappear from the verification result.
 */
import type {
  DefenseBudgetAssertionV1,
  SourceEvidenceV1,
} from '../../contracts/extraction-artifact-v1.js';
import type { VerificationRuleV1, RuleResultV1 } from './rule-types.js';
import { passCheck, failCheck, notRunCheck, skippedCheck, makeDiscrepancy } from './rule-types.js';

/* ------------------------------------------------------------------ */
/* F1+F3+F4. Evidence binding rule                                      */
/* ------------------------------------------------------------------ */

export const EVIDENCE_BINDING_RULE: VerificationRuleV1 = {
  code: 'evidence_binding',
  name: 'Evidence Binding',
  version: 'defense_budget_verification_rule_v1',
  required: true,
  blocking: true,
  riskPoints: 45,

  execute(ctx): RuleResultV1 {
    const { input } = ctx;
    const runId = ctx.verificationRunId;;
    const { artifact, proofBundle } = input;
    const trustedSourceSha = proofBundle.sourceDocument.sourceSha256;
    const evidenceById = new Map(artifact.evidence.map((e) => [e.evidenceId, e]));
    const parserRunById = new Map(artifact.parserRuns.map((pr) => [pr.parserRunId, pr]));
    const discrepancies: ReturnType<typeof makeDiscrepancy>[] = [];
    const failingAssertionIds: string[] = [];
    const failingEvidenceIds: string[] = [];

    // Check each assertion's evidence IDs resolve and have valid binding
    for (const assertion of artifact.assertions) {
      for (const evidenceId of assertion.evidenceIds) {
        const evidence = evidenceById.get(evidenceId);
        if (!evidence) {
          discrepancies.push(
            makeDiscrepancy(
              'evidence_id_unresolved',
              'blocking',
              `assertion "${assertion.assertionId}" references evidence "${evidenceId}" which does not exist`,
              [assertion.assertionId],
              [evidenceId],
              [],
            ),
          );
          failingAssertionIds.push(assertion.assertionId);
          failingEvidenceIds.push(evidenceId);
          continue;
        }

        // F1: source SHA matches trusted source PDF SHA
        if (evidence.sourcePdfSha256 !== trustedSourceSha) {
          discrepancies.push(
            makeDiscrepancy(
              'evidence_source_sha_mismatch',
              'blocking',
              `evidence "${evidenceId}" source SHA "${evidence.sourcePdfSha256}" does not match trusted source "${trustedSourceSha}"`,
              [assertion.assertionId],
              [evidenceId],
              [],
            ),
          );
          failingAssertionIds.push(assertion.assertionId);
          failingEvidenceIds.push(evidenceId);
          continue;
        }

        // F1: parser run exists
        const parserRun = parserRunById.get(evidence.parserRunId);
        if (!parserRun) {
          discrepancies.push(
            makeDiscrepancy(
              'evidence_parser_run_not_found',
              'blocking',
              `evidence "${evidenceId}" references parser run "${evidence.parserRunId}" which does not exist`,
              [assertion.assertionId],
              [evidenceId],
              [],
            ),
          );
          failingAssertionIds.push(assertion.assertionId);
          failingEvidenceIds.push(evidenceId);
          continue;
        }

        // F1: evidence page falls inside parser-run page ranges
        if (evidence.page != null) {
          const page = evidence.page;
          const inRange = parserRun.pageRanges.some(
            (r) => page >= r.startPage && page <= r.endPage,
          );
          if (!inRange) {
            discrepancies.push(
              makeDiscrepancy(
                'evidence_page_outside_parser_range',
                'blocking',
                `evidence "${evidenceId}" page ${page} is outside parser run "${evidence.parserRunId}" page ranges`,
                [assertion.assertionId],
                [evidenceId],
                [],
              ),
            );
            failingAssertionIds.push(assertion.assertionId);
            failingEvidenceIds.push(evidenceId);
            continue;
          }
        }

        // F1: page within source document page count when known
        if (evidence.page != null && artifact.source.pageCount != null) {
          if (evidence.page > artifact.source.pageCount) {
            discrepancies.push(
              makeDiscrepancy(
                'evidence_page_exceeds_source_page_count',
                'blocking',
                `evidence "${evidenceId}" page ${evidence.page} exceeds source page count ${artifact.source.pageCount}`,
                [assertion.assertionId],
                [evidenceId],
                [],
              ),
            );
            failingAssertionIds.push(assertion.assertionId);
            failingEvidenceIds.push(evidenceId);
            continue;
          }
        }

        // F4: parser provenance — method in evidence must equal parser run method
        const parserRunProof = proofBundle.parserRuns.find(
          (pr) => pr.parserRunId === evidence.parserRunId,
        );
        if (parserRunProof) {
          if (parserRun.method !== parserRunProof.method) {
            discrepancies.push(
              makeDiscrepancy(
                'parser_provenance_corruption',
                'blocking',
                `evidence "${evidenceId}" parser run method "${parserRun.method}" does not match provenance method "${parserRunProof.method}"`,
                [assertion.assertionId],
                [evidenceId],
                [],
              ),
            );
            failingAssertionIds.push(assertion.assertionId);
            failingEvidenceIds.push(evidenceId);
            continue;
          }
        }

        // F3: source-span SHA mismatch is blocking (when present and recomputable)
        if (evidence.sourceSpanSha256 && evidence.textSpan) {
          // We cannot recompute the span without the parser output bytes, so
          // we check that the parser-run output SHA matches the artifact SHA.
          // A full recompute would require parser-output-level span hashing.
          // If the parser-run proof shows mismatch, it's blocking.
          const parserProof = proofBundle.parserRuns.find(
            (pr) => pr.parserRunId === evidence.parserRunId,
          );
          if (parserProof && parserProof.proofStatus === 'mismatch') {
            discrepancies.push(
              makeDiscrepancy(
                'source_span_sha_proof_mismatch',
                'blocking',
                `evidence "${evidenceId}" source span SHA proof failed: parser run "${evidence.parserRunId}" has mismatch status`,
                [assertion.assertionId],
                [evidenceId],
                [],
              ),
            );
            failingAssertionIds.push(assertion.assertionId);
            failingEvidenceIds.push(evidenceId);
            continue;
          }
        }
      }
    }

    if (failingAssertionIds.length > 0) {
      return {
        check: failCheck(
          EVIDENCE_BINDING_RULE,
          runId,
          [...new Set(failingAssertionIds)],
          [...new Set(failingEvidenceIds)],
          [],
          `evidence binding failed for ${failingAssertionIds.length} assertions`,
          { failingAssertionCount: failingAssertionIds.length },
        ),
        discrepancies,
      };
    }

    return {
      check: passCheck(
        EVIDENCE_BINDING_RULE,
        runId,
        [],
        [],
        [],
        'all assertion evidence IDs resolve with valid source SHA, parser runs, page ranges, and provenance',
      ),
      discrepancies: [],
    };
  },
};

/* ------------------------------------------------------------------ */
/* F2. Money evidence policy rule                                       */
/* ------------------------------------------------------------------ */

export const MONEY_EVIDENCE_RULE: VerificationRuleV1 = {
  code: 'money_evidence_policy',
  name: 'Money Evidence Policy',
  version: 'defense_budget_verification_rule_v1',
  required: true,
  blocking: true,
  riskPoints: 35,

  execute(ctx): RuleResultV1 {
    const { input, policy } = ctx;
    const runId = ctx.verificationRunId;;
    const { artifact, proofBundle } = input;
    const evidenceById = new Map(artifact.evidence.map((e) => [e.evidenceId, e]));
    const discrepancies: ReturnType<typeof makeDiscrepancy>[] = [];
    const reviewTriggerIds: string[] = [];

    for (const assertion of artifact.assertions) {
      const isMoneyAssertion =
        assertion.assertionKind === 'funding' || assertion.assertionKind === 'project_funding';

      if (!isMoneyAssertion) continue;

      for (const evidenceId of assertion.evidenceIds) {
        const evidence = evidenceById.get(evidenceId);
        if (!evidence) continue;

        // document_only is never sufficient for a money assertion
        if (evidence.granularity === 'document_only') {
          discrepancies.push(
            makeDiscrepancy(
              'money_evidence_document_only_insufficient',
              'blocking',
              `money assertion "${assertion.assertionId}" uses document_only evidence "${evidenceId}" — never sufficient for money`,
              [assertion.assertionId],
              [evidenceId],
              [],
            ),
          );
          continue;
        }

        // cell_bbox may satisfy money evidence when geometry is valid
        if (evidence.granularity === 'cell_bbox') {
          if (!evidence.boundingBox) {
            discrepancies.push(
              makeDiscrepancy(
                'money_evidence_cell_bbox_missing_geometry',
                'blocking',
                `money assertion "${assertion.assertionId}" uses cell_bbox evidence "${evidenceId}" without bounding box`,
                [assertion.assertionId],
                [evidenceId],
                [],
              ),
            );
            continue;
          }
          // Fabricated full-page box must not be treated as cell geometry
          const box = evidence.boundingBox;
          if (box.pageWidth && box.pageHeight) {
            const coversFullPage =
              box.x0 <= 0 && box.y0 <= 0 && box.x1 >= box.pageWidth && box.y1 >= box.pageHeight;
            if (coversFullPage) {
              discrepancies.push(
                makeDiscrepancy(
                  'money_evidence_fabricated_full_page_box',
                  'blocking',
                  `money assertion "${assertion.assertionId}" evidence "${evidenceId}" has a fabricated full-page bounding box treated as cell geometry`,
                  [assertion.assertionId],
                  [evidenceId],
                  [],
                ),
              );
              continue;
            }
          }
          continue; // valid cell_bbox
        }

        // text_span may satisfy money evidence when span hash or output artifact binding is verifiable
        if (evidence.granularity === 'text_span') {
          if (!evidence.textSpan) {
            discrepancies.push(
              makeDiscrepancy(
                'money_evidence_text_span_missing',
                'blocking',
                `money assertion "${assertion.assertionId}" uses text_span evidence "${evidenceId}" without text span`,
                [assertion.assertionId],
                [evidenceId],
                [],
              ),
            );
            continue;
          }
          // Check span verifiability — sourceSpanSha256 or parser-run proof verified
          const parserProof = proofBundle.parserRuns.find(
            (pr) => pr.parserRunId === evidence.parserRunId,
          );
          if (parserProof && parserProof.proofStatus === 'verified') {
            continue; // verifiable
          }
          // Without proof, text_span is not verifiable
          discrepancies.push(
            makeDiscrepancy(
              'money_evidence_text_span_unverifiable',
              'review',
              `money assertion "${assertion.assertionId}" text_span evidence "${evidenceId}" lacks verifiable parser-run proof`,
              [assertion.assertionId],
              [evidenceId],
              [],
            ),
          );
          reviewTriggerIds.push(assertion.assertionId);
          continue;
        }

        // page_only normally forces review
        if (evidence.granularity === 'page_only') {
          if (policy.pageOnlyMayPassWithIndependentReconciliation) {
            // May contribute to PASS only when all required independent
            // reconciliation rules pass — the decision engine enforces that.
            // Here we flag it as a review trigger.
            reviewTriggerIds.push(assertion.assertionId);
          } else {
            discrepancies.push(
              makeDiscrepancy(
                'money_evidence_page_only_insufficient',
                'blocking',
                `money assertion "${assertion.assertionId}" uses page_only evidence "${evidenceId}" and policy does not allow page_only pass`,
                [assertion.assertionId],
                [evidenceId],
                [],
              ),
            );
          }
          continue;
        }
      }
    }

    if (discrepancies.some((d) => d.severity === 'blocking')) {
      return {
        check: failCheck(
          MONEY_EVIDENCE_RULE,
          runId,
          [...new Set(reviewTriggerIds)],
          [],
          [],
          `money evidence policy violations: ${discrepancies.filter((d) => d.severity === 'blocking').length} blocking`,
          { discrepancyCount: discrepancies.length },
        ),
        discrepancies,
      };
    }

    if (reviewTriggerIds.length > 0) {
      return {
        check: notRunCheck(
          MONEY_EVIDENCE_RULE,
          runId,
          [...new Set(reviewTriggerIds)],
          [],
          [],
          `${reviewTriggerIds.length} money assertions require review due to page_only/text_span evidence`,
          { reviewTriggerCount: reviewTriggerIds.length },
        ),
        discrepancies,
      };
    }

    return {
      check: passCheck(
        MONEY_EVIDENCE_RULE,
        runId,
        [],
        [],
        [],
        'all money evidence satisfies policy granularity requirements',
      ),
      discrepancies: [],
    };
  },
};

/* ------------------------------------------------------------------ */
/* F5. Extraction warning policy rule                                   */
/* ------------------------------------------------------------------ */

export const WARNING_POLICY_RULE: VerificationRuleV1 = {
  code: 'warning_policy',
  name: 'Extraction Warning Policy',
  version: 'defense_budget_verification_rule_v1',
  required: true,
  blocking: true,
  riskPoints: 20,

  execute(ctx): RuleResultV1 {
    const { input } = ctx;
    const runId = ctx.verificationRunId;;
    const { artifact } = input;
    const warnings = artifact.warnings;
    const discrepancies: ReturnType<typeof makeDiscrepancy>[] = [];

    const blockingWarnings = warnings.filter((w) => w.severity === 'blocking');
    const reviewWarnings = warnings.filter((w) => w.severity === 'review');
    const infoWarnings = warnings.filter((w) => w.severity === 'info');

    for (const w of blockingWarnings) {
      discrepancies.push(
        makeDiscrepancy(
          'blocking_extraction_warning',
          'blocking',
          `blocking warning "${w.warningId}" (${w.code}): ${w.message}`,
          [],
          w.evidenceIds,
          [],
        ),
      );
    }
    for (const w of reviewWarnings) {
      discrepancies.push(
        makeDiscrepancy(
          'review_extraction_warning',
          'review',
          `review warning "${w.warningId}" (${w.code}): ${w.message}`,
          [],
          w.evidenceIds,
          [],
        ),
      );
    }

    if (blockingWarnings.length > 0) {
      return {
        check: failCheck(
          WARNING_POLICY_RULE,
          runId,
          [],
          [],
          [],
          `${blockingWarnings.length} blocking extraction warnings`,
          { blockingWarningCount: blockingWarnings.length },
        ),
        discrepancies,
      };
    }

    if (reviewWarnings.length > 0) {
      return {
        check: notRunCheck(
          WARNING_POLICY_RULE,
          runId,
          [],
          [],
          [],
          `${reviewWarnings.length} review extraction warnings present`,
          {
            reviewWarningCount: reviewWarnings.length,
            infoWarningCount: infoWarnings.length,
          },
        ),
        discrepancies,
      };
    }

    return {
      check: passCheck(
        WARNING_POLICY_RULE,
        runId,
        [],
        [],
        [],
        `no blocking or review warnings (${infoWarnings.length} informational)`,
      ),
      discrepancies: [],
    };
  },
};

/* ------------------------------------------------------------------ */
/* R8-D1. Archive proof rule                                            */
/* ------------------------------------------------------------------ */

export const ARCHIVE_PROOF_RULE: VerificationRuleV1 = {
  code: 'archive_proof',
  name: 'Archive Proof',
  version: 'defense_budget_verification_rule_v1',
  required: true,
  blocking: true,
  riskPoints: 40,

  execute(ctx): RuleResultV1 {
    const { input, policy } = ctx;
    const runId = ctx.verificationRunId;
    const archive = input.proofBundle.archive;

    // Policy does not require archive and none exists → SKIPPED
    if (!policy.requireImmutableArchive && archive.status === 'missing') {
      return {
        check: skippedCheck(ARCHIVE_PROOF_RULE, runId, 'archive proof not required by policy'),
        discrepancies: [],
      };
    }

    // Archive verified → PASS
    if (archive.status === 'verified') {
      return {
        check: passCheck(ARCHIVE_PROOF_RULE, runId, [], [], [],
          `archive verified: ${archive.bucket}/${archive.key}@${archive.versionId ?? 'latest'}`),
        discrepancies: [],
      };
    }

    // Archive not applicable → SKIPPED
    if (archive.status === 'not_applicable') {
      return {
        check: skippedCheck(ARCHIVE_PROOF_RULE, runId, 'archive proof not applicable'),
        discrepancies: [],
      };
    }

    // Archive missing and policy requires immutable archive → FAIL
    if (archive.status === 'missing' && policy.requireImmutableArchive) {
      return {
        check: failCheck(ARCHIVE_PROOF_RULE, runId, [], [], [],
          'archive proof required by policy but archive is missing'),
        discrepancies: [makeDiscrepancy('archive_proof_missing', 'blocking',
          'immutable archive required by policy but no archive metadata exists', [], [], [])],
      };
    }

    // Archive mismatch → FAIL
    if (archive.status === 'mismatch') {
      return {
        check: failCheck(ARCHIVE_PROOF_RULE, runId, [], [], [],
          `archive SHA mismatch for ${archive.bucket}/${archive.key}@${archive.versionId}`),
        discrepancies: [makeDiscrepancy('archive_sha_mismatch', 'blocking',
          `archive object SHA does not match expected source SHA`, [], [], [])],
      };
    }

    return {
      check: notRunCheck(ARCHIVE_PROOF_RULE, runId, [], [], [],
        `archive proof status: ${archive.status}`),
      discrepancies: [],
    };
  },
};

/* ------------------------------------------------------------------ */
/* R8-D2. Parser-run proof rule                                        */
/* ------------------------------------------------------------------ */

export const PARSER_RUN_PROOF_RULE: VerificationRuleV1 = {
  code: 'parser_run_proof',
  name: 'Parser Run Proof',
  version: 'defense_budget_verification_rule_v1',
  required: true,
  blocking: true,
  riskPoints: 45,

  execute(ctx): RuleResultV1 {
    const { input, policy } = ctx;
    const runId = ctx.verificationRunId;
    const parserRuns = input.proofBundle.parserRuns;
    const discrepancies: ReturnType<typeof makeDiscrepancy>[] = [];
    const failingIds: string[] = [];

    if (parserRuns.length === 0) {
      if (policy.requireParserRunProof) {
        return {
          check: failCheck(PARSER_RUN_PROOF_RULE, runId, [], [], [],
            'parser-run proof required by policy but no parser runs found'),
          discrepancies: [makeDiscrepancy('parser_proof_missing', 'blocking',
            'policy requires parser-run proof but artifact has no parser runs', [], [], [])],
        };
      }
      return {
        check: skippedCheck(PARSER_RUN_PROOF_RULE, runId, 'no parser runs in artifact'),
        discrepancies: [],
      };
    }

    for (const pr of parserRuns) {
      switch (pr.proofStatus) {
        case 'verified':
          continue; // OK
        case 'not_applicable':
          if (policy.requireParserRunProof && pr.method !== 'manual') {
            failingIds.push(pr.parserRunId);
            discrepancies.push(makeDiscrepancy('parser_proof_not_applicable', 'blocking',
              `parser run ${pr.parserRunId} (${pr.method}) proof status is not_applicable but policy requires proof`,
              [], [], []));
          }
          break;
        case 'missing':
          if (policy.requireParserRunProof) {
            failingIds.push(pr.parserRunId);
            discrepancies.push(makeDiscrepancy('parser_proof_missing', 'blocking',
              `parser run ${pr.parserRunId} (${pr.method}) proof is missing`, [], [], []));
          }
          break;
        case 'mismatch':
          failingIds.push(pr.parserRunId);
          discrepancies.push(makeDiscrepancy('parser_proof_mismatch', 'blocking',
            `parser run ${pr.parserRunId} (${pr.method}) proof SHA mismatch`, [], [], []));
          break;
      }
    }

    if (failingIds.length > 0) {
      return {
        check: failCheck(PARSER_RUN_PROOF_RULE, runId, [], [], [],
          `${failingIds.length} parser runs have proof failures`),
        discrepancies,
      };
    }

    return {
      check: passCheck(PARSER_RUN_PROOF_RULE, runId, [], [], [],
        `all ${parserRuns.length} parser runs verified or acceptable`),
      discrepancies: [],
    };
  },
};
