/**
 * S-3 — profile-write coordination for parallel conversations of one user.
 *
 * THE SHAPE OF THE PROBLEM. An execution scope (`tenant:<t>:user:<u>`) is one
 * isolated Hermes home. Two conversations of the SAME user share it, so two
 * runs can be live in one writable profile at once. Two things could go wrong,
 * and they are NOT the same thing:
 *
 *   1. TRANSCRIPT CONTAMINATION — the two runs blending into one Hermes
 *      session. This is ALREADY SOLVED and is not reimplemented here. The
 *      `X-Hermes-Session-Key` is per Meri CONVERSATION
 *      (`MeriHermesRuntimeAdapter.sessionKeyFor` →
 *      `<executionScopeId>:conversation:<conversationId>[:e<epoch>]`), because
 *      the pinned build's session key NAMES THE TRANSCRIPT. A per-user key was
 *      tried in Phase 0 and blended a user's conversations together (harness
 *      D3/D6). The S-3 spec VERIFIES that property through the real adapter
 *      rather than asserting it from the source — see
 *      meri-hermes-profile-coordination.integration.spec.ts.
 *
 *   2. LOST SHARED-FILE UPDATES — both runs read the scope's shared writable
 *      profile state, both modify their copy, both write back, and one update
 *      vanishes. Nothing in Phase 1 addressed this. It is what this service
 *      exists for.
 *
 * THE MECHANISM. One writer per writable profile, leased, with a monotonic
 * FENCE token:
 *
 *   • `acquire()` is a single `INSERT ... ON CONFLICT (scope_id) DO UPDATE ...
 *     WHERE <expired OR already mine>`. A row comes back only to the winner.
 *     Re-acquiring your own LIVE lease renews it and does NOT bump the fence,
 *     so a holder's token stays valid across renewals; taking over an EXPIRED
 *     lease DOES bump it, which is what invalidates the previous holder.
 *   • Every profile write is executed by `writeSharedProfileState()`, whose
 *     UPDATE carries `AND holder_run_id = $me AND fence = $myFence AND
 *     expires_at > now()` in the SAME transaction as the write. A writer whose
 *     lease expired or was taken over therefore has its write REJECTED BY THE
 *     DATABASE (`MeriHermesStaleProfileWriterError`) rather than being trusted
 *     to notice on its own — the same discipline `RunWriteFence` already
 *     applies to the consumer lease on `meri_agent_runs`.
 *   • The read-modify-write happens INSIDE that transaction, with the scope row
 *     locked `FOR UPDATE`, so the lost-update window does not exist even if a
 *     caller bypasses the lease.
 *
 * VISIBLE, NOT SILENT. `acquireOrWait()` takes an `onWait` callback and reports
 * `waitedMs` / `contended` on the result. The adapter turns that into a public
 * `run.status` event carrying `waitingFor: 'profile_write'` and the holder's run
 * id, so a user whose second conversation is briefly serialized behind the
 * first sees WHY, instead of watching a run that appears to have stalled. That
 * is the S-3 requirement "make any required serialization VISIBLE in run state
 * rather than a silent block".
 */
import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
// Value import, not `import type`: Nest reads `design:paramtypes` for
// constructor injection, and a type-only import erases to `Object`.
import { PrismaService } from '../../prisma/prisma.service.js';
import { MeriHermesDbGovernor, meriHermesSharedDbGovernor } from './meri-hermes-db-governor.js';
import { meriHermesScalingLimits, type MeriHermesScalingLimits } from './meri-hermes-scaling.config.js';

export interface MeriHermesProfileLease {
  scopeId: string;
  tenantId: string;
  holderRunId: string;
  fence: number;
  expiresAt: string;
  /** True when the lease was contended — the caller had to wait for it. */
  contended: boolean;
  waitedMs: number;
}

export interface MeriHermesProfileHolder {
  scopeId: string;
  holderRunId: string;
  fence: number;
  expiresAt: string;
  expired: boolean;
}

/**
 * A write was presented by something that is no longer the profile's writer:
 * the lease expired and was taken over, it was released, or the fence token is
 * from an older holder. The write did not happen.
 */
export class MeriHermesStaleProfileWriterError extends Error {
  readonly code = 'stale_profile_writer';
  constructor(
    readonly scopeId: string,
    readonly presentedRunId: string,
    readonly presentedFence: number,
    readonly currentHolder: MeriHermesProfileHolder | null,
  ) {
    super(
      `Run ${presentedRunId} (fence ${presentedFence}) is no longer the writer for profile ${scopeId}` +
        (currentHolder ? `; it is now held by run ${currentHolder.holderRunId} at fence ${currentHolder.fence}` : '; the lease has been released') +
        '. The write was rejected rather than allowed to overwrite the current writer.',
    );
    this.name = 'MeriHermesStaleProfileWriterError';
  }
}

