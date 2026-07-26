import type { AxiosInstance } from 'axios';

/**
 * District Nexus v2 — web-side type mirror and fetch functions.
 *
 * Mirrors apps/api/src/district-nexus/district-nexus.types.ts (WS-A Step A3)
 * and the boundary manifest/artifact contract in
 * apps/api/src/directory/boundary-artifact.util.ts (WS-D Step D2, served via
 * IntelligenceController). Kept as a docblock-mirrored file per the repo's
 * dominant convention rather than a `packages/shared` import — see the
 * client-widget precedent at
 * apps/web/src/pages/clients/intelligence-v1/district-nexus-api.ts.
 *
 * ── The one rule that shapes every money field below ────────────────────────
 * There is deliberately NO `totalAmount` anywhere in this file. Contracts,
 * awarded grants, grant outlays and grant *opportunities* are different kinds
 * of number; summing them produces a figure that is wrong in a way nobody can
 * see. Callers that want a headline number must choose which one and label it.
 */

/** ISO-8601 timestamp. */
export type IsoTimestamp = string;

/**
 * Whole US dollars unless a field says otherwise. `null` means "we have no
 * figure" — NOT the same as 0 ("we looked, it's zero"). Never render null as $0.
 */
export type Money = number | null;

/** `<STATE>-<2-char district code>`, e.g. `TX-23`, `WY-00`. Matches BoundaryFeature.id. */
export type DistrictKey = string;

/** Mirrors apps/api/src/clients/representation-resolver.service.ts. Duplicated
 * per feature folder rather than cross-imported from the client-widget's
 * local mirror — see that file's own docblock for the same convention note. */
export interface FederalMemberSummary {
  bioguideId: string;
  fullName: string;
  party: string | null;
  state: string | null;
  district: number | null;
  chamber: string;
}

// ── Provenance, freshness, warnings ─────────────────────────────────────────

export interface SourceFreshness {
  /** Stable rail identifier — the ingestion verb name. */
  source: string;
  /** Operator-readable rail name for the freshness strip. */
  label: string;
  lastSyncedAt: IsoTimestamp | null;
  /** True when the source has never completed a successful run. */
  neverSynced: boolean;
  /** True when this rail's job records no SyncRun at all — freshness is
   * genuinely UNKNOWN rather than absent. Distinct from `neverSynced`. */
  freshnessUnavailable?: boolean;
}

export type DataQualityWarningCode =
  | 'statewide_attribution'
  | 'recipient_location_fallback'
  | 'inferred_entity_match'
  | 'stale_source'
  | 'unmapped_amount'
  | 'opportunity_only';

export interface DataQualityWarning {
  code: DataQualityWarningCode;
  message: string;
  districtKey?: DistrictKey;
}

// ── Evidence and scoring ────────────────────────────────────────────────────

export interface NexusEvidence {
  component: string;
  kind: string;
  label: string;
  sourceId: string | null;
  sourceSystem: string | null;
  amount: Money;
  observedAt: IsoTimestamp | null;
}

export interface NexusScoreBreakdown {
  component: string;
  label: string;
  weight: number;
  /** Exact, unrounded contribution: weight x strength multiplier. */
  credit: number;
  rationale: string;
  evidenceCount: number;
}

// ── Money, kept unambiguous ─────────────────────────────────────────────────

export interface AwardedFunding {
  contractObligations: Money;
  grantObligations: Money;
  /** Paid out, as distinct from obligated. Never summed with obligations. */
  grantOutlays: Money;
}

/** Prospective money — never added to AwardedFunding, never scored as awarded. */
export interface OpportunityFunding {
  opportunityEstimatedFunding: Money;
  opportunityAwardCeiling: Money;
}

/** Money we know about but could not attribute to a district. */
export interface UnmappedFunding {
  unmappedContractAmount: Money;
  unmappedGrantAmount: Money;
}

// ── Responses ───────────────────────────────────────────────────────────────

export interface DistrictNexusDistrictSummary {
  districtKey: DistrictKey;
  state: string;
  districtCode: string;
  /** 'C' current | 'F' future (enacted, not yet effective). */
  status: 'C' | 'F';
  name: string | null;
  awarded: AwardedFunding;
  opportunities: OpportunityFunding;
  clientCount: number;
  /** 0-100, rounded. Null when there is too little evidence to score honestly. */
  score: number | null;
  /** Share of total scoring weight backed by determinate evidence, 0-100. */
  coveragePercent: number;
  /** Null means "no figure" — NOT zero. See `employeesUnreported`. */
  employeeCount: number | null;
  employeesUnreported: boolean;
  warnings: DataQualityWarning[];
}

export interface DistrictNexusMapResponse {
  districts: DistrictNexusDistrictSummary[];
  unmapped: UnmappedFunding;
  freshness: SourceFreshness[];
  warnings: DataQualityWarning[];
  generatedAt: IsoTimestamp;
}

export interface DistrictNexusDistrictDetail extends DistrictNexusDistrictSummary {
  evidence: NexusEvidence[];
  breakdown: NexusScoreBreakdown[];
  freshness: SourceFreshness[];
}

