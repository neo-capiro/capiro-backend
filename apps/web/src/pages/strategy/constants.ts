import type { NodeKind, NodeStatus, NodeSubject, StrategyType } from './types.js';

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

/**
 * Node-kind display metadata (letter chip, label, accent colors). Shared by the
 * timeline cards and the node rail so they never drift. Verbatim from the
 * prototype NODE_KIND.
 */
export const NODE_KIND_META: Record<
  NodeKind,
  { letter: string; label: string; color: string; ink: string }
> = {
  action: { letter: 'A', label: 'Action', color: 'var(--accent)', ink: 'var(--accent-ink)' },
  decision: { letter: 'D', label: 'Decision', color: 'var(--notable)', ink: 'var(--notable)' },
  gate: { letter: 'G', label: 'Gate', color: '#5B6472', ink: '#434B57' },
  milestone: { letter: 'M', label: 'Milestone', color: 'var(--success)', ink: 'var(--success)' },
  risk: { letter: 'R', label: 'Risk', color: 'var(--critical)', ink: 'var(--critical)' },
};

/** The 8 node subjects (schema order). */
export const NODE_SUBJECTS: NodeSubject[] = [
  'deliverable',
  'submission',
  'member',
  'committee',
  'ask',
  'agency',
  'outcome',
  'optics',
];

/** Human-cased subject labels (summary line + Subject select), so subject reads
 *  consistently with the Type/Status labels rather than a raw lowercase enum. */
export const NODE_SUBJECT_LABEL: Record<NodeSubject, string> = {
  deliverable: 'Deliverable',
  submission: 'Submission',
  member: 'Member',
  committee: 'Committee',
  ask: 'Ask',
  agency: 'Agency',
  outcome: 'Outcome',
  optics: 'Optics',
};

/** Node status options with human labels (NOD-7 status select). */
export const NODE_STATUS_OPTIONS: Array<{ id: NodeStatus; label: string }> = [
  { id: 'draft', label: 'Draft' },
  { id: 'in_progress', label: 'In Progress' },
  { id: 'internal_review', label: 'Internal Review' },
  { id: 'active', label: 'Active' },
  { id: 'suggested', label: 'Suggested' },
];

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
