// ============================================================================
// ⛔ CHANGE-CONTROL: AUTHENTICATION — APPROVAL REQUIRED
// ----------------------------------------------------------------------------
// This is the de-provisioning durability path: it is what guarantees a user
// removed in Capiro is eventually removed from the Clerk organization. Changing
// it can silently leave removed users holding valid org-bearing tokens.
// ============================================================================
import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { ClerkService } from './clerk.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

export const CLERK_MEMBERSHIP_DELETE = 'clerk.membership.delete';

/** Backoff schedule by attempt count, capped. Deliberately coarse — a Clerk
 *  outage is measured in minutes, and the drain runs out-of-band. */
const BACKOFF_MS = [
  60_000, // 1m
  5 * 60_000, // 5m
  30 * 60_000, // 30m
  2 * 60 * 60_000, // 2h
  6 * 60 * 60_000, // 6h
];
/** After this many failures the row stays pending but stops being retried
 *  aggressively; the alarm on identity.deprovision_failed is the escalation. */
const MAX_ATTEMPTS = 12;

interface ClerkMembershipDeletePayload {
  clerkOrgId: string;
  clerkUserId: string;
  membershipId: string;
}

/**
 * Durable de-provisioning.
 *
 * Previously removeMember flipped the local membership to 'removed' and called
 * Clerk's deleteOrganizationMembership INSIDE the same Prisma interactive
 * transaction, swallowing failures. Two distinct bugs:
 *
 *   1. A fast Clerk error was swallowed -> HTTP 200 {ok:true} while the user
 *      remained in the Clerk org, still receiving org-bearing tokens. Nothing
 *      recorded that the mirror had diverged.
 *   2. A SLOW Clerk call (>5s, the interactive-transaction default) blew the
 *      transaction budget: the .catch swallowed the SDK error but $transaction
 *      still aborted with P2028, so the status='removed' write AND the audit row
 *      rolled back and the caller got a 500 having removed nothing. It also held
 *      a Prisma pool connection open across an external HTTPS call — the same
 *      shape as the 2026-07-21 graph-sync pool-starvation incident.
 *
 * Now: enqueue() runs inside the caller's transaction (atomic with the local
 * state change), and every Clerk call happens strictly OUTSIDE any transaction.
 */
@Injectable()
export class IdentityOutboxService {
  private readonly logger = new Logger(IdentityOutboxService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clerk: ClerkService,
  ) {}

