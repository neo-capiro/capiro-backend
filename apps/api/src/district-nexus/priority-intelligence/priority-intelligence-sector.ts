/**
 * District Nexus Release 4 — deterministic sector signals (pure).
 *
 * Maps Capiro-owned authoritative data (CBP by NAICS, LODES, ACS, client
 * capability NAICS/PSC, client sectorTag, federal awards, Program Elements)
 * into sector-signal shapes. NO LLM classification anywhere: every mapping is
 * a static, centrally-versioned table in this file.
 *
 * Sector-wide jobs/establishments/payroll are PUBLIC DISTRICT CONTEXT. They
 * are never client jobs, client payroll, or client footprint — this module
 * has no pathway into Nexus Strength by construction.
 *
 * A new public source (EIA/BTS/HRSA/FEMA/IPEDS...) may NOT be added to satisfy
 * a label — only when its authoritative structured dataset, version, geography
 * and operating cadence are verified and mapped here deterministically.
 */

export type SectorSignalFamily =
  | 'manufacturing_industry'
  | 'workforce'
  | 'defense_federal_presence';

export type SectorSignalSource =
  | 'cbp'
  | 'lodes'
  | 'acs'
  | 'gsa'
  | 'federal_awards'
  | 'program_element';

export interface SectorMappingRule {
  /** NAICS 2-6 digit prefixes this rule matches (string prefix match). */
  naicsPrefixes: string[];
  family: SectorSignalFamily;
  label: string;
}

export interface SectorMetricInput {
  source: SectorSignalSource;
  dataset: string;
  sourceYear: number | null;
  boundaryCongress: number | null;
  naicsCode: string | null;
  metricKey: string;
  metricValue: number | null;
  unit: string | null;
  sourceRecordId: string | null;
  sourceUrl: string | null;
  observedAt: string | null;
  lastSyncedAt: string | null;
}

export interface SectorMetricProjection {
  family: SectorSignalFamily;
  label: string;
  source: SectorSignalSource;
  dataset: string;
  sourceYear: number | null;
  boundaryCongress: number | null;
  naicsCode: string | null;
  metricKey: string;
  metricValue: number | null;
  unit: string | null;
  sourceRecordId: string | null;
  sourceUrl: string | null;
  observedAt: string | null;
  lastSyncedAt: string | null;
}

/**
 * Centrally-defined deterministic sector mapping. NAICS prefix → signal family.
 * Versioned: bump SECTOR_MAPPING_VERSION when the table changes.
 */
export const SECTOR_MAPPING_VERSION = 'district-nexus-sector-mapping-v1';

export const SECTOR_MAPPING_RULES: readonly SectorMappingRule[] = Object.freeze([
  // Manufacturing / industry through CBP (NAICS 31-33 = manufacturing; 33 comes
  // through prefix '33'; also '31','32'). Defense-adjacent manufacturing:
  // 3364 (aerospace products/parts), 3391 (medical equipment), 3345 (instruments).
  {
    naicsPrefixes: ['31', '32', '33'],
    family: 'manufacturing_industry',
    label: 'Manufacturing (NAICS 31–33)',
  },
  // Workforce through LODES/ACS is mapped by dataset, not NAICS (below).
]);

/** LODES/ACS metric keys treated as workforce signals. */
export const WORKFORCE_METRIC_KEYS: ReadonlySet<string> = new Set([
  'jobs_total',
  'jobs_goods_producing',
  'jobs_manufacturing',
  'resident_workers_total',
  'median_commute_minutes',
  'population',
  'civilian_labor_force',
  'employment_rate',
]);

/** Federal awards / PE metric keys treated as defense/federal-presence signals. */
export const FEDERAL_PRESENCE_METRIC_KEYS: ReadonlySet<string> = new Set([
  'contract_obligations_total',
  'assistance_obligations_total',
  'pe_amount_total',
  'gsa_asset_count',
  'gsa_square_feet_total',
]);

function naicsFamily(
  naicsCode: string | null,
): { family: SectorSignalFamily; label: string } | null {
  if (!naicsCode) return null;
  for (const rule of SECTOR_MAPPING_RULES) {
    if (rule.naicsPrefixes.some((p) => naicsCode.startsWith(p))) {
      return { family: rule.family, label: rule.label };
    }
  }
  return null;
}

/**
 * Project one district_economic_fact-style metric row into a sector signal.
 * Rows that do not map deterministically are skipped (returns null) — they are
 * never force-labeled.
 */
export function projectSectorMetric(metric: SectorMetricInput): SectorMetricProjection | null {
  // NAICS-tagged metrics → manufacturing/industry (CBP primary path).
  const byNaics = naicsFamily(metric.naicsCode);
  if (byNaics && metric.source === 'cbp') {
    return { family: byNaics.family, label: byNaics.label, ...metric };
  }
  if (metric.source === 'cbp' && metric.naicsCode == null) {
    // Unmapped NAICS from CBP stays unmapped (not forced into a family).
    return null;
  }

  if (metric.source === 'lodes' && WORKFORCE_METRIC_KEYS.has(metric.metricKey)) {
    return { family: 'workforce', label: 'Workforce (LODES)', ...metric };
  }
  if (metric.source === 'acs' && WORKFORCE_METRIC_KEYS.has(metric.metricKey)) {
    return { family: 'workforce', label: 'Workforce (ACS)', ...metric };
  }
  if (metric.source === 'gsa' && FEDERAL_PRESENCE_METRIC_KEYS.has(metric.metricKey)) {
    return { family: 'defense_federal_presence', label: 'Federal presence (GSA FRPP)', ...metric };
  }
  if (
    (metric.source === 'federal_awards' || metric.source === 'program_element') &&
    FEDERAL_PRESENCE_METRIC_KEYS.has(metric.metricKey)
  ) {
    return {
      family: 'defense_federal_presence',
      label: 'Federal presence (awards / PE)',
      ...metric,
    };
  }
  return null;
}

export interface SectorSignalAvailability {
  status: 'loaded' | 'not_loaded' | 'stale';
  /**
   * 'not_loaded' is DISTINCT from 'loaded with zero rows': it means no source
   * run has ever populated the underlying facts for this district.
   */
  sources: Array<{
    source: SectorSignalSource;
    dataset: string;
    sourceYear: number | null;
    lastSyncedAt: string | null;
    lastRunStatus:
      | 'success'
      | 'success_with_errors'
      | 'failed'
      | 'unavailable'
      | 'running'
      | 'no_run'
      | null;
  }>;
}

export function isStale(
  sourceYear: number | null,
  lastSyncedAt: string | null,
  now: Date,
): boolean {
  // Annual datasets: staleness has two independent honest signals.
  //  1) The sync itself is old: a successful sync older than 400 days (annual
  //     cadence + slack) means nobody has refreshed the rail — stale.
  //  2) The newest source year is old AND a newer publication window has
  //     likely passed: census-style year N data is current through roughly
  //     year N + 3 (e.g. CBP FY2023 — the newest published year at audit
  //     time — synced 2026-08 is the CURRENT available year, not stale).
  //     Year N is visibly stale only once N + 3 < currentYear.
  if (lastSyncedAt == null) return true;
  const synced = new Date(lastSyncedAt);
  if (Number.isNaN(synced.getTime())) return true;
  const ageDays = (now.getTime() - synced.getTime()) / 86_400_000;
  if (ageDays > 400) return true;
  if (sourceYear != null) {
    const currentYear = now.getUTCFullYear();
    return currentYear - sourceYear >= 4;
  }
  return false;
}

export { SECTOR_MAPPING_RULES as SECTOR_NAICS_RULES };
