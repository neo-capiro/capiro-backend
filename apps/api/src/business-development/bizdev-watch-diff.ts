/**
 * Business Development Phase 5 — deterministic PURE-DOMAIN watch diff.
 *
 * Compares one normalized BizDevSourceObservation against the per-watch,
 * per-source baseline and classifies the outcome. This module:
 *
 *   * imports only `crypto` (stdlib hashing) — no Prisma, no HTTP client, no
 *     provider package. It operates on the pure types in
 *     bizdev-watch.types.ts, so it is trivially testable and reusable by any
 *     runner;
 *   * normalizes MEANING: material values are canonicalized (recursively
 *     sorted key order, exact scalar semantics) while retrieval noise
 *     (fetchedAt / lastSyncedAt / providerFetchedAt / raw payload / raw key
 *     order) is dropped before comparison and can never produce an alert;
 *   * separates the CONTENT fingerprint (baseline equality over allowlisted
 *     material) from the SEMANTIC CHANGE fingerprint (prior content + new
 *     content + change kind + source revision): a legitimate A→B→A→B
 *     recurrence alerts each time, unchanged content with new retrieval
 *     stamps never does;
 *   * requires an exact usable source locator URL — descriptive text is
 *     never accepted;
 *   * checks identity ambiguity BEFORE any baseline acceptance: an
 *     ambiguous observation returns review/skip and never becomes a trusted
 *     baseline fact;
 *   * classifies new_record vs material_update vs correction vs backfill;
 *   * treats an `initialized` baseline with ZERO records as ESTABLISHED (the
 *     next new record alerts) and only an uninitialized/absent baseline as
 *     "quiet first pass".
 */

import * as crypto from 'crypto';

import {
  BIZDEV_ALERT_CATEGORY_BY_FAMILY,
  BIZDEV_IDENTITY_CONFIDENCE_REVIEW_THRESHOLD,
  BIZDEV_WATCH_HARMLESS_FIELD_ALLOWLIST,
  BIZDEV_WATCH_MATERIAL_FIELD_ALLOWLIST,
  bizdevSourceLocator,
  type BizDevAlertDraft,
  type BizDevJsonValue,
  type BizDevMaterialFieldChange,
  type BizDevSourceObservation,
  type BizDevWatchBaseline,
  type BizDevWatchBaselineRecord,
  type BizDevWatchDiffResult,
} from './bizdev-watch.types';

// ── Canonicalization ──────────────────────────────────────────────────────

/** Canonical scalar form: `undefined` collapses to null (never a change). */
function canonicalScalar(value: BizDevJsonValue): string {
  return JSON.stringify(value === undefined ? null : value);
}

/** Recursively sorted-key JSON: raw key order can never look like a change. */
export function canonicalizeJson(value: BizDevJsonValue): string {
  if (value === null || typeof value !== 'object') {
    return canonicalScalar(value as BizDevJsonValue);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalizeJson).join(',')}]`;
  }
  const record = value as Record<string, BizDevJsonValue>;
  const parts: string[] = [];
  for (const key of Object.keys(record).sort()) {
    const v = record[key];
    if (v === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${canonicalizeJson(v)}`);
  }
  return `{${parts.join(',')}}`;
}

/**
 * Drop retrieval-noise fields from a material map. The allowlist families in
 * bizdev-watch.types.ts already exclude them; this is a second defensive
 * layer so a sloppy adapter leaking fetchedAt / lastSyncedAt / raw can still
 * never produce an alert.
 */
export function stripHarmlessFields(
  material: Record<string, BizDevJsonValue>,
): Record<string, BizDevJsonValue> {
  const out: Record<string, BizDevJsonValue> = {};
  for (const key of Object.keys(material)) {
    if (BIZDEV_WATCH_HARMLESS_FIELD_ALLOWLIST.has(key)) continue;
    const value = material[key];
    if (value === undefined) continue;
    out[key] = value;
  }
  return out;
}

/**
 * True when the ONLY difference between two material maps is retrieval noise:
 * harmless fields (fetchedAt / lastSyncedAt / providerFetchedAt / raw) or
 * key order. Non-allowlisted unknown keys DO count as differences: adapters
 * are on notice that unreviewed fields must not leak into material.
 */
export function onlyHarmlessNoise(
  before: Record<string, BizDevJsonValue>,
  after: Record<string, BizDevJsonValue>,
): boolean {
  return (
    canonicalizeJson(stripHarmlessFields(before)) ===
    canonicalizeJson(stripHarmlessFields(after))
  );
}

