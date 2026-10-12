#!/usr/bin/env node
/** @cleanup-smoke noArgsExit=0 helpExit=0 */
/**
 * Phase 8 Session 7 static verifier.
 *
 * Every check here corresponds to a Session 7 acceptance requirement or safety
 * boundary. Where a check exists because something actually went wrong while
 * building Session 7, the comment says so — those are the ones most worth
 * keeping.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const usage = 'Usage: node scripts/verify-phase8-session7.mjs [--enforce-replay]';
const args = process.argv.slice(2);
if (args.length === 0) console.log(usage);
else if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
  console.log(usage);
  process.exit(0);
} else if (args.length !== 1 || args[0] !== '--enforce-replay') {
  console.error(usage);
  process.exit(2);
}

function resolveRepoRoot(start = process.cwd()) {
  let dir = path.resolve(start);
  for (let i = 0; i < 8; i += 1) {
    if (fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(start);
}

const root = resolveRepoRoot();
const failures = [];
const notes = [];
const enforceReplay = process.argv.includes('--enforce-replay');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const exists = (relative) => fs.existsSync(path.join(root, relative));
const fail = (message) => failures.push(message);

/**
 * Strip comments before applying PROHIBITION checks.
 *
 * Without this, a file that documents "no EventBridge schedule is registered
 * here" fails the very check asserting it registers none — a self-inflicted
 * false positive this verifier hit on five files the first time it ran.
 * Requirement checks still run against the full text, because a required
 * declaration may legitimately be described in prose.
 */
const stripComments = (content) =>
  content
    // block comments
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    // whole-line line comments
    .replace(/^[ \t]*\/\/.*$/gm, ' ')
    // trailing line comments; the [^:] guard keeps `https://` intact
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
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
  'apps/api/prisma/migrations/20261120230000_phase8_session7_budget_cycle_lifecycle/migration.sql';

const S7_TABLES = [
  'defense_budget_cycle',
  'defense_budget_expected_source',
  'defense_budget_source_observation',
  'defense_budget_watcher_adapter',
  'defense_budget_watcher_run',
  'defense_budget_ingestion_outbox',
  'defense_budget_lifecycle_signal',
];

