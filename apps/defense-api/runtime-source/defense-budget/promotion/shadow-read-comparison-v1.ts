/**
 * Phase 7 Workstream M — comparing a legacy response against a snapshot one.
 *
 * Shadow mode serves the legacy response and computes the snapshot response
 * beside it, so the difference between the two is measured on real traffic
 * before any client is exposed to the new one. Plan §M.10 makes that measurement
 * a gate: zero unexplained P0/P1 mismatch before the canary.
 *
 * ---------------------------------------------------------------------------
 * The output carries no data, by construction
 * ---------------------------------------------------------------------------
 *
 * Plan §M.8: "log/metric mismatches without exposing data bodies." This is not a
 * logging convention, it is a property of the return type. A `ShadowComparisonV1`
 * holds digests, counts, field *paths*, and classifications — there is nowhere in
 * it to put a value, so no caller can log one by accident and no future
 * refactor can widen it without changing the type. Shadow mode runs on
 * production traffic; a mismatch log that quoted the bodies would be a
 * continuous export of budget data into a log aggregator.
 *
 * A spec asserts this directly: it compares two responses full of distinctive
 * values and checks that no value appears anywhere in the serialized result.
 *
 * ---------------------------------------------------------------------------
 * Array order is a difference, not noise
 * ---------------------------------------------------------------------------
 *
 * Arrays are compared in order by default. It would be easy to sort both sides
 * and make a whole class of mismatch disappear, and for a keyed collection that
 * would be right — but a funding timeline, a milestone schedule, and a stage
 * ladder are all ordered, and a reordered one is a real contract change a client
 * would notice. `sortArrays` is available for the genuinely unordered cases and
 * off unless asked for.
 */
import { sha256CanonicalJson } from '../contracts/canonical-json.js';

/* ------------------------------------------------------------------ */
/* M4.1 Classification vocabulary                                      */
/* ------------------------------------------------------------------ */

/** Plan §M.9, verbatim. */
export const READ_MISMATCH_CLASS_V1_VALUES = [
  'expected_improvement',
  'missing_data',
  'value_conflict',
  'identity_mismatch',
  'duplicate_or_double_count',
  'contract_shape_mismatch',
  'performance_regression',
] as const;
export type ReadMismatchClassV1 = (typeof READ_MISMATCH_CLASS_V1_VALUES)[number];

export type MismatchSeverityV1 = 'none' | 'p0' | 'p1' | 'p2';

/**
 * How each class gates the rollout.
 *
 * `identity_mismatch` and `duplicate_or_double_count` are P0 because both are
 * wrong in a way a reader cannot detect: one attributes money to the wrong line,
 * the other reports more money than exists. A missing value or a shape change is
 * P1 — visibly broken, and therefore safer. `expected_improvement` is P2: the
 * snapshot having data the legacy tables never held is the point of the
 * exercise, but it still has to be looked at rather than assumed.
 */
const SEVERITY_BY_CLASS: Record<ReadMismatchClassV1, MismatchSeverityV1> = {
  identity_mismatch: 'p0',
  duplicate_or_double_count: 'p0',
  value_conflict: 'p1',
  missing_data: 'p1',
  contract_shape_mismatch: 'p1',
  expected_improvement: 'p2',
  performance_regression: 'p2',
};

const SEVERITY_ORDER: MismatchSeverityV1[] = ['none', 'p2', 'p1', 'p0'];

export function worstSeverityV1(classes: readonly ReadMismatchClassV1[]): MismatchSeverityV1 {
  let worst: MismatchSeverityV1 = 'none';
  for (const item of classes) {
    const severity = SEVERITY_BY_CLASS[item];
    if (SEVERITY_ORDER.indexOf(severity) > SEVERITY_ORDER.indexOf(worst)) worst = severity;
  }
  return worst;
}

/** Whether this comparison blocks the canary (plan §M.10). */
export function blocksCanaryV1(severity: MismatchSeverityV1): boolean {
  return severity === 'p0' || severity === 'p1';
}

/* ------------------------------------------------------------------ */
/* M4.2 Normalization                                                  */
/* ------------------------------------------------------------------ */

