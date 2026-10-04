#!/usr/bin/env node
// Bounded JSON transport for the packaged provider-budget owner. No owner/SQL
// logic is implemented here; exact owner output bytes are framed for collection.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const SOURCE = '4f0253874357c272fda1ae2a5271ee4af645f0bc';
const INPUT_SHA256 = 'a72c2d69bebb9694edb38bc4131a60a093e6488f8cd3528fafd92db7f84a082d';
const RUN = 'f4bb30bb-ebb4-4fba-89a9-d49aeafefd1b';
const PREFIX = 'C2_CASE20_NATIVE_BUDGET_RECEIPT ';
const FIXTURE_NAMESPACE = 'meri-foundation-20260928';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const emit = (value) => process.stdout.write(PREFIX + JSON.stringify(value) + '\n');
const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_CODE = /^[A-Z0-9_]{1,80}$/u;
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).sort().join('|') === [...keys].sort().join('|');
const PLAN_KEYS = ['target', 'fixtureNamespace', 'ctx', 'clientId'];
const INSTALL_KEYS = [...PLAN_KEYS, 'qualification', 'rateEvidence', 'expectedCurrentVerifySha256',
  'expectedCaptureBindingSha256', 'expectedPriorQualificationSha256', 'expectedTenantRowVersion'];
const QUALIFICATION_KEYS = ['version', 'caseId', 'captureRunId', 'currentVerifySha256',
  'rateEvidenceSha256', 'rateEvidenceExpiresAt', 'priceKind', 'maxAttempts', 'maxTokens',
  'maxCostMicros', 'rates'];
const EVIDENCE_KEYS = ['kind', 'version', 'priceKind', 'observedAt', 'expiresAt', 'maxTokens', 'rates', 'sources'];
const RATE_KEYS = ['kind', 'provider', 'model', 'inputMicrosPerMillion', 'outputMicrosPerMillion'];
const SOURCE_KEYS = ['kind', 'provider', 'model', 'url', 'unitContract'];
const BASE_KEYS = ['target', 'fixtureNamespace', 'caseId', 'captureRunId', 'ctx', 'clientId'];
const CTX_KEYS = ['tenantId', 'tenantSlug', 'userId', 'clerkUserId', 'role'];
const PLAN_RESULT_KEYS = ['status', 'caseId', 'captureRunId', 'currentVerifySha256',
  'captureBindingSha256', 'priorQualificationSha256', 'tenantRowVersion', 'liveAcceptance'];
