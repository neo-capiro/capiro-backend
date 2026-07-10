import { Injectable, NotFoundException } from '@nestjs/common';
import { issueAreaForSector } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { MIN_TERM_LEN } from '../watchlist/watchlist-mapping.js';
import { compileWatchlist, type CompiledWatchlist } from '../watchlist/watchlist-compiler.js';
import { normalizeE164 } from './sms/sms.service.js';

/**
 * Synthetic topic label for hearing-native FLAT terms (topicId NULL) folded into
 * the unified editor (P5). The old WatchlistsTab wrote flat terms straight onto a
 * watchlist row; the unified editor now owns them, so getWatchlist surfaces them
 * under this topic (rather than orphaning them) and putWatchlist re-persists them
 * from the same-named topic. Prefixed to avoid colliding with a real tag label.
 */
export const HEARING_TERMS_TOPIC_LABEL = 'Hearing terms';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Read/write API for the UNIFIED tracker watchlist (Phase 2, plan §5.2).
 *
 * Operates on the deterministic-id watchlist `wl:<clientId>` + its topics/terms
 * and the per-user `intel_alert_preference`. intel-api has no RLS, so every
 * query filters by the TenantGuard-resolved `tenantId` (app-code isolation).
 * All routes are gated by `tracker_owner_intel` (TrackerOwnerGuard, 404 when
 * off), so during shadow only the internal tenant can write here — apps/api
 * stays source of truth (D6).
 */
export interface TrackerTermInput {
  termType: string;
  value: string;
}
export interface TrackerTopicInput {
  label: string;
  issueArea?: string | null;
  position?: string;
  priority?: string;
  terms?: TrackerTermInput[];
}
export interface PutWatchlistInput {
  issueAreas?: string[];
  topics?: TrackerTopicInput[];
  /** State Legislation Platform (DD5) — empty = federal-only (unchanged default); non-empty also matches those states' bill corpus. */
  jurisdictions?: string[];
}
export interface WatchlistView {
  clientId: string;
  issueAreas: string[];
  jurisdictions: string[];
  topics: Array<{
    label: string;
    issueArea: string | null;
    position: string;
    priority: string;
    terms: Array<{ termType: string; value: string }>;
  }>;
  /**
   * P6 sector-default: the sector-derived issue area for a NEVER-configured client
   * (no `wl:` row), surfaced as a read-time SUGGESTION so a cold client isn't
   * blank. Never written on read, absent once a row exists (parity-safe — parity
   * compares persisted rows, not this hint).
   */
  suggestedIssueAreas?: string[];
  /** Same posture, for state jurisdictions (S5.1) — derived from client_facilities.state, shown only while the client's own jurisdictions are empty. */
  suggestedJurisdictions?: string[];
}
/**
 * Default alert triggers seeded on a new subscriber pref (kept in sync with
 * apps/api tracker.types.DEFAULT_TRIGGERS). LegiWatch B deliberately turns
 * `fiscalNote` + `sponsorMomentum` default-ON now that emitters exist for them
 * (they were defined-but-dead before); `newMatch` and the text-changed→`amendment`
 * key were already default-on. `deadline` (Phase 1 M2.3) joins the same way —
 * the emitter now exists. Existing subscribers pick these up via the
 * idempotent `backfill-default-triggers` verb (they were never deliverable, so
 * appending them can't clobber a deliberate opt-out).
 */
export const DEFAULT_TRIGGERS: readonly string[] = [
  'newMatch',
  'amendment',
  'hearing',
  'committeeVote',
  'floorVote',
  'enactedFailed',
  'fiscalNote',
  'sponsorMomentum',
  'companion',
  'deadline',
];

export interface PutAlertPrefsInput {
  triggers?: string[];
  materiality?: string;
  emailEnabled?: boolean;
  emailAddress?: string | null;
  emailCadence?: string;
  smsEnabled?: boolean;
  smsPhone?: string | null;
  smsCadence?: string;
  quietHoursStart?: string | null;
  quietHoursEnd?: string | null;
  /** State Legislation Platform (DD5) — empty = ALL jurisdictions the client's watchlist produces. */
  jurisdictions?: string[];
}

@Injectable()
export class TrackerWatchlistService {
  constructor(private readonly prisma: PrismaService) {}

