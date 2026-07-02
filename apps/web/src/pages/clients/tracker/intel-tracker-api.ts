/**
 * intel-api route map + response adapters for the client-profile Tracker tab
 * (Phase 7 repoint, plan §10). When `tracker_v2` is ON for a tenant, the tab
 * reads/writes intel-api instead of the legacy apps/api tracker; the render code
 * is unchanged because these adapters map intel-api's shapes onto the SAME
 * frontend types in tracker-api.ts.
 *
 * SCOPE: Board, Recommendations, Watchlist, Alert-prefs, Track/Untrack/Feedback
 * repoint to intel-api. The auxiliary endpoints intel-api does not (yet) serve —
 * bill-search, seed-suggestions, SMS verify, test-alert, issue-areas — stay on
 * legacy apps/api regardless of the flag (see TrackerTab). During shadow the
 * intel watchlist is kept in sync from legacy (scheduled sync), so recs computed
 * from it stay consistent.
 *
 * NOTE: dormant until `tracker_v2` is flipped at cutover — needs browser QA then.
 */
import type {
  AlertPrefsPayload,
  BillStage,
  BoardBillChange,
  BoardResponse,
  ChangeTone,
  MatchReason,
  MatchReasonKind,
  RecommendationsResponse,
  TagPosition,
  TagPriority,
  WatchlistPayload,
} from './tracker-api.js';

const enc = encodeURIComponent;

export const intelTrackerPaths = {
  board: (c: string) => `/intel-api/clients/${enc(c)}/tracker/board`,
  recommendations: (c: string) => `/intel-api/clients/${enc(c)}/recommendations`,
  track: (c: string) => `/intel-api/clients/${enc(c)}/tracker/track`,
  untrack: (c: string) => `/intel-api/clients/${enc(c)}/tracker/untrack`,
  feedback: (c: string) => `/intel-api/clients/${enc(c)}/tracker/feedback`,
  watchlist: (c: string) => `/intel-api/tracker/watchlists/${enc(c)}`,
  alertPrefs: (c: string) => `/intel-api/tracker/watchlists/${enc(c)}/alert-prefs`,
};

// ── intel-api response shapes (subset consumed here) ────────────────────────
interface IntelBoardCard {
  billId: string;
  displayNum: string;
  title: string | null;
  stage: BillStage;
  passageProbability: number;
  latestActionText: string | null;
  latestActionDate: string | null;
  note: string | null;
  isManual: boolean;
  unread: boolean;
  trackedAt: string;
  matchedTags: string[];
  changeChip: { label: string; changeType: string | null; at: string } | null;
}
interface IntelBoard {
  columns: Array<{ id: BillStage; label: string; cards: IntelBoardCard[] }>;
}
interface IntelRec {
  billId: string;
  displayNum: string;
  title: string | null;
  stage: BillStage;
  passageProbability: number;
  latestActionText: string | null;
  latestActionDate: string | null;
  sponsorName: string | null;
  sponsorParty: string | null;
  cosponsorsCount: number | null;
  fit: number;
  matchedTags: string[];
  why: string;
  whyKind: MatchReasonKind;
  matchReasons: MatchReason[];
}
interface IntelWatchlist {
  clientId: string;
  issueAreas: string[];
  topics: Array<{
    label: string;
    issueArea: string | null;
    position: string;
    priority: string;
    terms: Array<{ termType: string; value: string }>;
  }>;
}
interface IntelAlertPrefs {
  triggers?: string[];
  materiality?: string;
  emailEnabled?: boolean;
  emailAddress?: string | null;
  emailCadence?: string;
  smsEnabled?: boolean;
  smsPhone?: string | null;
  smsPhoneVerified?: boolean;
  smsCadence?: string;
  quietHoursStart?: string | null;
  quietHoursEnd?: string | null;
}

const CRITICAL_CHANGE_TYPES = ['bill_enacted', 'bill_to_president', 'bill_failed'];

function changeChipToChange(chip: IntelBoardCard['changeChip']): BoardBillChange | null {
  if (!chip) return null;
  const tone: ChangeTone = CRITICAL_CHANGE_TYPES.includes(chip.changeType ?? '') ? 'critical' : 'notable';
  return { tone, label: chip.label, dot: true };
}

/** intel `GET tracker/board` → legacy BoardResponse. */
export function adaptBoard(b: IntelBoard): BoardResponse {
  const columns = b.columns.map((col) => {
    const bills = col.cards.map((c) => ({
      billId: c.billId,
      displayNum: c.displayNum,
      title: c.title ?? '',
      stage: c.stage,
      probability: c.passageProbability,
      tags: c.matchedTags ?? [],
      isManual: true as const,
      trackedAt: typeof c.trackedAt === 'string' ? c.trackedAt : new Date(c.trackedAt).toISOString(),
      unread: Boolean(c.unread),
      change: changeChipToChange(c.changeChip),
    }));
    return { id: col.id, label: col.label, count: bills.length, bills };
  });
  return { columns, total: columns.reduce((n, c) => n + c.bills.length, 0) };
}

