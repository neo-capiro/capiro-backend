/**
 * Real disposable-Postgres proof for PR #1327's governed single-row canary
 * claim (`claimRowById` / `ingestionOutboxClaimByIdSqlV1` /
 * `drainIngestionOutboxRowV1`).
 *
 * Mocked/jest specs already prove the SQL shape and the worker's control
 * flow (see ingestion-outbox-drain-repository-prisma-v1.spec.ts and
 * ingestion-outbox-drain-worker-v1.spec.ts) but neither exercises a real
 * Postgres connection with two ELIGIBLE rows present at once. This script
 * closes that gap end to end against the real SQL statement
 * (`ingestionOutboxClaimByIdSqlV1`) and the real repository
 * (`createIngestionOutboxDrainRepositoryPrismaV1`), proving:
 *
 *   1. Two eligible pending rows exist (A, B).
 *   2. Explicitly targeting row B via claimRowById claims EXACTLY row B.
 *   3. Row A remains untouched (still 'pending', unleased).
 *   4. A second claimRowById call for row B (now leased, not yet expired)
 *      returns null -- it can never silently fall back to row A.
 *   5. A genuinely concurrent claim of row B (two real connections racing
 *      the same UPDATE ... FOR UPDATE ... SKIP LOCKED) fails closed: exactly
 *      one of the two callers wins, the other gets null, and Postgres's own
 *      locking -- not any application check -- is what enforces it.
 *
 * Usage:
 *   DATABASE_URL=postgresql://capiro:capiro@localhost:<port>/capiro \
 *     node --experimental-strip-types disposable-pg-proof-outbox-claim-by-id.mjs
 *
 * Cleans up its own fixture rows (fixed disposable UUIDs) before and after.
 */
import { PrismaClient } from '@prisma/client';
import {
  createIngestionOutboxDrainRepositoryPrismaV1,
} from '../src/defense-budget/ingestion-outbox-drain-repository-prisma-v1.js';

const FIXED = {
  cycleId: '00000000-0000-4000-8000-000000001327',
  expectedSourceId: '00000000-0000-4000-8000-000000001328',
  observationA: '00000000-0000-4000-8000-0000000013a1',
  observationB: '00000000-0000-4000-8000-0000000013b1',
  outboxA: '00000000-0000-4000-8000-0000000013a2',
  outboxB: '00000000-0000-4000-8000-0000000013b2',
};
const DEDUP = {
  cycle: 'a'.repeat(64),
  expected: 'b'.repeat(64),
  obsA: 'c'.repeat(63) + '1',
  obsB: 'c'.repeat(63) + '2',
  outboxA: 'd'.repeat(63) + '1',
  outboxB: 'd'.repeat(63) + '2',
  shaA: 'e'.repeat(64),
  shaB: 'f'.repeat(64),
};