  async getWatchlist(tenantId: string, clientId: string): Promise<WatchlistView> {
    const wlId = `wl:${clientId}`;
    const wl = await this.prisma.withTenant(tenantId, (tx) =>
      tx.watchlist.findFirst({
        where: { id: wlId, tenantId },
        select: { issueAreas: true, jurisdictions: true },
      }),
    );
    // Never configured → surface the sector-derived issue area as a suggestion
    // so the cold client isn't blank (P6). No write on read; the editor opts in.
    if (!wl) {
      const suggested = await this.getSectorSuggestion(tenantId, clientId);
      const suggestedJ = await this.suggestedJurisdictions(tenantId, clientId);
      return {
        clientId,
        issueAreas: [],
        jurisdictions: [],
        topics: [],
        ...(suggested.length ? { suggestedIssueAreas: suggested } : {}),
        ...(suggestedJ.length ? { suggestedJurisdictions: suggestedJ } : {}),
      };
    }
    const topics = await this.prisma.withTenant(tenantId, (tx) =>
      tx.watchlistTopic.findMany({
        where: { watchlistId: wlId, tenantId },
        select: { id: true, label: true, issueArea: true, position: true, priority: true },
      }),
    );
    const topicIds = topics.map((t) => t.id);
    // Topic-scoped terms + any hearing-native FLAT terms on this SAME row
    // (topicId NULL). The old WatchlistsTab wrote flat terms; the unified editor
    // now owns them, so fold them into a synthetic topic rather than dropping
    // them (putWatchlist re-persists them as topic terms — see below).
    const terms = await this.prisma.withTenant(tenantId, (tx) =>
      tx.watchlistTerm.findMany({
        where: {
          watchlistId: wlId,
          tenantId,
          OR: [...(topicIds.length ? [{ topicId: { in: topicIds } }] : []), { topicId: null }],
        },
        select: { topicId: true, termType: true, value: true },
      }),
    );
    const outTopics = topics.map((t) => ({
      label: t.label,
      issueArea: t.issueArea,
      position: t.position,
      priority: t.priority,
      terms: terms
        .filter((x) => x.topicId === t.id)
        .map((x) => ({ termType: x.termType, value: x.value })),
    }));
    const flatTerms = terms.filter((x) => x.topicId === null);
    if (flatTerms.length) {
      outTopics.push({
        label: HEARING_TERMS_TOPIC_LABEL,
        issueArea: null,
        position: 'monitor',
        priority: 'med',
        terms: flatTerms.map((x) => ({ termType: x.termType, value: x.value })),
      });
    }
    const suggestedJ = wl.jurisdictions.length
      ? []
      : await this.suggestedJurisdictions(tenantId, clientId);
    return {
      clientId,
      issueAreas: wl.issueAreas,
      jurisdictions: wl.jurisdictions,
      topics: outTopics,
      ...(suggestedJ.length ? { suggestedJurisdictions: suggestedJ } : {}),
    };
  }

  /**
   * The sector-derived issue area for a never-configured client (P6, legacy
   * carryover from apps/api getWatchlist which auto-selected
   * issueAreaForSector(client.sectorTag)). Tenant-scoped read (intel-api has no
   * RLS) via withSystem; returns [] on any miss. Read-only — never written.
   */
  private async getSectorSuggestion(tenantId: string, clientId: string): Promise<string[]> {
    if (!UUID_RE.test(clientId)) return [];
    const rows = await this.prisma.withSystem((tx) =>
      tx.$queryRawUnsafe<Array<{ sectorTag: string | null }>>(
        'SELECT sector_tag AS "sectorTag" FROM clients WHERE id = $1::uuid AND tenant_id = $2::uuid',
        clientId,
        tenantId,
      ),
    );
    const area = issueAreaForSector(rows[0]?.sectorTag ?? null);
    return area ? [area] : [];
  }

