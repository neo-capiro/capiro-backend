import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../prisma/prisma.service.js';
import { asRecord, asString } from './client-profile-fill.helpers.js';
import type {
  AdvocacyBackfillStatus,
  AdvocacySourceBackfillState,
} from './client-profile-fill-advocacy-health.js';
import {
  COMMUNITY_FUNDING_INTEL_MAPPING_SOURCE,
  filterAmbiguousCommunityFundingMatches,
  resolveCommunityFundingRecipientMatch,
  type CommunityFundingMatchDecision,
} from './community-funding-advocacy-match.js';
import {
  MAX_ADVOCACY_FINDINGS,
  type PublicAdvocacyDiscoveryPorts,
} from './client-profile-fill-advocacy-discovery.shared.js';
import {
  ClientProfileFillCommunityFundingSource,
  COMMUNITY_FUNDING_SCAN_BATCH_SIZE,
  type FundingRow,
} from './client-profile-fill-community-funding-source.js';
import { buildCommunityFundingDiscoveryFinding } from './client-profile-fill-community-funding-finding.js';

interface CommunityFundingResult {
  count: number;
  newestCreatedAt: string | null;
  newestKey: string | null;
  backfill: AdvocacySourceBackfillState;
}
interface FundingMatchContext {
  clientName: string;
  confirmedRequestIds: Set<string>;
  clientStates: Set<string>;
}
interface ScanProgress {
  count: number;
  examined: number;
  scanError: string | null;
}
interface ScanFrontier {
  newestCreatedAt: string | null;
  newestKey: string | null;
}
type BuildBackfill = (
  status: AdvocacyBackfillStatus,
  examined?: number,
  candidates?: number,
  lastError?: string | null,
  checkpoint?: Record<string, unknown> | null,
  limitation?: string | null,
) => AdvocacySourceBackfillState;

/**
 * Public-source auto-discovery: House CPF / Senate CDS via canonical
 * `community_funding_request` rows (PR #1328). Primary identity is the
 * funding RECIPIENT, never the Member/Senator requester (brief §16).
 *
 * Flow is review-gated only — this rail emits pending Fill findings; it
 * never writes client_advocacy_record rows directly. One logical request
 * → one finding, even when multiple provenance source documents exist
 * (brief §19); provenance is attached as evidence metadata.
 *
 * TWO independent queries (same shape as testimony):
 *  1. Confirmed-mapping bypass — every confirmed client_intel_mapping
 *     (source=community_funding) externalId = request UUID, no cursor.
 *  2. Bounded keyset scan over (created_at ASC, id ASC) joining recipient
 *     similarity + client facility geography for fuzzy corroboration.
 *
 * Matching hierarchy is pure (community-funding-advocacy-match.ts):
 * confirmed → exact recipient → exact alias → fuzzy+geography → skip.
 */
export class ClientProfileFillCommunityFundingDiscovery {
  private readonly source: ClientProfileFillCommunityFundingSource;

  constructor(
    prisma: PrismaService,
    private readonly ports: PublicAdvocacyDiscoveryPorts,
  ) {
    this.source = new ClientProfileFillCommunityFundingSource(prisma, ports);
  }

