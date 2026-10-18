import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { nativeCanonicalSha256, sameJson, type NativeRunBinding } from '../native-approvals/native-approval.contract.js';
import {
  meriAllocationBudgets,
  parseMeriQualification,
  type MeriCapabilityBudgets,
  type MeriQualificationBinding,
} from './meri-execution-capability.js';

export const MERI_ADMISSION_SNAPSHOT_CONTRACT = 'capiro.meri-core-admission-snapshot.v1';

interface SnapshotGrant {
  grantId: string;
  runId: string;
  attempt: number;
  workerArn: string;
  fence: number;
  policyRevision: string;
  capabilitySha256: string;
  expiresAtMs: number;
  state: string;
  boundGrantId: string | null;
  boundRunId: string | null;
  facts: unknown;
}

export interface MeriAdmittedRun {
  allocation: unknown;
  allocationSha256: string;
  budgets: MeriCapabilityBudgets;
  qualification: MeriQualificationBinding;
  /** min(started_at + maxRuntimeSeconds, schedule.expiresAt, every admitted grant's expires_at): Meri's admission deadline. */
  deadlineMs: number;
  /** Database clock read after the budget lock; every currentness check uses it. */
  dbNowMs: number;
}

/** The capability whose own execution grant must be current (receiver only). */
export interface MeriExecutionGrantExpectation {
  jti: string;
  capabilitySha256: string;
}

const notAdmitted = () => new ConflictException('Execution run is not admitted');
const unavailable = () => new ServiceUnavailableException('Execution run admission unavailable');
const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const closed = (v: unknown, keys: readonly string[]): Record<string, unknown> => {
  if (!plain(v) || Object.keys(v).length !== keys.length || Object.keys(v).some((k) => !keys.includes(k))) throw notAdmitted();
  return v;
};
const ms = (v: unknown): number => {
  if (!Number.isSafeInteger(v)) throw notAdmitted();
  return v as number;
};

/**
 * Meri's canonical admission predicate (meri-greenfield
 * `apps/gateway/budget/admitted-run-current.mjs` `readCurrentAdmission`, and
 * `execution-grant-admission.mjs`), evaluated by Core over ONE call on its
 * own transaction: Meri's SECURITY DEFINER function
 * `meri_core_authority.current_admission_v1(run_id)` (proposal
 * docs/integration/CORE-ADMISSION-SNAPSHOT-FUNCTION-20261018.sql; dot #121
 * 6248138427 / 6248171459). Core never takes the allocation, qualification or
 * deadline from the caller (dot 6247464370 item 2, 6247803584).
 *
 * Serialization: the function takes `FOR SHARE` on the single budget row
 * first (Meri's admission, revocation, grant installation and fence changes
 * take it `FOR UPDATE`), then reads the clock in a separate statement. The
 * row lock belongs to Core's transaction, so none of those changes can commit
 * until Core's effect has. Core takes its proposal lock before calling.
 *
 * Checks, all against the snapshot's database clock:
 *  - the budget row exists and is not quarantined;
 *  - one run and one allocation; the stored hash is the RFC 8785 hash of the
 *    stored allocation; the allocation's run is the executor's; the
 *    qualification is the executor's run and fence at the expected revision;
 *  - every grant on the run that is not a Core-issued execution capability is
 *    an admitted grant: ACTIVE, unexpired, bound to this run, with facts whose
 *    binding is EXACTLY the executor binding (authenticating attemptId,
 *    workerId and writerFence), whose qualification is the run row's, whose
 *    allocation hash is the allocation's and whose digest is the row's; at
 *    least one exists;
 *  - when `expect` is given, that capability's own execution grant exists, is
 *    ACTIVE and unexpired, and carries the token's digest and the same facts;
 *  - the deadline is ahead.
 * Until the function exists and Core's role may execute it, every call fails
 * closed with 503.
 */
