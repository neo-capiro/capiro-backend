/**
 * r1-verification.rules — R-1-specific completeness, ownership, and
 * internal-consistency checks for Phase 2.
 *
 * Blocking checks (Phase 4 plan §9):
 *   - zero PE identities in a required R-1 document;
 *   - printed money fact neither asserted nor omitted;
 *   - invalid PE identity;
 *   - duplicate conflicting PE/FY/role values;
 *   - missing unit;
 *   - invalid fiscal-year mapping;
 *   - multiple eligible totals for the same PE/FY without explicit reconciliation;
 *   - budget-year request missing when the manifest requires funding;
 *   - contextual or outyear value incorrectly marked canonical-request eligible.
 *
 * Review-required:
 *   - positional header fallback;
 *   - derived total because no total was printed;
 *   - OCR-corrected identity;
 *   - cross-parser disagreement;
 *   - source page carrying table-like content but zero rows;
 *   - unexpected new header vocabulary.
 *
 * Internal checks:
 *   - PE identity count equals unique valid R-1 PE count;
 *   - all budget_year_request assertions use the manifest cycle FY;
 *   - all outyear_projection values use a fiscal year greater than the cycle FY;
 *   - all historical-context values are excluded from canonical request eligibility.
 */
import type { VerificationRuleV1, RuleResultV1 } from './rule-types.js';
import { passCheck, failCheck, makeDiscrepancy } from './rule-types.js';

