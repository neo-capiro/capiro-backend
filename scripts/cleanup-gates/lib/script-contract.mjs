/**
 * Thin CI consumer of the ONE canonical CLI-contract module (review round 10).
 *
 * The canonical DOCUMENTED-CLI-contract derivation lives at
 * `scripts/cleanup-script-smoke/contract.mjs` (owned by the execution lane).
 * This CI file only RE-EXPORTS it and provides the gate's `contractFor()`
 * lookup — there is exactly ONE derivation, no fallback and no second
 * implementation. Both PRs may carry the identical canonical source path; Git
 * integration reconciles the identical bytes.
 *
 * CleanUp1 missing-DATABASE_URL smoke context: every isolated smoke invocation
 * runs with DATABASE_URL ABSENT, so this consumer derives under the ONE named,
 * immutable `MISSING_DATABASE_URL_SMOKE_CONTEXT` re-exported from the canonical
 * module. The producer (`run-smoke.mjs`) uses the SAME constant, so the gate and
 * the producer derive byte-identical configuration-conditioned contracts. The
 * default generic `deriveContract(source, rel)` remains conservative.
 *
 * (The emitter/runtime remains the execution lane's; this is a pure adapter.)
 */
import fs from 'node:fs';
import path from 'node:path';
import { deriveContract, MISSING_DATABASE_URL_SMOKE_CONTEXT } from '../../cleanup-script-smoke/contract.mjs';

export { deriveContract, MISSING_DATABASE_URL_SMOKE_CONTEXT };

/** Contract lookup used by the gate ctx: derive from the CURRENT source file. */
export function contractFor(root, relPath) {
  const abs = path.join(root, relPath);
  const source = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
  return deriveContract(source, relPath, MISSING_DATABASE_URL_SMOKE_CONTEXT);
}
