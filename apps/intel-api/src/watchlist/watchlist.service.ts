import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { WatchlistMatcherService, type WatchTerm } from './watchlist-matcher.service.js';

export interface CreateWatchlistData {
  clientId: string;
  name: string;
  terms?: Array<{ termType: string; value: string; weight?: number }>;
}

/**
 * Watchlist lifecycle + the persistence side of matching. Tenant-scoped on every
 * query. The matcher itself is pure (WatchlistMatcherService); this service
 * loads a tenant's active terms, runs the matcher on a segment, and persists
 * WatchlistMatch rows the alert layer consumes.
 */
@Injectable()
export class WatchlistService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly matcher: WatchlistMatcherService,
  ) {}

  async create(tenantId: string, userId: string, data: CreateWatchlistData) {
    return this.prisma.withTenant(tenantId, (tx) =>
      tx.watchlist.create({
        data: {
          tenantId,
          clientId: data.clientId,
          name: data.name,
          createdBy: userId,
          terms: data.terms
            ? {
                create: data.terms.map((t) => ({
                  tenantId,
                  termType: t.termType,
                  value: t.value,
                  weight: t.weight ?? 1,
                })),
              }
            : undefined,
        },
        include: { terms: true },
      }),
    );
  }

  async list(tenantId: string, clientId?: string) {
    return this.prisma.withTenant(tenantId, (tx) =>
      tx.watchlist.findMany({
        where: { tenantId, ...(clientId ? { clientId } : {}) },
        include: { terms: true },
        orderBy: { createdAt: 'desc' },
      }),
    );
  }

  async get(tenantId: string, id: string) {
    const wl = await this.prisma.withTenant(tenantId, (tx) =>
      tx.watchlist.findFirst({ where: { id, tenantId }, include: { terms: true } }),
    );
    if (!wl) throw new NotFoundException('Watchlist not found');
    return wl;
  }

  async addTerm(
    tenantId: string,
    watchlistId: string,
    term: { termType: string; value: string; weight?: number },
  ) {
    await this.get(tenantId, watchlistId);
    return this.prisma.withTenant(tenantId, (tx) =>
      tx.watchlistTerm.create({
        data: {
          tenantId,
          watchlistId,
          termType: term.termType,
          value: term.value,
          weight: term.weight ?? 1,
        },
      }),
    );
  }

  async removeTerm(tenantId: string, termId: string) {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const term = await tx.watchlistTerm.findFirst({ where: { id: termId, tenantId } });
      if (!term) throw new NotFoundException('Term not found');
      await tx.watchlistTerm.delete({ where: { id: termId } });
      return { removed: termId };
    });
  }

  async setActive(tenantId: string, id: string, active: boolean) {
    await this.get(tenantId, id);
    return this.prisma.withTenant(tenantId, (tx) =>
      tx.watchlist.update({ where: { id }, data: { active } }),
    );
  }

  /** Load all active watchlist terms for a tenant (optionally one client). */
  async loadActiveTerms(tenantId: string, clientId?: string): Promise<WatchTerm[]> {
    const lists = await this.prisma.withTenant(tenantId, (tx) =>
      tx.watchlist.findMany({
        where: { tenantId, active: true, ...(clientId ? { clientId } : {}) },
        include: { terms: true },
      }),
    );
    const out: WatchTerm[] = [];
    for (const wl of lists) {
      for (const t of wl.terms) {
        out.push({
          id: t.id,
          watchlistId: wl.id,
          clientId: wl.clientId,
          termType: t.termType,
          value: t.value,
          weight: t.weight,
        });
      }
    }
    return out;
  }

  /**
   * Match a finalized segment against the tenant's active watchlists and persist
   * the matches. Returns the persisted match count. Called by the live pipeline.
   */
  async matchAndPersist(params: {
    tenantId: string;
    sessionId: string;
    segmentId: string;
    text: string;
    clientId?: string;
  }): Promise<number> {
    const terms = await this.loadActiveTerms(params.tenantId, params.clientId);
    if (terms.length === 0) return 0;
    const matches = this.matcher.match(params.text, terms);
    if (matches.length === 0) return 0;

    await this.prisma.withTenant(params.tenantId, (tx) =>
      tx.watchlistMatch.createMany({
        data: matches.map((m) => ({
          tenantId: params.tenantId,
          sessionId: params.sessionId,
          segmentId: params.segmentId,
          clientId: m.clientId,
          watchlistId: m.watchlistId,
          termId: m.termId,
          termType: m.termType,
          termValue: m.termValue,
          score: m.score,
          startMs: 0,
        })),
      }),
    );
    return matches.length;
  }

  /** Keyterms for Deepgram prompting (H1 leftover): the literal term strings. */
  async keytermsFor(tenantId: string, clientId?: string): Promise<string[]> {
    const terms = await this.loadActiveTerms(tenantId, clientId);
    return Array.from(new Set(terms.map((t) => t.value).filter(Boolean)));
  }
}