  /**
   * Enqueue a Clerk membership deletion. MUST be called with the caller's
   * transaction client so the job commits atomically with the local removal.
   *
   * Idempotent: a partial unique index on (type, payload->>'membershipId')
   * WHERE consumed_at IS NULL means a retried removeMember cannot create a
   * second pending job for the same membership. Returns the job id, or null
   * when one was already pending.
   */
  async enqueueClerkMembershipDelete(
    tx: Prisma.TransactionClient,
    input: { tenantId: string } & ClerkMembershipDeletePayload,
  ): Promise<string | null> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      INSERT INTO identity_outbox (tenant_id, type, payload)
      VALUES (
        ${input.tenantId}::uuid,
        ${CLERK_MEMBERSHIP_DELETE},
        ${JSON.stringify({
          clerkOrgId: input.clerkOrgId,
          clerkUserId: input.clerkUserId,
          membershipId: input.membershipId,
        })}::jsonb
      )
      ON CONFLICT DO NOTHING
      RETURNING id::text AS id
    `;
    return rows[0]?.id ?? null;
  }

  /**
   * Best-effort immediate attempt, for the common case where Clerk is healthy.
   *
   * Call AFTER the enclosing transaction has committed. Never throws: a failure
   * simply leaves the job pending for the drain. This keeps removal
   * user-visibly instant without putting the network call back inside a
   * transaction.
   */
  async attemptNow(jobId: string): Promise<boolean> {
    try {
      return await this.processJob(jobId);
    } catch (err) {
      this.logger.warn(`identity-outbox immediate attempt failed: ${(err as Error).message}`);
      return false;
    }
  }

  /**
   * Drain pending jobs. Invoked out-of-band (entrypoint verb
   * `drain-identity-outbox`), NOT from an in-process scheduler — apps/api has
   * no scheduler, and running one in a multi-task service would have every task
   * draining the same rows.
   */
  async drainPending(limit = 50): Promise<{ processed: number; succeeded: number }> {
    const due = await this.prisma.withSystem((tx) =>
      tx.$queryRaw<Array<{ id: string }>>`
        SELECT id::text AS id
        FROM identity_outbox
        WHERE consumed_at IS NULL
          AND next_attempt_at <= now()
          AND attempts < ${MAX_ATTEMPTS}
        ORDER BY next_attempt_at ASC
        LIMIT ${limit}
      `,
    );

    let succeeded = 0;
    for (const row of due) {
      try {
        if (await this.processJob(row.id)) succeeded += 1;
      } catch (err) {
        this.logger.error(`identity-outbox job ${row.id} threw: ${(err as Error).message}`);
      }
    }
    return { processed: due.length, succeeded };
  }

  /**
   * Claim one job, perform its Clerk call, and record the outcome.
   *
   * The claim is an atomic conditional UPDATE, so two concurrent drains cannot
   * both process the same row. The Clerk call itself runs OUTSIDE any
   * transaction — that is the whole point of this class.
   */
  private async processJob(jobId: string): Promise<boolean> {
    const claimed = await this.prisma.withSystem((tx) =>
      tx.$queryRaw<Array<{ id: string; type: string; payload: ClerkMembershipDeletePayload }>>`
        UPDATE identity_outbox
        SET attempts = attempts + 1
        WHERE id = ${jobId}::uuid
          AND consumed_at IS NULL
        RETURNING id::text AS id, type, payload
      `,
    );
    const job = claimed[0];
    if (!job) return false; // already consumed, or gone

    if (job.type !== CLERK_MEMBERSHIP_DELETE) {
      await this.markFailed(jobId, `unknown job type ${job.type}`);
      return false;
    }

    try {
      await this.clerk.backend.organizations.deleteOrganizationMembership({
        organizationId: job.payload.clerkOrgId,
        userId: job.payload.clerkUserId,
      });
      await this.markConsumed(jobId);
      return true;
    } catch (err) {
      // A 404 means the Clerk-side membership is already gone — the desired end
      // state. Treat as success so a manual Clerk removal does not leave a job
      // retrying forever.
      if (isNotFound(err)) {
        this.logger.log(
          `identity-outbox job ${jobId}: Clerk membership already absent, treating as done`,
        );
        await this.markConsumed(jobId);
        return true;
      }
      await this.markFailed(jobId, (err as Error).message);
      return false;
    }
  }

  private async markConsumed(jobId: string): Promise<void> {
    await this.prisma.withSystem((tx) =>
      tx.$executeRaw`UPDATE identity_outbox SET consumed_at = now(), last_error = NULL WHERE id = ${jobId}::uuid`,
    );
  }

  private async markFailed(jobId: string, message: string): Promise<void> {
    const rows = await this.prisma.withSystem((tx) =>
      tx.$queryRaw<Array<{ attempts: number; tenant_id: string }>>`
        UPDATE identity_outbox
        SET last_error = ${message.slice(0, 1000)},
            next_attempt_at = now() + (${backoffSeconds(0)} || ' seconds')::interval
        WHERE id = ${jobId}::uuid
        RETURNING attempts, tenant_id::text AS tenant_id
      `,
    );
    const row = rows[0];
    const attempts = row?.attempts ?? 0;

    // Re-space using the real attempt count now that we have it.
    await this.prisma.withSystem((tx) =>
      tx.$executeRaw`
        UPDATE identity_outbox
        SET next_attempt_at = now() + (${backoffSeconds(attempts)} || ' seconds')::interval
        WHERE id = ${jobId}::uuid AND consumed_at IS NULL
      `,
    );

    // Structured, single-line JSON so a CloudWatch metric filter can count it.
    // Pattern: { $.security_event = "identity.deprovision_failed" }
    this.logger.error(
      JSON.stringify({
        security_event: 'identity.deprovision_failed',
        job_id: jobId,
        tenant_id: row?.tenant_id ?? null,
        attempts,
        exhausted: attempts >= MAX_ATTEMPTS,
        error: message.slice(0, 300),
        count: 1,
      }),
    );
  }
}

function backoffSeconds(attempts: number): number {
  const idx = Math.min(Math.max(attempts - 1, 0), BACKOFF_MS.length - 1);
  return Math.round((BACKOFF_MS[idx] ?? BACKOFF_MS[0]!) / 1000);
}

/** Clerk SDK surfaces HTTP status on `status`; some errors only carry a code. */
function isNotFound(err: unknown): boolean {
  const e = err as { status?: number; errors?: Array<{ code?: string }> } | null;
  if (!e) return false;
  if (e.status === 404) return true;
  return Boolean(e.errors?.some((x) => x.code === 'resource_not_found'));
}
