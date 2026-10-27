import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import type {
  DefenseEvidenceRefDto,
  PreviewResearchPortfolioShareDto,
  ResearchPortfolioContributionDto,
  ResearchPortfolioFitBasisDto,
  ResearchPortfolioFinancialBasisDto,
  ResearchPortfolioDashboardLayoutDto,
  ResearchPortfolioShareDashboardDto,
  ResearchPortfolioSnapshotDto,
  TenantContext,
} from '@capiro/shared';
import { BrandingService } from '../branding/branding.service.js';
import { DefenseResearchService } from '../defense-research/defense-research.service.js';
import {
  assertResearchPortfolioClientAccess,
  loadAuthorizedResearchPortfolio,
} from './research-portfolio-access.js';
import { ResearchPortfolioAnalyticsService } from './research-portfolio-analytics.service.js';
import { validateLayout } from './research-portfolio-dashboard-layout.js';
import { stableJson } from './research-portfolio-rules.js';

/** Private storage envelope; only dashboard and the authorized logo response leave the server. */
export interface ResearchPortfolioShareStoredPayload {
  schemaVersion: 2;
  dashboard: ResearchPortfolioShareDashboardDto;
  logoBinding: { dataUrl: string } | null;
}

const EVENT_KINDS = [
  'member_added',
  'member_decided',
  'member_excluded',
  'member_reinstated',
  'member_resolved',
  'rule_published',
  'review_updated',
  'annual_reopened',
  'import_created',
  'import_action',
] as const;
const FINANCIAL_WIDGETS = new Set(['key_totals', 'funding_table', 'sources']);

function refusal(widgetId: string, detail: string): never {
  throw new ConflictException(`Widget ${widgetId} cannot be published: ${detail}`);
}

/** Copy the public evidence contract, never arbitrary properties from stored JSON. */
function frozenEvidence(raw: Readonly<Record<string, unknown>>): DefenseEvidenceRefDto | null {
  if (typeof raw.evidenceRefId !== 'string' || !raw.evidenceRefId) return null;
  const nullable = (key: string) => (typeof raw[key] === 'string' ? (raw[key] as string) : null);
  const locator = raw.nativeLocator as Record<string, unknown> | null;
  return {
    evidenceRefId: raw.evidenceRefId,
    sourceDocumentId: nullable('sourceDocumentId'),
    sourceRevisionId: nullable('sourceRevisionId'),
    sourceFamily: typeof raw.sourceFamily === 'string' ? raw.sourceFamily : 'unknown',
    publisher: nullable('publisher'),
    sourceUrl: nullable('sourceUrl'),
    nativeLocator: {
      page: typeof locator?.page === 'number' ? locator.page : null,
      section: typeof locator?.section === 'string' ? locator.section : null,
      occurrenceId: typeof locator?.occurrenceId === 'string' ? locator.occurrenceId : null,
    },
    contentHash: nullable('contentHash'),
    edition: nullable('edition'),
    observedAt: nullable('observedAt'),
    ...(raw.availability === 'available' ||
    raw.availability === 'partial' ||
    raw.availability === 'unavailable'
      ? { availability: raw.availability }
      : {}),
    ...(typeof raw.reason === 'string' ? { reason: raw.reason } : {}),
  };
}

function financialBasis(
  basis: ResearchPortfolioFinancialBasisDto,
): ResearchPortfolioFinancialBasisDto {
  return {
    requestEdition: basis.requestEdition,
    fundingFiscalYear: basis.fundingFiscalYear,
    stage: basis.stage,
    metric: basis.metric,
    unit: basis.unit,
    currency: basis.currency,
    priceBasis: basis.priceBasis,
    knownAt: basis.knownAt,
  };
}
function fitBasis(raw: unknown): ResearchPortfolioFitBasisDto | null {
  if (!raw || typeof raw !== 'object') return null;
  const basis = raw as ResearchPortfolioFitBasisDto;
  return {
    calculationVersion: basis.calculationVersion,
    scoreBasis: basis.scoreBasis,
    portfolioRevision: basis.portfolioRevision,
    ruleVersionIds: [...(basis.ruleVersionIds ?? [])],
    capabilityFingerprint: basis.capabilityFingerprint,
    sourceBasisFingerprint: basis.sourceBasisFingerprint,
    basisFingerprint: basis.basisFingerprint,
    totalIncludedMemberCount: basis.totalIncludedMemberCount,
    supportedMemberCount: basis.supportedMemberCount,
    matchedMemberCount: basis.matchedMemberCount,
    limitations: (basis.limitations ?? []).filter((value) => typeof value === 'string'),
  };
}
function financialTotals(snapshot: ResearchPortfolioSnapshotDto) {
  return snapshot.projection.totals.map((total) => ({
    basis: financialBasis(total.basis),
    value: total.value,
    contributionCount: total.contributionCount,
  }));
}

