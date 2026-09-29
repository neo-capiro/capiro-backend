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
import type { Client } from '../../../../pages/clients/clientTypes.js';

export type { FeedItem, FeedResponse, FeedSourceType };

/** §6.1 band — the KIND of development, derived from the server sourceType.
 *  Never folded with severity or work state. */
export type PacketBand =
  | 'CRITICAL'
  | 'HEARING'
  | 'BILL'
  | 'BUDGET'
  | 'STATE BILL'
  | 'REGULATION'
  | 'UPDATE';

/** §6.2 — server-authoritative per-user work state. */

export type WorkState = 'new' | 'in_review' | 'assigned' | 'actioned' | 'snoozed' | 'dismissed';

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

/** Tab ids — Hearings first, it is the module's landing tab (§7.1 row 3).
 *  `settings` is a valid, URL-addressable value (reached from the header gear
 *  action, LEGIWATCH-V2-HANDOFF §1.9/§2) but is not a primary destination —
 *  it is excluded from `LEGIWATCH_PRIMARY_TABS`, the set rendered in the tab
 *  strip. */

export type LegiWatchTab =
  | 'hearings'
  | 'committees'
  | 'bills'
  | 'research'
  | 'news'
  | 'budget'
  | 'feed'
  | 'digest'
  | 'analytics'
  | 'settings';

/** Every URL-addressable tab value, including the header-only `settings`. */
export const LEGIWATCH_TABS: readonly LegiWatchTab[] = [
  'hearings',
  'committees',
  'bills',

  'research',
  'news',
  'budget',

  'feed',
  'digest',
  'analytics',
  'settings',
];

/** The five primary task destinations rendered in the LegiWatch navigation. */
export const LEGIWATCH_PRIMARY_TABS: readonly LegiWatchTab[] = [
  'feed',
  'bills',
  'hearings',
  'committees',
  'digest',
];

/** Secondary links preserve direct access without competing with primary groups. */
export const LEGIWATCH_SECONDARY_TABS: readonly LegiWatchTab[] = ['budget', 'analytics'];

/** URL-addressable but absent from the tab strip; a `tab=` deep link still
 *  renders them (and the module shows them as an extra active tab). */
export const LEGIWATCH_HIDDEN_TABS: readonly LegiWatchTab[] = ['research', 'news'];

/** Removed tabs redirect to hearings. Legacy watchlist names remain reachable
 * through the canonical client targeting subview under Settings. */
export const REMOVED_TABS = new Set(['overview']);

/** Settings dispatches watchlist/watchlists to canonical client targeting.
 * The watches/presets aliases went away with the W2-4 watch-presets feature. */
export const TAB_ALIASES: Record<string, LegiWatchTab> = {
  watchlist: 'settings',
  watchlists: 'settings',
};

/** react-query key namespace for this module. Shared records (alerts, bills,
 *  hearings) reuse the canonical keys from their owning client files so a
 *  mutation here invalidates the old app and vice-versa (§3.3). Only
 *  module-local derivations live under this namespace. */
export const lwKeys = {
  root: ['lw-vnext'] as const,

  packet: (clientId: string, alertId: string) => ['lw-vnext', 'packet', clientId, alertId] as const,

  dossier: (clientId: string | null, billId: string) =>
    ['lw-vnext', 'dossier', clientId ?? '_', billId] as const,
};

/** Derive the packet band from the server source type + severity (§6.1).
 *  CRITICAL is severity-driven; the rest are kind-driven. The FeedItem DTO
 *  carries no deadline semantics, so no source maps to a deadline claim: a
 *  federal bill change is a BILL, and an unrecognised future sourceType
 *  degrades to the neutral UPDATE — never an invented deadline. */
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
      return { band: 'BILL', tone: 'gray' };
    default:
      return { band: 'UPDATE', tone: 'gray' };
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
export function clientAttribution(
  item: FeedItem,
  /** The selected scope-lens client; used only as an ID-matched display
   *  fallback — the backend resolves clientName on the tenant roll-up only,
   *  so a client-scoped feed's own rows take their name from here. */
  selectedClient?: Client | null,
): string {
  // A null clientName whose owner id is NOT the selected client means the id
  // is not in the current tenant directory (archived/renamed/deleted client —
  // PR C §16): keep the honest "Historical client" label; never fabricate.
  if (item.clientName) return item.clientName;
  if (selectedClient && item.clientId === selectedClient.id) return selectedClient.name;
  return 'Historical client';
}
