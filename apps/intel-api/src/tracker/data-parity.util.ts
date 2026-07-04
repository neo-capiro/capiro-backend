/**
 * Pure legacy↔unified DATA parity comparison (Phase 8 cutover gate).
 *
 * `parity-report` (parity.util.ts) diffs ALERT DECISIONS (intelligence_change
 * vs intel_alert). This module diffs the three MIGRATED DATA STORES so the
 * cutover can prove "every customer's existing config carried over":
 *
 *   client_watchlist   ↔ intel_watchlist(+topics/terms)   — content-hash equality
 *   tracked_bill       ↔ intel_tracked_bill               — identity + user fields
 *   alert_preference   ↔ intel_alert_preference           — full field equality
 *
 * Pure + DB-free (parallels parity.util.ts); orchestration lives in
 * data-parity.service.ts.
 *
 * Gate semantics (what PASSES):
 *  - legacyOnly = 0 everywhere (nothing legacy failed to reach intel), and
 *  - mismatched/fieldMismatch = 0 (nothing arrived altered).
 *  - intelOnly rows do NOT fail the gate: the internal tenant writes v2
 *    natively during shadow, and post-backfill legacy deletes leave stale
 *    intel rows — those are surfaced for `reconcile-intel-tracker` instead.
 *  - tracked-bill watermark fields (lastSeenActionText/Date, lastSeenAt) are reported
 *    as `watermarkDrift` info but NEVER gate: the legacy and intel detectors
 *    advance their watermarks independently on different cadences, so drift
 *    between backfill and compare is expected, not data loss.
 */

export interface DiffSummary {
  legacy: number;
  intel: number;
  matched: number;
  legacyOnly: string[];
  intelOnly: string[];
  mismatched: string[];
}

export interface TrackedBillDiff extends DiffSummary {
  /** Non-gating: keys whose lastSeenActionText/Date or lastSeenAt differ across systems. */
  watermarkDrift: string[];
}

/** Cap list output so one log line stays well under the CloudWatch event limit. */
export const LIST_CAP = 50;

function capped(list: string[]): string[] {
  return list.length > LIST_CAP ? list.slice(0, LIST_CAP) : list;
}

function normStr(v: string | null | undefined): string {
  return v == null ? '' : v;
}