@Injectable()
export class ResearchPortfolioSharePayloadService {
  constructor(
    private readonly analytics: ResearchPortfolioAnalyticsService,
    private readonly evidence: DefenseResearchService,
    private readonly branding: BrandingService,
  ) {}

  /** Preview and publication call this same producer under current editor/client authority. */
  async prepare(
    ctx: TenantContext,
    portfolioId: string,
    input: PreviewResearchPortfolioShareDto,
    tx: Prisma.TransactionClient,
  ): Promise<{
    payload: ResearchPortfolioShareStoredPayload;
    previewHash: string;
    designVersion: number;
    snapshotName: string;
  }> {
    if (
      !input?.snapshotId ||
      !input.designId ||
      !input.clientId ||
      typeof input.branding !== 'boolean'
    )
      throw new BadRequestException(
        'A snapshot, dashboard design, client and branding choice are required',
      );
    const portfolio = await loadAuthorizedResearchPortfolio(tx, ctx, portfolioId, 'editor');
    if (
      !portfolio.clientLinks.some((link: { clientId: string }) => link.clientId === input.clientId)
    )
      throw new BadRequestException('The client must be linked to this portfolio');
    await assertResearchPortfolioClientAccess(tx, ctx, [input.clientId]);
    const design = await tx.researchPortfolioDashboardDesign.findFirst({
      where: { id: input.designId, tenantId: ctx.tenantId, portfolioId },
    });
    if (!design) throw new NotFoundException('Dashboard design not found');
    const layout = validateLayout(design.layout);
    if (!layout.widgets.length)
      throw new BadRequestException('Add at least one widget before publishing');
    for (const widget of layout.widgets) {
      if (
        widget.kind === 'image' &&
        typeof widget.settings.url === 'string' &&
        widget.settings.url.trim()
      )
        refusal(widget.id, 'an external image is not a frozen asset; use the firm logo');
    }
    const snapshot = await this.analytics.snapshot(ctx, portfolioId, input.snapshotId);
    const client = await tx.client.findFirst({
      where: { tenantId: ctx.tenantId, id: input.clientId },
      select: { name: true },
    });
    if (!client) throw new NotFoundException('Client not found');
    const tenant = input.branding
      ? await tx.tenant.findUnique({
          where: { id: ctx.tenantId },
          select: { name: true, logoS3Key: true, logoContentType: true },
        })
      : null;
    const financialWidget = layout.widgets.find((widget) => FINANCIAL_WIDGETS.has(widget.kind));
    const financial = financialWidget
      ? await this.financialProjection(snapshot, financialWidget.id)
      : { contributions: [], sources: [] };
    const has = (kind: string) => layout.widgets.some((widget) => widget.kind === kind);
    // Fit versions and event history are immutable. A snapshot can only include records
    // that existed by its capture time, on the same portfolio revision. Never refresh here.
    const fit = has('client_fit')
      ? await tx.researchPortfolioFitVersion.findFirst({
          where: {
            tenantId: ctx.tenantId,
            portfolioId,
            clientId: input.clientId,
            portfolioRevision: snapshot.portfolioRevision,
            createdAt: { lte: new Date(snapshot.capturedAt) },
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        })
      : null;
    const fitProjection = fit?.projection as Record<string, unknown> | undefined;
    const changes = has('changes')
      ? await tx.researchPortfolioEvent.findMany({
          where: {
            tenantId: ctx.tenantId,
            portfolioId,
            eventKind: { in: [...EVENT_KINDS] },
            occurredAt: { lte: new Date(snapshot.capturedAt) },
            aggregateRevision: { lte: snapshot.portfolioRevision },
          },
          orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        })
      : [];
    const comparison = await this.comparison(ctx, portfolioId, snapshot, layout);
    const headerWidget = layout.widgets.find(
      (widget) => widget.kind === 'header' || widget.kind === 'image',
    );
    let logoBinding: { dataUrl: string } | null = null;
    if (tenant?.logoS3Key) {
      try {
        logoBinding = await this.branding.freezeLogoForSharing(
          ctx.tenantId,
          tenant.logoS3Key,
          tenant.logoContentType ?? '',
        );
      } catch {
        refusal(
          headerWidget?.id ?? layout.widgets[0]!.id,
          'the firm logo could not be frozen safely',
        );
      }
    }
    const structure = snapshot.versions.structure;
    const dashboard: ResearchPortfolioShareDashboardDto = {
      schemaVersion: 1,
      portfolioName:
        typeof structure.portfolioName === 'string' ? structure.portfolioName : snapshot.name,
      portfolioPurpose:
        typeof structure.portfolioPurpose === 'string' ? structure.portfolioPurpose : null,
      asOf: snapshot.capturedAt,
      preparedFor: { clientName: client.name },
      branding: tenant ? { firmName: tenant.name, logoAvailable: Boolean(logoBinding) } : null,
      layout,
      data: {
        totals: financialWidget ? financialTotals(snapshot) : [],
        contributions: financial.contributions,
        sources: financial.sources,
        coverage: {
          eligibleMembers: snapshot.projection.coverage.eligibleMembers,
          supportedMembers: snapshot.projection.coverage.supportedMembers,
          includedContributions: snapshot.projection.coverage.includedContributions,
          excludedContributions: snapshot.projection.coverage.excludedContributions,
          overlapContributions: snapshot.projection.coverage.overlapContributions,
          unavailableMembers: snapshot.projection.coverage.unavailableMembers,
        },
        limitations: snapshot.limitations.filter((value) => typeof value === 'string'),
        subjects: has('subjects')
          ? snapshot.membership
              .filter((member) => member.disposition === 'included')
              .map((member) => ({
                id: member.id,
                targetKind: member.targetKind,
                targetId: member.targetId,
                label: member.label,
                disposition: member.disposition,
              }))
          : [],
        clientFit:
          fit && fitProjection
            ? {
                availability:
                  fitProjection.availability === 'available' ||
                  fitProjection.availability === 'partial'
                    ? fitProjection.availability
                    : 'unavailable',
                fitScore:
                  typeof fitProjection.fitScore === 'number' ? fitProjection.fitScore : null,
                basis: fitBasis(fitProjection.basis),
                refreshedAt: fit.createdAt.toISOString(),
              }
            : null,
        changes: changes.map((change) => ({
          id: change.id,
          eventKind: change.eventKind,
          occurredAt: change.occurredAt.toISOString(),
          summary: change.eventKind.replaceAll('_', ' '),
        })),
        comparison,
      },
      snapshot: {
        id: snapshot.id,
        name: snapshot.name,
        capturedAt: snapshot.capturedAt,
        portfolioRevision: snapshot.portfolioRevision,
        calculationVersion: snapshot.calculationVersion,
      },
      // The service replaces only these timestamps upon publication. They are not part of the review hash.
      publishedAt: snapshot.capturedAt,
      expiresAt: snapshot.capturedAt,
    };
    const payload: ResearchPortfolioShareStoredPayload = {
      schemaVersion: 2,
      dashboard,
      logoBinding,
    };
    if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > 3.5 * 1024 * 1024)
      refusal(
        financialWidget?.id ?? layout.widgets[0]!.id,
        'the full frozen dashboard exceeds the supported size; reduce the design before publishing',
      );
    const { publishedAt: _published, expiresAt: _expires, ...content } = dashboard;
    const previewHash = createHash('sha256')
      .update(
        stableJson({
          portfolioId,
          snapshotId: input.snapshotId,
          designId: input.designId,
          clientId: input.clientId,
          branding: input.branding,
          designVersion: design.version,
          content,
          logoBinding,
        }),
      )
      .digest('hex');
    return { payload, previewHash, designVersion: design.version, snapshotName: snapshot.name };
  }