/** Project an observation's material map down to the family allowlist. */
export function allowlistedMaterial(
  observation: BizDevSourceObservation,
): Record<string, BizDevJsonValue> {
  const allow = new Set(
    BIZDEV_WATCH_MATERIAL_FIELD_ALLOWLIST[observation.sourceFamily],
  );
  const out: Record<string, BizDevJsonValue> = {};
  for (const key of Object.keys(observation.material)) {
    if (!allow.has(key)) continue;
    const value = observation.material[key];
    if (value === undefined) continue;
    out[key] = value;
  }
  return out;
}

/** Stable lower-case hex SHA-256 over a canonicalized string. */
export function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * CONTENT fingerprint of one observation: SHA-256 over family, recordId, and
 * the canonicalized allowlisted material. Baseline equality compares THIS
 * only — retrieval timestamps, raw key order, and non-allowlisted fields are
 * invisible to it.
 */
export function observationFingerprint(
  observation: BizDevSourceObservation,
): string {
  return sha256Hex(
    `${observation.sourceFamily}\n${observation.recordId}\n${canonicalizeJson(
      allowlistedMaterial(observation),
    )}`,
  );
}

/**
 * SEMANTIC CHANGE fingerprint: prior content fingerprint + new content
 * fingerprint + change kind + source revision + the NEXT monotonic semantic
 * sequence for the record. The sequence is the dedupe collision killer:
 * hash(prior, new, kind, revision) alone would repeat for a later A→B after
 * a B→A (same content pair, same null revision), silently suppressing a
 * legitimate recurrence. The sequence increments exactly once per accepted
 * content change and is persisted atomically with the alert + baseline, so
 * replay-before-commit computes the same key while any FUTURE transition
 * gets a strictly larger sequence and a fresh key.
 */
export function semanticChangeFingerprint(
  sourceFamily: string,
  recordId: string,
  priorContentFingerprint: string | null,
  newContentFingerprint: string,
  changeKind: string,
  sourceRevision: string | null,
  nextSemanticSequence: number,
): string {
  return sha256Hex(
    `${sourceFamily}\n${recordId}\n${priorContentFingerprint ?? 'none'}\n${newContentFingerprint}\n${changeKind}\n${sourceRevision ?? 'none'}\n${nextSemanticSequence}`,
  );
}

/** Tenant-delivery dedupe key: family + record + semantic fingerprint. */
export function alertDedupeKey(
  sourceFamily: string,
  recordId: string,
  fingerprint: string,
): string {
  return `${sourceFamily}:${recordId}:${fingerprint}`;
}

// ── Classification helpers ────────────────────────────────────────────────

/** Effective floor used to distinguish backfill from new_record. */
function baselineFloor(baseline: BizDevWatchBaseline): string {
  return baseline.effectiveFloorAt ?? baseline.establishedAt;
}

/** Parse an ISO date defensively; null when absent/unparseable. */
function parseIso(value: string | null | undefined): number | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

/**
 * new_record: the record was not in the baseline AND its effective date is
 * on/after the baseline floor (a genuinely current event). A missing
 * effective date is conservatively treated as current (new_record), because
 * the alternative (silently classifying an undated record as backfill)
 * would hide it.
 */
function isNewRecord(
  observation: BizDevSourceObservation,
  baseline: BizDevWatchBaseline,
): boolean {
  const floor = parseIso(baselineFloor(baseline));
  const effective = parseIso(observation.effectiveAt ?? observation.eventAt);
  if (floor === null || effective === null) return true;
  return effective >= floor;
}

/**
 * correction vs material_update for an existing record: a correction REWRITES
 * already-published history (an earlier effective or published date than
 * the baseline row carried, i.e. the source moved facts backwards); an
 * update moves the record forward.
 */
function isCorrection(
  observation: BizDevSourceObservation,
  baselineRecord: BizDevWatchBaselineRecord,
): boolean {
  const basePublished = parseIso(baselineRecord.publishedAt);
  const nowPublished = parseIso(observation.publishedAt);
  if (basePublished !== null && nowPublished !== null && nowPublished < basePublished) {
    return true;
  }
  const baseEffective = parseIso(baselineRecord.effectiveAt);
  const nowEffective = parseIso(observation.effectiveAt ?? observation.eventAt);
  if (baseEffective !== null && nowEffective !== null && nowEffective < baseEffective) {
    return true;
  }
  return false;
}

function fieldChanges(
  before: Record<string, BizDevJsonValue>,
  after: Record<string, BizDevJsonValue>,
): BizDevMaterialFieldChange[] {
  const keys = Array.from(
    new Set([...Object.keys(before), ...Object.keys(after)]),
  ).sort();
  const changes: BizDevMaterialFieldChange[] = [];
  for (const key of keys) {
    const b = canonicalizeJson(before[key] ?? null);
    const a = canonicalizeJson(after[key] ?? null);
    if (b !== a) {
      changes.push({
        field: key,
        before: before[key] ?? null,
        after: after[key] ?? null,
      });
    }
  }
  return changes;
}

