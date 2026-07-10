import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  FeatureFlagService,
  TRACKER_OWNER_FEATURE,
} from '../feature-flags/feature-flag.service.js';
import { IntelEmailService } from './intel-email.service.js';
import { toCanonicalAlert } from './canonical-alert.adapter.js';
import {
  clearsMateriality,
  type AlertSeverity,
  type IntelAlertEvent,
} from './intel-alert.types.js';

type Channel = 'email' | 'sms' | 'in_app';

/**
 * State-rail changeType groups that share a subscriber triggerKey (2026-07-10
 * hot-fix, D-2 cleanup) — see classifyStateStatusChange's STATE_STATUS_TRIGGER
 * table and classifyChange's changeType/triggerKey pairs in
 * change-detector.util.ts. Kept as a static, hand-verified table (rather than
 * reconstructed from the classifiers at runtime) because both sides are fixed
 * enum-like definitions, not data-dependent.
 */
const STATE_DOUBLE_EMIT_GROUPS: ReadonlyArray<{ coded: string[]; actionText: string[] }> = [
  {
    coded: [
      'state_bill_enacted',
      'state_bill_vetoed',
      'state_bill_failed',
      'state_bill_dead_by_deadline',
    ],
    actionText: ['bill_enacted', 'bill_to_president', 'bill_failed'],
  },
  {
    coded: [
      'state_bill_passed_chamber',
      'state_bill_floor',
      'state_bill_to_governor',
      'state_bill_veto_overridden',
      'state_bill_resolving',
    ],
    actionText: ['bill_passed_chamber', 'bill_rule_reported', 'bill_floor_scheduled'],
  },
  {
    coded: ['state_bill_reported'],
    actionText: ['bill_reported', 'bill_markup'],
  },
];
/** A same-cycle write pair lands milliseconds/seconds apart; two genuinely
 * distinct historical events sharing a triggerKey are separated by at least
 * one detection-cycle cadence (hours). 5 minutes is comfortably narrower than
 * any real cadence while covering any realistic same-cycle write latency. */
const COLLISION_WINDOW_MINUTES = 5;

export interface DedupeStateAlertCandidate {
  tenantId: string;
  clientId: string;
  sourceRef: string;
  keptId: string;
  keptChangeType: string;
  suppressId: string;
  suppressChangeType: string;
  suppressTitle: string;
}

/**
 * Unified alert delivery (Phase 4, plan §7) — SHADOW-FIRST.
 *
 * SINGLE-SENDER GUARANTEE (D5): a real send happens ONLY when a tenant is
 * `tracker_owner_intel`-owned AND the `TRACKER_ALERTS_ENABLED` kill-switch is
 * set. In shadow BOTH are off, so every path computes the would-send payload,
 * logs it (`shadow:true`), writes an idempotent `intel_notification_log` row
 * with status `suppressed_shadow`, and RETURNS before `email.send()`. Even the
 * always-owned internal tenant never sends, because the kill-switch is off.
 *
 * RLS (G3): per-tenant reads/writes go through `withTenant`; the cross-tenant
 * sweeps (emitNewBillAlerts scans all tenants' new bill alerts, flushDigests
 * drains the queue by cadence across tenants) go through `withSystem` and then
 * fan out per-tenant.
 */
@Injectable()
export class IntelAlertService {
  private readonly logger = new Logger(IntelAlertService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly flags: FeatureFlagService,
    private readonly email: IntelEmailService,
  ) {}

  static alertId(clientId: string, billId: string, changeType: string): string {
    return `tracker:${clientId}:${billId}:${changeType}`;
  }

  private killSwitchOff(): boolean {
    return !['true', '1', 'yes'].includes((process.env.TRACKER_ALERTS_ENABLED ?? '').toLowerCase());
  }

