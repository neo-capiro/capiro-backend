#!/usr/bin/env node
/**
 * Parse and statically validate every repository-owned MeriV2 release operator.
 * No target script is imported or executed and no AWS call is made.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scripts = [
  'scripts/verify-meriv2-release.mjs',
  'scripts/run-meriv2-phase19-local.mjs',
  'scripts/collect-meriv2-aws-context.mjs',
  'scripts/prepare-meriv2-ecs-release.mjs',
  'scripts/execute-meriv2-ecs-release.mjs',
  'scripts/deploy-meriv2-operations-dark.mjs',
];

async function main() {
  for (const relative of scripts) {
    await nodeCheck(relative);
  }

  // Negative (prohibition) assertions run against executable code only. Comments
  // legitimately name the prohibited operation in order to document the ban, so a
  // raw-text scan cannot tell a documented prohibition from an actual call.
  const collect = code(await text('scripts/collect-meriv2-aws-context.mjs'));
  assert.doesNotMatch(
    collect,
    /GetSecretValue|secretsmanager\s+get-secret-value|'get-secret-value'/i,
  );

  const prepare = await text('scripts/prepare-meriv2-ecs-release.mjs');
  for (const fragment of [
    "MEMORY_GOVERNANCE_TENANTS: ''",
    "MERI_POLICY_PACK_TENANTS: ''",
    "MERI_RELEASE_GATE_TENANTS: ''",
    "MERI_RELEASE_GATE_SURFACES: ''",
    "MEMORY_AUTOLEARN_GOVERNED: 'false'",
  ]) {
    assert.ok(prepare.includes(fragment), `Dark task preparation is missing ${fragment}.`);
  }
  assert.doesNotMatch(code(prepare), /register-task-definition|update-service|run-task/);

  const execute = await text('scripts/execute-meriv2-ecs-release.mjs');
  for (const fragment of [
    'imageDigest',
    'assertDarkTaskDefinition',
    'runMigration',
    'rollbackServices',
    'DEPLOY_CAPIRO_',
    'additiveMigrationsRetained',
  ]) {
    assert.ok(execute.includes(fragment), `Dark ECS executor is missing ${fragment}.`);
  }
  assert.ok(
    execute.indexOf('runMigration') < execute.indexOf("'update-service'"),
    'Migration execution must precede service updates.',
  );

  const operations = await text('scripts/deploy-meriv2-operations-dark.mjs');
  for (const fragment of [
    'MemoryProjectionWorker',
    'MeriV2Control',
    "enableMemoryProjectionWorker: 'false'",
    "enableMeriV2ControlMonitor: 'false'",
    "worker.State !== 'DISABLED'",
    'OPERATIONS_DARK',
  ]) {
    assert.ok(operations.includes(fragment), `Dark operations deployer is missing ${fragment}.`);
  }
  assert.doesNotMatch(code(operations), /ComputeStack|DataStack|NetworkStack/);

  const browser = await text('scripts/run-meriv2-phase19-local.mjs');
  assert.ok(browser.includes("MEMORY_GOVERNANCE_TENANTS: 'all'"));
  assert.ok(browser.includes("MERI_POLICY_PACK_TENANTS: ''"));

  console.log(
    JSON.stringify({
      marker: 'MERIV2_RELEASE_SCRIPTS_OK',
      parsedScripts: scripts.length,
      awsMutation: false,
      sharedDatabaseMutation: false,
    }),
  );
}

async function nodeCheck(relative) {
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--check', path.join(ROOT, relative)], {
      cwd: ROOT,
      windowsHide: true,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (value) => resolve(value ?? 1));
  });
  assert.equal(code, 0, `Node syntax check failed for ${relative}.`);
}

async function text(relative) {
  return readFile(path.join(ROOT, relative), 'utf8');
}

/**
 * Strip line and block comments so prohibition assertions only inspect executable
 * code. A documented ban ("never calls GetSecretValue") must not read as a call.
 * String literals are preserved, so a real `'get-secret-value'` argument still trips.
 */
function code(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

main().catch((error) => {
  console.error(
    JSON.stringify({
      marker: 'MERIV2_RELEASE_SCRIPTS_FAILED',
      error: error instanceof Error ? error.message : String(error),
      awsMutation: false,
    }),
  );
  process.exitCode = 1;
});
