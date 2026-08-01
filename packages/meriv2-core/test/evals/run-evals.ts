import { crossTenantLeakageCase } from './leakage/cross-tenant-leakage.eval';
import { claimGroundingCase } from './grounding/claim-grounding.eval';
import { complianceGateCase } from './compliance/gate-enforcement.eval';
import { entityGroundingCase } from './entity/entity-grounding.eval';
import { billStatusCase } from './legislation/bill-status.eval';
import { stateBillStatusCase } from './legislation/state-bill-status.eval';
import { stateRuleStatusCase } from './legislation/state-rule-status.eval';
import { committeeRosterCase } from './legislation/committee-roster.eval';
import { multiStateComparisonCase } from './legislation/multi-state-comparison.eval';
import { federalStateMixedCase } from './legislation/federal-state-mixed.eval';
import { governmentAffairsAssuranceCase } from './assurance/government-affairs-assurance.eval';
import {
  defaultReleaseGateThresholds,
  evaluateReleaseGate,
  type AssuranceEvalResult,
  type EvalProvenance,
} from '../../src/assurance';
import { persistEvalRun } from './persist-run';
import type { EvalCase } from './types';

/**
 * MeriV2 deterministic CI release gate. Mechanism invariants fail the PR:
 * tenancy, approval, grounding, entity/jurisdiction resolution, legislative
 * procedure, government-affairs assurance, policy-pack safety, and golden-domain
 * coverage. Live-model quality/cost/latency remain separately versioned L3/L4
 * runs; their category-specific report is evaluated by assurance/eval-gate.ts.
 *
 * The `domain` / `severity` / `metric` classification is attached HERE rather than
 * inside each eval file, so that the mapping from case to release-gate DOMAIN is
 * readable in one place — a reviewer can see at a glance which domains are covered
 * and which are not. Every case is `critical`: these are mechanism invariants, so a
 * failure means the mechanism the product's safety claims rest on is broken, and no
 * amount of quality elsewhere compensates.
 */
const CASES: EvalCase[] = [
  {
    ...crossTenantLeakageCase,
    domain: 'security_tenancy',
    severity: 'critical',
    tier: 'L1',
    metric: 'tenant_isolation',
  },
  { ...claimGroundingCase, domain: 'general', severity: 'critical', tier: 'L1' },
  {
    ...complianceGateCase,
    domain: 'compliance_actions',
    severity: 'critical',
    tier: 'L1',
    metric: 'approval_invariant',
  },
  { ...entityGroundingCase, domain: 'roles_entities', severity: 'critical', tier: 'L1' },
  { ...billStatusCase, domain: 'legislation', severity: 'critical', tier: 'L1' },
  { ...stateBillStatusCase, domain: 'legislation', severity: 'critical', tier: 'L1' },
  { ...stateRuleStatusCase, domain: 'legislation', severity: 'critical', tier: 'L1' },
  { ...committeeRosterCase, domain: 'roles_entities', severity: 'critical', tier: 'L1' },
  { ...multiStateComparisonCase, domain: 'legislation', severity: 'critical', tier: 'L1' },
  { ...federalStateMixedCase, domain: 'legislation', severity: 'critical', tier: 'L1' },
  { ...governmentAffairsAssuranceCase, domain: 'general', severity: 'critical', tier: 'L1' },
];

async function main(): Promise<void> {
  let failed = 0;
  const results: AssuranceEvalResult[] = [];
  for (const c of CASES) {
    const out = await c.run();
    const tag = out.pass ? 'PASS' : 'FAIL';
    // eslint-disable-next-line no-console
    console.log(`[${tag}] ${c.category}/${c.id} — ${out.detail}`);
    if (!out.pass) failed += 1;
    // A case may emit its own per-mechanism breakdown; otherwise synthesize ONE
    // result. Defaults are the CONSERVATIVE end (critical / L1): a case that
    // forgot to declare its classification must not be able to fail quietly.
    if (out.results?.length) results.push(...out.results);
    else {
      results.push({
        id: `${c.category}/${c.id}`,
        tier: c.tier ?? 'L1',
        domain: c.domain ?? 'general',
        severity: c.severity ?? 'critical',
        passed: out.pass,
        metric: c.metric ?? 'deterministic_check',
        detail: out.detail,
      });
    }
  }
  // eslint-disable-next-line no-console
  console.log(`\n${CASES.length - failed}/${CASES.length} MeriV2 eval cases passed`);

  // CATEGORY-SPECIFIC release decision. Until now this runner counted passes and
  // console.logged them, while eval-gate.ts — which exists precisely so that one
  // critical legislative / tenancy / approval / compliance regression blocks
  // release regardless of the average — had no caller at all. It does now, and the
  // report is what decides the exit code.
  const thresholds = defaultReleaseGateThresholds();
  const report = evaluateReleaseGate({ provenance: provenance(), results, thresholds });
  // eslint-disable-next-line no-console
  console.log(
    `\nrelease gate: ${report.allowed ? 'ALLOWED' : 'BLOCKED'} (provenance ${report.provenanceHash.slice(0, 12)})`,
  );
  for (const domain of report.domains) {
    // eslint-disable-next-line no-console
    console.log(
      `  ${domain.domain}: ${domain.passed} passed, ${domain.failed} failed` +
        `${domain.criticalFailed ? ` (${domain.criticalFailed} CRITICAL)` : ''}`,
    );
  }
  for (const blocker of report.blockers) {
    // eslint-disable-next-line no-console
    console.error(`  BLOCKER: ${blocker}`);
  }
  for (const warning of report.warnings) {
    // eslint-disable-next-line no-console
    console.warn(`  warning: ${warning}`);
  }

  // Audit row. No-op without DATABASE_URL + ASSURANCE_EVAL_TENANT_ID, and never
  // able to change the verdict — see persist-run.ts.
  const persisted = persistEvalRun({ provenance: provenance(), thresholds, report, results });
  // eslint-disable-next-line no-console
  console.log(`eval run audit: ${persisted.reason}`);

  if (failed > 0 || !report.allowed) {
    // eslint-disable-next-line no-console
    console.error(
      `MeriV2 eval gate FAILED: ${failed} regression(s), ${report.blockers.length} release blocker(s)`,
    );
    process.exit(1);
  }
}

/**
 * What this run was actually a run OF. Every field is read from the environment
 * rather than guessed, and an unavailable field is recorded as `unknown` rather
 * than fabricated — a provenance hash over invented inputs would be worse than no
 * hash, because it would look authoritative.
 */
function provenance(): EvalProvenance {
  return {
    gitSha: process.env.GITHUB_SHA ?? process.env.GIT_SHA ?? 'unknown',
    promptVersion: process.env.MERI_PROMPT_VERSION ?? 'meriv2-deterministic',
    contextCompilerVersion: process.env.MERI_CONTEXT_COMPILER_VERSION ?? 'unknown',
    toolManifestHash: process.env.MERI_TOOL_MANIFEST_HASH ?? 'unknown',
    // These cases are deterministic and call no model. Saying so is more honest
    // than stamping whatever model happens to be configured.
    model: 'none-deterministic',
    provider: 'none',
    datasetVersion: process.env.MERI_EVAL_DATASET_VERSION ?? 'ga-goldens-v1.0.0',
    date: new Date().toISOString(),
  };
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
