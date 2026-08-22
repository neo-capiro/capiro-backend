#!/usr/bin/env node
/**
 * Governed Phase 8 Session 11 review-resolution command.
 *
 * This is the ONLY way to move an expected source out of `review_required`.
 * There is deliberately no HTTP route for it: the Session 7 migration grants
 * `capiro_defense_serve` (the role the HTTP process resolves to once the
 * deferred connection cutover lands) SELECT-only on every table this domain
 * touches, and `capiro_defense_job` — the role this script's connection
 * represents — is the only writer. Building an HTTP mutation route here
 * would contradict that grant's own stated intent even though the cutover
 * that would make Postgres itself reject it has not landed yet (same
 * deferred-cutover state Session 2's own closeout already recorded).
 *
 * Two independent safety layers, same philosophy as Sessions 8 and 10's
 * commands:
 *
 *  1. `--list` is read-only: it reads real review_required rows and reports
 *     them. No write, no authorisation needed.
 *  2. Resolving one item requires `--commit` AND
 *     `PHASE8_SESSION11_REVIEW_RESOLUTION_AUTHORIZED=true`. Without
 *     `--commit` the command validates its arguments and the item's current
 *     state and reports what it WOULD do, but writes nothing.
 *
 * The state write goes through the exact, frozen Session 7
 * `LifecycleStore.setExpectedSourceState` — the same method the watcher
 * itself calls to move a source INTO review. This script does not
 * reimplement that transition; it is a second, human-directed caller of it.
 *
 * The state write and the audit-log write are two separate statements, not
 * one transaction: `setExpectedSourceState` returns void rather than an
 * unawaited Prisma promise, so it cannot be composed into `$transaction([])`
 * without changing the frozen `LifecycleStore` interface, which this session
 * does not do. The precondition re-check below (refuse unless the item is
 * STILL `review_required`) makes a retry after a partial failure safe rather
 * than relying on atomicity: a retry either finds the same review_required
 * row (safe to resolve again) or finds it already resolved (refuses loudly
 * instead of double-writing).
 *
 * Usage:
 *   node apps/defense-api/scripts/run-review-resolution.mjs --list
 *   node apps/defense-api/scripts/run-review-resolution.mjs --list --fiscal-year 2027
 *   node apps/defense-api/scripts/run-review-resolution.mjs \
 *     --expected-source-id <uuid> --decision published \
 *     --note "verified against the publisher's own package page" \
 *     --actor-user-id <uuid> --tenant-id <uuid>
 *   PHASE8_SESSION11_REVIEW_RESOLUTION_AUTHORIZED=true \
 *     node apps/defense-api/scripts/run-review-resolution.mjs \
 *     --expected-source-id <uuid> --decision published \
 *     --note "verified against the publisher's own package page" \
 *     --actor-user-id <uuid> --tenant-id <uuid> --commit
 */
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, '..');

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name, fallback = null) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] && !argv[index + 1].startsWith('--')
    ? argv[index + 1]
    : fallback;
};

const RESOLVABLE_STATES = ['expected', 'not_filed', 'published', 'withdrawn', 'unavailable'];

const commit = flag('commit');
if (commit && process.env.PHASE8_SESSION11_REVIEW_RESOLUTION_AUTHORIZED !== 'true') {
  throw new Error(
    'Refusing Session 11 database mutation without PHASE8_SESSION11_REVIEW_RESOLUTION_AUTHORIZED=true',
  );
}

const { PrismaClient } = require(path.join(appRoot, 'generated/prisma-client/index.js'));
const { PrismaLifecycleStore } = require(
  path.join(appRoot, 'dist/budget-lifecycle/prisma-lifecycle.store.js'),
);
const { PrismaBudgetLifecycleReadStore } = require(
  path.join(appRoot, 'dist/budget-lifecycle-product/prisma-budget-lifecycle-read.store.js'),
);

const prisma = new PrismaClient();
const readStore = new PrismaBudgetLifecycleReadStore(prisma);
const lifecycleStore = new PrismaLifecycleStore(prisma);

