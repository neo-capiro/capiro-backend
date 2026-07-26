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
import { SourceDataRepository } from '../sourcedata/source-data.repository.js';
import {
  rendererFor,
  renderDigestEmail,
  appBaseUrl,
  type DigestItem,
} from '../tracker/tracker-email.templates.js';
import { AlertSummaryClient } from './alert-summary.client.js';
import { proceduralOutlook, proceduralStateFromAlert } from '../tracker/procedural-steps.js';

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
    private readonly sourceData: SourceDataRepository,
    private readonly summaryClient: AlertSummaryClient,
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
   * Claim (alertId,user,'email') AND insert the digest-queue row in ONE transaction,
   * so a crash between the two can never leave a 'queued' log row with no queue row
   * (which would suppress the alert forever). P2002 on the claim = already queued → no-op.
   */
  private async claimAndEnqueueDigest(
    tenantId: string,
    clientId: string,
    userId: string,
    alertId: string,
    cadence: 'daily' | 'weekly',
  ): Promise<boolean> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      try {
        await tx.intelNotificationLog.create({
          data: { tenantId, clientId, userId, alertId, channel: 'email', status: 'queued' },
        });
      } catch (e) {
        if ((e as { code?: string }).code === 'P2002') return false; // already queued/sent
        throw e;
      }
      await tx.intelAlertDigestQueue.create({
        data: { tenantId, clientId, userId, alertId, channel: 'email', cadence },
      });
      return true;
    });
  }

  /**
   * Fan one alert out to every eligible pref for the client. In shadow: log +
   * claim `suppressed_shadow`, send nothing. Returns per-run counters.
   */
  async fanOut(
    event: IntelAlertEvent,
    summaryCache?: Map<string, string | null>,
  ): Promise<{
    suppressed: number;
    sent: number;
    failed: number;
    queued: number;
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

    // A pref that clears every delivery filter. DD5: empty jurisdictions = ALL
    // jurisdictions the client's watchlist produces (today's behavior); non-empty
    // = only those states (+ 'US' is just another entry, no federal carve-out).
    const eligible = (pref: (typeof prefs)[number]): boolean =>
      pref.triggers.includes(event.triggerKey) &&
      clearsMateriality(event.severity, pref.materiality) &&
      (pref.jurisdictions.length === 0 ||
        pref.jurisdictions.includes(event.jurisdiction ?? 'US')) &&
      Boolean(pref.emailEnabled && pref.emailAddress);

    // "What happened" summary — generated ONLY when this event will actually be
    // delivered: canSend (owned + kill-switch on, so shadow tenants never burn
    // tokens) AND at least one recipient clears every filter. Delegated to
    // apps/api (intel-api has no in-process LLM); fail-soft (null → the email
    // just omits the line). apps/api owns the TRACKER_ALERT_SUMMARY flag + BYOK
    // key, so there's no flag here. The per-sweep cache dedupes IDENTICAL actions
    // (same summarize inputs) across clients tracking the same move; its key is
    // the FULL input signature — NOT (tenant,bill,changeType) — so two DISTINCT
    // actions that happen to share a changeType never reuse each other's text.
    if (canSend && this.summaryClient.configured && !event.summary && prefs.some(eligible)) {
      // §4.3: derive the allowed next steps DETERMINISTICALLY before asking the
      // model anything. An empty set is a real answer — the prompt then forbids
      // naming a next step at all, and apps/api drops a summary that names one
      // regardless. This is what stops a rejected governing rule being reported
      // as heading to a floor vote.
      const outlook = proceduralOutlook(
        proceduralStateFromAlert({
          changeType: event.changeType,
          jurisdiction: event.jurisdiction,
        }),
      );
      const summaryInput = {
        tenantId: event.tenantId,
        displayNum: event.displayNum,
        billTitle: event.billTitle,
        label: event.label,
        actionText: event.detail,
        allowedNextSteps: outlook.nextPossibleSteps,
        blockedBy: outlook.blockedBy,
      };
      const key = [
        summaryInput.tenantId,
        summaryInput.displayNum,
        summaryInput.billTitle,
        summaryInput.label,
        summaryInput.actionText,
        // The outlook is part of the prompt, so it is part of the cache
        // identity: two events with identical text but different allowed steps
        // must not reuse each other's summary.
        summaryInput.allowedNextSteps.join('|'),
        summaryInput.blockedBy.join('|'),
      ].join('\u0000'); // NUL delimiter -> collision-free even if a field value contains it
      if (summaryCache?.has(key)) {
        event.summary = summaryCache.get(key) ?? null;
      } else {
        const summary = await this.summaryClient.summarize(summaryInput);
        event.summary = summary;
        summaryCache?.set(key, summary);
      }
    }

    let suppressed = 0;
    let sent = 0;
    let failed = 0;
    let queued = 0;
    // Rendered once per event (not per-pref — content doesn't vary by recipient).
    // P1-07: a source with no registered renderer is not emailable. Return
    // all-zeros (not `failed`) so emitNewBillAlerts still stamps deliveredAt
    // (:failed === 0) instead of retrying an alert that can never render.
    const render = rendererFor(event.sourceType);
    if (!render) {
      this.logger.warn(
        `fanOut: no email renderer for sourceType='${event.sourceType}' (alert ${alertId}); skipping email delivery`,
      );
      return { suppressed: 0, sent: 0, failed: 0, queued: 0 };
    }
    const rendered = render(event);
    for (const pref of prefs) {
      if (!eligible(pref)) continue;

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
            subject: rendered.subject,
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

      // P0-02: honor pref.emailCadence. realtime → send now; daily/weekly → enqueue
      // an immutable alert reference for flushDigests. Reached only when canSend,
      // so shadow still suppresses BEFORE enqueue (no cutover backlog).
      const cadence = (pref.emailCadence ?? 'realtime').toLowerCase();
      if (cadence === 'daily' || cadence === 'weekly') {
        if (await this.claimAndEnqueueDigest(event.tenantId, event.clientId, pref.userId, alertId, cadence)) {
          queued += 1;
        }
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
        // eligible() already guaranteed emailAddress is a non-empty string; the
        // assertion just restores the narrowing the extracted predicate hid.
        const res = await this.email.send(
          pref.emailAddress!,
          rendered.subject,
          rendered.html,
          rendered.text,
        );
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
    return { suppressed, sent, failed, queued };
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
    queued: number;
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
    // Batch-resolve client display names per tenant (one query per tenant, not
    // per alert) — mirrors feed.service.ts's existing getClientNames pattern.
    // A name that can't be resolved just omits the "· {client}" parts of the
    // rendered email; it never blocks delivery.
    const clientIdsByTenant = new Map<string, Set<string>>();
    for (const r of rows) {
      const set = clientIdsByTenant.get(r.tenantId) ?? new Set<string>();
      set.add(r.clientId);
      clientIdsByTenant.set(r.tenantId, set);
    }
    const clientNamesByTenant = new Map<string, Map<string, string>>();
    for (const [tenantId, clientIds] of clientIdsByTenant) {
      clientNamesByTenant.set(
        tenantId,
        await this.sourceData
          .getClientNames(tenantId, Array.from(clientIds))
          .catch(() => new Map<string, string>()),
      );
    }

    // One "what happened" summary per (tenant,bill,changeType) per sweep, shared
    // by every client tracking the same bill — don't re-spend the tenant's key.
    const summaryCache = new Map<string, string | null>();

    let suppressed = 0;
    let sent = 0;
    let failed = 0;
    let queued = 0;
    for (const a of rows) {
      const ev = (a.evidence ?? {}) as Record<string, unknown>;
      const event: IntelAlertEvent = {
        tenantId: a.tenantId,
        clientId: a.clientId,
        clientName: clientNamesByTenant.get(a.tenantId)?.get(a.clientId) ?? null,
        alertRowId: a.id, // per-occurrence claim key (recurrences deliver; same row can't double-send)
        billId: a.sourceRef,
        displayNum: (ev.displayNum as string) ?? a.sourceRef,
        billTitle: (ev.billTitle as string) ?? a.title,
        changeType: a.changeType ?? a.kind,
        triggerKey: (ev.triggerKey as string) ?? a.kind,
        label: (ev.stage as string) ?? a.title,
        tone: (ev.tone as string) ?? undefined,
        severity: a.severity as AlertSeverity,
        detail: (ev.actionText as string) ?? a.title,
        actionDate: (ev.actionDate as string) ?? null,
        url: (ev.url as string) ?? '',
        why: a.whyItMatters,
        matchedTags: (ev.matchedTags as string[]) ?? [],
        score: a.score,
        band: (ev.band as string) ?? undefined,
        jurisdiction: (ev.jurisdiction as string) ?? 'US',
        sourceType: a.sourceType,
        appUrl: `${appBaseUrl()}/legiwatch?tab=feed&client=${encodeURIComponent(a.clientId)}`,
      };
      try {
        const r = await this.fanOut(event, summaryCache);
        suppressed += r.suppressed;
        sent += r.sent;
        failed += r.failed;
        queued += r.queued;
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
    return { alerts: rows.length, suppressed, sent, failed, queued };
  }

  /**
   * Idempotently turn LegiWatch-B's newly-default-on trigger keys on for
   * EXISTING subscribers who predate the emitters (fiscalNote, sponsorMomentum,
   * deadline). Safe to re-run and safe against deliberate opt-outs: these keys
   * had no emitter before their respective PRs, so no subscriber could have
   * intentionally removed them. Cross-tenant sweep → `withSystem` (RLS bypass);
   * `array_append` guarded by a `NOT (… = ANY …)` predicate makes each key
   * append exactly once. Returns rows touched.
   *
   * 2026-07-10 (W2.1, D-7): `companion` deliberately EXCLUDED — unlike the 3
   * keys above, its emitter shipped in Phase-0 (#374) BEFORE this backfill was
   * ever written, so a subscriber who ran with `companion` on and explicitly
   * opted out since then is indistinguishable, from this predicate alone, from
   * one who never had it. Backfilling it here would silently override that
   * opt-out. New subscribers already get `companion` from DEFAULT_TRIGGERS;
   * only a genuinely-pre-#374 row needs it, and this verb can no longer tell
   * the two apart safely, so it no longer tries.
   */
  async backfillDefaultTriggers(): Promise<{ updated: number }> {
    const NEWLY_DEFAULT_ON = ['fiscalNote', 'sponsorMomentum', 'deadline'];
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
   *
   * Idempotency contract (P0-02):
   *  - Re-running immediately after a successful flush claims nothing
   *    (`flushed = true`) → `{0,0,0,0,0}`.
   *  - Re-running after a failed flush re-claims the same rows (reset to
   *    `flushed = false` by the failure-compensation branch below) and
   *    retries, up to `maxAttempts`.
   *  - A crash between claim and send leaves rows `flushed = true` with
   *    `delivered_at IS NULL` — a STRANDED state, deliberately NOT
   *    auto-reset here (a crash-loop must not self-heal into an infinite
   *    retry). `recoverStrandedDigests` (d-7) is the diag-only recovery verb.
   *  - A digest queue row for a pref whose cadence has since changed to
   *    `realtime` still flushes as a digest — re-reading cadence at flush
   *    time would strand the row instead, which is worse.
   *  - A digest queue row for a pref that has since been deleted or had
   *    email disabled is skipped at step 5 below; it stays `flushed = true`,
   *    `delivered_at IS NULL` (stranded, intentionally — a human should see
   *    it via `recover-stranded-digests`'s dry run, not have it silently
   *    resurrected).
   */
  async flushDigests(cadence: 'daily' | 'weekly'): Promise<{
    flushed: number;
    sent: number;
    failed: number;
    deadLettered: number;
    unresolvable: number;
  }> {
    const maxAttempts = Number(process.env.LEGIWATCH_DIGEST_MAX_ATTEMPTS ?? '5');
    // Claim-on-read: atomically mark a batch flushed and return it, so a
    // concurrent run cannot grab the same rows (§7.3a). Cross-tenant drain by
    // cadence → withSystem (bypass RLS); the per-group send below re-checks the
    // per-tenant ownership flag. `attempts < maxAttempts` excludes dead-lettered
    // rows from ever being re-claimed.
    const claimed = await this.prisma.withSystem((tx) =>
      tx.$queryRawUnsafe<
        Array<{
          id: string;
          tenant_id: string;
          user_id: string;
          channel: string;
          client_id: string;
          alert_id: string;
        }>
      >(
        `UPDATE intel_alert_digest_queue
            SET flushed = true
          WHERE id IN (
            SELECT id FROM intel_alert_digest_queue
             WHERE cadence = $1 AND flushed = false AND attempts < $2
             ORDER BY created_at ASC
             LIMIT 5000
             FOR UPDATE SKIP LOCKED
          )
        RETURNING id, tenant_id, user_id, channel, client_id, alert_id`,
        cadence,
        maxAttempts,
      ),
    );
    if (!claimed.length) return { flushed: 0, sent: 0, failed: 0, deadLettered: 0, unresolvable: 0 };

    let sent = 0;
    let failed = 0;
    let deadLettered = 0;
    let unresolvable = 0;

    interface QueueRow {
      queueId: string;
      alertId: string;
    }
    // Grouped by (tenant,user,channel) — NOT client — because one recipient's
    // digest can legitimately span several clients they track; d-5's renderer
    // groups the rendered items back out by client within the single email.
    // `clientId` on the group is therefore only a REPRESENTATIVE value (the
    // last-seen row's), used for the step-5 pref lookup below — matching this
    // method's pre-existing grouping shape. A user with genuinely different
    // per-client email prefs (schema allows it) gets one representative pref
    // for the whole group; that limitation predates this rewrite.
    const groups = new Map<
      string,
      { tenantId: string; userId: string; clientId: string; rows: QueueRow[] }
    >();
    for (const r of claimed) {
      const key = `${r.tenant_id}|${r.user_id}|${r.channel}`;
      const g = groups.get(key) ?? {
        tenantId: r.tenant_id,
        userId: r.user_id,
        clientId: r.client_id,
        rows: [],
      };
      g.clientId = r.client_id;
      g.rows.push({ queueId: r.id, alertId: r.alert_id });
      groups.set(key, g);
    }

    const appBase = (process.env.TRACKER_APP_BASE_URL ?? 'https://app.capiro.ai').replace(/\/$/, '');

    for (const g of groups.values()) {
      const queueIds = g.rows.map((r) => r.queueId);
      try {
        const owned = await this.flags.isEnabled(TRACKER_OWNER_FEATURE, g.tenantId);
        if (!(owned && !this.killSwitchOff())) continue; // shadow/not-owned: rows stay flushed=true, no accumulation

        // The queue carries no payload — re-read the alerts by row id.
        const alertIds = g.rows.map((r) => r.alertId);
        const alerts = await this.prisma.withTenant(g.tenantId, (tx) =>
          tx.intelAlert.findMany({ where: { tenantId: g.tenantId, id: { in: alertIds } } }),
        );
        const alertById = new Map(alerts.map((a) => [a.id, a]));

        const resolvedRows: QueueRow[] = [];
        let groupUnresolvable = 0;
        for (const row of g.rows) {
          if (alertById.has(row.alertId)) {
            resolvedRows.push(row);
          } else {
            // A composite-string alert_id (a fanOut caller that omitted
            // alertRowId) will never resolve. Never retried — leave flushed=true.
            groupUnresolvable += 1;
            this.logger.warn(
              JSON.stringify({ digestUnresolvableAlertId: row.queueId, alertId: row.alertId }),
            );
          }
        }
        if (groupUnresolvable > 0) {
          unresolvable += groupUnresolvable;
          this.logger.warn(
            `flushDigests: ${groupUnresolvable} unresolvable alert id(s) for tenant=${g.tenantId} user=${g.userId}`,
          );
        }
        if (!resolvedRows.length) continue;

        const clientIds = Array.from(
          new Set(resolvedRows.map((r) => alertById.get(r.alertId)!.clientId)),
        );
        const clientNames = await this.sourceData
          .getClientNames(g.tenantId, clientIds)
          .catch(() => new Map<string, string>());

        // Same field map as emitNewBillAlerts (:373-395): ev.* from the frozen
        // evidence snapshot, falling back to the alert row's own columns.
        const items: DigestItem[] = resolvedRows.map((row) => {
          const a = alertById.get(row.alertId)!;
          const ev = (a.evidence ?? {}) as Record<string, unknown>;
          const actionDate = (ev.actionDate as string) ?? null;
          return {
            clientName: clientNames.get(a.clientId) ?? null,
            displayNum: (ev.displayNum as string) ?? a.sourceRef,
            billTitle: (ev.billTitle as string) ?? a.title,
            label: (ev.stage as string) ?? a.title,
            severity: a.severity,
            detail: (ev.actionText as string) ?? a.title,
            actionDate,
            // "deadline ← actionDate" mirrors the existing canonical-alert.adapter.ts convention.
            deadline: actionDate,
            recommendedAction: a.recommendedAction ?? null,
            why: a.whyItMatters,
            url: (ev.url as string) ?? '',
            appUrl: `${appBase}/clients/${encodeURIComponent(a.clientId)}?tab=tracker`,
          };
        });
        if (!items.length) continue;

        const pref = await this.prisma.withTenant(g.tenantId, (tx) =>
          tx.intelAlertPreference.findFirst({
            where: { tenantId: g.tenantId, userId: g.userId, clientId: g.clientId },
          }),
        );
        if (!(pref?.emailEnabled && pref.emailAddress)) continue; // stranded intentionally — see doc comment

        const { subject, html, text } = renderDigestEmail(cadence, items);
        const res = await this.email.send(pref.emailAddress, subject, html, text);
        const sentAlertIds = resolvedRows.map((r) => r.alertId);

        if (res.sent) {
          sent += 1;
          await this.prisma.withSystem((tx) =>
            tx.$executeRawUnsafe(
              `UPDATE intel_alert_digest_queue SET delivered_at = now() WHERE id = ANY($1)`,
              queueIds,
            ),
          );
          await this.prisma.withTenant(g.tenantId, (tx) =>
            tx.intelNotificationLog.updateMany({
              where: {
                tenantId: g.tenantId,
                userId: g.userId,
                channel: 'email',
                alertId: { in: sentAlertIds },
                status: 'queued',
              },
              data: { status: 'sent' },
            }),
          );
        } else {
          failed += 1;
          await this.prisma.withSystem((tx) =>
            tx.$executeRawUnsafe(
              `UPDATE intel_alert_digest_queue
                  SET flushed = false, attempts = attempts + 1, last_error = $2
                WHERE id = ANY($1)`,
              queueIds,
              (res.error ?? 'unknown').slice(0, 500),
            ),
          );
          const after = await this.prisma.withSystem((tx) =>
            tx.$queryRawUnsafe<Array<{ id: string; attempts: number }>>(
              `SELECT id, attempts FROM intel_alert_digest_queue WHERE id = ANY($1)`,
              queueIds,
            ),
          );
          const nowDead = after.filter((r) => r.attempts >= maxAttempts);
          if (nowDead.length) {
            deadLettered += 1;
            this.logger.error(
              JSON.stringify({
                digestDeadLettered: true,
                tenantId: g.tenantId,
                userId: g.userId,
                cadence,
                ids: nowDead.map((r) => r.id),
              }),
            );
            // Dead-lettered rows are never re-claimed (attempts < maxAttempts
            // filter above); flip the log rows so claim() can reclaim them if
            // the user's cadence later changes to realtime.
            await this.prisma.withTenant(g.tenantId, (tx) =>
              tx.intelNotificationLog.updateMany({
                where: {
                  tenantId: g.tenantId,
                  userId: g.userId,
                  channel: 'email',
                  alertId: { in: sentAlertIds },
                  status: 'queued',
                },
                data: { status: 'failed' },
              }),
            );
          }
        }
      } catch (e) {
        // One recipient's failure must not abort the sweep — same step-9
        // compensation as an explicit send failure.
        failed += 1;
        this.logger.error(
          `flushDigests group failed (tenant=${g.tenantId} user=${g.userId}, cadence=${cadence}): ${(e as Error).message}`,
        );
        await this.prisma
          .withSystem((tx) =>
            tx.$executeRawUnsafe(
              `UPDATE intel_alert_digest_queue
                  SET flushed = false, attempts = attempts + 1, last_error = $2
                WHERE id = ANY($1)`,
              queueIds,
              String((e as Error).message).slice(0, 500),
            ),
          )
          .catch(() => undefined);
      }
    }
    return { flushed: claimed.length, sent, failed, deadLettered, unresolvable };
  }

  /**
   * DRY-RUN by default (mirrors dedupeStateActionAlerts's dual gate). A row
   * with `flushed = true` and `delivered_at IS NULL` older than
   * `olderThanMinutes` was claimed by a `flushDigests` run that crashed before
   * reaching a send outcome (success or the failure-compensation branch) —
   * this resets it to `flushed = false` so the next `flushDigests` naturally
   * re-claims it. `attempts` is left untouched here (a stranded-row recovery
   * is not itself a send failure); the next real attempt increments it only
   * if that attempt fails. Excludes rows already at `attempts >= maxAttempts`
   * — those are dead-lettered by design and must not be silently resurrected.
   */
  async recoverStrandedDigests(
    opts: { apply: boolean; olderThanMinutes?: number },
    log: (msg: string) => void,
  ): Promise<{ candidates: number; reset: number }> {
    const maxAttempts = Number(process.env.LEGIWATCH_DIGEST_MAX_ATTEMPTS ?? '5');
    const olderThanMinutes = opts.olderThanMinutes ?? 60;
    const candidates = await this.prisma.withSystem((tx) =>
      tx.$queryRawUnsafe<
        Array<{
          id: string;
          tenant_id: string;
          user_id: string;
          cadence: string;
          attempts: number;
          created_at: Date;
        }>
      >(
        `SELECT id, tenant_id, user_id, cadence, attempts, created_at
           FROM intel_alert_digest_queue
          WHERE flushed = true
            AND delivered_at IS NULL
            AND attempts < $1
            AND created_at < now() - ($2 || ' minutes')::interval`,
        maxAttempts,
        String(olderThanMinutes),
      ),
    );

    for (const cand of candidates) {
      log(
        `STRANDED_DIGEST_CANDIDATE id=${cand.id} tenant=${cand.tenant_id} user=${cand.user_id} ` +
          `cadence=${cand.cadence} attempts=${cand.attempts} createdAt=${cand.created_at.toISOString()}`,
      );
    }

    let reset = 0;
    if (opts.apply && candidates.length) {
      const ids = candidates.map((c) => c.id);
      const r = await this.prisma.withSystem((tx) =>
        tx.$executeRawUnsafe(
          `UPDATE intel_alert_digest_queue SET flushed = false WHERE id = ANY($1)`,
          ids,
        ),
      );
      reset = Number(r);
    }

    return { candidates: candidates.length, reset };
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
