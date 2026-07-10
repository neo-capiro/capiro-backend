/**
 * intel-api route map + response adapters for the client-profile Tracker tab
 * (Phase 7 repoint, plan §10). When `tracker_v2` is ON for a tenant, the tab
 * reads/writes intel-api instead of the legacy apps/api tracker; the render code
 * is unchanged because these adapters map intel-api's shapes onto the SAME
 * frontend types in tracker-api.ts.
 *
 * SCOPE: Board, Recommendations, Watchlist, Alert-prefs, Track/Untrack/Feedback
 * repoint to intel-api, plus the five aux endpoints ported in P1.1 —
 * bill-search, seed-suggestions, SMS verify, test-alert, issue-areas — and the
 * tab-badge summary, which intel-api now serves with legacy-identical response
 * shapes (no adapters).
 * During shadow the intel watchlist is kept in sync from legacy (scheduled
 * sync), so recs computed from it stay consistent.
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
  // Tab-badge counts (ClientProfilePage) — legacy-identical `{ boardCount, unread }`, no adapter.
  summary: (c: string) => `/intel-api/clients/${enc(c)}/tracker/summary`,
  recommendations: (c: string) => `/intel-api/clients/${enc(c)}/recommendations`,
  track: (c: string) => `/intel-api/clients/${enc(c)}/tracker/track`,
  untrack: (c: string) => `/intel-api/clients/${enc(c)}/tracker/untrack`,
  feedback: (c: string) => `/intel-api/clients/${enc(c)}/tracker/feedback`,
  watchlist: (c: string) => `/intel-api/tracker/watchlists/${enc(c)}`,
  alertPrefs: (c: string) => `/intel-api/tracker/watchlists/${enc(c)}/alert-prefs`,
  // P1.1 aux ports — legacy-identical response shapes, no adapters.
  issueAreas: () => `/intel-api/tracker/issue-areas`,
  billSearch: (c: string) => `/intel-api/clients/${enc(c)}/tracker/bill-search`,
  seedSuggestions: (c: string) => `/intel-api/tracker/watchlists/${enc(c)}/seed-suggestions`,
  smsStart: (c: string) => `/intel-api/clients/${enc(c)}/tracker/sms/verify/start`,
  smsConfirm: (c: string) => `/intel-api/clients/${enc(c)}/tracker/sms/verify/confirm`,
  testAlert: (c: string) => `/intel-api/clients/${enc(c)}/tracker/test-alert`,
  // Phase 9 — Bill→Hearing interlink: hearings that discussed a tracked bill.
  billHearings: (c: string, billId: string) =>
    `/intel-api/clients/${enc(c)}/bills/${enc(billId)}/hearings`,
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
  // Phase 9 (Bill→Hearing interlink): "discussed in N hearings" chip data.
  lastHearingSessionId?: string | null;
  lastHearingAt?: string | null;
  hearingCount?: number;
  /** State Legislation Platform (S7.2) — 2-letter state code; absent/'US' = federal. */
  jurisdiction?: string;
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
  /** State Legislation Platform (S7.2) — 2-letter state code; absent/'US' = federal. */
  jurisdiction?: string;
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
  /** P6 sector-default suggestion (set only when the client has no persisted watchlist). */
  suggestedIssueAreas?: string[];
  /** State Legislation Platform (DD5) — empty = federal-only. */
  jurisdictions?: string[];
  /** Facility-derived jurisdiction suggestion (S5.1), same posture as suggestedIssueAreas. */
  suggestedJurisdictions?: string[];
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
  /** State Legislation Platform (DD5) — empty = ALL jurisdictions the client's watchlist produces. */
  jurisdictions?: string[];
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
      hearingCount: c.hearingCount ?? 0,
      lastHearingSessionId: c.lastHearingSessionId ?? null,
      jurisdiction: c.jurisdiction,
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
    jurisdiction: r.jurisdiction,
  }));
  return {
    recommendations,
    aboveFloorCount: recommendations.filter((r) => !r.belowFloor).length,
    total: recommendations.length,
    floor: RECOMMENDATION_FLOOR,
  };
}

/**
 * The three LEGACY implicit term types owned by the Configure panel's chip
 * inputs. Every other term type (the 11 canonical types + any unknown
 * hearing-native type) rides in `WatchlistTag.typedTerms` so nothing is lost.
 */
const LEGACY_CHIP_TERM_TYPES = new Set(['synonym', 'entity', 'risk']);

/** intel `GET tracker/watchlists/:c` → legacy WatchlistPayload (P5: all types round-trip). */
export function adaptWatchlist(w: IntelWatchlist): WatchlistPayload {
  const payload: WatchlistPayload = {
    issueAreas: w.issueAreas ?? [],
    tags: (w.topics ?? []).map((t) => ({
      tag: t.label,
      issueArea: t.issueArea ?? null,
      synonyms: t.terms.filter((x) => x.termType === 'synonym').map((x) => x.value),
      relatedEntities: t.terms.filter((x) => x.termType === 'entity').map((x) => x.value),
      riskTerms: t.terms.filter((x) => x.termType === 'risk').map((x) => x.value),
      // Everything that is NOT one of the three legacy chip types is preserved
      // verbatim as a typed term (the 11 canonical types + unknown types).
      typedTerms: t.terms
        .filter((x) => !LEGACY_CHIP_TERM_TYPES.has(x.termType))
        .map((x) => ({ termType: x.termType, value: x.value })),
      position: (t.position as TagPosition) ?? 'monitor',
      priority: (t.priority as TagPriority) ?? 'med',
    })),
  };
  // P6: a never-configured client carries the sector-derived default (read hint).
  if (w.suggestedIssueAreas && w.suggestedIssueAreas.length) {
    payload.suggestedIssueAreas = w.suggestedIssueAreas;
  }
  // State Legislation Platform (DD5) — empty = federal-only (unchanged default).
  payload.jurisdictions = w.jurisdictions ?? [];
  if (w.suggestedJurisdictions && w.suggestedJurisdictions.length) {
    payload.suggestedJurisdictions = w.suggestedJurisdictions;
  }
  return payload;
}

/** legacy WatchlistPayload → intel `PUT tracker/watchlists/:c` body (P5: all types round-trip). */
export function watchlistToIntel(w: WatchlistPayload) {
  return {
    issueAreas: w.issueAreas,
    jurisdictions: w.jurisdictions ?? [],
    topics: w.tags.map((t) => ({
      label: t.tag,
      issueArea: t.issueArea ?? null,
      position: t.position ?? 'monitor',
      priority: t.priority,
      terms: [
        ...t.synonyms.map((v) => ({ termType: 'synonym', value: v })),
        ...t.relatedEntities.map((v) => ({ termType: 'entity', value: v })),
        ...t.riskTerms.map((v) => ({ termType: 'risk', value: v })),
        // Canonical + unknown typed terms, kept exactly as stored.
        ...(t.typedTerms ?? []).map((x) => ({ termType: x.termType, value: x.value })),
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
    jurisdictions: p.jurisdictions ?? [],
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
    jurisdictions: p.jurisdictions ?? [],
  };
}

export type { IntelBoard, IntelRec, IntelWatchlist, IntelAlertPrefs };
