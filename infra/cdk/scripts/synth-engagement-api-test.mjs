#!/usr/bin/env node
/**
 * Synthesize the engagement-api CDK app against the synthetic test fixture.
 *
 * A thin wrapper rather than `ENGAGEMENT_API_INFRA_CONFIG=... cdk synth ...`
 * directly in package.json: pnpm on Windows runs scripts through cmd.exe by
 * default, which does not understand the `VAR=value command` prefix syntax —
 * setting the variable in Node's own child_process env option is portable
 * across every shell pnpm might pick.
 *
 * Usage: node scripts/synth-engagement-api-test.mjs [--quiet]
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CDK_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = path.join(CDK_ROOT, 'fixtures', 'engagement-api.test.json');
const extraArgs = process.argv.slice(2);

// A .cmd shim on Windows can only run through cmd.exe (shell: true), and
// Node does not escape shell:true argv arrays for you — an unescaped array
// containing "--app" with an embedded-space value produces a silently wrong
// command line (cdk synths nothing, no error, and the caller gets a bare
// ENOENT reading the manifest it never wrote). Building one fully quoted
// string and passing it as the shell command sidesteps that entirely.
const cdkBin = path.join(
  CDK_ROOT,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'cdk.cmd' : 'cdk',
);
const appCommand = 'ts-node --prefer-ts-exts bin/engagement-api.ts';
const command = [`"${cdkBin}"`, 'synth', '--app', `"${appCommand}"`, ...extraArgs].join(' ');

// cdk spawns the --app command (`ts-node ...`) as its own child process. That
// child only finds `ts-node` on PATH — which `pnpm exec` would normally set
// up, but calling the .bin shim directly bypasses pnpm entirely. Prepend
// node_modules/.bin here ourselves so the resolution still works.
const binDir = path.join(CDK_ROOT, 'node_modules', '.bin');
const pathSeparator = process.platform === 'win32' ? ';' : ':';

const result = spawnSync(command, [], {
  cwd: CDK_ROOT,
  stdio: 'inherit',
  shell: true,
  env: {
    ...process.env,
    ENGAGEMENT_API_INFRA_CONFIG: CONFIG_PATH,
    PATH: `${binDir}${pathSeparator}${process.env.PATH ?? ''}`,
  },
});

process.exit(result.status ?? 1);
