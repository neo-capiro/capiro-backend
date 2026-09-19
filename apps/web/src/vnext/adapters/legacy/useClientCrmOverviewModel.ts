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
import { sectorLabel } from '../../lib/labels.js';
import { useApi } from '../../../lib/use-api.js';
import { useIntelFeature } from '../../../lib/intel-feature-flags.js';
import { useClientFundingOpportunitiesV2 } from './useClientFundingOpportunitiesV2.js';
import { useActionsList } from '../../../pages/actions/actions-api.js';
import { useMeetings } from '../../../pages/engagement/meetings/meetings-api.js';
import type { Meeting } from '../../../pages/engagement/meetings/meetings-types.js';
import type { Client } from '../../../pages/clients/clientTypes.js';
import {
  clientTeamKey,
  getClientTeam,
  teamMemberLabel,
  type ClientTeamMember,
} from '../../pages/client-crm/client-team-api.js';
import { formatFacilityDistrict, type ClientFacility } from '../../../pages/clients/facilities-api.js';
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
import { useClientAccountOwner } from '../../pages/client-crm/useClientAccountOwner.js';
import type { ClientIntelProfile } from '../../../pages/intelligence/types.js';

/* ────────────────────────────── metric algebra ───────────────────────────── */

/**
 * A displayable number, or an explicit statement that it is not knowable.
 *
 * The whole point: `{ kind: 'unavailable' }` and `{ kind: 'value', value: 0 }`
 * are different facts and must render differently. Collapsing them is the
 * single error both the Program Elements and LegiWatch handoff frames forbid
 * independently, so it is treated here as a product-wide invariant.
 */
/** How a value renders — decided where the value's meaning is known (here),
 * never re-derived downstream by string-matching a display label. */
export type MetricFormat = 'currency' | 'count' | 'ratio';

export type Metric =
  | { kind: 'value'; value: number; href?: string; format?: MetricFormat }
  | { kind: 'unavailable'; reason: string };

/** Narrow return type on purpose: assignable to both Metric and TrajectoryMetric. */
export const unavailable = (reason: string): { kind: 'unavailable'; reason: string } => ({
  kind: 'unavailable',
  reason,
});
export const value = (n: number, href?: string, format?: MetricFormat): Metric => ({
  kind: 'value',
  value: n,
  href,
  format,
});

/**
 * Lobbying trajectory is a LABELED direction, not a bare number. The source
 * reports both a human label ("Contracting"/"Growing") and a growth rate
 * (-0.376 = down 37.6% YoY); rendering the raw rate as the stat was the bug
 * this type exists to prevent. `growthRate` may be null — the label alone is
 * still a real fact and renders without a delta.
 */
export type TrajectoryMetric =
  | { kind: 'value'; trajectoryLabel: string; growthRate: number | null }
  | { kind: 'unavailable'; reason: string };

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
  accountOwner: string | null;
  primaryContact: string | null;
  nextMeeting: { id: string; label: string; startsAt: string } | null;
  /** Derived from the next meeting's `preps`, which is the real brief record. */
  briefState: 'ready' | 'none' | 'no-meeting';
  /**
   * The real account-team roster: the account owner (flagged `isOwner`) plus
   * every `client_team_members` row, from `/api/clients/:id/team`.
   *
   * This used to be hardcoded `[]` with `accountTeamAvailable: false` because no
   * per-client roster existed anywhere in the product — the card rendered "No
   * roster" and there was no way to add anyone.
   */
  accountTeam: Array<{ id: string; initials: string; name: string; role: string | null; isOwner: boolean; userId: string }>;
  /**
   * True once the roster READ has settled successfully. False while loading or
   * on failure — so the card can say "couldn't read the team" instead of
   * showing an empty roster, which would be a different (and wrong) claim.
   */
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

/**
 * Federal footprint figures for the Overview tab (wire-audit "3 Compose
 * extend" item 3). Each slot is a `Metric` — a real value when the
 * client-profile endpoint returned it, or `unavailable` when the source
 * did not match or the query failed.
 */
export interface FederalFootprint {
  ldaSpend: Metric;
  ldaFilings: Metric;
  federalAwards: Metric;
  lobbyingTrajectory: TrajectoryMetric;
  /** False while the client-profile query is in flight or errored — the card
   * renders skeletons then, never four fake em dashes or zeros. */
  ready: boolean;
  /** Present when the client-profile read failed outright; pairs with `retry`. */
  error?: string | null;
  retry?: () => void;
  /** Display label for the footer's registrant count. */
  registrantsLabel: string | null;
}

