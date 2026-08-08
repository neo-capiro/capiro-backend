#!/usr/bin/env node
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let expectedSha = null;
for (let i = 2; i < process.argv.length; i += 1) {
  if (process.argv[i] === '--sha') expectedSha = process.argv[++i];
  else throw new Error(`Unknown argument: ${process.argv[i]}`);
}
if (!expectedSha || !/^[0-9a-f]{40}$/i.test(expectedSha)) {
  throw new Error('Usage: node scripts/run-outreach-v3-phase2-local.mjs --sha <40-char HEAD SHA>');
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    env: process.env,
    shell: process.platform === 'win32',
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  if (options.logPath) writeFileSync(options.logPath, output, 'utf8');
  if (result.status !== 0) {
    throw new Error(`${options.label || command} failed (exit ${result.status})\n${output.slice(-4000)}`);
  }
  if (!options.quiet) process.stdout.write(output);
  return output.trim();
}

const head = run('git', ['rev-parse', 'HEAD'], { quiet: true }).trim();
if (head !== expectedSha) throw new Error(`Expected HEAD ${expectedSha}; actual ${head}`);
const initialStatus = run('git', ['status', '--short'], { quiet: true });
if (initialStatus.trim()) throw new Error(`Phase 2 acceptance requires a clean tree:\n${initialStatus}`);

const artifactDir = path.resolve(ROOT, `.artifacts/outreach-v3-phase2-${head}`);
rmSync(artifactDir, { recursive: true, force: true });
mkdirSync(path.join(artifactDir, 'logs'), { recursive: true });

const summary = {
  schemaVersion: 1,
  sha: head,
  startedAt: new Date().toISOString(),
  browserAcceptance: {
    performedLocally: false,
    reason: 'owner-directed deployed-app browser acceptance; no localhost Clerk/browser acceptance',
  },
  gates: {},
};

function gate(name, command, args, marker, logName) {
  console.log(`\n==> ${name}`);
  const output = run(command, args, {
    label: name,
    logPath: path.join(artifactDir, 'logs', logName),
  });
  if (marker && !output.includes(marker)) {
    throw new Error(`${name} exited zero but did not emit required marker ${marker}`);
  }
  summary.gates[name] = { status: 'PASS', marker: marker || null };
}

let failed = false;
try {
  gate(
    'phase2DbFree',
    'pnpm',
    ['verify:outreach-v3-phase-2'],
    'OUTREACH_V3_PHASE2_DB_FREE_COMPLETE',
    'phase2-db-free.log',
  );
  gate(
    'phase2Database',
    'pnpm',
    ['verify:outreach-v3-phase-2:db'],
    'OUTREACH_V3_PHASE2_DB_COMPLETE',
    'phase2-database.log',
  );
  gate(
    'phase2StateFlow',
    'node',
    [
      'scripts/run-outreach-v3-phase2-flow-db.mjs',
      '--output',
      path.relative(ROOT, path.join(artifactDir, 'session-flow.json')),
    ],
    'OUTREACH_V3_PHASE2_FLOW_DB_COMPLETE',
    'phase2-state-flow.log',
  );
  gate(
    'phase3DbFreeRegression',
    'pnpm',
    ['verify:engagement-phase-3'],
    'ENGAGEMENT_PHASE3_DB_FREE_COMPLETE',
    'phase3-db-free-regression.log',
  );

  const finalStatus = run('git', ['status', '--short'], { quiet: true });
  const unexpected = finalStatus
    .split(/\r?\n/)
    .filter(Boolean)
    .filter((line) => !line.includes('.artifacts/'));
  if (unexpected.length) {
    throw new Error(`Acceptance left tracked/unexpected working-tree changes:\n${unexpected.join('\n')}`);
  }
  summary.workingTreeClean = true;
  summary.finishedAt = new Date().toISOString();
  summary.result = 'PASS';
  writeFileSync(path.join(artifactDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  console.log('\nOUTREACH_V3_PHASE2_LOCAL_COMPLETE');
} catch (error) {
  failed = true;
  summary.finishedAt = new Date().toISOString();
  summary.result = 'FAIL';
  summary.error = error instanceof Error ? error.message : String(error);
  writeFileSync(path.join(artifactDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
} finally {
  if (failed) process.exitCode = 1;
}
