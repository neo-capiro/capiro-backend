import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { restoreReviewedPeManifest } from './evidence/reviewed-pe-manifest-contract.current.mjs';
const current = readFileSync(new URL('./evidence/current-api-package.json', import.meta.url));
const proposed = readFileSync(new URL('./evidence/proposed-api-package.json', import.meta.url));
const restored = restoreReviewedPeManifest(current, 'api');
assert.ok(restored.length > 0);
assert.throws(() => restoreReviewedPeManifest(proposed, 'api'), /Unreviewed PE manifest change refused/);
const result = {
  currentPositive: true,
  proposedWithCurrentGuardRefused: true,
  qualification: 'Expected composition dependency, not a source waiver. Root must independently attest the new exact operand and retain all old inverse/refusal controls.',
  sha256: {
    currentAPI: createHash('sha256').update(current).digest('hex'),
    proposedAPI: createHash('sha256').update(proposed).digest('hex'),
  },
};
writeFileSync(new URL('./evidence/05-manifest-dependency-probe.json', import.meta.url), JSON.stringify(result, null, 2) + '\n');
process.stdout.write(JSON.stringify(result) + '\n');
