import {
  BadRequestException,
  ConflictException,
  Injectable,
  Optional,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  ApplyResearchPortfolioWatchConversionDto,
  CreateResearchPortfolioBookmarkDto,
  CreateResearchPortfolioReviewNoteDto,
  ResearchPortfolioBookmarkDto,
  ResearchPortfolioFitDto,
  ResearchPortfolioOperationDto,
  ResearchPortfolioOperationKind,
  ResearchPortfolioOperationStatus,
  ReconcileResearchPortfolioOperationDto,
  ResearchPortfolioReviewNoteDto,
  ResearchPortfolioTourStateDto,
  ResearchPortfolioWatchConversionPreviewDto,
  ResearchPortfolioWatchConversionResultDto,
  TenantContext,
  UpdateResearchPortfolioBookmarkDto,
} from '@capiro/shared';
import { createHash } from 'node:crypto';
import { scoreCapabilityPeDirect } from '../intelligence/client-pe-relevance.scoring.js';
import { capabilityFitFingerprint } from '../clients/client-capability-fit.fingerprint.js';
import { readCanonicalResearchTarget } from './research-portfolio-targets.js';
import { stableJson, evaluateRule, parseRule } from './research-portfolio-rules.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { clientMemoryAllowed } from '../memory/memory-wall.helpers.js';
import {
  assertResearchPortfolioClientAccess,
  loadAuthorizedResearchPortfolio as loadAuthorized,
} from './research-portfolio-access.js';

import { ResearchPortfolioOutputService } from './research-portfolio-output.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function asIso(date: Date): string {
  return date.toISOString();
}

/**
 * Phase 11 supplementary services: bookmarks, review notes, fit, operations,
 * watch-conversion, and tour state. Each method reauthorizes through the
 * shared loadAuthorized helper.
 */
