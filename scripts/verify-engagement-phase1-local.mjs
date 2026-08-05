#!/usr/bin/env node
/**
 * Authoritative Phase 1 local command.
 *
 * The primary runner proves the full two-process/API/browser/image contract.
 * A mandatory isolated runtime then proves successful browser responses and
 * real seeded-record parity. A final fresh process re-proves background
 * containment with JSON-encoded PostgreSQL digests.
 */
import { execFileSync, spawn } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const parsed = parse(args);
const sha =
  parsed.sha ??
  execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
const evidence = path.resolve(
  ROOT,
  parsed.evidenceDir ?? `.artifacts/engagement-phase1-${sha}`,
);
const summary = path.join(evidence, 'local-runner-summary.json');
const postProofPath = path.join(evidence, 'post-acceptance-proof.json');

await run('Phase 1 full local closeout', [
  path.join(ROOT, 'scripts', 'run-engagement-phase1-local.mjs'),
  ...args,
]);

try {
  await run('Phase 1 isolated successful-response and real-record closeout', [
    path.join(ROOT, 'scripts', 'run-engagement-phase1-post-acceptance.mjs'),
    ...args,
  ]);

  const postProof = JSON.parse(await readFile(postProofPath, 'utf8'));
  const replayResults = postProof.browserReplays?.results ?? [];
  if (
    postProof.marker !== 'ENGAGEMENT_PHASE1_POST_ACCEPTANCE_COMPLETE' ||
    postProof.sha !== sha ||
    postProof.browserResponsesSuccessful !== true ||
    postProof.realSeededReadParity !== true ||
    replayResults.length === 0 ||
    replayResults.some((result) => result.status < 200 || result.status >= 300)
  ) {
    throw new Error(
      `Post-acceptance proof is incomplete or contains a non-2xx replay: ${JSON.stringify({
        marker: postProof.marker,
        sha: postProof.sha,
        browserResponsesSuccessful: postProof.browserResponsesSuccessful,
        realSeededReadParity: postProof.realSeededReadParity,
        replayResults,
      })}`,
    );
  }

  // A previous local attempt must not satisfy the strict log assertions.
  await rm(path.join(evidence, 'logs', 'engagement-api-strict-background.log'), {
    force: true,
  });
  await rm(path.join(evidence, 'strict-background-failure.json'), { force: true });

  await run('Phase 1 strict background digest closeout', [
    path.join(ROOT, 'scripts', 'verify-engagement-phase1-background-final.mjs'),
    ...args,
  ]);

  const finalSummary = JSON.parse(await readFile(summary, 'utf8'));
  if (
    finalSummary.sha !== sha ||
    finalSummary.actualHeadSha !== sha ||
    finalSummary.browserResponsesVerified !== true ||
    finalSummary.realSeededReadParity !== true ||
    finalSummary.strictBackgroundContainment !== true
  ) {
    throw new Error(
      `Final Phase 1 summary is incomplete: ${JSON.stringify({
        sha: finalSummary.sha,
        actualHeadSha: finalSummary.actualHeadSha,
        browserResponsesVerified: finalSummary.browserResponsesVerified,
        realSeededReadParity: finalSummary.realSeededReadParity,
        strictBackgroundContainment: finalSummary.strictBackgroundContainment,
      })}`,
    );
  }
} catch (error) {
  // Every earlier marker is provisional. Any post-pass or strict-stage failure
  // removes the merge-authorizing summary so stale success cannot survive.
  await rm(summary, { force: true }).catch(() => undefined);
  throw error;
}

console.log('ENGAGEMENT_PHASE1_AUTHORITATIVE_LOCAL_COMPLETE');

async function run(label, commandArgs) {
  console.log(`\n==> ${label}`);
  const child = spawn(process.execPath, commandArgs, {
    cwd: ROOT,
    env: process.env,
    shell: false,
    windowsHide: true,
    stdio: 'inherit',
  });
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (value) => resolve(value ?? 1));
  });
  if (code !== 0) throw new Error(`${label} failed with exit code ${code}`);
}

function parse(values) {
  const output = {};
  for (let index = 0; index < values.length; index += 1) {
    const arg = values[index];
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`);
    const [raw, inline] = arg.slice(2).split('=', 2);
    const key = raw.replace(/-([a-z])/g, (_match, character) => character.toUpperCase());
    const value = inline ?? values[++index];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for --${raw}`);
    output[key] = value;
  }
  return output;
}
