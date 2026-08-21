/**
 * Phase 8 Session 9 — Prisma-backed provider audit sink.
 *
 * Parameterised raw SQL, for the same reason as the Session 7 and 8 stores: the
 * Session 9 table is deliberately outside the curated `defense-api` HTTP Prisma
 * model subset, because nothing in the HTTP response surface reads it. Adding it
 * there is part of a product cutover, not this session.
 *
 * Regression guard carried forward from Sessions 6, 7 and 8: `$queryRawUnsafe`
 * does not know column types, so every timestamp and integer placeholder is cast
 * explicitly. An uncast parameter fails at runtime rather than at review time.
 *
 * `record` never throws. Failing to write an audit row must not convert a read
 * route that degraded correctly into a 500, so a write failure is reported as an
 * outcome and the runner logs it.
 */

import { Injectable, Logger } from '@nestjs/common';

import {
  assertProviderAuditCarriesNoSecrets,
  type ProviderInvocationAudit,
} from '@capiro/defense-domain';

import type { ProviderAuditSink } from './provider-runtime.ports.js';

/** Minimal surface actually used, so this needs no generated client. */
export interface RawSqlExecutor {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
}

@Injectable()
export class PrismaProviderAuditSink implements ProviderAuditSink {
  private readonly logger = new Logger(PrismaProviderAuditSink.name);

  constructor(private readonly sql: RawSqlExecutor) {}

  async record(
    audit: ProviderInvocationAudit,
  ): Promise<{ persisted: boolean; reason: string | null }> {
    // Belt and braces: the builder already ran this, but a row assembled by some
    // future path must not reach the database unchecked.
    try {
      assertProviderAuditCarriesNoSecrets(audit);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.error(`refusing to persist a provider audit row: ${reason}`);
      return { persisted: false, reason };
    }

    try {
      await this.sql.$queryRawUnsafe(
        `INSERT INTO defense_provider_invocation (
           provider, operation, outcome, model, tenant_id,
           payload_sha256, idempotency_key, attempts, latency_ms,
           failure_class, reason, result_dimension, result_count,
           started_at, finished_at
         ) VALUES (
           $1, $2, $3, $4, $5,
           $6, $7, $8::int, $9::int,
           $10, $11, $12::int, $13::int,
           $14::timestamptz, $15::timestamptz
         )
         RETURNING id::text AS id`,
        audit.provider,
        audit.operation,
        audit.outcome,
        audit.model,
        audit.tenantId,
        audit.payloadSha256,
        audit.idempotencyKey,
        audit.attempts,
        audit.latencyMs,
        audit.failureClass,
        audit.reason,
        audit.resultDimension,
        audit.resultCount,
        audit.startedAt,
        audit.finishedAt,
      );
      return { persisted: true, reason: null };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn(`provider audit insert failed: ${reason}`);
      return { persisted: false, reason };
    }
  }
}