  /**
   * Claim a (alertId,userId,channel) notification slot. First delivery inserts
   * the log row and returns its id. A re-run hits the @@unique (P2002): if the
   * existing row is TERMINAL (`sent` / `suppressed_shadow`) → return null (skip,
   * no double-send); if it is a prior `failed`/`sending` (a soft failure or a
   * crashed mid-send) → reclaim it (flip to the new status) and return its id so
   * the send is retried. Without this, a soft failure permanently blocks the slot.
   */
  private async claim(
    tenantId: string,
    clientId: string,
    userId: string,
    alertId: string,
    channel: Channel,
    status: string,
  ): Promise<string | null> {
    try {
      const row = await this.prisma.withTenant(tenantId, (tx) =>
        tx.intelNotificationLog.create({
          data: { tenantId, clientId, userId, alertId, channel, status },
          select: { id: true },
        }),
      );
      return row.id;
    } catch (e) {
      if ((e as { code?: string }).code !== 'P2002') throw e;
      return this.prisma.withTenant(tenantId, async (tx) => {
        const existing = await tx.intelNotificationLog.findFirst({
          where: { alertId, userId, channel },
          select: { id: true, status: true },
        });
        if (!existing) return null; // vanished in a race — treat as claimed
        if (existing.status === 'sent' || existing.status === 'suppressed_shadow') return null;
        await tx.intelNotificationLog.update({ where: { id: existing.id }, data: { status } });
        return existing.id;
      });
    }
  }

  /**
   * Fan one alert out to every eligible pref for the client. In shadow: log +
   * claim `suppressed_shadow`, send nothing. Returns per-run counters.
   */
  async fanOut(event: IntelAlertEvent): Promise<{
    suppressed: number;
    sent: number;
    failed: number;
  }> {
    // Canonical 7-field Alert (SC1.1/SC1.2): map + LOG ONLY — completeness
    // flags surface the field gaps (whoActs/issueId/whyItMatters have no
    // tracker source yet) without ever touching the suppress/send branch.
    const canonical = toCanonicalAlert(event);
    if (!canonical.complete) {
      this.logger.log(
        JSON.stringify({
          canonicalAlertIncomplete: true,
          missingFields: canonical.missingFields,
          clientId: event.clientId,
          billId: event.billId,
          changeType: event.changeType,
        }),
      );
    }
    const owned = await this.flags.isEnabled(TRACKER_OWNER_FEATURE, event.tenantId);
    const canSend = owned && !this.killSwitchOff(); // shadow: false (kill-switch off)
    // Claim key = the specific intel_alert ROW id (unique per occurrence), NOT the
    // deterministic (client,bill,changeType). The composite would permanently
    // block any changeType that legitimately recurs after the 14-day dedup window
    // (its second row shares the composite → claim P2002 → never delivered). The
    // row id dedups per-occurrence AND still blocks a double-send of the SAME row.
    const alertId =
      event.alertRowId ?? IntelAlertService.alertId(event.clientId, event.billId, event.changeType);
    const prefs = await this.prisma.withTenant(event.tenantId, (tx) =>
      tx.intelAlertPreference.findMany({
        where: { tenantId: event.tenantId, clientId: event.clientId },
      }),
    );

    let suppressed = 0;
    let sent = 0;
    let failed = 0;
    for (const pref of prefs) {
      if (!pref.triggers.includes(event.triggerKey)) continue;
      if (!clearsMateriality(event.severity, pref.materiality)) continue;
      // DD5: empty jurisdictions = ALL jurisdictions the client's watchlist
      // produces (today's behavior, unchanged); non-empty = only those states
      // (+ always 'US' is just another entry, no implicit federal carve-out).
      if (
        pref.jurisdictions.length > 0 &&
        !pref.jurisdictions.includes(event.jurisdiction ?? 'US')
      ) {
        continue;
      }
      if (!(pref.emailEnabled && pref.emailAddress)) continue;

      const subject = `[Capiro] ${event.displayNum}: ${event.label}`;
      if (!canSend) {
        // SHADOW: compute + log the would-send, claim a suppressed row, send NOTHING.
        this.logger.log(
          JSON.stringify({
            shadow: true,
            tenantId: event.tenantId,
            clientId: event.clientId,
            alertId,
            channel: 'email',
            to: pref.emailAddress,
            subject,
            score: event.score ?? null,
            band: event.band ?? null,
            wouldSendAt: new Date().toISOString(),
          }),
        );
        await this.claim(
          event.tenantId,
          event.clientId,
          pref.userId,
          alertId,
          'email',
          'suppressed_shadow',
        );
        suppressed += 1;
        continue;
      }

      // owned && kill-switch on → real delivery (Phase 8 cutover ONLY).
      const logId = await this.claim(
        event.tenantId,
        event.clientId,
        pref.userId,
        alertId,
        'email',
        'sending',
      );
      if (logId) {
        const res = await this.email.send(pref.emailAddress, subject, `<p>${subject}</p>`, subject);
        await this.prisma.withTenant(event.tenantId, (tx) =>
          tx.intelNotificationLog.update({
            where: { id: logId },
            data: {
              status: res.sent ? 'sent' : 'failed',
              providerMessageId: res.messageId ?? null,
              error: res.error ?? null,
            },
          }),
        );
        // A soft failure (res.sent === false, no throw) is NOT delivered — count
        // it so emitNewBillAlerts leaves deliveredAt null and retries next sweep
        // (claim() reclaims the 'failed' log row rather than blocking it).
        if (res.sent) sent += 1;
        else failed += 1;
      }
    }
    return { suppressed, sent, failed };
  }