  async gather(
    ctx: TenantContext,
    clientId: string,
    runId: string,
    currentCount: number,
    lastCreatedAt: string | null,
    lastKey: string | null,
    priorState: Record<string, unknown>,
  ): Promise<{
    count: number;
    newestCreatedAt: string | null;
    newestKey: string | null;
    backfill: AdvocacySourceBackfillState;
  }> {
    const startedAt = asString(priorState.startedAt) ?? new Date().toISOString();
    const priorCheckpoint = asRecord(priorState.checkpoint);
    const priorWasComplete = asString(priorState.status) === 'complete';
    const state = this.backfillState(priorState, startedAt);
    if (currentCount >= MAX_ADVOCACY_FINDINGS) {
      return {
        count: 0,
        newestCreatedAt: lastCreatedAt,
        newestKey: lastKey,
        backfill: state('in_progress', 0, 0, null, priorCheckpoint),
      };
    }
    const clientName = await this.ports.resolveClientName(ctx, clientId);
    if (!clientName) {
      return {
        count: 0,
        newestCreatedAt: lastCreatedAt,
        newestKey: lastKey,
        backfill: state('complete', 0, 0, null, priorCheckpoint),
      };
    }
    const confirmedRequestIds = await this.ports.confirmedMappingKeys(
      ctx,
      clientId,
      COMMUNITY_FUNDING_INTEL_MAPPING_SOURCE,
    );
    const clientStates = await this.source.loadClientStates(ctx, clientId);
    const matching = { clientName, confirmedRequestIds, clientStates };
    const progress: ScanProgress = { count: 0, examined: 0, scanError: null };
    await this.emitConfirmed(ctx, clientId, runId, currentCount, matching, progress);
    // 2) Keyset scan for exact/fuzzy matches.
    const checkpointAt = priorWasComplete
      ? lastCreatedAt
      : (asString(priorCheckpoint.createdAt) ?? lastCreatedAt);
    const checkpointKey = priorWasComplete ? lastKey : (asString(priorCheckpoint.key) ?? lastKey);
    let scanRows: FundingRow[] = [];
    try {
      scanRows = await this.source.loadScan(clientName, checkpointAt, checkpointKey);
    } catch (error) {
      const err = this.ports.safeError(error);
      this.ports.warn(`Community funding scan rail unavailable: ${err}`);
      progress.scanError = progress.scanError ?? err;
      return this.scanFailure(state, progress, lastCreatedAt, lastKey, priorCheckpoint);
    }
    const frontier = this.scanFrontier(scanRows, lastCreatedAt, lastKey);
    await this.emitScan(ctx, clientId, runId, currentCount, matching, progress, scanRows);
    const limitation = await this.source.loadCoverage(asString(priorState.limitation));
    return this.finishScan(
      state,
      progress,
      scanRows.length,
      frontier,
      lastCreatedAt,
      lastKey,
      priorWasComplete,
      priorCheckpoint,
      limitation,
    );
  }

  private backfillState(priorState: Record<string, unknown>, startedAt: string): BuildBackfill {
    return (
      status: AdvocacyBackfillStatus,
      examined = 0,
      candidates = 0,
      lastError: string | null = null,
      checkpoint: Record<string, unknown> | null = null,
      limitation: string | null = null,
    ): AdvocacySourceBackfillState => ({
      status,
      startedAt,
      completedAt: status === 'complete' ? new Date().toISOString() : undefined,
      checkpoint,
      historyStart: asString(priorState.historyStart) ?? null,
      examined: Number(priorState.examined ?? 0) + examined,
      candidates: Number(priorState.candidates ?? 0) + candidates,
      lastError,
      limitation: limitation ?? asString(priorState.limitation) ?? null,
    });
  }

  private async emitConfirmed(
    ctx: TenantContext,
    clientId: string,
    runId: string,
    currentCount: number,
    matching: FundingMatchContext,
    progress: ScanProgress,
  ): Promise<void> {
    // 1) Confirmed-mapping bypass — no cursor filter.
    const { confirmedRequestIds, clientName, clientStates } = matching;
    if (confirmedRequestIds.size && currentCount + progress.count < MAX_ADVOCACY_FINDINGS) {
      try {
        const confirmedRows = await this.source.loadConfirmed(confirmedRequestIds);
        const prov = await this.source.loadProvenance(confirmedRows.map((r) => r.id));
        for (const row of confirmedRows) {
          if (currentCount + progress.count >= MAX_ADVOCACY_FINDINGS) break;
          row.provenanceDocs = prov.get(row.id) ?? null;
          const decision = resolveCommunityFundingRecipientMatch({
            requestId: row.id,
            recipientName: row.recipientName,
            recipientNormalized: row.recipientNormalized,
            state: row.state,
            confirmedRequestIds,
            clientName,
            clientStates,
            recipientSimilarity: 1,
          });
          if (!decision.matched) continue;
          progress.examined += 1;
          if (await this.emitRow(ctx, clientId, runId, row, decision)) progress.count += 1;
        }
      } catch (error) {
        progress.scanError = this.ports.safeError(error);
        this.ports.warn(
          `Community funding confirmed-mapping rail unavailable: ${progress.scanError}`,
        );
      }
    }
  }