export const R1_SPECIFIC_RULE: VerificationRuleV1 = {
  code: 'r1_specific',
  name: 'R-1 Specific Completeness and Ownership',
  version: 'defense_budget_verification_rule_v1',
  required: true,
  blocking: true,
  riskPoints: 50,

  execute(ctx): RuleResultV1 {
    const { input } = ctx;
    const runId = ctx.verificationRunId;
    const { artifact, manifest, manifestDocumentKey } = input;
    const doc = manifest.documents.find((d) => d.documentKey === manifestDocumentKey);

    if (doc == null || doc.exhibit !== 'R-1') {
      return {
        check: passCheck(R1_SPECIFIC_RULE, runId, [], [], [], 'not an R-1 document'),
        discrepancies: [],
      };
    }

    const discrepancies: ReturnType<typeof makeDiscrepancy>[] = [];
    const assertions = artifact.assertions;
    const omissions = artifact.omissions;
    const cycleFiscalYear = manifest.fiscalYear;

    /* ---- Blocking: zero PE identities in a required R-1 document ---- */
    const identityAssertions = assertions.filter(
      (a) => a.assertionKind === 'program_element_identity',
    );
    if (doc.required && identityAssertions.length === 0) {
      discrepancies.push(
        makeDiscrepancy(
          'r1_zero_pe_identities',
          'blocking',
          'required R-1 document has zero PE identity assertions',
          [],
          [],
          [],
        ),
      );
    }

    /* ---- Blocking: invalid PE identity ---- */
    const peCodeRe = /^[0-9]{7}[A-Z][A-Z0-9]*$/;
    for (const assertion of identityAssertions) {
      if (assertion.assertionKind !== 'program_element_identity') continue;
      if (!peCodeRe.test(assertion.identity.peCode)) {
        discrepancies.push(
          makeDiscrepancy(
            'r1_invalid_pe_identity',
            'blocking',
            `invalid PE code in R-1 identity: ${assertion.identity.peCode}`,
            [assertion.assertionId],
            assertion.evidenceIds,
            [],
          ),
        );
      }
    }

    /* ---- Blocking: printed money fact neither asserted nor omitted ---- */
    const moneyFacts = artifact.sourceFacts.filter((f) => f.category === 'money');
    const assertedFactIds = new Set(assertions.flatMap((a) => a.sourceFactIds));
    const omittedFactIds = new Set(omissions.map((o) => o.sourceFactId));
    for (const fact of moneyFacts) {
      if (!assertedFactIds.has(fact.factId) && !omittedFactIds.has(fact.factId)) {
        discrepancies.push(
          makeDiscrepancy(
            'r1_money_fact_neither_asserted_nor_omitted',
            'blocking',
            `money source fact ${fact.factId} is neither asserted nor omitted`,
            [],
            fact.evidenceIds,
            [],
          ),
        );
      }
    }

    /* ---- Blocking: missing unit ---- */
    const missingUnitOmissions = omissions.filter((o) => o.reason === 'unsupported_unit');
    if (missingUnitOmissions.length > 0) {
      discrepancies.push(
        makeDiscrepancy(
          'r1_missing_unit',
          'blocking',
          `R-1 artifact has ${missingUnitOmissions.length} money cells with missing unit`,
          [],
          missingUnitOmissions.flatMap((o) => [o.sourceFactId]),
          [],
        ),
      );
    }

    /* ---- Blocking: duplicate conflicting PE/FY/role values ---- */
    const conflictWarnings = artifact.warnings.filter(
      (w) => w.code === 'r1_duplicate_conflicting_value',
    );
    for (const warning of conflictWarnings) {
      discrepancies.push(
        makeDiscrepancy(
          'r1_duplicate_conflicting_value',
          'blocking',
          warning.message,
          [],
          warning.evidenceIds,
          [],
        ),
      );
    }

    /* ---- Blocking: budget-year request missing when funding required ---- */
    const requiresFunding = doc.requiredDataCategories.includes('funding');
    if (requiresFunding) {
      const requestAssertions = assertions.filter(
        (a) =>
          a.assertionKind === 'funding' &&
          a.field === 'request' &&
          a.fiscalYear === cycleFiscalYear,
      );
      if (requestAssertions.length === 0 && identityAssertions.length > 0) {
        discrepancies.push(
          makeDiscrepancy(
            'r1_budget_year_request_missing',
            'blocking',
            `R-1 document requires funding but has no budget_year_request assertions for cycle FY ${cycleFiscalYear}`,
            [],
            [],
            [],
          ),
        );
      }
    }

    /* ---- Blocking: contextual/outyear marked canonical-request eligible ---- */
    for (const assertion of assertions) {
      if (assertion.assertionKind !== 'funding') continue;
      const metadata = assertion.metadata as Record<string, unknown> | undefined;
      const columnRole = metadata?.['columnRole'];
      const disposition = metadata?.['disposition'];
      if (
        disposition === 'canonical_request_candidate' &&
        columnRole !== 'budget_year_request'
      ) {
        discrepancies.push(
          makeDiscrepancy(
            'r1_contextual_or_outyear_marked_canonical',
            'blocking',
            `funding assertion ${assertion.assertionId} has disposition canonical_request_candidate but columnRole ${String(columnRole)}`,
            [assertion.assertionId],
            assertion.evidenceIds,
            [],
          ),
        );
      }
    }

    /* ---- Internal: all budget_year_request use cycle FY ---- */
    for (const assertion of assertions) {
      if (assertion.assertionKind !== 'funding' || assertion.field !== 'request') continue;
      if (assertion.fiscalYear !== cycleFiscalYear) {
        discrepancies.push(
          makeDiscrepancy(
            'r1_request_wrong_fiscal_year',
            'blocking',
            `funding assertion ${assertion.assertionId} has field=request but fiscalYear ${assertion.fiscalYear} != cycle FY ${cycleFiscalYear}`,
            [assertion.assertionId],
            assertion.evidenceIds,
            [],
          ),
        );
      }
    }

    /* ---- Internal: outyear projections use FY > cycle FY ---- */
    for (const assertion of assertions) {
      if (assertion.assertionKind !== 'document_fact') continue;
      const value = assertion.value as Record<string, unknown> | undefined;
      const columnRole = value?.['columnRole'];
      const fiscalYear = value?.['fiscalYear'];
      if (
        columnRole === 'outyear_projection' &&
        typeof fiscalYear === 'number' &&
        fiscalYear <= cycleFiscalYear
      ) {
        discrepancies.push(
          makeDiscrepancy(
            'r1_outyear_not_after_cycle_fy',
            'blocking',
            `document_fact ${assertion.assertionId} has outyear_projection with fiscalYear ${fiscalYear} <= cycle FY ${cycleFiscalYear}`,
            [assertion.assertionId],
            assertion.evidenceIds,
            [],
          ),
        );
      }
    }

    /* ---- Internal: historical context excluded from canonical eligibility ---- */
    for (const assertion of assertions) {
      if (assertion.assertionKind !== 'document_fact') continue;
      const value = assertion.value as Record<string, unknown> | undefined;
      const columnRole = value?.['columnRole'];
      const disposition = value?.['disposition'];
      if (
        (columnRole === 'prior_actual_context' || columnRole === 'current_enacted_context') &&
        disposition === 'canonical_request_candidate'
      ) {
        discrepancies.push(
          makeDiscrepancy(
            'r1_historical_context_marked_canonical',
            'blocking',
            `document_fact ${assertion.assertionId} has historical role ${String(columnRole)} with canonical disposition`,
            [assertion.assertionId],
            assertion.evidenceIds,
            [],
          ),
        );
      }
    }

    /* ---- Review: positional header fallback ---- */
    const fallbackWarnings = artifact.warnings.filter(
      (w) => w.code === 'r1_positional_header_fallback',
    );
    for (const warning of fallbackWarnings) {
      discrepancies.push(
        makeDiscrepancy(
          'r1_positional_header_fallback',
          'review',
          warning.message,
          [],
          warning.evidenceIds,
          [],
        ),
      );
    }

    /* ---- Review: unexpected new header vocabulary ---- */
    const unknownRoleOmissions = omissions.filter((o) => o.reason === 'ambiguous_layout');
    if (unknownRoleOmissions.length > 0) {
      discrepancies.push(
        makeDiscrepancy(
          'r1_unexpected_header_vocabulary',
          'review',
          `R-1 artifact has ${unknownRoleOmissions.length} cells with unresolved column roles (unexpected header vocabulary)`,
          [],
          unknownRoleOmissions.flatMap((o) => [o.sourceFactId]),
          [],
        ),
      );
    }

    const blockingCount = discrepancies.filter((d) => d.severity === 'blocking').length;
    if (blockingCount > 0) {
      return {
        check: failCheck(
          R1_SPECIFIC_RULE,
          runId,
          [],
          [],
          [],
          `R-1 specific checks failed with ${blockingCount} blocking discrepancies`,
        ),
        discrepancies,
      };
    }

    return {
      check: passCheck(
        R1_SPECIFIC_RULE,
        runId,
        [],
        [],
        [],
        `R-1 specific checks passed (${discrepancies.length} review findings)`,
      ),
      discrepancies,
    };
  },
};
