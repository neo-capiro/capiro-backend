import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { nativeCanonicalSha256, sameJson, type NativeRunBinding } from '../native-approvals/native-approval.contract.js';
import {
  meriAllocationBudgets,
  parseMeriQualification,
  type MeriCapabilityBudgets,
  type MeriQualificationBinding,
} from './meri-execution-capability.js';

interface BudgetRow { quarantined: boolean; db_now: Date }
interface AdmittedRow {
  run_id: string;
  attempt: number;
  worker_arn: string;
  fence: number;
  policy_revision: string;
  allocation: unknown;
  allocation_sha256: string;
  started_at: Date;
}
interface GrantRow {
  grant_id: string;
  run_id: string;
  attempt: number;
  worker_arn: string;
  fence: number;
  policy_revision: string;
  capability_sha256: string;
  expires_at: Date;
  state: string;
  bound_grant_id: string | null;
  bound_run_id: string | null;
  facts: unknown;
}

export interface MeriAdmittedRun {
  allocation: unknown;
  allocationSha256: string;
  budgets: MeriCapabilityBudgets;
  qualification: MeriQualificationBinding;
  /** min(started_at + maxRuntimeSeconds, schedule.expiresAt, every admitted grant's expires_at): Meri's admission deadline. */
  deadlineMs: number;
  /** Database clock read under the budget lock; every currentness check uses it. */
  dbNowMs: number;
}

/** The capability whose own execution grant must be current (receiver only). */
export interface MeriExecutionGrantExpectation {
  jti: string;
  capabilitySha256: string;
}

const notAdmitted = () => new ConflictException('Execution run is not admitted');
const unavailable = () => new ServiceUnavailableException('Execution run admission unavailable');

/**
 * Meri's canonical admission predicate (meri-greenfield
 * `apps/gateway/budget/admitted-run-current.mjs` `readCurrentAdmission`, and
 * `execution-grant-admission.mjs`), read by Core on its own transaction. Core
 * never takes the allocation, qualification or deadline from the caller (dot
 * #121 6247464370 item 2, 6247803584).
 *
 * Serialization: the first read takes `FOR SHARE` on the single budget row,
 * which conflicts with the `FOR UPDATE` Meri's admission, revocation, grant
 * installation and fence changes take first. Until Core's transaction ends,
 * none of them can commit in between, so the rows below stay current through
 * the effect.
 *
 * Checks, all against the database clock read under that lock:
 *  - the budget is not quarantined;
 *  - one `runs` row and one `tool_run_allocations` row; the stored hash is the
 *    RFC 8785 hash of the stored allocation; the allocation's run is the
 *    executor's; the qualification is the executor's run and fence at the
 *    expected policy revision;
 *  - every grant on the run that is not a Core-issued execution capability is
 *    an admitted grant: ACTIVE, unexpired, bound to this run in
 *    `tool_grant_bindings`, with facts whose binding is EXACTLY the executor
 *    binding (this authenticates attemptId, workerId and writerFence), whose
 *    qualification is the run row's, whose allocation hash is the allocation's
 *    and whose capability digest is the row's; at least one exists;
 *  - when `expect` is given, that capability's own execution grant exists, is
 *    ACTIVE and unexpired, and carries the token's digest and the same facts;
 *  - the deadline is ahead.
 * Until Core's database role may read these tables (and lock the budget row),
 * every call fails closed with 503.
 */
