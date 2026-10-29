import { createHash } from 'node:crypto';
import type {
  BizDevWatchBaseline,
  BizDevWatchDeliveryCheckpoint,
  BizDevWatchScanCheckpoint,
  BizDevWatchScanExposureCheckpoint,
} from './bizdev-watch.types.js';

/**
 * PURE checkpoint validation helper (Phase 5 paging split). No DB, no runner
 * import, no side effects: persisted baselineState JSON is untrusted DATA at
 * this boundary — every field is validated before the runner trusts it, and
 * malformed or newer-version data FAILS CLOSED (throws a safe error) rather
 * than fabricating success or dropping accepted state.
 */

const CONTENT_HASH = /^[0-9a-f]{64}$/;
/**
 * Structural anchor shape (matches the runner's BizDevWatchIdentityAnchor
 * without importing it — no circular dependency). `resolved` is not part of
 * scope identity.
 */
interface WatchScopeAnchor {
  uei: string | null;
  exactNames: string[];
}

/**
 * Source-scope/identity fingerprint reflecting the ACTUAL source query:
 * - UEI-keyed families: family + exact UEI. An alias addition does not change
 *   the hash (the query is unchanged) so it never quiet-resets awards; a
 *   genuine UEI change does.
 * - lda_filing: family + exact UEI + the exact raw-name candidate set in
 *   stable deduplicated order, because its query is name-based (CONTAINS over
 *   raw names) — a candidate expansion changes the scope.
 */
