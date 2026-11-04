import {
  canonicalIdentityCandidates,
  mergeIdentityCandidate,
  type DisplayIdentity,
} from './profile-identity-match.js';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service.js';
import { UniversalEntityResolutionService } from '../knowledge/entities/universal-entity-resolution.service.js';
import { CanonicalEntityRegistrationService } from '../knowledge/entities/canonical-entity-registration.service.js';
import type { CanonicalEntityRecord } from '../knowledge/entities/entity-resolution.types.js';
import { requireOwnerActor } from './client-ordered-owner.access.js';
import { requireProfileSubject } from './profile-subject.js';
import { ProfileIdentitySourcesService } from './profile-identity-sources.service.js';
import { ProfileIdentityClaimsService } from './profile-identity-claims.service.js';
import {
  identityClaimSchema,
  identitySourceCandidateSchema,
  parseIdentityPreview,
  identityName,
  type DiscoveredProfileIdentity,
  type ProfileIdentityInput,
  type ProfileIdentitySourceCandidate,
} from './profile-identity.contracts.js';
import { reviewHash } from './client-profile-fill-review-snapshot.js';
import {
  readIdentityUpload,
  readIdentityUploadInTransaction,
  sameIdentityUpload,
} from '../engagement/attachments/profile-identity-upload.js';

const confirmationSchema = z
  .object({
    requestId: z.string().uuid(),
    sourceCandidate: identitySourceCandidateSchema,
    claims: z.array(identityClaimSchema).max(12).optional(),
  })
  .strict();
