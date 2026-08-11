/**
 * Client CRM vNext — Overview data adapter (Figma `906:2503`).
 *
 * Contract rules this file exists to enforce (`1244:4222`):
 *
 *  §8  "Overview = client aggregate + derived attention." Attention is DERIVED
 *      from authoritative systems; there is no mutable attention record.
 *  §8  "Work = STRATEGIES authoritative; no separate CRM tasks." Work Pulse
 *      reads the Strategies service through the SAME query keys the Strategies
 *      module uses, so an edit in either surface reflects in the other.
 *  §7  "Do not turn missing external evidence into a numeric zero."  Every
 *      number is a `Metric`, which is either a real value or an explicit
 *      `unavailable` carrying the reason. A metric with no backing contract
 *      renders as "—", never as 0.
 *  §9  "Keep data-fetching/query keys stable where possible so mutation
 *      invalidation remains correct." Existing keys are reused verbatim.
 */
import { useMemo } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { SECTOR_LABELS } from '@capiro/shared';
import { useApi } from '../../../lib/use-api.js';
import { useIntelFeature } from '../../../lib/intel-feature-flags.js';
import { useActionsList } from '../../../pages/actions/actions-api.js';
import { useMeetings } from '../../../pages/engagement/meetings/meetings-api.js';
import type { Meeting } from '../../../pages/engagement/meetings/meetings-types.js';
import type { Client } from '../../../pages/clients/clientTypes.js';
import type { ClientFacility } from '../../../pages/clients/facilities-api.js';
import {
  CLOSED_ACTION_STATUSES,
  daysUntil,
  readText,
  toRecord,
} from '../../../pages/clients/client-profile-crm-model.js';
import {
  trackerKeys,
  trackerPaths,
  type TrackerSummary,
} from '../../../pages/clients/tracker/tracker-api.js';
import { intelTrackerPaths } from '../../../pages/clients/tracker/intel-tracker-api.js';
import type { StrategyDetail, StrategyListItem } from '../../../pages/strategy/types.js';

/* ────────────────────────────── metric algebra ───────────────────────────── */

/**
 * A displayable number, or an explicit statement that it is not knowable.
 *
 * The whole point: `{ kind: 'unavailable' }` and `{ kind: 'value', value: 0 }`
 * are different facts and must render differently. Collapsing them is the
 * single error both the Program Elements and LegiWatch handoff frames forbid
 * independently, so it is treated here as a product-wide invariant.
 */
export type Metric =
  | { kind: 'value'; value: number; href?: string }
  | { kind: 'unavailable'; reason: string };

export const unavailable = (reason: string): Metric => ({ kind: 'unavailable', reason });
export const value = (n: number, href?: string): Metric => ({ kind: 'value', value: n, href });

/** Per-region async state, so one failed domain does not blank the page (§7 PARTIAL). */
export type RegionState = 'loading' | 'ready' | 'error';

export interface RegionStatus {
  state: RegionState;
  /** Present when `state === 'error'`; shown inline next to a Retry control. */
  message?: string;
  retry: () => void;
}

/* ─────────────────────────────── model shape ─────────────────────────────── */

export interface ClientProfileCard {
  name: string;
  initials: string;
  logoUrl: string | null;
  description: string | null;
  sectorLabel: string | null;
  website: string | null;
  location: string | null;
  clientSince: string | null;
}

export interface AccountCard {
  /** No owner column exists on `Client` — see the contract audit. */
  accountOwner: string | null;
  primaryContact: string | null;
  nextMeeting: { id: string; label: string; startsAt: string } | null;
  /** Derived from the next meeting's `preps`, which is the real brief record. */
  briefState: 'ready' | 'none' | 'no-meeting';
  accountTeam: Array<{ id: string; initials: string; name: string }>;
  accountTeamAvailable: boolean;
}

export type AttentionKind = 'budget' | 'hearing' | 'work' | 'regulatory' | 'profile';

