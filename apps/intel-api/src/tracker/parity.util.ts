/**
 * Phase 5 parity metrics (§8.3–8.5) — pure, deterministic, side-effect-free.
 *
 * Compares two decision sets at the ALERT-DECISION grain:
 *  - L (legacy ground truth): what the apps/api tracker DECIDED to fire, read
 *    from durable `intelligence_change` rows (source='congress_bill',
 *    data.tracker=true) — subscription-INDEPENDENT (§8 note: notification_log is
 *    delivery, gated by alert_preference, and would under-count decisions).
 *  - I (intel shadow): what intel-api's shadow pipeline wrote to `intel_alert`.
 *
 * Join key = clientId:billId:changeType. clientId is a globally-unique uuid, so
 * the tenant prefix the plan suggested is unnecessary for correctness (tenant is
 * still recorded on the audit row for scoping).
 */

/** changeTypes whose severity is 'critical' (from classifyChange, §6). */
export const CRITICAL_CHANGE_TYPES = ['bill_enacted', 'bill_to_president', 'bill_failed'] as const;

/** The full classifyChange changeType set (§6) — the legacy SQL filter uses this. */
export const KNOWN_CHANGE_TYPES = [
  'bill_enacted',
  'bill_to_president',
  'bill_failed',
  'bill_passed_chamber',
  'bill_rule_reported',
  'bill_floor_scheduled',
  'bill_reported',
  'bill_markup',
  'bill_hearing',
  'bill_amendment',
] as const;

export interface ParityDecision {
  clientId: string;
  billId: string;
  changeType: string;
  severity: string;
}

export function parityKey(d: { clientId: string; billId: string; changeType: string }): string {
  return `${d.clientId}:${d.billId}:${d.changeType}`;
}
const pairKey = (d: { clientId: string; billId: string }): string => `${d.clientId}:${d.billId}`;

export type TriageBucket = 'legacy_only' | 'intel_only' | 'classifier';
export interface TriageEntry {
  key: string;
  bucket: TriageBucket;
  clientId: string;
  billId: string;
  changeType: string;
  severity: string;
}

export interface ParityMetrics {
  legacyCount: number;
  intelCount: number;
  intersection: number;
  unionCount: number;
  overlap: number; //   Jaccard |∩|/|∪|
  recall: number; //    |∩|/|L| (1.0 when |L|=0)
  precision: number; // |∩|/|I| (1.0 when |I|=0)
  missedCriticals: ParityDecision[];
  severityCriticalMismatches: Array<{ key: string; legacy: string; intel: string }>;
  triage: TriageEntry[];
  reason: string | null; // 'NO_DATA' when both sides empty
}

/** Dedupe a decision list to one entry per parityKey (first wins). */
function indexByKey(rows: ParityDecision[]): Map<string, ParityDecision> {
  const m = new Map<string, ParityDecision>();
  for (const r of rows) {
    const k = parityKey(r);
    if (!m.has(k)) m.set(k, r);
  }
  return m;
}

export function computeParity(legacy: ParityDecision[], intel: ParityDecision[]): ParityMetrics {
  const L = indexByKey(legacy);
  const I = indexByKey(intel);
  const legacyPairs = new Set(Array.from(L.values()).map(pairKey));
  const intelPairs = new Set(Array.from(I.values()).map(pairKey));

  const intersectionKeys: string[] = [];
  for (const k of L.keys()) if (I.has(k)) intersectionKeys.push(k);
  const unionCount = new Set([...L.keys(), ...I.keys()]).size;
  const intersection = intersectionKeys.length;

  const overlap = unionCount === 0 ? 1 : intersection / unionCount;
  const recall = L.size === 0 ? 1 : intersection / L.size;
  const precision = I.size === 0 ? 1 : intersection / I.size;

  const missedCriticals: ParityDecision[] = [];
  for (const [k, d] of L) {
    if (
      (CRITICAL_CHANGE_TYPES as readonly string[]).includes(d.changeType) ||
      d.severity === 'critical'
    ) {
      if (!I.has(k)) missedCriticals.push(d);
    }
  }

  const severityCriticalMismatches: Array<{ key: string; legacy: string; intel: string }> = [];
  for (const k of intersectionKeys) {
    const l = L.get(k)!;
    const i = I.get(k)!;
    if (l.severity !== i.severity && (l.severity === 'critical' || i.severity === 'critical')) {
      severityCriticalMismatches.push({ key: k, legacy: l.severity, intel: i.severity });
    }
  }

  const triage: TriageEntry[] = [];
  for (const [k, d] of L) {
    if (I.has(k)) continue;
    // Same (client,bill) present on the intel side with a DIFFERENT changeType ⇒ classifier drift.
    const bucket: TriageBucket = intelPairs.has(pairKey(d)) ? 'classifier' : 'legacy_only';
    triage.push({ key: k, bucket, clientId: d.clientId, billId: d.billId, changeType: d.changeType, severity: d.severity });
  }
  for (const [k, d] of I) {
    if (L.has(k)) continue;
    const bucket: TriageBucket = legacyPairs.has(pairKey(d)) ? 'classifier' : 'intel_only';
    triage.push({ key: k, bucket, clientId: d.clientId, billId: d.billId, changeType: d.changeType, severity: d.severity });
  }

  return {
    legacyCount: L.size,
    intelCount: I.size,
    intersection,
    unionCount,
    overlap,
    recall,
    precision,
    missedCriticals,
    severityCriticalMismatches,
    triage,
    reason: unionCount === 0 ? 'NO_DATA' : null,
  };
}

export interface ParityGate {
  passed: boolean;
  reason: string | null;
}

/**
 * Hard gate (§8.3/§8.5 thresholds). Score-delta (S4) is intentionally NOT part
 * of the gate here: legacy stores no comparable `fit`, so `maxScoreDelta` is null
 * unless a recompute pass is added — a null delta does not fail the gate.
 */
export function gateVerdict(
  m: ParityMetrics,
  opts: { overlapMin?: number; recallMin?: number; maxScoreDelta?: number | null } = {},
): ParityGate {
  const overlapMin = opts.overlapMin ?? 0.95;
  const recallMin = opts.recallMin ?? 0.95;
  if (m.reason === 'NO_DATA') return { passed: false, reason: 'NO_DATA' };
  if (m.missedCriticals.length > 0) return { passed: false, reason: `GATE_RED:missed_criticals=${m.missedCriticals.length}` };
  if (m.severityCriticalMismatches.length > 0)
    return { passed: false, reason: `GATE_RED:severity_critical_mismatches=${m.severityCriticalMismatches.length}` };
  if (m.overlap < overlapMin) return { passed: false, reason: `GATE_RED:overlap=${m.overlap.toFixed(3)}` };
  if (m.recall < recallMin) return { passed: false, reason: `GATE_RED:recall=${m.recall.toFixed(3)}` };
  if (opts.maxScoreDelta != null && opts.maxScoreDelta > 0.1)
    return { passed: false, reason: `GATE_RED:max_score_delta=${opts.maxScoreDelta.toFixed(3)}` };
  return { passed: true, reason: null };
}