export interface ShadowCompareOptionsV1 {
  /**
   * Keys dropped from both sides at every depth. A snapshot response carries
   * additive provenance the legacy one cannot have, and both carry timestamps
   * that differ by construction; comparing those would report a mismatch on
   * every single request.
   */
  volatileKeys?: readonly string[];
  /**
   * Keys that constitute identity. A difference here is a P0: the two sides are
   * describing different things, which is categorically worse than disagreeing
   * about the same thing.
   */
  identityKeys?: readonly string[];
  /** Compare arrays as unordered collections. Off by default — see the header. */
  sortArrays?: boolean;
  /** Milliseconds the snapshot side may take relative to legacy before it counts. */
  latencyBudgetRatio?: number;
}

export const DEFAULT_VOLATILE_KEYS_V1 = [
  'generatedAt',
  'requestId',
  'provenance',
  'activeSnapshotId',
  'lastActivatedAt',
  'snapshotHash',
  'overridesApplied',
  'computedAt',
  'updatedAt',
  'cachedAt',
] as const;

export const DEFAULT_IDENTITY_KEYS_V1 = [
  'peCode',
  'canonicalEntity',
  'canonicalNaturalKey',
  'naturalKey',
  'lineNumber',
  'sagCode',
  'projectNumber',
  'fiscalYear',
  'fundingField',
  'stage',
  'id',
] as const;

export const DEFAULT_LATENCY_BUDGET_RATIO_V1 = 2;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/**
 * Drop volatile keys, sort object keys, and optionally sort arrays.
 *
 * `undefined` becomes absent rather than null: a legacy response omitting a key
 * and a snapshot response setting it undefined are the same response, and
 * treating them differently would manufacture a shape mismatch on every read.
 */
export function normalizeForComparisonV1(
  value: unknown,
  options: ShadowCompareOptionsV1 = {},
): Json {
  const volatile = new Set(options.volatileKeys ?? DEFAULT_VOLATILE_KEYS_V1);

  const walk = (node: unknown): Json => {
    if (node === null || node === undefined) return null;
    if (typeof node === 'string' || typeof node === 'boolean') return node;
    if (typeof node === 'number') return Number.isFinite(node) ? node : null;
    if (node instanceof Date) return node.toISOString();
    if (Array.isArray(node)) {
      const items = node.map(walk);
      if (options.sortArrays === true) {
        return [...items].sort((a, b) =>
          sha256CanonicalJson(a as never) < sha256CanonicalJson(b as never) ? -1 : 1,
        );
      }
      return items;
    }
    if (typeof node === 'object') {
      const out: { [key: string]: Json } = {};
      for (const key of Object.keys(node as Record<string, unknown>).sort()) {
        if (volatile.has(key)) continue;
        const child = (node as Record<string, unknown>)[key];
        if (child === undefined) continue;
        out[key] = walk(child);
      }
      return out;
    }
    // Functions, symbols, bigint: not part of any HTTP response contract.
    return null;
  };

  return walk(value);
}

export function shadowDigestV1(value: unknown, options: ShadowCompareOptionsV1 = {}): string {
  return sha256CanonicalJson(normalizeForComparisonV1(value, options) as never);
}

/* ------------------------------------------------------------------ */
/* M4.3 The comparison                                                 */
/* ------------------------------------------------------------------ */

export type MismatchKindV1 = 'missing' | 'extra' | 'differs' | 'shape' | 'count';

/** One difference, located but never quoted. */
export interface MismatchDetailV1 {
  path: string;
  kind: MismatchKindV1;
}

export interface ShadowComparisonV1 {
  matched: boolean;
  legacyDigest: string;
  snapshotDigest: string;
  classes: ReadMismatchClassV1[];
  severity: MismatchSeverityV1;
  blocksCanary: boolean;
  details: MismatchDetailV1[];
  counts: { missing: number; extra: number; differs: number; shape: number; count: number };
}

/** Bounded so one pathological response cannot fill a log. */
const MAX_DETAILS = 50;

