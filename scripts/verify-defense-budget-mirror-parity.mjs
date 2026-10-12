#!/usr/bin/env node
/** @cleanup-smoke noArgsExit=0 helpExit=0 */
/**
 * Verify exact content parity between the two defense-budget mirror directories.
 * Reports counts, missing/extra/mismatched files, exits non-zero on failure.
 * Does NOT mutate either mirror.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { exit } from 'node:process';

const usage = 'Usage: node scripts/verify-defense-budget-mirror-parity.mjs (no arguments runs the existing verifier)';
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--help') {
  console.log(usage);
  exit(0);
}
if (args.length !== 0) {
  console.error(usage);
  exit(2);
}

const ROOT = process.cwd();
const MIRROR_A = join(ROOT, 'apps/api/src/defense-budget');
const MIRROR_B = join(ROOT, 'apps/defense-api/runtime-source/defense-budget');
// Historical closeout baseline contained 721 files. The bounded native XML
// adapter and its mirrored regression spec add two files in each current mirror.
const EXPECTED_FILE_COUNT = 723;

async function computeFileHash(filePath) {
  const content = await readFile(filePath);
  return createHash('sha256').update(content).digest('hex');
}

async function walk(dir, base = dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walk(full, base));
    } else {
      files.push(relative(base, full).replaceAll(String.fromCharCode(92), '/'));
    }
  }
  return files.sort();
}

async function main() {
  console.error(usage);
  console.log(`Mirror A: ${MIRROR_A}`);
  console.log(`Mirror B: ${MIRROR_B}`);

  const [filesA, filesB] = await Promise.all([walk(MIRROR_A), walk(MIRROR_B)]);
  const setA = new Set(filesA);
  const setB = new Set(filesB);

  const missingInB = filesA.filter(f => !setB.has(f));
  const extraInB = filesB.filter(f => !setA.has(f));
  const common = filesA.filter(f => setB.has(f));

  console.log(`Total files in A: ${filesA.length}`);
  console.log(`Total files in B: ${filesB.length}`);
  console.log(`Common files: ${common.length}`);

  if (missingInB.length > 0) {
    console.log(`\nFiles missing in B:`);
    missingInB.forEach(f => console.log(`  - ${f}`));
  }
  if (extraInB.length > 0) {
    console.log(`\nExtra files in B:`);
    extraInB.forEach(f => console.log(`  - ${f}`));
  }

  let mismatchCount = 0;
  const mismatches = [];
  // Compare common files by hash
  for (const rel of common) {
    const hashA = await computeFileHash(join(MIRROR_A, rel));
    const hashB = await computeFileHash(join(MIRROR_B, rel));
    if (hashA !== hashB) {
      mismatches.push({ file: rel, hashA, hashB });
    }
  }
  mismatchCount = mismatches.length;

  if (mismatchCount > 0) {
    console.log(`\nContent mismatches (SHA-256):`);
    mismatches.forEach(({ file, hashA, hashB }) => {
      console.log(`  - ${file}`);
      console.log(`    A: ${hashA}`);
      console.log(`    B: ${hashB}`);
    });
  }

  const countMismatch = filesA.length !== EXPECTED_FILE_COUNT || filesB.length !== EXPECTED_FILE_COUNT;
  if (countMismatch) {
    console.error(`\nExpected ${EXPECTED_FILE_COUNT} files in each mirror.`);
  }

  const hasProblems =
    countMismatch || missingInB.length > 0 || extraInB.length > 0 || mismatchCount > 0;
  if (hasProblems) {
    console.error(`\nFAILURE: mirrors are not identical.`);
    exit(1);
  } else {
    console.log(`\nSUCCESS: both mirrors contain exactly ${common.length} files with identical content.`);
    exit(0);
  }
}

main().catch(err => {
  console.error(err);
  exit(1);
});
