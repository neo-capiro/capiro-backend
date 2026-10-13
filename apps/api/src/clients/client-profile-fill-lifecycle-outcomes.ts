import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../prisma/prisma.service.js';
import { asRecord, asString } from './client-profile-fill.helpers.js';
import { normalizePersistedAdvocacy, parseDate } from './client-profile-fill-advocacy-mapping.js';
import { isCommunityFundingAdvocacyRecord } from './community-funding-appropriations-outcome.js';
import {
  ClientProfileFillLifecycleOutcomeFindings,
  type LifecycleMatterIdentifier,
  type LifecycleOutcome,
  type LifecycleOutcomesPorts,
} from './client-profile-fill-lifecycle-outcome-findings.js';

export class ClientProfileFillLifecycleOutcomes {
  private readonly findings: ClientProfileFillLifecycleOutcomeFindings;

  constructor(
    private readonly prisma: PrismaService,
    private readonly ports: LifecycleOutcomesPorts,
  ) {
    this.findings = new ClientProfileFillLifecycleOutcomeFindings(this.ports);
  }

  private readSnapshot(ctx: TenantContext, clientId: string, runId: string) {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const findings = await tx.$queryRawUnsafe<Array<{ proposedValue: unknown }>>(
        `SELECT proposed_value_jsonb AS "proposedValue"
             FROM client_profile_fill_finding
            WHERE tenant_id = $1::uuid AND client_id = $2::uuid AND run_id = $3::uuid
              AND kind = 'advocacy_record' AND status IN ('pending', 'accepted')`,
        ctx.tenantId,
        clientId,
        runId,
      );
      const records = await tx.$queryRawUnsafe<Array<{ data: unknown }>>(
        `SELECT to_jsonb(a) AS data
             FROM client_advocacy_record a
            WHERE tenant_id = $1::uuid AND client_id = $2::uuid
            ORDER BY activity_date DESC NULLS LAST
            LIMIT 250`,
        ctx.tenantId,
        clientId,
      );
      const events = await tx.outcomeEvent.findMany({
        where: { tenantId: ctx.tenantId, clientId },
        select: {
          id: true,
          kind: true,
          sourceType: true,
          sourceId: true,
          evidence: true,
          notes: true,
          observedAt: true,
        },
        orderBy: { observedAt: 'desc' },
        take: 250,
      });
      // §16 deterministic-identifier priority requires matching against
      // the record's own MATTER's primary_pe_code/primary_bill_id (what
      // the Matter is actually about), not anything on the individual
      // record itself -- client_advocacy_record carries no PE/bill field
      // of its own. One extra lookup, keyed by matter_id, rather than N
      // per-record round trips.
      const identifiers = await tx.$queryRawUnsafe<
        Array<{ id: string; primaryPeCode: string | null; primaryBillId: string | null }>
      >(
        `SELECT id, primary_pe_code AS "primaryPeCode", primary_bill_id AS "primaryBillId"
             FROM client_advocacy_matter
            WHERE tenant_id = $1::uuid AND client_id = $2::uuid`,
        ctx.tenantId,
        clientId,
      );
      return [findings, records, events, identifiers] as const;
    });
  }

  async gather(ctx: TenantContext, clientId: string, runId: string): Promise<number> {
    const [findingRows, persistedRecords, outcomes, matterIdentifiers] = await this.readSnapshot(
      ctx,
      clientId,
      runId,
    );
    const matterIdentifierById = new Map(matterIdentifiers.map((m) => [m.id, m] as const));
    const advocacy = [
      ...findingRows.map((row) => asRecord(row.proposedValue)),
      ...persistedRecords.map((row) => normalizePersistedAdvocacy(asRecord(row.data))),
    ];
    let count = 0;
    const seen = new Set<string>();
    for (const record of advocacy) {
      const externalKey = asString(record.externalKey);
      if (!externalKey || seen.has(externalKey)) continue;
      seen.add(externalKey);
      const activityDate = parseDate(record.activityDate);
      const matterId = asString(record.matterId);
      const matterIdentifier = matterId ? matterIdentifierById.get(matterId) : undefined;
      count = await this.correlateRecord(
        ctx,
        clientId,
        runId,
        record,
        externalKey,
        activityDate,
        matterId,
        matterIdentifier,
        outcomes,
        count,
      );
      if (count >= 75) break;
    }
    await this.ports.recordCursor(ctx.tenantId, clientId, 'lifecycle_outcomes', {
      refreshedAt: new Date().toISOString(),
      latestOutcomeAt: outcomes[0]?.observedAt.toISOString() ?? null,
    });
    return count;
  }

  private async correlateRecord(
    ctx: TenantContext,
    clientId: string,
    runId: string,
    record: Record<string, unknown>,
    externalKey: string,
    activityDate: Date | null,
    matterId: string | null,
    matterIdentifier: LifecycleMatterIdentifier | undefined,
    outcomes: LifecycleOutcome[],
    count: number,
  ): Promise<number> {
    for (const outcome of outcomes) {
      if (activityDate && outcome.observedAt < activityDate) continue;
      const evidence = asRecord(outcome.evidence);
      const metadata = asRecord(record.metadata);
      // CPF/CDS path: ONLY deterministic appropriations correlation. Never fall
      // back to title/temporal similarity — that would invent "secured funding"
      // from weak signals (handoff after #1345).
      if (
        isCommunityFundingAdvocacyRecord({
          externalKey,
          recordType: asString(record.recordType),
          sourceType: asString(record.sourceType),
          sourceId: asString(record.sourceId),
          communityFundingRequestId:
            asString(metadata.communityFundingRequestId) ?? asString(record.sourceId),
        })
      ) {
        const cpfMatch = this.findings.matchCommunityFunding(
          record,
          externalKey,
          metadata,
          outcome,
          evidence,
          activityDate,
        );
        if (!cpfMatch) continue;
        const inserted = await this.findings.emitCommunityFunding(
          ctx,
          clientId,
          runId,
          externalKey,
          matterId,
          outcome,
          evidence,
          cpfMatch,
        );
        if (inserted) count += 1;
        if (count >= 75) break;
        continue;
      }
      const { deterministic, score } = this.findings.matchGeneric(
        record,
        matterIdentifier,
        outcome,
        evidence,
      );
      if (!deterministic && score < 0.34) continue;
      const inserted = await this.findings.emitGeneric(
        ctx,
        clientId,
        runId,
        externalKey,
        outcome,
        deterministic,
        score,
      );
      if (inserted) count += 1;
      if (count >= 75) break;
    }
    return count;
  }
}
