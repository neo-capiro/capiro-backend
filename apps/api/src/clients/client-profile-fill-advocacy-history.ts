import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { ClientAdvocacyMatterService } from './client-advocacy-matter.service.js';
import { asRecord, asString } from './client-profile-fill.helpers.js';
import {
  ADVOCACY_SOURCE_NAMES,
  deriveAdvocacyBackfillOverallStatus,
  deriveAdvocacyOverallHealth,
  updateAdvocacySourceHealth,
  type AdvocacySourceBackfillState,
} from './client-profile-fill-advocacy-health.js';
import {
  type AdvocacyHistoryPorts,
  type AdvocacyHistoryTaskResult,
} from './client-profile-fill-advocacy-discovery.shared.js';
import {
  ClientProfileFillLdaDiscovery,
  type LdaBackfillResult,
} from './client-profile-fill-lda-discovery.js';
import { ClientProfileFillFaraDiscovery } from './client-profile-fill-fara-discovery.js';
import { ClientProfileFillTestimonyDiscovery } from './client-profile-fill-testimony-discovery.js';
import { ClientProfileFillCommunityFundingDiscovery } from './client-profile-fill-community-funding-discovery.js';
import { ClientProfileFillTenantHistoryDiscovery } from './client-profile-fill-tenant-history-discovery.js';
import { ClientProfileFillFederalRegisterDiscovery } from './client-profile-fill-federal-register-discovery.js';
import type { ClientProfileFillRegulatoryCommentDiscovery } from './client-profile-fill-regulatory-comment-discovery.js';

interface HistoryContext {
  ldaIds: number[];
  cursor: Record<string, unknown>;
  priorSources: Record<string, unknown>;
  invocationStartedAt: string;
}
interface TenantHistoryResult {
  count: number;
  submissionResult: Awaited<
    ReturnType<ClientProfileFillTenantHistoryDiscovery['gatherClientSubmissions']>
  >;
  privateResult: Awaited<
    ReturnType<ClientProfileFillTenantHistoryDiscovery['gatherPrivateCandidates']>
  >;
}
interface PublicHistoryResult {
  count: number;
  testimonyResult: Awaited<ReturnType<ClientProfileFillTestimonyDiscovery['gather']>>;
  communityFundingResult: Awaited<ReturnType<ClientProfileFillCommunityFundingDiscovery['gather']>>;
}

/** One durable History task: ordered source traversal, budget, aggregate health and checkpoint. */
export class ClientProfileFillAdvocacyHistory {
  readonly lda: ClientProfileFillLdaDiscovery;
  readonly fara: ClientProfileFillFaraDiscovery;
  readonly testimony: ClientProfileFillTestimonyDiscovery;
  readonly tenantHistory: ClientProfileFillTenantHistoryDiscovery;
  readonly federalRegister: ClientProfileFillFederalRegisterDiscovery;
  readonly communityFunding: ClientProfileFillCommunityFundingDiscovery;

  constructor(
    private readonly prisma: PrismaService,
    advocacyMatters: ClientAdvocacyMatterService,
    private readonly regulatoryCommentDiscovery: ClientProfileFillRegulatoryCommentDiscovery,
    private readonly ports: AdvocacyHistoryPorts,
  ) {
    this.lda = new ClientProfileFillLdaDiscovery(prisma, ports);
    this.fara = new ClientProfileFillFaraDiscovery(prisma, ports);
    this.testimony = new ClientProfileFillTestimonyDiscovery(prisma, ports);
    this.tenantHistory = new ClientProfileFillTenantHistoryDiscovery(prisma, ports);
    this.federalRegister = new ClientProfileFillFederalRegisterDiscovery(
      prisma,
      advocacyMatters,
      ports,
    );
    this.communityFunding = new ClientProfileFillCommunityFundingDiscovery(prisma, ports);
  }