export interface AttentionRow {
  id: string;
  kind: AttentionKind;
  urgent: boolean;
  title: string;
  meta: string;
  /** Display date, e.g. TODAY / AUG 13. */
  when: string;
  status: string;
  /** Destination within the CRM, or null when nothing can be opened. */
  href: string | null;
  rank: number;
}

export interface WorkPulse {
  currentStrategies: Metric;
  remainingActions: Metric;
  upcomingMilestones: Metric;
  openRisk: Metric;
  /** 0–1, or null when no honest completion signal exists. */
  readiness: number | null;
  readinessReason: string | null;
  nextStep: string | null;
}

export interface IntelligencePulse {
  trackedBills: Metric;
  opportunities: Metric;
  districts: Metric;
  regulatoryMatters: Metric;
  signals: string[];
  lastRefresh: string | null;
}

export interface ClientCrmOverviewModel {
  profile: ClientProfileCard;
  account: AccountCard;
  accountStatus: RegionStatus;
  attention: AttentionRow[];
  attentionTotal: number;
  attentionStatus: RegionStatus;
  work: WorkPulse;
  workStatus: RegionStatus;
  intelligence: IntelligencePulse;
  intelligenceStatus: RegionStatus;
}

/* ──────────────────────────────── helpers ───────────────────────────────── */

/** Two-letter client mark, shared by the compact header and the profile card. */
export function initialsFor(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0];
  if (!first) return '—';
  const last = parts.length > 1 ? parts[parts.length - 1] : undefined;
  if (!last) return first.slice(0, 2).toUpperCase();
  return `${first.charAt(0)}${last.charAt(0)}`.toUpperCase();
}

function locationOf(client: Client): string | null {
  const intake = toRecord(client.intakeData);
  const city = readText(intake, ['city']);
  const state = readText(intake, ['state']);
  const country = readText(intake, ['country']);
  const parts = [city, state ?? country].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

function monthYear(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, { month: 'short', year: 'numeric' }).toUpperCase();
}

/** TODAY / AUG 13 — matches the Figma's meta column. */
function shortWhen(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  if (date.toDateString() === new Date().toDateString()) return 'TODAY';
  return date
    .toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    .toUpperCase();
}

function statusOf(query: { isLoading: boolean; isError: boolean; error?: unknown; refetch: () => unknown }): RegionStatus {
  if (query.isError) {
    const message = query.error instanceof Error ? query.error.message : 'Could not load';
    return { state: 'error', message, retry: () => void query.refetch() };
  }
  return { state: query.isLoading ? 'loading' : 'ready', retry: () => void query.refetch() };
}

/** Worst-of, so a region backed by several queries reports honestly. */
function combineStatus(...parts: RegionStatus[]): RegionStatus {
  const failed = parts.find((part) => part.state === 'error');
  const retryAll = () => parts.forEach((part) => part.retry());
  if (failed) return { state: 'error', message: failed.message, retry: retryAll };
  if (parts.some((part) => part.state === 'loading')) return { state: 'loading', retry: retryAll };
  return { state: 'ready', retry: retryAll };
}

const crmHref = (clientId: string, tab: string, view?: string) =>
  `/clients?clientId=${encodeURIComponent(clientId)}&tab=${tab}${view ? `&view=${view}` : ''}`;

/* ──────────────────────────────── the hook ──────────────────────────────── */