export interface ClientCrmOverviewModel {
  profile: ClientProfileCard;
  account: AccountCard;
  accountStatus: RegionStatus;
  /** Loading / error / retry for the account-team roster read specifically. */
  accountTeamStatus: RegionStatus;
  attention: AttentionRow[];
  attentionTotal: number;
  attentionStatus: RegionStatus;
  work: WorkPulse;
  workStatus: RegionStatus;
  intelligence: IntelligencePulse;
  intelligenceStatus: RegionStatus;
  federalFootprint: FederalFootprint;
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

/** Bounded window, unlike `future()` below — used only where the UI's own
 * label promises a specific horizon (Work pulse's "Next 30 days"). */
function withinDays(iso: string | null, days: number): boolean {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return false;
  const now = Date.now();
  return t >= now && t <= now + days * 86_400_000;
}

/** Most recent successful fetch among the given queries, or null if none have settled yet. */
export function latestDataUpdatedAt(...queries: Array<{ dataUpdatedAt: number }>): number | null {
  const timestamps = queries.map((q) => q.dataUpdatedAt).filter((t) => t > 0);
  return timestamps.length ? Math.max(...timestamps) : null;
}

/** "3 minutes ago" / "2 hours ago" / "Aug 16" — matches this file's `shortWhen` precedent. */
export function relativeRefresh(ms: number): string {
  const minutes = Math.max(0, Math.round((Date.now() - ms) / 60_000));
  if (minutes < 1) return 'moments ago';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
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
  const accountOwner = useClientAccountOwner(clientId);

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
  const { search: opportunities, feature: fundingFeature } = useClientFundingOpportunitiesV2(clientId);
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

  /* Account team — the real per-client roster (`/api/clients/:id/team`).
   * `accountTeam` was hardcoded `[]` here for as long as the slot existed,
   * because no roster table existed; `client_team_members` is that table. */
  const teamQuery = useQuery({
    queryKey: clientTeamKey(clientId),
    queryFn: () => getClientTeam(api, clientId),
    staleTime: 60_000,
  });

  /* Federal footprint (wire-audit "3 Compose extend" item 3) — the real
   * LDA spend, filing count, federal award total, and lobbying trajectory
   * from the client-profile endpoint. Replaces the hardcoded FOOT_STATS
   * fixture in OverviewTab. */
  const clientProfile = useQuery<ClientIntelProfile>({
    queryKey: ['client-intel-profile', clientId],
    queryFn: async () =>
      (await api.get<ClientIntelProfile>(`/api/intelligence/client-profile/${clientId}`)).data,
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });

  /* ── Derivations ────────────────────────────────────────────────────── */

  const profile = useMemo<ClientProfileCard>(() => {
    const intake = toRecord(client.intakeData);
    return {
      name: client.name,
      initials: initialsFor(client.name),
      logoUrl: client.logoUrl ?? null,
      description: client.description ?? client.productDescription ?? null,
      // The shared humanizer tolerates the mixed sectorTag vocabulary (enum
      // value, enum-shaped artifact, free text) — see labels.ts.
      sectorLabel: sectorLabel(client.sectorTag),
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
      accountOwner: accountOwner.ownerLabel,
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
      accountTeam: (teamQuery.data ?? []).map((member: ClientTeamMember) => {
        const name = teamMemberLabel(member);
        return {
          // The owner row has no membership id (it is a `clients` column), so
          // the userId is what identifies a row uniquely across both sources.
          id: member.id ?? `owner:${member.userId}`,
          userId: member.userId,
          initials: initialsFor(name),
          name,
          role: member.role,
          isOwner: member.isOwner,
        };
      }),
      // Only a SETTLED, successful read may claim the roster is known. Loading
      // or errored stays false so the card shows a skeleton / a failure line
      // rather than asserting the team is empty.
      accountTeamAvailable: teamQuery.isSuccess,
    };
  }, [client, nextMeeting, accountOwner.ownerLabel, teamQuery.data, teamQuery.isSuccess]);

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

    // "Next 30 days" (the UI's own label — OverviewTab.tsx's MetricCell for
    // this field) is a bounded window. An open-ended milestone has no end
    // date to check against that window, so — unlike the previous
    // `node.openEnded || future(node.endsOn)` — it is no longer counted
    // unconditionally here; that produced a false "always in the next 30
    // days" claim for milestones that may be months out. `future()` keeps
    // its unbounded meaning for `nextByDate` below, which carries no such label.
    const milestones = committed.filter((node) => node.kind === 'milestone' && withinDays(node.endsOn, 30));
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
    const opportunityCount = opportunities.data?.total ?? null;

    // Comment alerts are a global feed carrying a client reference; counting the
    // whole feed would attribute every tenant's matters to this client.
    const alertRows = alerts.data?.alerts ?? [];
    const clientScoped = alertRows.filter((row) => row.clientId === clientId);
    const alertsAreClientScoped = alertRows.length === 0 || alertRows.some((row) => 'clientId' in row);

    // A facility ROW is not a district — two facilities can share one
    // district, and a client's real district footprint is the distinct
    // "ST-NN" set, not the facility count (that undercounts nothing but
    // overcounts any client with more than one facility per district).
    const distinctDistrictCount = new Set(
      (facilities.data ?? [])
        .map((f) => formatFacilityDistrict(f.state, f.congressionalDistrict))
        .filter(Boolean),
    ).size;

    const signals: string[] = [];
    const urgent = attentionAll.filter((row) => row.urgent).length;
    if (urgent > 0) signals.push(`${urgent} HIGH-PRIORITY CHANGE${urgent === 1 ? '' : 'S'}`);
    if (nextMeeting) signals.push(`NEXT MEETING ${shortWhen(nextMeeting.startsAt)}`);
    if (distinctDistrictCount > 0) signals.push(`${distinctDistrictCount} DISTRICT${distinctDistrictCount === 1 ? '' : 'S'} MAPPED`);

    const lastRefreshAt = latestDataUpdatedAt(trackerSummary, opportunities, facilities, alerts);

    return {
      trackedBills: trackerSummary.data
        ? value(trackerSummary.data.boardCount, crmHref(clientId, 'intelligence', 'legislative'))
        : unavailable('Tracker summary unavailable'),
      opportunities:
        !fundingFeature.ready || !fundingFeature.enabled
          ? unavailable('Funding opportunities unavailable')
          : opportunityCount == null
            ? unavailable('Opportunity search unavailable')
            : value(opportunityCount, crmHref(clientId, 'opportunities')),
      districts: facilities.data
        ? value(distinctDistrictCount, crmHref(clientId, 'intelligence', 'district'))
        : unavailable('Facilities unavailable'),
      regulatoryMatters: alertsAreClientScoped
        ? value(clientScoped.length, crmHref(clientId, 'intelligence', 'regulatory'))
        : unavailable('Regulatory alerts are not client-scoped'),
      signals,
      lastRefresh: lastRefreshAt == null ? null : relativeRefresh(lastRefreshAt),
    };
  }, [
    opportunities.data,
    opportunities.dataUpdatedAt,
    fundingFeature.enabled,
    fundingFeature.ready,
    alerts.data,
    alerts.dataUpdatedAt,
    facilities.data,
    facilities.dataUpdatedAt,
    trackerSummary.data,
    trackerSummary.dataUpdatedAt,
    attentionAll,
    nextMeeting,
    clientId,
  ]);

  const federalFootprint = useMemo<FederalFootprint>(() => {
    const p = clientProfile.data;
    const ready = !clientProfile.isLoading && !clientProfile.isError;
    return {
      ldaSpend: p?.lda?.matched
        ? (p.lda.totalSpending != null
          ? value(p.lda.totalSpending, undefined, 'currency')
          : unavailable('LDA spend not reported'))
        : unavailable('No LDA match for this client'),
      ldaFilings: p?.lda?.matched
        ? value(p.lda.totalFilings, undefined, 'count')
        : unavailable('No LDA match for this client'),
      // `federal_contractor.total_contracts` is Decimal(18,2) DOLLARS of award
      // obligations — not a count of awards. Rendering it as a count printed
      // RTX's $68.97B as the bare digits `68973208559.3`: the declared type says
      // `number | null`, but Prisma serializes Decimal as a STRING, so
      // `formatNumber`'s `toLocaleString` was a no-op on it (hence not even
      // thousands separators). Currency + an explicit Number() coercion, so the
      // cell is right whether the API sends a number or a decimal string.
      federalAwards: p?.contracting?.matched
        ? (p.contracting.totalContracts != null && Number.isFinite(Number(p.contracting.totalContracts))
          ? value(Number(p.contracting.totalContracts), undefined, 'currency')
          : unavailable('Contract data not reported'))
        : unavailable('No federal award match for this client'),
      // Both facts travel: the human label ("Contracting") and the YoY rate.
      // Rendering the raw growthRate as the stat (-0.376) was the bug here.
      lobbyingTrajectory: p?.lobbyIntel?.matched
        ? (p.lobbyIntel.trajectory != null
          ? { kind: 'value' as const, trajectoryLabel: p.lobbyIntel.trajectory, growthRate: p.lobbyIntel.growthRate ?? null }
          : unavailable('Lobbying trajectory not reported'))
        : unavailable('No lobbying intel match for this client'),
      ready,
      error: clientProfile.isError
        ? (clientProfile.error instanceof Error ? clientProfile.error.message : 'Could not load the federal footprint')
        : null,
      retry: () => void clientProfile.refetch(),
      registrantsLabel: p?.lda?.matched
        ? `${p.lda.totalFilings} LD-2 filing${p.lda.totalFilings === 1 ? '' : 's'}`
        : null,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refetch is stable
  }, [clientProfile.data, clientProfile.isLoading, clientProfile.isError, clientProfile.error]);

  return {
    profile,
    account,
    accountStatus: statusOf(meetings),
    accountTeamStatus: statusOf(teamQuery),
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
    federalFootprint,
  };
}