/** The profile lease stayed busy for the whole bounded wait. Actionable, never a silent hang. */
export class MeriHermesProfileBusyError extends Error {
  readonly code = 'profile_write_busy';
  constructor(
    readonly scopeId: string,
    readonly holder: MeriHermesProfileHolder | null,
    readonly waitedMs: number,
  ) {
    super(
      `Another conversation in this workspace has been writing to the shared Hermes profile for ` +
        `${Math.round(waitedMs / 1000)}s${holder ? ` (run ${holder.holderRunId})` : ''}. ` +
        'This turn was not started so the two could not overwrite each other; please retry in a moment.',
    );
    this.name = 'MeriHermesProfileBusyError';
  }
}

interface LeaseRow {
  scope_id: string;
  tenant_id: string;
  holder_run_id: string;
  fence: bigint | number;
  expires_at: Date;
  expired?: boolean;
}

function fenceOf(value: bigint | number): number {
  return typeof value === 'bigint' ? Number(value) : value;
}

@Injectable()
export class MeriHermesProfileLeaseService {
  private readonly logger = new Logger(MeriHermesProfileLeaseService.name);

  /** Test seam; same convention as the adapter's `env`. */
  env: NodeJS.ProcessEnv = process.env;

  /** Assignable so a spec can share one governor (and its counters) across services. */
  governor: MeriHermesDbGovernor;

  constructor(
    private readonly prisma: PrismaService,
    governor?: MeriHermesDbGovernor,
  ) {
    this.governor = governor ?? meriHermesSharedDbGovernor();
  }

  limits(): MeriHermesScalingLimits {
    return meriHermesScalingLimits(this.env);
  }

  /**
   * Try once to become the writable profile's single writer.
   *
   * Returns `null` when a DIFFERENT run holds a live lease. Renewing your own
   * live lease succeeds and keeps your fence; taking over an expired lease
   * succeeds and bumps the fence, which is what makes the previous holder's
   * token stale.
   */
  async acquire(input: {
    scopeId: string;
    tenantId: string;
    runId: string;
    ttlMs?: number;
  }): Promise<MeriHermesProfileLease | null> {
    const ttlMs = Math.max(1, Math.floor(input.ttlMs ?? this.limits().profileLeaseTtlMs));
    const rows = await this.governor.withTenantTx(
      this.prisma,
      'profile.acquire',
      input.tenantId,
      (tx) =>
        tx.$queryRaw<LeaseRow[]>(Prisma.sql`
          INSERT INTO meri_agent_profile_leases
            (scope_id, tenant_id, holder_run_id, fence, acquired_at, renewed_at, expires_at, handoffs)
          VALUES
            (${input.scopeId}, ${input.tenantId}::uuid, ${input.runId}::uuid, 1, now(), now(),
             now() + make_interval(secs => ${ttlMs}::numeric / 1000), 0)
          ON CONFLICT (scope_id) DO UPDATE
            SET holder_run_id = EXCLUDED.holder_run_id,
                -- Renewing your own live lease must NOT invalidate the token
                -- you are already writing with; a takeover must.
                fence = CASE
                          WHEN meri_agent_profile_leases.holder_run_id = EXCLUDED.holder_run_id
                            THEN meri_agent_profile_leases.fence
                          ELSE meri_agent_profile_leases.fence + 1
                        END,
                handoffs = meri_agent_profile_leases.handoffs
                           + CASE WHEN meri_agent_profile_leases.holder_run_id = EXCLUDED.holder_run_id THEN 0 ELSE 1 END,
                acquired_at = CASE
                                WHEN meri_agent_profile_leases.holder_run_id = EXCLUDED.holder_run_id
                                  THEN meri_agent_profile_leases.acquired_at
                                ELSE now()
                              END,
                renewed_at = now(),
                expires_at = EXCLUDED.expires_at
            WHERE meri_agent_profile_leases.expires_at <= now()
               OR meri_agent_profile_leases.holder_run_id = EXCLUDED.holder_run_id
          RETURNING scope_id, tenant_id, holder_run_id, fence, expires_at
        `),
    );
    const row = rows[0];
    if (!row) return null;
    return {
      scopeId: row.scope_id,
      tenantId: row.tenant_id,
      holderRunId: row.holder_run_id,
      fence: fenceOf(row.fence),
      expiresAt: row.expires_at.toISOString(),
      contended: false,
      waitedMs: 0,
    };
  }

