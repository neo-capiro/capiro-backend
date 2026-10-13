import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../prisma/prisma.service.js';
import { asRecord, asString } from './client-profile-fill.helpers.js';
import {
  recordsFromUnknown,
  summarizeLdaActivity,
} from './client-profile-fill-advocacy-mapping.js';
import type { AdvocacySourceBackfillState } from './client-profile-fill-advocacy-health.js';
import {
  MAX_ADVOCACY_FINDINGS,
  type TenantAdvocacyDiscoveryPorts,
} from './client-profile-fill-advocacy-discovery.shared.js';

const LDA_BACKFILL_BATCH_SIZE = 250;

interface LdaBackfillRow {
  filingUuid: string;
  clientId: number;
  clientName: string;
  filingType: string;
  filingYear: number;
  filingPeriod: string | null;
  dtPosted: Date | null;
  scanAt: Date;
  registrantName: string;
  clientDescription: string | null;
  income: unknown;
  expenses: unknown;
  issueCodes: string[];
  governmentEntities: unknown;
  lobbyingActivities: unknown;
  filingDocumentUrl: string | null;
}

interface LdaResumePoint {
  at: string | null;
  key: string;
  activityIndex: number;
}
interface LdaProgress {
  count: number;
  examined: number;
  checkpoint: Record<string, unknown> | null;
  stoppedAtCap: boolean;
}
export interface LdaBackfillResult {
  count: number;
  backfill: AdvocacySourceBackfillState;
  checkpoint: Record<string, unknown> | null;
  lastDtPosted: string | null;
}

