import type { ValueProvider } from '@nestjs/common';
import {
  systemDelay,
  systemRandom,
  systemWallClock,
  type Delay,
  type RandomSource,
} from '@capiro/shared';

export const STRATEGY_WALL_CLOCK = Symbol('strategy.wall-clock');
export const STRATEGY_CONTEXT_RETRY = Symbol('strategy.context-retry');

/** Non-security randomness and delay for the existing bounded context retry. */
export interface ContextRetryRuntime {
  readonly random: RandomSource;
  readonly delay: Delay;
}

// The shared functions sample only when called, never when this module loads.
export const STRATEGY_TIME_PROVIDERS = [
  { provide: STRATEGY_WALL_CLOCK, useValue: systemWallClock },
  {
    provide: STRATEGY_CONTEXT_RETRY,
    useValue: Object.freeze({ random: systemRandom, delay: systemDelay }),
  },
] satisfies ValueProvider[];
