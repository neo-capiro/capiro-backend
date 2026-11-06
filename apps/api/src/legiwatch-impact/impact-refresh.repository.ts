import { randomUUID } from 'node:crypto';
import { ConflictException, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';

export const IMPACT_REFRESH_MAX_ATTEMPTS = 4;
export const IMPACT_REFRESH_CHECK_MS = 6 * 60 * 60 * 1000;
export type ImpactRefreshError = 'actor_unavailable' | 'access_denied' | 'analysis_unavailable' |
  'evidence_changed' | 'refresh_failed' | 'attempts_exhausted';
export interface ImpactRefreshClaim {
  tenantId: string; clientId: string; billId: string; requestedBy: string | null;
  claimToken: string; requestVersion: string; forceRefresh: boolean; attempts: number; observedFingerprint: string | null;
}
type Candidate = { tenantId: string; clientId: string; billId: string; requestedBy: string | null };
type Scan = { tenant: string; client: string; bill: string };

/** System transactions only manage inventory/claims. All evidence work uses the current actor. */
@Injectable()
export class ImpactRefreshRepository {
  constructor(private readonly prisma: PrismaService) {}

  async enqueue(tx: Prisma.TransactionClient, ctx: TenantContext, clientId: string, billId: string) {
    await tx.$executeRawUnsafe(`INSERT INTO legiwatch_impact_refresh(tenant_id,client_id,bill_id,requested_by,force_refresh)
      VALUES($1::uuid,$2::uuid,$3,$4::uuid,true) ON CONFLICT(tenant_id,client_id,bill_id) DO UPDATE SET
      requested_by=EXCLUDED.requested_by,force_refresh=true,
      state=CASE WHEN legiwatch_impact_refresh.state='running' THEN 'running' ELSE 'queued' END,
      attempts=CASE WHEN legiwatch_impact_refresh.state='running' THEN legiwatch_impact_refresh.attempts ELSE 0 END,
      error_code=NULL,next_check_at=now(),requested_at=now(),updated_at=now(),
      request_version=legiwatch_impact_refresh.request_version+1`, ctx.tenantId, clientId, billId, ctx.userId);
  }

  async discover(limit: number): Promise<number> {
    return this.prisma.withSystem(async tx => {
      const cursor = (await tx.$queryRawUnsafe<Scan[]>(`SELECT tenant_cursor AS tenant,client_cursor AS client,bill_cursor AS bill
        FROM legiwatch_impact_refresh_scan WHERE id='tracked' FOR UPDATE SKIP LOCKED`))[0];
      if (!cursor) return 0;
      const present = (await tx.$queryRawUnsafe<Array<{ present: boolean }>>(`SELECT to_regclass('public.intel_feature_flag') IS NOT NULL
        AND to_regclass('public.intel_tracked_bill') IS NOT NULL AS present`))[0]?.present;
      // Match ImpactRepository.backend, including the existing internal-tenant default.
      const owner = `coalesce((SELECT f.enabled FROM intel_feature_flag f WHERE f.tenant_id=t.tenant_id::text AND f.feature='tracker_owner_intel'),t.tenant_id::text=$4)`;
      const tracked = present
        ? `SELECT t.tenant_id::text,t.client_id::text,t.bill_id,t.created_by AS actor FROM tracked_bill t WHERE NOT ${owner}
           UNION ALL SELECT t.tenant_id,t.client_id,t.bill_id,t.tracked_by AS actor FROM intel_tracked_bill t WHERE ${owner}`
        : `SELECT t.tenant_id::text,t.client_id::text,t.bill_id,t.created_by AS actor FROM tracked_bill t WHERE $4::text IS NOT NULL`;
      const page = await tx.$queryRawUnsafe<Candidate[]>(`WITH tracked AS (${tracked}), page AS (
        SELECT t.* FROM tracked t JOIN tenants tenant ON tenant.id::text=t.tenant_id AND tenant.status::text='active'
        JOIN clients c ON c.tenant_id::text=t.tenant_id AND c.id::text=t.client_id AND c.status<>'archived'
        WHERE (t.tenant_id,t.client_id,t.bill_id)>($1,$2,$3)
        ORDER BY t.tenant_id,t.client_id,t.bill_id LIMIT $5)
        SELECT p.tenant_id AS "tenantId",p.client_id AS "clientId",p.bill_id AS "billId",actor.id::text AS "requestedBy"
        FROM page p LEFT JOIN LATERAL (
          SELECT u.id FROM users u JOIN tenant_memberships m ON m.user_id=u.id AND m.tenant_id::text=p.tenant_id
          JOIN clients c ON c.tenant_id=m.tenant_id AND c.id::text=p.client_id
          WHERE (u.id::text=p.actor OR u.clerk_user_id=p.actor) AND m.status::text='active'
            AND m.role::text IN ('standard_user','user_admin','capiro_admin')
            AND (NOT c.memory_wall OR EXISTS (SELECT 1 FROM client_memory_access a
              WHERE a.tenant_id=c.tenant_id AND a.client_id=c.id AND a.user_id=u.id))
          ORDER BY (u.id::text=p.actor) DESC LIMIT 1) actor ON true
        ORDER BY p.tenant_id,p.client_id,p.bill_id`, cursor.tenant, cursor.client, cursor.bill,
      process.env.CAPIRO_INTERNAL_TENANT_ID ?? '', limit);
      for (const candidate of page) if (candidate.requestedBy) await tx.$executeRawUnsafe(
        `INSERT INTO legiwatch_impact_refresh(tenant_id,client_id,bill_id,requested_by)
         VALUES($1::uuid,$2::uuid,$3,$4::uuid) ON CONFLICT(tenant_id,client_id,bill_id) DO NOTHING`,
        candidate.tenantId, candidate.clientId, candidate.billId, candidate.requestedBy);
      const last = page.length === limit ? page.at(-1) : undefined;
      await tx.$executeRawUnsafe(`UPDATE legiwatch_impact_refresh_scan SET tenant_cursor=$1,client_cursor=$2,bill_cursor=$3,updated_at=now() WHERE id='tracked'`,
        last?.tenantId ?? '', last?.clientId ?? '', last?.billId ?? '');
      return page.filter(candidate => candidate.requestedBy).length;
    }, { timeoutMs: 30_000 });
  }

  async claim(leaseMs: number): Promise<ImpactRefreshClaim | null> {
    return this.prisma.withSystem(async tx => (await tx.$queryRawUnsafe<ImpactRefreshClaim[]>(`
      WITH due AS (SELECT tenant_id,client_id,bill_id FROM legiwatch_impact_refresh
        WHERE (state<>'running' AND next_check_at<=now()) OR (state='running' AND claimed_until<=now())
        ORDER BY next_check_at,tenant_id,client_id,bill_id FOR UPDATE SKIP LOCKED LIMIT 1)
      UPDATE legiwatch_impact_refresh q SET state='running',claim_token=$1::uuid,
        claimed_until=now()+($2::int * interval '1 millisecond'),updated_at=now()
      FROM due WHERE q.tenant_id=due.tenant_id AND q.client_id=due.client_id AND q.bill_id=due.bill_id
      RETURNING q.tenant_id::text AS "tenantId",q.client_id::text AS "clientId",q.bill_id AS "billId",
        q.requested_by::text AS "requestedBy",q.claim_token::text AS "claimToken",q.request_version::text AS "requestVersion",
        q.force_refresh AS "forceRefresh",q.attempts,q.observed_fingerprint AS "observedFingerprint"`, randomUUID(), leaseMs))[0] ?? null,
    { timeoutMs: 10_000 });
  }

  async actor(claim: ImpactRefreshClaim): Promise<TenantContext | null> {
    if (!claim.requestedBy) return null;
    return this.prisma.withSystem(async tx => (await tx.$queryRawUnsafe<TenantContext[]>(`
      SELECT m.tenant_id::text AS "tenantId",u.id::text AS "userId",u.clerk_user_id AS "clerkUserId",t.slug AS "tenantSlug",m.role
      FROM tenant_memberships m JOIN users u ON u.id=m.user_id JOIN tenants t ON t.id=m.tenant_id
      WHERE m.tenant_id=$1::uuid AND u.id=$2::uuid AND m.status::text='active' AND t.status::text='active'
        AND m.role::text IN ('standard_user','user_admin','capiro_admin')`, claim.tenantId, claim.requestedBy))[0] ?? null,
    { timeoutMs: 10_000 });
  }

  async assertClaim(tx: Prisma.TransactionClient, claim: ImpactRefreshClaim) {
    const rows = await tx.$queryRawUnsafe<Array<{ valid: boolean }>>(`SELECT true AS valid FROM legiwatch_impact_refresh
      WHERE tenant_id=$1::uuid AND client_id=$2::uuid AND bill_id=$3 AND state='running'
        AND claim_token=$4::uuid AND claimed_until>clock_timestamp() FOR UPDATE`,
    claim.tenantId, claim.clientId, claim.billId, claim.claimToken);
    if (!rows[0]?.valid) throw new ConflictException('Impact refresh claim expired');
  }

  async beginAttempt(claim: ImpactRefreshClaim, fingerprint: string): Promise<number> {
    // Record the spend attempt before inference so a crashed worker cannot reset retry limits.
    const rows = await this.prisma.withSystem(tx => tx.$queryRawUnsafe<Array<{ attempts: number }>>(`
      UPDATE legiwatch_impact_refresh SET attempts=CASE WHEN observed_fingerprint IS DISTINCT FROM $5 THEN 1 ELSE attempts+1 END,
        observed_fingerprint=$5,updated_at=now()
      WHERE tenant_id=$1::uuid AND client_id=$2::uuid AND bill_id=$3 AND state='running'
        AND claim_token=$4::uuid AND claimed_until>clock_timestamp()
        AND (observed_fingerprint IS DISTINCT FROM $5 OR attempts<$6) RETURNING attempts`,
    claim.tenantId, claim.clientId, claim.billId, claim.claimToken, fingerprint, IMPACT_REFRESH_MAX_ATTEMPTS), { timeoutMs: 10_000 });
    if (!rows[0]) throw new ConflictException('Impact refresh claim expired or retries exhausted');
    return rows[0].attempts;
  }

  async finish(claim: ImpactRefreshClaim, result: { fingerprint: string | null; error: ImpactRefreshError | null; attempts: number; delayMs: number }) {
    return this.prisma.withSystem(tx => tx.$executeRawUnsafe(`UPDATE legiwatch_impact_refresh SET
      state=CASE WHEN request_version>$5::bigint THEN 'queued' WHEN $7::text IS NULL THEN 'idle' ELSE 'failed' END,
      next_check_at=CASE WHEN request_version>$5::bigint THEN now() ELSE now()+($9::int * interval '1 millisecond') END,
      attempts=CASE WHEN request_version>$5::bigint THEN 0 ELSE $8 END,
      force_refresh=request_version>$5::bigint,
      observed_fingerprint=$6,error_code=$7,claim_token=NULL,claimed_until=NULL,updated_at=now()
      WHERE tenant_id=$1::uuid AND client_id=$2::uuid AND bill_id=$3 AND state='running'
        AND claim_token=$4::uuid AND claimed_until>clock_timestamp()`,
    claim.tenantId, claim.clientId, claim.billId, claim.claimToken, claim.requestVersion,
    result.fingerprint, result.error, result.attempts, result.delayMs), { timeoutMs: 10_000 });
  }
}
