/**
 * Workstream E2 — Manifest binding rule.
 *
 * Verify exact agreement between manifest document entry, V1 artifact
 * source, and trusted proof:
 *   document key, cycle/fiscal year, family, exhibit, authority, component,
 *   budget cycle, document type, expected source SHA when supplied,
 *   required line kinds, source locator identity where meaningful.
 *
 * A classification disagreement is never silently normalized.
 */
import type { VerificationRuleV1, RuleResultV1 } from './rule-types.js';
import { passCheck, failCheck, makeDiscrepancy } from './rule-types.js';

export const MANIFEST_BINDING_RULE: VerificationRuleV1 = {
  code: 'manifest_binding',
  name: 'Manifest Binding',
  version: 'defense_budget_verification_rule_v1',
  required: true,
  blocking: true,
  riskPoints: 50,

  execute(ctx): RuleResultV1 {
    const { input, policy } = ctx;
    const runId = ''; // set by engine
    const { manifest, manifestDocumentKey, artifact, proofBundle } = input;
    const doc = manifest.documents.find((d) => d.documentKey === manifestDocumentKey);

    if (!doc) {
      return {
        check: failCheck(
          MANIFEST_BINDING_RULE,
          runId,
          [],
          [],
          [],
          `manifest document key "${manifestDocumentKey}" not found in manifest`,
        ),
        discrepancies: [
          makeDiscrepancy(
            'manifest_document_key_not_found',
            'blocking',
            `document key "${manifestDocumentKey}" not found in manifest ${manifest.cycleId}`,
            [],
            [],
            [],
          ),
        ],
      };
    }

    const src = artifact.source;
    const mismatches: string[] = [];

    // document key
    if (src.manifestDocumentKey !== doc.documentKey) {
      mismatches.push(
        `documentKey: artifact="${src.manifestDocumentKey}" manifest="${doc.documentKey}"`,
      );
    }

    // fiscal year
    if (src.fiscalYear !== manifest.fiscalYear) {
      mismatches.push(`fiscalYear: artifact=${src.fiscalYear} manifest=${manifest.fiscalYear}`);
    }

    // family
    if (src.family !== doc.family) {
      mismatches.push(`family: artifact="${src.family}" manifest="${doc.family}"`);
    }

    // exhibit
    if (src.exhibit !== doc.exhibit) {
      mismatches.push(`exhibit: artifact="${src.exhibit}" manifest="${doc.exhibit}"`);
    }

    // authority
    if (src.authority !== doc.authority) {
      mismatches.push(`authority: artifact="${src.authority}" manifest="${doc.authority}"`);
    }

    // component
    if (src.component !== doc.component) {
      mismatches.push(`component: artifact="${src.component}" manifest="${doc.component}"`);
    }

    // budget cycle
    if (src.budgetCycle !== doc.budgetCycle) {
      mismatches.push(`budgetCycle: artifact="${src.budgetCycle}" manifest="${doc.budgetCycle}"`);
    }

    // document type
    if (src.documentType !== doc.documentType) {
      mismatches.push(
        `documentType: artifact="${src.documentType}" manifest="${doc.documentType}"`,
      );
    }

    // expected source SHA when supplied
    if (doc.expectedSourceSha256 && src.sourcePdfSha256 !== doc.expectedSourceSha256) {
      mismatches.push(
        `expectedSourceSha256: artifact="${src.sourcePdfSha256}" manifest="${doc.expectedSourceSha256}"`,
      );
    }

    // proof bundle manifest cycle agreement
    if (proofBundle.manifest.cycleId !== manifest.cycleId) {
      mismatches.push(
        `proofManifestCycleId: proof="${proofBundle.manifest.cycleId}" manifest="${manifest.cycleId}"`,
      );
    }
    if (proofBundle.manifest.fiscalYear !== manifest.fiscalYear) {
      mismatches.push(
        `proofManifestFiscalYear: proof=${proofBundle.manifest.fiscalYear} manifest=${manifest.fiscalYear}`,
      );
    }
    if (proofBundle.manifest.documentKey !== doc.documentKey) {
      mismatches.push(
        `proofManifestDocumentKey: proof="${proofBundle.manifest.documentKey}" manifest="${doc.documentKey}"`,
      );
    }

    // expected line kinds — policy required kinds must be a subset of manifest expected kinds
    const manifestKinds = new Set(doc.expectedLineKinds);
    for (const kind of policy.requiredLineKinds) {
      if (!manifestKinds.has(kind)) {
        mismatches.push(`requiredLineKind "${kind}" not in manifest expectedLineKinds`);
      }
    }

    if (mismatches.length > 0) {
      return {
        check: failCheck(
          MANIFEST_BINDING_RULE,
          runId,
          [],
          [],
          [],
          `manifest binding failed: ${mismatches.join('; ')}`,
          { mismatches },
        ),
        discrepancies: mismatches.map((m) =>
          makeDiscrepancy('manifest_binding_mismatch', 'blocking', m, [], [], []),
        ),
      };
    }

    return {
      check: passCheck(
        MANIFEST_BINDING_RULE,
        runId,
        [],
        [],
        [],
        `manifest binding verified for document key "${manifestDocumentKey}"`,
      ),
      discrepancies: [],
    };
  },
};
