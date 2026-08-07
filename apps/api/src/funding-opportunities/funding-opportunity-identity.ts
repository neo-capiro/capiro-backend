import { BadRequestException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { OPPORTUNITY_SOURCES, type OpportunitySource } from './funding-opportunities.types.js';

/**
 * How a `client_funding_opportunity` row names the source record it is about.
 *
 * ── The problem this exists to solve ─────────────────────────────────────────
 *
 * The workflow row has carried source identity as TWO nullable foreign-key-shaped
 * columns since the table was created: `grant_opportunity_id` and
 * `sam_opportunity_id`, with a CHECK that exactly one is set and that it matches
 * `source`. That works for exactly two sources. Agency forecasts (P24), DIBBS
 * (P40) and SBIR/STTR (P42) each want the same durable decision record — a human
 * decision, an owner, a next action, an audit trail — and adding a third nullable
 * column per source means a wider CHECK, another partial unique index and another
 * branch in every writer, forever.
 *
 * ── The bridge, not the replacement ──────────────────────────────────────────
 *
 * P13 adds a GENERIC identity — `source_record_type` + `source_record_key` — and
 * changes nothing else. The legacy columns stay, keep being written, and remain
 * the constraint's requirement for the two legacy sources. New rows carry both
 * forms; existing rows were backfilled deterministically.
 *
 * That redundancy is the point. It is what makes the deploy safe in both
 * directions:
 *
 *   Old code reading a NEW row  — reads the legacy pointer, which is still there.
 *   New code reading an OLD row — the backfill filled the generic key, and where
 *                                  it did not (a row written by old code during
 *                                  the rolling deploy) the read falls back to the
 *                                  legacy pointer. See {@link readSourceRecordId}.
 *
 * Removing the legacy columns is a separate, later, CONTRACT phase. Nothing here
 * moves toward that.
 */

/**
 * Every source the SCHEMA can hold a workflow row for.
 *
 * Wider than {@link OPPORTUNITY_SOURCES}, which is what the API accepts. The
 * database CHECK is widened here so the generic branch of the constraint is
 * reachable and therefore TESTABLE — an unreachable constraint is an untested
 * one, and this phase's whole job is to prove the generic shape holds.
 *
 * No code path produces any of the planned values. Each is enabled by its own
 * phase, which adds it to `OPPORTUNITY_SOURCES` and ships the producer that
 * writes it.
 */
export const PLANNED_OPPORTUNITY_SOURCES = ['agency_forecast', 'dibbs', 'sbir_sttr'] as const;
export type PlannedOpportunitySource = (typeof PLANNED_OPPORTUNITY_SOURCES)[number];

export const STORABLE_OPPORTUNITY_SOURCES = [
  ...OPPORTUNITY_SOURCES,
  ...PLANNED_OPPORTUNITY_SOURCES,
] as const;
export type StorableOpportunitySource = (typeof STORABLE_OPPORTUNITY_SOURCES)[number];

/**
 * The record type each source produces.
 *
 * A SEPARATE field from `source` rather than a derivation of it, because the two
 * answer different questions and will stop being 1:1. `source` is the product
 * rail a row belongs to ("agency forecast"); `sourceRecordType` is the shape of
 * the thing pointed at ("a Tango procurement forecast record"), which is what a
 * later phase needs in order to know which table to join. Tango alone will supply
 * forecasts, DIBBS solicitations and SBIR topics under different record types.
 */
export const SOURCE_RECORD_TYPES: Readonly<Record<StorableOpportunitySource, string>> =
  Object.freeze({
    grants_gov: 'grants_gov_opportunity',
    sam_gov: 'sam_notice',
    agency_forecast: 'tango_procurement_forecast',
    dibbs: 'dibbs_solicitation',
    sbir_sttr: 'sbir_topic',
  });

/** The two sources whose identity still lives in a dedicated legacy column. */
export const LEGACY_POINTER_SOURCES = OPPORTUNITY_SOURCES;

export function isLegacyPointerSource(source: string): source is OpportunitySource {
  return (LEGACY_POINTER_SOURCES as readonly string[]).includes(source);
}

export function isStorableSource(source: string): source is StorableOpportunitySource {
  return (STORABLE_OPPORTUNITY_SOURCES as readonly string[]).includes(source);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The columns a writer must set to name one source record.
 *
 * DUAL-WRITE by construction: there is no way to call this and get only one of
 * the two forms, which is what stops a new row from being invisible to old code
 * (or an old row from being invisible to the generic index).
 */
export interface SourceRecordIdentity {
  source: StorableOpportunitySource;
  grantOpportunityId: string | null;
  samOpportunityId: string | null;
  sourceRecordType: string;
  sourceRecordKey: string;
}

/**
 * Build the identity columns for one (source, source record id).
 *
 * Throws rather than returning a partial identity. A malformed combination is a
 * caller bug that the database CHECK would reject anyway — surfacing it here
 * gives the caller a sentence instead of a constraint-violation stack trace, and
 * keeps the failure on the request rather than inside a transaction that has
 * already written an audit row.
 */
export function buildSourceRecordIdentity(
  source: string,
  sourceRecordId: string,
): SourceRecordIdentity {
  if (!isStorableSource(source)) {
    throw new BadRequestException(
      `Unknown opportunity source "${source}". Known sources: ${STORABLE_OPPORTUNITY_SOURCES.join(', ')}`,
    );
  }
  const key = sourceRecordId?.trim();
  if (!key) {
    throw new BadRequestException('A source record id is required.');
  }
  return {
    source,
    grantOpportunityId: source === 'grants_gov' ? key : null,
    samOpportunityId: source === 'sam_gov' ? key : null,
    sourceRecordType: SOURCE_RECORD_TYPES[source],
    sourceRecordKey: key,
  };
}

/**
 * Extra validation for a source record id that came from a REQUEST.
 *
 * Separate from {@link buildSourceRecordIdentity} on purpose. That function
 * validates identity SHAPE — a known source, a non-empty key — and is called by
 * producers, which read `sam_opportunity.id` out of a uuid column and cannot
 * produce a malformed one. This function validates USER INPUT, and belongs only on
 * paths where a stranger picked the string.
 *
 * The check it adds is narrow but load-bearing: `sam_opportunity_id` is a uuid
 * column, so a non-uuid reaching a Prisma `where` on it raises a driver error that
 * surfaces as a 500 and reads as a server fault, when the truth is that the caller
 * sent nonsense.
 */
export function assertRequestSourceRecordId(source: string, sourceRecordId: string): void {
  if (source === 'sam_gov' && !UUID_RE.test(sourceRecordId?.trim() ?? '')) {
    throw new BadRequestException('SAM opportunity id must be a UUID');
  }
}

/** Just the four identity columns, for spreading into a Prisma `create`. */
export function sourceRecordIdentityColumns(source: string, sourceRecordId: string) {
  const identity = buildSourceRecordIdentity(source, sourceRecordId);
  return {
    grantOpportunityId: identity.grantOpportunityId,
    samOpportunityId: identity.samOpportunityId,
    sourceRecordType: identity.sourceRecordType,
    sourceRecordKey: identity.sourceRecordKey,
  };
}

/**
 * The generic columns ONLY, for backfilling a row that already exists.
 *
 * Used on the update path so a row created by pre-P13 code acquires its generic
 * identity the first time new code touches it — the rolling-deploy tail the
 * migration's one-shot backfill cannot reach.
 */
export function backfillIdentityColumns(source: string, sourceRecordId: string) {
  const identity = buildSourceRecordIdentity(source, sourceRecordId);
  return {
    sourceRecordType: identity.sourceRecordType,
    sourceRecordKey: identity.sourceRecordKey,
  };
}

/** The row shape this module reads. Deliberately structural, not the Prisma type. */
export interface IdentityBearingRow {
  source: string;
  grantOpportunityId?: string | null;
  samOpportunityId?: string | null;
  sourceRecordKey?: string | null;
}

/**
 * DUAL-READ: the source record id of a row, whichever form it carries.
 *
 * Legacy pointer FIRST for a legacy source. The legacy column is the one the
 * database CHECK guarantees is present and the one the partial unique index is
 * built on; the generic key is a copy of it that a row written by pre-P13 code
 * during a rolling deploy simply will not have. Preferring the copy would make
 * that row read as having no source record at all — which renders as
 * "Source record no longer in the catalog" in the inbox.
 *
 * Returns null only for a row that is malformed under every form, which the CHECK
 * makes impossible but which a caller should still not have to crash on.
 */
export function readSourceRecordId(row: IdentityBearingRow): string | null {
  if (row.source === 'grants_gov') return row.grantOpportunityId ?? row.sourceRecordKey ?? null;
  if (row.source === 'sam_gov') return row.samOpportunityId ?? row.sourceRecordKey ?? null;
  return row.sourceRecordKey ?? null;
}

/**
 * The WHERE fragment that finds one row by (source, source record id).
 *
 * An OR across both forms. For a legacy source the two branches select the same
 * row, so the OR costs nothing and covers the rolling-deploy window in both
 * directions: a row written by old code matches on the legacy pointer, and a row
 * written by a future source matches on the generic key.
 *
 * Callers add `clientId` (and RLS supplies the tenant).
 */
export function sourceRecordWhere(
  source: string,
  sourceRecordId: string,
): Prisma.ClientFundingOpportunityWhereInput {
  const identity = buildSourceRecordIdentity(source, sourceRecordId);
  const generic = {
    sourceRecordType: identity.sourceRecordType,
    sourceRecordKey: identity.sourceRecordKey,
  };
  if (identity.grantOpportunityId != null) {
    return { source, OR: [{ grantOpportunityId: identity.grantOpportunityId }, generic] };
  }
  if (identity.samOpportunityId != null) {
    return { source, OR: [{ samOpportunityId: identity.samOpportunityId }, generic] };
  }
  return { source, ...generic };
}

// ── URL encoding, in one place ──────────────────────────────────────────────

/**
 * `source/sourceRecordId` as two path segments, with the id percent-encoded.
 *
 * Centralised because Grants.gov opportunity numbers are free-form source
 * strings: `DE-FOA-0001` is typical, but nothing in the source contract forbids a
 * slash, and one unencoded slash turns a two-segment route into a three-segment
 * 404 for exactly the records that contain it. Mirrors
 * `opportunityDetailPath` in apps/web's funding-opportunities-api.ts.
 */
export function encodeSourceRecordPath(source: string, sourceRecordId: string): string {
  return `${encodeURIComponent(source)}/${encodeURIComponent(sourceRecordId)}`;
}

/**
 * Parse a `source/sourceRecordId` pair back out, validating both halves.
 *
 * Fails CLOSED with a 400 rather than returning a partial result: a request that
 * names a source Capiro does not hold is a request that cannot be answered, and
 * guessing a default source would answer a different question than the one asked.
 */
export function parseSourceRecordPath(
  rawSource: string,
  rawId: string,
): { source: StorableOpportunitySource; sourceRecordId: string } {
  const source = safeDecode(rawSource);
  const sourceRecordId = safeDecode(rawId);
  const identity = buildSourceRecordIdentity(source, sourceRecordId);
  // A path segment is user input by definition.
  assertRequestSourceRecordId(identity.source, identity.sourceRecordKey);
  return { source: identity.source, sourceRecordId: identity.sourceRecordKey };
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    // A malformed percent-escape is not a decoding problem to recover from; the
    // raw value cannot name a record either way and the validator below says so.
    return value;
  }
}
