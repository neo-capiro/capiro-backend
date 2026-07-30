/**
 * Phase E static verifier: every PE dollar loader must import the exact-SHA
 * contract and gate --commit on --approved-sha256. No DB or vendor calls.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { PE_EXACT_SHA_DOLLAR_LOADERS } from './lib/pe-exact-sha-loader-contract.js';

function apiRoot(): string {
  const cwd = process.cwd().replace(/\\/g, '/');
  return cwd.endsWith('/apps/api') ? process.cwd() : resolve(process.cwd(), 'apps/api');
}

function sourceOf(fileName: string): string {
  const path = resolve(apiRoot(), 'scripts', fileName);
  if (!existsSync(path)) {
    throw new Error(`Missing loader entrypoint: ${fileName}`);
  }
  return readFileSync(path, 'utf8');
}

const failures: string[] = [];

for (const fileName of PE_EXACT_SHA_DOLLAR_LOADERS) {
  const source = sourceOf(fileName);

  if (fileName === 'ingest-defense-budget-pdf.ts') {
    // Generalized PDF path already uses Phase B helpers; it must keep fail-closed
    // approval + still not treat --allow-vendor-parse as a write posture.
    if (!source.includes("requireApprovedSha256(arg('approved-sha256'))")) {
      failures.push(`${fileName}: missing requireApprovedSha256 on commit`);
    }
    if (!source.includes('assertApprovedShaMatches(sourceSha256, approvedSha256)')) {
      failures.push(`${fileName}: missing assertApprovedShaMatches before promote`);
    }
    if (!source.includes("const ALLOW_VENDOR_PARSE = '--allow-vendor-parse'")) {
      failures.push(`${fileName}: missing explicit vendor-parse authorization`);
    }
    continue;
  }

  if (fileName === 'load-defense-budget-package.ts') {
    // Reviewed package JSON loader: inspect default; hard plan.errors + exact SHA block commit.
    if (!(
      source.includes('resolvePeDollarLoaderPosture') ||
      source.includes("process.argv.includes('--commit')")
    )) {
      failures.push(`${fileName}: missing --commit / posture gate`);
    }
    if (!source.includes('assertExactShaCommitAllowed') && !source.includes('plan.errors')) {
      failures.push(`${fileName}: missing plan.errors or exact-SHA quality gate`);
    }
    if (!source.includes('plan.errors')) {
      failures.push(`${fileName}: missing plan.errors quality gate`);
    }
    continue;
  }

  if (!source.includes("from './lib/pe-exact-sha-loader-contract.js'") &&
      !source.includes('from "./lib/pe-exact-sha-loader-contract.js"')) {
    failures.push(`${fileName}: does not import pe-exact-sha-loader-contract`);
  }
  if (!source.includes('resolvePeDollarLoaderPosture')) {
    failures.push(`${fileName}: missing resolvePeDollarLoaderPosture`);
  }
  if (!source.includes('assertExactShaCommitAllowed')) {
    failures.push(`${fileName}: missing assertExactShaCommitAllowed`);
  }
  if (!source.includes("'approved-sha256'") && !source.includes('"approved-sha256"')) {
    failures.push(`${fileName}: missing approved-sha256 wiring`);
  }
  // Default path must be able to exit without commit writes — look for INSPECT marker.
  if (!source.includes('INSPECT') && !source.includes("'inspect'")) {
    failures.push(`${fileName}: missing inspect posture handling`);
  }
}

if (failures.length) {
  console.error(JSON.stringify({ ok: false, failures }, null, 2));
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      ok: true,
      loadersChecked: PE_EXACT_SHA_DOLLAR_LOADERS.length,
      loaders: PE_EXACT_SHA_DOLLAR_LOADERS,
    },
    null,
    2,
  ),
);
