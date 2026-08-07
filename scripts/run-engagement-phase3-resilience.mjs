#!/usr/bin/env node
/**
 * Locate the Phase 3 disposable PostgreSQL container, run resilience, then
 * remove and verify the one retry-probe task before containment starts.
 */
import { spawn, spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATABASE_URL = required('DATABASE_URL');
const EVIDENCE = required('ENGAGEMENT_PHASE3_EVIDENCE_DIR');
const DOCKER = process.platform === 'win32' ? 'docker.exe' : 'docker';

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function runSync(command, args) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    env: process.env,
    shell: process.platform === 'win32',
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`);
  }
  return String(result.stdout ?? '').trim();
}

async function run(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      env,
      shell: process.platform === 'win32',
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} ${args.join(' ')} failed with exit ${code}`)),
    );
  });
}

function discoverContainer() {
  const parsed = new URL(DATABASE_URL);
  const port = parsed.port || '5432';
  const names = runSync(DOCKER, [
    'ps',
    '--filter',
    `publish=${port}`,
    '--format',
    '{{.Names}}',
  ])
    .split(/\r?\n/)
    .map((row) => row.trim())
    .filter(Boolean);
  const phase3 = names.filter((name) => name.startsWith('engagement-phase3-'));
  if (phase3.length !== 1) {
    throw new Error(
      `Expected exactly one Phase 3 PostgreSQL container publishing ${port}; ` +
        `found [${phase3.join(', ')}] among [${names.join(', ')}]`,
    );
  }
  return phase3[0];
}

async function main() {
  const container = discoverContainer();
  await run('node', ['scripts/engagement-phase3-resilience.mjs'], {
    ...process.env,
    ENGAGEMENT_PHASE3_DB_CONTAINER: container,
  });

  const evidencePath = path.join(EVIDENCE, 'resilience.json');
  const evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
  const retry = (evidence.results ?? []).find(
    (row) => row.id === 'safe-write-retry-no-duplicate',
  );
  const taskId = retry?.retriedTask?.body?.id;
  if (typeof taskId !== 'string' || !/^[0-9a-f-]{36}$/i.test(taskId)) {
    throw new Error('Resilience evidence did not expose a valid retry task id for cleanup');
  }

  const sql = [
    `DELETE FROM engagement_tasks WHERE id = '${taskId}'::uuid;`,
    `SELECT COUNT(*) FROM engagement_tasks WHERE id = '${taskId}'::uuid;`,
  ].join(' ');
  const output = runSync(DOCKER, [
    'exec',
    container,
    'psql',
    '-U',
    'capiro',
    '-d',
    'capiro',
    '-v',
    'ON_ERROR_STOP=1',
    '-tAc',
    sql,
  ]);
  const residual = Number(output.split(/\r?\n/).map((row) => row.trim()).filter(Boolean).at(-1));
  if (residual !== 0) throw new Error(`Resilience retry cleanup left ${residual} task rows`);

  evidence.retryRowCleaned = true;
  evidence.retryCleanupResidual = residual;
  evidence.databaseContainerRecorded = false;
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log('ENGAGEMENT_PHASE3_RESILIENCE_AND_CLEANUP_COMPLETE');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