  private async financialProjection(snapshot: ResearchPortfolioSnapshotDto, widgetId: string) {
    const sources = new Map<string, { id: string } & DefenseEvidenceRefDto>();
    const contributions: ResearchPortfolioContributionDto[] = [];
    for (const contribution of snapshot.projection.contributions) {
      if (contribution.disposition === 'excluded' || contribution.disposition === 'overlap')
        continue;
      const refs: DefenseEvidenceRefDto[] = [];
      for (const raw of contribution.evidence) {
        const frozen = frozenEvidence(raw);
        if (!frozen) refusal(widgetId, 'a frozen source has no verifiable evidence reference');
        let current: DefenseEvidenceRefDto;
        try {
          current = await this.evidence.resolveEvidence(frozen.evidenceRefId);
        } catch {
          refusal(widgetId, 'a frozen source is restricted or no longer accessible');
        }
        if (
          current.availability === 'unavailable' ||
          !['sourceDocumentId', 'sourceRevisionId', 'contentHash', 'nativeLocator'].every(
            (key) =>
              stableJson(current[key as keyof DefenseEvidenceRefDto] ?? null) ===
              stableJson(frozen[key as keyof DefenseEvidenceRefDto] ?? null),
          )
        )
          refusal(widgetId, 'a frozen source revision cannot be verified');
        refs.push(frozen);
        sources.set(frozen.evidenceRefId, {
          id: frozen.sourceRevisionId ?? frozen.contentHash ?? frozen.evidenceRefId,
          ...frozen,
        });
      }
      if (contribution.value !== null && !refs.length)
        refusal(widgetId, 'a figure has no verifiable frozen source');
      contributions.push({
        contributionId: contribution.contributionId,
        memberId: contribution.memberId,
        targetKind: contribution.targetKind,
        targetId: contribution.targetId,
        label: contribution.label,
        basis: contribution.basis ? financialBasis(contribution.basis) : null,
        value: contribution.value,
        disposition: contribution.disposition,
        ...(contribution.sourceDisposition !== undefined
          ? { sourceDisposition: contribution.sourceDisposition }
          : {}),
        reason: contribution.reason,
        sourceObservationId: contribution.sourceObservationId,
        sourceRevisionIds: contribution.sourceRevisionIds.filter(
          (value) => typeof value === 'string',
        ),
        evidence: refs as unknown as readonly Readonly<Record<string, unknown>>[],
        dedupKey: contribution.dedupKey,
        overlapsContributionId: contribution.overlapsContributionId,
      });
    }
    if (
      snapshot.projection.totals.length &&
      !contributions.some((entry) => entry.disposition === 'included')
    )
      refusal(widgetId, 'totals have no contributing frozen evidence');
    const known = new Set(
      [...sources.values()].flatMap((source) =>
        [source.id, source.sourceRevisionId, source.contentHash].filter(Boolean),
      ),
    );
    for (const source of snapshot.versions.sources) {
      if (typeof source.id === 'string' && !known.has(source.id))
        refusal(widgetId, 'a frozen source is restricted or cannot be verified');
    }
    return { contributions, sources: [...sources.values()] };
  }

  private async comparison(
    ctx: TenantContext,
    portfolioId: string,
    current: ResearchPortfolioSnapshotDto,
    layout: ResearchPortfolioDashboardLayoutDto,
  ) {
    const widget = layout.widgets.find((entry) => entry.kind === 'snapshot_comparison');
    if (!widget) return null;
    const earlier = (await this.analytics.listSnapshots(ctx, portfolioId))
      .filter((entry) => entry.id !== current.id && entry.capturedAt < current.capturedAt)
      .sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));
    const selectedId =
      typeof widget.settings.snapshotId === 'string' ? widget.settings.snapshotId : earlier[0]?.id;
    if (!selectedId) return null;
    if (!earlier.some((entry) => entry.id === selectedId))
      refusal(widget.id, 'the comparison must use an earlier snapshot of this portfolio');
    const detail = await this.analytics.snapshot(ctx, portfolioId, selectedId);
    await this.financialProjection(detail, widget.id);
    return {
      snapshotId: detail.id,
      snapshotName: detail.name,
      capturedAt: detail.capturedAt,
      totals: financialTotals(detail),
    };
  }
}
