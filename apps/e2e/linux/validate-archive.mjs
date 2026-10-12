/**
 * HOST-side archive validation for the portable runner (round-15).
 *
 *   node validate-archive.mjs <archiveDir> <bootstrapDir>
 *
 * Delegates ALL tar-header semantics to the ONE shared validator
 * (apps/e2e/lib/tar-validate.mjs) — no second, weaker parser. It also:
 *   - binds manifest ↔ receipt (schema/head/tree/fingerprint/fileCount) and
 *     requires the exact `source-<head>.tar` + sha256;
 *   - binds the archive to the canonical manifest by ACTUAL PAYLOAD (every
 *     manifest.files[] path must exist as a regular tar entry whose payload
 *     sha256 + size match) — not by trusting producer JSON;
 *   - requires every canonical REQUIRED_INPUT to be present in the tar BEFORE
 *     any setup/install (post-extraction verify-provenance is defence in depth);
 *   - byte-binds the trusted /bootstrap harness files to the measured archive.
 *
 * Prints `TARBALL_NAME=<name>` on success. Fail-closed on any problem.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { REQUIRED_INPUTS, MEASURED_INPUTS, fingerprintOf, comparePaths } from '../lib/source-identity.mjs';
import { validateTarAgainstManifest } from '../lib/tar-validate.mjs';

const [DIR, BOOTSTRAP_DIR] = process.argv.slice(2);
if (!DIR || !BOOTSTRAP_DIR) { console.error('[validate-archive] usage: validate-archive.mjs <archiveDir> <bootstrapDir>'); process.exit(2); }

const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const errs = [];
const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

let receipt; let manifest;
try { receipt = JSON.parse(readFileSync(path.join(DIR, 'archive-receipt.json'), 'utf8')); } catch (e) { console.error(`[validate-archive] receipt unreadable: ${e.message}`); process.exit(1); }
try { manifest = JSON.parse(readFileSync(path.join(DIR, 'source-manifest.json'), 'utf8')); } catch (e) { console.error(`[validate-archive] manifest unreadable: ${e.message}`); process.exit(1); }

if (receipt.schema !== 'capiro.cleanup1.visual-source-archive.v1') errs.push(`receipt schema: ${receipt.schema}`);
if (!HEX40.test(String(receipt.head))) errs.push(`receipt.head not 40-hex: ${JSON.stringify(receipt.head)}`);
if (!HEX40.test(String(receipt.treeHash))) errs.push('receipt.treeHash not 40-hex');
if (!HEX64.test(String(receipt.tarSha256))) errs.push('receipt.tarSha256 not 64-hex');
if (typeof receipt.tarball !== 'string' || !/^source-[0-9a-f]{40}\.tar$/.test(receipt.tarball)) errs.push(`receipt.tarball invalid: ${receipt.tarball}`);
if (receipt.tarball !== `source-${receipt.head}.tar`) errs.push('tarball name is not bound to the receipt head');

if (manifest.schema !== 'capiro.cleanup1.visual-source-manifest.v1') errs.push(`manifest schema: ${manifest.schema}`);
if (manifest.head !== receipt.head) errs.push('manifest.head != receipt.head');
if (manifest.treeHash !== receipt.treeHash) errs.push('manifest.treeHash != receipt.treeHash');
if (manifest.fingerprint !== receipt.sourceFingerprint) errs.push('manifest.fingerprint != receipt.sourceFingerprint');
if (manifest.fileCount !== receipt.fileCount) errs.push('manifest.fileCount != receipt.fileCount');

// Independent canonical manifest verification (shape/order/fingerprint/scope)
// BEFORE any setup/install — never trust producer JSON fields alone.
if (!Array.isArray(manifest.files) || manifest.files.length === 0) errs.push('manifest.files[] missing/empty');
else {
  if (Number.isInteger(manifest.fileCount) && manifest.fileCount !== manifest.files.length) errs.push('manifest.fileCount != files[] length');
  const seen = new Set(); let prev = '';
  for (const f of manifest.files) {
    if (!f || typeof f.path !== 'string' || !/^[0-9a-f]{64}$/.test(String(f.sha256)) || !Number.isInteger(f.bytes)) { errs.push('manifest files[] entry shape invalid'); break; }
    if (f.path.startsWith('/') || f.path.split('/').includes('..')) { errs.push(`manifest unsafe path: ${f.path}`); break; }
    if (seen.has(f.path)) { errs.push(`manifest duplicate path: ${f.path}`); break; }
    if (comparePaths(prev, f.path) > 0) { errs.push('manifest files[] is not path-ordered'); break; }
    seen.add(f.path); prev = f.path;
  }
  if (fingerprintOf(manifest.files) !== manifest.fingerprint) errs.push('manifest.fingerprint is not the digest of files[]');
  if (JSON.stringify(manifest.measuredInputs) !== JSON.stringify([...MEASURED_INPUTS])) errs.push('manifest.measuredInputs != canonical set');
}

const tarPath = path.join(DIR, receipt.tarball);
let bound = 0; let entryCount = 0;
if (!existsSync(tarPath)) { errs.push(`tarball missing: ${receipt.tarball}`); }
else {
  const buf = readFileSync(tarPath);
  const actual = createHash('sha256').update(buf).digest('hex');
  if (actual !== receipt.tarSha256) errs.push(`tar sha256 mismatch: ${actual} != ${receipt.tarSha256}`);
  // Shared parser: real typeflags + PAX/GNU effective paths + checksum/size/truncation.
  const v = validateTarAgainstManifest(buf, manifest, REQUIRED_INPUTS);
  errs.push(...v.errors);
  bound = v.bound ?? 0; entryCount = v.entries ?? 0;
}

// Byte-bind the trusted /bootstrap harness to the archived measured source.
const manifestByPath = new Map((manifest.files ?? []).map((f) => [f.path, f]));
let bootstrapBound = 0;
for (const name of readdirSync(BOOTSTRAP_DIR)) {
  const abs = path.join(BOOTSTRAP_DIR, name);
  if (!statSync(abs).isFile()) continue;
  const rel = `apps/e2e/linux/${name}`;
  const mf = manifestByPath.get(rel);
  if (!mf) { errs.push(`bootstrap file not in the measured manifest: ${rel}`); continue; }
  const actual = sha256(abs);
  if (actual !== mf.sha256) errs.push(`bootstrap byte-binding mismatch for ${rel}: ${actual.slice(0, 16)} != ${mf.sha256.slice(0, 16)}`);
  bootstrapBound++;
}
if (bootstrapBound === 0) errs.push('no bootstrap files bound (empty bootstrap dir?)');

if (errs.length) { console.error('[validate-archive] REFUSING:'); for (const e of errs.slice(0, 60)) console.error(`  ${e}`); process.exit(1); }
console.log(`[validate-archive] OK entries=${entryCount} payloadBound=${bound} bootstrapBound=${bootstrapBound} head=${receipt.head}`);
console.log(`TARBALL_NAME=${receipt.tarball}`);
