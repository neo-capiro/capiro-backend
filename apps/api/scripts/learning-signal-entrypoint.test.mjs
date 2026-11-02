import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { resolve, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const scratchRoot = resolve(process.env.LEARNING_ENTRYPOINT_TEST_SCRATCH ?? '.');
const shell = process.env.LEARNING_ENTRYPOINT_TEST_SHELL ?? 'sh';

function run(args, { childExit = '0', missingDatabase = false } = {}) {
  const directory = mkdtempSync(join(scratchRoot, 'learning-entrypoint-'));
  assert.ok(directory.startsWith(scratchRoot + sep));
  try {
    mkdirSync(join(directory, 'node_modules', '.bin'), { recursive: true });
    const capture = join(directory, 'capture.cjs');
    const receipt = join(directory, 'receipt.json');
    writeFileSync(
      capture,
      `require('node:fs').writeFileSync(process.env.RECEIPT, JSON.stringify({args:process.argv.slice(2), database:process.env.DATABASE_URL, tmp:process.env.TMPDIR})); process.exit(Number(process.env.CHILD_EXIT));`,
    );
    writeFileSync(
      join(directory, 'node_modules', '.bin', 'tsx'),
      '#!/bin/sh\nexec node "$CAPTURE" "$@"\n',
      { mode: 0o755 },
    );
    const env = {
      PATH: process.env.PATH,
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      TMPDIR: directory.replaceAll('\\', '/'),
      DB_HOST: 'synthetic.invalid',
      DB_PORT: '5432',
      DB_USER: 'synthetic',
      DB_PASSWORD: 'synthetic:@only',
      DB_NAME: 'synthetic',
      PE_COMPOSE_DATABASE_URL_JS: join(sourceRoot, 'scripts/lib/pe-compose-database-url.js'),
      CAPTURE: capture,
      RECEIPT: receipt,
      CHILD_EXIT: childExit,
    };
    if (missingDatabase) delete env.DB_PASSWORD;
    const result = spawnSync(
      shell,
      [join(sourceRoot, 'scripts/entrypoint.sh'), 'learning-signal-candidate-generation', ...args],
      {
        cwd: directory,
        env,
        encoding: 'utf8',
        timeout: 10000,
      },
    );
    assert.ifError(result.error);
    return {
      status: result.status,
      receipt: existsSync(receipt) ? JSON.parse(readFileSync(receipt, 'utf8')) : null,
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('actual entrypoint dispatches exact single-signal arguments to the existing CLI', () => {
  const args = [
    '--tenant',
    '11111111-1111-4111-8111-111111111111',
    '--signal',
    '22222222-2222-4222-8222-222222222222',
  ];
  const result = run(args);
  assert.equal(result.status, 0);
  assert.deepEqual(result.receipt.args, [
    'scripts/run-learning-signal-candidate-generation.ts',
    ...args,
  ]);
  assert.equal(
    result.receipt.database,
    'postgresql://synthetic:synthetic%3A%40only@synthetic.invalid:5432/synthetic?schema=public&sslmode=require&connection_limit=10',
  );
  assert.ok(result.receipt.tmp);
});

test('actual exec preserves child refusal exit and argument boundaries', () => {
  const args = ['--tenant', 'synthetic value with spaces', '--signal', '--invalid'];
  const result = run(args, { childExit: '19' });
  assert.equal(result.status, 19);
  assert.deepEqual(result.receipt.args, [
    'scripts/run-learning-signal-candidate-generation.ts',
    ...args,
  ]);
});

test('missing database configuration refuses before child invocation', () => {
  const result = run([], { missingDatabase: true });
  assert.equal(result.status, 1);
  assert.equal(result.receipt, null);
});

test('existing batch arguments pass through unchanged', () => {
  for (const args of [[], ['--tenant', '11111111-1111-4111-8111-111111111111']]) {
    const result = run(args);
    assert.equal(result.status, 0);
    assert.deepEqual(result.receipt.args, [
      'scripts/run-learning-signal-candidate-generation.ts',
      ...args,
    ]);
  }
});
