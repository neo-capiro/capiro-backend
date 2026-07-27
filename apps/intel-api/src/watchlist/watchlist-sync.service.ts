import { Injectable } from '@nestjs/common';
import { normalizeIssueArea } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  type LegacyWatchlistRow,
  type ExpandedTopic,
  expandLegacyWatchlist,
  watchlistContentHash,
} from './watchlist-mapping.js';

/**
 * Legacy → unified watchlist sync (Phase 2, plan §3.3 / §5.4). One-way,
 * `apps/api → intel-api` (D6): apps/api stays the source of truth during shadow.
 *
 * All reads of apps/api tenant-scoped tables (`client_watchlist`,
 * `alert_preference`, `tracked_bill`) go through `prisma.withSystem` — the RLS
 * bypass path (`SET LOCAL app.bypass_rls = 'on'`) — so a cross-tenant run reads
 * every tenant's rows. intel-api NEVER writes apps/api tables (D2). Writes land
 * only in `intel_*`, which itself carries FORCE ROW LEVEL SECURITY scoped to
 * tenant_id — this sweep's writes go through the same `withSystem` bypass since
 * they are legitimately cross-tenant. Per-client work is serialized with a Postgres
 * transaction advisory lock so an overlapping scheduled + manual run can't
 * double-write the same client.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface TrackedBillRow {
  client_id: string;
  tenant_id: string;
  bill_id: string;
  note: string | null;
  source: string | null;
  created_by: string | null;
  last_seen_action_text: string | null;
  last_seen_action_date: Date | null;
  last_seen_at: Date | null;
}

interface AlertPrefRow {
  client_id: string;
  tenant_id: string;
  user_id: string;
  /** From `users.clerk_user_id` (LEFT JOIN) — the id space intel-api keys by. */
  clerk_user_id: string | null;
  triggers: string[] | null;
  materiality: string;
  email_enabled: boolean;
  email_address: string | null;
  email_cadence: string;
  sms_enabled: boolean;
  sms_phone: string | null;
  sms_phone_verified: boolean;
  sms_cadence: string;
  quiet_hours_start: string | null;
  quiet_hours_end: string | null;
}

