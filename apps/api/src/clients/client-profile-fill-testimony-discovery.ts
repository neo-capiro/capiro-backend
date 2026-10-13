import { matchesTestimonyOrganization } from '@capiro/shared';
import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../prisma/prisma.service.js';
import { asString } from './client-profile-fill.helpers.js';
import type { AdvocacySourceBackfillState } from './client-profile-fill-advocacy-health.js';
import {
  planTestimonyScanBatch,
  testimonyMatchConfidence,
} from './client-profile-fill-advocacy-mapping.js';
import {
  MAX_ADVOCACY_FINDINGS,
  type PublicAdvocacyDiscoveryPorts,
} from './client-profile-fill-advocacy-discovery.shared.js';

const TESTIMONY_AUTO_MATCH_THRESHOLD = 0.55;
const TESTIMONY_INTEL_MAPPING_SOURCE = 'testimony';
const TESTIMONY_SCAN_BATCH_SIZE = 500;

interface TestimonyRow {
  hearingId: string;
  title: string;
  committeeName: string;
  chamber: string;
  date: Date;
  url: string | null;
  witnessText: string;
}

interface TestimonyScanRow extends TestimonyRow {
  syncedAt: Date;
  similarity: number;
}

interface TestimonyDiscoveryResult {
  count: number;
  newestSyncedAt: string | null;
  newestKey: string | null;
  backfill: AdvocacySourceBackfillState;
}

type TestimonyScanPlan = ReturnType<typeof planTestimonyScanBatch>;

