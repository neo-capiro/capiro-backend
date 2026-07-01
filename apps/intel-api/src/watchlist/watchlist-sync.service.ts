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
 * only in `intel_*` (no RLS). Per-client work is serialized with a Postgres
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
  }> {
    const tenantId = tenantSlugOrId ? await this.resolveTenantId(tenantSlugOrId) : null;
    if (tenantSlugOrId && !tenantId) throw new Error(`NO_TENANT_FOR ${tenantSlugOrId}`);

    const rows = await this.prisma.withSystem((tx) =>
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
        await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1))', `intel_wl_sync:${cw.client_id}`);

        const existWl = await tx.watchlist.findUnique({ where: { id: wlId }, select: { issueAreas: true } });
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
              .map((r) => ({ termType: r.termType as 'synonym' | 'entity' | 'risk', value: r.value })),
          }));
          const existHash = watchlistContentHash({ issueAreas: existWl.issueAreas, topics: existExpandedTopics });
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

    // Sweep: unified tracker watchlists (id LIKE 'wl:%') whose legacy row is gone.
    const trackerWls = await this.prisma.watchlist.findMany({
      where: tenantId ? { tenantId, id: { startsWith: 'wl:' } } : { id: { startsWith: 'wl:' } },
      select: { id: true, clientId: true },
    });
    let swept = 0;
    for (const w of trackerWls) {
      if (!legacyClientIds.has(w.clientId)) {
        await this.prisma.watchlist.delete({ where: { id: w.id } }); // cascade topics/terms
        swept += 1;
      }
    }

    return { clients: rows.length, changed, skipped, swept };
  }

  /** Backfill `tracked_bill` → `intel_tracked_bill` (idempotent on (clientId,billId)). */
  async backfillTrackedBills(tenantSlugOrId?: string): Promise<{ count: number }> {
    const tenantId = tenantSlugOrId ? await this.resolveTenantId(tenantSlugOrId) : null;
    if (tenantSlugOrId && !tenantId) throw new Error(`NO_TENANT_FOR ${tenantSlugOrId}`);

    const cols = `client_id::text AS client_id, tenant_id::text AS tenant_id, bill_id, note, source,
                  created_by, last_seen_action_text, last_seen_action_date, last_seen_at`;
    const rows = await this.prisma.withSystem((tx) =>
      tenantId
        ? tx.$queryRawUnsafe<TrackedBillRow[]>(`SELECT ${cols} FROM tracked_bill WHERE tenant_id = $1::uuid`, tenantId)
        : tx.$queryRawUnsafe<TrackedBillRow[]>(`SELECT ${cols} FROM tracked_bill`),
    );

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
      await this.prisma.trackedBill.upsert({
        where: { clientId_billId: { clientId: r.client_id, billId: r.bill_id } },
        create: { tenantId: r.tenant_id, clientId: r.client_id, billId: r.bill_id, ...data },
        update: data,
      });
      count += 1;
    }
    return { count };
  }

  /** Backfill `alert_preference` → `intel_alert_preference` (idempotent on (userId,clientId)). */
  async backfillAlertPrefs(tenantSlugOrId?: string): Promise<{ count: number }> {
    const tenantId = tenantSlugOrId ? await this.resolveTenantId(tenantSlugOrId) : null;
    if (tenantSlugOrId && !tenantId) throw new Error(`NO_TENANT_FOR ${tenantSlugOrId}`);

    const cols = `client_id::text AS client_id, tenant_id::text AS tenant_id, user_id, triggers, materiality,
                  email_enabled, email_address, email_cadence, sms_enabled, sms_phone, sms_phone_verified,
                  sms_cadence, quiet_hours_start, quiet_hours_end`;
    const rows = await this.prisma.withSystem((tx) =>
      tenantId
        ? tx.$queryRawUnsafe<AlertPrefRow[]>(`SELECT ${cols} FROM alert_preference WHERE tenant_id = $1::uuid`, tenantId)
        : tx.$queryRawUnsafe<AlertPrefRow[]>(`SELECT ${cols} FROM alert_preference`),
    );

    let count = 0;
    for (const r of rows) {
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
      await this.prisma.intelAlertPreference.upsert({
        where: { userId_clientId: { userId: r.user_id, clientId: r.client_id } },
        create: { tenantId: r.tenant_id, clientId: r.client_id, userId: r.user_id, ...data },
        update: data,
      });
      count += 1;
    }
    return { count };
  }

  /** Set a tenant's feature flag (the `disable-feature` OFF path, §5.0.1; also enables). */
  async setFeatureFlag(
    feature: string,
    tenantSlugOrId: string,
    enabled: boolean,
  ): Promise<{ feature: string; tenantId: string; enabled: boolean }> {
    const tenantId = await this.resolveTenantId(tenantSlugOrId);
    if (!tenantId) throw new Error(`NO_TENANT_FOR ${tenantSlugOrId}`);
    await this.prisma.featureFlag.upsert({
      where: { feature_tenantId: { feature, tenantId } },
      create: { feature, tenantId, enabled },
      update: { enabled },
    });
    return { feature, tenantId, enabled };
  }
}