  /**
   * Read undelivered (`status='new'`, `deliveredAt=null`) bill alerts and fan
   * each out, then STAMP `deliveredAt` so the row is never reprocessed.
   *
   * Idempotency (plan §7 SC6) has two independent guards, both required:
   *  - `deliveredAt` (per alert ROW): set here after a clean fan-out, so the next
   *    sweep's `deliveredAt: null` filter skips it. Fixes the old gap where the
   *    filter was read but never written — every sweep re-processed every alert.
   *  - `intel_notification_log` @@unique (per RECIPIENT): the `claim()` guard, so
   *    even a concurrent/overlapping sweep can't double-send to one user.
   * Stamping in shadow is deliberate: it also stops a cutover (kill-switch flip)
   * from flooding a week of shadow-suppressed backlog as a single send storm.
   * A row is stamped ONLY if its fan-out didn't throw, so a transient failure
   * retries on the next sweep instead of being silently marked delivered.
   */
  async emitNewBillAlerts(): Promise<{
    alerts: number;
    suppressed: number;
    sent: number;
    failed: number;
  }> {
    // Cross-tenant emit sweep: reads NEW alerts across ALL tenants, then fanOut
    // re-scopes each to its own tenant. Under RLS this MUST bypass.
    //
    // Source-type scope is env-driven (default `bill` = historical behavior).
    // Widening to `bill,hearing,combined` sweeps the Phase-6 hearing/combined
    // alerts into the same delivery path — plan §8 decision 3 (Ninja's call at
    // cutover), a config flip, not a code change. Only bill alerts carry the full
    // evidence the fanOut event-map expects today; hearing/combined without a
    // valid `evidence.triggerKey` fall through the pref filter harmlessly.
    const sourceTypes = (process.env.LEGIWATCH_EMIT_SOURCE_TYPES ?? 'bill')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const rows = await this.prisma.withSystem((tx) =>
      tx.intelAlert.findMany({
        where: { sourceType: { in: sourceTypes }, status: 'new', deliveredAt: null },
        orderBy: { createdAt: 'asc' },
        take: 5000,
      }),
    );
    let suppressed = 0;
    let sent = 0;
    let failed = 0;
    for (const a of rows) {
      const ev = (a.evidence ?? {}) as Record<string, unknown>;
      const event: IntelAlertEvent = {
        tenantId: a.tenantId,
        clientId: a.clientId,
        alertRowId: a.id, // per-occurrence claim key (recurrences deliver; same row can't double-send)
        billId: a.sourceRef,
        displayNum: (ev.displayNum as string) ?? a.sourceRef,
        billTitle: (ev.billTitle as string) ?? a.title,
        changeType: a.changeType ?? a.kind,
        triggerKey: (ev.triggerKey as string) ?? a.kind,
        label: (ev.stage as string) ?? a.title,
        severity: a.severity as AlertSeverity,
        detail: (ev.actionText as string) ?? a.title,
        actionDate: (ev.actionDate as string) ?? null,
        url: (ev.url as string) ?? '',
        why: a.whyItMatters,
        matchedTags: (ev.matchedTags as string[]) ?? [],
        score: a.score,
        band: (ev.band as string) ?? undefined,
        jurisdiction: (ev.jurisdiction as string) ?? 'US',
      };
      try {
        const r = await this.fanOut(event);
        suppressed += r.suppressed;
        sent += r.sent;
        failed += r.failed;
        // Mark processed ONLY when no recipient's send soft-failed — otherwise
        // leave deliveredAt null so the next sweep retries (claim() reclaims the
        // 'failed' log row). A clean run (all sent, all suppressed, or no eligible
        // recipient) stamps and is never reprocessed.
        if (r.failed === 0) {
          await this.prisma.withTenant(a.tenantId, (tx) =>
            tx.intelAlert.update({ where: { id: a.id }, data: { deliveredAt: new Date() } }),
          );
        } else {
          this.logger.warn(
            `emit: alert ${a.id} (${a.sourceRef}) had ${r.failed} soft send failure(s); left undelivered for retry`,
          );
        }
      } catch (e) {
        failed += 1;
        this.logger.error(
          `emit fan-out failed for alert ${a.id} (${a.sourceRef}, tenant ${a.tenantId}); left undelivered for retry: ${(e as Error).message}`,
        );
      }
    }
    return { alerts: rows.length, suppressed, sent, failed };
  }