// ── 1. Migration: tables, grants, and the structural guarantees ─────────────
if (!exists(MIGRATION)) {
  fail(`Missing Session 7 migration: ${MIGRATION}`);
} else {
  const sql = read(MIGRATION);

  for (const table of S7_TABLES) {
    if (!sql.includes(`CREATE TABLE "${table}"`)) fail(`Missing ${table} table`);
    if (!sql.includes(`REVOKE ALL ON TABLE "${table}" FROM PUBLIC`)) {
      fail(`${table} is not revoked from PUBLIC`);
    }
    if (!sql.includes(`GRANT SELECT ON TABLE "${table}" TO "capiro_defense_serve"`)) {
      fail(`${table} is not readable by the defense serve role`);
    }
    if (!sql.includes(`GRANT SELECT, INSERT, UPDATE ON TABLE "${table}" TO "capiro_defense_job"`)) {
      fail(`${table} is not writable by the defense job role`);
    }
  }

  // The job role may never delete: a superseded observation, a failed run and a
  // withdrawn source all have to stay auditable.
  if (/GRANT\s+[^;]*DELETE[^;]*defense_budget_(cycle|expected_source|source_observation|watcher|ingestion_outbox|lifecycle_signal)/i.test(sql)) {
    fail('Session 7 migration grants DELETE on auditable control-plane history');
  }
  if (/TRUNCATE/i.test(sql)) fail('Session 7 migration grants or performs TRUNCATE');

  // Cycle identity is (fiscal_year, authority_track). This is what makes
  // "authorization and appropriations never overwrite each other" structural.
  if (!sql.includes('CREATE UNIQUE INDEX "defense_budget_cycle_fy_track_key"')) {
    fail('Cycle identity is not unique on (fiscal_year, authority_track)');
  }

  // Idempotency: identical bytes for one expected source are ONE observation.
  if (!sql.includes('CREATE UNIQUE INDEX "defense_budget_source_observation_expected_sha_key"')) {
    fail('Observations are not unique on (expected_source_id, content_sha256)');
  }
  // Exactly one governed ingestion job per changed source.
  if (!sql.includes('CREATE UNIQUE INDEX "defense_budget_ingestion_outbox_observation_job_key"')) {
    fail('Ingestion outbox is not unique on (observation_id, job_kind)');
  }

  // Ambiguity cannot be enqueued, and an already-queued observation cannot be
  // moved into review — enforced by a composite FK with ON UPDATE CASCADE plus a
  // CHECK, not by application convention.
  for (const token of [
    'CREATE UNIQUE INDEX "defense_budget_source_observation_id_state_key"',
    'defense_budget_ingestion_outbox_queueable_chk',
    'FOREIGN KEY ("observation_id", "observation_state")',
    'ON UPDATE CASCADE',
  ]) {
    if (!sql.includes(token)) fail(`Missing ambiguity/queue safety token: ${token}`);
  }

  for (const token of [
    'defense_budget_source_observation_review_no_stage_chk',
    'defense_budget_source_observation_review_reason_chk',
    'defense_budget_source_observation_ingested_chk',
    'defense_budget_source_observation_superseded_chk',
    'defense_budget_source_observation_sha_chk',
    'defense_budget_watcher_adapter_no_gpu_chk',
    'defense_budget_watcher_run_queue_bound_chk',
    'defense_budget_lifecycle_signal_no_dollars_chk',
  ]) {
    if (!sql.includes(token)) fail(`Missing Session 7 safety constraint: ${token}`);
  }

  // Content identity is the SHA, and it is NOT NULL.
  if (!/"content_sha256"\s+CHAR\(64\)\s+NOT NULL/.test(sql)) {
    fail('content_sha256 is not a NOT NULL CHAR(64) — the authoritative content identity');
  }

  // Observations bind to immutable source identity rather than replacing it.
  if (!sql.includes('REFERENCES "source_document"("id")')) {
    fail('Source observations are not bound to the immutable source_document ledger');
  }

  // No monetary column anywhere in the control plane. A missing source is a
  // state, never a number.
  const columnPattern = /"([a-z_]+)"\s+(TEXT|INTEGER|BOOLEAN|UUID|JSONB|NUMERIC\([^)]*\)|CHAR\(\d+\)|DATE|TIMESTAMPTZ\(\d\))/g;
  for (const match of sql.matchAll(columnPattern)) {
    const column = match[1];
    if (/(amount|_usd|dollar|obligated|outlay|appropriated|funding_level)/.test(column)) {
      fail(`Session 7 control plane declares a monetary column: ${column}`);
    }
  }
  if (/NUMERIC\(20,\s*2\)/.test(sql)) {
    fail('Session 7 migration declares a money-shaped NUMERIC(20,2) column');
  }

  // Nothing here may promote or activate a snapshot.
  if (/defense_budget_active_snapshot|promotion_activation|activate_snapshot/i.test(sql)) {
    fail('Session 7 migration touches snapshot promotion/activation');
  }
  if (/program_element_year/i.test(sql)) {
    fail('Session 7 migration references program_element_year');
  }
}

