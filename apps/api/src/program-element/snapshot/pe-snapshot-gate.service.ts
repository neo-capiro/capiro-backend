/**
 * Phase 7 Workstream M — the one place `ProgramElementReadService` decides
 * whether a given call is served from legacy tables or the active canonical
 * snapshot.
 *
 * Wraps three already-built, Nest-free primitives from
 * `defense-budget/promotion/` behind one Nest-injectable surface:
 * `resolveSnapshotReadModeV1` (the mode decision), a **fresh-per-call**
 * `createActiveSnapshotResolverV1` (the pointer resolution), and the
 * `PE_SNAPSHOT_READ_MODE` / `PE_SNAPSHOT_CANARY_TENANTS` config.
 *
 * `resolve()` is deliberately not cached on `this` across calls. The resolver
 * module's own docstring is explicit about why: a process-lifetime cache would
 * keep serving a superseded snapshot after an activation, trading "mixed" for
 * "stale," which is quieter and just as wrong. Every call to `resolve()`
 * constructs its own resolver and therefore does its own round trip — callers
 * that need more than one lookup inside a single method invocation must call
 * `resolve()` once and reuse the returned `activeSnapshot`/`decision`, not call
 * `resolve()` again partway through (see `assertOneSnapshotV1` at the point
 * rows are assembled for why a second resolution inside one response is the
 * failure mode this whole module exists to prevent).
 *
 * The environment currently falls back to NODE_ENV. A dedicated
 * PE_SNAPSHOT_ENVIRONMENT override is accepted directly from process.env so an
 * activation and the serving task can share one exact environment key even
 * when deployment naming (for example "dev") intentionally differs from
 * NODE_ENV (for example "production"). The fallback preserves today's inert
 * behavior until rollout explicitly sets the override.
 */