export function scanScopeHash(family: string, anchor: WatchScopeAnchor): string {
  const parts = [family, anchor.uei ?? ''];
  if (family === 'lda_filing') {
    parts.push([...new Set(anchor.exactNames)].sort().join('\n'));
  }
  return createHash('sha256').update(parts.join('\n')).digest('hex');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** Null-or-nonempty string; `undefined` is NOT an explicit null. */
function isExplicitOptionalId(value: unknown): boolean {
  return value === null || isNonemptyString(value);
}

function isUsableIsoDate(value: unknown): value is string {
  return isNonemptyString(value) && !Number.isNaN(Date.parse(value));
}

/** Traversal key pair: explicit ids, and cursor <= inclusive fence. */
function assertIdRange(where: string, cursorId: unknown, fenceId: unknown): void {
  if (!isExplicitOptionalId(cursorId) || !isExplicitOptionalId(fenceId)) {
    throw new Error(`${where}: cursor/fence must be explicit null or nonempty string`);
  }
  if (cursorId !== null && fenceId === null) {
    throw new Error(`${where}: a non-null cursor requires a fence`);
  }
  if (typeof cursorId === 'string' && typeof fenceId === 'string' && cursorId > fenceId) {
    throw new Error(`${where}: cursor is past the inclusive fence`);
  }
}

function assertNonnegativeSafeInt(where: string, value: unknown): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${where}: must be a nonnegative safe integer`);
  }
}

/** Validate ONE baseline/staged record (keyed by its own recordId). */
function assertBaselineRecord(key: unknown, record: unknown): void {
  if (!isNonemptyString(key)) {
    throw new Error('baseline record key must be a nonempty string');
  }
  if (!isPlainObject(record)) {
    throw new Error(`baseline record ${key} is malformed`);
  }
  if (record.recordId !== key) {
    throw new Error(`baseline record key ${key} does not match recordId`);
  }
  if (typeof record.fingerprint !== 'string' || !CONTENT_HASH.test(record.fingerprint)) {
    throw new Error(`baseline record ${key} has an invalid content fingerprint`);
  }
  if (record.semanticSequence !== undefined) {
    assertNonnegativeSafeInt(`baseline record ${key} semanticSequence`, record.semanticSequence);
  }
  if (
    record.sourceRevision !== undefined &&
    record.sourceRevision !== null &&
    !isNonemptyString(record.sourceRevision)
  ) {
    throw new Error(`baseline record ${key} has a malformed sourceRevision`);
  }
  for (const dateField of ['effectiveAt', 'publishedAt'] as const) {
    const value = record[dateField];
    if (value !== undefined && value !== null && !isUsableIsoDate(value)) {
      throw new Error(`baseline record ${key} has an unusable ${dateField}`);
    }
  }
  if (record.material !== undefined && !isPlainObject(record.material)) {
    throw new Error(
      `baseline record ${key} material must be a JSON object, not an array or raw payload`,
    );
  }
}

function assertRecordMap(where: string, records: unknown): void {
  if (!isPlainObject(records)) {
    throw new Error(`${where} must be an object keyed by recordId`);
  }
  for (const [key, record] of Object.entries(records)) {
    assertBaselineRecord(key, record);
  }
}

/** Validate the optional SAM agency-exposure sub-walk. */
function assertExposure(exposure: unknown): void {
  if (exposure === undefined) return;
  if (!isPlainObject(exposure)) {
    throw new Error('scan exposure must be an object');
  }
  if (typeof exposure.complete !== 'boolean') {
    throw new Error('scan exposure completeness must be a boolean');
  }
  if (
    !Array.isArray(exposure.agencies) ||
    !exposure.agencies.every((agency) => isNonemptyString(agency))
  ) {
    throw new Error('scan exposure agencies must be an array of nonempty strings');
  }
  assertIdRange('scan exposure', exposure.cursorId, exposure.fenceId);
}

/**
 * Validate the optional MB-05 delivery-recovery cursor. It is carried progress
 * for THIS watch's alert rows (independent of the source scope), so it is
 * accepted in either phase and validated fail-closed exactly like the exposure
 * sub-walk: a malformed cursor must never be silently reinterpreted as "start
 * from the beginning" (that would replay a whole watch history) nor as
 * "advance past everything" (that would strand the same alerts the cursor
 * exists to recover).
 */
function assertDeliveryCheckpoint(delivery: unknown): void {
  if (delivery === undefined) return;
  if (!isPlainObject(delivery)) {
    throw new Error('delivery recovery cursor must be an object');
  }
  if (delivery.version !== 1) {
    throw new Error('delivery recovery cursor is malformed or a newer version — refusing to advance');
  }
  const cursorAtMs = delivery.cursorAtMs;
  if (cursorAtMs !== null && (typeof cursorAtMs !== 'number' || !Number.isSafeInteger(cursorAtMs) || cursorAtMs < 0)) {
    throw new Error('delivery recovery cursor has a malformed instant');
  }
  const cursorId = delivery.cursorId;
  if (cursorId !== null && !isNonemptyString(cursorId)) {
    throw new Error('delivery recovery cursor has a malformed id');
  }
  // A paired keyset: the instant and the id advance together, never one alone.
  if ((cursorAtMs === null) !== (cursorId === null)) {
    throw new Error('delivery recovery cursor must carry both keyset parts or neither');
  }
  assertNonnegativeSafeInt('delivery recovery cursor pagesDone', delivery.pagesDone);
}

function freshCheckpoint(scopeHash: string, phase: 'initial' | 'cycle'): BizDevWatchScanCheckpoint {
  return {
    version: 1,
    scopeHash,
    phase,
    cursorId: null,
    fenceId: null,
    stagedRecords: {},
    pagesDone: 0,
  };
}

/**
 * Resolve the checkpoint from a stored baseline. LEGACY baselines (no `scan`
 * field) keep working: a fresh checkpoint is synthesized — for an established
 * legacy baseline the next pass starts a reconciliation cycle from the
 * beginning (the legacy fingerprints came from a bounded newest-N read; a
 * full keyset walk re-validates them). A null baseline is a fresh quiet scan.
 * Malformed or NEWER-version checkpoint data FAILS CLOSED (throws a safe,
 * non-fabricating error the runner records as partial) — never crashes, never
 * invents success, never mutates the input.
 */
export function resolveScanCheckpoint(
  baseline: BizDevWatchBaseline | null,
  scopeHash: string,
  established: boolean,
): BizDevWatchScanCheckpoint {
  if (baseline == null) {
    return freshCheckpoint(scopeHash, established ? 'cycle' : 'initial');
  }
  if (!isPlainObject(baseline)) {
    throw new Error('Stored watch baseline is malformed — refusing to advance');
  }
  if (typeof baseline.initialized !== 'boolean') {
    throw new Error('Stored watch baseline has a malformed initialized flag — refusing to advance');
  }
  if (!isUsableIsoDate(baseline.establishedAt)) {
    throw new Error('Stored watch baseline has an unusable establishedAt — refusing to advance');
  }
  if (
    baseline.effectiveFloorAt !== undefined &&
    baseline.effectiveFloorAt !== null &&
    !isUsableIsoDate(baseline.effectiveFloorAt)
  ) {
    throw new Error('Stored watch baseline has an unusable effectiveFloorAt — refusing to advance');
  }
  assertRecordMap('baseline records', baseline.records);

  const scan: unknown = baseline.scan;
  if (scan == null) {
    // Legacy baseline (or fresh): keep initialized/established semantics.
    return freshCheckpoint(scopeHash, baseline.initialized ? 'cycle' : 'initial');
  }
  if (!isPlainObject(scan)) {
    throw new Error(
      'Stored watch scan checkpoint is malformed or a newer version — refusing to advance; the scan restarts safely only after the checkpoint is reset',
    );
  }
  if (scan.version !== 1) {
    throw new Error(
      'Stored watch scan checkpoint is malformed or a newer version — refusing to advance; the scan restarts safely only after the checkpoint is reset',
    );
  }
  if (typeof scan.scopeHash !== 'string' || !CONTENT_HASH.test(scan.scopeHash)) {
    throw new Error('Stored watch scan checkpoint has an invalid scope hash');
  }
  if (scan.phase !== 'initial' && scan.phase !== 'cycle') {
    throw new Error('Stored watch scan checkpoint has an unknown phase');
  }
  assertIdRange('scan checkpoint', scan.cursorId, scan.fenceId);
  assertNonnegativeSafeInt('scan pagesDone', scan.pagesDone);
  assertRecordMap('scan stagedRecords', scan.stagedRecords);

  // Phase-vs-baseline consistency: a cycle checkpoint presumes an established
  // baseline; an initial (quiet staging) checkpoint presumes an uninitialized
  // one. Neither may silently flip accepted state.
  const expectedPhase = baseline.initialized ? 'cycle' : 'initial';
  if (scan.phase !== expectedPhase) {
    throw new Error(
      `Stored watch scan phase "${scan.phase}" is inconsistent with the baseline's initialized state — refusing to advance`,
    );
  }
  // An established (cycle) checkpoint must never carry leftover quiet staged
  // records from an earlier initial traversal.
  if (
    scan.phase === 'cycle' &&
    Object.keys(scan.stagedRecords as Record<string, unknown>).length > 0
  ) {
    throw new Error(
      'Established scan checkpoint carries leftover staged records — refusing to advance',
    );
  }
  assertExposure(scan.exposure);
  assertDeliveryCheckpoint(scan.delivery);

  return scan as unknown as BizDevWatchScanCheckpoint;
}