  /**
   * Idempotently turn LegiWatch-B's newly-default-on trigger keys on for EXISTING
   * subscribers who predate the emitters (fiscalNote, sponsorMomentum). Safe to
   * re-run and safe against deliberate opt-outs: these keys had no emitter before
   * B, so no subscriber could have intentionally removed them. Cross-tenant sweep
   * → `withSystem` (RLS bypass); `array_append` guarded by a `NOT (… = ANY …)`
   * predicate makes each key append exactly once. Returns rows touched.
   */
  async backfillDefaultTriggers(): Promise<{ updated: number }> {
    const NEWLY_DEFAULT_ON = ['fiscalNote', 'sponsorMomentum'];
    let updated = 0;
    for (const key of NEWLY_DEFAULT_ON) {
      const n = await this.prisma.withSystem((tx) =>
        tx.$executeRawUnsafe(
          `UPDATE intel_alert_preference
              SET triggers = array_append(triggers, $1)
            WHERE NOT ($1 = ANY(triggers))`,
          key,
        ),
      );
      updated += Number(n);
    }
    return { updated };
  }

  /**
   * (2026-07-10 hot-fix, D-2) One-time cleanup for the state-rail double-emit
   * bug fixed in bill-change-detector.service.ts's runStateDetectionCycle:
   * before the fix, a single status TRANSITION could write BOTH a correctly
   * classified coded alert (classifyStateStatusChange, changeType
   * `state_bill_*`) and a text-regex-derived alert (classifyChange,
   * changeType `bill_*`) sharing the same subscriber triggerKey — the latter
   * sometimes mislabeling the transition (e.g. a veto shown as "Failed /
   * rejected"). Finds (tenantId, clientId, sourceRef) groups where a coded
   * alert and a same-triggerKey-group action-text alert exist within
   * COLLISION_WINDOW_MINUTES of each other (a same-detection-cycle write —
   * NOT two genuinely distinct historical events that happen to share a
   * triggerKey weeks apart, which legitimately coexist) and marks the
   * action-text duplicate `status='suppressed'`. Soft — never hard-deletes,
   * fully reversible, preserves the audit trail — and never touches a row a
   * human has already reviewed/sent/dismissed/snoozed (status must still be
   * 'new'). DRY-RUN unless apply=true, mirroring
   * DataParityService.reconcile's dual-gate convention (report first, apply
   * only on explicit request).
   */
  async dedupeStateActionAlerts(
    opts: { apply: boolean },
    log: (msg: string) => void,
  ): Promise<{ candidates: DedupeStateAlertCandidate[]; suppressed: number }> {
    const rows = await this.prisma.withSystem((tx) =>
      tx.intelAlert.findMany({
        where: { sourceType: 'state_bill' },
        select: {
          id: true,
          tenantId: true,
          clientId: true,
          sourceRef: true,
          changeType: true,
          title: true,
          status: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'asc' },
      }),
    );

    const byKey = new Map<string, typeof rows>();
    for (const r of rows) {
      const key = `${r.tenantId}:${r.clientId}:${r.sourceRef}`;
      const arr = byKey.get(key) ?? [];
      arr.push(r);
      byKey.set(key, arr);
    }

    const candidates: DedupeStateAlertCandidate[] = [];
    for (const group of byKey.values()) {
      for (const groupDef of STATE_DOUBLE_EMIT_GROUPS) {
        const coded = group.filter((r) => r.changeType && groupDef.coded.includes(r.changeType));
        const actionText = group.filter(
          (r) => r.changeType && groupDef.actionText.includes(r.changeType),
        );
        for (const c of coded) {
          for (const a of actionText) {
            const deltaMs = Math.abs(c.createdAt.getTime() - a.createdAt.getTime());
            if (deltaMs <= COLLISION_WINDOW_MINUTES * 60 * 1000) {
              candidates.push({
                tenantId: c.tenantId,
                clientId: c.clientId,
                sourceRef: c.sourceRef,
                keptId: c.id,
                keptChangeType: c.changeType!,
                suppressId: a.id,
                suppressChangeType: a.changeType!,
                suppressTitle: a.title,
              });
            }
          }
        }
      }
    }

    for (const cand of candidates) {
      log(
        `DEDUPE_CANDIDATE tenant=${cand.tenantId} client=${cand.clientId} bill=${cand.sourceRef} ` +
          `keep=${cand.keptChangeType}(${cand.keptId}) suppress=${cand.suppressChangeType}(${cand.suppressId}) "${cand.suppressTitle}"`,
      );
    }

    let suppressed = 0;
    if (opts.apply && candidates.length) {
      const ids = candidates.map((c) => c.suppressId);
      const r = await this.prisma.withSystem((tx) =>
        tx.intelAlert.updateMany({
          where: { id: { in: ids }, status: 'new' },
          data: { status: 'suppressed' },
        }),
      );
      suppressed = r.count;
    }

    return { candidates, suppressed };
  }

