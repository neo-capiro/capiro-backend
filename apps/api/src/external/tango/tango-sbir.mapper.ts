import type { Prisma } from '@prisma/client';
import { bool, int, str } from './tango.mappers.js';
// Shared rather than copied. Both sources write DATE columns and need the exact
// same UTC-midnight anchoring — a second copy would be free to drift, and this
// one carries the reasoning and its own tests. It lives in the DIBBS mapper for
// historical reasons only; move it to tango.mappers.ts if a third source needs
// it.
import { dateOnly } from './tango-dibbs.mapper.js';

/**
 * Funding Opportunities P42 — raw SBIR/STTR JSON to the rows `tango_sbir_*`
 * store.
 *
 * The provider publishes two list endpoints — `/api/sbir/topics/` and
 * `/api/sbir/solicitations/` — whose contract is transcribed in
 * `docs/plans/funding-opportunities-makegov-v1/dibbs-sbir-rest-contract.md`.
 *
 * ── EVERYTHING HERE IS PROVISIONAL, AND MORE SO THAN P40's ──────────────────
 *
 * The published documentation gives field NAMES. It does not give types, null
 * semantics, date formats, or the pagination envelope. **Nothing has ever
 * called `/api/sbir/`** — P17's 2026-08-08 run confirmed the envelope for
 * `/api/dibbs/` only, so this file has strictly less evidence behind it than
 * `tango-dibbs.mapper.ts` did on the day it merged.
 *
 * So it is written to survive being wrong, the same way: an unparseable value
 * becomes null rather than a guess, a record with no usable identity is dropped
 * and counted rather than half-mapped, and no field is inferred from another.
 * The tests pin the READING, not the provider's behaviour. Confirm against one
 * real response before trusting any type here, and expect at least one to be
 * wrong.
 *
 * ── TWO ENDPOINTS, TWO IDENTIFIERS, AND NEITHER IS `uuid` ───────────────────
 *
 * Topics key on `topic_id`, solicitations on `solicitation_id`. The contract
 * doc calls this out explicitly because it is the natural wrong assumption —
 * DIBBS keys everything on `uuid`, and a mapper that reached for `raw['uuid']`
 * here would return null for every record and report a clean "0 mapped".
 * Each mapper names its own id field, and neither falls back to the other's.
 *
 * ── WHAT THE PLAN ASKS FOR THAT THE PROVIDER DOES NOT PUBLISH ───────────────
 *
 * P42's work item names phase, description, DSIP parent and a source
 * opportunity/grant link. None has a documented field on either endpoint, and
 * none is mapped here — not to a column, and not to an approximation of one.
 * The migration header records each and why. The rule this follows is
 * `AwardHistoryFacts.contractOffices`, whose own comment records what happens
 * when a signal is fed a lookalike because it was adjacent and available.
 *
 * In particular `official_solicitation_url` is NOT parsed for a DSIP
 * identifier. It is stored as the URL it is.
 */

export type TangoSbirSolicitationRow = Omit<
  Prisma.TangoSbirSolicitationCreateInput,
  'id' | 'firstSyncedAt' | 'lastSyncedAt' | 'createdAt' | 'updatedAt'
>;

export type TangoSbirTopicRow = Omit<
  Prisma.TangoSbirTopicCreateInput,
  'id' | 'firstSyncedAt' | 'lastSyncedAt' | 'createdAt' | 'updatedAt'
>;

/**
 * A four-digit solicitation year, or null.
 *
 * Deliberately narrower than `int()`. The column carries a CHECK bounding the
 * year to 1980-2200, so a value outside that range would make the whole insert
 * fail — dropping a good record over a bad secondary field. Out-of-range
 * becomes null here instead, which is the same choice `reconcileQuantity` makes
 * in the DIBBS mapper: lose the field, keep the row.
 *
 * What the range actually catches is narrower than it looks, and worth stating
 * so nobody relies on it for more. `int()` builds on `num()`, which uses
 * `Number()` — so a date string like `'2026-01-01'` is already NaN and already
 * null before this function sees it. The range adds two cases `int()` would
 * otherwise accept as plausible years: an epoch-milliseconds timestamp
 * (1767225600000) and a two-digit year (26). Both would store, sort and filter
 * as if they were years.
 */
export function solicitationYear(value: unknown): number | null {
  const parsed = int(value);
  if (parsed == null) return null;
  return parsed >= 1980 && parsed <= 2200 ? parsed : null;
}

/**
 * `/api/sbir/solicitations/` — one solicitation cycle.
 *
 * Returns null when the record has no `solicitation_id` or no
 * `solicitation_number`: the first is the upsert key, the second is NOT NULL on
 * the table and is the ONLY key a topic carries back to its cycle. A cycle
 * missing either cannot be stored without inventing one, so it is dropped and
 * counted rather than half-mapped.
 */
export function mapSbirSolicitation(
  raw: Record<string, unknown>,
): TangoSbirSolicitationRow | null {
  const tangoSbirId = str(raw['solicitation_id']);
  const solicitationNumber = str(raw['solicitation_number']);
  if (tangoSbirId == null || solicitationNumber == null) return null;

  return {
    tangoSbirId,
    solicitationNumber,
    title: str(raw['title']),
    // The SBIR/STTR discriminator, stored as the provider spells it. Not
    // upper-cased, not mapped to an enum: the contract documents the field and
    // not its value set, so normalising would be inventing a vocabulary.
    program: str(raw['program']),
    cycleName: str(raw['cycle_name']),
    year: solicitationYear(raw['year']),
    startDate: dateOnly(raw['start_date']),
    endDate: dateOnly(raw['end_date']),
    outOfCycle: bool(raw['out_of_cycle']),
    activity: str(raw['activity']),
    // The provider's own lifecycle word, never derived from `end_date`. A cycle
    // whose end date has passed is not necessarily one the provider calls
    // closed — the same distinction P40 records for `is_open`.
    solicitationStatus: str(raw['solicitation_status']),
    solDownloadUrl: str(raw['sol_download_url']),
  };
}

/**
 * `/api/sbir/topics/` — one topic.
 *
 * Returns null only when the record has no `topic_id`. Unlike a cycle, a topic
 * with no `solicitation_number` is still worth storing: it is a real topic that
 * simply states no parent, and the column is nullable precisely so that case is
 * representable rather than dropped.
 */
export function mapSbirTopic(raw: Record<string, unknown>): TangoSbirTopicRow | null {
  const tangoSbirId = str(raw['topic_id']);
  if (tangoSbirId == null) return null;

  return {
    tangoSbirId,
    topicNumber: str(raw['topic_number']),
    title: str(raw['title']),
    // The provider's single `agency` field. NOT split into agency/component:
    // the resource publishes one value, and deriving a component from it would
    // be parsing a guess out of a name.
    agency: str(raw['agency']),
    year: solicitationYear(raw['year']),
    solicitationNumber: str(raw['solicitation_number']),
    releaseDate: dateOnly(raw['release_date']),
    openDate: dateOnly(raw['open_date']),
    closeDate: dateOnly(raw['close_date']),
    activity: str(raw['activity']),
    solicitationStatus: str(raw['solicitation_status']),
    topicUrl: str(raw['topic_url']),
    // Stored as the URL it is. Never parsed for a DSIP identifier — see the
    // file header.
    officialSolicitationUrl: str(raw['official_solicitation_url']),
  };
}
