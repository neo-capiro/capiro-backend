#!/usr/bin/env node
// Narrow transport adapter for the API image's existing controlled-read owner.
// This file contains no owner/SQL implementation and emits the exact owner JSON
// bytes, framed for durable collection by the host dispatcher.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';


const SOURCE = '4f0253874357c272fda1ae2a5271ee4af645f0bc';
const INPUT_SHA256 = 'a72c2d69bebb9694edb38bc4131a60a093e6488f8cd3528fafd92db7f84a082d';
const RUN = 'f4bb30bb-ebb4-4fba-89a9-d49aeafefd1b';
const PREFIX = 'C2_CASE20_NATIVE_SETUP_RECEIPT ';
const SAFE_CODE = /^[A-Z0-9_]{1,80}$/u;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const emit = (value) => process.stdout.write(PREFIX + JSON.stringify(value) + '\n');
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).sort().join('|') === [...keys].sort().join('|');

function validateInput(input) {
  assert.equal(input.target, 'capiro-dev');
  assert.equal(input.fixtureNamespace, 'meri-foundation-20260928');
  assert.equal(input.caseId, '20');
  assert.equal(input.captureRunId, RUN);
  assert.equal(input.ctx?.tenantSlug, 'meri-foundation-20260928-t1');
  assert.equal(input.ctx?.role, 'standard_user');
  assert.equal(process.env.RELEASE_SHA, SOURCE);
  assert.equal(process.env.GIT_SHA, SOURCE);
  assert.equal(process.env.MERI_SYNTHETIC_FIXTURE_NAMESPACE, input.fixtureNamespace);
  assert.equal(process.env.AWS_REGION_DEFAULT, 'us-east-1');
  assert.equal(process.env.DB_NAME, 'capiro');
  assert.equal(process.env.PGSSLMODE, 'require');
}

function parseOwner(bytes) {
  const text = bytes.toString('utf8');
  assert.ok(Buffer.from(text, 'utf8').equals(bytes), 'Owner receipt is not valid UTF-8');
  const value = JSON.parse(text);
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value;
}

