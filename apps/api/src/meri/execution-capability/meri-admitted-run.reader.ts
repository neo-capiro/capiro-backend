import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { nativeCanonicalSha256, type NativeRunBinding } from '../native-approvals/native-approval.contract.js';
import {
  meriAllocationBudgets,
  parseMeriQualification,
  type MeriCapabilityBudgets,
  type MeriQualificationBinding,
} from './meri-execution-capability.js';

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

export interface MeriAdmittedRun {
  allocation: unknown;
  allocationSha256: string;
  budgets: MeriCapabilityBudgets;
  qualification: MeriQualificationBinding;
  /** min(started_at + maxRuntimeSeconds, schedule.expiresAt), as Meri's admission computes it. */
  deadlineMs: number;
}

const notAdmitted = () => new ConflictException('Execution run is not admitted');

/**
 * The run's admitted allocation and qualification facts, read from Meri's own
 * owner tables (meri-greenfield `apps/gateway/budget/migrations/
 * 0001_product_budget.sql`: `meri_product_budget.runs` and
 * `meri_product_budget.tool_run_allocations`, the rows Meri's
 * `readCurrentAdmission` checks). This is the authenticated owner dot asked for
 * (#121 6247464370 item 2): Core never takes the allocation, its hash or the
 * qualification from the caller. Core is a reader only, as for
 * `meri_commands.approval_metadata`; until the migration is applied and Core's
 * database role may SELECT both tables, every call fails closed (503).
 *
 * Runs on the caller's transaction. Checks: exactly one row; the stored hash
 * is the RFC 8785 hash of the stored allocation; the allocation's run is the
 * executor's; the qualification is the executor's run and fence at the
 * expected policy revision; the run deadline has not passed.
 */
export async function readMeriAdmittedRun(
  tx: Prisma.TransactionClient,
  binding: NativeRunBinding,
  policyRevision: string,
  nowMs: number,
): Promise<MeriAdmittedRun> {
  let rows: AdmittedRow[];
  try {
    rows = await tx.$queryRaw<AdmittedRow[]>`
      SELECT r.run_id::text AS run_id, r.attempt, r.worker_arn, r.fence, r.policy_revision::text AS policy_revision,
             a.allocation, a.allocation_sha256::text AS allocation_sha256, a.started_at
        FROM meri_product_budget.runs r
        JOIN meri_product_budget.tool_run_allocations a ON a.run_id = r.run_id
       WHERE r.run_id = ${binding.runId}::uuid
       LIMIT 2`;
  } catch {
    throw new ServiceUnavailableException('Execution run allocation unavailable');
  }
  if (!Array.isArray(rows) || rows.length !== 1) throw notAdmitted();
  const row = rows[0]!;
  if (row.run_id !== binding.runId || typeof row.allocation_sha256 !== 'string' ||
      nativeCanonicalSha256(row.allocation) !== row.allocation_sha256 || !(row.started_at instanceof Date)) throw notAdmitted();
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
  const expiresAt = Date.parse((row.allocation as { schedule: { expiresAt?: unknown } }).schedule.expiresAt as string);
  const deadlineMs = Math.min(row.started_at.getTime() + budgets.maxRuntimeSeconds * 1000, expiresAt);
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= nowMs) throw notAdmitted();
  return { allocation: row.allocation, allocationSha256: row.allocation_sha256, budgets, qualification, deadlineMs };
}
