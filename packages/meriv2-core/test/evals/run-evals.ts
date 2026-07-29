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
import type { EvalCase } from './types';

/**
 * MeriV2 deterministic CI release gate. Mechanism invariants fail the PR:
 * tenancy, approval, grounding, entity/jurisdiction resolution, legislative
 * procedure, government-affairs assurance, policy-pack safety, and golden-domain
 * coverage. Live-model quality/cost/latency remain separately versioned L3/L4
 * runs; their category-specific report is evaluated by assurance/eval-gate.ts.
 */
const CASES: EvalCase[] = [
  crossTenantLeakageCase,
  claimGroundingCase,
  complianceGateCase,
  entityGroundingCase,
  billStatusCase,
  stateBillStatusCase,
  stateRuleStatusCase,
  committeeRosterCase,
  multiStateComparisonCase,
  federalStateMixedCase,
  governmentAffairsAssuranceCase,
];

async function main(): Promise<void> {
  let failed = 0;
  for (const c of CASES) {
    const out = await c.run();
    const tag = out.pass ? 'PASS' : 'FAIL';
    // eslint-disable-next-line no-console
    console.log(`[${tag}] ${c.category}/${c.id} — ${out.detail}`);
    if (!out.pass) failed += 1;
  }
  // eslint-disable-next-line no-console
  console.log(`\n${CASES.length - failed}/${CASES.length} MeriV2 eval cases passed`);
  if (failed > 0) {
    // eslint-disable-next-line no-console
    console.error(`MeriV2 eval gate FAILED: ${failed} regression(s)`);
    process.exit(1);
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
