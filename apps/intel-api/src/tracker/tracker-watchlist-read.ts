import { issueAreaForSector } from '@capiro/shared';
import type { TrackerWatchlistService } from './tracker-watchlist.service.js';
import type {
  WatchlistView,
  WatchlistRevisionView,
  WatchlistReadPolicy,
  WatchlistReadTopic,
  WatchlistReadTerm,
} from './tracker-watchlist.contracts.js';
export class TrackerWatchlistRead {
  constructor(private readonly policy: WatchlistReadPolicy) {}
  /**
   * @param opts.withUserNames resolve `updatedBy` to a display name. OFF by default
   *   because `getCompiled` → `compiledTopics` calls this on the recommendations hot
   *   path, and attribution is only ever rendered by the Configure panel — so the
   *   extra `users` lookup is paid by the one caller that needs it.
   */
  async getWatchlist(
    host: TrackerWatchlistService,
    tenantId: string,
    clientId: string,
    opts: {
      withUserNames?: boolean;
    },
  ): Promise<WatchlistView> {
    const wlId = `wl:${clientId}`;
    const wl = await host['prisma'].withTenant(tenantId, (tx) =>
      tx.watchlist.findFirst({
        where: { id: wlId, tenantId },
        select: {
          issueAreas: true,
          jurisdictions: true,
          // P1-02: the concurrency token + attribution the editor echoes back.
          version: true,
          updatedBy: true,
          updatedAt: true,
        },
      }),
    );
    // Never configured → surface the sector-derived issue area as a suggestion
    // so the cold client isn't blank (P6). No write on read; the editor opts in.
    if (!wl) {
      const suggested = await host['getSectorSuggestion'](tenantId, clientId);
      const suggestedJ = await host['suggestedJurisdictions'](tenantId, clientId);
      return this.coldView(clientId, suggested, suggestedJ);
    }
    const topics = await host['prisma'].withTenant(tenantId, (tx) =>
      tx.watchlistTopic.findMany({
        where: { watchlistId: wlId, tenantId },
        // Gate K (a-1): row order was Postgres physical order (genuinely
        // unstable across reads) — the root cause the web's label-remap
        // band-aid (TrackerConfigPanel.tsx) papered over. `id` breaks ties
        // deterministically (createdAt has millisecond granularity and a
        // bulk reconcile can insert two topics in the same millisecond).
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { id: true, label: true, issueArea: true, position: true, priority: true },
      }),
    );
    const topicIds = topics.map((t) => t.id);
    // Topic-scoped terms + any hearing-native FLAT terms on this SAME row
    // (topicId NULL). The old WatchlistsTab wrote flat terms; the unified editor
    // now owns them, so fold them into a synthetic topic rather than dropping
    // them (putWatchlist re-persists them as topic terms — see below).
    const terms = await host['prisma'].withTenant(tenantId, (tx) =>
      tx.watchlistTerm.findMany({
        where: {
          watchlistId: wlId,
          tenantId,
          OR: [...(topicIds.length ? [{ topicId: { in: topicIds } }] : []), { topicId: null }],
        },
        // Gate K (a-1): same determinism fix as the topics query above.
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { id: true, topicId: true, termType: true, value: true },
      }),
    );
    const outTopics = this.presentTopics(topics, terms);
    const suggestedJ = wl.jurisdictions.length
      ? []
      : await host['suggestedJurisdictions'](tenantId, clientId);
    return {
      clientId,
      issueAreas: wl.issueAreas,
      jurisdictions: wl.jurisdictions,
      topics: outTopics,
      version: wl.version ?? 0,
      updatedByName: opts.withUserNames ? await host['resolveUserName'](wl.updatedBy) : null,
      updatedAt: wl.updatedAt?.toISOString() ?? null,
      ...(suggestedJ.length ? { suggestedJurisdictions: suggestedJ } : {}),
    };
  }
  private coldView(clientId: string, suggested: string[], suggestedJ: string[]): WatchlistView {
    return {
      clientId,
      issueAreas: [],
      jurisdictions: [],
      topics: [],
      // A row that does not exist yet is version 0, so the first PUT's
      // `expectedVersion: 0` matches rather than 409-ing on a cold client.
      version: 0,
      updatedByName: null,
      updatedAt: null,
      ...(suggested.length ? { suggestedIssueAreas: suggested } : {}),
      ...(suggestedJ.length ? { suggestedJurisdictions: suggestedJ } : {}),
    };
  }
  private presentTopics(
    topics: WatchlistReadTopic[],
    terms: WatchlistReadTerm[],
  ): WatchlistView['topics'] {
    const outTopics: WatchlistView['topics'] = topics.map((t) => ({
      // Gate K (MP-08, b-1): `id` was already SELECTED above (line ~238) and
      // then dropped here — the exact gap that forced the web to key tags by
      // label/array-index instead of a stable identity.
      id: t.id,
      label: t.label,
      issueArea: t.issueArea,
      position: t.position,
      priority: t.priority,
      terms: terms
        .filter((x) => x.topicId === t.id)
        .map((x) => ({ termType: x.termType, value: x.value, id: x.id })),
    }));
    const flatTerms = terms.filter((x) => x.topicId === null);
    if (flatTerms.length) {
      const flat = flatTerms.map((x) => ({ termType: x.termType, value: x.value, id: x.id }));
      // Gate B §4.3: `HEARING_TERMS_TOPIC_LABEL` is a REAL, saveable label — the
      // first putWatchlist of this view persists the folded flat terms under a
      // topic with exactly this name. So a client can legitimately have BOTH flat
      // terms and a real topic called "Hearing terms" (legacy WatchlistsTab writes
      // flat terms straight onto the row at any time). MERGE into the existing
      // topic rather than pushing a second one with the same label: a duplicate
      // label in the view would be rejected as a dupe by putWatchlist's reconcile
      // and the flat rows cleared, destroying them. Merging is loss-free and
      // idempotent. Do NOT instead "reserve" the label — rejecting it on write is
      // what loses the terms (boundary §2.4.1).
      const host = outTopics.find(
        (t) => t.label.toLowerCase() === this.policy.hearingLabel().toLowerCase(),
      );
      if (host) host.terms.push(...flat);
      else
        outTopics.push({
          label: this.policy.hearingLabel(),
          issueArea: null,
          position: 'monitor',
          priority: 'med',
          terms: flat,
        });
    }
    return outTopics;
  }
  /**
   * The sector-derived issue area for a never-configured client (P6, legacy
   * carryover from apps/api getWatchlist which auto-selected
   * issueAreaForSector(client.sectorTag)). Tenant-scoped read (intel-api has no
   * RLS) via withSystem; returns [] on any miss. Read-only — never written.
   */
  async getSectorSuggestion(
    host: TrackerWatchlistService,
    tenantId: string,
    clientId: string,
  ): Promise<string[]> {
    if (!this.policy.uuid.test(clientId)) return [];
    const rows = await host['prisma'].withSystem((tx) =>
      tx.$queryRawUnsafe<
        Array<{
          sectorTag: string | null;
        }>
      >(
        'SELECT sector_tag AS "sectorTag" FROM clients WHERE id = $1::uuid AND tenant_id = $2::uuid',
        clientId,
        tenantId,
      ),
    );
    const area = issueAreaForSector(rows[0]?.sectorTag ?? null);
    return area ? [area] : [];
  }
  /**
   * Clerk user id → display name (P1-02 e-8 follow-up). `withSystem` because
   * `users` is not tenant-scoped in intel-api's schema and this service has no
   * Prisma model for it — the same raw-SQL pattern `assertClientInTenant` uses.
   *
   * Read-only and best-effort: any miss returns null and the UI falls back to the
   * timestamp alone. Deliberately returns a NAME or nothing — never the id, and
   * never the email (which would leak an address into shared firm-wide UI).
   */
  async resolveUserName(
    host: TrackerWatchlistService,
    clerkUserId: string | null,
  ): Promise<string | null> {
    if (!clerkUserId) return null;
    try {
      const rows = await host['prisma'].withSystem((tx) =>
        tx.$queryRawUnsafe<
          Array<{
            firstName: string | null;
            lastName: string | null;
          }>
        >(
          'SELECT first_name AS "firstName", last_name AS "lastName" FROM users WHERE clerk_user_id = $1 LIMIT 1',
          clerkUserId,
        ),
      );
      const name = [rows[0]?.firstName, rows[0]?.lastName].filter(Boolean).join(' ').trim();
      return name || null;
    } catch (err) {
      // Attribution is a nicety; never fail a watchlist read over it.
      host['logger'].warn(`resolveUserName failed: ${(err as Error).message}`);
      return null;
    }
  }
  /**
   * The shared-targeting change log, newest first (P1-02). Capped at 20 — this is
   * a "who touched this recently" affordance in the Configure panel, not an audit
   * export. `assertClientInTenant` first: the table's rows carry tenant_id but the
   * route takes a client id from the URL.
   */
  async getRevisions(
    host: TrackerWatchlistService,
    tenantId: string,
    clientId: string,
  ): Promise<WatchlistRevisionView[]> {
    await host['assertClientInTenant'](tenantId, clientId);
    const rows = await host['prisma'].withTenant(tenantId, (tx) =>
      tx.intelWatchlistRevision.findMany({
        where: { tenantId, clientId },
        orderBy: { version: 'desc' },
        take: 20,
        select: { version: true, changedBy: true, createdAt: true, summary: true },
      }),
    );
    return rows.map((r) => ({
      version: r.version,
      changedBy: r.changedBy ?? null,
      createdAt: r.createdAt.toISOString(),
      summary: r.summary,
    }));
  }
  /**
   * Facility-derived jurisdiction hint for a client (S5.1) — the exact
   * suggestedIssueAreas precedent (getSectorSuggestion above): read-only,
   * never written, absent once the client has explicitly configured
   * jurisdictions. withSystem because client_facilities is an apps/api-owned
   * table intel-api has no Prisma model for, not because intel_* lacks RLS.
   */
  async suggestedJurisdictions(
    host: TrackerWatchlistService,
    tenantId: string,
    clientId: string,
  ): Promise<string[]> {
    if (!this.policy.uuid.test(clientId)) return [];
    const rows = await host['prisma'].withSystem((tx) =>
      tx.$queryRawUnsafe<
        Array<{
          state: string | null;
        }>
      >(
        'SELECT DISTINCT state FROM client_facilities WHERE tenant_id = $1::uuid AND client_id = $2::uuid AND state IS NOT NULL',
        tenantId,
        clientId,
      ),
    );
    return rows.map((r) => r.state).filter((s): s is string => !!s);
  }
}