  /**
   * Acquire with a BOUNDED wait. `onWait` is invoked on every unsuccessful
   * attempt with the current holder, which is how the serialization is surfaced
   * in run state instead of being a silent block. On timeout it throws
   * `MeriHermesProfileBusyError` rather than waiting forever.
   */
  async acquireOrWait(input: {
    scopeId: string;
    tenantId: string;
    runId: string;
    ttlMs?: number;
    waitMs?: number;
    pollMs?: number;
    signal?: AbortSignal;
    onWait?: (holder: MeriHermesProfileHolder | null, waitedMs: number) => void;
  }): Promise<MeriHermesProfileLease> {
    const limits = this.limits();
    const waitMs = input.waitMs ?? limits.profileLeaseWaitMs;
    const pollMs = input.pollMs ?? limits.profileLeasePollMs;
    const started = Date.now();
    let notified = false;
    for (;;) {
      const lease = await this.acquire(input);
      if (lease) {
        const waitedMs = Date.now() - started;
        return { ...lease, contended: notified, waitedMs };
      }
      const holder = await this.holder(input.tenantId, input.scopeId);
      const waitedMs = Date.now() - started;
      input.onWait?.(holder, waitedMs);
      notified = true;
      if (waitedMs >= waitMs || input.signal?.aborted) {
        throw new MeriHermesProfileBusyError(input.scopeId, holder, waitedMs);
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, Math.max(1, waitMs - waitedMs))));
    }
  }

  /** Extend the lease. A non-holder (or an expired holder) is a STALE WRITER and is told so. */
  async renew(input: { scopeId: string; tenantId: string; runId: string; fence: number; ttlMs?: number }): Promise<MeriHermesProfileLease> {
    const ttlMs = Math.max(1, Math.floor(input.ttlMs ?? this.limits().profileLeaseTtlMs));
    const rows = await this.governor.withTenantTx(this.prisma, 'profile.renew', input.tenantId, (tx) =>
      tx.$queryRaw<LeaseRow[]>(Prisma.sql`
        UPDATE meri_agent_profile_leases
           SET renewed_at = now(),
               expires_at = now() + make_interval(secs => ${ttlMs}::numeric / 1000)
         WHERE scope_id = ${input.scopeId}
           AND holder_run_id = ${input.runId}::uuid
           AND fence = ${input.fence}::bigint
           AND expires_at > now()
        RETURNING scope_id, tenant_id, holder_run_id, fence, expires_at
      `),
    );
    const row = rows[0];
    if (!row) {
      throw new MeriHermesStaleProfileWriterError(
        input.scopeId,
        input.runId,
        input.fence,
        await this.holder(input.tenantId, input.scopeId),
      );
    }
    return {
      scopeId: row.scope_id,
      tenantId: row.tenant_id,
      holderRunId: row.holder_run_id,
      fence: fenceOf(row.fence),
      expiresAt: row.expires_at.toISOString(),
      contended: false,
      waitedMs: 0,
    };
  }

  /** Give the lease up. Guarded on holder+fence so a stale writer cannot release the CURRENT writer's lease. */
  async release(input: { scopeId: string; tenantId: string; runId: string; fence: number }): Promise<boolean> {
    const deleted = await this.governor.withTenantTx(this.prisma, 'profile.release', input.tenantId, (tx) =>
      tx.$executeRaw`
        DELETE FROM meri_agent_profile_leases
         WHERE scope_id = ${input.scopeId}
           AND holder_run_id = ${input.runId}::uuid
           AND fence = ${input.fence}::bigint
      `,
    );
    return deleted > 0;
  }

  async holder(tenantId: string, scopeId: string): Promise<MeriHermesProfileHolder | null> {
    const rows = await this.governor.withTenantTx(this.prisma, 'profile.holder', tenantId, (tx) =>
      tx.$queryRaw<LeaseRow[]>(Prisma.sql`
        SELECT scope_id, tenant_id, holder_run_id, fence, expires_at, (expires_at <= now()) AS expired
          FROM meri_agent_profile_leases
         WHERE scope_id = ${scopeId}
      `),
    );
    const row = rows[0];
    if (!row) return null;
    return {
      scopeId: row.scope_id,
      holderRunId: row.holder_run_id,
      fence: fenceOf(row.fence),
      expiresAt: row.expires_at.toISOString(),
      expired: Boolean(row.expired),
    };
  }

  /**
   * The ONE supported way to change shared writable-profile state.
   *
   * In a single transaction: verify the caller is still the fenced writer, lock
   * the scope row `FOR UPDATE`, read the current state, apply `mutate`, write it
   * back. A stale writer is rejected before `mutate` is ever consulted, and the
   * read-modify-write has no window another writer could interleave into — which
   * is what "cannot lose shared-file updates" means concretely.
   *
   * State lives in `meri_execution_scopes.profile_state_jsonb` -- a column added
   * for this and nothing else (migration 20280920050000). Deliberately NOT the
   * neighbouring `worker_state_jsonb`: that column already has an owner (the
   * worker lifecycle service read-modify-writes it under its OWN per-scope
   * advisory lock and parses it into a closed shape), and one column with two
   * independent writers holding two different locks is exactly the lost-update
   * hazard this method exists to close.
   */
  async writeSharedProfileState<T extends Record<string, unknown>>(input: {
    scopeId: string;
    tenantId: string;
    runId: string;
    fence: number;
    mutate: (current: Record<string, unknown>) => T;
  }): Promise<Record<string, unknown>> {
    const result = await this.governor.withTenantTx(
      this.prisma,
      'profile.writeSharedProfileState',
      input.tenantId,
      async (tx) => {
        const leases = await tx.$queryRaw<LeaseRow[]>(Prisma.sql`
          SELECT scope_id, tenant_id, holder_run_id, fence, expires_at
            FROM meri_agent_profile_leases
           WHERE scope_id = ${input.scopeId}
             AND holder_run_id = ${input.runId}::uuid
             AND fence = ${input.fence}::bigint
             AND expires_at > now()
           FOR UPDATE
        `);
        if (!leases[0]) return { stale: true as const };

        // FOR UPDATE on the scope row: even a caller that somehow bypassed the
        // lease cannot interleave with this read-modify-write.
        const scopes = await tx.$queryRaw<Array<{ profile_state_jsonb: unknown }>>(Prisma.sql`
          SELECT profile_state_jsonb FROM meri_execution_scopes WHERE id = ${input.scopeId} FOR UPDATE
        `);
        if (!scopes[0]) throw new Error(`Unknown Hermes execution scope ${input.scopeId}`);
        const current =
          scopes[0].profile_state_jsonb && typeof scopes[0].profile_state_jsonb === 'object' && !Array.isArray(scopes[0].profile_state_jsonb)
            ? (scopes[0].profile_state_jsonb as Record<string, unknown>)
            : {};
        const next = input.mutate({ ...current });
        await tx.$executeRaw`
          UPDATE meri_execution_scopes
             SET profile_state_jsonb = ${next as unknown as Prisma.InputJsonValue}, updated_at = now()
           WHERE id = ${input.scopeId}
        `;
        return { stale: false as const, next: next as Record<string, unknown> };
      },
    );
    if (result.stale) {
      throw new MeriHermesStaleProfileWriterError(
        input.scopeId,
        input.runId,
        input.fence,
        await this.holder(input.tenantId, input.scopeId),
      );
    }
    return result.next;
  }

  /** Read shared profile state without taking the lease (readers are never serialized against each other). */
  async readSharedProfileState(tenantId: string, scopeId: string): Promise<Record<string, unknown>> {
    const rows = await this.governor.withTenantTx(this.prisma, 'profile.readSharedProfileState', tenantId, (tx) =>
      tx.$queryRaw<Array<{ profile_state_jsonb: unknown }>>(Prisma.sql`
        SELECT profile_state_jsonb FROM meri_execution_scopes WHERE id = ${scopeId}
      `),
    );
    const raw = rows[0]?.profile_state_jsonb;
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  }

  /** Acquire (waiting, bounded), run `fn` with the fenced lease, always release. */
  async withProfileWrite<T>(
    input: {
      scopeId: string;
      tenantId: string;
      runId: string;
      ttlMs?: number;
      waitMs?: number;
      pollMs?: number;
      signal?: AbortSignal;
      onWait?: (holder: MeriHermesProfileHolder | null, waitedMs: number) => void;
    },
    fn: (lease: MeriHermesProfileLease) => Promise<T>,
  ): Promise<T> {
    const lease = await this.acquireOrWait(input);
    try {
      return await fn(lease);
    } finally {
      await this.release({
        scopeId: input.scopeId,
        tenantId: input.tenantId,
        runId: input.runId,
        fence: lease.fence,
      }).catch((error) => this.logger.warn(`profile lease release failed for ${input.scopeId}: ${String(error)}`));
    }
  }
}