const INSTALL_RESULT_KEYS = ['status', 'tenantId', 'clientId', 'captureRunId', 'currentVerifySha256',
  'captureBindingSha256', 'qualificationSha256', 'priorQualificationSha256', 'tenantRowVersion',
  'maxCostMicros', 'rateEvidenceSha256', 'rateEvidenceExpiresAt', 'liveAcceptance'];

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}
const stableHash = (value) => hash(Buffer.from(JSON.stringify(stable(value)), 'utf8'));
function validateBase(input) {
  assert.equal(input.target, 'capiro-dev');
  assert.equal(input.fixtureNamespace, FIXTURE_NAMESPACE);
  assert.equal(input.caseId, '20');
  assert.equal(input.captureRunId, RUN);
  assert.equal(input.ctx?.tenantSlug, 'meri-foundation-20260928-t1');
  assert.equal(input.ctx?.role, 'standard_user');
  assert.ok(exactKeys(input, BASE_KEYS), 'BASE_INPUT_KEYS_INVALID');
  assert.ok(exactKeys(input.ctx, CTX_KEYS), 'BASE_CONTEXT_KEYS_INVALID');
  assert.ok(typeof input.ctx.tenantId === 'string' && input.ctx.tenantId.length > 0);
  assert.ok(typeof input.ctx.userId === 'string' && input.ctx.userId.length > 0);
  assert.ok(typeof input.ctx.clerkUserId === 'string' && input.ctx.clerkUserId.length > 0);
  assert.ok(typeof input.clientId === 'string' && input.clientId.length > 0);
  assert.equal(process.env.RELEASE_SHA, SOURCE);
  assert.equal(process.env.GIT_SHA, SOURCE);
  assert.equal(process.env.MERI_SYNTHETIC_FIXTURE_NAMESPACE, FIXTURE_NAMESPACE);
  assert.equal(process.env.AWS_REGION_DEFAULT, 'us-east-1');
  assert.equal(process.env.DB_NAME, 'capiro');
  assert.equal(process.env.PGSSLMODE, 'require');
}
function parseObject(bytes, label) {
  const text = bytes.toString('utf8');
  assert.ok(Buffer.from(text, 'utf8').equals(bytes), `${label}_UTF8_INVALID`);
  const value = JSON.parse(text);
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${label}_OBJECT_REQUIRED`);
  return value;
}
function validateOwnerInput(owner, input, mode) {
  assert.ok(exactKeys(owner, mode === 'plan' ? PLAN_KEYS : INSTALL_KEYS), 'OWNER_INPUT_KEYS_INVALID');
  assert.equal(owner.target, input.target);
  assert.equal(owner.fixtureNamespace, input.fixtureNamespace);
  assert.deepEqual(owner.ctx, input.ctx);
  assert.equal(owner.clientId, input.clientId);
  if (mode === 'plan') return;

  const q = owner.qualification;
  const evidence = owner.rateEvidence;
  assert.ok(exactKeys(q, QUALIFICATION_KEYS), 'QUALIFICATION_KEYS_INVALID');
  assert.ok(exactKeys(evidence, EVIDENCE_KEYS), 'RATE_EVIDENCE_KEYS_INVALID');
  assert.equal(q.version, 1);
  assert.equal(q.caseId, input.caseId);
  assert.equal(q.captureRunId, input.captureRunId);
  assert.ok(SHA256.test(q.currentVerifySha256));
  assert.equal(q.currentVerifySha256, owner.expectedCurrentVerifySha256);
  assert.equal(q.priceKind, 'qualified_text_token_upper_bound');
  assert.equal(q.maxAttempts, 32);
  assert.equal(q.maxTokens, 500000);
  assert.equal(q.maxCostMicros, 15000000);
  assert.ok(SHA256.test(q.rateEvidenceSha256));
  assert.ok(SHA256.test(owner.expectedCurrentVerifySha256));
  assert.equal(q.currentVerifySha256, owner.expectedCurrentVerifySha256);
  assert.ok(SHA256.test(owner.expectedCaptureBindingSha256));
  assert.ok(SHA256.test(owner.expectedPriorQualificationSha256));
  assert.match(owner.expectedTenantRowVersion, /^\d+$/u);
  assert.equal(evidence.kind, 'meri-capture-reviewed-provider-rates');
  assert.equal(evidence.version, 1);
  assert.equal(evidence.priceKind, 'qualified_text_token_upper_bound');
  assert.equal(evidence.maxTokens, 500000);
  assert.deepEqual(evidence.rates, [
    { kind: 'openai_responses', provider: 'openai', model: 'gpt-6-astra', inputMicrosPerMillion: 25000000, outputMicrosPerMillion: 75000000 },
    { kind: 'bedrock_embeddings', provider: 'aws-bedrock', model: 'amazon.titan-embed-text-v2:0', inputMicrosPerMillion: 20000, outputMicrosPerMillion: 0 },
  ], 'EXACT_REVIEWED_RATES_REQUIRED');
  assert.ok(Array.isArray(evidence.sources) && evidence.sources.length > 0);
  assert.ok(q.rates.length === 2, 'TWO_REVIEWED_RATES_REQUIRED');
  assert.deepEqual(q.rates, evidence.rates, 'QUALIFICATION_RATES_DIFFER_FROM_EVIDENCE');
  assert.equal(q.rateEvidenceSha256, stableHash(evidence), 'RATE_EVIDENCE_HASH_MISMATCH');
  assert.ok(evidence.rates.every((rate) => exactKeys(rate, RATE_KEYS) &&
    typeof rate.kind === 'string' && typeof rate.provider === 'string' && typeof rate.model === 'string' &&
    Number.isSafeInteger(rate.inputMicrosPerMillion) && Number.isSafeInteger(rate.outputMicrosPerMillion)), 'RATE_SHAPE_INVALID');
  assert.ok(evidence.sources.every((source) => exactKeys(source, SOURCE_KEYS)), 'RATE_SOURCE_KEYS_INVALID');
  const identities = evidence.rates.map((rate) => `${rate.kind}:${rate.provider}:${rate.model}`);
  assert.equal(new Set(identities).size, 2, 'RATE_IDENTITIES_NOT_UNIQUE');
  for (const rate of evidence.rates)
    assert.ok(evidence.sources.some((source) => source.kind === rate.kind &&
      source.provider === rate.provider && source.model === rate.model), 'RATE_SOURCE_MISSING');
  const now = Date.now();
  const observed = Date.parse(evidence.observedAt);
  const expires = Date.parse(evidence.expiresAt);
  assert.ok(Number.isFinite(observed) && observed <= now, 'RATE_EVIDENCE_NOT_YET_OBSERVED');
  assert.ok(Number.isFinite(expires) && expires > now + 900000, 'RATE_EVIDENCE_EXPIRY_TOO_SOON');
  assert.equal(q.rateEvidenceExpiresAt, evidence.expiresAt, 'RATE_EVIDENCE_EXPIRY_MISMATCH');
  assert.equal(owner.expectedCurrentVerifySha256, q.currentVerifySha256);
}
function validateSuccess(owner, mode, input, ownerInput) {
  assert.equal(owner.liveAcceptance, 'NOT_RUN');
  assert.equal(owner.captureRunId, input.captureRunId);
  if (mode === 'plan') {
    assert.equal(owner.caseId, input.caseId);
    assert.ok(exactKeys(owner, PLAN_RESULT_KEYS), 'PLAN_RESULT_KEYS_INVALID');
    assert.equal(owner.status, 'READY_FOR_RATE_QUALIFICATION');
    assert.ok(SHA256.test(owner.currentVerifySha256));
    assert.ok(SHA256.test(owner.captureBindingSha256));
    assert.ok(SHA256.test(owner.priorQualificationSha256));
    assert.match(owner.tenantRowVersion, /^\d+$/u);
  } else {
    const q = ownerInput.qualification;
    assert.ok(exactKeys(owner, INSTALL_RESULT_KEYS), 'INSTALL_RESULT_KEYS_INVALID');
    assert.equal(owner.status, 'PROVIDER_QUALIFICATION_INSTALLED');
    assert.equal(owner.tenantId, input.ctx.tenantId);
    assert.equal(owner.clientId, input.clientId);
    assert.equal(owner.currentVerifySha256, q.currentVerifySha256);
    assert.equal(owner.captureBindingSha256, ownerInput.expectedCaptureBindingSha256);
    assert.equal(owner.priorQualificationSha256, ownerInput.expectedPriorQualificationSha256);
    assert.equal(owner.maxCostMicros, 15000000);
    assert.equal(owner.qualificationSha256, stableHash(q));
    assert.equal(owner.rateEvidenceSha256, q.rateEvidenceSha256);
    assert.equal(owner.rateEvidenceExpiresAt, q.rateEvidenceExpiresAt);
    assert.match(owner.tenantRowVersion, /^\d+$/u);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const mode = args.shift();
  assert.ok(mode === 'plan' || mode === 'install', 'MODE_INVALID');
  assert.equal(args.shift(), '--input');
  const inputPath = args.shift();
  assert.equal(args.shift(), '--owner-input');
  const ownerInputPath = args.shift();
  assert.equal(args.shift(), '--out');
  const outPath = args.shift();
  assert.equal(args.length, 0, 'ARGUMENTS_INVALID');
  assert.equal(inputPath, `/dev/shm/case20-native-budget-${mode}-input.json`);
  assert.equal(ownerInputPath, `/dev/shm/case20-native-budget-${mode}-owner-input.json`);
  assert.equal(outPath, `/dev/shm/case20-native-budget-${mode}-owner.json`);

  const inputBytes = await readFile(inputPath);
  assert.equal(hash(inputBytes), INPUT_SHA256, 'BASE_INPUT_HASH_MISMATCH');
  const input = parseObject(inputBytes, 'BASE_INPUT');
  validateBase(input);
  const ownerInputBytes = await readFile(ownerInputPath);
  assert.ok(ownerInputBytes.length > 0 && ownerInputBytes.length <= 256 * 1024, 'OWNER_INPUT_SIZE_INVALID');
  const expectedOwnerSha = process.env.C2_CASE20_OWNER_INPUT_SHA256;
  assert.match(expectedOwnerSha ?? '', /^[a-f0-9]{64}$/u, 'OWNER_INPUT_HASH_ENV_INVALID');
  assert.equal(hash(ownerInputBytes), expectedOwnerSha, 'OWNER_INPUT_HASH_MISMATCH');
  const ownerInput = parseObject(ownerInputBytes, 'OWNER_INPUT');
  validateOwnerInput(ownerInput, input, mode);

  // Only the four DB secret values are forwarded to the image-owned composer.
  const runtimeEnv = {};
  for (const name of ['PATH', 'TMPDIR', 'DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD',
    'DB_NAME', 'PGSSLMODE', 'AWS_REGION_DEFAULT', 'MERI_SYNTHETIC_FIXTURE_NAMESPACE',
    'RELEASE_SHA', 'GIT_SHA', 'C2_CASE20_INNER_SHA256', 'C2_CASE20_OWNER_INPUT_SHA256']) {
    if (process.env[name] !== undefined) runtimeEnv[name] = process.env[name];
  }
  const helper = '/app/apps/api/scripts/lib/pe-compose-database-url.js';
  const composed = spawnSync(process.execPath, [helper], {
    encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 64 * 1024,
    env: runtimeEnv, stdio: ['ignore', 'pipe', 'ignore'],
  });
  assert.equal(composed.error, undefined, 'DATABASE_URL_COMPOSITION_FAILED');
  assert.equal(composed.status, 0, 'DATABASE_URL_COMPOSITION_FAILED');
  assert.match(composed.stdout ?? '', /^postgresql:\/\//u, 'DATABASE_URL_INVALID');
  runtimeEnv.DATABASE_URL = composed.stdout;

  const cli = '/app/apps/api/scripts/meri-capture-provider-budget.mjs';
  const child = spawnSync(process.execPath, [cli, mode, '--input', ownerInputPath, '--out', outPath], {
    encoding: 'utf8', maxBuffer: 2 * 1024 * 1024, timeout: 6 * 60 * 1000,
    windowsHide: true, env: runtimeEnv, stdio: ['ignore', 'ignore', 'ignore'],
  });
  let bytes = null;
  try { bytes = await readFile(outPath); } catch {}
  if (!bytes || bytes.length === 0 || bytes.length > 1024 * 1024) {
    emit({ phase: 'FAILURE', version: 1, mode, sourceSha: SOURCE, inputSha256: INPUT_SHA256,
      scriptSha256: process.env.C2_CASE20_INNER_SHA256 ?? null,
      ownerInputSha256: expectedOwnerSha, captureRunId: RUN, outputPath: outPath,
      childExitCode: Number.isInteger(child.status) ? child.status : null,
      childSignal: child.signal ?? null, code: 'NATIVE_CLI_RECEIPT_MISSING', automaticRetryAllowed: false });
    process.exitCode = 1;
    return;
  }

  let owner = null;
  let valid = false;
  try {
    owner = parseObject(bytes, 'OWNER_RECEIPT');
    if (child.status === 0) validateSuccess(owner, mode, input, ownerInput);
    else {
      assert.equal(owner.status, 'FAILED', 'OWNER_FAILURE_STATUS_INVALID');
      assert.equal(owner.liveAcceptance, 'NOT_RUN');
      assert.ok(exactKeys(owner, ['status', 'code', 'liveAcceptance']), 'OWNER_FAILURE_KEYS_INVALID');
    }
    valid = true;
  } catch { valid = false; }

  const encoded = bytes.toString('base64');
  const chunks = Math.ceil(encoded.length / 8192);
  const meta = {
    version: 1, kind: 'case20-native-budget-json', mode,
    sourceSha: SOURCE, inputSha256: INPUT_SHA256,
    scriptSha256: process.env.C2_CASE20_INNER_SHA256 ?? null,
    ownerInputSha256: expectedOwnerSha, captureRunId: RUN, outputPath: outPath,
    byteLength: bytes.length, base64Length: encoded.length, chunks,
    sha256: hash(bytes), childExitCode: Number.isInteger(child.status) ? child.status : null,
    childSignal: child.signal ?? null,
    ownerOutput: valid ? (child.status === 0 ? 'OWNER_SUCCESS' : 'OWNER_FAILURE') : 'INVALID_OR_UNCLASSIFIED',
  };
  emit({ phase: 'BEGIN', ...meta });
  for (let index = 0; index < chunks; index++)
    emit({ phase: 'CHUNK', sha256: meta.sha256, index: index + 1,
      data: encoded.slice(index * 8192, (index + 1) * 8192) });
  emit({ phase: 'END', ...meta });
  if (!valid || child.status !== 0) process.exitCode = 1;
}

main().catch((error) => {
  const code = SAFE_CODE.test(error?.code ?? '') ? error.code :
    (SAFE_CODE.test(error?.message ?? '') ? error.message : 'NATIVE_ADAPTER_GUARD_FAILED');
  emit({ phase: 'FAILURE', version: 1, mode: process.argv[2] ?? null,
    sourceSha: SOURCE, inputSha256: INPUT_SHA256,
    scriptSha256: process.env.C2_CASE20_INNER_SHA256 ?? null,
    ownerInputSha256: process.env.C2_CASE20_OWNER_INPUT_SHA256 ?? null,
    captureRunId: RUN, outputPath: `/dev/shm/case20-native-budget-${process.argv[2] ?? 'unknown'}-owner.json`,
    childExitCode: null, childSignal: null, code, automaticRetryAllowed: false });
  process.exitCode = 1;
});

export { exactKeys };