/**
 * PURE advance of the MB-05 delivery-recovery cursor (Phase 5 paging split).
 *
 * `acknowledged` is the CONTIGUOUS OLDEST-FIRST prefix of the recovery page
 * whose delivery the delivery owner definitely answered — never a scattered
 * subset, and never the whole page when an older row is still UNKNOWN. An empty
 * prefix (nothing definitively answered) returns the cursor UNCHANGED, so the
 * next evaluation re-offers exactly the same rows. Advancing is monotone: the
 * cursor only ever moves forward to the last acknowledged key.
 */
export function nextDeliveryCheckpoint(
  current: BizDevWatchDeliveryCheckpoint | undefined,
  acknowledged: readonly { id: string; occurredAtMs: number }[],
): BizDevWatchDeliveryCheckpoint {
  const base: BizDevWatchDeliveryCheckpoint =
    current == null
      ? { version: 1, cursorAtMs: null, cursorId: null, pagesDone: 0 }
      : current;
  if (acknowledged.length === 0) return { ...base };
  const last = acknowledged[acknowledged.length - 1] as { id: string; occurredAtMs: number };
  return {
    version: 1,
    cursorAtMs: last.occurredAtMs,
    cursorId: last.id,
    // A page only counts when it genuinely advanced the cursor.
    pagesDone: base.pagesDone + 1,
  };
}

/**
 * Keyset predicate for the next recovery page: strictly AFTER the cursor pair,
 * in (firstObservedAt, id) order. Exported so the runner's query and any test
 * harness derive the SAME boundary — a drifting duplicate is exactly how a row
 * gets skipped.
 */
export function deliveryAfterCursor(
  current: BizDevWatchDeliveryCheckpoint | undefined,
): { at: Date; id: string } | null {
  if (current == null || current.cursorAtMs === null || current.cursorId === null) return null;
  return { at: new Date(current.cursorAtMs), id: current.cursorId };
}

// Re-export so the runner's integration keeps a single typed surface.
export type { BizDevWatchScanExposureCheckpoint };
