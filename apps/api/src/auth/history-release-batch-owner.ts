import type { Prisma } from '@prisma/client';
import type { Request } from 'express';
import type { TenantContext } from '@capiro/shared';
import type { ApplicationAuthorityIdentityEvidence } from './application-authority.js';
import {
  HISTORY_RELEASE_RECEIPT_TTL_MS,
  type HistoryReleaseBatchDecision,
  type HistoryReleaseBatchPort,
  type HistoryReleasePrincipal,
  type HistoryReleaseRequest,
} from './history-release-source.js';
import { assertSelectedClientHistoryReleaseWithinTx } from './history-release-selected-client-owner.js';

/** This owner remains unmounted. Its native port is intentionally not supplied by
 * the current tenant middleware: exact original membership provenance and a
 * fresh online Clerk observation under the caller's row locks still need Neo's
 * approval before that middleware can change. */
export interface HistoryReleaseNativeIdentityOwner {
  readApplicationAuthority(req: Request, ctx: TenantContext): Promise<ApplicationAuthorityIdentityEvidence>;
  /** Lock the original request's user, tenant and exact selected membership in
   * deterministic order on `tx`. Reject marked control credentials and every
   * impersonated request. All raw SQL needs explicit tenant/actor predicates.
   * Do not open a second transaction or choose another membership. */
  lockOriginalApplicationAuthorityInTransaction(
    req: Request, ctx: TenantContext, tx: Prisma.TransactionClient,
  ): Promise<void>;
  /** Make a NEW online Clerk session observation while the same local locks
   * remain held, then read local identity through `tx`, not `withSystem`. */
  readFreshApplicationAuthorityInTransaction(
    req: Request, ctx: TenantContext, tx: Prisma.TransactionClient,
  ): Promise<ApplicationAuthorityIdentityEvidence>;
}

export interface HistoryReleaseTenantTransactionOwner {
  withTenant<T>(
    tenantId: string,
    run: (tx: Prisma.TransactionClient) => Promise<T>,
    opts: { timeoutMs: number; isolationLevel: Prisma.TransactionIsolationLevel },
  ): Promise<T>;
}

export class HistoryReleaseBatchUnavailable extends Error {
  constructor() {
    super('Application authority unavailable');
    this.name = 'HistoryReleaseBatchUnavailable';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const HISTORY_RELEASE_TRANSACTION_TIMEOUT_MS = 4_000;
const unavailable = (): never => { throw new HistoryReleaseBatchUnavailable(); };

function samePrincipal(
  evidence: ApplicationAuthorityIdentityEvidence,
  principal: HistoryReleasePrincipal,
  nowMs: number,
): boolean {
  return evidence?.principal?.tenantId === principal.tenantId &&
    evidence.principal.actorId === principal.actorId &&
    typeof evidence.identityRevision === 'string' && SHA256.test(evidence.identityRevision) &&
    Number.isSafeInteger(evidence.expiresAtMs) && evidence.expiresAtMs > nowMs;
}

/** The future native route must use this exact target. A marked sidless control
 * credential is not admitted on it by TenantContextMiddleware. No alternate
 * service-header authority is accepted by this source. */
function exactNativeTarget(req: Request): boolean {
  const parsed = req?.path;
  const original = (req?.originalUrl ?? req?.url ?? '').split('?')[0];
  const normalized = (path: string) => path.startsWith('/api/') ? path.slice(4) : path;
  const authorization = req?.headers?.authorization;
  return req?.method === 'POST' && typeof parsed === 'string' && parsed === original &&
    normalized(parsed) === '/clio/application-authority/history-release' &&
    typeof authorization === 'string' && /^Bearer \S+$/.test(authorization) &&
    !req.header('x-capiro-impersonate-tenant');
}

/** A complete all-or-nothing source composition. `withTenant` resolves only
 * after commit, so this port cannot return its decision on a failed commit.
 * The native owner interface has no qualified runtime implementation yet. */
export function createHistoryReleaseBatchPort(input: {
  req: Request;
  ctx: TenantContext;
  native: HistoryReleaseNativeIdentityOwner;
  prisma: HistoryReleaseTenantTransactionOwner;
  now?: () => number;
}): HistoryReleaseBatchPort {
  return {
    async decideAll(
      request: HistoryReleaseRequest,
      principal: HistoryReleasePrincipal,
      subjectsSha256: string,
    ): Promise<HistoryReleaseBatchDecision> {
      const { req, ctx, native, prisma } = input;
      const now = input.now ?? Date.now;
      if (!exactNativeTarget(req) || !ctx || ctx.tenantId !== principal.tenantId ||
          ctx.userId !== principal.actorId || !UUID.test(principal.tenantId) ||
          !UUID.test(principal.actorId) || typeof subjectsSha256 !== 'string' ||
          !SHA256.test(subjectsSha256) || !native || !prisma ||
          typeof native.readApplicationAuthority !== 'function' ||
          typeof native.lockOriginalApplicationAuthorityInTransaction !== 'function' ||
          typeof native.readFreshApplicationAuthorityInTransaction !== 'function' ||
          typeof prisma.withTenant !== 'function') return unavailable();

      try {
        const initial = await native.readApplicationAuthority(req, ctx);
        if (!samePrincipal(initial, principal, now())) return unavailable();
        const decision = await prisma.withTenant(principal.tenantId, async (tx) => {
          // A qualified native owner must lock request provenance first. The
          // subject leaf then locks conversations, clients and wall grants in
          // sorted order before the final online session call.
          await native.lockOriginalApplicationAuthorityInTransaction(req, ctx, tx);
          await assertSelectedClientHistoryReleaseWithinTx(tx, principal, request.route, request.subjects);
          const current = await native.readFreshApplicationAuthorityInTransaction(req, ctx, tx);
          const checkedAtMs = now();
          if (!samePrincipal(current, principal, checkedAtMs) ||
              current.identityRevision !== initial.identityRevision ||
              initial.expiresAtMs <= checkedAtMs) return unavailable();
          const expiresAtMs = Math.min(checkedAtMs + HISTORY_RELEASE_RECEIPT_TTL_MS,
            initial.expiresAtMs, current.expiresAtMs);
          if (!Number.isSafeInteger(checkedAtMs) || checkedAtMs < 0 ||
              !Number.isSafeInteger(expiresAtMs) || expiresAtMs <= checkedAtMs) return unavailable();
          return {
            authorized: true as const,
            observationId: request.observationId,
            route: request.route,
            principal: { tenantId: principal.tenantId, actorId: principal.actorId },
            subjectsSha256,
            responseSha256: request.responseSha256,
            checkedAtMs,
            expiresAtMs,
          };
        }, { timeoutMs: HISTORY_RELEASE_TRANSACTION_TIMEOUT_MS, isolationLevel: 'RepeatableRead' });
        return decision;
      } catch {
        return unavailable();
      }
    },
  };
}
