import type { OnboardSessionState } from '../../generated/prisma-client/index.js';

/**
 * Forward order of the Flow-1 funnel ladder. `failed` is terminal and lives
 * OUTSIDE the ladder (rank -1): a failed session never advances and never
 * satisfies a step precondition.
 *
 * Pure module (type-only Prisma import) so the state math is unit-testable
 * without a database or the generated client runtime.
 */
export const FUNNEL_STATE_ORDER = [
  'registered',
  'verified',
  'plan_selected',
  'legal_accepted',
  'payment_on_file',
  'roles_designated',
  'import_pref',
  'org_setup',
  'provisioning',
  'provisioned',
] as const satisfies readonly OnboardSessionState[];

/** A state on the forward ladder (everything except `failed`). */
export type OrderedFunnelState = (typeof FUNNEL_STATE_ORDER)[number];

/** Ladder rank of a state; `failed` (and anything unknown) is -1. */
export function stateRank(state: OnboardSessionState): number {
  return FUNNEL_STATE_ORDER.indexOf(state as OrderedFunnelState);
}

/** True when `state` is at or past `min` on the ladder (`failed` never is). */
export function isAtLeast(state: OnboardSessionState, min: OrderedFunnelState): boolean {
  const rank = stateRank(state);
  return rank >= 0 && rank >= stateRank(min);
}

/**
 * The state a step transition lands on: max(current, to) in ladder order.
 * Revisiting an earlier step updates data but never rewinds the state;
 * `failed` is sticky.
 */
export function nextState(
  current: OnboardSessionState,
  to: OrderedFunnelState,
): OnboardSessionState {
  if (current === 'failed') return current;
  return stateRank(current) >= stateRank(to) ? current : to;
}

/**
 * True once the session has entered provisioning (or ended): all funnel step
 * handlers must refuse writes — the provisioning bridge owns the session now.
 */
export function isLocked(state: OnboardSessionState): boolean {
  return state === 'provisioning' || state === 'provisioned' || state === 'failed';
}