function assert(cond, message) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${message}`);
  console.log(`OK: ${message}`);
}

async function cleanup(prisma) {
  await prisma.$executeRawUnsafe(
    `DELETE FROM "defense_budget_ingestion_outbox" WHERE "id" IN ($1::uuid, $2::uuid)`,
    FIXED.outboxA,
    FIXED.outboxB,
  );
  await prisma.$executeRawUnsafe(
    `DELETE FROM "defense_budget_source_observation" WHERE "id" IN ($1::uuid, $2::uuid)`,
    FIXED.observationA,
    FIXED.observationB,
  );
  await prisma.$executeRawUnsafe(
    `DELETE FROM "defense_budget_expected_source" WHERE "id" = $1::uuid`,
    FIXED.expectedSourceId,
  );
  await prisma.$executeRawUnsafe(
    `DELETE FROM "defense_budget_cycle" WHERE "id" = $1::uuid`,
    FIXED.cycleId,
  );
}

async function seed(prisma) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO "defense_budget_cycle"
      ("id","fiscal_year","authority_track","status","template_version","bootstrap_origin","dedup_key")
     VALUES ($1::uuid,2024,'request','active','v1','operator',$2)`,
    FIXED.cycleId,
    DEDUP.cycle,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO "defense_budget_expected_source"
      ("id","cycle_id","fiscal_year","authority_track","stage","source_family","adapter_id","label",
       "expected_state","optional","template_version","expected_from","expected_to","dedup_key")
     VALUES ($1::uuid,$2::uuid,2024,'request','president_budget_request','pb_r1','dod-comptroller',
             'PR1327 proof fixture','published',false,'v1',now(),now(),$3)`,
    FIXED.expectedSourceId,
    FIXED.cycleId,
    DEDUP.expected,
  );
  // Two DISTINCT, independently eligible observations (different SHA -> different rows).
  await prisma.$executeRawUnsafe(
    `INSERT INTO "defense_budget_source_observation"
      ("id","expected_source_id","cycle_id","adapter_id","discovered_url","content_sha256",
       "observation_state","revision_kind","dedup_key")
     VALUES ($1::uuid,$2::uuid,$3::uuid,'dod-comptroller','https://example.test/a',$4,
             'changed','first_discovery',$5)`,
    FIXED.observationA,
    FIXED.expectedSourceId,
    FIXED.cycleId,
    DEDUP.shaA,
    DEDUP.obsA,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO "defense_budget_source_observation"
      ("id","expected_source_id","cycle_id","adapter_id","discovered_url","content_sha256",
       "observation_state","revision_kind","dedup_key")
     VALUES ($1::uuid,$2::uuid,$3::uuid,'dod-comptroller','https://example.test/b',$4,
             'changed','first_discovery',$5)`,
    FIXED.observationB,
    FIXED.expectedSourceId,
    FIXED.cycleId,
    DEDUP.shaB,
    DEDUP.obsB,
  );
  // Two DISTINCT pending outbox rows, row A and row B -- the two "eligible rows" the brief requires.
  await prisma.$executeRawUnsafe(
    `INSERT INTO "defense_budget_ingestion_outbox"
      ("id","observation_id","observation_state","cycle_id","job_kind","state","dedup_key")
     VALUES ($1::uuid,$2::uuid,'changed',$3::uuid,'governed_source_ingestion','pending',$4)`,
    FIXED.outboxA,
    FIXED.observationA,
    FIXED.cycleId,
    DEDUP.outboxA,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO "defense_budget_ingestion_outbox"
      ("id","observation_id","observation_state","cycle_id","job_kind","state","dedup_key")
     VALUES ($1::uuid,$2::uuid,'changed',$3::uuid,'governed_source_ingestion','pending',$4)`,
    FIXED.outboxB,
    FIXED.observationB,
    FIXED.cycleId,
    DEDUP.outboxB,
  );
}

async function rowState(prisma, id) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT "id","state","leased_by" FROM "defense_budget_ingestion_outbox" WHERE "id" = $1::uuid`,
    id,
  );
  return rows[0] ?? null;
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const url = new URL(process.env.DATABASE_URL);
  const allowedHosts = new Set(['localhost', '127.0.0.1', '::1']);
  if (!allowedHosts.has(url.hostname)) {
    throw new Error(`refusing to run against non-local host ${url.hostname} (disposable-DB safety gate)`);
  }

  const prisma = new PrismaClient();
  const prisma2 = new PrismaClient(); // second real connection for the concurrency race
  try {
    await prisma.$connect();
    await prisma2.$connect();
    await cleanup(prisma);
    await seed(prisma);

    const repo = createIngestionOutboxDrainRepositoryPrismaV1(prisma);
    const repo2 = createIngestionOutboxDrainRepositoryPrismaV1(prisma2);

    // 1. Two eligible rows exist.
    const before = await Promise.all([rowState(prisma, FIXED.outboxA), rowState(prisma, FIXED.outboxB)]);
    assert(before[0].state === 'pending', 'row A starts pending');
    assert(before[1].state === 'pending', 'row B starts pending (two eligible rows present)');

    // 2 & 3. Explicitly target row B; row A must remain untouched.
    const claimedB = await repo.claimRowById({
      rowId: FIXED.outboxB,
      leaseOwner: 'proof-operator',
      now: new Date(),
    });
    assert(claimedB !== null && claimedB.id === FIXED.outboxB, 'targeting row B claims exactly row B');
    const afterFirstClaim = await Promise.all([
      rowState(prisma, FIXED.outboxA),
      rowState(prisma, FIXED.outboxB),
    ]);
    assert(afterFirstClaim[0].state === 'pending', 'row A remains untouched (still pending)');
    assert(afterFirstClaim[0].leased_by === null, 'row A was never leased');
    assert(
      afterFirstClaim[1].state === 'leased' && afterFirstClaim[1].leased_by === 'proof-operator',
      'row B is now leased by the operator',
    );

    // 4. Retry of row B (still leased, not expired) cannot select row A -- and cannot re-select B either.
    const retryClaimB = await repo.claimRowById({
      rowId: FIXED.outboxB,
      leaseOwner: 'proof-operator-retry',
      now: new Date(),
    });
    assert(retryClaimB === null, 'retrying row B while it is actively leased returns null, never falls back to row A');
    const afterRetry = await rowState(prisma, FIXED.outboxA);
    assert(afterRetry.state === 'pending' && afterRetry.leased_by === null, 'row A is STILL untouched after the retry attempt');

    // Release row B's lease (simulate lease expiry) so we can run the real concurrency race on it.
    await prisma.$executeRawUnsafe(
      `UPDATE "defense_budget_ingestion_outbox" SET "state"='pending', "leased_by"=NULL, "leased_until"=NULL WHERE "id"=$1::uuid`,
      FIXED.outboxB,
    );

    // 5. Concurrent claim of row B: two REAL connections race the same claimRowById call.
    // Postgres's FOR UPDATE ... SKIP LOCKED enforces exactly one winner; this is not an
    // application-level check, it is the database's own row lock deciding the race.
    const now = new Date();
    const [resultX, resultY] = await Promise.all([
      repo.claimRowById({ rowId: FIXED.outboxB, leaseOwner: 'racer-x', now }),
      repo2.claimRowById({ rowId: FIXED.outboxB, leaseOwner: 'racer-y', now }),
    ]);
    const winners = [resultX, resultY].filter((r) => r !== null);
    const losers = [resultX, resultY].filter((r) => r === null);
    assert(winners.length === 1, 'concurrent claim of row B: exactly one caller wins (fails closed, no double-claim)');
    assert(losers.length === 1, 'concurrent claim of row B: exactly one caller loses cleanly with null');
    const finalB = await rowState(prisma, FIXED.outboxB);
    assert(
      finalB.state === 'leased' && (finalB.leased_by === 'racer-x' || finalB.leased_by === 'racer-y'),
      `row B ends leased by exactly the winning racer (leased_by=${finalB.leased_by})`,
    );
    const finalA = await rowState(prisma, FIXED.outboxA);
    assert(
      finalA.state === 'pending' && finalA.leased_by === null,
      'row A remains completely untouched through the entire race',
    );

    console.log('\nALL PR#1327 claimRowById REAL-POSTGRES CONCURRENCY PROOFS PASSED.');
  } finally {
    await cleanup(prisma).catch((e) => console.warn('cleanup warning:', e.message));
    await prisma.$disconnect();
    await prisma2.$disconnect();
  }
}

main().catch((error) => {
  console.error('PROOF FAILED:', error);
  process.exit(1);
});
