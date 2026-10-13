import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { asRecord, asString } from './client-profile-fill.helpers.js';
import { containsAdvocacyTerm } from './client-profile-fill-advocacy-mapping.js';
import type {
  AdvocacyBackfillStatus,
  AdvocacySourceBackfillState,
} from './client-profile-fill-advocacy-health.js';
import {
  MAX_ADVOCACY_FINDINGS,
  type CompletionFindingInput,
  type TenantAdvocacyDiscoveryPorts,
} from './client-profile-fill-advocacy-discovery.shared.js';

interface SubmissionRow {
  id: string;
  data: unknown;
  capabilityName: string | null;
  createdAt: Date;
}
interface PrivateRow {
  id: string;
  proposedValue: unknown;
  evidence: unknown;
  appliedAt: Date | null;
}
interface Traversal<Row> {
  count: number;
  examined: number;
  lastExamined: Row | undefined;
}

/** Tenant-owned source history emits review proposals through the shared ledger. */
export class ClientProfileFillTenantHistoryDiscovery {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ports: TenantAdvocacyDiscoveryPorts,
  ) {}

  async gatherClientSubmissions(
    ctx: TenantContext,
    clientId: string,
    runId: string,
    currentCount: number,
    lastClientSubmissionAt: string | null,
    priorState: Record<string, unknown>,
  ): Promise<{
    count: number;
    newestCreatedAt: string | null;
    backfill: AdvocacySourceBackfillState;
  }> {
    const startedAt = asString(priorState.startedAt) ?? new Date().toISOString();
    const priorCheckpoint = asRecord(priorState.checkpoint);
    const checkpointAt = asString(priorCheckpoint.createdAt);
    const checkpointKey = asString(priorCheckpoint.key) ?? '';
    if (currentCount >= MAX_ADVOCACY_FINDINGS)
      return {
        count: 0,
        newestCreatedAt: lastClientSubmissionAt,
        backfill: this.backfillState(priorState, startedAt, 'in_progress', 0, 0, priorCheckpoint),
      };
    let rows: SubmissionRow[] = [];
    try {
      rows = await this.readSubmissions(ctx, clientId, checkpointAt, checkpointKey);
    } catch (error) {
      this.ports.warn(
        `Client submission advocacy rail unavailable: ${this.ports.safeError(error)}`,
      );
      return {
        count: 0,
        newestCreatedAt: lastClientSubmissionAt,
        backfill: this.backfillState(
          priorState,
          startedAt,
          'partial',
          0,
          0,
          priorCheckpoint,
          this.ports.safeError(error),
        ),
      };
    }
    const traversal = await this.scanSubmissions(ctx, clientId, runId, currentCount, rows);
    const lastExamined = traversal.lastExamined;
    const complete = rows.length < 100 && traversal.examined === rows.length;
    const nextCheckpoint = lastExamined
      ? { createdAt: lastExamined.createdAt.toISOString(), key: lastExamined.id }
      : priorCheckpoint;
    const backfill = this.backfillState(
      priorState,
      startedAt,
      complete ? 'complete' : 'in_progress',
      traversal.examined,
      traversal.count,
      nextCheckpoint,
    );
    backfill.historyStart =
      asString(priorState.historyStart) ?? rows[0]?.createdAt.toISOString() ?? null;
    // ASC traversal checkpoints the last row examined; a capped run retains the global watermark.
    return {
      count: traversal.count,
      newestCreatedAt: complete
        ? (lastExamined?.createdAt.toISOString() ?? lastClientSubmissionAt)
        : lastClientSubmissionAt,
      backfill,
    };
  }

  async gatherPrivateCandidates(
    ctx: TenantContext,
    clientId: string,
    runId: string,
    currentCount: number,
    lastRelationshipLinkAppliedAt: string | null,
    priorState: Record<string, unknown>,
  ): Promise<{
    count: number;
    newestAppliedAt: string | null;
    backfill: AdvocacySourceBackfillState;
  }> {
    const startedAt = asString(priorState.startedAt) ?? new Date().toISOString();
    const priorCheckpoint = asRecord(priorState.checkpoint);
    const checkpointAt = asString(priorCheckpoint.appliedAt);
    const checkpointKey = asString(priorCheckpoint.key) ?? '';
    if (currentCount >= MAX_ADVOCACY_FINDINGS) {
      return {
        count: 0,
        newestAppliedAt: lastRelationshipLinkAppliedAt,
        backfill: this.backfillState(priorState, startedAt, 'in_progress', 0, 0, priorCheckpoint),
      };
    }
    let rows: PrivateRow[] = [];
    try {
      rows = await this.readPrivateCandidates(ctx, clientId, checkpointAt, checkpointKey);
    } catch (error) {
      const lastError = this.ports.safeError(error);
      this.ports.warn(`Private advocacy rail unavailable: ${lastError}`);
      return {
        count: 0,
        newestAppliedAt: lastRelationshipLinkAppliedAt,
        backfill: {
          ...this.backfillState(priorState, startedAt, 'partial', 0, 0, priorCheckpoint),
          lastError,
        },
      };
    }
    const traversal = await this.scanPrivateCandidates(ctx, clientId, runId, currentCount, rows);
    const lastExamined = traversal.lastExamined;
    const complete = rows.length < 250 && traversal.examined === rows.length;
    const nextCheckpoint = lastExamined?.appliedAt
      ? { appliedAt: lastExamined.appliedAt.toISOString(), key: lastExamined.id }
      : priorCheckpoint;
    const backfill = this.backfillState(
      priorState,
      startedAt,
      complete ? 'complete' : 'in_progress',
      traversal.examined,
      traversal.count,
      nextCheckpoint,
    );
    backfill.historyStart =
      asString(priorState.historyStart) ?? rows[0]?.appliedAt?.toISOString() ?? null;
    // ASC traversal advances only through examined rows; NULL/empty results retain progress.
    return {
      count: traversal.count,
      newestAppliedAt: complete
        ? (lastExamined?.appliedAt?.toISOString() ?? lastRelationshipLinkAppliedAt)
        : lastRelationshipLinkAppliedAt,
      backfill,
    };
  }

  private readSubmissions(
    ctx: TenantContext,
    clientId: string,
    checkpointAt: string | null,
    checkpointKey: string,
  ): Promise<SubmissionRow[]> {
    return this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.$queryRawUnsafe<SubmissionRow[]>(
        `SELECT s.id::text AS id, to_jsonb(s) AS data, c.name AS "capabilityName", s.created_at AS "createdAt"
             FROM client_submission_history s
             JOIN client_capabilities c ON c.id = s.capability_id
            WHERE c.tenant_id = $1::uuid AND c.client_id = $2::uuid
              AND (($3::timestamptz IS NULL) OR s.created_at > $3::timestamptz
                OR (s.created_at = $3::timestamptz AND s.id::text > $4::text))
            ORDER BY s.created_at ASC, s.id::text ASC
            LIMIT 100`,
        ctx.tenantId,
        clientId,
        checkpointAt,
        checkpointKey,
      ),
    );
  }

  private readPrivateCandidates(
    ctx: TenantContext,
    clientId: string,
    checkpointAt: string | null,
    checkpointKey: string,
  ): Promise<PrivateRow[]> {
    return this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.$queryRawUnsafe<PrivateRow[]>(
        `SELECT id,
                proposed_value_jsonb AS "proposedValue",
                evidence_jsonb AS evidence,
                applied_at AS "appliedAt"
           FROM client_profile_fill_finding
          WHERE tenant_id = $1::uuid AND client_id = $2::uuid
            AND kind = 'relationship_link' AND status = 'accepted'
            AND applied_at IS NOT NULL
            AND (($3::timestamptz IS NULL) OR applied_at > $3::timestamptz
              OR (applied_at = $3::timestamptz AND id::text > $4::text))
          ORDER BY applied_at ASC, id::text ASC
          LIMIT 250`,
        ctx.tenantId,
        clientId,
        checkpointAt,
        checkpointKey,
      ),
    );
  }

  private async scanSubmissions(
    ctx: TenantContext,
    clientId: string,
    runId: string,
    currentCount: number,
    rows: SubmissionRow[],
  ): Promise<Traversal<SubmissionRow>> {
    let count = 0;
    let lastExamined: SubmissionRow | undefined;
    let examined = 0;
    for (const row of rows) {
      if (currentCount + count >= MAX_ADVOCACY_FINDINGS) break;
      lastExamined = row;
      examined += 1;
      const input = this.submissionFinding(row);
      if (!input) continue;
      const inserted = await this.ports.persistFinding(ctx.tenantId, clientId, runId, input);
      if (inserted) count += 1;
    }
    return { count, examined, lastExamined };
  }

  private async scanPrivateCandidates(
    ctx: TenantContext,
    clientId: string,
    runId: string,
    currentCount: number,
    rows: PrivateRow[],
  ): Promise<Traversal<PrivateRow>> {
    let count = 0;
    let lastExamined: PrivateRow | undefined;
    let examined = 0;
    for (const row of rows) {
      if (currentCount + count >= MAX_ADVOCACY_FINDINGS) break;
      lastExamined = row;
      examined += 1;
      const input = this.privateFinding(row);
      if (!input) continue;
      const inserted = await this.ports.persistFinding(ctx.tenantId, clientId, runId, input);
      if (inserted) count += 1;
    }
    return { count, examined, lastExamined };
  }

  private submissionFinding(row: SubmissionRow): CompletionFindingInput | null {
    const data = asRecord(row.data);
    const id = asString(data.id);
    if (!id) return null;
    const title = asString(data.title) ?? `${row.capabilityName ?? 'Client'} submission`;
    const proposedValue = {
      externalKey: `client-submission:${id}`,
      recordType: 'client_submission',
      title,
      summary: asString(data.detail) ?? asString(data.description) ?? null,
      activityDate:
        asString(data.submitted_at) ??
        asString(data.created_at) ??
        asString(data.updated_at) ??
        null,
      status: asString(data.status),
      outcome: asString(data.outcome),
      sourceType: 'client_submission',
      sourceId: id,
      sourceUrl: null,
      evidenceClass: 'CLIENT_VERIFIED',
      confidence: 1,
      metadata: { ...data, capabilityName: row.capabilityName },
    };
    return {
      kind: 'advocacy_record',
      targetKey: `advocacy:client-submission:${id}`,
      source: 'advocacy_history',
      factKind: 'fact',
      currentValue: null,
      proposedValue,
      confidence: 1,
      status: 'pending',
      evidence: [
        {
          label: 'Existing client submission history',
          source: 'Capiro client record',
          metadata: { submissionId: id, capabilityName: row.capabilityName },
        },
      ],
    };
  }

  private privateFinding(row: PrivateRow): CompletionFindingInput | null {
    const proposal = asRecord(row.proposedValue);
    const title = asString(proposal.title) ?? '';
    if (!containsAdvocacyTerm(title)) return null;
    const entityType = asString(proposal.entityType);
    const entityId = asString(proposal.entityId);
    if (!entityType || !entityId) return null;
    const externalKey = `relationship:${entityType}:${entityId}`;
    const proposedValue = {
      externalKey,
      recordType: entityType === 'meeting' ? 'advocacy_meeting' : 'advocacy_correspondence',
      title,
      summary:
        'The interaction subject appears advocacy-related. The source record remains authoritative; review before classifying it as advocacy.',
      activityDate: asString(proposal.occurredAt),
      status: 'activity_observed',
      outcome: null,
      sourceType: entityType,
      sourceId: entityId,
      sourceUrl: null,
      evidenceClass: 'PRIVATE_ACTIVITY',
      confidence: 0.72,
      metadata: {
        relationshipFindingId: row.id,
        matchReason: proposal.matchReason,
        matchedDomains: proposal.matchedDomains,
      },
    };
    return {
      kind: 'advocacy_record',
      targetKey: `advocacy:${externalKey}`,
      source: 'advocacy_history',
      factKind: 'recommendation',
      currentValue: null,
      proposedValue,
      confidence: 0.72,
      status: 'pending',
      evidence: Array.isArray(row.evidence) ? row.evidence : [],
    };
  }

  private backfillState(
    priorState: Record<string, unknown>,
    startedAt: string,
    status: AdvocacyBackfillStatus,
    examined: number,
    candidates: number,
    checkpoint: Record<string, unknown> | null,
    lastError: string | null = null,
  ): AdvocacySourceBackfillState {
    return {
      status,
      startedAt,
      completedAt: status === 'complete' ? new Date().toISOString() : undefined,
      checkpoint,
      historyStart: asString(priorState.historyStart) ?? null,
      examined: Number(priorState.examined ?? 0) + examined,
      candidates: Number(priorState.candidates ?? 0) + candidates,
      lastError,
    };
  }
}