export async function readMeriAdmittedRun(
  tx: Prisma.TransactionClient,
  binding: NativeRunBinding,
  policyRevision: string,
  options: { tenantId: string; expect?: MeriExecutionGrantExpectation },
): Promise<MeriAdmittedRun> {
  let budget: BudgetRow[];
  let rows: AdmittedRow[];
  let grants: GrantRow[];
  try {
    budget = await tx.$queryRaw<BudgetRow[]>`
      SELECT quarantined, clock_timestamp() AS db_now FROM meri_product_budget.budget WHERE id = 1 FOR SHARE`;
    rows = await tx.$queryRaw<AdmittedRow[]>`
      SELECT r.run_id::text AS run_id, r.attempt, r.worker_arn, r.fence, r.policy_revision::text AS policy_revision,
             a.allocation, a.allocation_sha256::text AS allocation_sha256, a.started_at
        FROM meri_product_budget.runs r
        JOIN meri_product_budget.tool_run_allocations a ON a.run_id = r.run_id
       WHERE r.run_id = ${binding.runId}::uuid
       LIMIT 2`;
    grants = await tx.$queryRaw<GrantRow[]>`
      SELECT g.grant_id::text AS grant_id, g.run_id::text AS run_id, g.attempt, g.worker_arn, g.fence,
             g.policy_revision::text AS policy_revision, g.capability_sha256::text AS capability_sha256, g.expires_at, g.state,
             b.grant_id::text AS bound_grant_id, b.run_id::text AS bound_run_id, b.facts
        FROM meri_product_budget.grants g
        LEFT JOIN meri_product_budget.tool_grant_bindings b ON b.grant_id = g.grant_id
       WHERE g.run_id = ${binding.runId}::uuid
       ORDER BY g.grant_id
       LIMIT 65`;
  } catch {
    throw unavailable();
  }
  if (!Array.isArray(budget) || budget.length !== 1 || budget[0]!.quarantined !== false || !(budget[0]!.db_now instanceof Date)) {
    throw notAdmitted();
  }
  const dbNowMs = budget[0]!.db_now.getTime();
  if (!Array.isArray(rows) || rows.length !== 1) throw notAdmitted();
  const row = rows[0]!;
  if (row.run_id !== binding.runId || typeof row.allocation_sha256 !== 'string' ||
      nativeCanonicalSha256(row.allocation) !== row.allocation_sha256 || !(row.started_at instanceof Date) ||
      row.started_at.getTime() > dbNowMs) throw notAdmitted();
  let budgets: MeriCapabilityBudgets;
  let qualification: MeriQualificationBinding;
  try {
    budgets = meriAllocationBudgets(row.allocation, binding);
    qualification = parseMeriQualification({
      runId: row.run_id, attempt: row.attempt, workerArn: row.worker_arn, fence: row.fence, policyRevision: row.policy_revision,
    }, binding, policyRevision);
  } catch {
    throw notAdmitted();
  }
  let deadlineMs = Math.min(
    row.started_at.getTime() + budgets.maxRuntimeSeconds * 1000,
    Date.parse((row.allocation as { schedule: { expiresAt?: unknown } }).schedule.expiresAt as string),
  );

  // Core-issued execution capabilities on this run; every other grant is admitted.
  const issued = await tx.clioMeriExecutionIssuance.findMany({
    where: { tenantId: options.tenantId, runId: binding.runId }, select: { jti: true },
  });
  const executionIds = new Set(issued.map((r) => r.jti));
  if (!Array.isArray(grants) || grants.length > 64) throw notAdmitted();
  const current = (g: GrantRow, facts: Record<string, unknown>) =>
    g.run_id === binding.runId && g.bound_grant_id === g.grant_id && g.bound_run_id === binding.runId &&
    g.attempt === qualification.attempt && g.worker_arn === qualification.workerArn && g.fence === qualification.fence &&
    g.policy_revision === qualification.policyRevision && g.state === 'ACTIVE' &&
    g.expires_at instanceof Date && g.expires_at.getTime() > dbNowMs &&
    facts.grantId === g.grant_id && facts.capabilitySha256 === g.capability_sha256 &&
    facts.allocationSha256 === row.allocation_sha256 && sameJson(facts.qualificationBinding, qualification) &&
    sameJson(facts.binding, binding);
  const factsOf = (g: GrantRow): Record<string, unknown> =>
    g.facts && typeof g.facts === 'object' && !Array.isArray(g.facts) ? g.facts as Record<string, unknown> : {};
  const admitted = grants.filter((g) => !executionIds.has(g.grant_id));
  if (admitted.length < 1 || admitted.some((g) => !current(g, factsOf(g)))) throw notAdmitted();
  for (const g of admitted) deadlineMs = Math.min(deadlineMs, g.expires_at.getTime());
  if (options.expect) {
    const own = grants.filter((g) => g.grant_id === options.expect!.jti);
    if (own.length !== 1 || !current(own[0]!, factsOf(own[0]!)) || own[0]!.capability_sha256 !== options.expect.capabilitySha256) {
      throw notAdmitted();
    }
  }
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= dbNowMs) throw notAdmitted();
  return { allocation: row.allocation, allocationSha256: row.allocation_sha256, budgets, qualification, deadlineMs, dbNowMs };
}
