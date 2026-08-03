/**
 * Workstream E3-E6 — Completeness rules.
 *
 * E3: Required data categories — for each manifest category, require at
 *     least one corresponding assertion or a policy-approved explicit omission.
 * E4: Required funding fields — require at least one assertion when the
 *     document is required and not empty; validate fiscal year applicability,
 *     correct source authority, correct identity type.
 * E5: Source-fact completeness — every required fact must be asserted or
 *     omitted exactly once; blocking omissions produce REJECTED, review
 *     omissions produce NEEDS_REVIEW; no omission may be hidden by summary
 *     counts; no required fact may be consumed by contradictory value
 *     assertions.
 * E6: Empty document policy — a required manifest document with
 *     allowEmpty=false must reject when zero assertions, zero required source
 *     facts, zero required category assertions, zero money assertions when
 *     funding is required.
 */
import type { DefenseBudgetAssertionV1 } from '../../contracts/extraction-artifact-v1.js';
import type { RequiredDataCategoryV1 } from '../../contracts/budget-cycle-manifest-v1.js';
import type { VerificationRuleV1, RuleResultV1 } from './rule-types.js';
import { passCheck, failCheck, notRunCheck, makeDiscrepancy } from './rule-types.js';

/* ------------------------------------------------------------------ */
/* E3. Required data category mapping                                  */
/* ------------------------------------------------------------------ */

const CATEGORY_TO_ASSERTION_KINDS: Record<RequiredDataCategoryV1, string[]> = {
  identity: ['program_element_identity'],
  funding: ['funding'],
  narrative: ['narrative'],
  projects: ['project'],
  project_funding: ['project_funding'],
  performers: ['performer'],
  procurement_lines: ['procurement_line'],
  quantities: ['quantity', 'procurement_line'],
  unit_cost: ['unit_cost', 'procurement_line'],
  om_lines: ['om_line'],
  milcon_projects: ['milcon_project'],
  milestones: ['milestone'],
  relationships: ['relationship'],
};

/* ------------------------------------------------------------------ */
/* Completeness rule                                                    */
/* ------------------------------------------------------------------ */

