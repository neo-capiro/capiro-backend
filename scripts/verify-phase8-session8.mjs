#!/usr/bin/env node
/**
 * Phase 8 Session 8 — live official-source discovery static gate.
 *
 * Asserts the structural guarantees a reviewer cannot check by reading: that the
 * session stays dark, that a fabricated identity is unrepresentable, that pacing
 * is host-keyed and can be tightened by a publisher, that the Session 7 contracts
 * it builds on are untouched, and that the manifest adapter survives so the
 * Session 7 replay still has a deterministic offline discovery source.
 *
 * Prohibition checks strip comments first. Session 7's closeout hit exactly this:
 * five checks failed on the prose asserting the very thing they check.
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
const notes = [];
const enforceReplay = process.argv.includes('--enforce-replay');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const exists = (relative) => fs.existsSync(path.join(root, relative));
const fail = (message) => failures.push(message);

/**
 * Strip comments before a prohibition check. A doc comment that NAMES the thing
 * being forbidden is the guard, not the violation.
 */
const stripComments = (content) =>
  content
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => line.replace(/(^|\s)\/\/.*$/, '$1'))
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
  'apps/api/prisma/migrations/20261127120000_phase8_session8_live_source_discovery/migration.sql';

const S8_TABLES = [
  'defense_budget_discovery_crawl',
  'defense_budget_discovery_candidate',
  'defense_budget_discovery_host_budget',
];

// ── 1. Migration: structural guarantees, grants, no money ───────────────────
const migration = requireTokens(
  MIGRATION,
  [
    ...S8_TABLES,
    // Resolved <=> carries a key, in BOTH directions.
    '("resolution" = \'resolved\') = ("expected_source_dedup_key" IS NOT NULL)',
    // Only a resolved candidate may be emitted.
    'dbdcand_emitted_requires_resolved_chk',
    // A success must carry a 2xx, so a 403 cannot be logged as a success.
    'dbdc_success_requires_2xx_chk',
    'dbdc_blocked_requires_status_chk',
    'dbdc_unreachable_has_no_status_chk',
    'dbdc_failure_reason_chk',
    // Idempotent audit trail.
    'CREATE UNIQUE INDEX "dbdcand_run_url_uidx"',
    // Least privilege, matching Session 7.
    'GRANT SELECT, INSERT, UPDATE',
    'capiro_defense_serve',
    'capiro_defense_job',
    'REVOKE ALL',
  ],
  'Session 8 migration',
);

if (migration) {
  const sql = stripComments(migration);

  // No monetary column anywhere. The DB rehearsal measures this too.
  const monetary = /"[a-z_]*(amount|usd|dollar|obligat|outlay|budget_authority)[a-z_]*"\s+(NUMERIC|DECIMAL|MONEY|BIGINT|INTEGER)/i;
  if (monetary.test(sql)) {
    fail('Session 8 migration declares a monetary column; discovery records provenance, not dollars');
  }

  // `ON DELETE RESTRICT` is a referential-integrity clause, not a privilege.
  // Only a GRANTED delete or an actual DELETE statement is a violation, so the
  // FK clauses are stripped before the prohibition check.
  const sqlWithoutFkClauses = sql.replace(
    /ON\s+DELETE\s+(RESTRICT|CASCADE|SET\s+NULL|NO\s+ACTION)/gi,
    ' ',
  );
  if (/\bDELETE\s+FROM\b/i.test(sqlWithoutFkClauses)) {
    fail('Session 8 migration performs a DELETE; the crawl history must be append-only');
  }
  if (/GRANT[^;]*\bDELETE\b/i.test(sqlWithoutFkClauses)) {
    fail('Session 8 migration grants DELETE; the crawl history must be append-only');
  }

  for (const table of S8_TABLES) {
    if (!new RegExp(`GRANT SELECT ON TABLE "${table}" TO "capiro_defense_serve"`).test(sql)) {
      fail(`${table} does not grant read to capiro_defense_serve`);
    }
    if (
      !new RegExp(`GRANT SELECT, INSERT, UPDATE ON TABLE "${table}" TO "capiro_defense_job"`).test(
        sql,
      )
    ) {
      fail(`${table} does not grant the job role SELECT/INSERT/UPDATE`);
    }
    if (new RegExp(`GRANT[^;]*\\bDELETE\\b[^;]*"${table}"`, 'i').test(sqlWithoutFkClauses)) {
      fail(`${table} grants DELETE`);
    }
  }

  // Every candidate URL must be https, in the database, not just in code.
  if (!sql.includes('"candidate_url" LIKE \'https://%\'')) {
    fail('Session 8 migration does not constrain candidate_url to https');
  }
  if (!sql.includes('"request_url" LIKE \'https://%\'')) {
    fail('Session 8 migration does not constrain request_url to https');
  }

  // No promotion, no snapshot activation, no PE-year writes.
  if (/program_element_year|defense_budget_active_snapshot|promote/i.test(sql)) {
    fail('Session 8 migration touches PE-year rows, snapshot activation or promotion');
  }
}

