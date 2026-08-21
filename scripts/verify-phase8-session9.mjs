#!/usr/bin/env node
/**
 * Phase 8 Session 9 — cross-domain provider runtime static gate.
 *
 * Asserts the structural guarantees a reviewer cannot check by reading: that the
 * session is dark by default, that a provider cannot appear by accident, that a
 * degraded read path can never throw, that the audit row cannot carry a secret or
 * a dollar, that the Session 3 credential boundary is intact, and that the one
 * additive main-API route is internal-only.
 *
 * Prohibition checks strip comments first. Session 7's closeout hit exactly this:
 * five checks failed on the prose asserting the very thing they check, and this
 * session's files necessarily NAME the credential classes they forbid.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

function resolveRepoRoot(start = process.cwd()) {
  let current = start;
  for (let depth = 0; depth < 8; depth += 1) {
    if (fs.existsSync(path.join(current, 'pnpm-workspace.yaml'))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

const root = resolveRepoRoot();
const failures = [];
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const exists = (relative) => fs.existsSync(path.join(root, relative));
const fail = (message) => failures.push(message);

const stripComments = (content) =>
  content
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => line.replace(/(^|\s)\/\/.*$/, '$1'))
    .join('\n');

/**
 * SQL comments are `--`, not `//`, and this session's migration necessarily
 * spells out the privileges it does NOT grant. Session 7's closeout hit the same
 * class of bug in TypeScript; stripping only `//` here would have reproduced it
 * verbatim in a different comment syntax.
 */
const stripSqlComments = (content) =>
  content
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');

const requireTokens = (relative, tokens, label) => {
  if (!exists(relative)) {
    fail(`Missing ${label}: ${relative}`);
    return null;
  }
  const content = read(relative);
  for (const token of tokens) {
    if (!content.includes(token)) fail(`${label} is missing required token: ${token}`);
  }
  return content;
};

const MIGRATION =
  'apps/api/prisma/migrations/20261204120000_phase8_session9_provider_invocation_audit/migration.sql';
const TABLE = 'defense_provider_invocation';

// ── 1. Migration: append-only, no money, coherent outcomes ─────────────────
const migration = requireTokens(
  MIGRATION,
  [
    TABLE,
    'dpi_failure_class_chk',
    'dpi_success_has_result_chk',
    'dpi_degraded_no_dimension_chk',
    'dpi_model_only_for_embedding_chk',
    'dpi_count_only_for_relevance_chk',
    'payload_sha256',
    'idempotency_key',
    'capiro_defense_serve',
    'capiro_defense_job',
    'REVOKE ALL',
  ],
  'Session 9 migration',
);

if (migration) {
  const sql = stripSqlComments(migration);

  // Provider cost is not a funding fact. Sessions 7 and 8 asserted no dollars.
  if (
    /"[a-z_]*(amount|usd|dollar|cost|price|spend|obligat|outlay)[a-z_]*"\s+(NUMERIC|DECIMAL|MONEY|BIGINT|INTEGER)/i.test(
      sql,
    )
  ) {
    fail('Session 9 migration declares a monetary/cost column; provider spend is not a funding fact');
  }

  // No column may hold credential material or the payload in the clear.
  if (/"[a-z_]*(secret|token|credential|password|api_?key|authorization|signature)[a-z_]*"/i.test(sql)) {
    fail('Session 9 migration declares a column that could hold credential material');
  }
  if (/"(query|query_text|pe_codes|embedding|vector)"/i.test(sql)) {
    fail('Session 9 migration declares a column holding raw payload or vector data');
  }

  // Append-only. `ON DELETE` clauses are referential integrity, not privileges.
  const withoutFk = sql.replace(/ON\s+DELETE\s+(RESTRICT|CASCADE|SET\s+NULL|NO\s+ACTION)/gi, ' ');
  if (/\bDELETE\s+FROM\b/i.test(withoutFk)) {
    fail('Session 9 migration performs a DELETE; the invocation audit must be append-only');
  }
  if (/GRANT[^;]*\bDELETE\b/i.test(withoutFk)) {
    fail('Session 9 migration grants DELETE; the invocation audit must be append-only');
  }
  if (/GRANT[^;]*\bUPDATE\b/i.test(withoutFk)) {
    fail('Session 9 migration grants UPDATE; an audit row must not be rewritable');
  }

  // The serve grant is the narrow, deliberate addition. It must be exactly
  // SELECT+INSERT on exactly this table.
  if (!new RegExp(`GRANT SELECT, INSERT ON TABLE "${TABLE}" TO "capiro_defense_serve"`).test(sql)) {
    fail('the serve role does not have exactly SELECT+INSERT on the invocation audit table');
  }

  // Nothing about promotion, snapshots or PE-year rows.
  if (/program_element_year|defense_budget_active_snapshot|promote/i.test(sql)) {
    fail('Session 9 migration touches PE-year rows, snapshot activation or promotion');
  }
}

