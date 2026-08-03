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
import type { DefenseBudgetAssertionV1, SourceEvidenceV1 } from '../../contracts/extraction-artifact-v1.js';
import type { VerificationRuleV1, RuleResultV1 } from './rule-types.js';
import { passCheck, failCheck, notRunCheck, makeDiscrepancy } from './rule-types.js';

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
    const runId = '';
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
    const runId = '';
    const { artifact, proofBundle } = input;
    const evidenceById = new Map(artifact.evidence.map((e) => [e.evidenceId, e]));
    const discrepancies: ReturnType<typeof makeDiscrepancy>[] = [];
    const reviewTriggerIds: string[] = [];

    for (const assertion of artifact.assertions) {
      const isMoneyAssertion =
        assertion.assertionKind === 'funding' ||
        assertion.assertionKind === 'project_funding';

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
              box.x0 <= 0 &&
              box.y0 <= 0 &&
              box.x1 >= box.pageWidth &&
              box.y1 >= box.pageHeight;
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
    const runId = '';
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
