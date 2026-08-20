/**
 * Phase 7 Workstream M — the one place `ProgramElementReadService` decides
 * whether a given call is served from legacy tables or the active canonical
 * snapshot.
 *
 * The gate also owns the read-time manual-override overlay. Canonical rows stay
 * immutable; an independently approved correction is loaded beside the exact
 * selected rows and applied only to the returned read model, with the official
 * value preserved as provenance.
 */
import { Inject, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../config/config.schema.js';
import {
  assertOneSnapshotV1,
  createActiveSnapshotResolverV1,
  type ActiveSnapshotV1,
  type SnapshotReadPortV1,
  type SnapshotRowQueryV1,
} from '../../defense-budget/promotion/snapshot-read-repository-v1.js';
import {
  applyOverrideOverlayV1,
  inForceOverridesV1,
  type SnapshotReadRowV1,
} from '../../defense-budget/promotion/manual-override-overlay-v1.js';
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
    @Optional() private readonly tenantContextStore?: TenantContextStore,
  ) {}

  private environment(): string {
    const explicit = process.env.PE_SNAPSHOT_ENVIRONMENT?.trim();
    return explicit && explicit.length > 0
      ? explicit
      : (this.config.get('NODE_ENV', { infer: true }) ?? 'development');
  }

  async resolve(tenantId: string | null): Promise<PeSnapshotGateResultV1> {
    const effectiveTenantId = tenantId ?? this.tenantContextStore?.get()?.tenantId ?? null;
    const resolver = createActiveSnapshotResolverV1(
      this.port,
      DEFENSE_BUDGET_DOMAIN,
      this.environment(),
    );
    const activeSnapshot = await resolver.resolve();

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

  sloDescriptor(): { recorder: SloMetricRecorderV1; domain: string; environment: string } {
    return {
      recorder: this.sloMetrics,
      domain: DEFENSE_BUDGET_DOMAIN,
      environment: this.environment(),
    };
  }

  /**
   * Load one snapshot-scoped row set and apply every in-force governed override
   * whose target exactly matches those rows.
   *
   * The production Prisma port implements `loadManualOverridesForRows`; narrow
   * test/Phase8 adapters may omit it, in which case the returned rows still get
   * the explicit `override:null` / `officialMoney:null` shape rather than an
   * ambiguous partial read model.
   */
  async loadRows(query: SnapshotRowQueryV1): Promise<SnapshotReadRowV1[]> {
    const startedAtMs = Date.now();
    try {
      const canonical = await this.port.loadRows(query);
      assertOneSnapshotV1(canonical, query.snapshotId);

      const allOverrides = this.port.loadManualOverridesForRows
        ? await this.port.loadManualOverridesForRows(canonical)
        : [];
      const inForce = inForceOverridesV1(allOverrides, new Date());
      const overlaid = applyOverrideOverlayV1(canonical, inForce);

      // The repository only asks for exact targets from `canonical`, so an
      // unmatched result means the target identity changed between loading the
      // rows and loading the override, or an adapter violated the port contract.
      // Serving the uncorrected value would hide that governance drift.
      if (overlaid.unmatched.length > 0) {
        const ids = overlaid.unmatched.map((entry) => entry.provenance.overrideId).sort();
        throw new Error(
          `governed override target mismatch for snapshot ${query.snapshotId}: ${ids.join(', ')}`,
        );
      }
      return overlaid.rows;
    } finally {
      this.sloMetrics.record('snapshot_read_latency_ms', Date.now() - startedAtMs, {
        domain: DEFENSE_BUDGET_DOMAIN,
        environment: this.environment(),
        mode: this.config.get('PE_SNAPSHOT_READ_MODE', { infer: true }),
      });
    }
  }
}