@Injectable()
export class ProfileIdentityDiscoveryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly resolver: UniversalEntityResolutionService,
    private readonly registration: CanonicalEntityRegistrationService,
    private readonly sources: ProfileIdentitySourcesService,
    private readonly claims: ProfileIdentityClaimsService,
  ) {}
  private access(ctx: TenantContext) {
    return this.prisma.withTenantUser(ctx.tenantId, ctx.userId, (tx) => requireOwnerActor(tx, ctx));
  }

  async preview(ctx: TenantContext, raw: unknown, signal?: AbortSignal) {
    const input = parseIdentityPreview(raw);
    await this.access(ctx);
    const identifiers = [
      ...(input.identifiers ?? []),
      ...(input.website ? [{ type: 'domain', value: new URL(input.website).hostname }] : []),
    ];
    const [canonical, acquired] = await Promise.all([
      input.name || identifiers.length
        ? this.resolver.preview(ctx.tenantId, {
            query: input.name,
            entityTypeHint: 'organization',
            identifiers,
            maxCandidates: 4,
            actorUserId: ctx.userId,
          })
        : Promise.resolve({
            status: 'unresolved',
            entity: null,
            confidence: 0,
            candidates: [],
            provenance: [],
            resolutionMethod: 'document_identity_pending',
            requiresUserConfirmation: true,
          }),
      this.sources.discover(ctx, input, signal),
    ]);
    const candidates = canonicalIdentityCandidates(canonical.candidates, input);
    await this.addSourceCandidates(ctx, input, candidates, acquired.candidates);
    candidates.sort((a, b) => b.confidence - a.confidence);
    const shown = candidates.slice(0, 4),
      conflict =
        canonical.status === 'ambiguous' &&
        [
          'conflicting_identifiers',
          'multiple_authoritative_identifiers',
          'cross_scope_conflict',
        ].includes(canonical.resolutionMethod),
      confident = conflict ? [] : shown.filter((candidate) => candidate.confidence >= 0.95);
    await this.access(ctx);
    signal?.throwIfAborted();
    const chosen = confident.length === 1 ? confident[0] : shown.length === 1 ? shown[0] : null;
    const duplicate = await this.duplicate(ctx, chosen?.entity.id ? [chosen.entity.id] : []);
    return {
      status: duplicate
        ? 'duplicate'
        : confident.length === 1
          ? 'exact'
          : shown.length
            ? 'ambiguous'
            : 'none',
      entity: confident.length === 1 ? confident[0]!.entity : null,
      confidence: shown[0]?.confidence ?? 0,
      resolutionMethod: canonical.resolutionMethod,
      candidates: shown,
      provenance: shown.flatMap((candidate) => candidate.provenance),
      requiresUserConfirmation: true,
      duplicate,
      sourceGaps: conflict
        ? [
            ...acquired.sourceGaps,
            'The supplied identifiers conflict; choose the intended company explicitly.',
          ]
        : acquired.sourceGaps,
    };
  }

  private async addSourceCandidates(
    ctx: TenantContext,
    input: ProfileIdentityInput,
    candidates: DisplayIdentity[],
    acquired: DiscoveredProfileIdentity[],
  ) {
    for (const item of acquired) {
      const identifiers = item.identifiers.length
        ? item.identifiers
        : item.sourceCandidate.website
          ? [{ type: 'domain', value: new URL(item.sourceCandidate.website).hostname }]
          : [];
      const known = await this.resolver.preview(ctx.tenantId, {
        query: identifiers.length ? '' : item.sourceCandidate.name,
        entityTypeHint: 'organization',
        identifiers,
        actorUserId: ctx.userId,
        maxCandidates: 4,
      });
      for (const candidate of canonicalIdentityCandidates(known.candidates, input))
        if (!candidates.some((existing) => existing.entity.id === candidate.entity.id))
          candidates.push(candidate);
      const entity =
        identifiers.length &&
        known.status === 'resolved' &&
        known.entity &&
        (item.identifiers.length ||
          identityName(known.entity.canonicalName) === identityName(item.sourceCandidate.name))
          ? known.entity
          : null;
      mergeIdentityCandidate(candidates, input, item, entity);
    }
  }

  private duplicate(ctx: TenantContext, ids: string[]) {
    return this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      await requireOwnerActor(tx, ctx);
      if (!ids.length) return null;
      const client = await tx.client.findFirst({
        where: {
          tenantId: ctx.tenantId,
          canonicalEntityId: { in: ids },
          OR: [{ memoryWall: false }, { memoryAccessGrants: { some: { userId: ctx.userId } } }],
        },
        select: { id: true, name: true },
      });
      if (client) {
        await requireProfileSubject(tx, ctx, { kind: 'client', id: client.id });
        return { kind: 'client', ...client };
      }
      const prospects = await tx.businessDevelopmentProspect.findMany({
        where: { tenantId: ctx.tenantId, canonicalEntityId: { in: ids }, convertedAt: null },
        take: 4,
        select: { id: true, displayName: true },
      });
      for (const prospect of prospects)
        try {
          await requireProfileSubject(tx, ctx, { kind: 'prospect', id: prospect.id });
          return { kind: 'prospect', id: prospect.id, name: prospect.displayName };
        } catch (error) {
          if (!(error instanceof NotFoundException)) throw error;
        }
      return null;
    });
  }

  /** Explicit unsaved selection is resolved before the existing client/prospect create command. */
  async confirm(ctx: TenantContext, raw: unknown, signal?: AbortSignal) {
    const parsed = confirmationSchema.safeParse(raw);
    if (!parsed.success) throw new BadRequestException('Invalid identity source confirmation');
    const input = parsed.data,
      digest = reviewHash(input);
    await this.access(ctx);
    const replay = await this.receipt(ctx, input.requestId, digest);
    if (replay) return replay;
    const attachmentIds = [
      ...new Set([
        ...(input.sourceCandidate.source === 'document' ? [input.sourceCandidate.externalId] : []),
        ...(input.claims ?? []).flatMap((claim) =>
          claim.attachmentId ? [claim.attachmentId] : [],
        ),
      ]),
    ];
    const originalSources = await Promise.all(
      attachmentIds.map((id) => readIdentityUpload(this.prisma, ctx, id)),
    );
    const current = await this.sources.refresh(ctx, input.sourceCandidate, signal);
    const claims = await this.sources.validateClaims(ctx, current, input.claims ?? [], signal);
    await this.access(ctx);
    signal?.throwIfAborted();
    return this.prisma.withTenantUser(
      ctx.tenantId,
      ctx.userId,
      async (tx) => {
        await requireOwnerActor(tx, ctx, false, true);
        await tx.$executeRawUnsafe(
          'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
          `${ctx.tenantId}:identity-confirm:${input.requestId}`,
        );
        const prior = await tx.auditLog.findFirst({
          where: { id: input.requestId, tenantId: ctx.tenantId },
        });
        if (prior) return this.validReceipt(prior, ctx, digest);
        signal?.throwIfAborted();
        for (const [index, id] of attachmentIds.entries()) {
          const currentSource = await readIdentityUploadInTransaction(tx, ctx, id, { lock: true });
          sameIdentityUpload(originalSources[index]!, currentSource);
        }
        const entity = await this.register(ctx, current);
        await this.claims.retain(ctx, entity.id, claims);
        const result = {
          requestId: input.requestId,
          canonicalEntityId: entity.id,
          sourceCandidate: input.sourceCandidate,
        };
        await tx.auditLog.create({
          data: {
            id: input.requestId,
            tenantId: ctx.tenantId,
            actorUserId: ctx.userId,
            action: 'profile.identity_confirm',
            entityType: 'canonical_entity',
            entityId: entity.id,
            after: { digest, result },
          },
        });
        return result;
      },
      { timeoutMs: 30000 },
    );
  }

  private async register(
    ctx: TenantContext,
    candidate: DiscoveredProfileIdentity,
  ): Promise<CanonicalEntityRecord> {
    const common = {
      actorUserId: ctx.userId,
      entityType: 'organization',
      canonicalName: candidate.sourceCandidate.name,
      metadata: {
        identitySource: candidate.sourceCandidate.source,
        sourceEvidence: candidate.evidence.filter((evidence) => !evidence.attachmentId),
      },
      resolutionConfidence: 1,
    };
    if (['sam_entity', 'lda_client', 'sec_filing'].includes(candidate.sourceType))
      return this.registration.registerGlobalPublicEntity({
        ...common,
        resolutionMethod: candidate.sourceType,
        identifiers: candidate.identifiers.map((id) => ({
          ...id,
          sourceType: candidate.sourceType,
          sourceId: candidate.sourceCandidate.externalId,
          verifiedAt: new Date(),
          confidence: 1,
        })),
      });
    const identifiers = candidate.sourceCandidate.website
      ? [{ type: 'domain', value: new URL(candidate.sourceCandidate.website).hostname }]
      : [
          {
            type: 'profile_source_record',
            value: `${candidate.sourceCandidate.externalId}#${identityName(candidate.sourceCandidate.name)}`,
          },
        ];
    const existing = await this.resolver.preview(ctx.tenantId, {
      query: candidate.sourceCandidate.name,
      entityTypeHint: 'organization',
      identifiers,
      actorUserId: ctx.userId,
    });
    if (existing.candidates.length) {
      const exact =
        existing.status === 'resolved' &&
        existing.entity &&
        identityName(existing.entity.canonicalName) ===
          identityName(candidate.sourceCandidate.name) &&
        existing.candidates.some(
          (row) =>
            row.entity.id === existing.entity!.id && row.resolutionMethod === 'identifier_exact',
        );
      if (exact && existing.entity) return existing.entity;
      throw new ConflictException(
        'This source overlaps another known identity; choose and confirm the intended existing company',
      );
    }
    return this.resolver.registerTenantPrivateEntity(ctx.tenantId, {
      ...common,
      resolutionMethod: candidate.sourceType,
      identifiers: identifiers.map((identifier) => ({
        ...identifier,
        sourceType: candidate.sourceType,
        sourceId: candidate.sourceCandidate.externalId.slice(0, 512),
        confidence: 1,
        verifiedAt: null,
      })),
    });
  }
  private async receipt(ctx: TenantContext, id: string, digest: string) {
    return this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      await requireOwnerActor(tx, ctx);
      const row = await tx.auditLog.findFirst({ where: { id, tenantId: ctx.tenantId } });
      return row ? this.validReceipt(row, ctx, digest) : null;
    });
  }
  private validReceipt(
    row: { actorUserId: string | null; action: string; after: unknown },
    ctx: TenantContext,
    digest: string,
  ) {
    const after = row.after as {
      digest?: string;
      result?: {
        requestId: string;
        canonicalEntityId: string;
        sourceCandidate: ProfileIdentitySourceCandidate;
      };
    } | null;
    if (
      row.actorUserId !== ctx.userId ||
      row.action !== 'profile.identity_confirm' ||
      after?.digest !== digest ||
      !after.result
    )
      throw new ConflictException('Request ID belongs to another identity command');
    return after.result;
  }
}
