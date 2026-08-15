/**
 * LegiWatch vNext — shared domain types + endpoint paths.
 *
 * Every type mirrors the server DTO (see docs/handoff/legiwatch-api-inventory.md).
 * The module reuses the canonical fetchers in `pages/clients/tracker/*` and
 * `lib/hearing-watch-api.ts` for anything they already own; this file owns only
 * the vNext-shaped selectors and the paths those clients don't export.
 *
 * Data invariants (LEGIWATCH-HANDOFF §8): missing data is never zero; a failed
 * or unmapped source renders an explicit state; timestamps are server
 * timestamps and ages are derived at render.
 */

import type {
  FeedItem,
  FeedResponse,
  FeedSourceType,
} from '../../../../pages/clients/tracker/intel-feed-api.js';

export type { FeedItem, FeedResponse, FeedSourceType };

/** §6.1 band — the KIND of development, derived from the server sourceType.
 *  Never folded with severity or work state. */
export type PacketBand =
  | 'CRITICAL'
  | 'HEARING'
  | 'DEADLINE'
  | 'BUDGET'
  | 'STATE BILL'
  | 'REGULATION';

/** §6.2 — server-authoritative per-user work state. */
export type WorkState =
  | 'new'
  | 'in_review'
  | 'assigned'
  | 'actioned'
  | 'snoozed'
  | 'dismissed';

export const WORK_STATE_LABEL: Record<WorkState, string> = {
  new: 'NEW',
  in_review: 'IN REVIEW',
  assigned: 'ASSIGNED',
  actioned: 'ACTIONED',
  snoozed: 'SNOOZED',
  dismissed: 'DISMISSED',
};

/** §5.2 tone ramp keys — status is dot + label, never colour-only. */
export type Tone = 'gray' | 'brand' | 'error' | 'warning' | 'success' | 'dark';

export const WORK_STATE_TONE: Record<WorkState, Tone> = {
  new: 'brand',
  in_review: 'gray',
  assigned: 'dark',
  actioned: 'success',
  snoozed: 'gray',
  dismissed: 'gray',
};

/** The active queue = NEW + IN REVIEW + ASSIGNED (§6.2). Resolved buckets are
 *  excluded from every "active" count, the tab badge and the header pill. */
export const ACTIVE_WORK_STATES: readonly WorkState[] = ['new', 'in_review', 'assigned'];

/** Feed rail worklist buckets (§7.3). `default` is the server's active queue
 *  (dismissed + still-snoozed already excluded server-side). */
export const WORKLIST_BUCKETS: Array<{ id: string; label: string }> = [
  { id: 'default', label: 'Active queue' },
  { id: 'new', label: 'New' },
  { id: 'in_review', label: 'In review' },
  { id: 'assigned', label: 'Assigned to me' },
  { id: 'actioned', label: 'Actioned' },
  { id: 'snoozed', label: 'Snoozed' },
  { id: 'dismissed', label: 'Dismissed' },
];

/** §6.1 sourceFamily drives the source-type chips and the analytics stack. */
export const SOURCE_FAMILIES: Array<{ id: FeedSourceType; label: string }> = [
  { id: 'bill', label: 'Bills' },
  { id: 'hearing', label: 'Hearings' },
  { id: 'regulation', label: 'Regulations' },
  { id: 'program_element', label: 'Program elements' },
  { id: 'state_bill', label: 'State bills' },
];

/** §6.4 — capture capability, resolved before setup. `unavailable` names its
 *  reason; `pending` offers notify-when-resolved, never setup. */
export type HearingCapability = 'direct' | 'browser' | 'pending' | 'unavailable';

export const CAPABILITY_LABEL: Record<HearingCapability, string> = {
  direct: 'AVAILABLE',
  browser: 'AVAILABLE',
  pending: 'PENDING',
  unavailable: 'UNAVAILABLE',
};

/** Tab ids — Hearings first, it is the module's landing tab (§7.1 row 3). */
export type LegiWatchTab = 'hearings' | 'feed' | 'bills' | 'digest' | 'analytics';

export const LEGIWATCH_TABS: readonly LegiWatchTab[] = [
  'hearings',
  'feed',
  'bills',
  'digest',
  'analytics',
];

/** §7.2 / §7.9 — removed tabs redirect to hearings. */
export const REMOVED_TABS = new Set(['overview', 'watchlist', 'watchlists']);

/** react-query key namespace for this module. Shared records (alerts, bills,
 *  hearings) reuse the canonical keys from their owning client files so a
 *  mutation here invalidates the old app and vice-versa (§3.3). Only
 *  module-local derivations live under this namespace. */
export const lwKeys = {
  root: ['lw-vnext'] as const,
  packet: (clientId: string, alertId: string) =>
    ['lw-vnext', 'packet', clientId, alertId] as const,
  dossier: (clientId: string | null, billId: string) =>
    ['lw-vnext', 'dossier', clientId ?? '_', billId] as const,
};

/** Derive the packet band from the server source type + severity (§6.1).
 *  CRITICAL is severity-driven; the rest are kind-driven. */
export function packetBand(item: FeedItem): { band: PacketBand; tone: Tone } {
  if (item.severity === 'critical') return { band: 'CRITICAL', tone: 'error' };
  switch (item.sourceType) {
    case 'hearing':
      return { band: 'HEARING', tone: 'brand' };
    case 'combined':
      return { band: 'HEARING', tone: 'brand' };
    case 'program_element':
      return { band: 'BUDGET', tone: 'gray' };
    case 'state_bill':
      return { band: 'STATE BILL', tone: 'gray' };
    case 'regulation':
      return { band: 'REGULATION', tone: 'gray' };
    case 'bill':
    default:
      return { band: 'DEADLINE', tone: 'warning' };
  }
}

/** §8.10 — age is derived from the server timestamp at render, never stored. */
export function ageLabel(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '—';
  const ms = now - new Date(iso).getTime();
  if (Number.isNaN(ms) || ms < 0) return '—';
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'NOW';
  if (min < 60) return `${min} MIN`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} HR`;
  const day = Math.floor(hr / 24);
  return `${day} D`;
}

/** §8.8 — client attribution is exact: one client named, several counted. */
export function clientAttribution(item: FeedItem): string {
  // The feed row carries one owning client; combined/client-count display comes
  // from the server when a packet spans clients (a count, never a truncated list).
  return item.clientName ?? 'Client';
}