/** Selected-filing traversal, including resumable activity indices and inserted-only budget. */
export class ClientProfileFillLdaDiscovery {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ports: TenantAdvocacyDiscoveryPorts,
  ) {}

  async gather(
    ctx: TenantContext,
    clientId: string,
    runId: string,
    ldaIds: number[],
    cursor: Record<string, unknown>,
    priorSources: Record<string, unknown>,
    invocationStartedAt: string,
  ): Promise<LdaBackfillResult> {
    const lastDtPosted = asString(cursor.lastLdaPostedAt);
    const priorLda = asRecord(priorSources.lda);
    const priorLdaCheckpoint = asRecord(priorLda.checkpoint);
    const ldaBackfillWasComplete = asString(priorLda.status) === 'complete';
    const ldaCheckpointAt = ldaBackfillWasComplete
      ? lastDtPosted
      : asString(priorLdaCheckpoint.scanAt);
    const ldaCheckpointKey = ldaBackfillWasComplete
      ? (asString(cursor.lastLdaKey) ?? '')
      : (asString(priorLdaCheckpoint.key) ?? '');
    const ldaCheckpointActivity = ldaBackfillWasComplete
      ? Number(cursor.lastLdaActivityIndex ?? -1)
      : Number(priorLdaCheckpoint.activityIndex ?? -1);
    const point = {
      at: ldaCheckpointAt,
      key: ldaCheckpointKey,
      activityIndex: ldaCheckpointActivity,
    };
    let filings: LdaBackfillRow[] = [];
    let ldaError: string | null = null;
    try {
      filings = await this.loadFilings(ldaIds, point);
    } catch (error) {
      ldaError = this.ports.safeError(error);
      this.ports.warn(`LDA historical backfill unavailable: ${ldaError}`);
    }
    const progress: LdaProgress = {
      count: 0,
      examined: 0,
      checkpoint: Object.keys(priorLdaCheckpoint).length ? priorLdaCheckpoint : null,
      stoppedAtCap: false,
    };
    await this.walkFilings(ctx, clientId, runId, filings, point, progress);
    const ldaComplete =
      ldaBackfillWasComplete ||
      (!ldaError && !progress.stoppedAtCap && filings.length < LDA_BACKFILL_BATCH_SIZE);
    const ldaStartedAt = asString(priorLda.startedAt) ?? invocationStartedAt;
    const backfill: AdvocacySourceBackfillState = {
      status: ldaError ? 'partial' : ldaComplete ? 'complete' : 'in_progress',
      startedAt: ldaStartedAt,
      completedAt: ldaComplete ? invocationStartedAt : undefined,
      checkpoint: ldaBackfillWasComplete ? priorLdaCheckpoint : progress.checkpoint,
      historyStart: asString(priorLda.historyStart) ?? filings[0]?.scanAt.toISOString() ?? null,
      examined: Number(priorLda.examined ?? 0) + progress.examined,
      candidates: Number(priorLda.candidates ?? 0) + progress.count,
      lastError: ldaError,
    };
    return { count: progress.count, backfill, checkpoint: progress.checkpoint, lastDtPosted };
  }

  private async loadFilings(ldaIds: number[], point: LdaResumePoint): Promise<LdaBackfillRow[]> {
    return ldaIds.length
      ? await this.prisma.$queryRawUnsafe<LdaBackfillRow[]>(
          `SELECT filing_uuid AS "filingUuid",
                  client_id AS "clientId",
                  client_name AS "clientName",
                  filing_type AS "filingType",
                  filing_year AS "filingYear",
                  filing_period AS "filingPeriod",
                  dt_posted AS "dtPosted",
                  COALESCE(dt_posted, make_date(filing_year, 1, 1)::timestamptz) AS "scanAt",
                  registrant_name AS "registrantName",
                  client_description AS "clientDescription",
                  income,
                  expenses,
                  issue_codes AS "issueCodes",
                  government_entities AS "governmentEntities",
                  lobbying_activities AS "lobbyingActivities",
                  filing_document_url AS "filingDocumentUrl"
             FROM lda_filing
            WHERE client_id = ANY($1::int[])
              AND (($2::timestamptz IS NULL)
                OR (COALESCE(dt_posted, make_date(filing_year, 1, 1)::timestamptz) > $2::timestamptz)
                OR (COALESCE(dt_posted, make_date(filing_year, 1, 1)::timestamptz) = $2::timestamptz
                    AND filing_uuid >= $3::text))
            ORDER BY COALESCE(dt_posted, make_date(filing_year, 1, 1)::timestamptz) ASC,
                     filing_uuid ASC
            LIMIT $4`,
          ldaIds,
          point.at,
          point.key,
          LDA_BACKFILL_BATCH_SIZE,
        )
      : [];
  }

  private async walkFilings(
    ctx: TenantContext,
    clientId: string,
    runId: string,
    filings: LdaBackfillRow[],
    point: LdaResumePoint,
    progress: LdaProgress,
  ): Promise<void> {
    for (const filing of filings) {
      const activities = recordsFromUnknown(filing.lobbyingActivities);
      const records = activities.length ? activities : [{}];
      const resumesSameFiling =
        point.at === filing.scanAt.toISOString() && point.key === filing.filingUuid;
      for (
        let index = resumesSameFiling ? point.activityIndex + 1 : 0;
        index < records.length;
        index += 1
      ) {
        if (progress.count >= MAX_ADVOCACY_FINDINGS) {
          progress.stoppedAtCap = true;
          break;
        }
        const activity = records[index]!;
        const inserted = await this.emitActivity(ctx, clientId, runId, filing, activity, index);
        if (inserted) progress.count += 1;
        progress.examined += 1;
        progress.checkpoint = {
          scanAt: filing.scanAt.toISOString(),
          key: filing.filingUuid,
          activityIndex: index,
        };
      }
      if (progress.stoppedAtCap) break;
    }
  }

  private async emitActivity(
    ctx: TenantContext,
    clientId: string,
    runId: string,
    filing: LdaBackfillRow,
    activity: Record<string, unknown>,
    index: number,
  ): Promise<boolean> {
    const proposedValue = this.buildProposal(filing, activity, index);
    return this.ports.persistFinding(ctx.tenantId, clientId, runId, {
      kind: 'advocacy_record',
      targetKey: `advocacy:${proposedValue.externalKey}`,
      source: 'advocacy_history',
      factKind: 'fact',
      currentValue: null,
      proposedValue,
      confidence: 1,
      status: 'pending',
      evidence: [
        {
          label: proposedValue.title,
          url: filing.filingDocumentUrl,
          source: 'Senate Lobbying Disclosure Act filing',
          metadata: { filingUuid: filing.filingUuid, activityIndex: index },
        },
      ],
    });
  }

  private buildProposal(filing: LdaBackfillRow, activity: Record<string, unknown>, index: number) {
    const summary = summarizeLdaActivity(activity, filing.clientDescription);
    const issueCode =
      asString(activity.general_issue_code) ??
      asString(activity.issue_code) ??
      filing.issueCodes?.[0] ??
      null;
    const externalKey = `lda:${filing.filingUuid}:${index}`;
    return {
      externalKey,
      recordType: 'federal_lobbying',
      title: `${filing.filingYear}${filing.filingPeriod ? ` ${filing.filingPeriod}` : ''}${
        issueCode ? ` — ${issueCode}` : ''
      }`,
      summary,
      activityDate: filing.dtPosted?.toISOString() ?? null,
      status: filing.filingType,
      outcome: null,
      sourceType: 'lda',
      sourceId: filing.filingUuid,
      sourceUrl: filing.filingDocumentUrl,
      evidenceClass: 'PUBLIC_VERIFIED',
      confidence: 1,
      metadata: {
        ldaClientId: filing.clientId,
        ldaClientName: filing.clientName,
        registrantName: filing.registrantName,
        filingYear: filing.filingYear,
        filingPeriod: filing.filingPeriod,
        income: filing.income == null ? null : Number(filing.income),
        expenses: filing.expenses == null ? null : Number(filing.expenses),
        issueCodes: filing.issueCodes ?? [],
        governmentEntities: filing.governmentEntities,
        activity,
      },
    };
  }
}