  /** Upsert the watchlist head + replace topics/terms atomically. */
  async putWatchlist(
    tenantId: string,
    clientId: string,
    userId: string,
    input: PutWatchlistInput,
  ): Promise<WatchlistView> {
    // CROSS-TENANT GUARD (batch-A review, CRITICAL): wl:<clientId> is a globally
    // unique id and intel-api has no RLS, so an unscoped write could clobber
    // ANOTHER tenant's watchlist (cascade-deleting all their topics/terms).
    // Prove the client belongs to the caller — same guard the sibling writers
    // (putAlertPrefs/markPhoneVerified) carry; TrackerOwnerGuard only checks the
    // caller's flag, not client ownership.
    await this.assertClientInTenant(tenantId, clientId);
    const wlId = `wl:${clientId}`;
    const issueAreas = Array.isArray(input.issueAreas) ? input.issueAreas : [];
    const jurisdictions = Array.isArray(input.jurisdictions)
      ? input.jurisdictions.map((j) => j.toUpperCase())
      : [];
    const topics = Array.isArray(input.topics) ? input.topics : [];
    // withTenant IS a $transaction (same atomic rebuild) + sets the tenant GUC.
    await this.prisma.withTenant(tenantId, async (tx) => {
      await tx.watchlist.upsert({
        where: { id: wlId },
        create: {
          id: wlId,
          tenantId,
          clientId,
          name: 'Watchlist',
          createdBy: userId,
          issueAreas,
          jurisdictions,
        },
        update: { issueAreas, jurisdictions },
      });
      // Rebuild the `wl:` row's topics (cascade-deletes their terms). This ONLY
      // touches the `wl:<clientId>` row — hearing FLAT terms on OTHER watchlist
      // rows (random cuid, created by the old WatchlistsTab) are on a different
      // `watchlistId` and are structurally untouched (proven by test). tenantId
      // is added to both deletes as defense-in-depth behind the ownership guard.
      await tx.watchlistTopic.deleteMany({ where: { watchlistId: wlId, tenantId } });
      // Also drop any hearing FLAT terms on THIS row (topicId NULL): getWatchlist
      // folded them into the synthetic "Hearing terms" topic, so the incoming
      // `topics` already carries them — clearing avoids duplicating on migration.
      await tx.watchlistTerm.deleteMany({ where: { watchlistId: wlId, tenantId, topicId: null } });
      for (const tp of topics) {
        if (!tp?.label?.trim()) continue;
        const topic = await tx.watchlistTopic.create({
          data: {
            watchlistId: wlId,
            tenantId,
            label: tp.label.trim(),
            issueArea: tp.issueArea ?? null,
            position: tp.position ?? 'monitor',
            priority: tp.priority ?? 'med',
          },
        });
        const rows = (tp.terms ?? [])
          .filter((t) => t?.value && t.value.trim().length >= MIN_TERM_LEN && t.termType)
          .map((t) => ({
            watchlistId: wlId,
            tenantId,
            topicId: topic.id,
            termType: t.termType,
            value: t.value.trim(),
          }));
        if (rows.length) await tx.watchlistTerm.createMany({ data: rows });
      }
    });
    return this.getWatchlist(tenantId, clientId);
  }

  async getAlertPrefs(tenantId: string, clientId: string, userId: string) {
    const row = await this.prisma.withTenant(tenantId, (tx) =>
      tx.intelAlertPreference.findUnique({
        where: { userId_clientId: { userId, clientId } },
      }),
    );
    if (row && row.tenantId === tenantId) return row;
    return {
      clientId,
      userId,
      triggers: [] as string[],
      materiality: 'medium',
      emailEnabled: false,
      emailAddress: null,
      emailCadence: 'realtime',
      smsEnabled: false,
      smsPhone: null,
      smsPhoneVerified: false,
      smsCadence: 'realtime',
      quietHoursStart: null,
      quietHoursEnd: null,
      jurisdictions: [] as string[],
    };
  }

  /**
   * Legacy `assertClient` port: 404 unless `clientId` is a client of the
   * caller's tenant. intel-api has no RLS, and (userId, clientId) — the pref
   * unique key — carries no tenant, so every pref WRITE must first prove the
   * client belongs to the caller (cross-tenant review finding, PR-1).
   */
  private async assertClientInTenant(tenantId: string, clientId: string): Promise<void> {
    if (!UUID_RE.test(clientId)) throw new NotFoundException('Client not found');
    const rows = await this.prisma.withSystem((tx) =>
      tx.$queryRawUnsafe<Array<{ id: string }>>(
        'SELECT id::text AS id FROM clients WHERE id = $1::uuid AND tenant_id = $2::uuid',
        clientId,
        tenantId,
      ),
    );
    if (rows.length === 0) throw new NotFoundException('Client not found');
  }

  /**
   * The upsert's update-branch guard: the unique key is tenant-free, so a row
   * created under ANOTHER tenant (same user in two orgs) must read as absent —
   * mirrors getAlertPrefs's `row.tenantId === tenantId` read guard.
   */
  private async assertPrefRowTenant(
    tenantId: string,
    clientId: string,
    userId: string,
  ): Promise<void> {
    const existing = await this.prisma.withTenant(tenantId, (tx) =>
      tx.intelAlertPreference.findUnique({
        where: { userId_clientId: { userId, clientId } },
        select: { tenantId: true },
      }),
    );
    if (existing && existing.tenantId !== tenantId) throw new NotFoundException('Client not found');
  }

