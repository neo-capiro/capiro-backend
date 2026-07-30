/**
 * Phase 5 — Trust-first PE web helpers (pure).
 *
 * URL deep-link, tab enablement, surface load states, claim copy text,
 * and mark-bearing cycle labeling derived only from stored year marks
 * (zeros count; no projected-enacted substitution).
 */

import type { FundingClaim } from '@capiro/shared/funding-claim';
import {
  FUNDING_CLAIM_STAGE_LABEL,
  currentCycleFyPreservingZero,
} from '@capiro/shared/funding-claim';
import type { ProgramElementYearPoint } from './types.js';

/** Allowed PE Watch sub-tabs (URL `tab=` values). */
export const PE_WATCH_TABS = [
  'overview',
  'funding',
  'procurement',
  'legislation',
  'relationships',
  'incumbents',
  'team',
  'approp',
  'proof',
] as const;

export type PeWatchTab = (typeof PE_WATCH_TABS)[number];

export type PeSurfaceState =
  | 'loading'
  | 'failed'
  | 'not_found'
  | 'not_ingested'
  | 'unsupported'
  | 'partial'
  | 'complete_empty'
  | 'complete_with_data';

export interface PeWatchUrlState {
  tab: PeWatchTab;
  fy: number | null;
}

const TAB_SET = new Set<string>(PE_WATCH_TABS);

export function parsePeWatchTab(raw: string | null | undefined): PeWatchTab {
  if (raw && TAB_SET.has(raw)) return raw as PeWatchTab;
  return 'overview';
}

export function parsePeWatchFy(raw: string | null | undefined): number | null {
  if (raw == null || raw === '') return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 1970 && n <= 2100 ? n : null;
}

/** Read tab + fy from a URLSearchParams-like map. */
export function readPeWatchUrlState(params: {
  get(name: string): string | null;
}): PeWatchUrlState {
  return {
    tab: parsePeWatchTab(params.get('tab')),
    fy: parsePeWatchFy(params.get('fy')),
  };
}

/** Build search params string (no leading `?`). Drops defaults. */
export function serializePeWatchUrlState(state: PeWatchUrlState): string {
  const p = new URLSearchParams();
  if (state.tab && state.tab !== 'overview') p.set('tab', state.tab);
  if (state.fy != null) p.set('fy', String(state.fy));
  return p.toString();
}

export function isPeWatchTab(value: string): value is PeWatchTab {
  return TAB_SET.has(value);
}

/** Tabs valid for the current line type (procurement-only / team always ok). */
export function filterTabsForLineType(
  tabs: readonly PeWatchTab[],
  lineType: string | null,
): PeWatchTab[] {
  const isProc = lineType === 'PROCUREMENT_BLIN';
  const isRdte = lineType === 'RDTE_PE' || lineType === null;
  return tabs.filter((t) => {
    if (t === 'procurement') return isProc;
    if (t === 'incumbents') return isRdte || isProc;
    return true;
  });
}

/**
 * Which secondary fetches a tab mount is allowed to fire.
 * Detail is always on. Bills + intelligence stay on for hero/KPI strip.
 */
export type PeWatchQueryBucket =
  | 'bills'
  | 'intelligence'
  | 'contractors'
  | 'personnel'
  | 'sources'
  | 'programs'
  | 'clientRelevance'
  | 'deltas'
  | 'projects'
  | 'related'
  | 'provisions'
  | 'opportunities'
  | 'procurementLines'
  | 'actions'
  | 'relationships'
  | 'incumbents'
  | 'billActions';

const TAB_QUERY_MAP: Record<PeWatchTab, readonly PeWatchQueryBucket[]> = {
  overview: ['bills', 'intelligence', 'projects', 'actions', 'relationships', 'billActions'],
  funding: ['bills', 'intelligence'],
  procurement: ['bills', 'intelligence', 'procurementLines'],
  legislation: ['bills', 'intelligence', 'actions', 'provisions', 'opportunities', 'billActions'],
  relationships: ['bills', 'intelligence', 'relationships', 'programs', 'related'],
  incumbents: ['bills', 'intelligence', 'incumbents', 'contractors'],
  team: ['bills', 'intelligence', 'personnel'],
  approp: ['bills', 'intelligence'],
  proof: ['bills', 'intelligence', 'deltas', 'clientRelevance', 'sources'],
};