  async gather(
    ctx: TenantContext,
    clientId: string,
    runId: string,
  ): Promise<AdvocacyHistoryTaskResult> {
    const context = await this.loadContext(ctx, clientId, runId);
    const { ldaIds, cursor, priorSources, invocationStartedAt } = context;
    const sourceStates: Record<string, AdvocacySourceBackfillState> = {};
    const lda = await this.lda.gather(
      ctx,
      clientId,
      runId,
      ldaIds,
      cursor,
      priorSources,
      invocationStartedAt,
    );
    sourceStates.lda = lda.backfill;
    const tenant = await this.gatherTenantHistory(
      ctx,
      clientId,
      runId,
      lda.count,
      cursor,
      priorSources,
      sourceStates,
    );
    const publicSources = await this.gatherPublicHistory(
      ctx,
      clientId,
      runId,
      tenant.count,
      cursor,
      priorSources,
      sourceStates,
    );
    await this.updateSourceHealth(ctx, clientId, priorSources, sourceStates, invocationStartedAt);
    return this.finish(
      ctx,
      clientId,
      cursor,
      invocationStartedAt,
      sourceStates,
      lda,
      tenant,
      publicSources,
    );
  }

  private async loadContext(
    ctx: TenantContext,
    clientId: string,
    runId: string,
  ): Promise<HistoryContext> {
    const runRows = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.$queryRawUnsafe<Array<{ selectedLdaIds: number[] }>>(
        `SELECT selected_lda_ids AS "selectedLdaIds"
           FROM client_profile_fill_run
          WHERE id = $1::uuid AND tenant_id = $2::uuid AND client_id = $3::uuid`,
        runId,
        ctx.tenantId,
        clientId,
      ),
    );
    const ldaIds = runRows[0]?.selectedLdaIds ?? [];
    const cursor = await this.ports.readCursor(ctx.tenantId, clientId, 'advocacy_history');
    const priorBackfill = asRecord(cursor.backfill);
    const priorSources = asRecord(priorBackfill.sources);
    const invocationStartedAt = new Date().toISOString();
    return { ldaIds, cursor, priorSources, invocationStartedAt };
  }

  private async gatherTenantHistory(
    ctx: TenantContext,
    clientId: string,
    runId: string,
    currentCount: number,
    cursor: Record<string, unknown>,
    priorSources: Record<string, unknown>,
    sourceStates: Record<string, AdvocacySourceBackfillState>,
  ): Promise<TenantHistoryResult> {
    let count = currentCount;
    const submissionResult = await this.tenantHistory.gatherClientSubmissions(
      ctx,
      clientId,
      runId,
      count,
      asString(cursor.lastClientSubmissionAt),
      asRecord(priorSources.client_submission),
    );
    count += submissionResult.count;
    sourceStates.client_submission = submissionResult.backfill;
    const privateResult = await this.tenantHistory.gatherPrivateCandidates(
      ctx,
      clientId,
      runId,
      count,
      asString(cursor.lastRelationshipLinkAppliedAt),
      asRecord(priorSources.private_evidence),
    );
    count += privateResult.count;
    sourceStates.private_evidence = privateResult.backfill;
    return { count, submissionResult, privateResult };
  }

  private async gatherPublicHistory(
    ctx: TenantContext,
    clientId: string,
    runId: string,
    currentCount: number,
    cursor: Record<string, unknown>,
    priorSources: Record<string, unknown>,
    sourceStates: Record<string, AdvocacySourceBackfillState>,
  ): Promise<PublicHistoryResult> {
    let count = currentCount;
    const faraResult = await this.fara.gather(ctx, clientId, runId, count);
    count += faraResult.count;
    sourceStates.fara = faraResult.backfill;
    const testimonyResult = await this.testimony.gather(
      ctx,
      clientId,
      runId,
      count,
      asString(cursor.lastTestimonySyncedAt),
      asString(cursor.lastTestimonyKey),
      asRecord(priorSources.testimony),
    );
    count += testimonyResult.count;
    sourceStates.testimony = testimonyResult.backfill;
    const regulatoryCommentResult = await this.regulatoryCommentDiscovery.gather(
      ctx,
      clientId,
      runId,
      count,
      asRecord(priorSources.regulations_gov),
    );
    count += regulatoryCommentResult.count;
    sourceStates.regulations_gov = regulatoryCommentResult.backfill;
    sourceStates.federal_register = await this.federalRegister.gather(
      ctx,
      clientId,
      runId,
      asRecord(priorSources.federal_register),
    );
    const communityFundingResult = await this.communityFunding.gather(
      ctx,
      clientId,
      runId,
      count,
      asString(cursor.lastCommunityFundingCreatedAt),
      asString(cursor.lastCommunityFundingKey),
      asRecord(priorSources.community_funding),
    );
    count += communityFundingResult.count;
    sourceStates.community_funding = communityFundingResult.backfill;

    return { count, testimonyResult, communityFundingResult };
  }

  private async updateSourceHealth(
    ctx: TenantContext,
    clientId: string,
    priorSources: Record<string, unknown>,
    sourceStates: Record<string, AdvocacySourceBackfillState>,
    invocationStartedAt: string,
  ): Promise<void> {
    const refreshSchedule = await this.ports.readSchedule(ctx, clientId);
    for (const source of ADVOCACY_SOURCE_NAMES) {
      sourceStates[source] = updateAdvocacySourceHealth(
        source,
        asRecord(priorSources[source]),
        sourceStates[source]!,
        invocationStartedAt,
        refreshSchedule.cadenceHours,
        refreshSchedule.nextRunAt,
      );
    }
  }

  private async finish(
    ctx: TenantContext,
    clientId: string,
    cursor: Record<string, unknown>,
    invocationStartedAt: string,
    sourceStates: Record<string, AdvocacySourceBackfillState>,
    lda: LdaBackfillResult,
    tenant: TenantHistoryResult,
    publicSources: PublicHistoryResult,
  ): Promise<AdvocacyHistoryTaskResult> {
    const count = publicSources.count;
    const overallStatus = deriveAdvocacyBackfillOverallStatus(sourceStates);
    await this.ports.recordCursor(ctx.tenantId, clientId, 'advocacy_history', {
      lastLdaPostedAt:
        sourceStates.lda!.status === 'complete'
          ? (asString(lda.checkpoint?.scanAt) ?? lda.lastDtPosted ?? null)
          : (lda.lastDtPosted ?? null),
      lastLdaKey:
        sourceStates.lda!.status === 'complete'
          ? (asString(lda.checkpoint?.key) ?? cursor.lastLdaKey ?? null)
          : (cursor.lastLdaKey ?? null),
      lastLdaActivityIndex:
        sourceStates.lda!.status === 'complete'
          ? Number(lda.checkpoint?.activityIndex ?? cursor.lastLdaActivityIndex ?? -1)
          : (cursor.lastLdaActivityIndex ?? null),
      lastClientSubmissionAt:
        tenant.submissionResult.newestCreatedAt ?? cursor.lastClientSubmissionAt ?? null,
      lastRelationshipLinkAppliedAt:
        tenant.privateResult.newestAppliedAt ?? cursor.lastRelationshipLinkAppliedAt ?? null,
      lastTestimonySyncedAt:
        publicSources.testimonyResult.newestSyncedAt ?? cursor.lastTestimonySyncedAt ?? null,
      lastTestimonyKey: publicSources.testimonyResult.newestKey ?? cursor.lastTestimonyKey ?? null,
      lastCommunityFundingCreatedAt:
        publicSources.communityFundingResult.newestCreatedAt ??
        cursor.lastCommunityFundingCreatedAt ??
        null,
      lastCommunityFundingKey:
        publicSources.communityFundingResult.newestKey ?? cursor.lastCommunityFundingKey ?? null,
      backfill: {
        status: overallStatus,
        sources: sourceStates,
        updatedAt: invocationStartedAt,
      },
      refreshedAt: new Date().toISOString(),
    });
    return {
      count,
      overallStatus,
      overallHealth: deriveAdvocacyOverallHealth(sourceStates),
      sources: sourceStates,
    };
  }

  async resolveClientNameForDiscovery(
    ctx: TenantContext,
    clientId: string,
  ): Promise<string | null> {
    const client = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.client.findFirst({ where: { id: clientId }, select: { id: true, name: true } }),
    );
    return client?.name ?? null;
  }

  async emitDiscoveryFinding(
    ctx: TenantContext,
    clientId: string,
    runId: string,
    input: {
      externalKey: string;
      isConfirmed: boolean;
      confidence: number;
      proposedValue: unknown;
      evidence: unknown[];
    },
  ): Promise<boolean> {
    return this.ports.persistFinding(ctx.tenantId, clientId, runId, {
      kind: 'advocacy_record',
      targetKey: `advocacy:${input.externalKey}`,
      source: 'advocacy_history',
      factKind: input.isConfirmed ? 'fact' : 'recommendation',
      currentValue: null,
      proposedValue: input.proposedValue,
      confidence: input.confidence,
      status: 'pending',
      evidence: input.evidence,
    });
  }
}
