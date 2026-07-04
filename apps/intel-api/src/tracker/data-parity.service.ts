import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { normalizeIssueArea } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { WatchlistSyncService } from '../watchlist/watchlist-sync.service.js';
import {
  type LegacyWatchlistRow,
  type ExpandedTopic,
  expandLegacyWatchlist,
  watchlistContentHash,
} from '../watchlist/watchlist-mapping.js';
import {
  type DataParityReport,
  type LegacyTrackedBillRow,
  type LegacyAlertPrefRow,
  compareAlertPrefs,
  compareTrackedBills,
  compareWatchlistHashes,
  evaluateDataParity,
  trackedBillKey,
  alertPrefKey,
} from './data-parity.util.js';

/**
 * DATA parity + migration evidence for the Phase-8 cutover (companion to the
 * alert-decision ParityService). Three verbs hang off this service:
 *
 *   `parity-data`             — READ-ONLY diff of the three migrated stores
 *                               (gate: legacyOnly=0 AND mismatched=0).
 *   `snapshot-legacy`         — READ-ONLY chunked JSON dump of the legacy
 *                               tables to logs (the pre-migration snapshot /
 *                               restore source of last resort).
 *   `reconcile-intel-tracker` — deletes STALE intel-only rows (rows whose
 *                               legacy counterpart was deleted after backfill)
 *                               for NOT-YET-FLIPPED tenants only. DRY-RUN by
 *                               default; `--apply=true` requires an explicit
 *                               `--created-before=<ISO>` cutoff and refuses to
 *                               run when rollback evidence exists (a disabled
 *                               tracker_owner_intel row) unless `--force=true`.
 *                               PRE-FIRST-FLIP tool only.
 *
 * All legacy reads go through `prisma.withSystem` (RLS bypass, cross-tenant),
 * identical to WatchlistSyncService. intel-api never writes apps/api tables
 * (D2) — reconcile touches ONLY `intel_*` rows.
 */
@Injectable()
export class DataParityService {
  constructor(private readonly prisma: PrismaService) {}

  /** Bound-param tenant-scoped read, matching WatchlistSyncService's pattern. */
  private async legacyRows<T>(cols: string, table: string, tenantId: string | null): Promise<T[]> {
    return this.prisma.withSystem((tx) =>
      tenantId
        ? tx.$queryRawUnsafe<T[]>(`SELECT ${cols} FROM ${table} WHERE tenant_id = $1::uuid`, tenantId)
        : tx.$queryRawUnsafe<T[]>(`SELECT ${cols} FROM ${table}`),
    );
  }

  private legacyWatchlists(tenantId: string | null): Promise<LegacyWatchlistRow[]> {
    return this.legacyRows<LegacyWatchlistRow>(
      `client_id::text AS client_id, tenant_id::text AS tenant_id, issue_areas, tags, updated_by`,
      'client_watchlist',
      tenantId,
    );
  }

  private legacyTrackedBills(tenantId: string | null): Promise<LegacyTrackedBillRow[]> {
    return this.legacyRows<LegacyTrackedBillRow>(
      `client_id::text AS client_id, tenant_id::text AS tenant_id, bill_id, note, source,
       created_by, last_seen_action_text, last_seen_action_date, last_seen_at`,
      'tracked_bill',
      tenantId,
    );
  }

  /**
   * Legacy prefs with the SAME id-space translation the backfill applies
   * (users.id → users.clerk_user_id): parity must compare in the id space the
   * intel runtime actually reads. Rows whose user lacks a clerk id come back
   * with user_id=null-translated and are EXCLUDED here (they are skipped by
   * the backfill too); the caller reports their count as a note.
   */
  private async legacyAlertPrefsTranslated(
    tenantId: string | null,
  ): Promise<{ rows: LegacyAlertPrefRow[]; skippedNoClerkId: number }> {
    const cols = `ap.client_id::text AS client_id, ap.tenant_id::text AS tenant_id,
                  u.clerk_user_id AS user_id, ap.triggers, ap.materiality,
                  ap.email_enabled, ap.email_address, ap.email_cadence, ap.sms_enabled, ap.sms_phone,
                  ap.sms_phone_verified, ap.sms_cadence, ap.quiet_hours_start, ap.quiet_hours_end`;
    const from = `FROM alert_preference ap LEFT JOIN users u ON u.id = ap.user_id`;
    const all = await this.prisma.withSystem((tx) =>
      tenantId
        ? tx.$queryRawUnsafe<Array<LegacyAlertPrefRow & { user_id: string | null }>>(
            `SELECT ${cols} ${from} WHERE ap.tenant_id = $1::uuid`,
            tenantId,
          )
        : tx.$queryRawUnsafe<Array<LegacyAlertPrefRow & { user_id: string | null }>>(`SELECT ${cols} ${from}`),
    );
    const rows = all.filter((r): r is LegacyAlertPrefRow => Boolean(r.user_id));
    return { rows, skippedNoClerkId: all.length - rows.length };
  }

