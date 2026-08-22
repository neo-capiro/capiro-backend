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
 * Covers the library AND the editor (screen=strategy-editor); other
 * Strategies views still need their own hooks added before they can render
 * here.
 */
import { useEffect, useReducer } from 'react';
import {
  STRATEGIES_VISUAL_CLIENTS,
  STRATEGIES_VISUAL_EDITOR_DETAIL,
  STRATEGIES_VISUAL_EDITOR_FIRM_PHASES,
  STRATEGIES_VISUAL_REFERENCE_CALENDARS,
  STRATEGIES_VISUAL_FIRM_PHASES,
  STRATEGIES_VISUAL_FIRM_PHASES_LONG,
  STRATEGIES_VISUAL_LIST,
  STRATEGIES_VISUAL_MEMBERS,
  STRATEGIES_VISUAL_NO_PENDING_WATCH_COUNTS,
  STRATEGIES_VISUAL_PENDING_WATCH_COUNTS,
} from '../fixtures/strategies.js';
import type { ReferenceCalendars } from '../../../pages/strategy/types.js';
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
  const screen = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('screen') : null;
  if (screen === 'firm-phases-long') return { data: STRATEGIES_VISUAL_FIRM_PHASES_LONG };
  return { data: screen === 'strategy-editor' ? STRATEGIES_VISUAL_EDITOR_FIRM_PHASES : STRATEGIES_VISUAL_FIRM_PHASES };
}

/** `?screen=strategies-empty` shows the "Needs review" card with nothing
 *  pending — the plain, non-attention state — same trick as the existing
 *  congressional-staff / congressional-staff-empty pair. */
export function usePendingWatchCounts(_enabled: boolean) {
  const screen = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('screen') : null;
  return { data: screen === 'strategies-empty' ? STRATEGIES_VISUAL_NO_PENDING_WATCH_COUNTS : STRATEGIES_VISUAL_PENDING_WATCH_COUNTS };
}

/**
 * Library row delete. Inert in the harness: the visual pass is about the row's
 * two states (armed vs not), which the component drives from local state, so
 * this never needs to mutate the fixture list.
 */
export function useDeleteStrategy() {
  return { mutate: () => undefined, isPending: false, isError: false, error: null };
}

/**
 * Firm-phases full-replace PUT. Inert for the same reason — the overlay edits a
 * local copy of the rows, so the phase-name width/wrap behaviour this screen
 * exists to check never depends on a save round-trip.
 */
export function usePutFirmPhases() {
  return { mutate: () => undefined, isPending: false, isError: false, error: null };
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

/* ─────────────────── Strategy editor (screen=strategy-editor) ───────────────
 *
 * The editor is a container component too, so the same alias covers it. These
 * are read-only stubs over the fixtures; the one mutation the editor owns
 * (the legislative-calendar fork) is stubbed as a local state write so the
 * drag/resize/rename interactions are exercisable here without a backend.
 * ────────────────────────────────────────────────────────────────────────── */

let harnessCalendars: ReferenceCalendars = STRATEGIES_VISUAL_REFERENCE_CALENDARS;
const calendarListeners = new Set<() => void>();

export function useStrategy(_id: string | null) {
  return {
    data: STRATEGIES_VISUAL_EDITOR_DETAIL,
    isLoading: false,
    isError: false,
    dataUpdatedAt: Date.now() - 4 * 60_000,
  };
}

export function useReferenceCalendars() {
  const [, force] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    calendarListeners.add(force);
    return () => void calendarListeners.delete(force);
  }, []);
  return { data: harnessCalendars, isLoading: false, isError: false };
}

export function useForkReferenceCalendar(kind: 'congress' | 'ppbe') {
  return {
    isPending: false,
    isError: false,
    error: null,
    mutate: (
      rows: Array<{ label: string; startsOn?: string | null; endsOn?: string | null; tone?: string | null }>,
      opts?: { onSuccess?: () => void },
    ) => {
      if (kind === 'congress') {
        harnessCalendars = {
          ...harnessCalendars,
          congress: rows.map((r, i) => ({
            id: `fork-${i}`,
            kind: 'congress_milestone' as const,
            label: r.label,
            fy: null,
            startsOn: r.startsOn ?? null,
            endsOn: r.endsOn ?? null,
            tone: r.tone ?? null,
            position: i,
          })),
          source: { ...harnessCalendars.source, congress: 'override' as const },
        };
        calendarListeners.forEach((fn) => fn());
      }
      opts?.onSuccess?.();
    },
  };
}

export function useWatchReviewState(_strategyId: string | null, _enabled: boolean) {
  return { data: { proposals: [] }, isLoading: false, isError: false };
}

export function useRevalidateWatch() {
  return { mutate: () => {}, isPending: false };
}

/* StepInspector's own hooks. The inspector is reachable from the editor (any
   step click deep-links `?step=<id>`), so the alias has to satisfy its imports
   too or the harness bundle will not build. Inert stubs — the inspector's own
   behaviour is out of scope for the timeline harness. */
export function useAddNode(_strategyId: string) {
  return { mutate: () => {}, mutateAsync: async () => undefined, isPending: false, isError: false, error: null };
}

export function useAssistant(_strategyId: string) {
  return { mutate: () => {}, mutateAsync: async () => undefined, isPending: false, isError: false, error: null };
}

export function useDismissContextGap(_strategyId: string) {
  return { mutate: () => {}, isPending: false };
}

export function useRecordArtifact(_strategyId: string) {
  return { mutate: () => {}, isPending: false, isError: false, error: null };
}

export function useStrategyConversation(_strategyId: string, _nodeId: string | null, _enabled?: boolean) {
  return { data: [], isLoading: false, isError: false };
}
