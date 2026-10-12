/**
 * In-container provenance verification (round-12).
 *
 * Uses the CANONICAL walker (apps/e2e/lib/source-identity.mjs verifyManifest) —
 * NOT a duplicated inline walker that trusts manifest.measuredInputs. Validates
 * schema/head/tree/files/fingerprint against the extracted /work bytes.
 * cwd must be the extracted source root (/work).
 */
import { readFileSync } from 'node:fs';
import { verifyManifest } from '../lib/source-identity.mjs';

const doc = JSON.parse(readFileSync('/arch/source-manifest.json', 'utf8'));
if (doc.head == null || doc.treeHash == null) {
  console.error('PROVENANCE FAIL: manifest lacks immutable head/tree');
  process.exit(1);
}
const v = verifyManifest(doc, process.cwd());
if (!v.ok) {
  console.error('PROVENANCE FAIL:', JSON.stringify(v.errors, null, 2));
  if (v.missing?.length) console.error('missing:', v.missing.slice(0, 20));
  if (v.changed?.length) console.error('changed:', v.changed.slice(0, 20));
  if (v.added?.length) console.error('added:', v.added.slice(0, 20));
  process.exit(1);
}
console.log(`[capture] canonical provenance OK head=${doc.head} fingerprint=${doc.fingerprint.slice(0, 16)}`);
