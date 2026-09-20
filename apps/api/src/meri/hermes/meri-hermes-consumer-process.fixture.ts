/**
 * A REAL, separate OS process that holds a Hermes run's consumer lease.
 *
 * Why this file exists: recovery from a dead consuming replica was only ever
 * exercised by calling the recovery method directly, in the same process, on a
 * row whose heartbeat a test had backdated by hand. That proves the SQL, not
 * the failure. This fixture lets a spec do the real thing — start another
 * process, let it genuinely claim and heartbeat the lease through the
 * production repository, then SIGKILL it with no cleanup, no finally block and
 * no chance to release anything — and then assert that the surviving replica
 * notices and closes the run out honestly.
 *
 * Run by `meri-hermes-ownership-and-finalization.spec.ts` via
 * `node node_modules/tsx/dist/cli.mjs <this file> <runId> <consumerId>`.
 * It is NOT a spec (jest collects `*.spec.ts` only) and is never imported by
 * application code.
 *
 * Protocol on stdout, one line each:
 *   READY <consumerId>     the lease is claimed and heartbeating
 *   FAILED <reason>        the lease could not be claimed
 */
import { PrismaService } from '../../prisma/prisma.service.js';
import { MeriHermesPrismaRunRepository } from './meri-hermes-prisma-run-repository.js';

/** Well under any stale threshold a spec would use, so the lease stays fresh while alive. */
const HEARTBEAT_MS = 200;
/** Safety net: never outlive the spec that spawned us, even if it dies first. */
const MAX_LIFETIME_MS = 120_000;

async function main(): Promise<void> {
  const [runId, consumerId] = process.argv.slice(2);
  if (!runId || !consumerId) {
    process.stdout.write('FAILED missing-arguments\n');
    process.exit(2);
  }

  const prisma = new PrismaService();
  await prisma.$connect();
  const repo = new MeriHermesPrismaRunRepository(prisma);

  // The production claim, through the production repository — not a hand-written
  // UPDATE — so what this process holds is exactly what a real replica holds.
  const claimed = await repo.claimConsumer(runId, consumerId, 60_000);
  if (!claimed) {
    // Say WHY, so a spec failure here names the cause instead of just
    // "rejected" (run invisible from this process vs. already leased vs.
    // already terminal).
    const seen = await repo.get(runId).catch((error: unknown) => `error:${String(error).slice(0, 120)}`);
    const detail =
      typeof seen === 'string'
        ? seen
        : seen === null
          ? 'run-not-visible-from-this-process'
          : `status=${seen.status} consumer=${seen.consumerId ?? 'null'} heartbeat=${seen.consumerHeartbeatAt ?? 'null'}`;
    process.stdout.write(`FAILED claim-rejected ${detail.replace(/\s+/g, ' ')}\n`);
    await prisma.$disconnect();
    process.exit(3);
  }

  const heartbeat = setInterval(() => {
    void repo.heartbeatConsumer(runId, consumerId).catch(() => undefined);
  }, HEARTBEAT_MS);

  // Deliberately NOT unref'd and deliberately without any SIGTERM/exit handler:
  // this process must die abruptly, holding the lease, exactly like a replica
  // that was killed.
  setTimeout(() => {
    clearInterval(heartbeat);
    void prisma.$disconnect().finally(() => process.exit(0));
  }, MAX_LIFETIME_MS);

  process.stdout.write(`READY ${consumerId}\n`);
}

void main().catch((error: unknown) => {
  process.stdout.write(`FAILED ${String(error).slice(0, 200).replace(/\s+/g, ' ')}\n`);
  process.exit(1);
});