// ── 2. Authoritative Prisma schema truthfully models the migrated tables ────
//
// Session 6 shipped a migration that created tables the authoritative
// schema.prisma did not declare. Guard the same class of drift here.
const authoritativeSchema = read('apps/api/prisma/schema.prisma');
const prismaModelChecks = [
  {
    model: 'DefenseBudgetCycle',
    dbTable: 'defense_budget_cycle',
    requiredFields: ['fiscalYear', 'authorityTrack', 'status', 'templateVersion', 'bootstrapOrigin', 'dedupKey'],
  },
  {
    model: 'DefenseBudgetExpectedSource',
    dbTable: 'defense_budget_expected_source',
    requiredFields: ['cycleId', 'stage', 'sourceFamily', 'adapterId', 'expectedState', 'optional', 'expectedFrom', 'expectedTo', 'dedupKey'],
  },
  {
    model: 'DefenseBudgetSourceObservation',
    dbTable: 'defense_budget_source_observation',
    requiredFields: ['expectedSourceId', 'contentSha256', 'observationState', 'revisionKind', 'reviewReasons', 'sourceDocumentId', 'supersededByObservationId', 'seenCount', 'dedupKey'],
  },
  {
    model: 'DefenseBudgetWatcherAdapter',
    dbTable: 'defense_budget_watcher_adapter',
    requiredFields: ['adapterId', 'cursor', 'checkpoint', 'nextCheckAt', 'consecutiveFailures', 'leaseOwner', 'leaseExpiresAt', 'requiresGpu'],
  },
  {
    model: 'DefenseBudgetWatcherRun',
    dbTable: 'defense_budget_watcher_run',
    requiredFields: ['adapterId', 'runKey', 'status', 'changedCount', 'queuedCount', 'attempt'],
  },
  {
    model: 'DefenseBudgetIngestionOutbox',
    dbTable: 'defense_budget_ingestion_outbox',
    requiredFields: ['observationId', 'observationState', 'jobKind', 'state', 'attempts', 'dedupKey'],
  },
  {
    model: 'DefenseBudgetLifecycleSignal',
    dbTable: 'defense_budget_lifecycle_signal',
    requiredFields: ['signalKind', 'fromStage', 'toStage', 'fromObservationId', 'toObservationId', 'payload', 'dedupKey'],
  },
];
for (const check of prismaModelChecks) {
  const modelMatch = new RegExp(`model\\s+${check.model}\\s*\\{([\\s\\S]*?)\\n\\}`, 'm').exec(
    authoritativeSchema,
  );
  if (!modelMatch) {
    fail(
      `Authoritative Prisma schema is missing model ${check.model} for migrated table ` +
        `"${check.dbTable}" — migration ledger and Prisma desired schema are inconsistent`,
    );
    continue;
  }
  const body = modelMatch[1];
  if (!new RegExp(`@@map\\("${check.dbTable}"\\)`).test(body)) {
    fail(`Prisma model ${check.model} does not @@map to "${check.dbTable}"`);
  }
  for (const field of check.requiredFields) {
    if (!new RegExp(`\\b${field}\\b`).test(body)) {
      fail(`Prisma model ${check.model} is missing expected field ${field}`);
    }
  }
  // The SQL default is gen_random_uuid(); a client-side @default(uuid()) makes
  // Prisma's desired schema drift from the migration on every id column.
  if (!/@default\(dbgenerated\("gen_random_uuid\(\)"\)\)/.test(body)) {
    fail(
      `Prisma model ${check.model} does not declare @default(dbgenerated("gen_random_uuid()")), ` +
        'which drifts from the migration default',
    );
  }
}
if (!/defenseBudgetObservations\s+DefenseBudgetSourceObservation\[\]/.test(authoritativeSchema)) {
  fail('SourceDocument is missing the DefenseBudgetSourceObservation back-relation');
}

// ProgramElementYear must remain annual-stage only.
const peYearMatch = /model\s+ProgramElementYear\s*\{([\s\S]*?)\n\}/m.exec(authoritativeSchema);
if (!peYearMatch) {
  fail('Unable to locate ProgramElementYear in the authoritative Prisma schema');
} else if (/supplemental|reconciliation|rescission|transfer|reprogramming|continuing.?resolution/i.test(peYearMatch[1])) {
  fail('Alternative funding leaked into the ProgramElementYear annual-stage model');
}

// The curated defense-api HTTP subset must NOT gain these control-plane models:
// Session 7 is control-plane/job work, not an HTTP or product cutover.
const defenseApiSchema = read('apps/defense-api/prisma/schema.prisma');
if (/model\s+DefenseBudget(Cycle|ExpectedSource|SourceObservation|Watcher|IngestionOutbox|LifecycleSignal)\b/.test(defenseApiSchema)) {
  fail(
    'Session 7 control-plane models must not appear in the curated defense-api HTTP Prisma ' +
      'subset — Session 7 is the lifecycle control plane, not the HTTP/product cutover',
  );
}