async function main() {
  const args = process.argv.slice(2);
  const mode = args.shift();
  assert.ok(mode === 'plan' || mode === 'execute');
  assert.equal(args.shift(), '--input');
  const inputPath = args.shift();
  assert.equal(args.shift(), '--owner-input');
  const ownerInputPath = args.shift();
  assert.equal(args.shift(), '--out');
  const outPath = args.shift();
  assert.equal(args.length, 0);
  assert.equal(inputPath, `/dev/shm/case20-native-setup-${mode}-input.json`);
  assert.equal(ownerInputPath, `/dev/shm/case20-native-setup-${mode}-owner-input.json`);
  assert.equal(outPath, `/dev/shm/case20-native-setup-${mode}-owner.json`);

  const inputBytes = await readFile(inputPath);
  assert.equal(hash(inputBytes), INPUT_SHA256);
  const input = JSON.parse(inputBytes.toString('utf8'));
  validateInput(input);
  const ownerInputBytes = await readFile(ownerInputPath);
  assert.ok(ownerInputBytes.length > 0 && ownerInputBytes.length <= 256 * 1024);
  const ownerInput = JSON.parse(ownerInputBytes.toString('utf8'));
  assert.equal(ownerInput.target, input.target);
  assert.equal(ownerInput.fixtureNamespace, input.fixtureNamespace);
  assert.equal(ownerInput.caseId, input.caseId);
  assert.equal(ownerInput.captureRunId, input.captureRunId);
  assert.equal(ownerInput.clientId, input.clientId);
  assert.deepEqual(ownerInput.ctx, input.ctx);

  if (mode === 'plan') {
    assert.equal(process.env.C2_CASE20_PRIOR_PLAN_RECEIPT_B64 ?? '', '');
    assert.deepEqual(ownerInput, input);
  } else {
    // The host passes the exact saved owner plan JSON bytes from its successful
    // plan result, not a synthesized envelope or caller-supplied plan fields.
    const encoded = process.env.C2_CASE20_PRIOR_PLAN_RECEIPT_B64;
    assert.equal(typeof encoded, 'string');
    assert.ok(encoded.length > 0 && encoded.length <= 256 * 1024);
    const priorBytes = Buffer.from(encoded, 'base64');
    assert.equal(priorBytes.toString('base64'), encoded);
    const expectedBytesSha = process.env.C2_CASE20_PRIOR_PLAN_RECEIPT_SHA256;
    assert.match(expectedBytesSha ?? '', /^[a-f0-9]{64}$/u);
    assert.equal(hash(priorBytes), expectedBytesSha);
    const plan = parseOwner(priorBytes);
    assert.equal(plan.kind, 'meri-controlled-read-setup-plan');
    assert.equal(plan.version, 1);
    assert.equal(plan.liveAcceptance, 'NOT_RUN');
    assert.equal(ownerInput.expectedPlanSha256, plan.planSha256);
    assert.equal(ownerInput.confirmation, 'INSTALL_OWNED_CONTROLLED_READ_FIXTURE');
    assert.deepEqual(Object.keys(ownerInput).sort(),
      ['target', 'fixtureNamespace', 'ctx', 'caseId', 'clientId', 'captureRunId', 'expectedPlanSha256', 'confirmation'].sort());
  }

  // The overridden ECS entryPoint bypasses entrypoint.sh; compose DATABASE_URL
  // with the image-owned helper explicitly. Capture its stdout only in memory.
  const helper = '/app/apps/api/scripts/lib/pe-compose-database-url.js';
  const runtimeEnv = {};
  for (const name of ['PATH', 'TMPDIR', 'DB_HOST', 'DB_PORT', 'DB_USER',
    'DB_PASSWORD', 'DB_NAME', 'PGSSLMODE', 'AWS_REGION_DEFAULT',
    'MERI_SYNTHETIC_FIXTURE_NAMESPACE', 'RELEASE_SHA', 'GIT_SHA',
    'C2_CASE20_INNER_SHA256', 'C2_CASE20_PRIOR_PLAN_RECEIPT_B64',
    'C2_CASE20_PRIOR_PLAN_RECEIPT_SHA256']) {
    if (process.env[name] !== undefined) runtimeEnv[name] = process.env[name];
  }
  const composed = spawnSync(process.execPath, [helper], {
    encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 64 * 1024,
    env: runtimeEnv, stdio: ['ignore', 'pipe', 'ignore'],
  });
  assert.equal(composed.error, undefined, 'DATABASE_URL composition failed');
  assert.equal(composed.status, 0, 'DATABASE_URL composition failed');
  assert.match(composed.stdout ?? '', /^postgresql:\/\//u);
  runtimeEnv.DATABASE_URL = composed.stdout;
  // Never print/log the composed URL or any DB secret.

  const cli = '/app/apps/api/scripts/meri-controlled-read-setup.mjs';
  const child = spawnSync(process.execPath, [cli, mode, '--input', ownerInputPath, '--out', outPath], {
    encoding: 'utf8', maxBuffer: 2 * 1024 * 1024,
    timeout: 6 * 60 * 1000, windowsHide: true, env: runtimeEnv,
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  let bytes;
  try { bytes = await readFile(outPath); } catch { bytes = null; }
  if (!bytes || bytes.length === 0 || bytes.length > 1024 * 1024) {
    emit({ phase: 'FAILURE', version: 1, mode, sourceSha: SOURCE,
      inputSha256: INPUT_SHA256, scriptSha256: process.env.C2_CASE20_INNER_SHA256 ?? null,
      captureRunId: RUN, outputPath: outPath,
      childExitCode: Number.isInteger(child.status) ? child.status : null,
      childSignal: child.signal ?? null, code: 'NATIVE_CLI_RECEIPT_MISSING',
      automaticRetryAllowed: false });
    process.exitCode = 1;
    return;
  }

  let owner = null;
  let valid = false;
  try {
    owner = parseOwner(bytes);
    if (child.status === 0) {
      if (mode === 'plan') {
        assert.equal(owner.kind, 'meri-controlled-read-setup-plan');
        assert.equal(owner.version, 1);
        assert.equal(owner.tenantId, input.ctx.tenantId);
        assert.equal(owner.actorUserId, input.ctx.userId);
        assert.equal(owner.clientId, input.clientId);
        assert.equal(owner.caseId, input.caseId);
        assert.equal(owner.captureRunId, input.captureRunId);
        assert.equal(owner.liveAcceptance, 'NOT_RUN');
        assert.equal(owner.liveAcceptance, 'NOT_RUN');
      } else {
        assert.equal(owner.liveAcceptance, 'NOT_RUN');
        assert.equal(owner.status, 'CONTROLLED_READ_BOUND');
      }
      valid = true;
    } else {
      assert.equal(owner.status, 'RECONCILIATION_REQUIRED');
      assert.equal(owner.liveAcceptance, 'NOT_RUN');
      valid = true;
    }
  } catch { valid = false; }

  const encoded = bytes.toString('base64');
  const chunks = Math.ceil(encoded.length / 8192);
  const meta = {
    version: 1, kind: 'case20-native-setup-json', mode,
    sourceSha: SOURCE, inputSha256: INPUT_SHA256,
    scriptSha256: process.env.C2_CASE20_INNER_SHA256 ?? null,
    captureRunId: RUN, outputPath: outPath,
    byteLength: bytes.length, base64Length: encoded.length, chunks,
    sha256: hash(bytes), childExitCode: Number.isInteger(child.status) ? child.status : null,
    childSignal: child.signal ?? null,
    ownerOutput: valid ? (child.status === 0 ? 'OWNER_SUCCESS' : 'OWNER_FAILURE') : 'INVALID_OR_UNCLASSIFIED',
  };
  emit({ phase: 'BEGIN', ...meta });
  for (let index = 0; index < chunks; index++) {
    emit({ phase: 'CHUNK', sha256: meta.sha256, index: index + 1,
      data: encoded.slice(index * 8192, (index + 1) * 8192) });
  }
  emit({ phase: 'END', ...meta });
  if (!valid || child.status !== 0) process.exitCode = 1;
}

main().catch((error) => {
  const code = SAFE_CODE.test(error?.code ?? '') ? error.code :
    (SAFE_CODE.test(error?.message ?? '') ? error.message : 'NATIVE_ADAPTER_GUARD_FAILED');
  emit({ phase: 'FAILURE', version: 1, mode: process.argv[2] ?? null,
    sourceSha: SOURCE, inputSha256: INPUT_SHA256,
    scriptSha256: process.env.C2_CASE20_INNER_SHA256 ?? null,
    captureRunId: RUN, outputPath: `/dev/shm/case20-native-setup-${process.argv[2] ?? 'unknown'}-owner.json`,
    childExitCode: null, childSignal: null, code, automaticRetryAllowed: false });
  process.exitCode = 1;
});

export { exactKeys };