export function useClientCrmOverviewModel(client: Client): ClientCrmOverviewModel {
  const api = useApi();
  const clientId = client.id;

  /* Account ------------------------------------------------------------- */
  const dateRange = useMemo(() => {
    const from = new Date();
    from.setDate(from.getDate() - 120);
    const to = new Date();
    to.setDate(to.getDate() + 45);
    return { from: from.toISOString(), to: to.toISOString() };
  }, []);
  const meetings = useMeetings({ clientId, ...dateRange });

  /* Attention ----------------------------------------------------------- */
  const actionQuery = useActionsList({ clientId, page: 1, limit: 50, sort: 'priority' });

  /* Work — Strategies is authoritative ---------------------------------- */
  // Same key as the Strategies library (`pages/strategy/api.ts`), so the two
  // surfaces share one cache entry and cannot drift.
  const strategiesQuery = useQuery<StrategyListItem[]>({
    queryKey: ['strategy', 'strategies'],
    queryFn: async () => (await api.get<StrategyListItem[]>('/strategy-api/strategies')).data,
    staleTime: 30_000,
  });
  const clientStrategies = useMemo(
    () => (strategiesQuery.data ?? []).filter((entry) => entry.clientId === clientId),
    [strategiesQuery.data, clientId],
  );
  // Node-level metrics need each strategy's detail. Same key as the editor
  // (`['strategy','strategy',id]`) so opening a strategy is a cache hit and an
  // edit there invalidates the pulse here.
  const strategyDetails = useQueries({
    queries: clientStrategies.map((entry) => ({
      queryKey: ['strategy', 'strategy', entry.id],
      queryFn: async () => (await api.get<StrategyDetail>(`/strategy-api/strategies/${entry.id}`)).data,
      staleTime: 30_000,
    })),
  });

  /* Intelligence -------------------------------------------------------- */
  const { enabled: trackerV2, ready: intelFlagsReady } = useIntelFeature('tracker_v2');
  const trackerSummary = useQuery<TrackerSummary>({
    queryKey: trackerKeys.summary(clientId),
    queryFn: async () =>
      (
        await api.get<TrackerSummary>(
          trackerV2 ? intelTrackerPaths.summary(clientId) : trackerPaths.summary(clientId),
        )
      ).data,
    enabled: intelFlagsReady,
    staleTime: 60_000,
  });
  const opportunities = useQuery<{ total?: number; count?: number }>({
    queryKey: ['client-funding-opportunities', clientId],
    queryFn: async () =>
      (await api.get<{ total?: number; count?: number }>(`/api/intelligence/clients/${clientId}/opportunities/summary`))
        .data,
    staleTime: 5 * 60 * 1000,
  });
  const facilities = useQuery<ClientFacility[]>({
    queryKey: ['client-facilities', clientId],
    queryFn: async () => (await api.get<ClientFacility[]>(`/api/clients/${clientId}/facilities`)).data,
    staleTime: 60_000,
  });
  const alerts = useQuery<{ alerts: Array<Record<string, unknown>> }>({
    queryKey: ['comment-alerts'],
    queryFn: async () =>
      (await api.get<{ alerts: Array<Record<string, unknown>> }>('/api/intelligence/comment-alerts')).data,
    staleTime: 5 * 60 * 1000,
  });

  /* ── Derivations ────────────────────────────────────────────────────── */

  const profile = useMemo<ClientProfileCard>(() => {
    const intake = toRecord(client.intakeData);
    return {
      name: client.name,
      initials: initialsFor(client.name),
      logoUrl: client.logoUrl ?? null,
      description: client.description ?? client.productDescription ?? null,
      sectorLabel: client.sectorTag
        ? ((SECTOR_LABELS as Record<string, string>)[client.sectorTag] ?? client.sectorTag)
        : null,
      website: client.website ?? null,
      location: locationOf(client),
      // engagementStartDate is the relationship start; createdAt is only when
      // the record was typed into Capiro. Prefer the former, fall back honestly.
      clientSince: monthYear(readText(intake, ['engagementStartDate']) ?? client.createdAt),
    };
  }, [client]);

  const nextMeeting = useMemo<Meeting | null>(() => {
    const now = Date.now();
    return (
      (meetings.data ?? [])
        .filter((meeting) => new Date(meeting.startsAt).getTime() >= now)
        .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime())[0] ?? null
    );
  }, [meetings.data]);

  const account = useMemo<AccountCard>(() => {
    const intake = toRecord(client.intakeData);
    return {
      // No owner/team columns exist on the Client model. Rendering a name here
      // would be inventing product logic from placeholder copy.
      accountOwner: null,
      primaryContact: client.primaryContactName ?? readText(intake, ['pocName']) ?? null,
      nextMeeting: nextMeeting
        ? {
            id: nextMeeting.id,
            label: new Date(nextMeeting.startsAt).toLocaleString(undefined, {
              month: 'short',
              day: 'numeric',
              hour: 'numeric',
              minute: '2-digit',
            }),
            startsAt: nextMeeting.startsAt,
          }
        : null,
      briefState: !nextMeeting ? 'no-meeting' : nextMeeting.preps.length > 0 ? 'ready' : 'none',
      accountTeam: [],
      accountTeamAvailable: false,
    };
  }, [client, nextMeeting]);

  const openActions = useMemo(
    () => (actionQuery.data?.data ?? []).filter((action) => !CLOSED_ACTION_STATUSES.has(action.status)),
    [actionQuery.data],
  );

  const attentionAll = useMemo<AttentionRow[]>(() => {
    const rows: AttentionRow[] = [];

    for (const action of openActions) {
      const dueSoon = action.deadline ? daysUntil(action.deadline) <= 7 : false;
      rows.push({
        id: `action:${action.id}`,
        kind: 'work',
        urgent: action.priority >= 80 || dueSoon,
        title: action.issueTitle,
        meta: action.whyItMatters || action.recommendedAction,
        when: shortWhen(action.deadline),
        status: 'OPEN',
        href: crmHref(clientId, 'work'),
        rank: action.priority + (dueSoon ? 35 : 0),
      });
    }

    // SAM registration lapse is a client-record fact, not external evidence.
    const intake = toRecord(client.intakeData);
    const samExpiration = readText(intake, ['samExpirationDate']);
    const samDays = samExpiration ? daysUntil(samExpiration) : null;
    if (samDays != null && samDays >= 0 && samDays <= 60) {
      rows.push({
        id: 'sam-expiration',
        kind: 'profile',
        urgent: samDays <= 30,
        title: `SAM.gov registration expires in ${samDays} day${samDays === 1 ? '' : 's'}`,
        meta: 'Keep the registration current so eligibility and identifiers stay reliable',
        when: shortWhen(samExpiration),
        status: 'OPEN',
        href: crmHref(clientId, 'overview'),
        rank: samDays <= 30 ? 130 : 95,
      });
    }

    if (nextMeeting && daysUntil(nextMeeting.startsAt) <= 7) {
      const days = daysUntil(nextMeeting.startsAt);
      rows.push({
        id: `meeting:${nextMeeting.id}`,
        kind: 'hearing',
        urgent: days <= 2,
        title: `Upcoming meeting: ${nextMeeting.subject}`,
        meta: nextMeeting.preps.length ? 'Brief prepared' : 'No brief prepared yet',
        when: shortWhen(nextMeeting.startsAt),
        status: 'OPEN',
        href: crmHref(clientId, 'relationships', 'history'),
        rank: days <= 2 ? 120 : 85,
      });
    }

    const seen = new Set<string>();
    return rows
      .sort((a, b) => b.rank - a.rank)
      .filter((row) => {
        const key = row.title.trim().toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  }, [openActions, client.intakeData, nextMeeting, clientId]);

  const work = useMemo<WorkPulse>(() => {
    const nodes = strategyDetails
      .map((query) => query.data)
      .filter((detail): detail is StrategyDetail => !!detail)
      .flatMap((detail) => detail.nodes);

    // `NodeStatus` has no terminal/completed member (draft | in_progress |
    // internal_review | active | suggested), so "committed" is the honest
    // boundary: suggested and draft nodes are not yet work anyone owes.
    const committed = nodes.filter((node) => node.status !== 'suggested' && node.status !== 'draft');
    const future = (iso: string | null) => !!iso && new Date(iso).getTime() >= Date.now();

    const milestones = committed.filter((node) => node.kind === 'milestone' && (node.openEnded || future(node.endsOn)));
    const nextByDate = [...committed]
      .filter((node) => future(node.endsOn) || future(node.startsOn))
      .sort(
        (a, b) =>
          new Date(a.endsOn ?? a.startsOn).getTime() - new Date(b.endsOn ?? b.startsOn).getTime(),
      )[0];

    return {
      currentStrategies: value(clientStrategies.length, crmHref(clientId, 'work')),
      remainingActions: value(
        committed.filter((node) => node.kind === 'action').length,
        crmHref(clientId, 'work'),
      ),
      upcomingMilestones: value(milestones.length, crmHref(clientId, 'work')),
      openRisk: value(committed.filter((node) => node.kind === 'risk').length, crmHref(clientId, 'work')),
      // A percentage needs a completion signal. `NodeStatus` has none, so any
      // number here would be invented. Surfaced as a blocked criterion instead.
      readiness: null,
      readinessReason: 'Strategy nodes have no completion state, so readiness cannot be computed',
      nextStep: nextByDate
        ? `Next: ${nextByDate.title}${nextByDate.endsOn ? ` · ${shortWhen(nextByDate.endsOn)}` : ''}`
        : null,
    };
  }, [strategyDetails, clientStrategies, clientId]);

  const intelligence = useMemo<IntelligencePulse>(() => {
    const opportunityCount = opportunities.data?.total ?? opportunities.data?.count ?? null;

    // Comment alerts are a global feed carrying a client reference; counting the
    // whole feed would attribute every tenant's matters to this client.
    const alertRows = alerts.data?.alerts ?? [];
    const clientScoped = alertRows.filter((row) => row.clientId === clientId);
    const alertsAreClientScoped = alertRows.length === 0 || alertRows.some((row) => 'clientId' in row);

    const signals: string[] = [];
    const urgent = attentionAll.filter((row) => row.urgent).length;
    if (urgent > 0) signals.push(`${urgent} HIGH-PRIORITY CHANGE${urgent === 1 ? '' : 'S'}`);
    if (nextMeeting) signals.push(`NEXT MEETING ${shortWhen(nextMeeting.startsAt)}`);
    const facilityCount = facilities.data?.length ?? 0;
    if (facilityCount > 0) signals.push(`${facilityCount} DISTRICT${facilityCount === 1 ? '' : 'S'} MAPPED`);

    return {
      trackedBills: trackerSummary.data
        ? value(trackerSummary.data.boardCount, crmHref(clientId, 'intelligence', 'legislative'))
        : unavailable('Tracker summary unavailable'),
      opportunities:
        opportunityCount == null
          ? unavailable('Opportunity summary unavailable')
          : value(opportunityCount, crmHref(clientId, 'intelligence', 'funding')),
      districts: facilities.data
        ? value(facilities.data.length, crmHref(clientId, 'intelligence', 'district'))
        : unavailable('Facilities unavailable'),
      regulatoryMatters: alertsAreClientScoped
        ? value(clientScoped.length, crmHref(clientId, 'intelligence', 'regulatory'))
        : unavailable('Regulatory alerts are not client-scoped'),
      signals,
      lastRefresh: null,
    };
  }, [opportunities.data, alerts.data, facilities.data, trackerSummary.data, attentionAll, nextMeeting, clientId]);

  return {
    profile,
    account,
    accountStatus: statusOf(meetings),
    attention: attentionAll.slice(0, 4),
    attentionTotal: attentionAll.length,
    attentionStatus: statusOf(actionQuery),
    work,
    workStatus: combineStatus(
      statusOf(strategiesQuery),
      ...strategyDetails.map((query) =>
        statusOf({
          isLoading: query.isLoading,
          isError: query.isError,
          error: query.error,
          refetch: query.refetch,
        }),
      ),
    ),
    intelligence,
    intelligenceStatus: combineStatus(
      statusOf(trackerSummary),
      statusOf(opportunities),
      statusOf(facilities),
      statusOf(alerts),
    ),
  };
}