  async putAlertPrefs(
    tenantId: string,
    clientId: string,
    userId: string,
    input: PutAlertPrefsInput,
  ) {
    await this.assertClientInTenant(tenantId, clientId);
    await this.assertPrefRowTenant(tenantId, clientId, userId);
    const data = {
      triggers: input.triggers ?? [],
      materiality: input.materiality ?? 'medium',
      emailEnabled: input.emailEnabled ?? false,
      emailAddress: input.emailAddress ?? null,
      emailCadence: input.emailCadence ?? 'realtime',
      smsEnabled: input.smsEnabled ?? false,
      // Normalize like legacy putAlertPrefs — an un-normalized stored phone
      // would never match the verify flow's normalized compare.
      smsPhone: normalizeE164(input.smsPhone) ?? null,
      smsCadence: input.smsCadence ?? 'realtime',
      quietHoursStart: input.quietHoursStart ?? null,
      quietHoursEnd: input.quietHoursEnd ?? null,
      jurisdictions: Array.isArray(input.jurisdictions)
        ? input.jurisdictions.map((j) => j.toUpperCase())
        : [],
    };
    return this.prisma.withTenant(tenantId, (tx) =>
      tx.intelAlertPreference.upsert({
        where: { userId_clientId: { userId, clientId } },
        create: { tenantId, clientId, userId, ...data },
        update: data,
      }),
    );
  }

  /**
   * Mark a verified phone on the user's pref (P1.1, called after OTP confirm —
   * ported from apps/api tracker.service.markPhoneVerified). The confirm flow
   * is the ONLY writer of `smsPhoneVerified` (putAlertPrefs never sets it),
   * preserving the legacy consent contract. Client-ownership + row-tenant
   * guards mirror legacy's assertClient (cross-tenant review finding, PR-1).
   */
  async markPhoneVerified(
    tenantId: string,
    clientId: string,
    userId: string,
    phone: string,
  ): Promise<void> {
    await this.assertClientInTenant(tenantId, clientId);
    await this.assertPrefRowTenant(tenantId, clientId, userId);
    await this.prisma.withTenant(tenantId, (tx) =>
      tx.intelAlertPreference.upsert({
        where: { userId_clientId: { userId, clientId } },
        update: { smsPhone: phone, smsPhoneVerified: true, smsEnabled: true },
        create: {
          tenantId,
          clientId,
          userId,
          triggers: [...DEFAULT_TRIGGERS],
          smsPhone: phone,
          smsPhoneVerified: true,
          smsEnabled: true,
        },
      }),
    );
  }

  async getCompiled(
    tenantId: string,
    clientId: string,
  ): Promise<CompiledWatchlist & { jurisdictions: string[] }> {
    const wl = await this.getWatchlist(tenantId, clientId);
    const compiled = compileWatchlist({
      issueAreas: wl.issueAreas,
      topics: wl.topics.map((t) => ({
        label: t.label,
        issueArea: t.issueArea,
        position: t.position,
        priority: t.priority,
      })),
      terms: wl.topics.flatMap((t) =>
        t.terms.map((x) => ({
          termType: x.termType,
          value: x.value,
          weight: 1,
          topicLabel: t.label,
        })),
      ),
    });
    // State Legislation Platform (DD5) — jurisdictions ride alongside the pure
    // compiler output rather than threading through compileWatchlist itself
    // (which stays a pure function of issueAreas/topics/terms only).
    return { ...compiled, jurisdictions: wl.jurisdictions };
  }

  /**
   * Facility-derived jurisdiction hint for a client (S5.1) — the exact
   * suggestedIssueAreas precedent (getSectorSuggestion above): read-only,
   * never written, absent once the client has explicitly configured
   * jurisdictions. withSystem because client_facilities is tenant-scoped and
   * intel-api has no RLS.
   */
  async suggestedJurisdictions(tenantId: string, clientId: string): Promise<string[]> {
    if (!UUID_RE.test(clientId)) return [];
    const rows = await this.prisma.withSystem((tx) =>
      tx.$queryRawUnsafe<Array<{ state: string | null }>>(
        'SELECT DISTINCT state FROM client_facilities WHERE tenant_id = $1::uuid AND client_id = $2::uuid AND state IS NOT NULL',
        tenantId,
        clientId,
      ),
    );
    return rows.map((r) => r.state).filter((s): s is string => !!s);
  }
}
