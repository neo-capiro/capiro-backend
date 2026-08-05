#!/usr/bin/env node
/**
 * Authoritative Phase 1 local command.
 *
 * The primary runner proves the full two-process/API/browser/image contract.
 * A mandatory second process then re-proves background containment with
 * JSON-encoded PostgreSQL digests. Arguments are passed to both stages.
 */
import { execFileSync, spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
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

await run('Phase 1 full local closeout', [
  path.join(ROOT, 'scripts', 'run-engagement-phase1-local.mjs'),
  ...args,
]);

// A previous local attempt must not satisfy the strict log assertions.
await rm(path.join(evidence, 'logs', 'engagement-api-strict-background.log'), {
  force: true,
});
await rm(path.join(evidence, 'strict-background-failure.json'), { force: true });

await run('Phase 1 strict background digest closeout', [
  path.join(ROOT, 'scripts', 'verify-engagement-phase1-background-final.mjs'),
  ...args,
]);

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