// ── 3. Domain: templates, classifier, watcher, signals ──────────────────────
requireTokens(
  'packages/defense-domain/src/budget-lifecycle/types.ts',
  [
    "'request'", "'authorization'", "'appropriations'", "'alternative_funding'", "'execution'",
    'STAGE_TRACK', 'STAGE_RANK',
    'NON_QUEUEABLE_OBSERVATION_STATES',
    "'not_filed'", "'withdrawn'", "'unavailable'", "'review_required'", "'superseded'",
  ],
  'lifecycle types',
);

const templates = requireTokens(
  'packages/defense-domain/src/budget-lifecycle/templates.ts',
  [
    'DEFENSE_BUDGET_CYCLE_TEMPLATE_VERSION',
    'DEFENSE_BUDGET_CYCLE_TEMPLATE_V1',
    'resolveCycleTemplate',
    "'pb_r1'", "'pb_r2'", "'pb_r2a'", "'pb_r3'", "'pb_r4'", "'pb_p1'", "'pb_p_series'",
    "'pb_o1'", "'pb_op5'", "'pb_milcon_c1'", "'pb_dd1391'",
    "'auth_committee_mark'", "'auth_committee_report'", "'auth_chamber_action'",
    "'auth_conference_report'", "'auth_public_law'",
    "'appr_committee_mark'", "'appr_committee_report'", "'appr_chamber_action'",
    "'appr_conference_jes'", "'appr_public_law'",
    "'alt_supplemental'", "'alt_reconciliation'", "'alt_continuing_resolution'",
    "'alt_rescission'", "'alt_transfer'", "'alt_reprogramming'",
    "'exec_allocation'", "'exec_obligation'", "'exec_award'",
    // Real Session 7 bug: the classifier could emit emergency_supplemental but
    // no template expected it, so the candidate matched nothing and blocked.
    "stage: 'emergency_supplemental'",
  ],
  'expected-source templates',
);
if (templates) {
  if (/https?:\/\//.test(templates)) {
    fail('Templates embed URLs; discovery rules belong to the adapter registry, not cycle semantics');
  }
  if (/amount|Usd|dollar/i.test(stripComments(templates))) {
    fail('Expected-source templates reference a monetary concept');
  }
}

requireTokens(
  'packages/defense-domain/src/budget-lifecycle/cycle.ts',
  [
    'bootstrapFiscalYearCycle',
    'bootstrapRollingHorizon',
    'bootstrapCycleFromFirstDiscovery',
    'rollingCycleHorizon',
    'expectedSourceDedupKey',
    'budgetCycleDedupKey',
    'assertStageBelongsToTrack',
    'expectedSourceFundingPosition',
    'resolveUnobservedExpectedState',
    'NEVER_ZERO_EXPECTED_STATES',
  ],
  'annual cycle controller domain',
);

const classifier = requireTokens(
  'packages/defense-domain/src/budget-lifecycle/classifier.ts',
  [
    'classifyLifecycleSource',
    'validateClassificationAgainstContent',
    'parseOfficialPackageId',
    'billVersionRank',
    'CLASSIFICATION_ACCEPT_THRESHOLD',
    'corroborationDeferred',
    // Ambiguity must be a first-class outcome.
    "decision: 'review' as const",
    'omnibus/consolidated appropriations vehicle without proven Department of Defense division',
    // Real official phrasings, each taken from a live GovInfo document.
    'fiscal\\s+year\\s+ending\\s+september\\s+30',
    'appropriations\\s+(?:bill|act)',
  ],
  'lifecycle classifier',
);
if (classifier && /refusing to guess/i.test(classifier) === false) {
  fail('Classifier no longer states its refusal-to-guess behaviour on conflicting fiscal years');
}

