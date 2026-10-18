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
 *  - Meri's saved ADMITTED allocation record (`meri_conversations.
 *    native_allocations`) for exactly this tenant/conversation/run is
 *    ADMITTED, its binding is EXACTLY the executor binding (authenticating
 *    attemptId, workerId and writerFence) and its allocation hash is the
 *    allocation's (dot 6248171459 item 2);
 *  - EVERY grant that record declares (`resource.grantFactsJsons`) exists and
 *    is ACTIVE, unexpired, bound to this run with exactly the declared facts,
 *    at the run row's qualification and the row's digest; a missing declared
 *    grant refuses;
 *  - every other grant on the run is a Core-issued execution capability;
 *    anything else refuses;
 *  - when `expect` is given, that capability's own execution grant exists, is
 *    ACTIVE and unexpired, and carries the token's digest and the same
 *    binding/qualification/allocation facts; its expiry joins the deadline;
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
      SELECT meri_core_authority.current_admission_v1(${binding.tenantId}::uuid, ${binding.conversationId}::uuid, ${binding.runId}::uuid) AS snapshot`;
    if (!Array.isArray(rows) || rows.length !== 1) throw new Error('snapshot');
    raw = rows[0]!.snapshot;
  } catch {
    throw unavailable();
  }
  const snap = closed(raw, ['contract', 'budgetPresent', 'quarantined', 'dbNowMs', 'admitted', 'run', 'allocation', 'grants']);
  if (snap.contract !== MERI_ADMISSION_SNAPSHOT_CONTRACT) throw unavailable();
  if (snap.budgetPresent !== true || snap.quarantined !== false) throw notAdmitted();
  const dbNowMs = ms(snap.dbNowMs);
  if (snap.run === null || snap.allocation === null || snap.admitted === null) throw notAdmitted();
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

  // Meri's saved ADMITTED record: the exact declared grant set.
  const record = closed(snap.admitted, ['state', 'binding', 'allocationSha256', 'grantFactsJsons']);
  if (record.state !== 'ADMITTED' || !sameJson(record.binding, binding) || record.allocationSha256 !== alloc.allocationSha256 ||
      !Array.isArray(record.grantFactsJsons) || record.grantFactsJsons.length < 1 || record.grantFactsJsons.length > 16) throw notAdmitted();
  let declared: Array<Record<string, unknown>>;
  try {
    declared = record.grantFactsJsons.map((text) => {
      if (typeof text !== 'string') throw new Error('facts');
      const f = JSON.parse(text) as unknown;
      return closed(f, ['grantId', 'binding', 'qualificationBinding', 'capabilitySha256', 'allocationSha256']);
    });
  } catch {
    throw notAdmitted();
  }
  if (new Set(declared.map((f) => f.grantId)).size !== declared.length) throw notAdmitted();

  if (!Array.isArray(snap.grants) || snap.grants.length > 64) throw notAdmitted();
  const grants = snap.grants.map((g) => closed(g, ['grantId', 'runId', 'attempt', 'workerArn', 'fence', 'policyRevision',
    'capabilitySha256', 'expiresAtMs', 'state', 'boundGrantId', 'boundRunId', 'facts']) as unknown as SnapshotGrant);
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
  // Every declared grant: present, current, and bound to exactly the declared facts.
  for (const f of declared) {
    const rows = grants.filter((g) => g.grantId === f.grantId);
    if (rows.length !== 1 || !current(rows[0]!) || !sameJson(factsOf(rows[0]!), f)) throw notAdmitted();
    deadlineMs = Math.min(deadlineMs, rows[0]!.expiresAtMs);
  }
  // Every undeclared grant must be a Core-issued execution capability of this run.
  const declaredIds = new Set(declared.map((f) => f.grantId));
  const issued = await tx.clioMeriExecutionIssuance.findMany({
    where: { tenantId: options.tenantId, runId: binding.runId }, select: { jti: true },
  });
  const executionIds = new Set(issued.map((r) => r.jti));
  if (grants.some((g) => !declaredIds.has(g.grantId) && !executionIds.has(g.grantId))) throw notAdmitted();
  if (options.expect) {
    const own = grants.filter((g) => g.grantId === options.expect!.jti);
    if (declaredIds.has(options.expect.jti) || own.length !== 1 || !current(own[0]!) ||
        own[0]!.capabilitySha256 !== options.expect.capabilitySha256) throw notAdmitted();
    deadlineMs = Math.min(deadlineMs, own[0]!.expiresAtMs);
  }
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= dbNowMs) throw notAdmitted();
  return { allocation: alloc.allocation, allocationSha256: alloc.allocationSha256 as string, budgets, qualification, deadlineMs, dbNowMs };
}