export const RECOMMENDATION_FLOOR = 0.45;

/** intel `GET recommendations` (array) → legacy RecommendationsResponse. */
export function adaptRecs(items: IntelRec[]): RecommendationsResponse {
  const recommendations = items.map((r) => ({
    billId: r.billId,
    displayNum: r.displayNum,
    title: r.title ?? '',
    stage: r.stage,
    probability: r.passageProbability,
    fit: r.fit,
    belowFloor: r.fit < RECOMMENDATION_FLOOR,
    matchedTags: r.matchedTags ?? [],
    matchReasons: r.matchReasons ?? [],
    whyKind: r.whyKind,
    why: r.why,
    latestAction: r.latestActionText ?? null,
    latestActionDate: r.latestActionDate ? String(r.latestActionDate).slice(0, 10) : null,
    sponsorName: r.sponsorName ?? null,
    sponsorParty: r.sponsorParty ?? null,
    cosponsorsCount: r.cosponsorsCount ?? 0,
  }));
  return {
    recommendations,
    aboveFloorCount: recommendations.filter((r) => !r.belowFloor).length,
    total: recommendations.length,
    floor: RECOMMENDATION_FLOOR,
  };
}

/** intel `GET tracker/watchlists/:c` → legacy WatchlistPayload. */
export function adaptWatchlist(w: IntelWatchlist): WatchlistPayload {
  return {
    issueAreas: w.issueAreas ?? [],
    tags: (w.topics ?? []).map((t) => ({
      tag: t.label,
      issueArea: t.issueArea ?? null,
      synonyms: t.terms.filter((x) => x.termType === 'synonym').map((x) => x.value),
      relatedEntities: t.terms.filter((x) => x.termType === 'entity').map((x) => x.value),
      riskTerms: t.terms.filter((x) => x.termType === 'risk').map((x) => x.value),
      position: (t.position as TagPosition) ?? 'monitor',
      priority: (t.priority as TagPriority) ?? 'med',
    })),
  };
}

/** legacy WatchlistPayload → intel `PUT tracker/watchlists/:c` body. */
export function watchlistToIntel(w: WatchlistPayload) {
  return {
    issueAreas: w.issueAreas,
    topics: w.tags.map((t) => ({
      label: t.tag,
      issueArea: t.issueArea ?? null,
      position: t.position ?? 'monitor',
      priority: t.priority,
      terms: [
        ...t.synonyms.map((v) => ({ termType: 'synonym', value: v })),
        ...t.relatedEntities.map((v) => ({ termType: 'entity', value: v })),
        ...t.riskTerms.map((v) => ({ termType: 'risk', value: v })),
      ],
    })),
  };
}

/** intel `GET .../alert-prefs` → legacy AlertPrefsPayload. */
export function adaptPrefs(p: IntelAlertPrefs): AlertPrefsPayload {
  return {
    triggers: p.triggers ?? [],
    materiality: (p.materiality as AlertPrefsPayload['materiality']) ?? 'medium',
    emailEnabled: Boolean(p.emailEnabled),
    emailAddress: p.emailAddress ?? null,
    emailCadence: (p.emailCadence as AlertPrefsPayload['emailCadence']) ?? 'realtime',
    smsEnabled: Boolean(p.smsEnabled),
    smsPhone: p.smsPhone ?? null,
    smsPhoneVerified: Boolean(p.smsPhoneVerified),
    smsCadence: (p.smsCadence as AlertPrefsPayload['smsCadence']) ?? 'realtime',
    quietHoursStart: p.quietHoursStart ?? null,
    quietHoursEnd: p.quietHoursEnd ?? null,
  };
}

/** legacy AlertPrefsPayload → intel `PUT .../alert-prefs` body (verification is separate). */
export function prefsToIntel(p: AlertPrefsPayload) {
  return {
    triggers: p.triggers,
    materiality: p.materiality,
    emailEnabled: p.emailEnabled,
    emailAddress: p.emailAddress,
    emailCadence: p.emailCadence,
    smsEnabled: p.smsEnabled,
    smsPhone: p.smsPhone,
    smsCadence: p.smsCadence,
    quietHoursStart: p.quietHoursStart,
    quietHoursEnd: p.quietHoursEnd,
  };
}

export type { IntelBoard, IntelRec, IntelWatchlist, IntelAlertPrefs };