const watcherDomain = requireTokens(
  'packages/defense-domain/src/budget-lifecycle/watcher.ts',
  [
    'detectSourceRevision',
    "'first_discovery'", "'unchanged'", "'changed'", "'replacement_url'", "'superseding_version'",
    'observationDedupKey',
    'ingestionOutboxDedupKey',
    'assertObservationQueueable',
    'assertWatcherRunnableWithoutGpu',
    'canAcquireWatcherLease',
    'nextWatcherCheckAt',
    'watcherSeasonForInstant',
    'routeAlternativeFundingDiscovery',
    'WATCHER_EXECUTION_CONTRACT',
    "nvidiaRouting: 'disabled'",
    'activeGpuCapacity: 0',
    'nvidiaQueuedPages: 0',
    "productionParser: 'DETERMINISTIC_PRIMARY'",
    'fabricatesDollars: false',
  ],
  'lifecycle watcher domain',
);
if (watcherDomain) {
  // Content identity must be the SHA. ETag/Last-Modified are hints only.
  if (!/Source SHA|content SHA|content sha/i.test(watcherDomain)) {
    fail('Watcher domain no longer states that the content SHA is the authoritative identity');
  }
  if (!/queuesIngestion: false/.test(watcherDomain)) {
    fail('Watcher domain has no revision outcome that suppresses ingestion work');
  }
}

requireTokens(
  'packages/defense-domain/src/budget-lifecycle/signals.ts',
  [
    'deriveLifecycleSignals',
    'assertLifecycleSignalCarriesNoDollars',
    'recomputeScopeForCorrection',
    "'pb_to_hasc'", "'pb_to_sasc'", "'pb_to_hac_d'", "'pb_to_sac_d'",
    "'house_to_senate'", "'latest_mark_to_conference'", "'conference_to_enacted'",
    "'source_correction'",
    'untouchedEarlierStages',
    'untouchedOtherTracks',
  ],
  'lifecycle signals',
);

requireTokens(
  'packages/defense-domain/src/budget-lifecycle/progression.ts',
  [
    'assertStageEvidenceIsAppendOnly',
    'StageOverwriteError',
    'CrossTrackWriteError',
    'enactedMatchesConference',
    'governingStage',
    'positionsByStage',
  ],
  'stage progression guards',
);

const health = requireTokens(
  'packages/defense-domain/src/budget-lifecycle/health.ts',
  [
    'buildCycleHealth',
    "'defense_budget_cycle_health_v1'",
    'notFiled',
    'reviewBacklog',
    'staleAdapters',
    'parserFailures',
    'nvidiaQueuedPages',
    'activeGpuJobs',
    'missingSourceMeansUnknownNotZero',
  ],
  'cycle health read model',
);
if (health && /amountUsd|authoritativeAmount|totalUsd/.test(health)) {
  fail('Cycle health read model declares a monetary field');
}

// ── 4. Contracts ────────────────────────────────────────────────────────────
const contracts = requireTokens(
  'packages/defense-contracts/src/public/budget-lifecycle.ts',
  [
    "DEFENSE_BUDGET_LIFECYCLE_SCHEMA_VERSION = 'defense_budget_lifecycle_v1'",
    'DefenseBudgetCycleDto',
    'DefenseExpectedSourceDto',
    'DefenseSourceObservationDto',
    'DefenseLifecycleSignalDto',
    'DefenseCycleHealthDto',
    'knownFundingPosition: null',
    'carriesFundingAmounts: false',
    'missingSourceMeansUnknownNotZero: true',
  ],
  'lifecycle public contracts',
);
if (contracts && /amountUsd|authoritativeAmountUsd|statedAmountUsd/.test(contracts)) {
  fail('Lifecycle contracts declare a funding-amount field');
}
if (!read('packages/defense-contracts/src/index.ts').includes('./public/budget-lifecycle.js')) {
  fail('Lifecycle contracts are not exported from the defense-contracts entrypoint');
}
if (!read('packages/defense-domain/src/index.ts').includes('./budget-lifecycle/index.js')) {
  fail('Lifecycle domain is not exported from the defense-domain entrypoint');
}