function normDate(v: Date | string | null | undefined): string {
  if (v == null) return '';
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

/** Legacy `tracked_bill` row as read by $queryRawUnsafe (snake_case). */
export interface LegacyTrackedBillRow {
  client_id: string;
  tenant_id: string;
  bill_id: string;
  note: string | null;
  source: string | null;
  created_by: string | null;
  last_seen_action_text: string | null;
  last_seen_action_date: Date | null;
  last_seen_at: Date | null;
}

/** intel_tracked_bill projection needed for the compare. */
export interface IntelTrackedBillRow {
  clientId: string;
  tenantId: string;
  billId: string;
  note: string | null;
  isManual: boolean;
  trackedBy: string | null;
  lastSeenActionText: string | null;
  lastSeenActionDate: Date | null;
  lastSeenAt: Date | null;
}

export function trackedBillKey(clientId: string, billId: string): string {
  return `${clientId}:${billId}`;
}

/**
 * Diff tracked bills. Gating fields mirror EXACTLY what backfillTrackedBills
 * writes from user-authored legacy state: note, isManual (source ===
 * 'manual_search'), trackedBy. Watermarks compare into `watermarkDrift` only.
 */
export function compareTrackedBills(
  legacy: LegacyTrackedBillRow[],
  intel: IntelTrackedBillRow[],
): TrackedBillDiff {
  const intelByKey = new Map(intel.map((r) => [trackedBillKey(r.clientId, r.billId), r]));
  const legacyKeys = new Set<string>();
  const legacyOnly: string[] = [];
  const mismatched: string[] = [];
  const watermarkDrift: string[] = [];
  let matched = 0;

  for (const l of legacy) {
    const key = trackedBillKey(l.client_id, l.bill_id);
    legacyKeys.add(key);
    const i = intelByKey.get(key);
    if (!i) {
      legacyOnly.push(key);
      continue;
    }
    const fieldsEqual =
      normStr(l.note) === normStr(i.note) &&
      (l.source === 'manual_search') === i.isManual &&
      normStr(l.created_by) === normStr(i.trackedBy);
    if (!fieldsEqual) {
      mismatched.push(key);
      continue;
    }
    matched += 1;
    const watermarksEqual =
      normStr(l.last_seen_action_text) === normStr(i.lastSeenActionText) &&
      normDate(l.last_seen_action_date) === normDate(i.lastSeenActionDate) &&
      normDate(l.last_seen_at) === normDate(i.lastSeenAt);
    if (!watermarksEqual) watermarkDrift.push(key);
  }

  const intelOnly = [...intelByKey.keys()].filter((k) => !legacyKeys.has(k));
  return {
    legacy: legacy.length,
    intel: intel.length,
    matched,
    legacyOnly: capped(legacyOnly),
    intelOnly: capped(intelOnly),
    mismatched: capped(mismatched),
    watermarkDrift: capped(watermarkDrift),
  };
}

/** Legacy `alert_preference` row as read by $queryRawUnsafe (snake_case). */
export interface LegacyAlertPrefRow {
  client_id: string;
  tenant_id: string;
  user_id: string;
  triggers: string[] | null;
  materiality: string;
  email_enabled: boolean;
  email_address: string | null;
  email_cadence: string;
  sms_enabled: boolean;
  sms_phone: string | null;
  sms_phone_verified: boolean;
  sms_cadence: string;
  quiet_hours_start: string | null;
  quiet_hours_end: string | null;
}

/** intel_alert_preference projection needed for the compare. */
export interface IntelAlertPrefRow {
  clientId: string;
  tenantId: string;
  userId: string;
  triggers: string[];
  materiality: string;
  emailEnabled: boolean;
  emailAddress: string | null;
  emailCadence: string;
  smsEnabled: boolean;
  smsPhone: string | null;
  smsPhoneVerified: boolean;
  smsCadence: string;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
}

export function alertPrefKey(userId: string, clientId: string): string {
  return `${userId}:${clientId}`;
}

function triggersEqual(a: string[] | null | undefined, b: string[] | null | undefined): boolean {
  const sa = [...(a ?? [])].sort().join('|');
  const sb = [...(b ?? [])].sort().join('|');
  return sa === sb;
}

/** Diff alert prefs across every field backfillAlertPrefs maps (all user-set). */
export function compareAlertPrefs(
  legacy: LegacyAlertPrefRow[],
  intel: IntelAlertPrefRow[],
): DiffSummary {
  const intelByKey = new Map(intel.map((r) => [alertPrefKey(r.userId, r.clientId), r]));
  const legacyKeys = new Set<string>();
  const legacyOnly: string[] = [];
  const mismatched: string[] = [];
  let matched = 0;

  for (const l of legacy) {
    const key = alertPrefKey(l.user_id, l.client_id);
    legacyKeys.add(key);
    const i = intelByKey.get(key);
    if (!i) {
      legacyOnly.push(key);
      continue;
    }
    const equal =
      triggersEqual(l.triggers, i.triggers) &&
      l.materiality === i.materiality &&
      l.email_enabled === i.emailEnabled &&
      normStr(l.email_address) === normStr(i.emailAddress) &&
      l.email_cadence === i.emailCadence &&
      l.sms_enabled === i.smsEnabled &&
      normStr(l.sms_phone) === normStr(i.smsPhone) &&
      l.sms_phone_verified === i.smsPhoneVerified &&
      l.sms_cadence === i.smsCadence &&
      normStr(l.quiet_hours_start) === normStr(i.quietHoursStart) &&
      normStr(l.quiet_hours_end) === normStr(i.quietHoursEnd);
    if (equal) matched += 1;
    else mismatched.push(key);
  }

  const intelOnly = [...intelByKey.keys()].filter((k) => !legacyKeys.has(k));
  return {
    legacy: legacy.length,
    intel: intel.length,
    matched,
    legacyOnly: capped(legacyOnly),
    intelOnly: capped(intelOnly),
    mismatched: capped(mismatched),
  };
}

/**
 * Diff watchlists given precomputed content hashes per clientId. Hashes come
 * from the SAME machinery the sync uses (expandLegacyWatchlist +
 * watchlistContentHash on both sides), so hash equality ⇔ the sync itself
 * would skip-as-unchanged — the strongest available "carried over verbatim"
 * signal. Only unified rows with id `wl:<clientId>` participate (hearing-only
 * watchlists are out of scope).
 */
export function compareWatchlistHashes(
  legacyByClient: Map<string, string>,
  intelByClient: Map<string, string>,
): DiffSummary {
  const legacyOnly: string[] = [];
  const mismatched: string[] = [];
  let matched = 0;
  for (const [clientId, lHash] of legacyByClient) {
    const iHash = intelByClient.get(clientId);
    if (iHash === undefined) legacyOnly.push(clientId);
    else if (iHash === lHash) matched += 1;
    else mismatched.push(clientId);
  }
  const intelOnly = [...intelByClient.keys()].filter((c) => !legacyByClient.has(c));
  return {
    legacy: legacyByClient.size,
    intel: intelByClient.size,
    matched,
    legacyOnly: capped(legacyOnly),
    intelOnly: capped(intelOnly),
    mismatched: capped(mismatched),
  };
}

export interface DataParityReport {
  tenantScope: string;
  watchlists: DiffSummary;
  trackedBills: TrackedBillDiff;
  alertPrefs: DiffSummary;
  passed: boolean;
  reason: string | null;
  /** Non-gating observations (e.g. legacy rows untranslatable to clerk ids). */
  notes?: string[];
}

/** Apply the gate semantics documented in the header. */
export function evaluateDataParity(
  tenantScope: string,
  watchlists: DiffSummary,
  trackedBills: TrackedBillDiff,
  alertPrefs: DiffSummary,
): DataParityReport {
  const failures: string[] = [];
  if (watchlists.legacyOnly.length) failures.push(`watchlists.legacyOnly=${watchlists.legacyOnly.length}`);
  if (watchlists.mismatched.length) failures.push(`watchlists.mismatched=${watchlists.mismatched.length}`);
  if (trackedBills.legacyOnly.length) failures.push(`trackedBills.legacyOnly=${trackedBills.legacyOnly.length}`);
  if (trackedBills.mismatched.length) failures.push(`trackedBills.mismatched=${trackedBills.mismatched.length}`);
  if (alertPrefs.legacyOnly.length) failures.push(`alertPrefs.legacyOnly=${alertPrefs.legacyOnly.length}`);
  if (alertPrefs.mismatched.length) failures.push(`alertPrefs.mismatched=${alertPrefs.mismatched.length}`);
  return {
    tenantScope,
    watchlists,
    trackedBills,
    alertPrefs,
    passed: failures.length === 0,
    reason: failures.length ? failures.join(' ') : null,
  };
}