@Injectable()
export class WatchlistSyncService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Tenants whose tracker is intel-OWNED (`tracker_owner_intel` enabled).
   * Sync + backfills SKIP these: after a tenant flips, intel_* is its source
   * of truth and re-running legacy→intel copies would overwrite v2-native
   * edits with stale legacy state (cutover review finding, PR-1).
   */
  private async ownedTenantIds(): Promise<Set<string>> {
    // Cross-tenant: reads owned-flags for EVERY tenant to drive the sweep/skip
    // logic → withSystem (bypass RLS on intel_feature_flag).
    const rows = await this.prisma.withSystem((tx) =>
      tx.featureFlag.findMany({
        where: { feature: 'tracker_owner_intel', enabled: true },
        select: { tenantId: true },
      }),
    );
    return new Set(rows.map((r) => r.tenantId));
  }

  /** Resolve a tenant slug or uuid to the tenant uuid, or null if unknown. */
  async resolveTenantId(slugOrId: string): Promise<string | null> {
    if (UUID_RE.test(slugOrId)) return slugOrId;
    const rows = await this.prisma.withSystem((tx) =>
      tx.$queryRawUnsafe<Array<{ id: string }>>(
        'SELECT id::text AS id FROM tenants WHERE slug = $1',
        slugOrId,
      ),
    );
    return rows[0]?.id ?? null;
  }

  /**
   * Sync `client_watchlist` → `intel_watchlist` (+ topics/terms). Watchlist
   * identity is the deterministic id `wl:<clientId>` (upsert-by-id). Per client:
   * skip if content unchanged, else delete+rebuild topics/terms atomically under
   * a per-client advisory lock. Sweeps unified tracker watchlists whose legacy
   * row is gone. Returns per-run counters (final log line drives SC-3/alarms).
   */
  async syncWatchlists(tenantSlugOrId?: string): Promise<{
    clients: number;
    changed: number;
    skipped: number;
    swept: number;
    skippedOwned: number;
  }> {
    const tenantId = tenantSlugOrId ? await this.resolveTenantId(tenantSlugOrId) : null;
    if (tenantSlugOrId && !tenantId) throw new Error(`NO_TENANT_FOR ${tenantSlugOrId}`);
    const owned = await this.ownedTenantIds();

    const allRows = await this.prisma.withSystem((tx) =>
      tenantId
        ? tx.$queryRawUnsafe<LegacyWatchlistRow[]>(
            `SELECT client_id::text AS client_id, tenant_id::text AS tenant_id,
                    issue_areas, tags, updated_by
               FROM client_watchlist WHERE tenant_id = $1::uuid`,
            tenantId,
          )
        : tx.$queryRawUnsafe<LegacyWatchlistRow[]>(
            `SELECT client_id::text AS client_id, tenant_id::text AS tenant_id,
                    issue_areas, tags, updated_by
               FROM client_watchlist`,
          ),
    );

    const rows = allRows.filter((r) => !owned.has(r.tenant_id));
    const skippedOwned = allRows.length - rows.length;

    let changed = 0;
    let skipped = 0;
    const legacyClientIds = new Set(rows.map((r) => r.client_id));

    for (const cw of rows) {
      const expanded = expandLegacyWatchlist(cw, normalizeIssueArea);
      const wlId = `wl:${cw.client_id}`;
      const newHash = watchlistContentHash(expanded);

      await this.prisma.withSystem(async (tx) => {
        // Serialize concurrent syncs of the SAME client (auto-released at commit).
        // $executeRawUnsafe (not $queryRawUnsafe): pg_advisory_xact_lock returns
        // `void`, which the query path cannot deserialize; execute discards it.
        await tx.$executeRawUnsafe(
          'SELECT pg_advisory_xact_lock(hashtext($1))',
          `intel_wl_sync:${cw.client_id}`,
        );

        const existWl = await tx.watchlist.findUnique({
          where: { id: wlId },
          select: { issueAreas: true },
        });
        if (existWl) {
          const existTopics = await tx.watchlistTopic.findMany({
            where: { watchlistId: wlId },
            select: { id: true, label: true, issueArea: true, position: true, priority: true },
          });
          const existTerms = existTopics.length
            ? await tx.watchlistTerm.findMany({
                where: { topicId: { in: existTopics.map((t) => t.id) } },
                select: { topicId: true, termType: true, value: true },
              })
            : [];
          const existExpandedTopics: ExpandedTopic[] = existTopics.map((t) => ({
            label: t.label,
            issueArea: t.issueArea,
            position: t.position as ExpandedTopic['position'],
            priority: t.priority as ExpandedTopic['priority'],
            terms: existTerms
              .filter((r) => r.topicId === t.id)
              .map((r) => ({
                termType: r.termType as 'synonym' | 'entity' | 'risk',
                value: r.value,
              })),
          }));
          const existHash = watchlistContentHash({
            issueAreas: existWl.issueAreas,
            topics: existExpandedTopics,
          });
          if (existHash === newHash) {
            skipped += 1;
            return;
          }
        }

        await tx.watchlist.upsert({
          where: { id: wlId },
          create: {
            id: wlId,
            tenantId: cw.tenant_id,
            clientId: cw.client_id,
            name: 'Watchlist',
            createdBy: expanded.createdBy,
            issueAreas: expanded.issueAreas,
          },
          update: { issueAreas: expanded.issueAreas },
        });

        // Rebuild legacy-derived topics/terms. Cascade FK removes child terms.
        // Hearing terms (topic_id NULL) hang off DIFFERENT rows and are untouched.
        await tx.watchlistTopic.deleteMany({ where: { watchlistId: wlId } });
        for (const tp of expanded.topics) {
          const topic = await tx.watchlistTopic.create({
            data: {
              watchlistId: wlId,
              tenantId: cw.tenant_id,
              label: tp.label,
              issueArea: tp.issueArea,
              position: tp.position,
              priority: tp.priority,
            },
          });
          if (tp.terms.length) {
            await tx.watchlistTerm.createMany({
              data: tp.terms.map((t) => ({
                watchlistId: wlId,
                tenantId: cw.tenant_id,
                topicId: topic.id,
                termType: t.termType,
                value: t.value,
              })),
            });
          }
        }
        changed += 1;
      });
    }

    // Sweep: unified tracker watchlists (id LIKE 'wl:%') whose legacy row is
    // gone. NEVER sweeps intel-owned tenants — their `wl:` rows are v2-native
    // truth with no legacy counterpart by design.
    const trackerWls = await this.prisma.withSystem((tx) =>
      tx.watchlist.findMany({
        where: tenantId ? { tenantId, id: { startsWith: 'wl:' } } : { id: { startsWith: 'wl:' } },
        select: { id: true, clientId: true, tenantId: true },
      }),
    );
    let swept = 0;
    for (const w of trackerWls) {
      if (owned.has(w.tenantId)) continue;
      if (!legacyClientIds.has(w.clientId)) {
        // cascade topics/terms; cross-tenant sweep → withSystem
        await this.prisma.withSystem((tx) => tx.watchlist.delete({ where: { id: w.id } }));
        swept += 1;
      }
    }

    return { clients: rows.length, changed, skipped, swept, skippedOwned };
  }

  /**
   * Backfill `tracked_bill` → `intel_tracked_bill` (idempotent on
   * (clientId,billId)). Skips intel-owned tenants (see ownedTenantIds).
   */
  async backfillTrackedBills(
    tenantSlugOrId?: string,
  ): Promise<{ count: number; skippedOwned: number }> {
    const tenantId = tenantSlugOrId ? await this.resolveTenantId(tenantSlugOrId) : null;
    if (tenantSlugOrId && !tenantId) throw new Error(`NO_TENANT_FOR ${tenantSlugOrId}`);
    const owned = await this.ownedTenantIds();

    const cols = `client_id::text AS client_id, tenant_id::text AS tenant_id, bill_id, note, source,
                  created_by, last_seen_action_text, last_seen_action_date, last_seen_at`;
    const allRows = await this.prisma.withSystem((tx) =>
      tenantId
        ? tx.$queryRawUnsafe<TrackedBillRow[]>(
            `SELECT ${cols} FROM tracked_bill WHERE tenant_id = $1::uuid`,
            tenantId,
          )
        : tx.$queryRawUnsafe<TrackedBillRow[]>(`SELECT ${cols} FROM tracked_bill`),
    );
    const rows = allRows.filter((r) => !owned.has(r.tenant_id));
    const skippedOwned = allRows.length - rows.length;

    let count = 0;
    for (const r of rows) {
      const data = {
        note: r.note ?? null,
        source: 'congress',
        isManual: r.source === 'manual_search',
        trackedBy: r.created_by ?? null,
        lastSeenActionText: r.last_seen_action_text ?? null,
        lastSeenActionDate: r.last_seen_action_date ?? null,
        lastSeenAt: r.last_seen_at ?? null,
      };
      await this.prisma.withSystem((tx) =>
        tx.trackedBill.upsert({
          where: { clientId_billId: { clientId: r.client_id, billId: r.bill_id } },
          create: { tenantId: r.tenant_id, clientId: r.client_id, billId: r.bill_id, ...data },
          update: data,
        }),
      );
      count += 1;
    }
    return { count, skippedOwned };
  }

  /**
   * Backfill `alert_preference` → `intel_alert_preference` (idempotent on
   * (userId,clientId)).
   *
   * ID-SPACE TRANSLATION (cutover review finding, PR-1 — CRITICAL): legacy
   * `alert_preference.user_id` is the INTERNAL `users.id` uuid, but every
   * intel-api runtime path keys prefs by the Clerk subject (`clerkUserId` from
   * the JWT). Copying the uuid verbatim produced rows the runtime could never
   * read (prefs "wiped" post-flip) while a user's first v2 save created a
   * duplicate clerk-keyed row (double alert delivery). So: JOIN users and
   * write `userId = clerk_user_id`; rows whose user has no clerk id (deleted
   * users) are skipped and counted. Skips intel-owned tenants.
   */
  async backfillAlertPrefs(
    tenantSlugOrId?: string,
  ): Promise<{ count: number; skippedOwned: number; skippedNoClerkId: number }> {
    const tenantId = tenantSlugOrId ? await this.resolveTenantId(tenantSlugOrId) : null;
    if (tenantSlugOrId && !tenantId) throw new Error(`NO_TENANT_FOR ${tenantSlugOrId}`);
    const owned = await this.ownedTenantIds();

    const cols = `ap.client_id::text AS client_id, ap.tenant_id::text AS tenant_id, ap.user_id,
                  u.clerk_user_id, ap.triggers, ap.materiality,
                  ap.email_enabled, ap.email_address, ap.email_cadence, ap.sms_enabled, ap.sms_phone,
                  ap.sms_phone_verified, ap.sms_cadence, ap.quiet_hours_start, ap.quiet_hours_end`;
    // users.id is a uuid COLUMN; alert_preference.user_id is text — cast the
    // uuid side or PG throws 42883 (operator does not exist: uuid = text).
    const from = `FROM alert_preference ap LEFT JOIN users u ON u.id::text = ap.user_id`;
    const allRows = await this.prisma.withSystem((tx) =>
      tenantId
        ? tx.$queryRawUnsafe<AlertPrefRow[]>(
            `SELECT ${cols} ${from} WHERE ap.tenant_id = $1::uuid`,
            tenantId,
          )
        : tx.$queryRawUnsafe<AlertPrefRow[]>(`SELECT ${cols} ${from}`),
    );
    const unowned = allRows.filter((r) => !owned.has(r.tenant_id));
    const skippedOwned = allRows.length - unowned.length;
    const rows = unowned.filter((r) => Boolean(r.clerk_user_id));
    const skippedNoClerkId = unowned.length - rows.length;

    let count = 0;
    for (const r of rows) {
      const clerkUserId = r.clerk_user_id as string;
      const data = {
        triggers: r.triggers ?? [],
        materiality: r.materiality,
        emailEnabled: r.email_enabled,
        emailAddress: r.email_address ?? null,
        emailCadence: r.email_cadence,
        smsEnabled: r.sms_enabled,
        smsPhone: r.sms_phone ?? null,
        smsPhoneVerified: r.sms_phone_verified,
        smsCadence: r.sms_cadence,
        quietHoursStart: r.quiet_hours_start ?? null,
        quietHoursEnd: r.quiet_hours_end ?? null,
      };
      await this.prisma.withSystem((tx) =>
        tx.intelAlertPreference.upsert({
          where: { userId_clientId: { userId: clerkUserId, clientId: r.client_id } },
          create: { tenantId: r.tenant_id, clientId: r.client_id, userId: clerkUserId, ...data },
          update: data,
        }),
      );
      count += 1;
    }
    return { count, skippedOwned, skippedNoClerkId };
  }

  /**
   * Flip a feature for EVERY tenant in one pass (Phase-8 all-tenant cutover).
   * Upsert-idempotent; returns the tenant list so the verb can log each slug.
   */
  async setFeatureFlagAll(
    feature: string,
    enabled: boolean,
  ): Promise<{ feature: string; enabled: boolean; tenants: Array<{ id: string; slug: string }> }> {
    const tenants = await this.prisma.withSystem((tx) =>
      tx.$queryRawUnsafe<Array<{ id: string; slug: string }>>(
        'SELECT id::text AS id, slug FROM tenants ORDER BY slug',
      ),
    );
    for (const t of tenants) {
      // Bulk all-tenant admin write → withSystem (bypass RLS on intel_feature_flag).
      await this.prisma.withSystem((tx) =>
        tx.featureFlag.upsert({
          where: { feature_tenantId: { feature, tenantId: t.id } },
          create: { feature, tenantId: t.id, enabled },
          update: { enabled },
        }),
      );
    }
    return { feature, enabled, tenants };
  }

  /** Set a tenant's feature flag (the `disable-feature` OFF path, §5.0.1; also enables). */
  async setFeatureFlag(
    feature: string,
    tenantSlugOrId: string,
    enabled: boolean,
  ): Promise<{ feature: string; tenantId: string; enabled: boolean }> {
    const tenantId = await this.resolveTenantId(tenantSlugOrId);
    if (!tenantId) throw new Error(`NO_TENANT_FOR ${tenantSlugOrId}`);
    await this.prisma.withTenant(tenantId, (tx) =>
      tx.featureFlag.upsert({
        where: { feature_tenantId: { feature, tenantId } },
        create: { feature, tenantId, enabled },
        update: { enabled },
      }),
    );
    return { feature, tenantId, enabled };
  }
}