// ── 2. Prisma model mirrors the table ──────────────────────────────────────
const schema = read('apps/api/prisma/schema.prisma');
if (!/model\s+DefenseProviderInvocation\s*\{/.test(schema)) {
  fail('Authoritative Prisma schema is missing model DefenseProviderInvocation');
}
if (!schema.includes(`@@map("${TABLE}")`)) {
  fail(`Authoritative Prisma schema does not map ${TABLE}`);
}
const modelBlock = /model\s+DefenseProviderInvocation\s*\{([\s\S]*?)\n\}/.exec(schema)?.[1] ?? '';
// Session 7 trap: @default(uuid()) drifts against gen_random_uuid().
if (/@default\(uuid\(\)\)/.test(modelBlock)) {
  fail('DefenseProviderInvocation uses @default(uuid()); this drifts against gen_random_uuid()');
}
if (!/dbgenerated\("gen_random_uuid\(\)"\)/.test(modelBlock)) {
  fail('DefenseProviderInvocation id does not use dbgenerated("gen_random_uuid()")');
}
if (/(amount|usd|dollar|cost|secret|token|credential|vector|queryText)/i.test(modelBlock)) {
  fail('DefenseProviderInvocation declares a monetary or credential-shaped field');
}

// ── 3. Domain: fail-closed selection, deterministic retry, leak guard ──────
const selection = requireTokens(
  'packages/defense-domain/src/cross-domain/provider-selection.ts',
  [
    'export function selectEmbeddingProvider',
    'export function selectClientRelevanceProvider',
    'export function selectCrossDomainProviders',
    'export function assertNoForbiddenProviderConfig',
    'DEFENSE_EMBEDDING_PROVIDER',
    'DEFENSE_CLIENT_RELEVANCE_PROVIDER',
    'PROVIDER_LIMITS',
  ],
  'Session 9 provider selection',
);
if (selection) {
  const code = stripComments(selection);
  // The explicit switch is what stops a stray credential turning a dark
  // deployment live.
  if (!/requested === '' \|\| requested === 'dark' \|\| requested === 'none'/.test(code)) {
    fail('provider selection does not default to dark on an absent switch');
  }
  // Plaintext service-to-service traffic must be impossible.
  if (!/parsed\.protocol !== 'https:'/.test(code)) {
    fail('provider selection does not require https for the main-API base URL');
  }
  // The Session 3 forbidden credential classes must all still be named.
  for (const pattern of [
    'DEFENSE_PROMOTER_',
    'DEFENSE_SNAPSHOT_ACTIVATION_',
    'NVIDIA_',
    'SAGEMAKER_MODEL_ADMIN_',
    'DEFENSE_PARSER_MODEL_',
  ]) {
    if (!code.includes(pattern)) {
      fail(`provider selection no longer forbids the ${pattern} credential class`);
    }
  }
  // A selection must never carry the secret itself.
  if (/resolved:[\s\S]{0,400}SECRET/.test(code)) {
    fail('a provider selection appears to carry secret material in its resolved config');
  }
}

const retry = requireTokens(
  'packages/defense-domain/src/cross-domain/provider-retry.ts',
  [
    'export function classifyHttpStatus',
    'export function isRetryableFailure',
    'export function nextRetryDecision',
    'export function providerIdempotencyKey',
    'export class ProviderConcurrencyGate',
    'totalBudgetMs',
  ],
  'Session 9 retry policy',
);
if (retry) {
  const code = stripComments(retry);
  // Determinism: a replay has to reproduce the schedule.
  if (/Math\.random/.test(code)) {
    fail('retry backoff uses randomness; it must be deterministic for replay');
  }
  // An auth failure must be terminal.
  if (/RETRYABLE[\s\S]{0,220}'unauthorized'/.test(code)) {
    fail('unauthorized is listed as retryable; hammering an auth failure is an incident');
  }
  // The tenant must be part of the idempotency key.
  if (!/tenantId: input\.tenantId/.test(code)) {
    fail('the idempotency key does not include the tenant, so tenants could share a result');
  }
}

const audit = requireTokens(
  'packages/defense-domain/src/cross-domain/provider-audit.ts',
  [
    'export function buildProviderAudit',
    'export function assertProviderAuditCarriesNoSecrets',
    'ProviderAuditLeakError',
    'payloadSha256',
  ],
  'Session 9 audit records',
);
if (audit) {
  const code = stripComments(audit);
  for (const token of ['secret', 'token', 'credential', 'vector', 'amount']) {
    if (!code.includes(token)) {
      fail(`the audit leak guard no longer forbids "${token}"`);
    }
  }
  if (!/buildProviderAudit[\s\S]{0,3000}assertProviderAuditCarriesNoSecrets\(record\)/.test(code)) {
    fail('buildProviderAudit does not run the leak guard, so an unchecked row could be produced');
  }
}

const domainIndex = read('packages/defense-domain/src/index.ts');
if (!domainIndex.includes("export * from './cross-domain/index.js';")) {
  fail('the Session 9 cross-domain domain is not exported from the package barrel');
}

// ── 4. defense-api: dark by default, degrade never throw, no new route ─────
const S9_FILES = [
  'apps/defense-api/src/program-elements/cross-domain/provider-runtime.ports.ts',
  'apps/defense-api/src/program-elements/cross-domain/provider-invocation.runner.ts',
  'apps/defense-api/src/program-elements/cross-domain/provider-runtime.factory.ts',
  'apps/defense-api/src/program-elements/cross-domain/bedrock-embedding.adapter.ts',
  'apps/defense-api/src/program-elements/cross-domain/internal-service-client-relevance.adapter.ts',
  'apps/defense-api/src/program-elements/cross-domain/https-provider-http.adapter.ts',
  'apps/defense-api/src/program-elements/cross-domain/prisma-provider-audit.sink.ts',
];

for (const file of S9_FILES) {
  if (!exists(file)) {
    fail(`Missing Session 9 service file: ${file}`);
    continue;
  }
  const content = stripComments(read(file));
  // Session 9 adds no route to the frozen defense-api surface.
  if (/@Controller|@Get\(|@Post\(|@Put\(|@Patch\(|@Delete\(/.test(content)) {
    fail(`${file} declares an HTTP route; the Session 3 surface stays frozen at 49`);
  }
  if (/@Cron\(|CronExpression|ScheduleModule|EventBridge/.test(content)) {
    fail(`${file} declares a schedule; production schedule ownership is Session 10`);
  }
  if (/promote|activateSnapshot|DefenseBudgetPromotion/.test(content)) {
    fail(`${file} references snapshot promotion/activation`);
  }
  // Session 3's boundary forbids defense-api from naming a GPU provider.
  if (/sagemaker|nvidia|nemotron|cuda|gpu_?instance/i.test(content)) {
    fail(`${file} references NVIDIA/SageMaker/GPU execution`);
  }
  if (/from '\.\.\/\.\.\/\.\.\/api\/|@capiro\/api/.test(content)) {
    fail(`${file} imports executable source from apps/api`);
  }
  // A credential must never be logged.
  if (/logger\.[a-z]+\([^)]*(secret|credential|apiKey|token)/i.test(content)) {
    fail(`${file} appears to log credential material`);
  }
}

const runner = read('apps/defense-api/src/program-elements/cross-domain/provider-invocation.runner.ts');
for (const token of [
  'recordNonInvocation',
  'degraded_concurrency',
  'degraded_failed',
  'malformed_response',
  'buildProviderAudit',
  'nextRetryDecision',
  'gate.release()',
]) {
  if (!runner.includes(token)) fail(`the invocation runner is missing required token: ${token}`);
}
// The audit write must not be able to fail the read path.
if (!/private async persist[\s\S]{0,900}catch/.test(runner)) {
  fail('the runner does not guard the audit write, so a failed insert could 500 a read route');
}
// Concurrency must be refused, not queued.
if (!/tryAcquire\(\)/.test(runner)) {
  fail('the runner does not refuse on concurrency; queueing on a read path is not acceptable');
}

const factory = read('apps/defense-api/src/program-elements/cross-domain/provider-runtime.factory.ts');
for (const token of [
  'assertNoForbiddenProviderConfig',
  'selectCrossDomainProviders',
  'UnconfiguredEmbeddingPort',
  'UnconfiguredClientRelevancePort',
  'BOUND_CROSS_DOMAIN_PROVIDERS',
]) {
  if (!factory.includes(token)) fail(`the provider factory is missing required token: ${token}`);
}
// A construction failure must degrade, not propagate.
if ((factory.match(/return new UnconfiguredEmbeddingPort\(\)/g) ?? []).length < 2) {
  fail('the embedding factory does not fall back to dark on a construction failure');
}
if ((factory.match(/return new UnconfiguredClientRelevancePort\(\)/g) ?? []).length < 2) {
  fail('the relevance factory does not fall back to dark on a construction failure');
}

const httpAdapter = read('apps/defense-api/src/program-elements/cross-domain/https-provider-http.adapter.ts');
// Session 8's redirect rule, which matters more here because these carry a credential.
if (!httpAdapter.includes("redirect: 'manual'")) {
  fail('the provider transport follows redirects automatically; a credential could leave the origin');
}
if (!/protocol !== 'https:'/.test(httpAdapter)) {
  fail('the provider transport does not refuse plaintext, so a credential could travel in the clear');
}

const sink = read('apps/defense-api/src/program-elements/cross-domain/prisma-provider-audit.sink.ts');
// Sessions 6/7/8 regression: $queryRawUnsafe does not know column types.
for (const cast of ['::int', '::timestamptz']) {
  if (!sink.includes(cast)) fail(`the audit sink is missing an expected SQL cast: ${cast}`);
}
if (!/assertProviderAuditCarriesNoSecrets/.test(sink)) {
  fail('the audit sink does not re-run the leak guard before persisting');
}
if (/DELETE FROM defense_provider_invocation|UPDATE defense_provider_invocation/i.test(sink)) {
  fail('the audit sink mutates or deletes invocation history');
}

// ── 5. The ports stay frozen and dark-by-default in the module ─────────────
const contracts = read('packages/defense-contracts/src/internal/cross-domain.ts');
for (const token of [
  'export interface ClientRelevancePort',
  'export interface EmbeddingPort',
  "export const CLIENT_RELEVANCE_PORT = 'defense.port.clientRelevance'",
  "export const EMBEDDING_PORT = 'defense.port.embedding'",
]) {
  if (!contracts.includes(token)) {
    fail(`the frozen cross-domain port contract changed; missing: ${token}`);
  }
}

const module_ = requireTokens(
  'apps/defense-api/src/program-elements/program-elements.module.ts',
  [
    'CLIENT_RELEVANCE_PORT',
    'EMBEDDING_PORT',
    'bindCrossDomainProviders',
    'BOUND_CROSS_DOMAIN_PROVIDERS',
    'UnconfiguredClientRelevancePort',
    'UnconfiguredEmbeddingPort',
  ],
  'Session 9 module wiring',
);
if (module_) {
  const code = stripComments(module_);
  // Bound ONCE, so both ports share one concurrency-gate map.
  if ((code.match(/bindCrossDomainProviders\(/g) ?? []).length !== 1) {
    fail('providers are bound more than once, which would double the effective concurrency cap');
  }
  if (!/controllers: \[ProgramElementController, BudgetLinesController, ProgramsController\]/.test(code)) {
    fail('the Session 3 controller set changed; the 49-route surface must stay frozen');
  }
  if (/@Cron|ScheduleModule|EventBridge/.test(code)) {
    fail('the module registers a schedule; production schedule ownership is Session 10');
  }
}

// The dark implementations must survive: they are the fallback and the default.
const darkPorts = read('apps/defense-api/src/program-elements/cross-domain/ports.ts');
for (const token of ['UnconfiguredClientRelevancePort', 'UnconfiguredEmbeddingPort']) {
  if (!darkPorts.includes(token)) {
    fail(`the dark-posture implementation ${token} was removed; it is the default and the fallback`);
  }
}

// ── 6. The one additive main-API route is internal-only ────────────────────
const internalController = requireTokens(
  'apps/api/src/intelligence/internal-pe-relevance.controller.ts',
  [
    "@Controller('internal/program-elements/relevance')",
    '@UseGuards(InternalServiceGuard)',
    'getRelevantClientsForPeByTenantId',
    'MAX_BATCH',
  ],
  'Session 9 internal relevance controller',
);
if (internalController) {
  const code = stripComments(internalController);
  // Read-only: no write verb, no mutation.
  if (/@Put\(|@Patch\(|@Delete\(/.test(code)) {
    fail('the internal relevance route declares a mutating verb; it must be read-only');
  }
  // PE codes only: client identities must not cross into a dark service.
  if (/clientName|clientId/.test(code)) {
    fail('the internal relevance route returns client identities; it must return PE codes only');
  }
  // A batch must be refused rather than silently trimmed.
  if (!/exceeds the maximum batch/.test(code)) {
    fail('the internal relevance route silently truncates a batch instead of refusing it');
  }
}

const intelligenceModule = read('apps/api/src/intelligence/intelligence.module.ts');
if (!intelligenceModule.includes('InternalPeRelevanceController')) {
  fail('the internal relevance controller is not registered');
}

// ── 7. Gates and documentation ─────────────────────────────────────────────
for (const gate of [
  'scripts/test-phase8-session9-provider-domain.mjs',
  'scripts/verify-phase8-session9-db.mjs',
  'scripts/verify-phase8-session9-db.sh',
  'apps/defense-api/src/program-elements/cross-domain/provider-runtime.spec.ts',
  'apps/defense-api/src/program-elements/cross-domain/testing/provider-test-doubles.ts',
  'docs/defense-budget/phase8-session9-provider-design.md',
  'docs/runbooks/defense-cross-domain-providers-v1.md',
]) {
  if (!exists(gate)) fail(`Missing Session 9 gate or document: ${gate}`);
}

// ── 8. Session 5's accepted negative provider decision is untouched ────────
const providerDecision = 'docs/defense-budget/phase8-session5-provider-decision.json';
if (exists(providerDecision)) {
  const decision = JSON.parse(read(providerDecision));
  if (!/NOT_ADOPTED|not_adopted/i.test(JSON.stringify(decision))) {
    fail('the accepted Session 5 negative provider decision appears to have changed');
  }
}

// ── report ─────────────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.error('SESSION9_PROVIDER_RUNTIME_FAIL');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log('SESSION9_PROVIDER_RUNTIME_PASS');
