/**
 * Program Elements — UI-free shared model (extraction from pe-shared.tsx).
 *
 * pe-shared.tsx is antd-coupled (message toasts, star icons), so the vNext
 * Program Elements module cannot import it (no-legacy-ui.contract.test.ts).
 * The label registry and the optimistic watch-toggle mutation are pure logic
 * over the shared endpoints, so they live here; pe-shared.tsx re-exports them
 * (public API unchanged) and keeps only the antd presentation on top.
 *
 * Do not import antd, any component module, or any stylesheet here — this
 * file is consumed at runtime from `src/vnext/**`.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../lib/use-api.js';
import { setProgramElementWatching } from './api.js';
import type { ProgramElementListResponse } from './types.js';

// Canonical service code -> friendly label. Mirrors the finder's SERVICE_OPTIONS.
const SERVICE_LABELS: Record<string, string> = {
  ARMY: 'Army',
  NAVY: 'Navy',
  AF: 'Air Force',
  SF: 'Space Force',
  USMC: 'Marine Corps',
  DW: 'Defense-Wide',
  DARPA: 'DARPA',
};

export function serviceLabel(code: string | null | undefined): string {
  if (!code) return '—';
  return SERVICE_LABELS[code.trim().toUpperCase()] ?? code;
}

/** "6.1" style budget-activity chip text from a budget_activity value. */
export function baShort(budgetActivity: string | null | undefined): string | null {
  if (!budgetActivity) return null;
  const m = budgetActivity.match(/(\d(?:\.\d)?)/);
  return m?.[1] ?? budgetActivity;
}

/**
 * line_type registry (mockup data-spine): label/short/color per type. MILCON /
 * TRANSFER / CLASSIFIED are reserved — they render correctly the day those
 * ingests land, and the facet strip hides types with zero rows. Data registry
 * (not presentation) — shared verbatim by the canonical chips (pe-shared.tsx)
 * and the vNext fallback chips so the two surfaces cannot drift.
 */
export const LINE_TYPES: Record<
  string,
  { label: string; short: string; code: string; color: string }
> = {
  RDTE_PE: { label: 'RDT&E · Program Element', short: 'RDT&E PE', code: 'PE', color: '#2A57CE' },
  PROCUREMENT_BLIN: { label: 'Procurement · BLIN', short: 'Proc BLIN', code: 'BLIN', color: '#1A6E78' },
  OM_BLI: { label: 'O&M · Budget Line', short: 'O&M BLI', code: 'BLI', color: '#A26913' },
  MILCON_PROJECT: { label: 'MILCON · Project', short: 'MILCON', code: 'MC', color: '#4E5A86' },
  TRANSFER: { label: 'Transfer authority', short: 'Transfer', code: 'TR', color: '#7A5C3A' },
  CLASSIFIED: { label: 'Classified program', short: 'Classified', code: '•••', color: '#3A3D45' },
};

/** Appropriability tier color registry (F27). */
export const TIER_COLOR: Record<string, string> = {
  high: '#2E6B43',
  med: '#A26913',
  low: '#B5301B',
};

/** Latest normalized budget-action chip metadata (BL catalog Signal column). */
export const ACTION_SIGNAL_META: Record<string, { label: string; tone: string }> = {
  add: { label: 'Add', tone: 'notable' },
  cut: { label: 'Cut', tone: 'critical' },
  new_start: { label: 'New start', tone: 'info' },
  termination: { label: 'Zeroed', tone: 'critical' },
  hold: { label: 'Fenced', tone: 'notable' },
  transfer: { label: 'Transfer', tone: 'info' },
};

function patchListWatched(
  data: ProgramElementListResponse | undefined,
  peCode: string,
  watching: boolean,
): ProgramElementListResponse | undefined {
  if (!data || !Array.isArray(data.data)) return data;
  return {
    ...data,
    data: data.data.map((row) => (row.peCode === peCode ? { ...row, watched: watching } : row)),
  };
}

/** The exact copy both surfaces show when the watch toggle fails. */
export const WATCH_TOGGLE_ERROR_COPY = 'Unable to update watch status. Please try again.';

/**
 * Optimistic watch toggle shared by the finder table, the watchlist cards, the
 * detail hero and the vNext Explore grid. Flips the `watched` flag across any
 * cached finder lists and the PE detail immediately, rolls back on error, and
 * invalidates the finder/summary/detail queries on settle so counts + the
 * watchlist membership reconcile with the server.
 *
 * `notifyError` is the only presentation seam: the canonical surface passes
 * antd's `message.error`, the vNext surface passes the Capiro toast API.
 */
export function useWatchToggleCore(notifyError: (text: string) => void) {
  const api = useApi();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ peCode, watching }: { peCode: string; watching: boolean }) =>
      setProgramElementWatching(api, peCode, watching),
    onMutate: async ({ peCode, watching }) => {
      await queryClient.cancelQueries({ queryKey: ['program-element-finder'] });
      const previousLists = queryClient.getQueriesData<ProgramElementListResponse>({
        queryKey: ['program-element-finder'],
      });
      queryClient.setQueriesData<ProgramElementListResponse>(
        { queryKey: ['program-element-finder'] },
        (old) => patchListWatched(old, peCode, watching),
      );

      const detailKey = ['program-element-detail', peCode] as const;
      const previousDetail = queryClient.getQueryData(detailKey);
      queryClient.setQueryData(detailKey, (old: unknown) =>
        old && typeof old === 'object'
          ? { ...(old as Record<string, unknown>), currentUserIsWatching: watching }
          : old,
      );

      return { previousLists, previousDetail, detailKey };
    },
    onError: (_error, _vars, context) => {
      context?.previousLists?.forEach(([key, value]) => queryClient.setQueryData(key, value));
      if (context?.detailKey) {
        queryClient.setQueryData(context.detailKey, context.previousDetail);
      }
      notifyError(WATCH_TOGGLE_ERROR_COPY);
    },
    onSettled: (_result, _error, vars) => {
      queryClient.invalidateQueries({ queryKey: ['program-element-finder'] }).catch(() => undefined);
      queryClient
        .invalidateQueries({ queryKey: ['program-element-summary'] })
        .catch(() => undefined);
      queryClient
        .invalidateQueries({ queryKey: ['program-element-watchlist'] })
        .catch(() => undefined);
      queryClient
        .invalidateQueries({ queryKey: ['program-element-detail', vars.peCode] })
        .catch(() => undefined);
    },
  });
}
