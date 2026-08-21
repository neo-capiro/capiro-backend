/**
 * ScheduleCoordinatorService — Phase 8 Session 10.
 *
 * The orchestration loop Sessions 7 and 8 explicitly left for later: given an
 * instant, decide which of the 14 registered adapters are due, run each
 * through the existing `DefenseBudgetLifecycleWatcher.runAdapter`, and never
 * let one adapter's exception stop the loop driving the other thirteen.
 *
 * Everything about *how* a single adapter run is made safe — the atomic
 * lease, the seasonal + exponential backoff `next_check_at`, the content-sha
 * idempotency, the official-host refusal — stays exactly where Session 7 put
 * it, inside `runAdapter`. This service adds only the walk and the isolation
 * boundary around it, plus the rolling-horizon keep-alive Session 7 designed
 * to be called by "a scheduled controller run" (its own words) and that
 * nothing before this session has ever actually called on a recurring basis.
 *
 * Still dark: this service is invoked only by an explicit operator command
 * (`scripts/run-schedule-controller.mjs`) or a future caller that decides to
 * construct it. Nothing in this module or its NestJS registration installs a
 * timer, a `@Cron`, or an EventBridge rule — see `budget-lifecycle.module.ts`.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  buildScheduleTickSummary,
  evaluateAdapterDue,
  sanitizeScheduleFailureReason,
  type AdapterTickAttempt,
  type ScheduleTickSummary,
} from '@capiro/defense-domain';

import { AnnualDefenseBudgetCycleController } from '../annual-cycle-controller.service.js';
import { DefenseBudgetLifecycleWatcher } from '../lifecycle-watcher.service.js';
import { SourceAdapterRegistry } from '../source-adapter.registry.js';
import { SCHEDULE_AUDIT_STORE } from './schedule-audit.port.js';
import type { ScheduleAuditStore } from './schedule-audit.port.js';

export interface ScheduleTickOptions {
  readonly nowIso: string;
  readonly workerId: string;
  readonly tickKey: string;
  readonly leaseSeconds?: number;
  /** Dry-run reports every decision without persisting anything. */
  readonly commit: boolean;
}

export interface ScheduleTickResult {
  readonly summary: ScheduleTickSummary;
  readonly attempts: readonly AdapterTickAttempt[];
}

@Injectable()
export class ScheduleCoordinatorService {
  private readonly logger = new Logger(ScheduleCoordinatorService.name);

  constructor(
    private readonly registry: SourceAdapterRegistry,
    private readonly controller: AnnualDefenseBudgetCycleController,
    private readonly watcher: DefenseBudgetLifecycleWatcher,
    @Inject(SCHEDULE_AUDIT_STORE) private readonly auditStore: ScheduleAuditStore,
  ) {}

  async tick(options: ScheduleTickOptions): Promise<ScheduleTickResult> {
    const startedAt = options.nowIso;
    const adapterIds = this.registry.list().map((adapter) => adapter.adapterId);
    const attempts: AdapterTickAttempt[] = [];
    let tickFailureReason: string | null = null;

    // The rolling horizon is idempotent and cheap (a handful of upserts, no
    // network): Session 7 designed `ensureRollingHorizon` to be exactly what
    // "a scheduled controller run" calls. It failing must not block the
    // per-adapter work below — an unbootstrapped future year only matters
    // once a source for it actually appears, and the watcher already
    // self-heals that case via `ensureFromFirstDiscovery`.
    let horizonBootstrapped = false;
    try {
      await this.controller.ensureRollingHorizon({ nowIso: options.nowIso });
      horizonBootstrapped = true;
    } catch (error) {
      tickFailureReason = `rolling horizon bootstrap failed: ${sanitizeScheduleFailureReason(error)}`;
      this.logger.error(tickFailureReason);
    }

    // A scheduler that cannot read its own due-state must not go quiet and
    // silently skip every adapter forever: on a read failure every adapter
    // falls back to "no state recorded", which `evaluateAdapterDue` already
    // treats as due. Failing open to real (lease-guarded, idempotent) work is
    // the safe side of this failure; failing closed would be indistinguishable
    // from a scheduler nobody is running at all.
    let snapshots: ReadonlyMap<string, { nextCheckAt: string | null }> = new Map();
    try {
      snapshots = await this.auditStore.loadAdapterScheduleStates(adapterIds);
    } catch (error) {
      const reason = `could not load adapter schedule state: ${sanitizeScheduleFailureReason(error)}`;
      tickFailureReason = tickFailureReason ? `${tickFailureReason}; ${reason}` : reason;
      this.logger.error(reason);
    }

    for (const adapterId of adapterIds) {
      const decision = evaluateAdapterDue({
        adapterId,
        state: snapshots.get(adapterId) ?? null,
        nowIso: options.nowIso,
      });

      if (!decision.due) {
        attempts.push({ adapterId, outcome: 'skipped_not_due', detail: decision.reason });
        continue;
      }

      try {
        const result = await this.watcher.runAdapter({
          adapterId,
          nowIso: options.nowIso,
          leaseOwner: options.workerId,
          runKey: `${options.tickKey}:${adapterId}`,
          leaseSeconds: options.leaseSeconds,
          commit: options.commit,
        });

        if (result.status === 'skipped_not_leased') {
          attempts.push({
            adapterId,
            outcome: 'skipped_lease_lost',
            detail: 'another worker holds the lease, or lost the atomic acquisition race',
          });
        } else if (result.status === 'failed') {
          attempts.push({
            adapterId,
            outcome: 'ran_failed',
            detail: 'watcher run reported status=failed',
          });
        } else {
          attempts.push({
            adapterId,
            outcome: 'ran_succeeded',
            detail:
              `status=${result.status} discovered=${result.discovered} changed=${result.changed} ` +
              `queued=${result.queued} blocked=${result.blocked} nextCheckAt=${result.nextCheckAt}`,
          });
        }
      } catch (error) {
        // The actual net-new guarantee this service adds: one adapter's
        // exception must never stop the loop driving the other thirteen.
        const reason = sanitizeScheduleFailureReason(error);
        this.logger.error(`Adapter ${adapterId} threw during a scheduled run: ${reason}`);
        attempts.push({ adapterId, outcome: 'ran_failed', detail: reason });
      }
    }

    const finishedAt = new Date().toISOString();
    const summary = buildScheduleTickSummary({
      workerId: options.workerId,
      tickKey: options.tickKey,
      startedAt,
      finishedAt,
      horizonBootstrapped,
      adaptersConsidered: adapterIds.length,
      attempts,
      committed: options.commit,
      failureReason: tickFailureReason,
    });

    if (options.commit) {
      await this.auditStore.recordScheduleTick({ ...summary });
    }

    return Object.freeze({ summary, attempts: Object.freeze(attempts) });
  }
}