/** Deterministic materiality: exact amount/stage/date metadata drives it. */
function materialityOf(changes: BizDevMaterialFieldChange[]): 'high' | 'medium' | 'low' {
  const touched = new Set(changes.map((c) => c.field));
  if (
    touched.has('amount') ||
    touched.has('stage') ||
    touched.has('status') ||
    touched.has('noticeType') ||
    touched.has('responseDeadline') ||
    touched.has('effectiveAt') ||
    touched.has('deadlineAt')
  ) {
    return 'high';
  }
  if (
    touched.has('peCode') ||
    touched.has('setAside') ||
    touched.has('setAsideCode') ||
    touched.has('pscCode') ||
    touched.has('naicsCode') ||
    touched.has('programCode') ||
    touched.has('awardingAgency') ||
    touched.has('office') ||
    touched.has('fundingTas') ||
    touched.has('actionDate') ||
    touched.has('postedDate') ||
    touched.has('income') ||
    touched.has('expenses')
  ) {
    return 'medium';
  }
  return 'low';
}

function displayLabel(observation: BizDevSourceObservation): string {
  const label =
    observation.material['title'] ??
    observation.material['name'] ??
    observation.material['contractorName'] ??
    observation.material['recipientName'] ??
    observation.material['clientName'];
  return typeof label === 'string' && label.length > 0 ? label : observation.recordId;
}

function titleFor(
  sourceFamily: string,
  changeKind: string,
  observation: BizDevSourceObservation,
): string {
  const kind =
    changeKind === 'new_record'
      ? 'New'
      : changeKind === 'correction'
        ? 'Corrected'
        : changeKind === 'backfill'
          ? 'Backfilled'
          : 'Updated';
  return `${kind} ${sourceFamily.replace(/_/g, ' ')}: ${displayLabel(observation)}`;
}

function summaryFor(
  sourceFamily: string,
  changeKind: string,
  changes: BizDevMaterialFieldChange[],
  observation: BizDevSourceObservation,
): string {
  if (changes.length === 0) {
    return `Record ${observation.recordId} from ${sourceFamily} appeared (${changeKind}).`;
  }
  const head = changes
    .slice(0, 4)
    .map(
      (c) =>
        `${c.field}: ${JSON.stringify(c.before ?? null)} → ${JSON.stringify(c.after ?? null)}`,
    )
    .join('; ');
  const tail = changes.length > 4 ? ` (+${changes.length - 4} more)` : '';
  return `Record ${observation.recordId} (${changeKind}) changed: ${head}${tail}`;
}

/**
 * Deterministic inference gloss. IMPORTANT: consumers MUST label this text as
 * inference — it is the diff's interpretation of the change, never a source
 * fact.
 */
function implicationFor(
  sourceFamily: BizDevSourceObservation['sourceFamily'],
  changeKind: string,
  materiality: string,
  changes: BizDevMaterialFieldChange[],
): string {
  const touched = new Set(changes.map((c) => c.field));
  const parts: string[] = [];
  if (sourceFamily === 'sam_opportunity') {
    parts.push(
      changeKind === 'new_record'
        ? 'A SAM.gov opportunity appeared in an agency context seen in this prospect’s prior public-award history. This is thematic context only and does not indicate that the company will bid or win.'
        : 'A SAM.gov opportunity in an agency context seen in this prospect’s prior public-award history changed. This is thematic context only and does not indicate that the company will bid or win.',
    );
  } else if (sourceFamily === 'lda_filing') {
    parts.push(
      changeKind === 'new_record'
        ? 'A lobbying filing used an exact confirmed organization name. LDA records do not carry UEIs, so verify the name match before relying on it.'
        : 'A lobbying filing matched by exact confirmed organization name changed. LDA records do not carry UEIs, so verify the name match before relying on it.',
    );
  } else if (changeKind === 'new_record') {
    parts.push(
      'A new source record matching this watched prospect appeared; it may represent a new opportunity or relationship worth reviewing.',
    );
  } else if (changeKind === 'backfill') {
    parts.push(
      'An older record surfaced after the baseline was established; it likely reflects prior history rather than a new development.',
    );
  } else if (changeKind === 'correction') {
    parts.push(
      'The source corrected or revised previously published information; earlier conclusions drawn from it may need revisiting.',
    );
  } else {
    parts.push(
      'An existing record materially changed; the previous picture of this prospect may be out of date.',
    );
  }
  if (touched.has('amount')) {
    parts.push(
      'The change touches a dollar amount, which typically signals a material shift in contract value.',
    );
  }
  if (touched.has('stage') || touched.has('status')) {
    parts.push(
      'The stage or status moved, suggesting the underlying activity progressed or regressed.',
    );
  }
  parts.push(`Assessed materiality: ${materiality}.`);
  return parts.join(' ');
}

