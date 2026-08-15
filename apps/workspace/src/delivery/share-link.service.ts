// Share Link Service — manages secure share links.
// Stores ONLY the hash of the token. Tokens are returned once.
// Share links have expiration and revocation.

import {
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { CollaboratorsService } from '../collaborators/collaborators.service.js';
import { canRead } from '../collaborators/role-policy.js';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import type { WsShareLink } from '../../generated/prisma-client/index.js';

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
  private async findLiveLinkByToken(token: string): Promise<WsShareLink> {
    const tokenHash = this.hashToken(token);
    const links = await this.prisma.wsShareLink.findMany({ where: { tokenHash } });

    let link: WsShareLink | undefined;
    for (const l of links) {
      if (l.tokenHash.length === tokenHash.length) {
        const a = Buffer.from(l.tokenHash, 'hex');
        const b = Buffer.from(tokenHash, 'hex');
        if (timingSafeEqual(a, b)) {
          link = l;
          break;
        }
      }
    }
    if (!link) throw new NotFoundException('Share link not found');
    if (link.revokedAt) throw new NotFoundException('Share link has been revoked');
    if (link.expiresAt && link.expiresAt.getTime() < Date.now()) {
      throw new NotFoundException('Share link has expired');
    }
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
    // Idempotency check.
    if (params.idempotencyKey) {
      const existing = await this.prisma.wsShareLink.findFirst({
        where: { tenantId, draftId, label: params.idempotencyKey },
      });
      if (existing) {
        return { shareId: existing.id, token: '', expiresAt: existing.expiresAt?.toISOString() ?? null };
      }
    }

    const token = randomBytes(32).toString('hex');
    const tokenHash = this.hashToken(token);
    const expiresAt = params.expiresInDays
      ? new Date(Date.now() + params.expiresInDays * 24 * 60 * 60 * 1000)
      : null;

    const link = await this.prisma.wsShareLink.create({
      data: {
        tenantId,
        draftId,
        createdById,
        tokenHash,
        versionId: params.versionId,
        label: params.label ?? params.idempotencyKey,
        expiresAt,
      },
    });

    return { shareId: link.id, token, expiresAt: expiresAt?.toISOString() ?? null };
  }

  /**
   * Revoke a share link.
   */
  async revoke(tenantId: string, draftId: string, shareLinkId: string): Promise<void> {
    const link = await this.prisma.wsShareLink.findFirst({
      where: { id: shareLinkId, tenantId, draftId },
    });
    if (!link) throw new NotFoundException('Share link not found');
    await this.prisma.wsShareLink.update({
      where: { id: shareLinkId },
      data: { revokedAt: new Date() },
    });
  }

  /**
   * Look up a share link by token. Returns the link + sanitized payload.
   * 404 if not found, expired, or revoked.
   */
  async getByToken(
    token: string,
  ): Promise<{
    draftId: string;
    versionId: string | null;
    docTitle: string;
    sections: Array<{ id: string; title: string; content: string }>;
  }> {
    const link = await this.findLiveLinkByToken(token);

    // Load the draft and sanitize the payload.
    const draft = await this.prisma.wsDraft.findFirst({
      where: { id: link.draftId },
    });
    if (!draft) throw new NotFoundException('Document not found');

    // A share link pinned to a version must ALWAYS serve that frozen snapshot,
    // never the live (possibly since-edited) draft — otherwise editing the draft
    // after sharing silently changes what a client already viewing the link sees.
    let config: Record<string, unknown>;
    let docTitle: string;
    if (link.versionId) {
      const version = await this.prisma.wsDocVersion.findFirst({
        where: { id: link.versionId, tenantId: link.tenantId, draftId: link.draftId },
      });
      if (!version) throw new NotFoundException('Share link is pinned to a version that no longer exists');
      const snapshot = (version.snapshot as { docTitle?: string; config?: unknown }) ?? {};
      config = (snapshot.config as Record<string, unknown>) ?? {};
      docTitle = snapshot.docTitle ?? draft.docTitle;
    } else {
      config = (draft.config as Record<string, unknown>) ?? {};
      docTitle = draft.docTitle;
    }
    const sections = (config.sections as string[]) ?? [];
    const sectionContent = (config.sectionContent as Record<string, string>) ?? {};

    // Sanitized: no tenantId, no internal context, no private source text, no model prompts.
    return {
      draftId: '', // no tenantId leak
      versionId: link.versionId,
      docTitle,
      sections: sections.map((id) => ({
        id,
        title: id,
        content: this.sanitize(sectionContent[id] ?? ''),
      })),
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
  async addGuestComment(
    token: string,
    text: string,
    name?: string,
  ): Promise<{ ok: true }> {
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
    return createHash('sha256').update(token, 'utf8').digest('hex');
  }
}
