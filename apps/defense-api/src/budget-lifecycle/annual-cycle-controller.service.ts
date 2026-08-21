/**
 * AnnualDefenseBudgetCycleController.
 *
 * Owns cycle bootstrap, expected-source state and closeout. The point of this
 * service is that FY28, FY29 and every later cycle need no engineer: given the
 * clock and a governed template version it creates every track's cycle and the
 * full expected-source set, and it keeps the rolling horizon moving on its own.
 *
 * Dark in Session 7: no controller, no route, no schedule, no snapshot
 * promotion, no production ownership change.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  DEFENSE_BUDGET_CYCLE_TEMPLATE_VERSION,
  bootstrapCycleFromFirstDiscovery,
  bootstrapFiscalYearCycle,
  expectedSourceFundingPosition,
  resolveUnobservedExpectedState,
  rollingCycleHorizon,
  type AuthorityTrack,
  type BootstrapCycleResult,
  type ExpectedSourceState,
} from '@capiro/defense-domain';

import { LIFECYCLE_STORE } from './lifecycle.tokens.js';
import type { LifecycleStore, StoredExpectedSource } from './lifecycle-ports.js';

export interface CycleBootstrapSummary {
  readonly fiscalYear: number;
  readonly templateVersion: string;
  readonly bootstrapOrigin: 'discovery' | 'template' | 'operator';
  readonly cyclesEnsured: number;
  readonly expectedSourcesEnsured: number;
  readonly tracks: readonly AuthorityTrack[];
}

@Injectable()
export class AnnualDefenseBudgetCycleController {
  private readonly logger = new Logger(AnnualDefenseBudgetCycleController.name);

  constructor(@Inject(LIFECYCLE_STORE) private readonly store: LifecycleStore) {}

  /**
   * Ensure a fiscal year exists across every track, with its complete expected
   * source set. Idempotent: re-running never resets an already-observed state.
   */
  async ensureFiscalYear(input: {
    fiscalYear: number;
    templateVersion?: string;
    bootstrapOrigin?: 'discovery' | 'template' | 'operator';
  }): Promise<CycleBootstrapSummary> {
    const plan = bootstrapFiscalYearCycle({
      fiscalYear: input.fiscalYear,
      templateVersion: input.templateVersion ?? DEFENSE_BUDGET_CYCLE_TEMPLATE_VERSION,
      bootstrapOrigin: input.bootstrapOrigin ?? 'template',
    });
    return this.apply(plan);
  }

  /**
   * Keep the rolling prior/current/upcoming horizon populated. This is what a
   * scheduled controller run calls; it never asks a human which years exist.
   */
  async ensureRollingHorizon(input: {
    nowIso: string;
    priorYears?: number;
    upcomingYears?: number;
    templateVersion?: string;
  }): Promise<readonly CycleBootstrapSummary[]> {
    const years = rollingCycleHorizon(input.nowIso, {
      priorYears: input.priorYears ?? 1,
      upcomingYears: input.upcomingYears ?? 1,
    });
    const summaries: CycleBootstrapSummary[] = [];
    for (const fiscalYear of years) {
      summaries.push(
        await this.ensureFiscalYear({
          fiscalYear,
          templateVersion: input.templateVersion,
          bootstrapOrigin: 'template',
        }),
      );
    }
    return Object.freeze(summaries);
  }

  /**
   * A first authoritative source for a fiscal year we have never seen creates
   * that year's cycles from templates. Discovery-driven bootstrap: the watcher
   * calls this instead of failing on an unknown FY.
   */
  async ensureFromFirstDiscovery(input: {
    fiscalYear: number;
    authorityTrack: AuthorityTrack;
    templateVersion?: string;
  }): Promise<CycleBootstrapSummary> {
    const plan = bootstrapCycleFromFirstDiscovery({
      fiscalYear: input.fiscalYear,
      authorityTrack: input.authorityTrack,
      templateVersion: input.templateVersion,
    });
    this.logger.log(
      `Bootstrapping FY${input.fiscalYear} from first authoritative ${input.authorityTrack} discovery`,
    );
    return this.apply(plan);
  }

  private async apply(plan: BootstrapCycleResult): Promise<CycleBootstrapSummary> {
    const cycleIdByTrack = new Map<AuthorityTrack, string>();
    for (const cycle of plan.cycles) {
      const stored = await this.store.upsertCycle({
        fiscalYear: cycle.fiscalYear,
        authorityTrack: cycle.authorityTrack,
        templateVersion: cycle.templateVersion,
        bootstrapOrigin: cycle.bootstrapOrigin,
        dedupKey: cycle.dedupKey,
      });
      cycleIdByTrack.set(cycle.authorityTrack, stored.id);
    }

    let expectedSourcesEnsured = 0;
    for (const expected of plan.expectedSources) {
      const cycleId = cycleIdByTrack.get(expected.authorityTrack);
      if (!cycleId) {
        throw new Error(
          `Template produced an expected source on unbootstrapped track ${expected.authorityTrack}`,
        );
      }
      await this.store.upsertExpectedSource({
        cycleId,
        plan: {
          dedupKey: expected.dedupKey,
          fiscalYear: expected.fiscalYear,
          authorityTrack: expected.authorityTrack,
          stage: expected.stage,
          sourceFamily: expected.sourceFamily,
          adapterId: expected.adapterId,
          expectedState: expected.expectedState,
          optional: expected.optional,
          expectedTo: expected.expectedTo,
          chamber: expected.chamber,
          committee: expected.committee,
          component: expected.component,
          label: expected.label,
          templateVersion: expected.templateVersion,
          expectedFrom: expected.expectedFrom,
        },
      });
      expectedSourcesEnsured += 1;
    }

    return Object.freeze({
      fiscalYear: plan.fiscalYear,
      templateVersion: plan.templateVersion,
      bootstrapOrigin: plan.bootstrapOrigin,
      cyclesEnsured: plan.cycles.length,
      expectedSourcesEnsured,
      tracks: Object.freeze(plan.cycles.map((cycle) => cycle.authorityTrack)),
    });
  }

  /**
   * Resolve the state of an expected source that nothing has satisfied. An
   * optional family past its window is `not_filed`; a required one is
   * `review_required` so a human looks at it.
   *
   * There is no branch that produces a number. Callers that want a funding
   * position get `expectedSourceFundingPosition`, which has no numeric form for
   * an unpublished source.
   */
  async reconcileUnobserved(input: {
    expectedSources: readonly StoredExpectedSource[];
    nowIso: string;
  }): Promise<
    readonly {
      expectedSourceId: string;
      expectedState: ExpectedSourceState;
      fundingPosition: ReturnType<typeof expectedSourceFundingPosition>;
    }[]
  > {
    const results: {
      expectedSourceId: string;
      expectedState: ExpectedSourceState;
      fundingPosition: ReturnType<typeof expectedSourceFundingPosition>;
    }[] = [];

    for (const expected of input.expectedSources) {
      // Never walk back a state that real evidence already established.
      if (expected.expectedState !== 'expected') continue;

      const resolved = resolveUnobservedExpectedState({
        plan: { optional: expected.optional, expectedTo: expected.expectedTo },
        nowIso: input.nowIso,
      });
      if (resolved === 'expected') continue;

      await this.store.setExpectedSourceState({
        expectedSourceId: expected.id,
        expectedState: resolved,
        reviewReason:
          resolved === 'review_required'
            ? `required ${expected.authorityTrack}/${expected.stage} source not observed by ${expected.expectedTo}`
            : null,
      });
      results.push({
        expectedSourceId: expected.id,
        expectedState: resolved,
        fundingPosition: expectedSourceFundingPosition(resolved),
      });
    }

    return Object.freeze(results);
  }
}
