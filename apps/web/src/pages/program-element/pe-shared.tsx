import { useMutation, useQueryClient } from '@tanstack/react-query';
import { message } from 'antd';
import { StarFilled, StarOutlined } from '@ant-design/icons';
import { useApi } from '../../lib/use-api.js';
import { setProgramElementWatching } from './api.js';
import type { ProgramElementListItem, ProgramElementListResponse } from './types.js';
import { serviceColor, signalMeta } from './charts/index.js';

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

export function PeCodeBadge({ code, size }: { code: string; size?: 'sm' }) {
  return <span className={`pe-code-badge${size === 'sm' ? ' sm' : ''}`}>{code}</span>;
}

export function ServiceCell({ service }: { service: string | null }) {
  return (
    <span className="pe-svc">
      <span className="pe-svc-dot" style={{ background: serviceColor(service) }} />
      {serviceLabel(service)}
    </span>
  );
}

export function BaBadge({ budgetActivity }: { budgetActivity: string | null }) {
  const short = baShort(budgetActivity);
  if (!short) return <span className="pe-dash">—</span>;
  return <span className="pe-ba-badge">{short}</span>;
}

export function SignalPill({ item }: { item: ProgramElementListItem }) {
  const meta = signalMeta(item);
  if (!meta) return <span className="pe-dash">—</span>;
  return <span className={`pe-sig-pill tone-${meta.tone}`}>{meta.label}</span>;
}

export function WatchStar({
  watched,
  onToggle,
  busy,
}: {
  watched: boolean;
  onToggle: () => void;
  busy?: boolean;
}) {
  return (
    <button
      type="button"
      className={`pe-watch-star${watched ? ' on' : ''}`}
      title={watched ? 'Watching — click to stop' : 'Add to watchlist'}
      aria-pressed={watched}
      aria-label={watched ? 'Stop watching' : 'Add to watchlist'}
      disabled={busy}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
    >
      {watched ? <StarFilled /> : <StarOutlined />}
    </button>
  );
}

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

/**
 * Optimistic watch toggle shared by the finder table, the watchlist cards, and the
 * detail hero. Flips the `watched` flag across any cached finder lists and the PE
 * detail immediately, rolls back on error, and invalidates the finder/summary/detail
 * queries on settle so counts + the watchlist membership reconcile with the server.
 */
export function useWatchToggle() {
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
      message.error('Unable to update watch status. Please try again.');
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
