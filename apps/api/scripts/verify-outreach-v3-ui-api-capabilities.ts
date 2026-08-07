#!/usr/bin/env tsx
/**
 * CLI for the Outreach V3 UI-to-API capability matrix.
 *
 * All logic lives in `src/engagement/outreach-v3-ui-api-capability.ts`; this
 * file only does file I/O so the matrix stays importable from a typechecked
 * spec.
 *
 * Usage:
 *   tsx apps/api/scripts/verify-outreach-v3-ui-api-capabilities.ts
 *   tsx apps/api/scripts/verify-outreach-v3-ui-api-capabilities.ts --write
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  buildCapabilityManifest,
  verifyCapabilityManifest,
} from '../src/engagement/outreach-v3-ui-api-capability.js';

const API_ROOT = path.resolve(__dirname, '..');
const FIXTURES = path.join(API_ROOT, 'src/engagement/__fixtures__');
const PROTOTYPE_MANIFEST = path.join(FIXTURES, 'outreach-v3-prototype-state-manifest.v1.json');
const ROUTE_MANIFEST = path.join(FIXTURES, 'engagement-route-manifest.v1.json');
const CAPABILITY_MANIFEST = path.join(FIXTURES, 'outreach-v3-ui-api-capability-manifest.v1.json');

function main(): void {
  const write = process.argv.includes('--write');
  const prototype = JSON.parse(readFileSync(PROTOTYPE_MANIFEST, 'utf8'));
  const routeManifest = JSON.parse(readFileSync(ROUTE_MANIFEST, 'utf8'));

  const manifest = buildCapabilityManifest(prototype, routeManifest);
  const failures = verifyCapabilityManifest(manifest, prototype, routeManifest);

  if (failures.length > 0) {
    for (const failure of failures) console.error(`FAIL  ${failure}`);
    console.error(`\nOUTREACH_V3_UI_API_CAPABILITY_FAILED (${failures.length} failure(s))`);
    process.exit(1);
  }

  const serialized = `${JSON.stringify(manifest, null, 2)}
`;
  if (write) {
    writeFileSync(CAPABILITY_MANIFEST, serialized);
    console.log(`Wrote ${path.relative(API_ROOT, CAPABILITY_MANIFEST)}`);
  } else if (readFileSync(CAPABILITY_MANIFEST, 'utf8') !== serialized) {
    console.error('FAIL  capability manifest is stale; re-run with --write and review the diff');
    process.exit(1);
  }

  const counts = manifest.entries.reduce<Record<string, number>>((acc, entry) => {
    acc[entry.capabilityClass] = (acc[entry.capabilityClass] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`States mapped: ${manifest.entries.length}`);
  for (const key of Object.keys(counts).sort()) console.log(`  ${key}: ${counts[key]}`);
  console.log('\nOUTREACH_V3_UI_API_CAPABILITY_VERIFIED');
}

main();