export async function readMeriAdmittedRun(
  tx: Prisma.TransactionClient,
  binding: NativeRunBinding,
  policyRevision: string,
  options: { tenantId: string; expect?: MeriExecutionGrantExpectation },
): Promise<MeriAdmittedRun> {
  let raw: unknown;
  try {
    const rows = await tx.$queryRaw<Array<{ snapshot: unknown }>>`
      SELECT meri_core_authority.current_admission_v1(${binding.runId}::uuid) AS snapshot`;
    if (!Array.isArray(rows) || rows.length !== 1) throw new Error('snapshot');
    raw = rows[0]!.snapshot;
  } catch {
    throw unavailable();
  }
  const snap = closed(raw, ['contract', 'budgetPresent', 'quarantined', 'dbNowMs', 'run', 'allocation', 'grants']);
  if (snap.contract !== MERI_ADMISSION_SNAPSHOT_CONTRACT) throw unavailable();
  if (snap.budgetPresent !== true || snap.quarantined !== false) throw notAdmitted();
  const dbNowMs = ms(snap.dbNowMs);
  if (snap.run === null || snap.allocation === null) throw notAdmitted();
  const run = closed(snap.run, ['runId', 'attempt', 'workerArn', 'fence', 'policyRevision']);
  const alloc = closed(snap.allocation, ['allocation', 'allocationSha256', 'startedAtMs']);
  const startedAtMs = ms(alloc.startedAtMs);
  if (run.runId !== binding.runId || typeof alloc.allocationSha256 !== 'string' ||
      nativeCanonicalSha256(alloc.allocation) !== alloc.allocationSha256 || startedAtMs > dbNowMs) throw notAdmitted();
  let budgets: MeriCapabilityBudgets;
  let qualification: MeriQualificationBinding;
  try {
    budgets = meriAllocationBudgets(alloc.allocation, binding);
    qualification = parseMeriQualification({ ...run }, binding, policyRevision);
  } catch {
    throw notAdmitted();
  }
  let deadlineMs = Math.min(
    startedAtMs + budgets.maxRuntimeSeconds * 1000,
    Date.parse((alloc.allocation as { schedule: { expiresAt?: unknown } }).schedule.expiresAt as string),
  );

  if (!Array.isArray(snap.grants) || snap.grants.length > 64) throw notAdmitted();
  const grants = snap.grants.map((g) => closed(g, ['grantId', 'runId', 'attempt', 'workerArn', 'fence', 'policyRevision',
    'capabilitySha256', 'expiresAtMs', 'state', 'boundGrantId', 'boundRunId', 'facts']) as unknown as SnapshotGrant);
  // Core-issued execution capabilities on this run; every other grant is admitted.
  const issued = await tx.clioMeriExecutionIssuance.findMany({
    where: { tenantId: options.tenantId, runId: binding.runId }, select: { jti: true },
  });
  const executionIds = new Set(issued.map((r) => r.jti));
  const factsOf = (g: SnapshotGrant): Record<string, unknown> => (plain(g.facts) ? g.facts : {});
  const current = (g: SnapshotGrant) => {
    const facts = factsOf(g);
    return g.runId === binding.runId && g.boundGrantId === g.grantId && g.boundRunId === binding.runId &&
      g.attempt === qualification.attempt && g.workerArn === qualification.workerArn && g.fence === qualification.fence &&
      g.policyRevision === qualification.policyRevision && g.state === 'ACTIVE' &&
      Number.isSafeInteger(g.expiresAtMs) && g.expiresAtMs > dbNowMs &&
      facts.grantId === g.grantId && facts.capabilitySha256 === g.capabilitySha256 &&
      facts.allocationSha256 === alloc.allocationSha256 && sameJson(facts.qualificationBinding, qualification) &&
      sameJson(facts.binding, binding);
  };
  const admitted = grants.filter((g) => !executionIds.has(g.grantId));
  if (admitted.length < 1 || admitted.some((g) => !current(g))) throw notAdmitted();
  for (const g of admitted) deadlineMs = Math.min(deadlineMs, g.expiresAtMs);
  if (options.expect) {
    const own = grants.filter((g) => g.grantId === options.expect!.jti);
    if (own.length !== 1 || !current(own[0]!) || own[0]!.capabilitySha256 !== options.expect.capabilitySha256) throw notAdmitted();
  }
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= dbNowMs) throw notAdmitted();
  return { allocation: alloc.allocation, allocationSha256: alloc.allocationSha256 as string, budgets, qualification, deadlineMs, dbNowMs };
}