export interface DistrictDemographics {
  congress: number;
  dataYear: number;
  totalPopulation: number | null;
  medianHouseholdIncome: number | null;
  medianAge: number | null;
  percentBachelorPlus: number | null;
  percentPoverty: number | null;
  percentVeteran: number | null;
  percentUninsured: number | null;
  laborForceSize: number | null;
  unemploymentRate: number | null;
}

export interface DistrictClientSummary {
  clientId: string;
  clientName: string;
  awarded: AwardedFunding;
  facilityCount: number;
  employeeCount: number | null;
}

export interface DistrictFacilitySummary {
  id: string;
  name: string;
  city: string | null;
  clientId: string;
  clientName: string;
  employeeCount: number | null;
}

/** One award row for the drawer's "top awards" list — a single instrument's
 * figure, never a blend. The list it belongs to says which. */
export interface TopAward {
  id: string;
  label: string;
  counterparty: string | null;
  amount: Money;
  awardedAt: IsoTimestamp | null;
  externalUrl: string | null;
}

export interface DistrictNexusDistrictDetailResponse extends DistrictNexusDistrictDetail {
  /** Null when the district code cannot resolve a House seat at all (a
   * sentinel like '90'/'98'), as distinct from a resolvable district whose
   * member simply is not in the roster (`{ house: null, senate: [...] }`). */
  representatives: {
    house: FederalMemberSummary | null;
    senate: FederalMemberSummary[];
  } | null;
  clients: DistrictClientSummary[];
  facilities: DistrictFacilitySummary[];
  topContractAwards: TopAward[];
  topGrantAwards: TopAward[];
  demographics: DistrictDemographics | null;
  boundaryAvailable: boolean;
  generatedAt: IsoTimestamp;
}

// ── Boundary artifact (WS-D Step D2) ────────────────────────────────────────

export type BoundaryStatus = 'C' | 'F';
export type BoundarySource = 'census_cartographic_500k' | 'legistorm_kml';

export interface BoundaryManifest {
  status: 'current' | 'future';
  vintage: string;
  generatedAt: IsoTimestamp;
  districtCount: number;
  source: BoundarySource;
  hash: string;
  gzipBytes: number;
  warnings: string[];
}

export interface BoundaryFeatureProperties {
  state: string;
  /** Facility-style: 2-char zero-padded, '00' at-large. */
  districtCode: string;
  status: 'C' | 'F';
  vintage: string;
  legislativeDistrictId: string | null;
  name: string | null;
  bbox: [number, number, number, number];
  centroid: [number, number];
}

export interface BoundaryFeature {
  type: 'Feature';
  /** `<STATE>-<districtCode>` — matches DistrictKey. */
  id: string;
  geometry:
    | { type: 'Polygon'; coordinates: number[][][] }
    | { type: 'MultiPolygon'; coordinates: number[][][][] };
  properties: BoundaryFeatureProperties;
}

export interface BoundaryFeatureCollection {
  type: 'FeatureCollection';
  bbox: [number, number, number, number];
  features: BoundaryFeature[];
}

// ── Query params ─────────────────────────────────────────────────────────────

export interface DistrictNexusMapQuery {
  /** Only 'current' is accepted by the API today; 'future' 400s until a
   * future boundary artifact exists. Kept as a param (not hardcoded) so the
   * UI only needs its disabled-toggle guard lifted once the rail is live. */
  view?: 'current' | 'future';
  clientId?: string;
  state?: string;
}

export interface DistrictNexusDistrictDetailQuery {
  view?: 'current' | 'future';
  clientId?: string;
}

// ── Fetch functions ──────────────────────────────────────────────────────────

export async function getDistrictNexusMap(
  api: AxiosInstance,
  query: DistrictNexusMapQuery = {},
): Promise<DistrictNexusMapResponse> {
  return (
    await api.get<DistrictNexusMapResponse>('/api/intelligence/district-nexus/map', {
      params: query,
    })
  ).data;
}

export async function getDistrictNexusDistrictDetail(
  api: AxiosInstance,
  state: string,
  district: string,
  query: DistrictNexusDistrictDetailQuery = {},
): Promise<DistrictNexusDistrictDetailResponse> {
  return (
    await api.get<DistrictNexusDistrictDetailResponse>(
      `/api/intelligence/district-nexus/districts/${encodeURIComponent(state)}/${encodeURIComponent(district)}`,
      { params: query },
    )
  ).data;
}

export async function getDistrictBoundaryManifest(
  api: AxiosInstance,
  status: BoundaryStatus = 'C',
): Promise<BoundaryManifest> {
  return (
    await api.get<BoundaryManifest>('/api/intelligence/district-nexus/boundaries', {
      params: { status },
    })
  ).data;
}

/**
 * The artifact itself — served gzipped with a strong ETag by the API
 * (Content-Encoding: gzip), which axios/the browser decompress transparently.
 * No client-side gzip handling needed, matching the prototype's own plain
 * `fetch(url).then(r => r.json())` pattern.
 */
export async function getDistrictBoundaryGeoJson(
  api: AxiosInstance,
  status: BoundaryStatus = 'C',
): Promise<BoundaryFeatureCollection> {
  return (
    await api.get<BoundaryFeatureCollection>(
      `/api/intelligence/district-nexus/boundaries/${status}/geojson`,
    )
  ).data;
}
