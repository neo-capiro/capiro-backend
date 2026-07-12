import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';

/**
 * RLS-aware Prisma client.
 *
 * Direct use of `this.prisma.user.findMany()` (without a tenant scope) is the
 * "system" path: it runs with `app.current_tenant` unset, so RLS-protected
 * tables return zero rows. That fail-closed default is intentional.
 *
 * Per-request tenant-scoped queries go through `withTenant(tenantId, fn)`.
 * That opens a transaction, sets the GUC with `SET LOCAL`, and hands the
 * caller a transactional client. When the transaction commits, the GUC is
 * automatically discarded, no leakage between requests.
 *
 * `withSystem(fn)` is the same pattern but with the bypass flag set, used
 * for cross-tenant admin work and webhook ingestion. Use sparingly and
 * always log via the audit_logs table.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Prisma connected');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /**
   * Run `fn` with `app.current_tenant` set to the given UUID inside a
   * transaction. The transactional client passed to `fn` MUST be used for
   * any query that should respect the tenant scope.
   */
  async withTenant<T>(
    tenantId: string,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
    opts?: { timeoutMs?: number },
  ): Promise<T> {
    return this.$transaction(
      async (tx) => {
        // SET LOCAL is bound to the transaction. set_config(..., true) returns
        // the value, which we discard. Parameter binding via $executeRaw is
        // safe against injection.
        await tx.$executeRaw`SELECT set_config('app.current_tenant', ${tenantId}, true)`;
        return fn(tx);
      },
      // Prisma's interactive-transaction default is 5000 ms. Most tenant
      // queries finish in <100 ms, but a few SQL graph helpers (e.g.
      // kg_walk in intelligence.service.getKnowledgeGraph) can take
      // several seconds on warm Aurora and were producing
      //   "Transaction already closed: ... however 8061 ms passed since
      //    the start of the transaction"
      // every time the intel tab loaded. Callers can pass a higher
      // timeoutMs for known-slow paths.
      opts?.timeoutMs ? { timeout: opts.timeoutMs } : undefined,
    );
  }

  /**
   * Like {@link withTenant}, but ALSO sets `app.current_user` in the same
   * transaction (Phase 1, 1C). Required for any query against a table whose
   * RLS policy references `current_user_id()` — today that's memory_items
   * and the memory_item-sourced rows of context_embeddings. Every other
   * table's RLS is unaffected by this GUC (their policies don't reference
   * it), so this is purely additive: existing `withTenant` callers on other
   * tables need no change. A caller that reads/writes memory_items via plain
   * `withTenant` instead of this method will silently see zero private-item
   * rows (visibility='tenant' rows are unaffected) — see the 1C migration's
   * header comment for the caller-conversion sweep this depends on.
   */
  async withTenantUser<T>(
    tenantId: string,
    userId: string,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
    opts?: { timeoutMs?: number },
  ): Promise<T> {
    return this.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_tenant', ${tenantId}, true)`;
        await tx.$executeRaw`SELECT set_config('app.current_user', ${userId}, true)`;
        return fn(tx);
      },
      opts?.timeoutMs ? { timeout: opts.timeoutMs } : undefined,
    );
  }

  /**
   * Like {@link withTenant} but retries the whole transaction when Postgres
   * aborts it with a deadlock (SQLSTATE 40P01) or serialization failure
   * (40001) — both transient. Concurrent writers that touch the same rows are
   * expected to lose this race occasionally; the loser is safe to replay as
   * long as `fn` is idempotent (upsert / updateMany / deleteMany+create).
   *
   * Used by the Microsoft Graph sync, where a burst of webhook notifications
   * for a freshly connected mailbox runs several syncs at once and they all
   * upsert the same brand-new engagement_contacts rows.
   */
  async withTenantRetry<T>(
    tenantId: string,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
    opts?: { timeoutMs?: number; retries?: number },
  ): Promise<T> {
    const maxRetries = opts?.retries ?? 3;
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.withTenant(tenantId, fn, opts);
      } catch (err) {
        if (attempt >= maxRetries || !isRetryableTransactionError(err)) throw err;
        // Exponential backoff with jitter so the two deadlock victims don't
        // line up and collide again on the retry.
        const backoffMs = Math.min(250, 25 * 2 ** attempt) + Math.floor(Math.random() * 25);
        this.logger.warn(
          `Retryable transaction conflict (attempt ${attempt + 1}/${maxRetries + 1}); retrying in ${backoffMs}ms`,
        );
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    }
  }

  /**
   * Run `fn` with the RLS bypass flag enabled. Use only for trusted server
   * paths (cross-tenant admin tooling, webhook ingestion, migrations).
   */
  async withSystem<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
      return fn(tx);
    });
  }
}

/**
 * True when a Postgres error is a transient transaction conflict worth
 * retrying: a deadlock (40P01) or a serialization failure (40001). Prisma
 * maps these to P2034, but when the failure surfaces from a raw query it can
 * arrive as a generic error whose message carries the SQLSTATE, so we sniff
 * both.
 */
export function isRetryableTransactionError(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2034') {
    return true;
  }
  // A deadlock raised mid interactive-transaction frequently surfaces NOT as a
  // tidy P2034 but as a generic error whose message carries the raw SQLSTATE
  // (the form seen in production), so we also sniff the message. Match the
  // phrases (already specific) and the bare SQLSTATEs only with a leading
  // boundary, so an incidental "40001" inside row data / external ids in some
  // other error can't trigger a spurious retry.
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes('deadlock detected') ||
    message.includes('could not serialize access') ||
    /(?:^|[^0-9A-Za-z])40P01\b/.test(message) ||
    /(?:^|[^0-9A-Za-z])40001\b/.test(message)
  );
}
