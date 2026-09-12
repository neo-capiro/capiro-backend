/**
 * Evidence freshness thresholds (§6.6), extracted from the former
 * government-affairs-policy.registry.ts when per-audience policy was removed.
 *
 * Staleness checking is audience-agnostic: a bill's status ages the same way
 * whether the message goes to a congressional office or a client executive.
 * One flat table replaces what used to be a per-policy freshness map.
 */

/** Max age in days before a source of this type needs an explicit as-of caveat. */
const FRESHNESS_THRESHOLDS: Record<string, number> = {
  // A bill's canonical status is the fastest-moving fact we quote.
  bill: 14,
  stateBill: 21,
  // Budget marks move on the appropriations calendar, not daily.
  programElement: 45,
  // Rosters/assignments change at the margins between congresses.
  directory: 120,
  press: 30,
  email: 180,
  document: 365,
  prep: 90,
  debrief: 90,
  note: 365,
  // Durable relationship facts.
  client: 365,
  // LDA (Lobbying Disclosure Act) LD-2 filings are quarterly by statute — a
  // filing IS the accurate "latest known status" for the entire quarter it
  // covers, not a fact that goes stale within days. 90 days ≈ one quarter,
  // matching the filing cadence rather than the harsh 14-day bill bucket.
  // Keyed camelCase (not `lda_filing`) so it matches the normalized V3
  // sourceType key produced by normalizeFreshnessEvidenceType, same as
  // programElement/stateBill above.
  ldaFiling: 90,
  // Congressional hearing status (scheduled/held/postponed) moves on the
  // same congress.gov cadence as bill status — same bucket as `bill`.
  hearing: 14,
  // A federal award (usaspending.gov) can pick up a follow-on mod within a
  // news-cycle timeframe; treat it like `press`, not the harsher bill window.
  award: 30,
};

/**
 * V3 evidence carries sourceTypes like `outreach_v3:government_record:program_element`
 * (see `outreach-v3-generation-context.ts` `sourceTypeFor()`), but `FRESHNESS_THRESHOLDS`
 * is keyed by bare camelCase evidence types (`programElement`, `bill`, `stateBill`, ...)
 * predating V3. This strips the V3 prefix/infix and converts snake_case to the
 * camelCase key so an already-configured type resolves correctly. Categories that
 * were never configured (sec_filing, fara_registration, gao_report, crs_report,
 * regulatory_docket, intel_article, federal_register) fall through to the
 * conservative global minimum — deliberate for a genuinely un-decided type.
 */
function normalizeFreshnessEvidenceType(evidenceType: string): string {
  const govRecordMatch = /^outreach_v3:government_record:(.+)$/.exec(evidenceType);
  const raw = govRecordMatch?.[1] ?? evidenceType.replace(/^outreach_v3:/, '');
  return raw.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
}

/**
 * Days after which a source of `evidenceType` needs an explicit as-of caveat.
 * Falls back to the most conservative configured threshold rather than "no
 * limit" for an unknown type.
 */
export function freshnessThresholdDays(evidenceType: string): number {
  const explicit =
    FRESHNESS_THRESHOLDS[evidenceType] ??
    FRESHNESS_THRESHOLDS[normalizeFreshnessEvidenceType(evidenceType)];
  if (typeof explicit === 'number') return explicit;
  const all = Object.values(FRESHNESS_THRESHOLDS);
  return all.length ? Math.min(...all) : 14;
}