export function peWatchQueriesForTab(tab: PeWatchTab): ReadonlySet<PeWatchQueryBucket> {
  return new Set(TAB_QUERY_MAP[tab] ?? TAB_QUERY_MAP.overview);
}

export function peWatchQueryEnabled(
  tab: PeWatchTab,
  bucket: PeWatchQueryBucket,
  peCodePresent: boolean,
): boolean {
  if (!peCodePresent) return false;
  return peWatchQueriesForTab(tab).has(bucket);
}

export interface ResolvePeSurfaceInput {
  peCodePresent: boolean;
  isLoading: boolean;
  isError: boolean;
  /** HTTP-ish status when known (404 → not_found). */
  errorStatus?: number | null;
  hasDetail: boolean;
  yearCount: number;
  /** Catalog marks this line/type as intentionally unsupported (e.g. classified family). */
  unsupported?: boolean;
  /**
   * True when some secondary section of the *active* view failed while detail
   * still loaded (partial data disclosure).
   */
  secondaryFailed?: boolean;
  /** Line finished earlier cycles (still "complete" but historical). */
  isHistoricalOnly?: boolean;
}

export function resolvePeSurfaceState(input: ResolvePeSurfaceInput): PeSurfaceState {
  if (!input.peCodePresent) return 'failed';
  if (input.isLoading) return 'loading';
  if (input.isError || !input.hasDetail) {
    if (input.errorStatus === 404) return 'not_found';
    return 'failed';
  }
  if (input.unsupported) return 'unsupported';
  if (input.yearCount === 0) return 'not_ingested';
  if (input.secondaryFailed) return 'partial';
  // Years present but every dollar null is still ingested structure — complete empty.
  return input.yearCount > 0 ? 'complete_with_data' : 'complete_empty';
}

export function peSurfaceFailedAsEmpty(state: PeSurfaceState): boolean {
  return state === 'failed' || state === 'not_found';
}

/** Stage/vehicle labels for the trust header from PE mark-bearing cycle. */
export function deriveTrustCycleFromYears(years: ProgramElementYearPoint[]): {
  currentFy: number | null;
  stageLabel: string | null;
  vehicleLabel: string | null;
} {
  const marks = years.map((y) => ({
    fy: y.fy,
    request: toNum(y.request),
    hascMark: toNum(y.hascMark),
    sascMark: toNum(y.sascMark),
    hacDMark: toNum(y.hacDMark),
    sacDMark: toNum(y.sacDMark),
    conference: toNum(y.conference),
    ndaaConference: toNum(y.ndaaConference),
    enacted: toNum(y.enacted),
  }));
  const currentFy = currentCycleFyPreservingZero(marks);
  if (currentFy == null) {
    return { currentFy: null, stageLabel: null, vehicleLabel: null };
  }
  const row = marks.find((m) => m.fy === currentFy);
  if (!row) return { currentFy, stageLabel: null, vehicleLabel: null };

  // Furthest-along on the appropriations ladder first; NDAA alone is still a real mark.
  const ladder: Array<{ stage: keyof typeof FUNDING_CLAIM_STAGE_LABEL; vehicle: string; v: number | null }> =
    [
      { stage: 'enacted', vehicle: 'Enacted appropriation', v: row.enacted },
      { stage: 'appropriations_conference', vehicle: 'Appropriations conference', v: row.conference },
      { stage: 'sacd', vehicle: 'SAC-D mark', v: row.sacDMark },
      { stage: 'hacd', vehicle: 'HAC-D mark', v: row.hacDMark },
      { stage: 'ndaa_conference', vehicle: 'NDAA conference (authorization)', v: row.ndaaConference },
      { stage: 'sasc', vehicle: 'SASC mark (authorization)', v: row.sascMark },
      { stage: 'hasc', vehicle: 'HASC mark (authorization)', v: row.hascMark },
      { stage: 'request', vehicle: "President's Budget request", v: row.request },
    ];
  for (const step of ladder) {
    if (step.v != null) {
      return {
        currentFy,
        stageLabel: FUNDING_CLAIM_STAGE_LABEL[step.stage],
        vehicleLabel: step.vehicle,
      };
    }
  }
  return { currentFy, stageLabel: null, vehicleLabel: null };
}

