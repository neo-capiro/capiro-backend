import { crossTenantLeakageCase } from './leakage/cross-tenant-leakage.eval';
import { claimGroundingCase } from './grounding/claim-grounding.eval';
import type { EvalCase } from './types';

/**
 * MeriV2 CI eval gate (SC0.6). Runs the cross-client-leakage + grounding suites
 * and exits non-zero on any regression, failing the `meriv2-evals` PR check.
 * Set MERIV2_EVAL_SEED_FAILURE=1 to inject a deliberately-failing case (proves
 * the gate goes red); unset → green.
 */
const CASES: EvalCase[] = [crossTenantLeakageCase, claimGroundingCase];

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