// ── 2. Authoritative Prisma schema models the migrated tables ──────────────
const authoritativeSchema = read('apps/api/prisma/schema.prisma');
for (const model of [
  'DefenseBudgetDiscoveryCrawl',
  'DefenseBudgetDiscoveryCandidate',
  'DefenseBudgetDiscoveryHostBudget',
]) {
  if (!new RegExp(`model\\s+${model}\\s*\\{`).test(authoritativeSchema)) {
    fail(`Authoritative Prisma schema is missing model ${model}`);
  }
}
for (const table of S8_TABLES) {
  if (!authoritativeSchema.includes(`@@map("${table}")`)) {
    fail(`Authoritative Prisma schema does not map ${table}`);
  }
}
// Session 7 trap #4: @default(uuid()) drifts against gen_random_uuid().
const s8ModelBlocks = [...authoritativeSchema.matchAll(/model\s+DefenseBudgetDiscovery\w+\s*\{([\s\S]*?)\n\}/g)];
if (s8ModelBlocks.length !== 3) {
  fail(`Expected 3 Session 8 Prisma models, found ${s8ModelBlocks.length}`);
}
for (const block of s8ModelBlocks) {
  const body = block[1] ?? '';
  if (/@default\(uuid\(\)\)/.test(body)) {
    fail('A Session 8 model uses @default(uuid()); this drifts against gen_random_uuid()');
  }
  if (/@db\.Uuid/.test(body) && !/dbgenerated\("gen_random_uuid\(\)"\)/.test(body)) {
    // Only the id column needs a generated default; host_budget has none.
    if (/\bid\s+String\s+@id/.test(body)) {
      fail('A Session 8 model id does not use dbgenerated("gen_random_uuid()")');
    }
  }
  if (/(amount|usd|dollar|obligat|outlay)/i.test(body)) {
    fail('A Session 8 Prisma model declares a monetary field');
  }
}

// ── 3. Discovery domain: pure, fail-closed, publisher-respecting ───────────
const robots = requireTokens(
  'packages/defense-domain/src/budget-lifecycle/discovery/robots.ts',
  [
    'export function parseRobotsTxt',
    'export function robotsPolicyFromFetch',
    'export function selectRobotsGroup',
    'export function evaluateRobots',
    'export function assertUserAgentPermitted',
    'UserAgentExcludedByPublisherError',
    'crawlDelaySeconds',
    'robotsUnavailable',
  ],
  'Session 8 robots domain',
);
if (robots) {
  // A 4xx must be unavailable-and-allowed, never a ban.
  if (!/statusCode >= 200 && statusCode < 300/.test(robots)) {
    fail('robots policy does not restrict parsing to a 2xx response');
  }
}

const rateLimit = requireTokens(
  'packages/defense-domain/src/budget-lifecycle/discovery/rate-limit.ts',
  [
    'export function effectiveRequestIntervalMs',
    'export function nextHostRequestAt',
    'export function publisherBackoffMs',
    'export function retryAfterMs',
    'export function createRequestBudget',
    'budgetExhausted',
  ],
  'Session 8 pacing domain',
);
if (rateLimit) {
  // The publisher's crawl-delay must win when stricter.
  if (!/Math\.max\(registry, declared\)/.test(rateLimit)) {
    fail('effectiveRequestIntervalMs does not take the maximum of registry and publisher delay');
  }
  // Determinism: a replay must reproduce the schedule.
  if (/Math\.random/.test(stripComments(rateLimit))) {
    fail('Session 8 pacing uses randomness; backoff must be deterministic for replay');
  }
}

