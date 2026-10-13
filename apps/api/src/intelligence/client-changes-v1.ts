import type { PrismaService } from '../prisma/prisma.service.js';

export class ClientChangesV1 {
  constructor(private readonly prisma: PrismaService) {}

  async getChanges(
    tenantId: string,
    since?: string,
    clientId?: string,
    source?: string,
    consumed?: boolean,
    peCodes?: string[],
  ) {
    const tenantClientIds = await this.prisma.withTenant(tenantId, (tx) =>
      tx.client.findMany({ where: { status: { not: 'archived' } }, select: { id: true } }),
    );
    const ids = tenantClientIds.map((c) => c.id);

    // Validate the optional clientId query param is one of this tenant's clients.
    if (clientId && !ids.includes(clientId)) {
      return [];
    }

    const where: Record<string, unknown> = {};
    if (since) where.detectedAt = { gte: new Date(since) };
    if (source) where.source = source;
    // Optional read/unread filter. The Changes Inbox passes consumed=false so a
    // change a user has cleared stays cleared across reloads (true inbox
    // semantics). Dashboard surfaces (Needs Attention, greeting count) omit the
    // param and still receive every change.
    if (typeof consumed === 'boolean') where.consumed = consumed;
    // PE Watchlist signal feed: scope to changes touching a set of Program
    // Element codes. related_pe_codes is populated by the PE delta/writer emitters
    // and the bill↔PE extractor, and is GIN-indexed, so hasSome is index-supported.
    if (peCodes && peCodes.length > 0) where.relatedPeCodes = { hasSome: peCodes };

    if (clientId) {
      where.relatedClientIds = { has: clientId };
    } else {
      // Either touches one of this tenant's clients, or is tenant-neutral
      // (no related clients at all = general market signal).
      where.OR = [{ relatedClientIds: { hasSome: ids } }, { relatedClientIds: { isEmpty: true } }];
    }

    return this.prisma.intelligenceChange.findMany({
      where,
      orderBy: { detectedAt: 'desc' },
      take: 50,
    });
  }

  async markChangeConsumed(id: string, consumed: boolean) {
    return this.prisma.intelligenceChange.update({
      where: { id },
      data: { consumed },
    });
  }

  async getUnreadChangesCount() {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const count = await this.prisma.intelligenceChange.count({
      where: { consumed: false, detectedAt: { gte: sevenDaysAgo } },
    });
    return { count };
  }
}