  /**
   * Drain the digest queue for a cadence and deliver one summary per
   * (tenant,user,channel). Concurrency-safe via a claim-on-read (mark flushed in
   * the same UPDATE...RETURNING) so overlapping runs don't double-process
   * (plan §7.3a). In shadow nothing is enqueued (fanOut suppresses before
   * enqueue), so this drains 0 rows; the guard is enforced per group anyway.
   */
  async flushDigests(cadence: 'daily' | 'weekly'): Promise<{ flushed: number; sent: number }> {
    // Claim-on-read: atomically mark a batch flushed and return it, so a
    // concurrent run cannot grab the same rows (§7.3a). Cross-tenant drain by
    // cadence → withSystem (bypass RLS); the per-group send below re-checks the
    // per-tenant ownership flag.
    const claimed = await this.prisma.withSystem((tx) =>
      tx.$queryRawUnsafe<
        Array<{
          id: string;
          tenant_id: string;
          user_id: string;
          channel: string;
          client_id: string;
        }>
      >(
        `UPDATE intel_alert_digest_queue
          SET flushed = true
        WHERE id IN (
          SELECT id FROM intel_alert_digest_queue
           WHERE cadence = $1 AND flushed = false
           ORDER BY created_at ASC
           LIMIT 5000
           FOR UPDATE SKIP LOCKED
        )
      RETURNING id, tenant_id, user_id, channel, client_id`,
        cadence,
      ),
    );
    if (!claimed.length) return { flushed: 0, sent: 0 };

    let sent = 0;
    const groups = new Map<string, { tenantId: string; userId: string; clientId: string }>();
    for (const r of claimed) {
      groups.set(`${r.tenant_id}|${r.user_id}|${r.channel}`, {
        tenantId: r.tenant_id,
        userId: r.user_id,
        clientId: r.client_id,
      });
    }
    for (const g of groups.values()) {
      const owned = await this.flags.isEnabled(TRACKER_OWNER_FEATURE, g.tenantId);
      if (!(owned && !this.killSwitchOff())) continue; // shadow: suppress (already marked flushed)
      // Phase 8 real digest send would go here.
    }
    return { flushed: claimed.length, sent };
  }

  /**
   * Live shadow self-test (plan §7 S1/S2/S3): exercise the shadow suppress path
   * for a synthetic alert, proving it LOGS a would-send + writes a
   * `suppressed_shadow` row + sends nothing, without needing a real bill move.
   */
  async shadowSelftest(
    tenantId: string,
    clientId: string,
    email = 'selftest@example.com',
  ): Promise<{ suppressed: boolean; sent: number }> {
    const owned = await this.flags.isEnabled(TRACKER_OWNER_FEATURE, tenantId);
    const canSend = owned && !this.killSwitchOff();
    const alertId = IntelAlertService.alertId(clientId, 'selftest-bill', 'bill_amendment');
    const subject = '[Capiro] SELFTEST: shadow suppress';
    this.logger.log(
      JSON.stringify({
        shadow: true,
        selftest: true,
        tenantId,
        clientId,
        alertId,
        channel: 'email',
        to: email,
        subject,
        canSend,
        wouldSendAt: new Date().toISOString(),
      }),
    );
    if (canSend) {
      // Would be a real send at cutover; NOT exercised here (selftest asserts shadow).
      return { suppressed: false, sent: 0 };
    }
    await this.claim(tenantId, clientId, 'selftest-user', alertId, 'email', 'suppressed_shadow');
    return { suppressed: true, sent: 0 };
  }
}