const resolution = requireTokens(
  'packages/defense-domain/src/budget-lifecycle/discovery/candidate-resolution.ts',
  [
    'export function resolveDiscoveredCandidate',
    'expectedSourceDedupKey',
    'registeredExpectedSourceKeys',
    'unresolved_no_registered_expected_source',
    'unresolved_fiscal_year_out_of_horizon',
    'contentExcerptAvailable: false',
    'assertStageBelongsToTrack' in {} ? 'STAGE_TRACK' : 'STAGE_TRACK',
  ],
  'Session 8 candidate resolution',
);
if (resolution) {
  const code = stripComments(resolution);
  // The single most important structural rule of this session.
  if (!/expectedSourceDedupKey: null/.test(code)) {
    fail('resolution has no branch that returns a null dedup key; unresolved must carry none');
  }
  if (/registeredExpectedSourceKeys\.has\(dedupKey\)/.test(code) === false) {
    fail('resolution does not require the dedup key to be a REGISTERED expected source');
  }
  if (/amount|usd|dollar|outlay/i.test(code)) {
    fail('candidate resolution references a monetary concept');
  }
}

const cursor = requireTokens(
  'packages/defense-domain/src/budget-lifecycle/discovery/crawl-cursor.ts',
  [
    'export function advanceCollectionCursor',
    'export function alreadyEmittedAtWatermark',
    'backfillPending',
    'hasPendingBackfill',
    'DISCOVERY_CURSOR_SCHEMA',
  ],
  'Session 8 crawl cursor',
);
if (cursor) {
  // A truncated run must not advance the watermark.
  if (!/input\.exhausted && input\.observedWatermark !== null/.test(cursor)) {
    fail('the cursor may advance its watermark on a truncated run, silently skipping backlog');
  }
}

requireTokens(
  'packages/defense-domain/src/budget-lifecycle/discovery/sitemap.ts',
  ['export function parseSitemapIndex', 'export function parseSitemapUrlSet', 'entries.sort('],
  'Session 8 sitemap domain',
);

requireTokens(
  'packages/defense-domain/src/budget-lifecycle/discovery/govinfo-packages.ts',
  [
    'export function packageIdFromSitemapLoc',
    'export function govinfoPackagePdfUrl',
    'export function govinfoPackageModsUrl',
    'export function parseModsMetadata',
    'alternativeTitles',
    'relatedItem',
  ],
  'Session 8 GovInfo package algebra',
);

requireTokens(
  'packages/defense-domain/src/budget-lifecycle/discovery/listing-extract.ts',
  ['export function extractDocumentLinks', 'export function extractFeedItems', 'officialHosts'],
  'Session 8 listing extraction',
);

// The domain must be exported through the package barrel or the gate below
// exercises a different artifact from the one the services consume.
const domainIndex = read('packages/defense-domain/src/budget-lifecycle/index.ts');
if (!domainIndex.includes("export * from './discovery/index.js';")) {
  fail('the Session 8 discovery domain is not exported from the budget-lifecycle barrel');
}

// ── 4. defense-api discovery: dark, no route, no schedule, no GPU ──────────
const S8_API_FILES = [
  'apps/defense-api/src/budget-lifecycle/discovery/publisher-http.port.ts',
  'apps/defense-api/src/budget-lifecycle/discovery/discovery-audit.port.ts',
  'apps/defense-api/src/budget-lifecycle/discovery/https-publisher-http.adapter.ts',
  'apps/defense-api/src/budget-lifecycle/discovery/govinfo-sitemap.crawler.ts',
  'apps/defense-api/src/budget-lifecycle/discovery/index-page.crawler.ts',
  'apps/defense-api/src/budget-lifecycle/discovery/live-source-discovery.adapter.ts',
  'apps/defense-api/src/budget-lifecycle/discovery/prisma-discovery-audit.store.ts',
  'apps/defense-api/src/budget-lifecycle/discovery/publisher-crawler.ts',
];

