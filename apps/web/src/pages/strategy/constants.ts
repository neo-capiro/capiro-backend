import type { StrategyType } from './types.js';

/** Objective types (verbatim from the prototype OBJECTIVE_TYPES). */
export const OBJECTIVE_TYPES: Array<{ id: StrategyType; label: string; desc: string }> = [
  {
    id: 'appropriations',
    label: 'Appropriations ask',
    desc: 'Secure or protect funding in a single budget cycle.',
  },
  {
    id: 'authorization',
    label: 'Authorization',
    desc: 'Establish or amend authorities, often multi-year (NDAA).',
  },
  {
    id: 'regulatory',
    label: 'Regulatory / policy',
    desc: 'Shape a rule, guidance, or agency policy position.',
  },
  {
    id: 'coalition',
    label: 'Coalition / positioning',
    desc: 'Build durable support and standing for the long game.',
  },
  {
    id: 'procurement',
    label: 'Contract / procurement',
    desc: 'Win or protect a program of record or contract vehicle.',
  },
  {
    id: 'earmark',
    label: 'Grant / earmark (CDS)',
    desc: 'Pursue community project funding or a federal grant.',
  },
];

export const STRATEGY_TYPE_LABEL: Record<StrategyType, string> = OBJECTIVE_TYPES.reduce(
  (acc, t) => {
    acc[t.id] = t.label;
    return acc;
  },
  {} as Record<StrategyType, string>,
);

/** "2 hours ago" / "Yesterday" / "Jan 24" — compact relative time for list rows. */
export function relativeTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const ms = Date.now() - d.getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? '' : 's'} ago`;
  const days = Math.floor(hrs / 24);
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