/** Confirmed witness bypass and resumable federal-source scan remain independent. */
export class ClientProfileFillTestimonyDiscovery {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ports: PublicAdvocacyDiscoveryPorts,
  ) {}

  async gather(
    ctx: TenantContext,
    clientId: string,
    runId: string,
    currentCount: number,
    lastTestimonySyncedAt: string | null,
    lastTestimonyKey: string | null,
    priorState: Record<string, unknown>,
  ): Promise<{
    count: number;
    newestSyncedAt: string | null;
    newestKey: string | null;
    backfill: AdvocacySourceBackfillState;
  }> {
    const startedAt = asString(priorState.startedAt) ?? new Date().toISOString();
    const noAdvance = this.noAdvance(
      priorState,
      startedAt,
      lastTestimonySyncedAt,
      lastTestimonyKey,
    );
    if (currentCount >= MAX_ADVOCACY_FINDINGS) return noAdvance;

    const clientName = await this.ports.resolveClientName(ctx, clientId);
    if (!clientName) return noAdvance;

    const confirmedKeys = await this.ports.confirmedMappingKeys(
      ctx,
      clientId,
      TESTIMONY_INTEL_MAPPING_SOURCE,
    );
    const count = await this.gatherConfirmed(ctx, clientId, runId, currentCount, confirmedKeys);
    return this.scanAndEmit(
      ctx,
      clientId,
      runId,
      currentCount,
      lastTestimonySyncedAt,
      lastTestimonyKey,
      priorState,
      startedAt,
      noAdvance,
      clientName,
      confirmedKeys,
      count,
    );
  }

  private noAdvance(
    priorState: Record<string, unknown>,
    startedAt: string,
    lastTestimonySyncedAt: string | null,
    lastTestimonyKey: string | null,
  ): TestimonyDiscoveryResult {
    return {
      count: 0,
      newestSyncedAt: lastTestimonySyncedAt,
      newestKey: lastTestimonyKey,
      backfill: {
        status: 'in_progress' as const,
        startedAt,
        checkpoint: lastTestimonySyncedAt
          ? { syncedAt: lastTestimonySyncedAt, key: lastTestimonyKey }
          : null,
        historyStart: asString(priorState.historyStart) ?? null,
        examined: Number(priorState.examined ?? 0),
        candidates: Number(priorState.candidates ?? 0),
        lastError: null,
      },
    };
  }

  private async gatherConfirmed(
    ctx: TenantContext,
    clientId: string,
    runId: string,
    currentCount: number,
    confirmedKeys: Set<string>,
  ): Promise<number> {
    let count = 0;
    if (confirmedKeys.size && currentCount + count < MAX_ADVOCACY_FINDINGS) {
      let confirmedRows: TestimonyRow[];
      try {
        confirmedRows = await this.prisma.$queryRawUnsafe(
          `SELECT ch.id AS "hearingId", ch.title, ch.committee_name AS "committeeName",
                  ch.chamber, ch.date, ch.url, w AS "witnessText"
             FROM federal_committee_hearing ch, unnest(ch.witnesses) AS w
            WHERE (ch.id || '::' || w) = ANY($1::text[])`,
          [...confirmedKeys],
        );
      } catch (error) {
        this.ports.warn(
          `Testimony discovery confirmed-mapping lookup unavailable: ${this.ports.safeError(error)}`,
        );
        confirmedRows = [];
      }
      for (const row of confirmedRows) {
        if (currentCount + count >= MAX_ADVOCACY_FINDINGS) break;
        const inserted = await this.addTestimonyFinding(ctx, clientId, runId, row, true, 1);
        if (inserted) count += 1;
      }
    }
    return count;
  }

  private async scanAndEmit(
    ctx: TenantContext,
    clientId: string,
    runId: string,
    currentCount: number,
    lastTestimonySyncedAt: string | null,
    lastTestimonyKey: string | null,
    priorState: Record<string, unknown>,
    startedAt: string,
    noAdvance: TestimonyDiscoveryResult,
    clientName: string,
    confirmedKeys: Set<string>,
    count: number,
  ): Promise<TestimonyDiscoveryResult> {
    let scanRows: TestimonyScanRow[] = [];
    if (currentCount + count < MAX_ADVOCACY_FINDINGS) {
      try {
        scanRows = await this.loadScanRows(lastTestimonySyncedAt, lastTestimonyKey, clientName);
      } catch (error) {
        this.ports.warn(
          `Testimony discovery scan rail unavailable: ${this.ports.safeError(error)}`,
        );
        const lastError = this.ports.safeError(error);
        return {
          count,
          newestSyncedAt: lastTestimonySyncedAt,
          newestKey: lastTestimonyKey,
          backfill: { ...noAdvance.backfill, status: 'partial', candidates: count, lastError },
        };
      }
    }
    const progress = await this.emitScanPlan(
      ctx,
      clientId,
      runId,
      currentCount,
      count,
      clientName,
      confirmedKeys,
      scanRows,
    );
    return this.finishScan(
      progress.count,
      progress.plan,
      scanRows,
      lastTestimonySyncedAt,
      lastTestimonyKey,
      priorState,
      startedAt,
    );
  }

  private async loadScanRows(
    lastTestimonySyncedAt: string | null,
    lastTestimonyKey: string | null,
    clientName: string,
  ): Promise<TestimonyScanRow[]> {
    return this.prisma.$queryRawUnsafe<TestimonyScanRow[]>(
      `SELECT ch.id AS "hearingId", ch.title, ch.committee_name AS "committeeName",
                  ch.chamber, ch.date, ch.url, ch.synced_at AS "syncedAt", w AS "witnessText",
                  GREATEST(similarity(w, $3), word_similarity($3, w))::float AS similarity
             FROM federal_committee_hearing ch, unnest(ch.witnesses) AS w
            WHERE ($1::timestamptz IS NULL)
               OR (ch.synced_at > $1::timestamptz)
               OR (ch.synced_at = $1::timestamptz AND (ch.id || '::' || w) > $2::text)
            ORDER BY ch.synced_at ASC, (ch.id || '::' || w) ASC
            LIMIT $4`,
      lastTestimonySyncedAt,
      lastTestimonyKey ?? '',
      clientName,
      TESTIMONY_SCAN_BATCH_SIZE,
    );
  }

  private async emitScanPlan(
    ctx: TenantContext,
    clientId: string,
    runId: string,
    currentCount: number,
    count: number,
    clientName: string,
    confirmedKeys: Set<string>,
    scanRows: TestimonyScanRow[],
  ): Promise<{ count: number; plan: TestimonyScanPlan }> {
    const remainingBudget = MAX_ADVOCACY_FINDINGS - (currentCount + count);
    const plan = planTestimonyScanBatch(
      scanRows,
      confirmedKeys,
      TESTIMONY_AUTO_MATCH_THRESHOLD,
      remainingBudget,
    );
    for (const row of plan.toEmit) {
      if (!matchesTestimonyOrganization(clientName, row.witnessText)) continue;
      const inserted = await this.addTestimonyFinding(
        ctx,
        clientId,
        runId,
        row,
        false,
        row.similarity,
      );
      if (inserted) count += 1;
    }
    return { count, plan };
  }

  private finishScan(
    count: number,
    plan: TestimonyScanPlan,
    scanRows: TestimonyScanRow[],
    lastTestimonySyncedAt: string | null,
    lastTestimonyKey: string | null,
    priorState: Record<string, unknown>,
    startedAt: string,
  ): TestimonyDiscoveryResult {
    const scanComplete =
      scanRows.length < TESTIMONY_SCAN_BATCH_SIZE &&
      (scanRows.length === 0 ||
        plan.cursor?.key === `${scanRows.at(-1)!.hearingId}::${scanRows.at(-1)!.witnessText}`);
    return {
      count,
      newestSyncedAt: plan.cursor?.syncedAt ?? lastTestimonySyncedAt,
      newestKey: plan.cursor?.key ?? lastTestimonyKey,
      backfill: {
        status: scanComplete ? 'complete' : 'in_progress',
        startedAt,
        completedAt: scanComplete ? new Date().toISOString() : undefined,
        checkpoint:
          plan.cursor ??
          (lastTestimonySyncedAt
            ? { syncedAt: lastTestimonySyncedAt, key: lastTestimonyKey }
            : null),
        historyStart: null,
        examined:
          Number(priorState.examined ?? 0) +
          (plan.cursor
            ? scanRows.findIndex(
                (row) => `${row.hearingId}::${row.witnessText}` === plan.cursor!.key,
              ) + 1
            : 0),
        candidates: Number(priorState.candidates ?? 0) + count,
        lastError: null,
      },
    };
  }

  private async addTestimonyFinding(
    ctx: TenantContext,
    clientId: string,
    runId: string,
    row: {
      hearingId: string;
      title: string;
      committeeName: string;
      chamber: string;
      date: Date;
      url: string | null;
      witnessText: string;
    },
    isConfirmed: boolean,
    similarity: number,
  ): Promise<boolean> {
    const confidence = testimonyMatchConfidence(isConfirmed, similarity);
    const compoundKey = `${row.hearingId}::${row.witnessText}`;
    const externalKey = `testimony:${compoundKey}`;
    const proposedValue = {
      externalKey,
      recordType: 'congressional_testimony',
      title: `Congressional testimony — ${row.witnessText} at ${row.title}`,
      summary: `${row.chamber} ${row.committeeName}`,
      activityDate: row.date.toISOString(),
      status: null,
      outcome: null,
      sourceType: 'testimony',
      sourceId: row.hearingId,
      sourceUrl: row.url,
      // HONEST COVERAGE GAP (matches linkTestimony's own comment): no
      // canonical testimony document/organization row exists in this
      // repo. This finding's evidence is the witness string as recorded
      // on the hearing itself — never fabricated beyond that.
      evidenceClass: isConfirmed ? 'PUBLIC_VERIFIED' : 'INFERRED',
      confidence,
      metadata: {
        hearingId: row.hearingId,
        witness: row.witnessText,
        committeeName: row.committeeName,
        chamber: row.chamber,
        clientMatch: {
          method: isConfirmed ? 'confirmed_client_intel_mapping' : 'organization_name',
          confidence,
          similarity: isConfirmed ? null : similarity,
        },
      },
    };
    return this.ports.emitFinding(ctx, clientId, runId, {
      externalKey,
      isConfirmed,
      confidence,
      proposedValue,
      evidence: [
        {
          label: proposedValue.title,
          source: 'Congressional committee hearing witness list',
          metadata: { hearingId: row.hearingId, witness: row.witnessText },
        },
      ],
    });
  }
}
