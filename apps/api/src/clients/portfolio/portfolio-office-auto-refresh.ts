import { createHash } from 'node:crypto';
import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { StartClientProfileFillWorkflowInput } from '../client-profile-fill-workflow.service.js';
import { currentCongress } from './portfolio-office-signals.js';

type Candidate = TenantContext & { clientId: string; cursor: string; localRevision: string };
export function officeRefreshRequestId(
  candidate: Pick<Candidate, 'tenantId' | 'clientId' | 'userId' | 'localRevision'>,
  sourceRevision: string,
) {
  const hash = createHash('sha256')
    .update(
      JSON.stringify([
        'office-refresh-v1',
        candidate.tenantId,
        candidate.clientId,
        candidate.userId,
        candidate.localRevision,
        sourceRevision,
        currentCongress(),
      ]),
    )
    .digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

/** Called by the existing profile worker sweep. No timer, GET mutation, new queue, or fabricated actor. */
export class PortfolioOfficeAutoRefresh {
  private nextCheckAt = 0;
  private cursor = '';
  constructor(private readonly prisma: PrismaService) {}

  async enqueue(
    start: (
      ctx: TenantContext,
      clientId: string,
      input: StartClientProfileFillWorkflowInput,
    ) => Promise<unknown>,
    report: (message: string) => void,
  ) {
    if (Date.now() < this.nextCheckAt) return;
    this.nextCheckAt = Date.now() + 60_000;
    const sourceRevision = await this.sourceRevision();
    const candidates = await this.candidates();
    this.cursor = candidates.length === 10 ? candidates[candidates.length - 1]!.cursor : '';
    for (const candidate of candidates) {
      const { clientId, localRevision: _localRevision, cursor: _cursor, ...ctx } = candidate;
      const requestId = officeRefreshRequestId(candidate, sourceRevision);
      const exists = await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, (tx) =>
        tx.$queryRawUnsafe<Array<{ id: string }>>(
          'SELECT id FROM client_profile_fill_run WHERE tenant_id=$1::uuid AND client_id=$2::uuid AND id=$3::uuid',
          ctx.tenantId,
          clientId,
          requestId,
        ),
      );
      if (exists.length) continue; // Existing task retry/review remains the owner, including failed/cancelled work.
      try {
        await start(ctx, clientId, { requestId, sources: ['bill_tracker'] });
      } catch (error) {
        // Current actor/wall checks in startRun are authoritative. A denied actor or busy
        // subject never blocks the other subjects, and no alternative identity is invented.
        const status =
          error &&
          typeof error === 'object' &&
          'getStatus' in error &&
          typeof error.getStatus === 'function'
            ? error.getStatus()
            : undefined;
        if (![400, 401, 403, 404, 409].includes(Number(status)))
          report(
            'Office source refresh could not enqueue; the existing worker will retry its source check.',
          );
      }
    }
  }

  private sourceRevision(): Promise<string> {
    return this.prisma.withSystem(async (tx) => {
      const rows = await tx.$queryRawUnsafe<Array<{ revision: string }>>(`SELECT md5(concat_ws('|',
        (SELECT concat(count(*), ':', max(synced_at)) FROM member_press_item),
        (SELECT concat(count(*), ':', max(last_synced_at)) FROM congress_bill),
        (SELECT concat(count(*), ':', max(last_synced_at)) FROM congress_bill_cosponsor),
        (SELECT concat(count(*), ':', max(fetched_at)) FROM federal_evidence_revision),
        (SELECT concat(count(*), ':', max(synced_at), ':', max(last_official_update_at), ':', sum(source_revision)) FROM committee_hearing),
        (SELECT concat(count(*), ':', max(last_synced_at)) FROM congress_committee_membership),
        (SELECT concat(count(*), ':', max(last_synced_at)) FROM congress_committee))) AS revision`);
      return rows[0]!.revision;
    });
  }

  private candidates(): Promise<Candidate[]> {
    return this.prisma.withSystem((tx) =>
      tx.$queryRawUnsafe<Candidate[]>(
        `WITH participants AS (
      SELECT DISTINCT ON (r.tenant_id,r.client_id) r.tenant_id,r.client_id,r.created_by_user_id
      FROM client_profile_fill_run r JOIN clients c ON c.id=r.client_id AND c.tenant_id=r.tenant_id
      WHERE r.client_id IS NOT NULL AND c.status<>'archived' AND 'bill_tracker'=ANY(r.requested_sources)
        AND r.status IN ('completed','partial')
      ORDER BY r.tenant_id,r.client_id,r.created_at DESC
    ) SELECT p.tenant_id AS "tenantId",p.client_id AS "clientId",p.created_by_user_id AS "userId",
      u.clerk_user_id AS "clerkUserId",t.slug AS "tenantSlug",tm.role,
      p.tenant_id::text||':'||p.client_id::text AS cursor,
      concat_ws('|',(SELECT max(approved_at) FROM client_capability_terms x WHERE x.tenant_id=p.tenant_id AND x.client_id=p.client_id),
        (SELECT max(updated_at) FROM client_portfolio_proposals x WHERE x.tenant_id=p.tenant_id AND x.client_id=p.client_id AND x.kind='statement' AND x.status='approved')) AS "localRevision"
      FROM participants p JOIN tenant_memberships tm ON tm.tenant_id=p.tenant_id AND tm.user_id=p.created_by_user_id
      JOIN users u ON u.id=tm.user_id JOIN tenants t ON t.id=tm.tenant_id
      WHERE tm.status::text='active' AND t.status::text='active' AND u.clerk_user_id IS NOT NULL
        AND (p.tenant_id::text||':'||p.client_id::text)>$1
      ORDER BY p.tenant_id,p.client_id LIMIT 10`,
        this.cursor,
      ),
    );
  }
}