try {
  if (flag('list')) {
    const fiscalYearArg = value('fiscal-year');
    if (!fiscalYearArg) {
      throw new Error('--list requires --fiscal-year <year>: the review queue is scoped per cycle');
    }
    const queue = await readStore.listReviewQueue(Number(fiscalYearArg));
    if (queue.length === 0) {
      console.log(`[phase8-session11] no review_required items for FY${fiscalYearArg}`);
    }
    for (const entry of queue) {
      console.log(
        `${entry.expectedSource.id}  ${entry.expectedSource.authorityTrack.padEnd(20)} ` +
          `${entry.expectedSource.stage.padEnd(24)} ${entry.expectedSource.label}`,
      );
      console.log(`  reason: ${entry.expectedSource.reviewReason ?? '(none recorded)'}`);
      console.log(`  observation reasons: ${entry.observation.reviewReasons.join('; ')}`);
      console.log(`  discoveredUrl: ${entry.observation.discoveredUrl}`);
      console.log(`  contentSha256: ${entry.observation.contentSha256}`);
    }
    console.log('SESSION11_REVIEW_LIST_PASS');
    process.exit(0);
  }

  const expectedSourceId = value('expected-source-id');
  const decision = value('decision');
  const note = value('note');
  const actorUserId = value('actor-user-id');
  const tenantId = value('tenant-id');

  if (!expectedSourceId || !decision || !note || !actorUserId || !tenantId) {
    console.error(
      'usage: --list --fiscal-year <year>\n' +
        '   or: --expected-source-id <uuid> --decision <state> --note <text> ' +
        '--actor-user-id <uuid> --tenant-id <uuid> [--commit]',
    );
    process.exit(2);
  }
  if (!RESOLVABLE_STATES.includes(decision)) {
    throw new Error(
      `--decision must be one of ${RESOLVABLE_STATES.join(', ')} (review_required is the state being resolved OUT of, not into)`,
    );
  }

  const current = await readStore.getExpectedSourceById(expectedSourceId);
  if (!current) throw new Error(`Expected source ${expectedSourceId} not found`);
  if (current.expectedState !== 'review_required') {
    throw new Error(
      `Expected source ${expectedSourceId} is '${current.expectedState}', not 'review_required' — ` +
        'nothing to resolve (a concurrent resolution or a new watcher run may already have moved it)',
    );
  }

  console.log(
    `[phase8-session11] ${commit ? 'RESOLVING' : 'DRY_RUN'} ${expectedSourceId} ` +
      `'${current.expectedState}' -> '${decision}'`,
  );
  console.log(`  label: ${current.label}`);
  console.log(`  current review reason: ${current.reviewReason ?? '(none recorded)'}`);
  console.log(`  operator note: ${note}`);

  if (!commit) {
    console.log('SESSION11_REVIEW_RESOLUTION_DRY_RUN_PASS');
    process.exit(0);
  }

  await lifecycleStore.setExpectedSourceState({
    expectedSourceId,
    expectedState: decision,
    reviewReason: null,
  });

  // Append-only, job-role-only (Session 11's own migration): `audit_logs`
  // has no INSERT grant for capiro_defense_job (that table's grants serve
  // the older PE-Budget-Phase-7 admin flows on the HTTP/serve path), so this
  // resolution needs its own narrow record — same precedent as Session 9's
  // `defense_provider_invocation`.
  await prisma.$executeRawUnsafe(
    `INSERT INTO defense_budget_review_resolution
       (expected_source_id, previous_expected_state, decision, review_reason_before, note, actor_user_id, tenant_id)
     VALUES ($1::uuid, $2, $3, $4, $5, $6::uuid, $7::uuid)`,
    expectedSourceId, current.expectedState, decision, current.reviewReason, note, actorUserId, tenantId,
  );

  console.log('SESSION11_REVIEW_RESOLUTION_COMMITTED');
  process.exit(0);
} finally {
  await prisma.$disconnect();
}
