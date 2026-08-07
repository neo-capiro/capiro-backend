#!/usr/bin/env node
/**
 * Run representative browser parity, the non-skippable interaction/URL/a11y
 * matrix, replay observed Engagement GETs, sweep every unique UI read against
 * both runtimes, prove one shared safe database-local write round trip, verify
 * auth/tenant/role/ownership/wall denials, then exercise every UI-classified
 * external action while the same disposable DB/auth context is alive. The local
 * runner removes bearer material immediately afterward.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

async function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      env: process.env,
      shell: process.platform === 'win32',
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} ${args.join(' ')} failed with exit ${code}`)),
    );
  });
}

await run('node', ['apps/web/scripts/engagement-phase3-browser-parity.mjs']);
await run('node', ['apps/web/scripts/engagement-phase3-browser-interactions.mjs']);
await run('node', ['scripts/engagement-phase3-api-replay.mjs']);
await run('pnpm', [
  '-C', 'apps/api', 'exec', 'tsx', 'scripts/engagement-phase3-full-read-parity.ts',
]);
await run('pnpm', [
  '-C',
  'apps/api',
  'exec',
  'tsx',
  'scripts/engagement-phase3-local-write-interoperability.ts',
]);
await run('pnpm', [
  '-C',
  'apps/api',
  'exec',
  'tsx',
  'scripts/engagement-phase3-security-parity.ts',
]);
await run('pnpm', [
  '-C',
  'apps/api',
  'exec',
  'tsx',
  'scripts/engagement-phase3-external-denial.ts',
]);
console.log(
  'ENGAGEMENT_PHASE3_BROWSER_INTERACTIONS_FULL_READ_WRITE_SECURITY_AND_CONTAINMENT_COMPLETE',
);