  /** Untranslated legacy prefs (raw user_id uuids) — snapshot use only. */
  private legacyAlertPrefsRaw(tenantId: string | null): Promise<LegacyAlertPrefRow[]> {
    return this.legacyRows<LegacyAlertPrefRow>(
      `client_id::text AS client_id, tenant_id::text AS tenant_id, user_id, triggers, materiality,
       email_enabled, email_address, email_cadence, sms_enabled, sms_phone, sms_phone_verified,
       sms_cadence, quiet_hours_start, quiet_hours_end`,
      'alert_preference',
      tenantId,
    );
  }

  /** Rebuild the sync's expanded-topic shape from persisted unified rows. */
  private async intelWatchlistHashes(tenantId: string | null): Promise<Map<string, string>> {
    const wls = await this.prisma.watchlist.findMany({
      where: { id: { startsWith: 'wl:' }, ...(tenantId ? { tenantId } : {}) },
      select: { id: true, clientId: true, issueAreas: true },
    });
    const out = new Map<string, string>();
    for (const wl of wls) {
      const topics = await this.prisma.watchlistTopic.findMany({
        where: { watchlistId: wl.id },
        select: { id: true, label: true, issueArea: true, position: true, priority: true },
      });
      const terms = topics.length
        ? await this.prisma.watchlistTerm.findMany({
            where: { topicId: { in: topics.map((t) => t.id) } },
            select: { topicId: true, termType: true, value: true },
          })
        : [];
      const expanded: ExpandedTopic[] = topics.map((t) => ({
        label: t.label,
        issueArea: t.issueArea,
        position: t.position as ExpandedTopic['position'],
        priority: t.priority as ExpandedTopic['priority'],
        terms: terms
          .filter((r) => r.topicId === t.id)
          .map((r) => ({ termType: r.termType as 'synonym' | 'entity' | 'risk', value: r.value })),
      }));
      out.set(wl.clientId, watchlistContentHash({ issueAreas: wl.issueAreas, topics: expanded }));
    }
    return out;
  }

  /** READ-ONLY data-parity run. `tenantSlugOrId` omitted = all tenants. */
  async run(tenantSlugOrId?: string): Promise<DataParityReport> {
    const sync = new WatchlistSyncService(this.prisma);
    const tenantId = tenantSlugOrId ? await sync.resolveTenantId(tenantSlugOrId) : null;
    if (tenantSlugOrId && !tenantId) throw new Error(`NO_TENANT_FOR ${tenantSlugOrId}`);

    const [legacyWls, legacyBills, legacyPrefsT, intelHashes, intelBills, intelPrefs] = await Promise.all([
      this.legacyWatchlists(tenantId),
      this.legacyTrackedBills(tenantId),
      this.legacyAlertPrefsTranslated(tenantId),
      this.intelWatchlistHashes(tenantId),
      this.prisma.trackedBill.findMany({
        where: tenantId ? { tenantId } : {},
        select: {
          clientId: true, tenantId: true, billId: true, note: true, isManual: true, trackedBy: true,
          lastSeenActionText: true, lastSeenActionDate: true, lastSeenAt: true,
        },
      }),
      this.prisma.intelAlertPreference.findMany({
        where: tenantId ? { tenantId } : {},
        select: {
          clientId: true, tenantId: true, userId: true, triggers: true, materiality: true,
          emailEnabled: true, emailAddress: true, emailCadence: true, smsEnabled: true,
          smsPhone: true, smsPhoneVerified: true, smsCadence: true, quietHoursStart: true, quietHoursEnd: true,
        },
      }),
    ]);

    const legacyHashes = new Map<string, string>();
    for (const cw of legacyWls) {
      const expanded = expandLegacyWatchlist(cw, normalizeIssueArea);
      legacyHashes.set(cw.client_id, watchlistContentHash(expanded));
    }

    const report = evaluateDataParity(
      tenantId ?? 'all',
      compareWatchlistHashes(legacyHashes, intelHashes),
      compareTrackedBills(legacyBills, intelBills),
      compareAlertPrefs(legacyPrefsT.rows, intelPrefs),
    );
    if (legacyPrefsT.skippedNoClerkId > 0) {
      report.notes = [
        ...(report.notes ?? []),
        `alertPrefs: ${legacyPrefsT.skippedNoClerkId} legacy row(s) skipped (user has no clerk_user_id — backfill skips these too)`,
      ];
    }
    return report;
  }