/**
 * Exact usable source locator URL. The observation's own sourceLocator wins;
 * otherwise the deterministic per-family URL is built. Empty result (Tango /
 * ledger without a provider URL) makes the observation unusable → skip.
 */
function buildSourceLocator(observation: BizDevSourceObservation): string {
  const own = observation.sourceLocator;
  if (typeof own === 'string' && /^https?:\/\//i.test(own)) return own;
  const materialUrl =
    observation.material['sourceUrl'] ?? observation.material['filingDocumentUrl'];
  const fallback =
    typeof materialUrl === 'string' && /^https?:\/\//i.test(materialUrl)
      ? materialUrl
      : null;
  return bizdevSourceLocator(observation.sourceFamily, observation.recordId, fallback);
}

/**
 * Reconstruct the BEFORE material map for an existing record. Baseline rows
 * MAY carry an allowlisted material snapshot (`material`); when present the
 * alert gets exact per-field before values. When absent we never invent
 * prior values: the before state reports null per field and the alert is
 * still honest (the change set is exact, the prior values are unknown).
 */
function reconstructBeforeMaterial(
  after: Record<string, BizDevJsonValue>,
  existing: BizDevWatchBaselineRecord,
): Record<string, BizDevJsonValue> {
  if (existing.material && typeof existing.material === 'object') {
    return existing.material;
  }
  const before: Record<string, BizDevJsonValue> = {};
  for (const key of Object.keys(after)) {
    before[key] = null;
  }
  return before;
}

function buildAlertDraft(
  observation: BizDevSourceObservation,
  changeKind: BizDevAlertDraft['changeKind'],
  changes: BizDevMaterialFieldChange[],
  beforeState: BizDevJsonValue,
  afterState: BizDevJsonValue,
  fingerprint: string,
): BizDevAlertDraft {
  const materiality = materialityOf(changes);
  return {
    sourceFamily: observation.sourceFamily,
    category: BIZDEV_ALERT_CATEGORY_BY_FAMILY[observation.sourceFamily],
    changeKind,
    materiality,
    recordId: observation.recordId,
    sourceRevision: observation.sourceRevision ?? null,
    fingerprint,
    dedupeKey: alertDedupeKey(observation.sourceFamily, observation.recordId, fingerprint),
    beforeState,
    afterState,
    changes,
    title: titleFor(observation.sourceFamily, changeKind, observation),
    summary: summaryFor(observation.sourceFamily, changeKind, changes, observation),
    implication: implicationFor(observation.sourceFamily, changeKind, materiality, changes),
    sourceLocator: buildSourceLocator(observation),
    eventAt: observation.eventAt ?? null,
    effectiveAt: observation.effectiveAt ?? null,
    publishedAt: observation.publishedAt ?? null,
  };
}

// ── The diff ───────────────────────────────────────────────────────────────

/**
 * Diff ONE observation against the per-watch/per-source baseline.
 *
 * Contract (see the focused spec for the exhaustive cases):
 *   * baseline uninitialized/absent  → 'baseline' with the record's baseline
 *     entry, NO alert (quiet initial baseline). An ESTABLISHED baseline with
 *     zero records is NOT this case: the next record alerts;
 *   * identity ambiguous (low identityConfidence) → 'review', checked
 *     BEFORE baseline acceptance — an ambiguous observation never becomes a
 *     trusted baseline fact and never alerts;
 *   * missing usable source locator → 'skip';
 *   * known record, content fingerprint identical → 'no_alert' (harmless
 *     retrieval noise included; a bare revision bump with identical content
 *     is also no_alert);
 *   * unknown record, baseline established → 'new_record' or 'backfill';
 *   * known record, content fingerprint changed → 'material_update' or
 *     'correction', carrying the SEMANTIC change fingerprint (prior content
 *     + new content + change kind + source revision) so A→B→A→B recurrence
 *     is never suppressed.
 */
export function diffObservationAgainstBaseline(
  observation: BizDevSourceObservation,
  baseline: BizDevWatchBaseline | null | undefined,
): BizDevWatchDiffResult {
  // Structural validation → skip (never a confident alert on bad input).
  if (!observation.recordId || typeof observation.recordId !== 'string') {
    return { outcome: 'skip', reason: 'missing recordId' };
  }
  if (
    !observation.material ||
    typeof observation.material !== 'object' ||
    Array.isArray(observation.material)
  ) {
    return { outcome: 'skip', reason: 'missing material map' };
  }

  // Identity ambiguity FIRST: an ambiguous observation must never become a
  // trusted baseline fact and never produce a confident alert.
  const confidence = observation.identityConfidence ?? 1;
  if (
    !Number.isFinite(confidence) ||
    confidence < BIZDEV_IDENTITY_CONFIDENCE_REVIEW_THRESHOLD ||
    confidence > 1
  ) {
    return {
      outcome: 'review',
      reason: 'identity confidence below review threshold',
    };
  }

  // A quiet baseline must not silently trust an untraceable record. Requiring
  // the exact public locator before baseline acceptance ensures a future
  // change can always be grounded in the underlying source.
  const locator = buildSourceLocator(observation);
  if (!locator) {
    return { outcome: 'skip', reason: 'no exact source locator URL' };
  }

  const material = allowlistedMaterial(observation);
  const contentFingerprint = observationFingerprint(observation);
  // The baselineUpdate carries the sequence this content was accepted AT.
  // For an unchanged/no-alert result that is the EXISTING sequence (replay
  // stability); for a changed/alert result the runner persists
  // priorSequence + 1 atomically with the alert, and the alert's semantic
  // fingerprint is computed over that SAME next value.
  const priorSequence =
    baseline?.records?.[observation.recordId]?.semanticSequence ?? 0;
  const baselineUpdate: BizDevWatchBaselineRecord = {
    recordId: observation.recordId,
    sourceRevision: observation.sourceRevision ?? null,
    semanticSequence: priorSequence,
    fingerprint: contentFingerprint,
    effectiveAt: observation.effectiveAt ?? observation.eventAt ?? null,
    publishedAt: observation.publishedAt ?? null,
    material,
  };

  // Quiet baseline pass: with NO established baseline (null/undefined object
  // or initialized=false), record the observation and alert on nothing. An
  // ESTABLISHED baseline with ZERO records is deliberately NOT this case.
  const established = baseline !== null && baseline !== undefined && baseline.initialized;
  if (!established) {
    return { outcome: 'baseline', baselineUpdate };
  }

  const baselineRecord = baseline!.records[observation.recordId];

  // Known record: no change unless the CONTENT fingerprint moved. It already
  // canonicalizes key order and only sees allowlisted material, so
  // fetchedAt / lastSyncedAt / raw noise can never reach this comparison.
  // A bare revision bump with identical content is also no_alert.
  if (baselineRecord) {
    if (baselineRecord.fingerprint === contentFingerprint) {
      return { outcome: 'no_alert', baselineUpdate };
    }
    const changeKind = isCorrection(observation, baselineRecord)
      ? 'correction'
      : 'material_update';
    const beforeMaterial = reconstructBeforeMaterial(material, baselineRecord);
    const changes = fieldChanges(beforeMaterial, material);
    const nextSequence = priorSequence + 1;
    const semanticFingerprint = semanticChangeFingerprint(
      observation.sourceFamily,
      observation.recordId,
      baselineRecord.fingerprint,
      contentFingerprint,
      changeKind,
      observation.sourceRevision ?? null,
      nextSequence,
    );
    // The persisted baseline row must carry the advanced sequence so the
    // NEXT transition hashes a strictly larger value.
    baselineUpdate.semanticSequence = nextSequence;
    return {
      outcome: 'alert',
      baselineUpdate,
      alertDraft: buildAlertDraft(
        observation,
        changeKind,
        changes,
        beforeMaterial,
        material,
        semanticFingerprint,
      ),
    };
  }

  // Unknown record → new_record or backfill, decided by the effective-date
  // floor. before state is honestly null (the record did not exist here).
  const changeKind = isNewRecord(observation, baseline!)
    ? 'new_record'
    : 'backfill';
  const changes = fieldChanges({}, material);
  const nextSequence = priorSequence + 1;
  const semanticFingerprint = semanticChangeFingerprint(
    observation.sourceFamily,
    observation.recordId,
    null,
    contentFingerprint,
    changeKind,
    observation.sourceRevision ?? null,
    nextSequence,
  );
  baselineUpdate.semanticSequence = nextSequence;
  return {
    outcome: 'alert',
    baselineUpdate,
    alertDraft: buildAlertDraft(
      observation,
      changeKind,
      changes,
      null,
      material,
      semanticFingerprint,
    ),
  };
}