function toNum(v: string | number | null | undefined): number | null {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const t = v.trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

export interface CopyClaimInput {
  peCode: string;
  title?: string | null;
  claim: Pick<FundingClaim, 'value' | 'fiscalYear' | 'stageLabel' | 'legislativeVehicle' | 'unit' | 'isProjection' | 'cycleClass'>;
  /** Citation tail — e.g. source attribution or verification time. */
  citation: string;
}

/** Clipboard body for "copy claim with citation". Never invents absent dollars. */
export function formatClaimWithCitation(input: CopyClaimInput): string | null {
  const { peCode, title, claim, citation } = input;
  if (claim.value == null || claim.fiscalYear == null) return null;
  const fy = `FY${claim.fiscalYear}`;
  const dollars =
    claim.value === 0 ? '$0M' : `$${Number(claim.value).toLocaleString('en-US', { maximumFractionDigits: 3 })}M`;
  const proj = claim.isProjection || claim.cycleClass === 'outyear' ? ' [FYDP projection — not current-cycle request]' : '';
  const head = title ? `${peCode} (${title})` : peCode;
  const cite = citation.trim() || 'source not recorded';
  return `${head} — ${fy} ${claim.stageLabel}: ${dollars} (${claim.unit}; vehicle: ${claim.legislativeVehicle})${proj}. Citation: ${cite}`;
}

/** Source coverage chips derived from counts already on the detail payload. */
export function buildSourceCoverageSummary(input: {
  yearCount: number;
  sourceCount?: number | null;
  projectCount?: number | null;
  billCount?: number | null;
  hasDescription?: boolean;
}): string[] {
  const chips: string[] = [];
  chips.push(input.yearCount > 0 ? `Budget years: ${input.yearCount}` : 'Budget years: none ingested');
  if (input.sourceCount != null) {
    chips.push(input.sourceCount > 0 ? `Citations: ${input.sourceCount}` : 'Citations: none registered');
  }
  if (input.projectCount != null) {
    chips.push(input.projectCount > 0 ? `R-2A projects: ${input.projectCount}` : 'R-2A projects: none');
  }
  if (input.billCount != null) {
    chips.push(input.billCount > 0 ? `Bills linked: ${input.billCount}` : 'Bills linked: none');
  }
  if (input.hasDescription === false) chips.push('Mission description: missing');
  else if (input.hasDescription === true) chips.push('Mission description: present');
  return chips;
}

/** Extract fiscal year tokens from a P-40 sourceBook slug/title when present. */
export function sourceFyFromPdocBook(sourceBook: string | null | undefined): number | null {
  if (!sourceBook) return null;
  const m = sourceBook.match(/(?:FY|fy)[\s_-]*((?:19|20)\d{2})/);
  if (m?.[1]) return Number(m[1]);
  const bare = sourceBook.match(/\b((?:19|20)\d{2})\b/);
  return bare?.[1] ? Number(bare[1]) : null;
}

export function formatPdocSourceLine(sourceBook: string | null | undefined): string | null {
  if (!sourceBook) return null;
  const fy = sourceFyFromPdocBook(sourceBook);
  const book = sourceBook.replace(/_/g, ' ');
  if (fy != null) {
    // Avoid "FY2027 FY2027 Navy …" if the book already embeds FY.
    const bookWithoutDupFy = book.replace(new RegExp(`FY\\s*${fy}`, 'i'), '').trim();
    return `Source: FY${fy} ${bookWithoutDupFy || book} P-40 exhibit`;
  }
  return `Source: ${book} P-40 exhibit (source fiscal year not recorded on exhibit metadata)`;
}

/** Fingerprint badge: only when a real hash exists; never imply archive parity. */
export function proofFingerprintLabel(sha256: string | null | undefined): {
  short: string;
  title: string;
} | null {
  if (!sha256 || sha256.trim().length < 16) return null;
  const clean = sha256.trim().toLowerCase();
  return {
    short: `sha256 ${clean.slice(0, 12)}…`,
    title: `Content fingerprint sha256:${clean}. Confirms the bytes that were ingested; not a substitute for the full source archive or page image.`,
  };
}
