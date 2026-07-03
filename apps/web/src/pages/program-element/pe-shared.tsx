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

// ── BL-1: money-graph registries + badges ─────────────────────────────────────

/**
 * line_type registry (mockup data-spine): label/short/color per type. MILCON /
 * TRANSFER / CLASSIFIED are reserved — they render correctly the day those
 * ingests land, and the facet strip hides types with zero rows.
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

export function LineTypeBadge({ lineType, small }: { lineType: string | null | undefined; small?: boolean }) {
  const t = lineType ? LINE_TYPES[lineType] : undefined;
  if (!t) return <span className="pe-dash">—</span>;
  return (
    <span
      className={`pe-linetype-badge${small ? ' sm' : ''}`}
      style={{ color: t.color, background: `${t.color}18` }}
      title={t.label}
    >
      {t.short}
    </span>
  );
}

/** Compact 0-5 transition-maturity pips (F19). Null = not applicable. */
export function MaturityMini({ value }: { value: number | null | undefined }) {
  if (value == null) return <span className="pe-dash" title="Not applicable">—</span>;
  const color = value >= 4 ? 'var(--success)' : value >= 2 ? 'var(--notable)' : 'var(--accent)';
  return (
    <span className="pe-mat-mini" title={`Transition maturity ${value}/5`}>
      {[1, 2, 3, 4, 5].map((i) => (
        <span
          key={i}
          className="pe-mm-pip"
          style={{ background: i <= value ? color : 'var(--border-1)' }}
        />
      ))}
      <span className="pe-mm-n" style={{ color }}>
        {value}
      </span>
    </span>
  );
}

const TIER_COLOR: Record<string, string> = {
  high: '#2E6B43',
  med: '#A26913',
  low: '#B5301B',
};

/** Appropriability tier badge (F27). `label` overrides the tier text (e.g. score). */
export function TierBadge({ tier, label }: { tier: string | null | undefined; label?: string }) {
  if (!tier) return <span className="pe-dash">—</span>;
  const color = TIER_COLOR[tier] ?? 'var(--ink-3)';
  const text = label ?? (tier === 'high' ? 'High' : tier === 'med' ? 'Medium' : 'Low');
  return (
    <span className="pe-tier-badge" style={{ color, background: `${color}18` }} title={`Appropriability: ${tier}`}>
      {text}
    </span>
  );
}

/** Latest normalized budget-action chip (BL catalog Signal column). */
const ACTION_SIGNAL_META: Record<string, { label: string; tone: string }> = {
  add: { label: 'Add', tone: 'notable' },
  cut: { label: 'Cut', tone: 'critical' },
  new_start: { label: 'New start', tone: 'info' },
  termination: { label: 'Zeroed', tone: 'critical' },
  hold: { label: 'Fenced', tone: 'notable' },
  transfer: { label: 'Transfer', tone: 'info' },
};

export function ActionSignalChip({
  type,
  tone,
}: {
  type: string | null | undefined;
  tone?: string | null;
}) {
  if (!type) return null;
  const meta = ACTION_SIGNAL_META[type] ?? { label: type, tone: tone ?? 'info' };
  return <span className={`pe-sig-pill tone-${tone ?? meta.tone}`}>{meta.label}</span>;
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