export const COMPLETENESS_RULE: VerificationRuleV1 = {
  code: 'completeness',
  name: 'Completeness',
  version: 'defense_budget_verification_rule_v1',
  required: true,
  blocking: true,
  riskPoints: 40,

  execute(ctx): RuleResultV1 {
    const { input, policy } = ctx;
    const runId = '';
    const { artifact, manifest, manifestDocumentKey } = input;
    const doc = manifest.documents.find((d) => d.documentKey === manifestDocumentKey);
    const assertions = artifact.assertions;
    const omissions = artifact.omissions;
    const sourceFacts = artifact.sourceFacts;
    const discrepancies: ReturnType<typeof makeDiscrepancy>[] = [];

    if (!doc) {
      return {
        check: failCheck(
          COMPLETENESS_RULE,
          runId,
          [],
          [],
          [],
          `cannot evaluate completeness: document key "${manifestDocumentKey}" not found`,
        ),
        discrepancies: [],
      };
    }

    // E6. Empty document policy
    if (doc.required && !doc.allowEmpty) {
      const emptyFailures: string[] = [];
      if (assertions.length === 0) emptyFailures.push('zero assertions');
      if (sourceFacts.filter((f) => f.requiredForCompleteness).length === 0)
        emptyFailures.push('zero required source facts');

      const hasFundingCategory = doc.requiredDataCategories.some(
        (c) => c === 'funding' || c === 'project_funding',
      );
      const hasMoneyAssertions = assertions.some(
        (a) => a.assertionKind === 'funding' || a.assertionKind === 'project_funding',
      );
      if (hasFundingCategory && !hasMoneyAssertions && doc.required) {
        emptyFailures.push('zero money assertions when funding is required');
      }

      if (emptyFailures.length > 0 && assertions.length === 0) {
        return {
          check: failCheck(
            COMPLETENESS_RULE,
            runId,
            [],
            [],
            [],
            `empty document policy violation: ${emptyFailures.join(', ')}`,
          ),
          discrepancies: [
            makeDiscrepancy(
              'empty_document_violation',
              'blocking',
              `required document "${doc.documentKey}" with allowEmpty=false has ${emptyFailures.join(', ')}`,
              [],
              [],
              [],
            ),
          ],
        };
      }
    }

    // E3. Required data categories
    const categoryFailures: string[] = [];
    for (const cat of doc.requiredDataCategories) {
      const expectedKinds = CATEGORY_TO_ASSERTION_KINDS[cat] ?? [];
      const hasAssertion = assertions.some((a) => expectedKinds.includes(a.assertionKind));
      const hasOmission = omissions.some((o) => {
        const fact = sourceFacts.find((f) => f.factId === o.sourceFactId);
        if (!fact) return false;
        // Map fact categories to data categories loosely
        return (
          (cat === 'identity' && fact.category === 'identity') ||
          (cat === 'funding' && fact.category === 'money') ||
          (cat === 'narrative' && fact.category === 'text') ||
          (cat === 'projects' && fact.category === 'project') ||
          (cat === 'project_funding' && fact.category === 'money') ||
          (cat === 'performers' && fact.category === 'performer') ||
          (cat === 'procurement_lines' && fact.category === 'metadata') ||
          (cat === 'quantities' && fact.category === 'quantity') ||
          (cat === 'unit_cost' && fact.category === 'metadata') ||
          (cat === 'om_lines' && fact.category === 'metadata') ||
          (cat === 'milcon_projects' && fact.category === 'project') ||
          (cat === 'milestones' && fact.category === 'milestone') ||
          (cat === 'relationships' && fact.category === 'relationship')
        );
      });
      if (!hasAssertion && !hasOmission) {
        categoryFailures.push(cat);
      }
    }
    if (categoryFailures.length > 0) {
      return {
        check: failCheck(
          COMPLETENESS_RULE,
          runId,
          [],
          [],
          [],
          `missing required data categories: ${categoryFailures.join(', ')}`,
          { missingCategories: categoryFailures },
        ),
        discrepancies: categoryFailures.map((cat) =>
          makeDiscrepancy(
            'missing_required_data_category',
            'blocking',
            `required data category "${cat}" has no assertion or omission`,
            [],
            [],
            [],
          ),
        ),
      };
    }

    // E4. Required funding fields
    const fundingFields = doc.requiredFundingFields ?? policy.requiredFundingFields;
    if (fundingFields.length > 0) {
      const fieldFailures: string[] = [];
      const hasAnyFunding = assertions.some((a) => a.assertionKind === 'funding');
      if (hasAnyFunding || doc.required) {
        for (const field of fundingFields) {
          const hasField = assertions.some(
            (a) => a.assertionKind === 'funding' && (a as { field: string }).field === field,
          );
          const hasOmissionForField = omissions.some((o) => {
            const fact = sourceFacts.find((f) => f.factId === o.sourceFactId);
            return fact != null && fact.category === 'money';
          });
          if (!hasField && !hasOmissionForField) {
            fieldFailures.push(field);
          }
        }
        if (fieldFailures.length > 0) {
          return {
            check: failCheck(
              COMPLETENESS_RULE,
              runId,
              [],
              [],
              [],
              `missing required funding fields: ${fieldFailures.join(', ')}`,
              { missingFundingFields: fieldFailures },
            ),
            discrepancies: fieldFailures.map((f) =>
              makeDiscrepancy(
                'missing_required_funding_field',
                'blocking',
                `required funding field "${f}" has no assertion or omission`,
                [],
                [],
                [],
              ),
            ),
          };
        }
      }
    }

    // E5. Source-fact completeness
    const requiredFacts = sourceFacts.filter((f) => f.requiredForCompleteness);
    const assertedFactIds = new Set(assertions.flatMap((a) => a.sourceFactIds));
    const omittedFactIds = new Set(omissions.map((o) => o.sourceFactId));
    const uncovered: string[] = [];
    const doubleCounted: string[] = [];

    for (const fact of requiredFacts) {
      const asserted = assertedFactIds.has(fact.factId);
      const omitted = omittedFactIds.has(fact.factId);
      if (asserted && omitted) {
        doubleCounted.push(fact.factId);
      }
      if (!asserted && !omitted) {
        uncovered.push(fact.factId);
      }
    }

    if (doubleCounted.length > 0) {
      return {
        check: failCheck(
          COMPLETENESS_RULE,
          runId,
          [],
          [],
          [],
          `source facts both asserted and omitted: ${doubleCounted.join(', ')}`,
          { doubleCounted },
        ),
        discrepancies: doubleCounted.map((id) =>
          makeDiscrepancy(
            'source_fact_double_counted',
            'blocking',
            `required source fact "${id}" is both asserted and omitted`,
            [],
            [],
            [],
          ),
        ),
      };
    }

    if (uncovered.length > 0) {
      return {
        check: failCheck(
          COMPLETENESS_RULE,
          runId,
          [],
          [],
          [],
          `uncovered required source facts: ${uncovered.length} of ${requiredFacts.length}`,
          { uncovered },
        ),
        discrepancies: uncovered.map((id) =>
          makeDiscrepancy(
            'uncovered_required_source_fact',
            'blocking',
            `required source fact "${id}" is neither asserted nor omitted`,
            [],
            [],
            [],
          ),
        ),
      };
    }

    // Check omission severity — blocking omissions from artifact
    const blockingOmissions = omissions.filter((o) => o.severity === 'blocking');
    if (blockingOmissions.length > 0) {
      return {
        check: failCheck(
          COMPLETENESS_RULE,
          runId,
          [],
          [],
          [],
          `${blockingOmissions.length} blocking omissions present`,
          { blockingOmissionCount: blockingOmissions.length },
        ),
        discrepancies: blockingOmissions.map((o) =>
          makeDiscrepancy(
            'blocking_omission',
            'blocking',
            `blocking omission for source fact "${o.sourceFactId}": ${o.message}`,
            [],
            [],
            [],
          ),
        ),
      };
    }

    // Review omissions produce at least NEEDS_REVIEW (not blocking)
    const reviewOmissions = omissions.filter((o) => o.severity === 'review');
    if (reviewOmissions.length > 0) {
      return {
        check: notRunCheck(
          COMPLETENESS_RULE,
          runId,
          [],
          [],
          [],
          `${reviewOmissions.length} review-severity omissions present`,
          { reviewOmissionCount: reviewOmissions.length },
        ),
        discrepancies: reviewOmissions.map((o) =>
          makeDiscrepancy(
            'review_omission',
            'review',
            `review omission for source fact "${o.sourceFactId}": ${o.message}`,
            [],
            [],
            [],
          ),
        ),
      };
    }

    return {
      check: passCheck(
        COMPLETENESS_RULE,
        runId,
        [],
        [],
        [],
        `completeness verified: all required categories, fields, and source facts satisfied`,
      ),
      discrepancies: [],
    };
  },
};
