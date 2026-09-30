import {
  Injectable,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type {
  TenantContext,
  SaveDefenseComparisonDto,
  DefenseSavedComparisonDto,
  DefenseSavedComparisonReceiptDto,
  DefenseComparisonResponseDto,
  DefenseSavedComparisonVersionDto,
  DefenseEvidenceRefDto,
  ChangeDefenseSavedComparisonLifecycleDto,
  AddDefenseSavedComparisonSelectionDto,
  DefenseSavedComparisonSelectionReceiptDto,
} from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { DefenseResearchService } from './defense-research.service.js';
import { readCanonicalResearchTarget } from '../research-portfolios/research-portfolio-targets.js';
import { loadAuthorizedResearchPortfolio } from '../research-portfolios/research-portfolio-access.js';
export interface DefenseSavedComparisonScope {
  readonly portfolioId: string;
}

type Tx = Prisma.TransactionClient;
const TYPES = ['program_element', 'program', 'project', 'budget_line', 'context_document'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BASIS_FIELDS = [
  'requestEdition',
  'fundingFiscalYear',
  'stage',
  'metric',
  'unit',
  'currency',
  'priceBasis',
  'asOfDate',
  'periodStart',
  'periodEnd',
];
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const canonical = (value: unknown): string =>
  Array.isArray(value)
    ? '[' + value.map(canonical).join(',') + ']'
    : value && typeof value === 'object'
      ? '{' +
        Object.keys(value)
          .sort()
          .map(
            (key) => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key]),
          )
          .join(',') +
        '}'
      : JSON.stringify(value);
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');

