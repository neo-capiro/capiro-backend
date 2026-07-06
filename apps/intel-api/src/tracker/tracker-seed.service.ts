import { Injectable } from '@nestjs/common';
import { issueAreaForSector, normalizeIssueArea } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { SourceDataRepository } from '../sourcedata/source-data.repository.js';

/**
 * Watchlist seed-suggestions from the client profile (P1.1, ported from
 * apps/api tracker.service.getSeedSuggestions). Lives in its own service (not
 * TrackerWatchlistService) because it needs SourceDataRepository and the task
 * runner constructs TrackerWatchlistService directly with prisma only.
 *
 * Returns the LEGACY `{ tags, issueAreas }` shape — the web Configure panel
 * consumes it directly with no adapter.
 */
export interface SeedWatchlistTag {
  tag: string;
  issueArea?: string | null;
  synonyms: string[];
  relatedEntities: string[];
  riskTerms: string[];
  /** Typed terms (P5) — empty for a profile-seeded tag; kept for shape parity. */
  typedTerms: Array<{ termType: string; value: string }>;
  position: 'support' | 'oppose' | 'monitor';
  priority: 'low' | 'med' | 'high';
}
export interface SeedSuggestions {
  tags: SeedWatchlistTag[];
  issueAreas: string[];
}

@Injectable()
export class TrackerSeedService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: SourceDataRepository,
  ) {}

  /**
   * Suggestions to seed an empty (or partial) watchlist FROM the client
   * profile: the client's capability tags become watchlist tag rows (Med /
   * Monitor), and the client's sector (+ each capability's sector) maps to
   * issue areas. Dedup is against the UNIFIED watchlist (`wl:<clientId>` topic
   * labels + issue areas) so re-importing is a no-op, and the legacy
   * sector-default carryover is reproduced: with NO watchlist row, the
   * sector-derived issue area counts as default-selected (so it is not
   * re-suggested — same observable behavior as legacy getWatchlist + seed).
   * `clients`/`client_capabilities` are read-only tenant-scoped reads (D2).
   */
  async getSeedSuggestions(tenantId: string, clientId: string): Promise<SeedSuggestions> {
    const wlId = `wl:${clientId}`;
    const [wl, client, caps] = await Promise.all([
      this.prisma.withTenant(tenantId, (tx) =>
        tx.watchlist.findFirst({ where: { id: wlId, tenantId }, select: { issueAreas: true } }),
      ),
      this.repo.getClientProfile(tenantId, clientId),
      this.repo.getClientCapabilities(tenantId, clientId),
    ]);
    const topics = wl
      ? await this.prisma.withTenant(tenantId, (tx) =>
          tx.watchlistTopic.findMany({
            where: { watchlistId: wlId, tenantId },
            select: { label: true },
          }),
        )
      : [];

    const clientArea = issueAreaForSector(client?.sectorTag);
    // A capability tag already present as a topic label is excluded.
    const existingTagNames = new Set(topics.map((t) => t.label.toLowerCase()));
    // Never configured → the sector-derived issue area is default-selected
    // (legacy carryover), so it counts as "existing" for dedup purposes.
    // Stored areas are NORMALIZED before dedup (legacy compared normalized
    // labels; an un-normalized synced variant must not cause a re-suggest).
    const existingAreas = new Set(
      (wl ? wl.issueAreas : clientArea ? [clientArea] : []).map((a) => normalizeIssueArea(a) ?? a),
    );

    // Capability tags → watchlist tag rows (distinct, not already tracked).
    const seen = new Set<string>();
    const tags: SeedWatchlistTag[] = [];
    for (const cap of caps) {
      const capTags = Array.isArray(cap.tags)
        ? (cap.tags as unknown[]).filter((t): t is string => typeof t === 'string')
        : [];
      for (const raw of capTags) {
        const tag = raw.trim();
        const key = tag.toLowerCase();
        if (!tag || seen.has(key) || existingTagNames.has(key)) continue;
        seen.add(key);
        tags.push({
          tag,
          issueArea: null,
          synonyms: [],
          relatedEntities: [],
          riskTerms: [],
          typedTerms: [],
          position: 'monitor',
          priority: 'med',
        });
      }
    }

    // Client sector + capability sectors → issue areas (not already selected).
    const areaSet = new Set<string>();
    if (clientArea && !existingAreas.has(clientArea)) areaSet.add(clientArea);
    for (const cap of caps) {
      const a = issueAreaForSector(cap.sector);
      if (a && !existingAreas.has(a)) areaSet.add(a);
    }

    return { tags, issueAreas: [...areaSet] };
  }
}