  /**
   * Dump the three legacy tables to logs as chunked JSON (the pre-migration
   * snapshot). Each chunk line is `SNAPSHOT_JSON {...}` well under the 256KB
   * CloudWatch event cap; the summary line carries row count + an md5 over the
   * canonical (PK-sorted) JSON so a re-run can prove the tables unchanged.
   */
  async snapshotLegacy(log: (msg: string) => void): Promise<void> {
    const CHUNK = 20;
    const dump = async (table: string, rows: Array<Record<string, unknown>>, pk: (r: Record<string, unknown>) => string) => {
      const sorted = [...rows].sort((a, b) => pk(a).localeCompare(pk(b)));
      const canonical = JSON.stringify(sorted);
      const md5 = createHash('md5').update(canonical).digest('hex');
      const of = Math.max(1, Math.ceil(sorted.length / CHUNK));
      for (let c = 0; c < of; c++) {
        log(`SNAPSHOT_JSON ${JSON.stringify({ table, chunk: c + 1, of, rows: sorted.slice(c * CHUNK, (c + 1) * CHUNK) })}`);
      }
      log(`SNAPSHOT_SUMMARY table=${table} rows=${sorted.length} md5=${md5}`);
    };

    const [wls, bills, prefs] = await Promise.all([
      this.legacyWatchlists(null),
      this.legacyTrackedBills(null),
      this.legacyAlertPrefsRaw(null),
    ]);
    // Contact PII (email/phone) is redacted from the DUMPED rows by default —
    // CloudWatch read access is broader than prod-DB access (SOC 2 review
    // finding, PR-1). The md5 is computed over the FULL canonical rows first,
    // so integrity remains checkable against the DB; legacy tables are never
    // modified by the cutover, so the redacted dump still serves as evidence
    // while the tables themselves remain the restore source.
    const redact = (rows: LegacyAlertPrefRow[]): Array<Record<string, unknown>> =>
      rows.map((r) => ({
        ...r,
        email_address: r.email_address ? `***@${r.email_address.split('@')[1] ?? '***'}` : null,
        sms_phone: r.sms_phone ? `***${r.sms_phone.slice(-2)}` : null,
      }));
    const prefsFull = prefs as unknown as Array<Record<string, unknown>>;
    const prefsPk = (r: Record<string, unknown>) => `${r.user_id}:${r.client_id}`;
    const prefsMd5 = createHash('md5')
      .update(JSON.stringify([...prefsFull].sort((a, b) => prefsPk(a).localeCompare(prefsPk(b)))))
      .digest('hex');
    await dump('client_watchlist', wls as unknown as Array<Record<string, unknown>>, (r) => `${r.tenant_id}:${r.client_id}`);
    await dump('tracked_bill', bills as unknown as Array<Record<string, unknown>>, (r) => `${r.client_id}:${r.bill_id}`);
    await dump('alert_preference', redact(prefs) as Array<Record<string, unknown>>, prefsPk);
    log(`SNAPSHOT_PII alert_preference redacted=true fullContentMd5=${prefsMd5}`);
    log(`SNAPSHOT_DONE tables=3 watchlists=${wls.length} trackedBills=${bills.length} alertPrefs=${prefs.length}`);
  }