import { Inject, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../config/config.schema.js';
import {
  createActiveSnapshotResolverV1,
  type ActiveSnapshotV1,
  type SnapshotReadPortV1,
  type SnapshotRowQueryV1,
  type SnapshotCanonicalRowV1,
} from '../../defense-budget/promotion/snapshot-read-repository-v1.js';
import { resolveSnapshotReadModeV1 } from '../../defense-budget/promotion/snapshot-read-mode-v1.js';
import type { SnapshotReadDecisionV1 } from '../../defense-budget/promotion/snapshot-read-mode-v1.js';
import { SNAPSHOT_READ_PORT_V1 } from '../../defense-budget/promotion/snapshot-read-port.tokens.js';
import { resolveCanaryRollbackV1 } from '../../defense-budget/promotion/canary-controls-v1.js';
import { SLO_METRIC_RECORDER_V1 } from '../../defense-budget/promotion/slo-metrics.tokens.js';
import {
  NOOP_SLO_METRIC_RECORDER_V1,
  type SloMetricRecorderV1,
} from '../../defense-budget/promotion/slo-metrics-v1.js';
import { TenantContextStore } from '../../tenant/tenant-context.store.js';

const DEFENSE_BUDGET_DOMAIN = 'defense_budget';

export interface PeSnapshotGateResultV1 {
  decision: SnapshotReadDecisionV1;
  activeSnapshot: ActiveSnapshotV1 | null;
}

@Injectable()
export class PeSnapshotGateService {
  constructor(
    @Inject(SNAPSHOT_READ_PORT_V1) private readonly port: SnapshotReadPortV1,
    private readonly config: ConfigService<AppConfig, true>,
    @Optional()
    @Inject(SLO_METRIC_RECORDER_V1)
    private readonly sloMetrics: SloMetricRecorderV1 = NOOP_SLO_METRIC_RECORDER_V1,
    // TenantModule is global. Optional keeps direct-construction unit tests and
    // non-request/system callers working, but authenticated HTTP requests get
    // the already-verified tenant resolved by TenantContextMiddleware via ALS.
    @Optional() private readonly tenantContextStore?: TenantContextStore,
  ) {}

  private environment(): string {
    const explicit = process.env.PE_SNAPSHOT_ENVIRONMENT?.trim();
    return explicit && explicit.length > 0
      ? explicit
      : (this.config.get('NODE_ENV', { infer: true }) ?? 'development');
  }

  /**
   * Resolve the mode/pointer for one method invocation. Call this exactly once
   * per invocation and thread the result through every `loadRows` call that
   * invocation makes.
   *
   * Older Workstream-M callers pass `null` because they predate tenant-aware
   * canary routing. That must not mean "this authenticated request has no
   * tenant": use the request-scoped TenantContextStore as the fallback. An
   * explicit argument always wins, which keeps system/test callers
   * deterministic and prevents ambient context from overriding deliberate
   * scope.
   */
  async resolve(tenantId: string | null): Promise<PeSnapshotGateResultV1> {
    const effectiveTenantId = tenantId ?? this.tenantContextStore?.get()?.tenantId ?? null;
    const resolver = createActiveSnapshotResolverV1(
      this.port,
      DEFENSE_BUDGET_DOMAIN,
      this.environment(),
    );
    const activeSnapshot = await resolver.resolve();

    // Phase 7 Gap 5 decision C. Checked first and unconditionally: the whole
    // point of a rollback switch is that it does not depend on correctly
    // reasoning through resolveSnapshotReadModeV1's other branches to take
    // effect.
    const rollback = resolveCanaryRollbackV1({
      rollbackEngaged: this.config.get('PE_SNAPSHOT_CANARY_ROLLBACK', { infer: true }) === 'on',
    });
    if (rollback.forceLegacy) {
      return {
        decision: { serve: 'legacy', compare: false, reason: 'canary_rollback_engaged' },
        activeSnapshot,
      };
    }

    const configuredMode = this.config.get('PE_SNAPSHOT_READ_MODE', { infer: true });
    const canaryTenantIds = (this.config.get('PE_SNAPSHOT_CANARY_TENANTS', { infer: true }) ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id.length > 0);

    const decision = resolveSnapshotReadModeV1({
      configuredMode,
      tenantId: effectiveTenantId,
      canaryTenantIds,
      hasActiveSnapshot: activeSnapshot != null,
    });

    return { decision, activeSnapshot };
  }

  /**
   * The recorder plus the dimensions a *detached* emission needs.
   *
   * `schedulePeShadowComparisonV1` runs its comparison after the request that
   * scheduled it has already been answered, so by the time it emits there is no
   * ambient request to read a domain or environment off. Resolving them here
   * keeps one definition of both — the same `environment()` the pointer lookup
   * and the activation row use — instead of a second copy in the read service
   * that could drift from it.
   */
  sloDescriptor(): { recorder: SloMetricRecorderV1; domain: string; environment: string } {
    return {
      recorder: this.sloMetrics,
      domain: DEFENSE_BUDGET_DOMAIN,
      environment: this.environment(),
    };
  }

  /**
   * Thin passthrough so call sites don't need their own port injection.
   *
   * Phase 7 Gap 5 decision C: this is where `snapshot_read_latency_ms` is
   * measured. Every canonical row read on the PE surface goes through here, and
   * `resolve()`'s pointer lookup deliberately does not — a pointer lookup and a
   * row read have different shapes and different costs, and folding both into
   * one metric with no dimension to separate them would make the number
   * unreadable exactly when someone is using it to decide whether to widen the
   * canary.
   *
   * `mode` is the *configured* read mode, not the per-call resolved decision:
   * the resolved decision varies by tenant within `snapshot_canary`, and the
   * question this metric answers is "how does the snapshot read path perform at
   * this stage of the rollout". Timed in a finally, so a read that throws still
   * reports the latency it burned before failing.
   */
  async loadRows(query: SnapshotRowQueryV1): Promise<SnapshotCanonicalRowV1[]> {
    const startedAtMs = Date.now();
    try {
      return await this.port.loadRows(query);
    } finally {
      this.sloMetrics.record('snapshot_read_latency_ms', Date.now() - startedAtMs, {
        domain: DEFENSE_BUDGET_DOMAIN,
        environment: this.environment(),
        mode: this.config.get('PE_SNAPSHOT_READ_MODE', { infer: true }),
      });
    }
  }
}