@Injectable()
export class DefenseSavedComparisonsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly research: DefenseResearchService,
  ) {}

  private validate(input: SaveDefenseComparisonDto): void {
    if (
      !input ||
      input.schemaVersion !== 'defense_saved_comparison_v1' ||
      input.displayVersion !== 'defense-compare-display-v1'
    )
      throw new BadRequestException('Unsupported saved comparison version');
    if (
      typeof input.name !== 'string' ||
      !input.name.trim() ||
      input.name.trim().length > 200 ||
      typeof input.idempotencyKey !== 'string' ||
      !input.idempotencyKey.trim() ||
      input.idempotencyKey.length > 128
    )
      throw new BadRequestException('Name and idempotency key are required');
    if (
      !Array.isArray(input.subjects) ||
      input.subjects.length < 2 ||
      input.subjects.length > 5 ||
      input.subjects.some(
        (s) =>
          !s ||
          !TYPES.includes(s.type) ||
          typeof s.id !== 'string' ||
          !s.id.trim() ||
          s.id !== s.id.trim() ||
          s.id.length > 256,
      )
    )
      throw new BadRequestException('Save requires 2–5 typed public subjects');
    const keys = input.subjects.map((s) => s.type + ':' + s.id);
    if (new Set(keys).size !== keys.length)
      throw new BadRequestException('Subjects must be distinct');
    if (
      !input.selection ||
      input.selection.mode !== 'explicit' ||
      !Array.isArray(input.selection.subjectKeys) ||
      !Array.isArray(input.selection.passageIds) ||
      input.selection.subjectKeys.some((k) => !keys.includes(k)) ||
      new Set(input.selection.subjectKeys).size !== input.selection.subjectKeys.length ||
      new Set(input.selection.passageIds).size !== input.selection.passageIds.length ||
      input.selection.passageIds.some((id) => typeof id !== 'string' || !UUID.test(id))
    )
      throw new BadRequestException('Explicit valid subject and passage selection is required');
    for (const basis of [input.basisPair?.left, input.basisPair?.right]) {
      if (
        !basis ||
        typeof basis !== 'object' ||
        Array.isArray(basis) ||
        BASIS_FIELDS.some((field) => !(field in basis))
      )
        throw new BadRequestException('Both complete nullable bases are required');
      if (
        Object.entries(basis).some(
          ([field, value]) =>
            !BASIS_FIELDS.includes(field) ||
            (field === 'fundingFiscalYear'
              ? value !== null &&
                (!Number.isInteger(value) || Number(value) < 1900 || Number(value) > 2200)
              : value !== null && (typeof value !== 'string' || value.length > 256)),
        )
      )
        throw new BadRequestException('Invalid comparison basis');
    }
    if (
      !['none', 'native_sections'].includes(input.passageMode) ||
      !Array.isArray(input.contextualRevisionPins)
    )
      throw new BadRequestException('Passage mode and revision pins are required');
    const documents = input.subjects.filter((s) => s.type === 'context_document').map((s) => s.id);
    if (
      input.contextualRevisionPins.some(
        (p) =>
          !p ||
          !documents.includes(p.documentId) ||
          !UUID.test(p.documentId) ||
          !UUID.test(p.revisionId) ||
          !Array.isArray(p.sectionIds) ||
          p.sectionIds.some((id: unknown) => typeof id !== 'string' || !UUID.test(id)) ||
          new Set(p.sectionIds).size !== p.sectionIds.length,
      ) ||
      input.contextualRevisionPins.length !== documents.length ||
      new Set(input.contextualRevisionPins.map((p) => p.documentId)).size !== documents.length
    )
      throw new BadRequestException('Every contextual subject requires one exact revision pin');
    const sections = input.contextualRevisionPins.flatMap((p) => [...p.sectionIds]);
    if (
      input.selection.passageIds.some((id) => !sections.includes(id)) ||
      (input.passageMode === 'none' && input.selection.passageIds.length)
    )
      throw new BadRequestException('Selected passages must belong to pinned revisions');
    if (input.portfolioId != null && !UUID.test(input.portfolioId))
      throw new BadRequestException('Invalid portfolio attachment');
    if (
      input.expectedRevision !== undefined &&
      (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1)
    )
      throw new BadRequestException('Invalid expected revision');
    if (
      'knownAt' in input ||
      'capturedProjection' in input ||
      'contentHash' in input ||
      'sourcePins' in input
    )
      throw new BadRequestException('Capture values and knownAt are server generated');
  }

  private async member(tx: Tx, ctx: TenantContext) {
    await tx.$executeRaw`SELECT id FROM tenant_memberships WHERE tenant_id = ${ctx.tenantId}::uuid AND user_id = ${ctx.userId}::uuid AND status = 'active' FOR SHARE`;
    if (
      !(await tx.tenantMembership.findFirst({
        where: { tenantId: ctx.tenantId, userId: ctx.userId, status: 'active' },
        select: { id: true },
      }))
    )
      throw new ForbiddenException('Active tenant membership required');
  }
  private async portfolio(tx: Tx, ctx: TenantContext, portfolioId: string | null, write: boolean) {
    if (!portfolioId) return;
    await tx.$executeRaw`SELECT id FROM research_portfolios WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ${portfolioId}::uuid FOR SHARE`;
    await tx.$executeRaw`SELECT id FROM research_portfolio_grants WHERE tenant_id = ${ctx.tenantId}::uuid AND portfolio_id = ${portfolioId}::uuid AND principal_user_id = ${ctx.userId}::uuid FOR SHARE`;
    const row = await tx.researchPortfolio.findFirst({
      where: {
        id: portfolioId,
        tenantId: ctx.tenantId,
        ...(write ? { lifecycle: 'active' } : {}),
        grants: {
          some: {
            principalUserId: ctx.userId,
            ...(write ? { role: { in: ['editor', 'owner'] } } : {}),
          },
        },
      },
      select: { id: true },
    });
    if (!row)
      throw new NotFoundException(
        write ? 'Authorized active editable portfolio not found' : 'Authorized portfolio not found',
      );
  }
  private normalizeScope(
    scope?: DefenseSavedComparisonScope,
  ): DefenseSavedComparisonScope | undefined {
    if (scope === undefined) return undefined;
    if (!scope || typeof scope.portfolioId !== 'string' || !UUID.test(scope.portfolioId))
      throw new BadRequestException('Invalid server Research Portfolio scope');
    return Object.freeze({ portfolioId: scope.portfolioId });
  }
  private assertScope(
    portfolioId: string | null | undefined,
    scope?: DefenseSavedComparisonScope,
  ): void {
    if (scope && portfolioId !== scope.portfolioId)
      throw new NotFoundException('Saved comparison is outside the current Research Portfolio');
  }
  private async authorized(
    tx: Tx,
    ctx: TenantContext,
    id: string,
    write: boolean,
    scope?: DefenseSavedComparisonScope,
  ) {
    await this.member(tx, ctx);
    const row = await tx.defenseSavedComparison.findFirst({
      where: { id, tenantId: ctx.tenantId, ownerUserId: ctx.userId },
      include: { currentVersion: true },
    });
    if (!row) throw new NotFoundException('Saved comparison not found');
    this.assertScope(row.portfolioId, scope);
    await this.portfolio(tx, ctx, row.portfolioId, write);
    if (scope) {
      // Match native attachment order: portfolio authority first, saved parent second.
      // Re-read under SHARE to reject a reattachment between the initial peek and lock.
      await tx.$executeRaw`SELECT id FROM defense_saved_comparisons WHERE tenant_id=${ctx.tenantId}::uuid AND id=${id}::uuid FOR SHARE`;
      const locked = await tx.defenseSavedComparison.findFirst({
        where: { id, tenantId: ctx.tenantId, ownerUserId: ctx.userId },
        include: { currentVersion: true },
      });
      if (!locked) throw new NotFoundException('Saved comparison not found');
      this.assertScope(locked.portfolioId, scope);
      return locked;
    }
    return row;
  }
  private version(row: any): DefenseSavedComparisonVersionDto {
    return {
      id: row.id,
      version: row.version,
      schemaVersion: row.schemaVersion,
      displayVersion: row.displayVersion,
      projectionVersion: row.projectionVersion,
      subjects: row.subjects,
      selection: row.selection,
      basisPair: row.basisPair,
      passageMode: row.passageMode,
      sourcePins: row.sourcePins,
      capturedProjection: row.capturedProjection,
      contentHash: row.contentHash,
      capturedAt: row.capturedAt.toISOString(),
      captureKnownAt: row.captureKnownAt.toISOString(),
      knownAtSupport: 'capture_only',
      limitations: row.limitations,
    };
  }
  private dto(row: any, version = row.currentVersion): DefenseSavedComparisonDto {
    if (!version) throw new ConflictException('Saved comparison capture is incomplete');
    return {
      id: row.id,
      name: row.name,
      ownerUserId: row.ownerUserId,
      portfolioId: row.portfolioId,
      revision: row.revision,
      archivedAt: row.archivedAt?.toISOString() ?? null,
      currentVersion: this.version(version),
    };
  }
  async get(
    ctx: TenantContext,
    id: string,
    versionId?: string,
    scope?: DefenseSavedComparisonScope,
  ): Promise<DefenseSavedComparisonDto> {
    scope = this.normalizeScope(scope);
    if (!UUID.test(id) || (versionId && !UUID.test(versionId)))
      throw new NotFoundException('Saved comparison not found');
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const row = await this.authorized(tx, ctx, id, false, scope);
      if (!versionId) return this.dto(row);
      const version = await tx.defenseSavedComparisonVersion.findFirst({
        where: { id: versionId, tenantId: ctx.tenantId, comparisonId: row.id },
      });
      if (!version) throw new NotFoundException('Saved comparison version not found');
      return this.dto(row, version);
    });
  }
  async list(
    ctx: TenantContext,
    includeArchived = false,
    scope?: DefenseSavedComparisonScope,
  ): Promise<readonly DefenseSavedComparisonDto[]> {
    scope = this.normalizeScope(scope);
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await this.member(tx, ctx);
      const rows = await tx.defenseSavedComparison.findMany({
        where: {
          tenantId: ctx.tenantId,
          ownerUserId: ctx.userId,
          ...(scope ? { portfolioId: scope.portfolioId } : {}),
          ...(includeArchived ? {} : { archivedAt: null }),
          OR: [
            { portfolioId: null },
            { portfolio: { grants: { some: { principalUserId: ctx.userId } } } },
          ],
        },
        include: { currentVersion: true },
        orderBy: { updatedAt: 'desc' },
        take: 50,
      });
      return rows.map((row) => this.dto(row));
    });
  }
  private async replay(
    tx: Tx,
    ctx: TenantContext,
    key: string,
    fingerprint: string,
    scope?: DefenseSavedComparisonScope,
  ): Promise<DefenseSavedComparisonReceiptDto | null> {
    const event = await tx.defenseSavedComparisonEvent.findFirst({
      where: { tenantId: ctx.tenantId, actorUserId: ctx.userId, idempotencyKey: key },
    });
    if (!event) return null;
    // Current authorization always precedes payload comparison or receipt disclosure.
    const parent = await this.authorized(tx, ctx, event.comparisonId, false, scope);
    const receiptMetadata = event.payload as { portfolioId?: string | null };
    this.assertScope(receiptMetadata.portfolioId, scope);
    if (event.payloadFingerprint !== fingerprint)
      throw new ConflictException('Idempotency key was used for different content');
    const version = event.versionId
      ? await tx.defenseSavedComparisonVersion.findFirst({
          where: { id: event.versionId, tenantId: ctx.tenantId, comparisonId: parent.id },
        })
      : parent.currentVersion;
    const metadata = event.payload as {
      name: string;
      portfolioId: string | null;
      revision: number;
      archivedAt?: string | null;
    };
    return {
      comparison: this.dto(
        {
          ...parent,
          ...metadata,
          archivedAt: metadata.archivedAt ? new Date(metadata.archivedAt) : null,
        },
        version,
      ),
      eventId: event.id,
      resultingRevision: event.aggregateRevision,
      replayed: true,
    };
  }
  private async capture(input: SaveDefenseComparisonDto) {
    const tokens = input.subjects.map((s) => s.type + ':' + s.id);
    const pins = input.contextualRevisionPins;
    // Compare reads exact selected contextual revisions, never client-provided values.
    const project = async () => {
      const full = await this.research.compare(tokens, { contextualRevisionPins: pins });
      const selected = new Set(input.selection.subjectKeys),
        passages = new Set(input.selection.passageIds);
      const basisKeys = [input.basisPair.left, input.basisPair.right]
        .filter((b) => b.asOfDate === null && b.periodStart === null && b.periodEnd === null)
        .map((b) =>
          [
            b.requestEdition ?? 'unknown-edition',
            b.fundingFiscalYear,
            b.stage,
            b.metric,
            b.unit,
            b.currency ?? 'unknown-currency',
            b.priceBasis ?? 'unknown-price-basis',
          ].join('|'),
        );
      const metrics = full.metrics
        .filter((m) =>
          m.metric === 'passage'
            ? input.passageMode === 'native_sections' &&
              m.cells.some((c) =>
                c.evidence.some(
                  (e) =>
                    e.evidenceRefId.startsWith('context-compare:') &&
                    passages.has(e.evidenceRefId.slice('context-compare:'.length)),
                ),
              )
            : basisKeys.includes(m.key),
        )
        .map((m) => ({
          ...m,
          cells: m.cells.filter(
            (c) =>
              selected.has(c.subjectKey) &&
              (m.metric !== 'passage' ||
                c.evidence.some(
                  (e) =>
                    e.evidenceRefId.startsWith('context-compare:') &&
                    passages.has(e.evidenceRefId.slice('context-compare:'.length)),
                )),
          ),
        }))
        .filter((m) => m.cells.length > 0);
      const projection: DefenseComparisonResponseDto = {
        ...full,
        subjects: full.subjects.filter((s) => selected.has(s.key)),
        metrics,
        alignments: full.alignments.map((a) => ({
          ...a,
          subjectEvidence: Object.fromEntries(
            Object.entries(a.subjectEvidence).filter(([key]) => selected.has(key)),
          ),
        })),
        limitations: [
          ...full.limitations,
          'This immutable capture supports capture-time reopening only; arbitrary historical knownAt reconstruction is unavailable.',
          'Saved bases retain unsupported execution periods without coercion; current Defense Compare supports its native funding bases only.',
        ],
      };
      // Fingerprint complete server projection before filtering too: changed canonical
      // observations cannot be hidden by an empty selection during capture.
      return { full, projection };
    };
    const first = await project(),
      second = await project();
    if (digest(first.full) !== digest(second.full))
      throw new ConflictException('Source projection changed during capture; refresh and retry');
    const evidence: DefenseEvidenceRefDto[] = [
      ...first.full.metrics.flatMap((m) => m.cells.flatMap((c) => [...c.evidence])),
      ...first.full.alignments.flatMap((a) =>
        Object.values(a.subjectEvidence).flatMap((e) => [...e]),
      ),
    ];
    const sourcePins = {
      contextualRevisionPins: pins,
      evidence: [
        ...new Map(evidence.map((e) => [e.evidenceRefId + '|' + e.contentHash, e])).values(),
      ],
    };
    return { projection: first.projection, sourcePins };
  }
  async save(
    ctx: TenantContext,
    input: SaveDefenseComparisonDto,
    id?: string,
    scope?: DefenseSavedComparisonScope,
  ): Promise<DefenseSavedComparisonReceiptDto> {
    scope = this.normalizeScope(scope);
    if (scope) {
      if (input?.portfolioId !== undefined && input.portfolioId !== scope.portfolioId)
        throw new BadRequestException(
          'Capture attachment must match the server Research Portfolio scope',
        );
      input = { ...input, portfolioId: scope.portfolioId };
    }
    this.validate(input);
    if (id && !UUID.test(id)) throw new NotFoundException('Saved comparison not found');
    const fingerprint = digest({ operation: id ? 'revise' : 'create', id: id ?? null, input });
    return this.prisma.withTenant(
      ctx.tenantId,
      async (tx) => {
        await this.member(tx, ctx);
        if (id)
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${ctx.tenantId + ':saved-comparison:' + id}, 0))`;
        let parent = id ? await this.authorized(tx, ctx, id, false, scope) : null;
        // Serialize actor-scoped idempotency before lookup, including concurrent creates.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${ctx.tenantId + ':' + ctx.userId + ':' + input.idempotencyKey}, 0))`;
        const replay = await this.replay(tx, ctx, input.idempotencyKey, fingerprint, scope);
        if (replay) return replay;
        // Historical same-actor receipts require current read authority, even when
        // the attached portfolio is archived or the original owner is now a viewer.
        // Only a genuinely new capture requires an active editable portfolio.
        if (parent) parent = await this.authorized(tx, ctx, id!, true, scope);
        await this.portfolio(tx, ctx, input.portfolioId ?? parent?.portfolioId ?? null, true);
        if (parent && (parent.archivedAt || input.expectedRevision !== parent.revision))
          throw new ConflictException('Saved comparison revision is stale or archived');
        const { projection, sourcePins } = await this.capture(input);
        // Recheck current grants after source work and immediately before persistence.
        await this.member(tx, ctx);
        await this.portfolio(tx, ctx, input.portfolioId ?? parent?.portfolioId ?? null, true);
        const comparisonId = parent?.id ?? randomUUID(),
          versionId = randomUUID(),
          capturedAt = new Date();
        if (!parent)
          parent = await tx.defenseSavedComparison.create({
            data: {
              id: comparisonId,
              tenantId: ctx.tenantId,
              ownerUserId: ctx.userId,
              name: input.name.trim(),
              portfolioId: input.portfolioId ?? null,
            },
            include: { currentVersion: true },
          });
        const previous = parent.currentVersion?.version ?? 0,
          revision = id ? parent.revision + 1 : parent.revision;
        const content = {
          subjects: input.subjects,
          selection: input.selection,
          basisPair: input.basisPair,
          passageMode: input.passageMode,
          sourcePins,
          capturedProjection: projection,
          displayVersion: input.displayVersion,
          captureKnownAt: capturedAt.toISOString(),
        };
        const version = await tx.defenseSavedComparisonVersion.create({
          data: {
            id: versionId,
            tenantId: ctx.tenantId,
            comparisonId,
            version: previous + 1,
            creatorUserId: ctx.userId,
            schemaVersion: input.schemaVersion,
            projectionVersion: projection.projectionVersion,
            displayVersion: input.displayVersion,
            subjects: json(input.subjects),
            selection: json(input.selection),
            basisPair: json(input.basisPair),
            passageMode: input.passageMode,
            sourcePins: json(sourcePins),
            capturedProjection: json(projection),
            limitations: json(projection.limitations),
            contentHash: digest(content),
            capturedAt,
            captureKnownAt: capturedAt,
            knownAtSupport: 'capture_only',
          },
        });
        const updated = await tx.defenseSavedComparison.updateMany({
          where: {
            id: comparisonId,
            tenantId: ctx.tenantId,
            ownerUserId: ctx.userId,
            revision: parent.revision,
            ...(scope ? { portfolioId: scope.portfolioId } : {}),
          },
          data: {
            currentVersionId: versionId,
            revision,
            name: input.name.trim(),
            ...(input.portfolioId !== undefined ? { portfolioId: input.portfolioId } : {}),
          },
        });
        if (updated.count !== 1) throw new ConflictException('Saved comparison revision is stale');
        const event = await tx.defenseSavedComparisonEvent.create({
          data: {
            tenantId: ctx.tenantId,
            comparisonId,
            versionId,
            actorUserId: ctx.userId,
            aggregateRevision: revision,
            eventKind: id ? 'revised' : 'created',
            idempotencyKey: input.idempotencyKey,
            payloadFingerprint: fingerprint,
            payload: {
              versionId,
              name: input.name.trim(),
              portfolioId: input.portfolioId !== undefined ? input.portfolioId : parent.portfolioId,
              revision,
            },
          },
        });
        return {
          comparison: this.dto(
            {
              ...parent,
              name: input.name.trim(),
              portfolioId: input.portfolioId !== undefined ? input.portfolioId : parent.portfolioId,
              revision,
            },
            version,
          ),
          eventId: event.id,
          resultingRevision: revision,
          replayed: false,
        };
      },
      { timeoutMs: 20000 },
    );
  }

  private validateMutation(input: ChangeDefenseSavedComparisonLifecycleDto) {
    if (
      !input ||
      !Number.isInteger(input.expectedRevision) ||
      input.expectedRevision < 1 ||
      typeof input.idempotencyKey !== 'string' ||
      !input.idempotencyKey.trim() ||
      input.idempotencyKey.length > 128
    )
      throw new BadRequestException('Revision and idempotency key are required');
  }
  async changeLifecycle(
    ctx: TenantContext,
    id: string,
    input: ChangeDefenseSavedComparisonLifecycleDto,
    archived: boolean,
    scope?: DefenseSavedComparisonScope,
  ): Promise<DefenseSavedComparisonReceiptDto> {
    scope = this.normalizeScope(scope);
    this.validateMutation(input);
    if (!UUID.test(id)) throw new NotFoundException('Saved comparison not found');
    const fingerprint = digest({ operation: archived ? 'archive' : 'restore', id, input });
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${ctx.tenantId + ':saved-comparison:' + id},0))`;
      const parent = await this.authorized(tx, ctx, id, false, scope);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${ctx.tenantId + ':' + ctx.userId + ':' + input.idempotencyKey},0))`;
      const replay = await this.replay(tx, ctx, input.idempotencyKey, fingerprint, scope);
      if (replay) return replay;
      if (parent.revision !== input.expectedRevision)
        throw new ConflictException('Saved comparison revision is stale');
      if (!!parent.archivedAt === archived)
        throw new ConflictException(
          archived ? 'Saved comparison is already archived' : 'Saved comparison is already active',
        );
      const archivedAt = archived ? new Date() : null,
        revision = parent.revision + 1;
      const updated = await tx.defenseSavedComparison.updateMany({
        where: {
          id,
          tenantId: ctx.tenantId,
          ownerUserId: ctx.userId,
          revision: input.expectedRevision,
          ...(scope ? { portfolioId: scope.portfolioId } : {}),
        },
        data: { archivedAt, revision },
      });
      if (updated.count !== 1) throw new ConflictException('Saved comparison revision is stale');
      const event = await tx.defenseSavedComparisonEvent.create({
        data: {
          tenantId: ctx.tenantId,
          comparisonId: id,
          versionId: parent.currentVersionId,
          actorUserId: ctx.userId,
          aggregateRevision: revision,
          eventKind: archived ? 'archived' : 'restored',
          idempotencyKey: input.idempotencyKey,
          payloadFingerprint: fingerprint,
          payload: {
            name: parent.name,
            portfolioId: parent.portfolioId,
            revision,
            archivedAt: archivedAt?.toISOString() ?? null,
          },
        },
      });
      return {
        comparison: this.dto({ ...parent, revision, archivedAt }),
        eventId: event.id,
        resultingRevision: revision,
        replayed: false,
      };
    });
  }

  async addSelectionToPortfolio(
    ctx: TenantContext,
    id: string,
    versionId: string,
    input: AddDefenseSavedComparisonSelectionDto,
    scope?: DefenseSavedComparisonScope,
  ): Promise<DefenseSavedComparisonSelectionReceiptDto> {
    scope = this.normalizeScope(scope);
    if (scope && input?.portfolioId !== scope.portfolioId)
      throw new BadRequestException(
        'Selection target must match the server Research Portfolio scope',
      );
    this.validateMutation(input);
    if (
      !UUID.test(id) ||
      !UUID.test(versionId) ||
      !UUID.test(input.portfolioId) ||
      !Number.isInteger(input.expectedPortfolioRevision) ||
      input.expectedPortfolioRevision < 1 ||
      !input.selection ||
      input.selection.mode !== 'explicit' ||
      !Array.isArray(input.selection.subjectKeys) ||
      !Array.isArray(input.selection.passageIds) ||
      new Set(input.selection.subjectKeys).size !== input.selection.subjectKeys.length ||
      new Set(input.selection.passageIds).size !== input.selection.passageIds.length
    )
      throw new BadRequestException(
        'Exact capture, portfolio revision and explicit selection are required',
      );
    const fingerprint = digest({ operation: 'add_selection_to_portfolio', id, versionId, input });
    return this.prisma.withTenant(
      ctx.tenantId,
      async (tx) => {
        await this.member(tx, ctx);
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${ctx.tenantId + ':saved-comparison:' + id},0))`;
        // Obtain only caller-owned metadata before locking both portfolio parents
        // in a stable order; current grants are checked after those locks.
        const owned = await tx.defenseSavedComparison.findFirst({
          where: { id, tenantId: ctx.tenantId, ownerUserId: ctx.userId },
          select: { portfolioId: true },
        });
        if (!owned) throw new NotFoundException('Saved comparison not found');
        this.assertScope(owned.portfolioId, scope);
        for (const portfolioId of [
          ...new Set(
            [input.portfolioId, owned.portfolioId].filter((value): value is string => !!value),
          ),
        ].sort())
          await tx.$executeRaw`SELECT id FROM research_portfolios WHERE id=${portfolioId}::uuid AND tenant_id=${ctx.tenantId}::uuid FOR UPDATE`;
        const parent = await this.authorized(tx, ctx, id, false, scope);
        const target = await loadAuthorizedResearchPortfolio(tx, ctx, input.portfolioId, 'viewer');
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${ctx.tenantId + ':' + ctx.userId + ':' + input.idempotencyKey},0))`;
        const replay = await this.replay(tx, ctx, input.idempotencyKey, fingerprint, scope);
        if (replay) {
          const event = await tx.defenseSavedComparisonEvent.findFirst({
            where: {
              tenantId: ctx.tenantId,
              actorUserId: ctx.userId,
              idempotencyKey: input.idempotencyKey,
            },
          });
          const payload = event!.payload as unknown as {
            portfolioRevision: number;
            outcomes: DefenseSavedComparisonSelectionReceiptDto['outcomes'];
          };
          return {
            ...replay,
            portfolioId: input.portfolioId,
            portfolioRevision: payload.portfolioRevision,
            outcomes: payload.outcomes,
          };
        }
        if (parent.archivedAt || parent.revision !== input.expectedRevision)
          throw new ConflictException('Saved comparison revision is stale or archived');
        if (target.lifecycle !== 'active' || !['owner', 'editor'].includes(target.myRole))
          throw new ForbiddenException('An active editable target portfolio is required');
        if (target.revision !== input.expectedPortfolioRevision)
          throw new ConflictException('Research portfolio revision is stale');
        const version = await tx.defenseSavedComparisonVersion.findFirst({
          where: { id: versionId, tenantId: ctx.tenantId, comparisonId: id },
        });
        if (!version) throw new NotFoundException('Saved comparison version not found');
        const capture = this.version(version),
          allowedSubjects = new Set(capture.selection.subjectKeys),
          allowedPassages = new Set(capture.selection.passageIds);
        if (
          input.selection.subjectKeys.some(
            (key) => typeof key !== 'string' || !allowedSubjects.has(key),
          ) ||
          input.selection.passageIds.some(
            (sectionId) => typeof sectionId !== 'string' || !allowedPassages.has(sectionId),
          )
        )
          throw new BadRequestException(
            'Choose only subjects and passages explicitly retained in this saved capture',
          );
        const outcomes: DefenseSavedComparisonSelectionReceiptDto['outcomes'][number][] = [];
        const passageEvidence = new Map(
          capture.capturedProjection.metrics.flatMap((metric) =>
            metric.cells.flatMap((cell) =>
              cell.evidence
                .filter((e) => e.evidenceRefId.startsWith('context-compare:'))
                .map((e) => [e.evidenceRefId.slice('context-compare:'.length), e] as const),
            ),
          ),
        );
        const bookmark = async (targetId: string, label: string, lineage: unknown) => {
          const where = {
            tenantId: ctx.tenantId,
            portfolioId: input.portfolioId,
            userId: ctx.userId,
            targetKind: 'evidence',
            targetId,
          };
          const existing = await tx.researchPortfolioBookmark.findFirst({ where });
          const row =
            existing ??
            (await tx.researchPortfolioBookmark.create({
              data: {
                ...where,
                label: label.slice(0, 255),
                note: JSON.stringify({
                  schemaVersion: 'saved_comparison_bookmark_v1',
                  comparisonId: id,
                  versionId,
                  contentHash: capture.contentHash,
                  captureKnownAt: capture.captureKnownAt,
                  lineage,
                }),
              },
            }));
          outcomes.push({
            kind: 'bookmark',
            targetId,
            id: row.id,
            status: existing ? 'unchanged' : 'created',
          });
        };
        for (const key of input.selection.subjectKeys) {
          const subject = capture.subjects.find(
            (subject) => subject.type + ':' + subject.id === key,
          )!;
          const label =
            capture.capturedProjection.subjects.find((subject) => subject.key === key)?.label ??
            key;
          if (subject.type === 'context_document') {
            await bookmark('saved-comparison:' + id + ':' + versionId + ':subject:' + key, label, {
              subject,
              sourcePins: capture.sourcePins,
            });
            continue;
          }
          const canonical = await readCanonicalResearchTarget(tx, subject.type, subject.id);
          if (!canonical)
            throw new BadRequestException(
              'Selected public subject no longer resolves to a canonical record',
            );
          const existing = await tx.researchPortfolioMember.findUnique({
            where: {
              tenantId_portfolioId_targetKind_targetId: {
                tenantId: ctx.tenantId,
                portfolioId: input.portfolioId,
                targetKind: subject.type,
                targetId: subject.id,
              },
            },
          });
          if (existing && existing.disposition !== 'included')
            throw new ConflictException(
              'A selected member already has a portfolio decision; review that decision before adding it',
            );
          const row =
            existing ??
            (await tx.researchPortfolioMember.create({
              data: {
                tenantId: ctx.tenantId,
                portfolioId: input.portfolioId,
                targetKind: subject.type,
                targetId: subject.id,
                label,
                disposition: 'included',
                createdByUserId: ctx.userId,
                updatedByUserId: ctx.userId,
              },
            }));
          outcomes.push({
            kind: 'member',
            targetId: key,
            id: row.id,
            status: existing ? 'unchanged' : 'created',
          });
        }
        for (const sectionId of input.selection.passageIds) {
          const evidence = passageEvidence.get(sectionId);
          if (!evidence)
            throw new BadRequestException('The selected passage has no exact saved evidence');
          await bookmark(
            'saved-comparison:' + id + ':' + versionId + ':passage:' + sectionId,
            evidence.nativeLocator.section ?? 'Saved source passage',
            evidence,
          );
        }
        const portfolioRevision = target.revision + 1;
        const rpUpdate = await tx.researchPortfolio.updateMany({
          where: {
            id: input.portfolioId,
            tenantId: ctx.tenantId,
            lifecycle: 'active',
            revision: input.expectedPortfolioRevision,
          },
          data: { revision: portfolioRevision },
        });
        if (rpUpdate.count !== 1)
          throw new ConflictException('Research portfolio revision is stale');
        // Portfolio history is visible to other granted viewers. Retain only
        // aggregate counts/digest and public member lineage. Exact saved IDs,
        // personal selections and bookmark IDs remain in owner-only records.
        const publicMemberLineage = outcomes
          .filter((outcome) => outcome.kind === 'member')
          .map((outcome) => ({
            subjectKey: outcome.targetId,
            status: outcome.status,
            evidence: capture.capturedProjection.metrics.flatMap((metric) =>
              metric.cells
                .filter((cell) => cell.subjectKey === outcome.targetId)
                .flatMap((cell) => [...cell.evidence]),
            ),
          }));
        const counts = {
          membersCreated: outcomes.filter(
            (outcome) => outcome.kind === 'member' && outcome.status === 'created',
          ).length,
          membersUnchanged: outcomes.filter(
            (outcome) => outcome.kind === 'member' && outcome.status === 'unchanged',
          ).length,
          personalBookmarksCreated: outcomes.filter(
            (outcome) => outcome.kind === 'bookmark' && outcome.status === 'created',
          ).length,
          personalBookmarksUnchanged: outcomes.filter(
            (outcome) => outcome.kind === 'bookmark' && outcome.status === 'unchanged',
          ).length,
        };
        await tx.researchPortfolioEvent.create({
          data: {
            tenantId: ctx.tenantId,
            portfolioId: input.portfolioId,
            eventKind: 'updated',
            aggregateRevision: portfolioRevision,
            actorUserId: ctx.userId,
            idempotencyKey:
              'saved-selection:' + digest({ actor: ctx.userId, key: input.idempotencyKey }),
            payloadFingerprint: fingerprint,
            payload: json({
              operation: 'saved_comparison_selection',
              selectionDigest: digest({
                contentHash: capture.contentHash,
                selection: input.selection,
              }),
              counts,
              publicMemberLineage,
            }),
          },
        });
        const revision = parent.revision + 1;
        const updated = await tx.defenseSavedComparison.updateMany({
          where: {
            id,
            tenantId: ctx.tenantId,
            ownerUserId: ctx.userId,
            revision: input.expectedRevision,
            ...(scope ? { portfolioId: scope.portfolioId } : {}),
          },
          data: { portfolioId: input.portfolioId, revision },
        });
        if (updated.count !== 1) throw new ConflictException('Saved comparison revision is stale');
        const event = await tx.defenseSavedComparisonEvent.create({
          data: {
            tenantId: ctx.tenantId,
            comparisonId: id,
            versionId,
            actorUserId: ctx.userId,
            aggregateRevision: revision,
            eventKind: 'portfolio_attached',
            idempotencyKey: input.idempotencyKey,
            payloadFingerprint: fingerprint,
            payload: json({
              name: parent.name,
              portfolioId: input.portfolioId,
              revision,
              archivedAt: null,
              portfolioRevision,
              outcomes,
              selection: input.selection,
              contentHash: capture.contentHash,
              captureKnownAt: capture.captureKnownAt,
              sourcePins: capture.sourcePins,
            }),
          },
        });
        return {
          comparison: this.dto({ ...parent, portfolioId: input.portfolioId, revision }, version),
          eventId: event.id,
          resultingRevision: revision,
          replayed: false,
          portfolioId: input.portfolioId,
          portfolioRevision,
          outcomes,
        };
      },
      { timeoutMs: 20000 },
    );
  }
}