function isObject(value: Json): value is { [key: string]: Json } {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function diff(legacy: Json, snapshot: Json, path: string, out: MismatchDetailV1[]): void {
  if (out.length >= MAX_DETAILS) return;

  if (Array.isArray(legacy) && Array.isArray(snapshot)) {
    if (legacy.length !== snapshot.length) {
      out.push({ path, kind: 'count' });
    }
    const shared = Math.min(legacy.length, snapshot.length);
    for (let index = 0; index < shared; index += 1) {
      diff(legacy[index]!, snapshot[index]!, `${path}[${index}]`, out);
    }
    return;
  }

  if (isObject(legacy) && isObject(snapshot)) {
    for (const key of new Set([...Object.keys(legacy), ...Object.keys(snapshot)])) {
      const childPath = path === '' ? key : `${path}.${key}`;
      const inLegacy = key in legacy;
      const inSnapshot = key in snapshot;
      if (inLegacy && !inSnapshot) out.push({ path: childPath, kind: 'missing' });
      else if (!inLegacy && inSnapshot) out.push({ path: childPath, kind: 'extra' });
      else diff(legacy[key]!, snapshot[key]!, childPath, out);
    }
    return;
  }

  const legacyType = Array.isArray(legacy) ? 'array' : legacy === null ? 'null' : typeof legacy;
  const snapshotType = Array.isArray(snapshot)
    ? 'array'
    : snapshot === null
      ? 'null'
      : typeof snapshot;
  if (legacyType !== snapshotType) {
    // A null on one side and a value on the other is not a shape change, it is
    // presence — and which direction it goes decides whether it is a gap or the
    // improvement the whole migration is for.
    if (legacy === null) out.push({ path, kind: 'extra' });
    else if (snapshot === null) out.push({ path, kind: 'missing' });
    else out.push({ path, kind: 'shape' });
    return;
  }
  if (legacy !== snapshot) out.push({ path, kind: 'differs' });
}

function lastSegment(path: string): string {
  const afterDot = path.slice(path.lastIndexOf('.') + 1);
  const bracket = afterDot.indexOf('[');
  return bracket < 0 ? afterDot : afterDot.slice(0, bracket);
}

/**
 * Compare one legacy response against one snapshot response.
 *
 * Timing is optional and separate: a response can be byte-identical and still
 * fail the rollout on latency, which is a mismatch class in the plan and not a
 * property of the bodies.
 */
export function compareShadowReadV1(input: {
  legacy: unknown;
  snapshot: unknown;
  options?: ShadowCompareOptionsV1;
  timing?: { legacyMs: number; snapshotMs: number };
}): ShadowComparisonV1 {
  const options = input.options ?? {};
  const identityKeys = new Set(options.identityKeys ?? DEFAULT_IDENTITY_KEYS_V1);

  const legacy = normalizeForComparisonV1(input.legacy, options);
  const snapshot = normalizeForComparisonV1(input.snapshot, options);
  const legacyDigest = sha256CanonicalJson(legacy as never);
  const snapshotDigest = sha256CanonicalJson(snapshot as never);

  const details: MismatchDetailV1[] = [];
  if (legacyDigest !== snapshotDigest) diff(legacy, snapshot, '', details);

  const counts = { missing: 0, extra: 0, differs: 0, shape: 0, count: 0 };
  const classes = new Set<ReadMismatchClassV1>();

  for (const detail of details) {
    counts[detail.kind] += 1;
    switch (detail.kind) {
      case 'shape':
        classes.add('contract_shape_mismatch');
        break;
      case 'missing':
        classes.add('missing_data');
        break;
      case 'extra':
        // The snapshot carrying something legacy never had. Additive provenance
        // is already normalized away, so what is left is real new data.
        classes.add('expected_improvement');
        break;
      case 'differs':
        classes.add(
          identityKeys.has(lastSegment(detail.path)) ? 'identity_mismatch' : 'value_conflict',
        );
        break;
      case 'count':
        // Direction matters and the path alone cannot say which, so both
        // classes are reachable from a count and the walk above records the
        // element-level differences that disambiguate it.
        classes.add('duplicate_or_double_count');
        break;
    }
  }

  if (input.timing != null) {
    const ratio = options.latencyBudgetRatio ?? DEFAULT_LATENCY_BUDGET_RATIO_V1;
    // Guard the zero case: a legacy read that measured 0ms cannot produce a
    // meaningful ratio, and dividing by it would report a regression on every
    // fast request.
    if (input.timing.legacyMs > 0 && input.timing.snapshotMs > input.timing.legacyMs * ratio) {
      classes.add('performance_regression');
    }
  }

  const classList = [...classes].sort();
  const severity = worstSeverityV1(classList);
  return {
    matched: legacyDigest === snapshotDigest && !classes.has('performance_regression'),
    legacyDigest,
    snapshotDigest,
    classes: classList,
    severity,
    blocksCanary: blocksCanaryV1(severity),
    details: details.slice(0, MAX_DETAILS),
    counts,
  };
}
