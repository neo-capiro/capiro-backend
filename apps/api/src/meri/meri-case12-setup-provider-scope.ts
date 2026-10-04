import { AsyncLocalStorage } from 'node:async_hooks';
import type { Case12SetupOutcome, Case12SetupWireInput } from './meri-case12-setup-budget.js';

/** Internal service composition port. It must commit the durable owner write before returning. */
export interface Case12SetupProviderOwner {
  reserve(input: Case12SetupWireInput): Promise<{ reservationId: string }>;
  settle(reservationId: string, outcome: Case12SetupOutcome): Promise<void>;
}
type Scope = {
  owner: Case12SetupProviderOwner;
  open: boolean;
  pending: Set<object>;
  uncertain: boolean;
};
const scope = new AsyncLocalStorage<Scope>();
const reservations = new WeakMap<
  object,
  { scope: Scope; reservationId: string; settled: boolean }
>();
function fail(code: string): never {
  throw new Error(`meri_case12_setup_provider_${code}`);
}
export function case12SetupProviderScopeActive(): boolean {
  return !!scope.getStore();
}

/** This accepts native functions, never a JSON policy, HTTP field, or persisted ready flag. */
export async function withCase12SetupProviderScope<T>(
  owner: Case12SetupProviderOwner,
  work: () => Promise<T>,
): Promise<T> {
  if (scope.getStore()) fail('nested_scope');
  if (
    typeof owner?.reserve !== 'function' ||
    typeof owner?.settle !== 'function' ||
    typeof work !== 'function'
  )
    fail('owner_missing');
  // Bind methods now, so the caller cannot replace them while a wire is in flight.
  const current: Scope = {
    owner: { reserve: owner.reserve.bind(owner), settle: owner.settle.bind(owner) },
    open: true,
    pending: new Set(),
    uncertain: false,
  };
  return scope.run(current, async () => {
    try {
      const result = await work();
      if (current.pending.size || current.uncertain) fail('reconciliation_required');
      return result;
    } finally {
      current.open = false;
    }
  });
}

export async function reserveCase12SetupProviderAttempt(
  input: Case12SetupWireInput,
): Promise<object | null> {
  const current = scope.getStore();
  if (!current) return null;
  if (!current.open || current.uncertain) fail('scope_closed');
  // A pending native reservation also prevents a detached task from escaping the scope.
  const capability = Object.freeze({});
  current.pending.add(capability);
  let result: { reservationId: string };
  try {
    result = await current.owner.reserve(structuredClone(input));
  } catch (error) {
    current.uncertain = true;
    throw error;
  }
  if (
    !current.open ||
    current.uncertain ||
    !result ||
    typeof result.reservationId !== 'string' ||
    !result.reservationId
  )
    fail('reservation_unavailable');
  reservations.set(capability, {
    scope: current,
    reservationId: result.reservationId,
    settled: false,
  });
  return capability;
}

export async function settleCase12SetupProviderAttempt(
  capability: object | null,
  outcome: Case12SetupOutcome,
): Promise<void> {
  if (!capability) return;
  const reservation = reservations.get(capability);
  if (
    !reservation ||
    reservation.scope !== scope.getStore() ||
    !reservation.scope.open ||
    reservation.settled
  )
    fail('reservation_invalid');
  // Failed/unknown writes leave the durable reservation charged. Never dispatch a retry.
  // Consume synchronously: concurrent callers cannot enter the durable owner twice.
  reservation.settled = true;
  if (outcome.kind === 'uncertain') reservation.scope.uncertain = true;
  try {
    await reservation.scope.owner.settle(reservation.reservationId, structuredClone(outcome));
  } catch (error) {
    reservation.scope.uncertain = true;
    throw error;
  }
  reservation.scope.pending.delete(capability);
  if (outcome.kind === 'uncertain') fail('usage_uncertain');
}
