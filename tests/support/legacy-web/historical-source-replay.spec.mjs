import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { buildUiInventory } from '../../../scripts/engagement-phase3-ui-inventory.mjs';
import { requirePinnedLegacySourceRoot } from './source-root.mjs';

// Explicit historical replay only. No extraction, checkout creation, compiler,
// browser, provider or database is invoked. Missing input refuses collection.
const root = requirePinnedLegacySourceRoot();
const committed = JSON.parse(readFileSync(path.join(root,
  'apps/web/src/pages/engagement/__fixtures__/engagement-current-ui-surface-manifest.v1.json'), 'utf8'));
const routeManifest = JSON.parse(readFileSync(path.join(root,
  'apps/api/src/engagement/__fixtures__/engagement-route-manifest.v1.json'), 'utf8'));

test('the committed manifest is exactly what the builder generates', () => {
  assert.deepEqual(buildUiInventory({ root, routeManifest }), committed);
});

test('output is deterministic across repeated builds', () => {
  const first = buildUiInventory({ root, routeManifest });
  const second = buildUiInventory({ root, routeManifest });
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(first), JSON.stringify(second), 'key order must be stable too');
});

test('is absent from every file under apps/web/src', () => {
  const offenders = [];
  const walk = directory => {
    for (const entry of readdirSync(directory)) {
      const full = path.join(directory, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry)) continue;
      const source = readFileSync(full, 'utf8');
      if (source.includes('__capiroAcceptanceOrglessTokenShim') ||
          source.includes('__capiroAcceptanceShimmed')) {
        offenders.push(path.relative(root, full));
      }
    }
  };
  walk(path.join(root, 'apps/web/src'));
  assert.deepEqual(offenders, []);
});
