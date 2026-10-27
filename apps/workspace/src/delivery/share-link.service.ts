import { releaseVersion } from './release-version.js';
import { isHeldDraftClientAssociation } from '../drafts/draft-client-access.js';
import { denyProspectTransfer } from '../prospect-resources/prospect-draft-access.js';
// Share Link Service — manages secure share links.
// Stores ONLY the hash of the token. Tokens are returned once.
// Share links have expiration and revocation.

import {
  HttpException,
  HttpStatus,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { CollaboratorsService } from '../collaborators/collaborators.service.js';
import { canRead, canManageCollaborators } from '../collaborators/role-policy.js';
import {
  WorkspaceShareLifecycle,
  ShareOperationConflict,
  hashWorkspaceShareToken,
  type WorkspaceSharePersistence,
  type WorkspaceShareRecord,
} from '@capiro/shared/workspace-share-lifecycle';
import {
  projectSharedWorkspaceDocument,
  type SharedWorkspaceDocument,
} from './share-document-projection.js';
import type { WsShareLink, Prisma } from '../../generated/prisma-client/index.js';

type DocumentShareRow = WsShareLink & WorkspaceShareRecord & { draftId: string };

@Injectable()
export class ShareLinkService {
  /** Rate limit: max 10 comments per 5 minutes per token. */
  private readonly rateLimitMap = new Map<string, number[]>();
  private readonly RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
  private readonly RATE_LIMIT_MAX = 10;

  constructor(
    private readonly prisma: PrismaService,
    private readonly collaborators: CollaboratorsService,
  ) {}

  /**
   * Look up a live (non-revoked, non-expired) share link by token via a
   * timing-safe comparison. Shared by the public read path and the guest-
   * comment write path so both enforce the same revocation/expiry rules.
   */
  private lifecycle(prisma: Pick<Prisma.TransactionClient, 'wsShareLink'> = this.prisma) {
    return new WorkspaceShareLifecycle(
      prisma.wsShareLink as unknown as WorkspaceSharePersistence<DocumentShareRow>,
      'workspace_document',
    );
  }

  private async findLiveLinkByToken(token: string): Promise<DocumentShareRow> {
    const lifecycle = this.lifecycle();
    const link = await lifecycle.byToken(token);
    if (!link || !lifecycle.isLive(link) || !link.draftId)
      throw new NotFoundException('Share link not found, expired or revoked');
    const origin = await this.prisma.wsDraft.findFirst({
      where: { id: link.draftId, tenantId: link.tenantId },
      select: { prospectId: true },
    });
    if (!origin || origin.prospectId) throw new NotFoundException('Share link not found');
    // A grant is revoked when its issuing actor loses current source access.
    // It never falls back to an authenticated tenant-only read.
    await this.collaborators.assertCan(
      link.tenantId,
      link.draftId,
      link.createdById,
      canManageCollaborators,
    );
    await releaseVersion(this.prisma, link.tenantId, link.draftId, link.versionId, false);
    return link;
  }

  /**
   * Create a share link. Returns the token ONCE; only the hash is stored.
   */
  async createShareLink(
    tenantId: string,
    draftId: string,
    createdById: string,
    params: { label?: string; expiresInDays?: number; versionId?: string; idempotencyKey?: string },
  ): Promise<{ shareId: string; token: string; expiresAt: string | null }> {
    if (
      params.idempotencyKey !== undefined &&
      (!params.idempotencyKey || params.idempotencyKey.length > 128)
    )
      throw new ConflictException('Share operation key must contain 1 to 128 characters');
    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM ws_draft WHERE tenant_id = ${tenantId}::uuid AND id = ${draftId}::uuid FOR UPDATE`;
        denyProspectTransfer(
          await tx.wsDraft.findFirst({
            where: { tenantId, id: draftId },
            select: { prospectId: true },
          }),
        );
        await this.collaborators.assertCan(tenantId, draftId, createdById, canManageCollaborators);
        const { version } = await releaseVersion(tx, tenantId, draftId, params.versionId);
        const lifecycle = this.lifecycle(tx);
        // A historical display label may have been used as a key by the old API.
        // Its request cannot be reconstructed safely. Never create a duplicate or
        // reinterpret a human label as authority to replay a different revision.
        if (params.idempotencyKey) {
          const legacy = await lifecycle.findMany({
            where: { tenantId, draftId, operationKey: null, requestHash: null },
          });
          if (
            legacy.some(
              (row) => row.versionId === version.id || row.label === params.idempotencyKey,
            )
          )
            throw new ConflictException(
              'This operation may refer to a legacy share. Reconcile the existing share or save and review a new revision',
            );
        }
        const payload = projectSharedWorkspaceDocument(version.snapshot);
        const result = await lifecycle.publish({
          tenantId,
          resourceId: draftId,
          createdById,
          operationKey: params.idempotencyKey,
          request: {
            versionId: version.id,
            label: params.label ?? null,
            expiresInDays: params.expiresInDays ?? null,
          },
          payload,
          expiresInDays: params.expiresInDays,
          data: { draftId, versionId: version.id, label: params.label ?? null },
        });
        return {
          shareId: result.row.id,
          token: result.token ?? '',
          expiresAt: result.row.expiresAt?.toISOString() ?? null,
        };
      });
    } catch (error) {
      if (error instanceof ShareOperationConflict || error instanceof RangeError)
        throw new ConflictException(error.message);
      throw error;
    }
  }

  /**
   * Revoke a share link.
   */
  async revoke(
    tenantId: string,
    draftId: string,
    shareLinkId: string,
    actorId: string,
  ): Promise<void> {
    denyProspectTransfer(
      await this.prisma.wsDraft.findFirst({
        where: { tenantId: tenantId, id: draftId },
        select: { prospectId: true },
      }),
    );

    await this.collaborators.assertCan(tenantId, draftId, actorId, canManageCollaborators);
    const link = await this.lifecycle().findFirst({
      where: { id: shareLinkId, tenantId, draftId },
    });
    if (!link) throw new NotFoundException('Share link not found');
    await this.lifecycle().revoke(link);
  }

  /**
   * Look up a share link by token. Returns the link + sanitized payload.
   * 404 if not found, expired, or revoked.
   */
  async getByToken(token: string): Promise<{
    draftId: string;
    versionId: string | null;
    docTitle: string;
    sections: Array<{ id: string; title: string; content: string }>;
  }> {
    const link = await this.findLiveLinkByToken(token);

    // New rows store the exact safe projection. Older links are projected in full
    // from their pinned revision; unsupported historical shapes fail closed.
    let payload: SharedWorkspaceDocument;
    if (
      link.payload &&
      (link.payload as unknown as SharedWorkspaceDocument).kind === 'workspace_document'
    ) {
      payload = link.payload as unknown as SharedWorkspaceDocument;
    } else {
      const { version } = await releaseVersion(
        this.prisma,
        link.tenantId,
        link.draftId,
        link.versionId,
        false,
      );
      payload = projectSharedWorkspaceDocument(version.snapshot);
    }
    return {
      draftId: '',
      versionId: link.versionId,
      docTitle: payload.docTitle,
      sections: payload.sections,
    };
  }

  /**
   * Check the rate limit for a guest comment. Returns true if allowed.
   */
  checkRateLimit(tokenHash: string): boolean {
    const now = Date.now();
    const timestamps = this.rateLimitMap.get(tokenHash) ?? [];
    const recent = timestamps.filter((t) => now - t < this.RATE_LIMIT_WINDOW_MS);
    if (recent.length >= this.RATE_LIMIT_MAX) {
      this.rateLimitMap.set(tokenHash, recent);
      return false;
    }
    recent.push(now);
    this.rateLimitMap.set(tokenHash, recent);
    return true;
  }

  /**
   * Persist a guest comment left on a public share link. Previously this was a
   * pure echo — `{ ok: true, text }` with no durable write — invisible to the
   * internal team. Real 429 (not a 200 with an `error` field) when rate-limited.
   */
  async addGuestComment(token: string, text: string, name?: string): Promise<{ ok: true }> {
    const link = await this.findLiveLinkByToken(token);
    const tokenHash = this.hashToken(token);
    if (!this.checkRateLimit(tokenHash)) {
      throw new HttpException(
        'Rate limit exceeded. Please try again later.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const body = this.sanitize(text);
    const guestName = name ? this.sanitize(name) : null;
    await this.prisma.wsGuestComment.create({
      data: {
        tenantId: link.tenantId,
        draftId: link.draftId,
        shareLinkId: link.id,
        body,
        guestName,
      },
    });
    return { ok: true };
  }

  /**
   * List guest comments for the internal team (authenticated, tenant + role
   * scoped) — the whole point of persisting them durably.
   */
  async listGuestComments(tenantId: string, draftId: string, actorId: string) {
    await this.collaborators.assertCan(
      tenantId,
      draftId,
      actorId,
      canRead,
      'You do not have permission to access this document',
    );
    return this.prisma.wsGuestComment.findMany({
      where: { tenantId, draftId },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * List all share links across all drafts in the tenant (tenant-wide index
   * for the /workspace/shares page). Returns non-revoked links with the
   * associated draft title and guest-comment count.
   */
  async listShares(
    tenantId: string,
    actorId: string,
  ): Promise<{
    shares: Array<{
      id: string;
      draftId: string;
      draftTitle: string;
      label: string | null;
      createdAt: string;
      expiresAt: string | null;
      guestCommentCount: number;
    }>;
  }> {
    const links = await this.lifecycle().findMany({
      where: { tenantId, revokedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    if (links.length === 0) return { shares: [] };

    const draftIds = [...new Set(links.map((l) => l.draftId))];
    const drafts = await this.prisma.wsDraft.findMany({
      where: { prospectId: null, id: { in: draftIds }, tenantId },
      select: {
        id: true,
        docTitle: true,
        clientId: true,
        client: true,
        config: true,
        prospectId: true,
      },
    });
    const draftMap = new Map<string, string>();
    for (const draft of drafts) {
      if (isHeldDraftClientAssociation(draft)) continue;
      const role = await this.collaborators.resolveRole(tenantId, draft.id, actorId);
      if (canRead(role)) draftMap.set(draft.id, draft.docTitle);
    }

    const commentCounts = await this.prisma.wsGuestComment.groupBy({
      by: ['shareLinkId'],
      where: {
        tenantId,
        shareLinkId: { in: links.filter((l) => draftMap.has(l.draftId)).map((l) => l.id) },
      },
      _count: { _all: true },
    });
    const commentMap = new Map(commentCounts.map((c) => [c.shareLinkId, c._count._all]));

    return {
      shares: links
        .filter((link) => draftMap.has(link.draftId))
        .map((link) => ({
          id: link.id,
          draftId: link.draftId,
          draftTitle: draftMap.get(link.draftId) ?? 'Untitled',
          label: link.label,
          createdAt: link.createdAt.toISOString(),
          expiresAt: link.expiresAt?.toISOString() ?? null,
          guestCommentCount: commentMap.get(link.id) ?? 0,
        })),
    };
  }

  /**
   * Sanitize text: strip HTML, max 2000 chars.
   */
  sanitize(text: string): string {
    return text
      .replace(/<[^>]*>/g, '')
      .slice(0, 2000)
      .trim();
  }

  /**
   * Hash a token using sha256.
   */
  hashToken(token: string): string {
    return hashWorkspaceShareToken(token);
  }
}