// ── 5. defense-api services: dark, no route, no schedule, no promotion ──────
const module_ = requireTokens(
  'apps/defense-api/src/budget-lifecycle/budget-lifecycle.module.ts',
  ['AnnualDefenseBudgetCycleController', 'DefenseBudgetLifecycleWatcher', 'CycleHealthService', 'SourceAdapterRegistry'],
  'Session 7 module',
);
if (module_) {
  const moduleCode = stripComments(module_);
  if (/controllers\s*:/.test(moduleCode)) {
    fail('Session 7 module registers controllers; the Session 3 route surface must stay frozen');
  }
  if (/@Cron|ScheduleModule|EventBridge|setInterval/.test(moduleCode)) {
    fail('Session 7 module registers a schedule; production schedule ownership is Session 10');
  }
}

for (const file of [
  'apps/defense-api/src/budget-lifecycle/annual-cycle-controller.service.ts',
  'apps/defense-api/src/budget-lifecycle/lifecycle-watcher.service.ts',
  'apps/defense-api/src/budget-lifecycle/cycle-health.service.ts',
  'apps/defense-api/src/budget-lifecycle/prisma-lifecycle.store.ts',
  'apps/defense-api/src/budget-lifecycle/source-adapter.registry.ts',
  'apps/defense-api/src/budget-lifecycle/manifest-source-discovery.adapter.ts',
  'apps/defense-api/src/budget-lifecycle/https-source-fetch.adapter.ts',
]) {
  if (!exists(file)) {
    fail(`Missing Session 7 service file: ${file}`);
    continue;
  }
  const content = stripComments(read(file));
  if (/@Controller|@Get\(|@Post\(|@Put\(|@Patch\(|@Delete\(/.test(content)) {
    fail(`${file} declares an HTTP route; Session 7 changes no public routing`);
  }
  if (/@Cron\(|CronExpression|EventBridge/.test(content)) {
    fail(`${file} declares a schedule; Session 7 takes no schedule ownership`);
  }
  if (/promote|activateSnapshot|DefenseBudgetPromotion/.test(content)) {
    fail(`${file} references snapshot promotion/activation`);
  }
  if (/sagemaker|nvidia|nemotron|gpu_?instance/i.test(content.replace(/nvidiaRouting|NVIDIA_ROUTING_MODE|NVIDIA routing|nvidia routing/g, ''))) {
    fail(`${file} references NVIDIA/SageMaker/GPU execution`);
  }
  if (/from '\.\.\/\.\.\/\.\.\/api\/|@capiro\/api/.test(content)) {
    fail(`${file} imports executable source from apps/api`);
  }
}

const registry = read('apps/defense-api/src/budget-lifecycle/source-adapter.registry.ts');
for (const token of [
  'comptroller.defense.gov',
  'asafm.army.mil',
  'secnav.navy.mil',
  'saffm.hq.af.mil',
  'govinfo.gov',
  'congress.gov',
  'armedservices.house.gov',
  'armed-services.senate.gov',
  'appropriations.house.gov',
  'appropriations.senate.gov',
  'assertAuthoritativeHost',
  'NonOfficialSourceHostError',
  'requiresGpu: false',
]) {
  if (!registry.includes(token)) fail(`Adapter registry is missing required token: ${token}`);
}
if (/authoritative: true/.test(registry) === false) {
  fail('Adapter registry does not distinguish authoritative official sources');
}

const watcherService = read('apps/defense-api/src/budget-lifecycle/lifecycle-watcher.service.ts');
for (const token of [
  'assertWatcherRunnableWithoutGpu',
  'assertAuthoritativeHost',
  'detectSourceRevision',
  'conditionalFetchHeaders',
  'classifyLifecycleSource',
  'validateClassificationAgainstContent',
  'assertObservationQueueable',
  'supersedeObservation',
  'ensureFromFirstDiscovery',
  "observationState: 'review_required'",
  'canAcquireWatcherLease',
]) {
  if (!watcherService.includes(token)) fail(`Watcher service is missing required token: ${token}`);
}
// The ambiguous branch must NOT persist a resolved FY/track/stage.
if (!/classifiedAuthorityTrack: null,\s*\n\s*classifiedStage: null,/.test(watcherService)) {
  fail('Watcher service may record a resolved track/stage on an ambiguous observation');
}

const store = read('apps/defense-api/src/budget-lifecycle/prisma-lifecycle.store.ts');
// Regression guard carried forward from Session 6: $queryRawUnsafe does not know
// column types, so every uuid/numeric placeholder must be explicitly cast.
for (const cast of ['$1::uuid', '$2::uuid', '$3::uuid', '::timestamptz', '::jsonb', '::int', '::numeric', '::boolean']) {
  if (!store.includes(cast)) fail(`Prisma lifecycle store is missing an expected SQL cast: ${cast}`);
}
if (!store.includes('ON CONFLICT (observation_id, job_kind) DO NOTHING')) {
  fail('Ingestion enqueue does not use DO NOTHING, so a racing worker could report a false insert');
}
if (!store.includes('ON CONFLICT (expected_source_id, content_sha256) DO UPDATE')) {
  fail('Observation upsert does not key on the (expected source, bytes) idempotency point');
}
if (/DELETE FROM defense_budget_/i.test(store)) {
  fail('Prisma lifecycle store deletes control-plane history');
}

// ── 6. Governed run command ─────────────────────────────────────────────────
const command = requireTokens(
  'apps/defense-api/scripts/run-lifecycle-watcher.mjs',
  [
    "process.env.PHASE8_SESSION7_COMMIT_AUTHORIZED !== 'true'",
    'DRY_RUN_PASS',
    'assertWatcherRunnableWithoutGpu',
    '--list-adapters',
    'InMemoryLifecycleStore',
    'PrismaLifecycleStore',
  ],
  'governed watcher run command',
);
if (command) {
  const commandCode = stripComments(command);
  if (/program_element_year|activateSnapshot|promote/.test(commandCode)) {
    fail('Watcher run command touches PE-year rows or snapshot promotion');
  }
  if (/EventBridge|put-rule|events:PutRule/i.test(commandCode)) {
    fail('Watcher run command installs a production schedule');
  }
}

// ── 7. Gates and evidence ───────────────────────────────────────────────────
for (const gate of [
  'scripts/test-phase8-session7-lifecycle-domain.mjs',
  'scripts/prepare-phase8-session7-lifecycle-corpus.mjs',
  'scripts/phase8-session7-lifecycle-replay.mjs',
  'scripts/verify-phase8-session7-db.mjs',
  'scripts/verify-phase8-session7-db.sh',
  'apps/defense-api/src/budget-lifecycle/lifecycle-watcher.spec.ts',
]) {
  if (!exists(gate)) fail(`Missing Session 7 gate: ${gate}`);
}

const corpusPath = 'docs/defense-budget/phase8-session7-lifecycle-corpus.json';
if (!exists(corpusPath)) {
  fail(`Missing Session 7 lifecycle corpus: ${corpusPath}`);
} else {
  const corpus = JSON.parse(read(corpusPath));
  if (corpus.schemaVersion !== 'phase8_session7_lifecycle_corpus_v1') {
    fail('Unexpected Session 7 corpus schemaVersion');
  }
  const officialHost = /^https:\/\/((www\.)?(govinfo\.gov|congress\.gov)|comptroller\.defense\.gov|asafm\.army\.mil|(www\.)?secnav\.navy\.mil|(www\.)?saffm\.hq\.af\.mil)\//;
  const stages = new Set();
  const tracks = new Set();
  for (const source of corpus.sources ?? []) {
    if (!officialHost.test(source.officialUrl)) {
      fail(`Corpus source is not an official publisher URL: ${source.sourceKey}`);
    }
    if (!source.availableFrom || !source.stage || !source.authorityTrack) {
      fail(`Corpus source lacks lifecycle identity: ${source.sourceKey ?? '<unknown>'}`);
    }
    if (source.expectedDecision !== 'accept' && source.expectedDecision !== 'review') {
      fail(`Corpus source has no expected classification decision: ${source.sourceKey}`);
    }
    for (const key of Object.keys(source)) {
      if (/amount|usd|dollar/i.test(key)) {
        fail(`Corpus source declares a monetary field (${key}): ${source.sourceKey}`);
      }
    }
    stages.add(source.stage);
    tracks.add(source.authorityTrack);
  }
  // The replay must cover a full lifecycle plus the independent second track and
  // an alternative-funding vehicle.
  for (const stage of [
    'president_budget_request', 'hasc_report', 'sasc_report', 'house_auth_action',
    'auth_enacted', 'hac_d_report', 'sac_d_report', 'appr_enacted',
  ]) {
    if (!stages.has(stage)) fail(`Replay corpus is missing lifecycle stage ${stage}`);
  }
  for (const track of ['request', 'authorization', 'appropriations', 'alternative_funding']) {
    if (!tracks.has(track)) fail(`Replay corpus is missing authority track ${track}`);
  }
  // At least one source must be a genuine review case, and one a genuine
  // supersession of the same logical source.
  if (!(corpus.sources ?? []).some((source) => source.expectedDecision === 'review')) {
    fail('Replay corpus contains no source that must stop in review');
  }
  if (!(corpus.sources ?? []).some((source) => source.supersedes)) {
    fail('Replay corpus contains no official superseding version');
  }
}

const evidencePath =
  process.env.PHASE8_SESSION7_REPLAY_EVIDENCE ||
  'docs/defense-budget/phase8-session7-lifecycle-replay-evidence.json';
if (enforceReplay) {
  if (!exists(evidencePath)) {
    fail(`Session 7 replay evidence is required under --enforce-replay: ${evidencePath}`);
  } else {
    const evidence = JSON.parse(read(evidencePath));
    if (evidence.schemaVersion !== 'phase8_session7_lifecycle_replay_evidence_v1') {
      fail('Unexpected Session 7 replay evidence schemaVersion');
    }
    if (evidence.failed !== 0) fail(`Session 7 replay evidence records ${evidence.failed} failures`);
    if (!(evidence.checks > 40)) fail(`Session 7 replay evidence is too thin (${evidence.checks} checks)`);
    if (evidence.nvidiaRouting !== 'disabled') fail('Replay evidence does not record NVIDIA routing disabled');
    if (evidence.activeGpuCapacity !== 0) fail('Replay evidence records non-zero GPU capacity');
    if (evidence.awsMutated !== false) fail('Replay evidence records an AWS mutation');
    if (evidence.productionDatabaseMutated !== false) {
      fail('Replay evidence records a production database mutation');
    }
    for (const source of evidence.sources ?? []) {
      if (!/^[0-9a-f]{64}$/.test(source.sourceSha256 ?? '')) {
        fail(`Replay evidence source has no pinned sha256: ${source.sourceKey}`);
      }
    }
  }
} else {
  notes.push(
    'Real-source lifecycle replay not enforced; rerun with --enforce-replay before declaring Session 7 complete',
  );
}

// ── 8. Preserve accepted Session 5 provider decision ────────────────────────
for (const file of [
  'packages/defense-domain/src/budget-lifecycle/watcher.ts',
  'apps/defense-api/src/budget-lifecycle/lifecycle-watcher.service.ts',
  'apps/defense-api/scripts/run-lifecycle-watcher.mjs',
]) {
  const content = stripComments(read(file));
  if (/NVIDIA_PARSING_ENABLED\s*=\s*true|nvidiaRouting\s*[:=]\s*'(preferred|fallback|benchmark)'/.test(content)) {
    fail(`${file} re-enables NVIDIA routing, contradicting the accepted Session 5 decision`);
  }
  if (/CreateEndpoint|CreateTransformJob|createEndpointConfig/i.test(content)) {
    fail(`${file} creates a SageMaker endpoint or transform job`);
  }
}

for (const note of notes) console.log(`[phase8-session7] ${note}`);
if (failures.length) {
  console.error(`\n[phase8-session7] FAILED (${failures.length})`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log('[phase8-session7] SESSION7_LIFECYCLE_CONTROL_PLANE_PASS');