@Injectable()
export class ResearchPortfolioPhase11Service {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly outputs?: ResearchPortfolioOutputService,
  ) {}

  // --- Bookmarks ---

  async listBookmarks(
    ctx: TenantContext,
    portfolioId: string,
  ): Promise<readonly ResearchPortfolioBookmarkDto[]> {
    return this.prisma.withTenant(ctx.tenantId, async (tx: any) => {
      await loadAuthorized(tx, ctx, portfolioId, 'viewer');
      const rows = await tx.researchPortfolioBookmark.findMany({
        where: { tenantId: ctx.tenantId, portfolioId, userId: ctx.userId },
        orderBy: { createdAt: 'desc' },
      });
      return rows.map((row: any) => this.bookmarkDto(row));
    });
  }

  async createBookmark(
    ctx: TenantContext,
    portfolioId: string,
    dto: CreateResearchPortfolioBookmarkDto,
  ): Promise<ResearchPortfolioBookmarkDto> {
    if (!dto.targetKind || !dto.targetId)
      throw new BadRequestException('Bookmark requires targetKind and targetId');
    return this.prisma.withTenant(ctx.tenantId, async (tx: any) => {
      await loadAuthorized(tx, ctx, portfolioId, 'viewer');
      const existing = await tx.researchPortfolioBookmark.findFirst({
        where: {
          tenantId: ctx.tenantId,
          portfolioId,
          userId: ctx.userId,
          targetKind: dto.targetKind,
          targetId: dto.targetId,
        },
      });
      if (existing) return this.bookmarkDto(existing);
      const row = await tx.researchPortfolioBookmark.create({
        data: {
          tenantId: ctx.tenantId,
          portfolioId,
          userId: ctx.userId,
          targetKind: dto.targetKind,
          targetId: dto.targetId,
          label: dto.label?.trim() || null,
          note: dto.note?.trim() || null,
        },
      });
      return this.bookmarkDto(row);
    });
  }

  async updateBookmark(
    ctx: TenantContext,
    portfolioId: string,
    bookmarkId: string,
    dto: UpdateResearchPortfolioBookmarkDto,
  ): Promise<ResearchPortfolioBookmarkDto> {
    if (!UUID.test(bookmarkId)) throw new NotFoundException('Bookmark not found');
    return this.prisma.withTenant(ctx.tenantId, async (tx: any) => {
      await loadAuthorized(tx, ctx, portfolioId, 'viewer');
      const existing = await tx.researchPortfolioBookmark.findFirst({
        where: { id: bookmarkId, tenantId: ctx.tenantId, portfolioId, userId: ctx.userId },
      });
      if (!existing) throw new NotFoundException('Bookmark not found');
      const row = await tx.researchPortfolioBookmark.update({
        where: { id: bookmarkId },
        data: {
          ...(dto.label !== undefined ? { label: dto.label?.trim() || null } : {}),
          ...(dto.note !== undefined ? { note: dto.note?.trim() || null } : {}),
        },
      });
      return this.bookmarkDto(row);
    });
  }

  async deleteBookmark(ctx: TenantContext, portfolioId: string, bookmarkId: string): Promise<void> {
    if (!UUID.test(bookmarkId)) throw new NotFoundException('Bookmark not found');
    await this.prisma.withTenant(ctx.tenantId, async (tx: any) => {
      await loadAuthorized(tx, ctx, portfolioId, 'viewer');
      const existing = await tx.researchPortfolioBookmark.findFirst({
        where: { id: bookmarkId, tenantId: ctx.tenantId, portfolioId, userId: ctx.userId },
      });
      if (!existing) throw new NotFoundException('Bookmark not found');
      await tx.researchPortfolioBookmark.delete({ where: { id: bookmarkId } });
    });
  }

  // --- Review notes ---

  async addReviewNote(
    ctx: TenantContext,
    portfolioId: string,
    reviewId: string,
    dto: CreateResearchPortfolioReviewNoteDto,
  ): Promise<ResearchPortfolioReviewNoteDto> {
    if (!UUID.test(reviewId)) throw new NotFoundException('Review not found');
    const body = dto.body?.trim();
    if (!body) throw new BadRequestException('Note body must not be empty');
    return this.prisma.withTenant(ctx.tenantId, async (tx: any) => {
      await loadAuthorized(tx, ctx, portfolioId, 'viewer');
      const review = await tx.researchPortfolioReview.findFirst({
        where: { tenantId: ctx.tenantId, id: reviewId, portfolioId },
      });
      if (!review) throw new NotFoundException('Review not found');
      if (review.revision !== dto.expectedRevision) {
        throw new ConflictException('Review revision mismatch');
      }
      const note = await tx.researchPortfolioReviewNote.create({
        data: {
          tenantId: ctx.tenantId,
          portfolioId,
          reviewId,
          authorUserId: ctx.userId,
          body,
        },
      });
      return {
        id: note.id,
        reviewId: note.reviewId,
        authorUserId: note.authorUserId,
        body: note.body,
        createdAt: asIso(note.createdAt),
      };
    });
  }

  // --- Fit ---

  async getFit(ctx: TenantContext, portfolioId: string): Promise<ResearchPortfolioFitDto> {
    return this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx: any) => {
      const portfolio = await loadAuthorized(tx, ctx, portfolioId, 'viewer');
      return this.calculateFit(tx, ctx, portfolio, false);
    });
  }

  async refreshFit(ctx: TenantContext, portfolioId: string): Promise<ResearchPortfolioFitDto> {
    return this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx: any) => {
      const portfolio = await loadAuthorized(tx, ctx, portfolioId, 'editor');
      if (portfolio.lifecycle === 'archived')
        throw new ConflictException('Archived portfolios are read-only');
      return this.calculateFit(tx, ctx, portfolio, true);
    });
  }

  private hasQualifiedFitSourceLocator(source: any): boolean {
    if (
      source.pageNumber != null &&
      (!Number.isSafeInteger(source.pageNumber) || source.pageNumber <= 0)
    )
      return false;
    if (
      source.pageEnd != null &&
      (!Number.isSafeInteger(source.pageEnd) ||
        source.pageNumber == null ||
        source.pageEnd < source.pageNumber)
    )
      return false;
    if (source.metadata?.locator != null && !this.hasQualifiedFitLocator(source.metadata.locator))
      return false;
    return source.pageNumber != null || this.hasQualifiedFitLocator(source.metadata?.locator);
  }

  private hasQualifiedFitLocator(locator: any): boolean {
    if (
      !locator ||
      typeof locator !== 'object' ||
      Array.isArray(locator) ||
      Object.keys(locator).length > 20
    )
      return false;
    try {
      if (JSON.stringify(locator).length > 16384) return false;
    } catch {
      return false;
    }
    const positive = (value: unknown) =>
      typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
    const text = (value: unknown) =>
      typeof value === 'string' && Boolean(value.trim()) && value.length <= 2048;
    const range = (start: unknown, end: unknown) =>
      typeof start === 'number' &&
      typeof end === 'number' &&
      Number.isSafeInteger(start) &&
      Number.isSafeInteger(end) &&
      start >= 0 &&
      end > start;
    // A supplied malformed coordinate cannot be rescued by another valid coordinate.
    for (const key of ['page', 'pageNumber', 'paragraph'])
      if (locator[key] !== undefined && !positive(locator[key])) return false;
    for (const key of ['xmlPath', 'xpath'])
      if (
        locator[key] !== undefined &&
        !(
          text(locator[key]) &&
          locator[key].trim().startsWith('/') &&
          locator[key].trim().length > 1
        )
      )
        return false;
    for (const key of ['table', 'section', 'row', 'cell'])
      if (locator[key] !== undefined && !(positive(locator[key]) || text(locator[key])))
        return false;
    if (locator.start !== undefined || locator.end !== undefined) {
      if (!range(locator.start, locator.end)) return false;
    }
    if (
      locator.span !== undefined &&
      !(
        locator.span &&
        typeof locator.span === 'object' &&
        !Array.isArray(locator.span) &&
        range(locator.span.start, locator.span.end)
      )
    )
      return false;
    return (
      positive(locator.page) ||
      positive(locator.pageNumber) ||
      positive(locator.paragraph) ||
      text(locator.xmlPath) ||
      text(locator.xpath) ||
      range(locator.start, locator.end) ||
      Boolean(locator.span) ||
      text(locator.section) ||
      ((text(locator.table) || positive(locator.table)) &&
        (text(locator.row) ||
          positive(locator.row) ||
          text(locator.cell) ||
          positive(locator.cell)))
    );
  }

  private async calculateFit(
    tx: any,
    ctx: TenantContext,
    portfolio: any,
    persist: boolean,
  ): Promise<ResearchPortfolioFitDto> {
    const calculationVersion = 'qualified-direct-pe-v1';
    const scoreBasis = 'direct_qualified_pe_association_share' as const;
    const limitations = [
      'Only explicit client capability PE associations are supported; this is not exhaustive relevance or a corpus-wide fit score.',
      'Source hashes and locators are retained as input provenance; corpus and archive qualification require separate evidence.',
    ];
    const members = await tx.researchPortfolioMember.findMany({
      where: { tenantId: ctx.tenantId, portfolioId: portfolio.id, disposition: 'included' },
      orderBy: { id: 'asc' },
      take: 201,
    });
    if (members.length > 200)
      throw new BadRequestException('Fit supports at most 200 included members per calculation');
    const rules = await tx.researchPortfolioRuleVersion.findMany({
      where: { tenantId: ctx.tenantId, portfolioId: portfolio.id },
      orderBy: { version: 'desc' },
      take: 1,
    });
    const targets: any[] = [];
    for (const member of members) {
      if (member.targetKind !== 'program_element') {
        targets.push({
          member,
          facts: null,
          sources: [],
          supported: false,
          reasons: ['target_kind_not_supported_by_direct_pe_basis'],
        });
        continue;
      }
      const pe = await tx.programElement.findUnique({
        where: { peCode: member.targetId },
        include: { sources: { include: { sourceDocument: true }, orderBy: { id: 'asc' } } },
      });
      const sources = (pe?.sources ?? []).filter(
        (source: any) =>
          source.confidence >= 0.8 &&
          source.sourceDocument &&
          /^[0-9a-f]{64}$/i.test(source.sourceDocument.sha256 ?? '') &&
          !source.sourceDocument.supersededByDocumentId &&
          this.hasQualifiedFitSourceLocator(source),
      );
      const supported = Boolean(
        pe &&
        !pe.retiredAt &&
        pe.sourceConfidence != null &&
        pe.sourceConfidence >= 0.8 &&
        sources.length,
      );
      const canonical = pe
        ? await readCanonicalResearchTarget(tx, 'program_element', member.targetId)
        : null;
      targets.push({
        member,
        facts: canonical?.facts ?? null,
        supported: supported && Boolean(canonical),
        sources: sources.map((source: any) => ({
          id: source.id,
          sourceDocumentId: source.sourceDocumentId,
          sha256: source.sourceDocument.sha256,
          fiscalYear: source.fy,
          sourceUrl: source.sourceUrl,
          pageNumber: source.pageNumber,
          pageEnd: source.pageEnd,
          confidence: source.confidence,
          locator: source.metadata?.locator ?? null,
        })),
        reasons:
          supported && canonical
            ? []
            : ['canonical_pe_not_currently_qualified_with_hashed_source_and_locator'],
      });
    }
    const sourceBasis = targets.map(({ member, facts, sources, supported }: any) => ({
      memberId: member.id,
      revision: member.revision,
      targetKind: member.targetKind,
      targetId: member.targetId,
      qualification: member.qualification,
      facts,
      sources,
      supported,
    }));
    const sourceBasisFingerprint = createHash('sha256')
      .update(stableJson(sourceBasis))
      .digest('hex');
    const supported = targets.filter((target) => target.supported);
    const clientFits: any[] = [];
    for (const link of portfolio.clientLinks) {
      // The wall is evaluated before either private capability input or stored versions are read.
      if (!(await clientMemoryAllowed(tx, ctx.tenantId, ctx.userId, link.clientId))) continue;
      const client = await tx.client.findFirst({
        where: { id: link.clientId, tenantId: ctx.tenantId },
        select: { id: true, name: true },
      });
      if (!client) continue;
      const capabilities = await tx.clientCapability.findMany({
        where: { tenantId: ctx.tenantId, clientId: link.clientId },
        orderBy: { id: 'asc' },
        take: 1001,
      });
      if (capabilities.length > 1000)
        throw new BadRequestException('Fit supports at most 1000 capabilities per linked client');
      const capabilityFingerprint = capabilityFitFingerprint({ capabilities });
      const memberMatches = targets.map((target) => {
        const capabilityIds = target.supported
          ? capabilities
              .filter((cap: any) =>
                [...(cap.peNumbers ?? []), cap.peNumber ?? ''].some(
                  (pe: string) => pe.trim().toUpperCase() === target.member.targetId.toUpperCase(),
                ),
              )
              .map((cap: any) => cap.id)
          : [];
        const direct = target.supported
          ? scoreCapabilityPeDirect({
              matchedPeNumbers: capabilityIds.length ? [target.member.targetId] : [],
            })
          : null;
        return {
          memberId: target.member.id,
          targetKind: target.member.targetKind,
          targetId: target.member.targetId,
          matched: target.supported ? Boolean(direct) : null,
          capabilityIds,
          reasons:
            direct?.evidence ??
            (target.supported ? ['no_explicit_capability_pe_association'] : target.reasons),
          sourceDocumentIds: [
            ...new Set(target.sources.map((source: any) => source.sourceDocumentId)),
          ],
        };
      });
      const matchedMemberCount = memberMatches.filter((match) => match.matched === true).length;
      const ruleMatches = rules.map((rule: any) => {
        const outcomes = supported.map((target) =>
          evaluateRule(parseRule(rule.expression), target.facts),
        );
        const result = outcomes.some((outcome) => outcome.result === 'match')
          ? 'match'
          : !outcomes.length || outcomes.some((outcome) => outcome.result === 'unknown')
            ? 'unknown'
            : 'nonmatch';
        return {
          ruleVersionId: rule.id,
          matched: result === 'match',
          result,
          reason: `${outcomes.filter((outcome) => outcome.result === 'match').length}/${supported.length} supported qualified PE members match the published rule; ${outcomes.filter((outcome) => outcome.result === 'unknown').length} unknown. Unsupported members are excluded.`,
        };
      });
      const inputBasis = {
        calculationVersion,
        scoreBasis,
        portfolioRevision: portfolio.revision,
        client: { id: client.id, name: client.name },
        capabilities: capabilities.map((cap: any) => ({
          ...cap,
          updatedAt: cap.updatedAt instanceof Date ? cap.updatedAt.toISOString() : cap.updatedAt,
          createdAt: cap.createdAt instanceof Date ? cap.createdAt.toISOString() : cap.createdAt,
        })),
        sourceBasis,
        rules: rules.map((rule: any) => ({
          id: rule.id,
          version: rule.version,
          schemaVersion: rule.schemaVersion,
          expression: rule.expression,
          qualificationPolicy: rule.qualificationPolicy,
          taxonomyVersionId: rule.taxonomyVersionId,
          templateVersionId: rule.templateVersionId,
        })),
        capabilityFingerprint,
        sourceBasisFingerprint,
      };
      const basisFingerprint = createHash('sha256').update(stableJson(inputBasis)).digest('hex');
      const availability = !supported.length
        ? 'unavailable'
        : supported.length < members.length
          ? 'partial'
          : 'available';
      const projection = {
        portfolioId: portfolio.id,
        clientId: client.id,
        clientName: client.name,
        fitScore: supported.length ? (matchedMemberCount / supported.length) * 100 : null,
        ruleMatches,
        availability,
        basis: {
          calculationVersion,
          scoreBasis,
          portfolioRevision: portfolio.revision,
          ruleVersionIds: rules.map((rule: any) => rule.id),
          capabilityFingerprint,
          sourceBasisFingerprint,
          basisFingerprint,
          totalIncludedMemberCount: members.length,
          supportedMemberCount: supported.length,
          matchedMemberCount,
          limitations,
        },
        memberMatches,
      };
      const where = {
        tenantId_portfolioId_clientId_basisFingerprint: {
          tenantId: ctx.tenantId,
          portfolioId: portfolio.id,
          clientId: client.id,
          basisFingerprint,
        },
      };
      if (persist) {
        // INSERT ON CONFLICT DO NOTHING preserves immutable versions and concurrent identical refresh.
        await tx.researchPortfolioFitVersion.createMany({
          data: [
            {
              tenantId: ctx.tenantId,
              portfolioId: portfolio.id,
              clientId: client.id,
              basisFingerprint,
              calculationVersion,
              portfolioRevision: portfolio.revision,
              projection,
              inputBasis: JSON.parse(stableJson(inputBasis)),
              createdByUserId: ctx.userId,
            },
          ],
          skipDuplicates: true,
        });
      }
      const version = await tx.researchPortfolioFitVersion.findUnique({ where });
      clientFits.push({
        ...projection,
        ...(version ? { versionId: version.id } : {}),
        refreshedAt: version?.createdAt.toISOString() ?? null,
      });
    }
    return {
      portfolioId: portfolio.id,
      clientFits,
      availability:
        clientFits.length && clientFits.every((fit) => fit.availability === 'available')
          ? 'available'
          : !clientFits.length || clientFits.every((fit) => fit.availability === 'unavailable')
            ? 'unavailable'
            : 'partial',
      limitations,
      calculatedAt: new Date().toISOString(),
    };
  }

  // --- Watch-conversion ---

  async previewWatchConversion(
    ctx: TenantContext,
    portfolioId: string,
  ): Promise<ResearchPortfolioWatchConversionPreviewDto> {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const portfolio = await loadAuthorized(tx, ctx, portfolioId, 'editor');
      return this.watchConversionPreview(tx, ctx, portfolio);
    });
  }

  private async watchConversionPreview(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    portfolio: any,
  ): Promise<ResearchPortfolioWatchConversionPreviewDto> {
    const watches = await tx.programElementWatch.findMany({
      where: { tenantId: ctx.tenantId, userId: ctx.userId },
      orderBy: { id: 'asc' },
      take: 201,
    });
    if (watches.length > 200)
      throw new BadRequestException(
        'Watch conversion supports at most 200 owned legacy watches per preview',
      );
    const targets = watches.map((watch) => watch.peCode);
    const members = await tx.researchPortfolioMember.findMany({
      where: {
        tenantId: ctx.tenantId,
        portfolioId: portfolio.id,
        targetKind: 'program_element',
        targetId: { in: targets },
        disposition: 'included',
      },
      select: { id: true, targetId: true, revision: true },
      orderBy: { id: 'asc' },
    });
    const subscriptions = await tx.researchPortfolioSubscription.findMany({
      where: {
        tenantId: ctx.tenantId,
        portfolioId: portfolio.id,
        subscriberUserId: ctx.userId,
        targetKind: 'program_element',
        targetId: { in: targets },
      },
      orderBy: { id: 'asc' },
      take: 1001,
    });
    if (subscriptions.length > 1000)
      throw new BadRequestException(
        'Watch conversion subscription basis exceeds the supported bound',
      );
    const included = new Set(members.map((member) => member.targetId));
    const subscribed = new Set(subscriptions.map((subscription) => subscription.targetId));
    const previewHash = createHash('sha256')
      .update(
        stableJson({
          version: 'owned-dormant-watch-conversion.v1',
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          portfolioId: portfolio.id,
          revision: portfolio.revision,
          watches: watches.map((watch) => ({
            id: watch.id,
            peCode: watch.peCode,
            createdAt: watch.createdAt.toISOString(),
          })),
          members,
          subscriptions: subscriptions.map((subscription) => ({
            id: subscription.id,
            targetId: subscription.targetId,
            channel: subscription.channel,
            cadence: subscription.cadence,
            active: subscription.active,
            updatedAt: subscription.updatedAt.toISOString(),
          })),
        }),
      )
      .digest('hex');
    const previewItems = watches.map((watch) => ({
      watchId: watch.id,
      userId: ctx.userId,
      channel: 'in_app',
      legacyKind: 'program_element_watch',
      targetKind: 'program_element' as const,
      targetId: watch.peCode,
      active: false as const,
      willConvert: included.has(watch.peCode) && !subscribed.has(watch.peCode),
      reason: !included.has(watch.peCode)
        ? ('not_included_member' as const)
        : subscribed.has(watch.peCode)
          ? ('already_subscribed' as const)
          : ('convertible' as const),
    }));
    return {
      portfolioId: portfolio.id,
      expectedRevision: portfolio.revision,
      previewHash,
      legacyWatches: watches.length,
      convertibleWatches: previewItems.filter((item) => item.willConvert).length,
      alreadyConverted: previewItems.filter((item) => item.reason === 'already_subscribed').length,
      previewItems,
      limitations: [
        "Only this user's legacy PE watches and included portfolio PE members are supported.",
        'Selected conversions create dormant in-app subscriptions; activation is a separate explicit action. Legacy watches and existing subscription preferences are preserved.',
      ],
    };
  }

  async applyWatchConversion(
    ctx: TenantContext,
    portfolioId: string,
    input: ApplyResearchPortfolioWatchConversionDto,
  ): Promise<ResearchPortfolioWatchConversionResultDto> {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "research_portfolios" WHERE "id" = ${portfolioId}::uuid AND "tenant_id" = ${ctx.tenantId}::uuid FOR UPDATE`,
      );
      const portfolio = await loadAuthorized(tx, ctx, portfolioId, 'editor');
      if (
        !input ||
        typeof input.idempotencyKey !== 'string' ||
        !input.idempotencyKey.trim() ||
        input.idempotencyKey.length > 128 ||
        !Number.isSafeInteger(input.expectedRevision) ||
        input.expectedRevision < 1 ||
        typeof input.previewHash !== 'string' ||
        !/^[0-9a-f]{64}$/i.test(input.previewHash) ||
        !Array.isArray(input.selectedWatchIds) ||
        !input.selectedWatchIds.length ||
        input.selectedWatchIds.length > 200 ||
        input.selectedWatchIds.some((id) => typeof id !== 'string' || !UUID.test(id)) ||
        new Set(input.selectedWatchIds).size !== input.selectedWatchIds.length
      )
        throw new BadRequestException(
          'Watch conversion requires a bounded explicit selection, revision, preview hash and idempotency key',
        );
      const selection = [...input.selectedWatchIds].sort();
      const operationKey =
        'watch:convert:' + createHash('sha256').update(input.idempotencyKey).digest('hex');
      const operationFingerprint = createHash('sha256')
        .update(
          stableJson({
            operation: 'watch.convert.v1',
            portfolioId,
            ...input,
            selectedWatchIds: selection,
          }),
        )
        .digest('hex');
      const prior = await tx.researchPortfolioEvent.findFirst({
        where: { tenantId: ctx.tenantId, idempotencyKey: operationKey },
      });
      if (prior) {
        const payload = prior.payload as unknown as {
          receiptVersion?: number;
          receipt?: ResearchPortfolioWatchConversionResultDto;
        };
        if (
          prior.portfolioId !== portfolioId ||
          prior.actorUserId !== ctx.userId ||
          prior.payloadFingerprint !== operationFingerprint ||
          payload.receiptVersion !== 1 ||
          !payload.receipt
        )
          throw new ConflictException(
            'Watch conversion key belongs to another actor, portfolio, or immutable request',
          );
        return payload.receipt;
      }
      if (portfolio.lifecycle === 'archived')
        throw new BadRequestException('Cannot convert watches for archived portfolio');
      if (portfolio.revision !== input.expectedRevision)
        throw new ConflictException('Portfolio revision mismatch');
      const preview = await this.watchConversionPreview(tx, ctx, portfolio);
      if (preview.previewHash !== input.previewHash)
        throw new ConflictException(
          'Watch conversion preview changed; review a fresh preview before applying',
        );
      const selected = selection.map((watchId) =>
        preview.previewItems.find((item) => item.watchId === watchId),
      );
      if (selected.some((item) => !item || item.reason === 'not_included_member'))
        throw new BadRequestException(
          'Every selected watch must belong to this user and an included portfolio PE member',
        );
      const baseline = await tx.researchPortfolioEvent.findFirst({
        where: { tenantId: ctx.tenantId, portfolioId },
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        select: { id: true, occurredAt: true },
      });
      const completedAt = new Date();
      let convertedCount = 0,
        skippedCount = 0;
      for (const item of selected) {
        if (!item) throw new BadRequestException('Selected watch missing');
        if (!item.willConvert) {
          skippedCount++;
          continue;
        }
        const created = await tx.researchPortfolioSubscription.createMany({
          data: [
            {
              tenantId: ctx.tenantId,
              portfolioId,
              subscriberUserId: ctx.userId,
              targetKind: 'program_element',
              targetId: item.targetId,
              channel: 'in_app',
              cadence: 'immediate',
              active: false,
              baselineEventId: baseline?.id ?? null,
              baselineRevision: portfolio.revision,
              baselineCompletedAt: completedAt,
              checkpoint: {
                quietFirstBaseline: true,
                dormantConversion: true,
                legacyWatchId: item.watchId,
                observedThrough: baseline?.occurredAt.toISOString() ?? completedAt.toISOString(),
              },
            },
          ],
          skipDuplicates: true,
        });
        convertedCount += created.count;
        if (!created.count) skippedCount++;
        const row = await tx.researchPortfolioSubscription.findFirst({
          where: {
            tenantId: ctx.tenantId,
            portfolioId,
            subscriberUserId: ctx.userId,
            targetKind: 'program_element',
            targetId: item.targetId,
            channel: 'in_app',
            cadence: 'immediate',
          },
          select: { id: true },
        });
        if (!row) throw new ConflictException('Converted subscription receipt is unavailable');
      }
      const revision = portfolio.revision + (convertedCount ? 1 : 0);
      if (convertedCount) {
        const bumped = await tx.researchPortfolio.updateMany({
          where: {
            id: portfolioId,
            tenantId: ctx.tenantId,
            revision: portfolio.revision,
            lifecycle: 'active',
          },
          data: { revision: { increment: 1 } },
        });
        if (bumped.count !== 1) throw new ConflictException('Portfolio revision mismatch');
      }
      const receipt: ResearchPortfolioWatchConversionResultDto = {
        portfolioId,
        idempotencyKey: input.idempotencyKey,
        revision,
        convertedCount,
        skippedCount,
        limitations: [
          'Converted subscriptions are dormant. Legacy watches and existing subscription preferences were preserved; no notifications were sent.',
        ],
      };
      await tx.researchPortfolioEvent.create({
        data: {
          tenantId: ctx.tenantId,
          portfolioId,
          eventKind: 'updated',
          aggregateRevision: revision,
          actorUserId: ctx.userId,
          idempotencyKey: operationKey,
          payloadFingerprint: operationFingerprint,
          payload: {
            receiptVersion: 1,
            operation: 'watch_conversion',
            receipt: receipt as unknown as Prisma.InputJsonObject,
          },
        },
      });
      return receipt;
    });
  }

  // --- Operations ---

  async getOperation(
    ctx: TenantContext,
    portfolioId: string,
    operationId: string,
  ): Promise<ResearchPortfolioOperationDto> {
    if (!UUID.test(operationId)) throw new NotFoundException('Operation not found');
    return this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx: any) => {
      const portfolio = await loadAuthorized(tx, ctx, portfolioId, 'viewer');
      const where = { tenantId: ctx.tenantId, portfolioId, id: operationId };
      const importJob = await tx.researchPortfolioImportJob.findFirst({ where });
      if (importJob) {
        const creation = await tx.researchPortfolioEvent.findFirst({
          where: {
            tenantId: ctx.tenantId,
            portfolioId,
            eventKind: 'import_created',
            payload: { path: ['jobId'], equals: operationId },
          },
          orderBy: { occurredAt: 'asc' },
          select: { actorUserId: true },
        });
        const retryCount = await tx.researchPortfolioImportAttempt.count({
          where: { tenantId: ctx.tenantId, portfolioId, importJobId: operationId, action: 'retry' },
        });
        return this.operationDto(importJob, 'import', {
          actorUserId: creation?.actorUserId ?? null,
          retryCount,
          label: importJob.fileName,
          limitations: ['Import execution start and completion timestamps were not captured.'],
        });
      }
      const recomputeJob = await tx.researchPortfolioRecomputeJob.findFirst({ where });
      if (recomputeJob) {
        const publication = await tx.researchPortfolioEvent.findFirst({
          where: {
            tenantId: ctx.tenantId,
            portfolioId,
            eventKind: 'rule_published',
            payload: { path: ['operationId'], equals: operationId },
          },
          orderBy: { occurredAt: 'asc' },
          select: { actorUserId: true, occurredAt: true },
        });
        return this.operationDto(recomputeJob, 'recompute', {
          actorUserId: publication?.actorUserId ?? null,
          retryCount: Math.max(0, recomputeJob.attempt - 1),
          completedAt: ['completed', 'partial'].includes(recomputeJob.status)
            ? (publication?.occurredAt ?? null)
            : null,
          limitations: [
            'Execution start was not captured; completion is the immutable publication commit observation.',
          ],
        });
      }
      const outputJob = await tx.researchPortfolioOutputJob.findFirst({
        where,
        include: { request: { select: { requestedByUserId: true } } },
      });
      if (outputJob) {
        const retryCount = await tx.researchPortfolioOutputAttempt.count({
          where: { tenantId: ctx.tenantId, portfolioId, jobId: operationId, action: 'retry' },
        });
        const completed = ['completed', 'partial', 'failed', 'cancelled'].includes(outputJob.status)
          ? await tx.researchPortfolioOutputAttempt.findFirst({
              where: {
                tenantId: ctx.tenantId,
                portfolioId,
                jobId: operationId,
                outcome: outputJob.status,
                completedAt: { not: null },
              },
              orderBy: { attemptNumber: 'desc' },
              select: { completedAt: true },
            })
          : null;
        return this.operationDto(outputJob, 'output', {
          actorUserId: outputJob.request?.requestedByUserId ?? null,
          retryCount,
          completedAt: completed?.completedAt ?? null,
          limitations: [
            'Execution start is not inferred from an attempt record written at finalization.',
          ],
        });
      }
      const filing = await tx.researchPortfolioClientFilingJob.findFirst({
        where: { ...where, actorUserId: ctx.userId },
      });
      if (filing) {
        await this.authorizeFiling(tx, ctx, portfolio, filing);
        return this.operationDto(filing, 'client_filing', {
          actorUserId: filing.actorUserId,
          startedAt: filing.writerStartedAt,
          completedAt: filing.completedAt,
          limitations: [
            'Only the original caller can observe this filing handle. Reconciliation never starts another document write.',
          ],
        });
      }
      const snapshot = await tx.researchPortfolioSnapshot.findFirst({ where });
      if (snapshot) {
        await assertResearchPortfolioClientAccess(
          tx,
          ctx,
          snapshot.clientAccessRequirements as readonly string[],
        );
        return this.operationDto(
          {
            ...snapshot,
            status: 'completed',
            createdAt: snapshot.capturedAt,
            updatedAt: snapshot.capturedAt,
          },
          'snapshot',
          {
            actorUserId: snapshot.createdByUserId,
            label: snapshot.name,
            completedAt: snapshot.capturedAt,
            limitations: ['Snapshot execution start was not captured.'],
          },
        );
      }
      throw new NotFoundException('Operation not found');
    });
  }

  private async authorizeFiling(
    tx: any,
    ctx: TenantContext,
    portfolio: any,
    filing: any,
  ): Promise<void> {
    const membership = await tx.tenantMembership.findFirst({
      where: { tenantId: ctx.tenantId, userId: ctx.userId, status: 'active' },
      select: { id: true },
    });
    if (
      !membership ||
      !portfolio.clientLinks.some((link: any) => link.clientId === filing.clientId)
    )
      throw new NotFoundException('Operation not found');
    await assertResearchPortfolioClientAccess(tx, ctx, [filing.clientId]);
  }

  async reconcileOperation(
    ctx: TenantContext,
    portfolioId: string,
    operationId: string,
    input: ReconcileResearchPortfolioOperationDto = {},
  ): Promise<ResearchPortfolioOperationDto> {
    if (!UUID.test(operationId)) throw new NotFoundException('Operation not found');
    // Discovery is read-only. The owning domain service reauthorizes inside its mutation transaction.
    const target = await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx: any) => {
      const portfolio = await loadAuthorized(tx, ctx, portfolioId, 'editor');
      const where = { tenantId: ctx.tenantId, portfolioId, id: operationId };
      const output = await tx.researchPortfolioOutputJob.findFirst({ where, select: { id: true } });
      if (output) return { kind: 'output' as const, job: output };
      const filing = await tx.researchPortfolioClientFilingJob.findFirst({
        where: { ...where, actorUserId: ctx.userId },
      });
      if (filing) {
        await this.authorizeFiling(tx, ctx, portfolio, filing);
        if (!input.operationKey || input.operationKey !== filing.operationKey)
          throw new BadRequestException(
            'The exact original caller operationKey is required to reconcile this filing',
          );
        return { kind: 'client_filing' as const, job: filing };
      }
      for (const model of [
        tx.researchPortfolioImportJob,
        tx.researchPortfolioRecomputeJob,
        tx.researchPortfolioSnapshot,
      ]) {
        if (await model.findFirst({ where, select: { id: true } }))
          throw new BadRequestException({
            code: 'RESEARCH_PORTFOLIO_OPERATION_RECONCILE_UNSUPPORTED',
            message:
              'Use the original domain action with its complete immutable request. This operation handle cannot reconstruct that request.',
          });
      }
      throw new NotFoundException('Operation not found');
    });
    if (!this.outputs) throw new BadRequestException('Output reconciliation is unavailable');
    if (target.kind === 'output')
      await this.outputs.reconcile(ctx, portfolioId, target.job.id, 'editor');
    else
      await this.outputs.saveToClient(
        ctx,
        portfolioId,
        target.job.artifactId,
        { clientId: target.job.clientId, operationKey: input.operationKey! },
        'editor',
        true,
      );
    return this.getOperation(ctx, portfolioId, operationId);
  }

  // --- Tour state ---

  async getTourState(
    ctx: TenantContext,
    tourVersion: string,
  ): Promise<ResearchPortfolioTourStateDto> {
    const row = await this.prisma.withTenant(ctx.tenantId, async (tx: any) => {
      return tx.researchPortfolioTourState.findFirst({
        where: { tenantId: ctx.tenantId, userId: ctx.userId, tourVersion },
      });
    });
    if (!row) return { tourVersion, status: 'active', completedAt: null };
    return {
      tourVersion: row.tourVersion,
      status: row.status as 'active' | 'dismissed' | 'completed',
      completedAt: row.completedAt ? asIso(row.completedAt) : null,
    };
  }

  async updateTourState(
    ctx: TenantContext,
    tourVersion: string,
    status: 'dismissed' | 'completed',
  ): Promise<ResearchPortfolioTourStateDto> {
    return this.prisma.withTenant(ctx.tenantId, async (tx: any) => {
      const existing = await tx.researchPortfolioTourState.findFirst({
        where: { tenantId: ctx.tenantId, userId: ctx.userId, tourVersion },
      });
      const completedAt = status === 'completed' ? new Date() : null;
      if (existing) {
        const row = await tx.researchPortfolioTourState.update({
          where: { id: existing.id },
          data: { status, completedAt },
        });
        return {
          tourVersion: row.tourVersion,
          status: row.status as 'dismissed' | 'completed',
          completedAt: row.completedAt ? asIso(row.completedAt) : null,
        };
      }
      const row = await tx.researchPortfolioTourState.create({
        data: { tenantId: ctx.tenantId, userId: ctx.userId, tourVersion, status, completedAt },
      });
      return {
        tourVersion: row.tourVersion,
        status: row.status as 'dismissed' | 'completed',
        completedAt: row.completedAt ? asIso(row.completedAt) : null,
      };
    });
  }

  // --- Helpers ---

  private bookmarkDto(row: any): ResearchPortfolioBookmarkDto {
    return {
      id: row.id,
      portfolioId: row.portfolioId,
      userId: row.userId,
      targetKind: row.targetKind,
      targetId: row.targetId,
      label: row.label,
      note: row.note,
      createdAt: asIso(row.createdAt),
      updatedAt: asIso(row.updatedAt),
    };
  }

  private operationDto(
    row: any,
    kind: ResearchPortfolioOperationKind,
    facts: {
      actorUserId: string | null;
      retryCount?: number;
      label?: string | null;
      startedAt?: Date | null;
      completedAt?: Date | null;
      limitations: string[];
    },
  ): ResearchPortfolioOperationDto {
    const domainStatus: string = row.status;
    const known: Record<string, ResearchPortfolioOperationStatus> = {
      queued: 'queued',
      running: 'running',
      completed: 'completed',
      partial: 'partial',
      failed: 'failed',
      cancelled: 'cancelled',
      outcome_unknown: 'outcome_unknown',
      created: 'queued',
      mapped: 'queued',
      previewed: 'queued',
      applying: 'running',
      paused: 'paused',
      unknown: 'outcome_unknown',
      needs_reconciliation: 'outcome_unknown',
      compensated: 'completed',
      pending: 'running',
    };
    const status = known[domainStatus] ?? 'outcome_unknown';
    const limitations = [
      ...facts.limitations,
      ...(!facts.actorUserId ? ['Original actor provenance was not captured.'] : []),
      ...(!known[domainStatus] ? ['Domain status has no supported generic mapping.'] : []),
      ...(domainStatus === 'compensated'
        ? [
            'Completed compensation preserves the original import history; it does not mean the imported effects remain applied.',
          ]
        : []),
    ];
    return {
      id: row.id,
      portfolioId: row.portfolioId,
      kind,
      status,
      domainStatus,
      actorUserId: facts.actorUserId,
      label: facts.label ?? null,
      startedAt: facts.startedAt ? asIso(facts.startedAt) : null,
      completedAt: facts.completedAt ? asIso(facts.completedAt) : null,
      lastErrorCode: row.lastErrorCode ?? row.errorCode ?? null,
      lastError: row.lastError ?? null,
      retryCount: facts.retryCount ?? 0,
      createdAt: asIso(row.createdAt),
      updatedAt: asIso(row.updatedAt),
      limitations,
    };
  }
}