for (const file of S8_API_FILES) {
  if (!exists(file)) {
    fail(`Missing Session 8 service file: ${file}`);
    continue;
  }
  const content = stripComments(read(file));
  if (/@Controller|@Get\(|@Post\(|@Put\(|@Patch\(|@Delete\(/.test(content)) {
    fail(`${file} declares an HTTP route; Session 8 changes no public routing`);
  }
  if (/@Cron\(|CronExpression|ScheduleModule|EventBridge/.test(content)) {
    fail(`${file} declares a schedule; production schedule ownership is Session 10`);
  }
  if (/promote|activateSnapshot|DefenseBudgetPromotion/.test(content)) {
    fail(`${file} references snapshot promotion/activation`);
  }
  // Session 3's frozen boundary forbids defense-api from naming a GPU provider.
  if (/sagemaker|nvidia|nemotron|cuda|gpu_?instance/i.test(content)) {
    fail(`${file} references NVIDIA/SageMaker/GPU execution`);
  }
  if (/from '\.\.\/\.\.\/\.\.\/api\/|@capiro\/api/.test(content)) {
    fail(`${file} imports executable source from apps/api`);
  }
  if (/DELETE FROM defense_budget_/i.test(content)) {
    fail(`${file} deletes control-plane or discovery history`);
  }
}

const liveAdapter = read(
  'apps/defense-api/src/budget-lifecycle/discovery/live-source-discovery.adapter.ts',
);
for (const token of [
  // Same official-host rule the manifest adapter obeyed.
  'assertAuthoritativeHost',
  'loadRegisteredExpectedSourceKeys',
  'rollingCycleHorizon',
  'hasPendingBackfill',
  'serialiseDiscoveryCursor',
  'parseDiscoveryCursor',
]) {
  if (!liveAdapter.includes(token)) {
    fail(`Live discovery adapter is missing required token: ${token}`);
  }
}
// It must implement the FROZEN Session 7 port, not a new one.
if (!/implements SourceDiscoveryPort/.test(liveAdapter)) {
  fail('Live discovery adapter does not implement the frozen Session 7 SourceDiscoveryPort');
}
// A non-authoritative adapter must never be crawled for evidence.
if (!/adapter\.authoritative/.test(liveAdapter)) {
  fail('Live discovery adapter does not check the authoritative flag');
}

const auditStore = read(
  'apps/defense-api/src/budget-lifecycle/discovery/prisma-discovery-audit.store.ts',
);
// Session 6/7 regression: $queryRawUnsafe does not know column types.
for (const cast of ['$1::uuid', '::timestamptz', '::int', '::boolean', '::numeric']) {
  if (!auditStore.includes(cast)) {
    fail(`Prisma discovery audit store is missing an expected SQL cast: ${cast}`);
  }
}
if (!auditStore.includes('ON CONFLICT (adapter_id, run_key, candidate_url) DO NOTHING')) {
  fail('candidate audit insert is not idempotent, so a retry would duplicate the trail');
}
// The host reservation must be ONE atomic statement.
if (!/GREATEST\(hb\.next_request_allowed_at/.test(auditStore)) {
  fail('host slot reservation is not a single atomic GREATEST-based claim');
}

const govinfoCrawler = read(
  'apps/defense-api/src/budget-lifecycle/discovery/govinfo-sitemap.crawler.ts',
);
for (const token of [
  'budgetExhausted',
  'advanceCollectionCursor',
  'alreadyEmittedAtWatermark',
  'passesIdPrefilter',
  'alternativeTitles',
  'logger.warn',
]) {
  if (!govinfoCrawler.includes(token)) {
    fail(`GovInfo sitemap crawler is missing required token: ${token}`);
  }
}
// A bounded run must SAY it was bounded. A silent cap reads as "nothing left".
if (!/budget exhausted/i.test(govinfoCrawler)) {
  fail('GovInfo crawler does not log budget exhaustion; a silent cap looks like completeness');
}

// ── 5. Session 8 live discovery is opt-in, and the manifest adapter survives ─
const module_ = requireTokens(
  'apps/defense-api/src/budget-lifecycle/budget-lifecycle.module.ts',
  [
    // Session 7 tokens must all still be present.
    'AnnualDefenseBudgetCycleController',
    'DefenseBudgetLifecycleWatcher',
    'CycleHealthService',
    'SourceAdapterRegistry',
    // Session 8 wiring.
    'LiveSourceDiscoveryAdapter',
    'ManifestSourceDiscoveryAdapter',
    'PHASE8_SESSION8_LIVE_DISCOVERY',
  ],
  'Session 8 module wiring',
);
if (module_) {
  const moduleCode = stripComments(module_);
  if (/controllers\s*:/.test(moduleCode)) {
    fail('Session 8 module registers controllers; the Session 3 route surface must stay frozen');
  }
  if (/@Cron|ScheduleModule|EventBridge|setInterval/.test(moduleCode)) {
    fail('Session 8 module registers a schedule; production schedule ownership is Session 10');
  }
  // Live crawling must not be the default.
  if (!/liveDiscoveryEnabled\(process\.env\)\s*\n?\s*\?/.test(moduleCode)) {
    fail('live discovery is not gated behind an explicit opt-in');
  }
}

// The Session 7 replay depends on a deterministic offline discovery source.
if (!exists('apps/defense-api/src/budget-lifecycle/manifest-source-discovery.adapter.ts')) {
  fail('the Session 7 manifest discovery adapter was removed; its historical replay needs it');
}

// ── 6. Governed run command: dark by default, twice ────────────────────────
const command = requireTokens(
  'apps/defense-api/scripts/run-live-discovery.mjs',
  [
    "process.env.PHASE8_SESSION8_CRAWL_AUTHORIZED !== 'true'",
    'PHASE8_SESSION8_COMMIT_AUTHORIZED',
    'SESSION8_DRY_RUN_PASS',
    'assertWatcherRunnableWithoutGpu',
    '--list-adapters',
    '--plan',
  ],
  'governed live-discovery command',
);
if (command) {
  const commandCode = stripComments(command);
  if (/program_element_year|activateSnapshot|promote/.test(commandCode)) {
    fail('live-discovery command touches PE-year rows or snapshot promotion');
  }
  if (/EventBridge|put-rule|events:PutRule/i.test(commandCode)) {
    fail('live-discovery command installs a production schedule');
  }
  if (/aws\s+(ecs|events|lambda)|update-service|register-task-definition/i.test(commandCode)) {
    fail('live-discovery command performs an AWS mutation');
  }
}

// ── 7. Gates, corpus and evidence ──────────────────────────────────────────
for (const gate of [
  'scripts/test-phase8-session8-discovery-domain.mjs',
  'scripts/prepare-phase8-session8-discovery-corpus.mjs',
  'scripts/phase8-session8-discovery-replay.mjs',
  'scripts/verify-phase8-session8-db.mjs',
  'scripts/verify-phase8-session8-db.sh',
  'apps/defense-api/src/budget-lifecycle/discovery/live-discovery.spec.ts',
  'docs/defense-budget/phase8-session8-discovery-design.md',
]) {
  if (!exists(gate)) fail(`Missing Session 8 gate: ${gate}`);
}

const corpusPath = 'docs/defense-budget/phase8-session8-discovery-corpus.json';
if (!exists(corpusPath)) {
  fail(`Missing Session 8 discovery corpus: ${corpusPath}`);
} else {
  const corpus = JSON.parse(read(corpusPath));
  if (corpus.schemaVersion !== 'phase8_session8_discovery_corpus_v1') {
    fail('Unexpected Session 8 corpus schemaVersion');
  }
  if (!Array.isArray(corpus.resources) || corpus.resources.length < 10) {
    fail('Session 8 corpus is too small to be a meaningful discovery-channel proof');
  }
  // The corpus must include the refusals, not only the happy path.
  const refusals = corpus.resources.filter(
    (resource) => resource.expectedUnreachable === true || resource.expectedStatus >= 400,
  );
  if (refusals.length < 2) {
    fail('Session 8 corpus does not encode the publishers that really refuse a plain client');
  }
  // And the case that proves title-only classification is not enough.
  if (!corpus.resources.some((resource) => resource.assertTitleLacksFiscalYearPhrase === true)) {
    fail('Session 8 corpus does not assert the HAC-D title lacks a fiscal-year phrase');
  }
  for (const resource of corpus.resources) {
    if (!String(resource.officialUrl).startsWith('https://')) {
      fail(`Session 8 corpus entry is not https: ${resource.officialUrl}`);
    }
  }
}

const evidencePath = 'docs/defense-budget/phase8-session8-discovery-replay-evidence.json';
if (!exists(evidencePath)) {
  if (enforceReplay) fail(`Missing Session 8 replay evidence: ${evidencePath}`);
  else notes.push(`replay evidence absent (${evidencePath}); run the replay to produce it`);
} else {
  const evidence = JSON.parse(read(evidencePath));
  if (evidence.schemaVersion !== 'phase8_session8_discovery_replay_evidence_v1') {
    fail('Unexpected Session 8 replay evidence schemaVersion');
  }
  if (enforceReplay) {
    if (evidence.failed !== 0) {
      fail(`Session 8 replay evidence records ${evidence.failed} failing checks`);
    }
    if (!(evidence.passed >= 25)) {
      fail(`Session 8 replay evidence records only ${evidence.passed} passing checks`);
    }
    // The measured cost of a cold backfill must be published, not implied.
    if (typeof evidence.observed?.bills2023PrefilterSurvivors !== 'number') {
      fail('replay evidence does not publish the measured BILLS prefilter survivor count');
    }
    if (evidence.observed?.congressGovEffectiveIntervalMs !== 2_000) {
      fail('replay evidence does not record the publisher-tightened effective interval');
    }
    const omnibus = (evidence.resolutions ?? []).find(
      (entry) => entry.packageId === 'PLAW-118publ42',
    );
    if (!omnibus || omnibus.outcome === 'resolved') {
      fail('replay evidence does not prove the no-defence-division omnibus refuses to resolve');
    }
    const hacd = (evidence.resolutions ?? []).find((entry) => entry.packageId === 'CRPT-118hrpt121');
    if (!hacd || hacd.authorityTrack !== 'appropriations') {
      fail('replay evidence does not prove the HAC-D report resolves onto appropriations');
    }
    if (hacd?.titleStatesFiscalYearPhrase !== false) {
      fail('replay evidence does not prove the HAC-D title lacks a fiscal-year phrase');
    }
  }
}

// ── 8. Session 7 contracts are untouched ───────────────────────────────────
const ports = read('apps/defense-api/src/budget-lifecycle/lifecycle-ports.ts');
for (const token of [
  'export interface SourceDiscoveryPort',
  'expectedSourceDedupKey: string;',
  'cursor: Record<string, unknown>;',
]) {
  if (!ports.includes(token)) {
    fail(`Session 7 discovery port contract changed; missing: ${token}`);
  }
}
const watcherService = read('apps/defense-api/src/budget-lifecycle/lifecycle-watcher.service.ts');
for (const token of [
  'assertWatcherRunnableWithoutGpu',
  'assertAuthoritativeHost',
  'detectSourceRevision',
  'assertObservationQueueable',
]) {
  if (!watcherService.includes(token)) {
    fail(`Session 7 watcher lost a required guarantee: ${token}`);
  }
}

// ── 9. Session 5 provider decision preserved ───────────────────────────────
const providerDecision = 'docs/defense-budget/phase8-session5-provider-decision.json';
if (exists(providerDecision)) {
  const decision = JSON.parse(read(providerDecision));
  const serialised = JSON.stringify(decision);
  if (!/NOT_ADOPTED|not_adopted/i.test(serialised)) {
    fail('the accepted Session 5 negative provider decision appears to have changed');
  }
}

// ── report ─────────────────────────────────────────────────────────────────
for (const note of notes) console.log(`note: ${note}`);

if (failures.length > 0) {
  console.error('SESSION8_LIVE_DISCOVERY_FAIL');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log('SESSION8_LIVE_DISCOVERY_PASS');
