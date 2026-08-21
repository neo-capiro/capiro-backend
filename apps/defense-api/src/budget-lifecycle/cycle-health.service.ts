/**
 * Cycle health / coverage read model service.
 *
 * Backend only. Session 7 registers no controller for this: the Session 3 public
 * route surface stays frozen and product integration is Session 11's work.
 */

import { Injectable } from '@nestjs/common';
import {
  buildCycleHealth,
  type CycleHealth,
  type CycleHealthExpectedSourceInput,
  type CycleHealthObservationInput,
  type CycleHealthOutboxInput,
  type CycleHealthWatcherRunInput,
} from '@capiro/defense-domain';
import type { DefenseCycleHealthDto } from '@capiro/defense-contracts';

@Injectable()
export class CycleHealthService {
  build(input: {
    fiscalYear: number;
    nowIso: string;
    expectedSources: readonly CycleHealthExpectedSourceInput[];
    observations: readonly CycleHealthObservationInput[];
    watcherRuns: readonly CycleHealthWatcherRunInput[];
    outbox: readonly CycleHealthOutboxInput[];
  }): CycleHealth {
    return buildCycleHealth(input);
  }

  /**
   * The DTO is structurally identical to the domain read model, so this is a
   * widening cast rather than a re-shape. Keeping the conversion explicit means
   * a future divergence between the two shapes fails to compile instead of
   * silently reshaping the numbers a consumer reads.
   */
  toDto(health: CycleHealth): DefenseCycleHealthDto {
    return health;
  }
}