  /**
   * Delete STALE intel-only tracker rows for tenants that are NOT intel-owned
   * (tracker_owner_intel off) and are not the always-on internal tenant —
   * i.e. rows whose legacy counterpart was deleted after a backfill, which
   * upserts but never deletes. DRY-RUN unless apply=true. Never touches
   * apps/api tables (D2) and never touches a flipped tenant's data (intel is
   * source of truth there).
   */
  async reconcile(
    opts: { apply: boolean; createdBefore?: string; force?: boolean },
    log: (msg: string) => void,
  ): Promise<{ bills: number; prefs: number; watchlists: number }> {
    const { apply, force } = opts;
    // GUARD 1 (rollback tripwire — review finding, PR-1): protection below is
    // keyed to CURRENT flag state, which has no memory of PREVIOUSLY-flipped
    // tenants. A disabled tracker_owner_intel row is evidence of a rollback —
    // those tenants' v2-era writes exist ONLY in intel_* and would look
    // "stale" here. Refuse to delete unless the operator forces it.
    const rolledBack = await this.prisma.featureFlag.count({
      where: { feature: 'tracker_owner_intel', enabled: false },
    });
    if (apply && rolledBack > 0 && !force) {
      throw new Error(
        `RECONCILE_REFUSED ${rolledBack} tenant(s) have tracker_owner_intel=disabled (rollback evidence): ` +
          `their v2-era writes have no legacy counterpart and would be deleted as "stale". ` +
          `reconcile-intel-tracker is a PRE-FIRST-FLIP tool. Pass --force=true only if you are ` +
          `certain no tenant ever ran with intel ownership.`,
      );
    }
    // GUARD 2: --apply requires an explicit createdAt cutoff (rows created at
    // or after it are never deleted). Set it to a timestamp BEFORE the first
    // flip so v2-native writes are structurally out of reach.
    const cutoff = opts.createdBefore ? new Date(opts.createdBefore) : null;
    if (apply && (!cutoff || Number.isNaN(cutoff.getTime()))) {
      throw new Error('RECONCILE_REFUSED --apply=true requires a valid --created-before=<ISO timestamp>');
    }
    // Protect the internal tenant by DB slug lookup, NOT only by env: the verb
    // task-def does not set CAPIRO_INTERNAL_TENANT_ID, and the internal tenant
    // writes v2-native rows during shadow that have no legacy counterpart —
    // deleting those would be silent data loss. Env kept as belt-and-braces.
    const internalRows = await this.prisma.withSystem((tx) =>
      tx.$queryRawUnsafe<Array<{ id: string }>>(`SELECT id::text AS id FROM tenants WHERE slug = 'capiro-internal'`),
    );
    const owned = await this.prisma.featureFlag.findMany({
      where: { feature: 'tracker_owner_intel', enabled: true },
      select: { tenantId: true },
    });
    const protectedTenants = new Set<string>(
      [
        ...owned.map((f) => f.tenantId),
        ...internalRows.map((r) => r.id),
        process.env.CAPIRO_INTERNAL_TENANT_ID ?? '',
      ].filter(Boolean),
    );

    const [legacyBills, legacyPrefsT, legacyWls] = await Promise.all([
      this.legacyTrackedBills(null),
      // Translated (clerk-id) space — the space backfilled intel rows live in.
      this.legacyAlertPrefsTranslated(null),
      this.legacyWatchlists(null),
    ]);
    const legacyBillKeys = new Set(legacyBills.map((r) => trackedBillKey(r.client_id, r.bill_id)));
    const legacyPrefKeys = new Set(legacyPrefsT.rows.map((r) => alertPrefKey(r.user_id, r.client_id)));
    const legacyWlClients = new Set(legacyWls.map((r) => r.client_id));
    const beforeCutoff = (createdAt: Date) => (cutoff ? createdAt.getTime() < cutoff.getTime() : true);

    const staleBills = (
      await this.prisma.trackedBill.findMany({
        select: { id: true, tenantId: true, clientId: true, billId: true, createdAt: true },
      })
    ).filter(
      (r) =>
        !protectedTenants.has(r.tenantId) &&
        beforeCutoff(r.createdAt) &&
        !legacyBillKeys.has(trackedBillKey(r.clientId, r.billId)),
    );
    const stalePrefs = (
      await this.prisma.intelAlertPreference.findMany({
        select: { id: true, tenantId: true, clientId: true, userId: true, createdAt: true },
      })
    ).filter(
      (r) =>
        !protectedTenants.has(r.tenantId) &&
        beforeCutoff(r.createdAt) &&
        !legacyPrefKeys.has(alertPrefKey(r.userId, r.clientId)),
    );
    const staleWls = (
      await this.prisma.watchlist.findMany({
        where: { id: { startsWith: 'wl:' } },
        select: { id: true, tenantId: true, clientId: true, createdAt: true },
      })
    ).filter(
      (r) => !protectedTenants.has(r.tenantId) && beforeCutoff(r.createdAt) && !legacyWlClients.has(r.clientId),
    );

    for (const b of staleBills) log(`RECONCILE_STALE tracked_bill ${b.tenantId} ${b.clientId}:${b.billId}`);
    for (const p of stalePrefs) log(`RECONCILE_STALE alert_pref ${p.tenantId} ${p.userId}:${p.clientId}`);
    for (const w of staleWls) log(`RECONCILE_STALE watchlist ${w.tenantId} ${w.id}`);

    if (apply) {
      if (staleBills.length)
        await this.prisma.trackedBill.deleteMany({ where: { id: { in: staleBills.map((r) => r.id) } } });
      if (stalePrefs.length)
        await this.prisma.intelAlertPreference.deleteMany({ where: { id: { in: stalePrefs.map((r) => r.id) } } });
      for (const w of staleWls) await this.prisma.watchlist.delete({ where: { id: w.id } }); // cascade topics/terms
    }
    log(
      `RECONCILE_DONE apply=${apply} cutoff=${cutoff ? cutoff.toISOString() : '(none — dry-run listing)'} ` +
        `bills=${staleBills.length} prefs=${stalePrefs.length} watchlists=${staleWls.length} ` +
        `protectedTenants=${protectedTenants.size}`,
    );
    return { bills: staleBills.length, prefs: stalePrefs.length, watchlists: staleWls.length };
  }
}
