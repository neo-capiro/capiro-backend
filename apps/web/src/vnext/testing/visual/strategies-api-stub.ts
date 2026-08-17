/**
 * Strategies data-layer stub for the Clerk-free vNext visual harness.
 *
 * `vite.harness.config.ts` aliases the real `strategies-api.ts` onto this
 * module, scoped to that config only — the app's own `vite.config.ts` is
 * untouched, so the production bundle still resolves the real hooks and
 * still calls the real API.
 *
 * `StrategyLibraryVNext` is a container component (it calls these hooks
 * directly, unlike Dashboard/Directory/Client CRM's harness screens, which
 * take fixture data as a `model` prop) — swapping the whole data module is
 * the non-invasive way to get it rendering here without touching that
 * production component. Only the names `StrategyLibraryVNext.tsx` actually
 * imports are covered; this is not a full `strategies-api.ts` replacement,
 * so it must not be aliased for any screen that also needs the editor or
 * other Strategies views.
 */
import {
  STRATEGIES_VISUAL_CLIENTS,
  STRATEGIES_VISUAL_FIRM_PHASES,
  STRATEGIES_VISUAL_LIST,
  STRATEGIES_VISUAL_MEMBERS,
  STRATEGIES_VISUAL_NO_PENDING_WATCH_COUNTS,
  STRATEGIES_VISUAL_PENDING_WATCH_COUNTS,
} from '../fixtures/strategies.js';
import type { ClientLite, TenantMember } from '../../pages/strategies/strategies-api.js';

export function useStrategies() {
  return { data: STRATEGIES_VISUAL_LIST, isLoading: false, isError: false, dataUpdatedAt: 1755280200000 };
}

export function useClientsLite() {
  return { data: STRATEGIES_VISUAL_CLIENTS };
}

export function useTenantMembers() {
  return { data: STRATEGIES_VISUAL_MEMBERS };
}

export function useFirmPhases() {
  return { data: STRATEGIES_VISUAL_FIRM_PHASES };
}

/** `?screen=strategies-empty` shows the "Needs review" card with nothing
 *  pending — the plain, non-attention state — same trick as the existing
 *  congressional-staff / congressional-staff-empty pair. */
export function usePendingWatchCounts(_enabled: boolean) {
  const screen = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('screen') : null;
  return { data: screen === 'strategies-empty' ? STRATEGIES_VISUAL_NO_PENDING_WATCH_COUNTS : STRATEGIES_VISUAL_PENDING_WATCH_COUNTS };
}

/** Mirrors strategies-api.ts's memberName exactly (see that file for the real one). */
export function memberName(
  members: TenantMember[] | undefined,
  clerkUserId: string | null | undefined,
  fallback = 'Team member',
): string {
  if (!clerkUserId) return 'Unassigned';
  return members?.find((m) => m.clerkUserId === clerkUserId)?.name ?? fallback;
}

/** Mirrors strategies-api.ts's clientName exactly (see that file for the real one). */
export function clientName(clients: ClientLite[] | undefined, clientId: string | null | undefined): string {
  if (!clientId) return '—';
  return clients?.find((c) => c.id === clientId)?.name ?? 'Client';
}