  private async emitScan(
    ctx: TenantContext,
    clientId: string,
    runId: string,
    currentCount: number,
    matching: FundingMatchContext,
    progress: ScanProgress,
    scanRows: FundingRow[],
  ): Promise<void> {
    const { confirmedRequestIds, clientName, clientStates } = matching;
    const resolved: Array<{
      row: FundingRow;
      decision: CommunityFundingMatchDecision;
      requestId: string;
    }> = [];
    for (const row of scanRows) {
      // Confirmed rows already handled above; still "examined" for cursor.
      if (confirmedRequestIds.has(row.id)) {
        progress.examined += 1;
        continue;
      }
      const decision = resolveCommunityFundingRecipientMatch({
        requestId: row.id,
        recipientName: row.recipientName,
        recipientNormalized: row.recipientNormalized,
        state: row.state,
        confirmedRequestIds,
        clientName,
        clientStates,
        recipientSimilarity: row.recipientSimilarity,
      });
      progress.examined += 1;
      if (decision.matched) {
        resolved.push({ row, decision, requestId: row.id });
      }
    }
    const accepted = filterAmbiguousCommunityFundingMatches(resolved);
    const prov = await this.source.loadProvenance(accepted.map((a) => a.row.id));
    for (const item of accepted) {
      if (currentCount + progress.count >= MAX_ADVOCACY_FINDINGS) break;
      if (!item.decision.matched) continue;
      item.row.provenanceDocs = prov.get(item.row.id) ?? null;
      if (await this.emitRow(ctx, clientId, runId, item.row, item.decision)) progress.count += 1;
    }
  }

  private async emitRow(
    ctx: TenantContext,
    clientId: string,
    runId: string,
    row: FundingRow,
    decision: Extract<CommunityFundingMatchDecision, { matched: true }>,
  ): Promise<boolean> {
    return this.ports.emitFinding(
      ctx,
      clientId,
      runId,
      buildCommunityFundingDiscoveryFinding(row, decision),
    );
  }

  private scanFrontier(
    scanRows: FundingRow[],
    lastCreatedAt: string | null,
    lastKey: string | null,
  ): ScanFrontier {
    // Cursor advances across the full batch even when zero matches — same
    // contract as testimony (scan frontier, not match frontier).
    let newestCreatedAt: string | null = lastCreatedAt;
    let newestKey: string | null = lastKey;
    if (scanRows.length) {
      const last = scanRows[scanRows.length - 1]!;
      newestCreatedAt = last.createdAt.toISOString();
      newestKey = last.id;
    }
    return { newestCreatedAt, newestKey };
  }

  private scanFailure(
    state: BuildBackfill,
    progress: ScanProgress,
    lastCreatedAt: string | null,
    lastKey: string | null,
    priorCheckpoint: Record<string, unknown>,
  ): CommunityFundingResult {
    return {
      count: progress.count,
      newestCreatedAt: lastCreatedAt,
      newestKey: lastKey,
      backfill: state(
        'partial',
        progress.examined,
        progress.count,
        progress.scanError,
        priorCheckpoint,
        'Canonical CPF/CDS table unavailable or not yet migrated',
      ),
    };
  }

  private finishScan(
    state: BuildBackfill,
    progress: ScanProgress,
    scanRowCount: number,
    frontier: ScanFrontier,
    lastCreatedAt: string | null,
    lastKey: string | null,
    priorWasComplete: boolean,
    priorCheckpoint: Record<string, unknown>,
    limitation: string | null,
  ): CommunityFundingResult {
    const batchExhausted = scanRowCount < COMMUNITY_FUNDING_SCAN_BATCH_SIZE;
    const complete = priorWasComplete || (!progress.scanError && batchExhausted);
    const checkpoint = { createdAt: frontier.newestCreatedAt, key: frontier.newestKey };
    return {
      count: progress.count,
      newestCreatedAt: complete ? frontier.newestCreatedAt : lastCreatedAt,
      newestKey: complete ? frontier.newestKey : lastKey,
      backfill: state(
        progress.scanError ? 'partial' : complete ? 'complete' : 'in_progress',
        progress.examined,
        progress.count,
        progress.scanError,
        complete || scanRowCount ? checkpoint : priorCheckpoint,
        limitation,
      ),
    };
  }
}
