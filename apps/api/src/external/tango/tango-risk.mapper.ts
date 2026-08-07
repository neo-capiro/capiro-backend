import type { Prisma } from '@prisma/client';
import { iso, str } from './tango.mappers.js';

/**
 * Protest and exclusion mapping (P45).
 *
 * ── Where these shapes come from, and where they do not ──────────────────────
 *
 * PROTESTS: `ProtestRecord` is one of the few resources @makegov/tango-node
 * actually declares as a typed interface rather than returning `AnyRecord`, and
 * the field list below is that declaration. That is a better source than a
 * guess and a worse one than a live call — this program has four decision-log
 * entries (D-35, D-41, D-42, D-45) where the SDK's declared shape and the live
 * server disagreed. It was NOT live-verified for this phase, because the
 * account's daily rate limit was exhausted during P44's own probe. The mapper
 * is written to survive the disagreement: every field is optional in the SDK's
 * own type, every one is read defensively here, and an unrecognized field
 * cannot enter a normalized object.
 *
 * EXCLUSIONS: there is no exclusions endpoint at all. P17 established that
 * against the real account — the fields live on the Entity record
 * (`exclusion_status_flag`, `exclusion_url`), which `tango.shapes.ts` has
 * deliberately excluded from `ENTITY_FIELDS` since P19 with a comment saying
 * this phase would own them. So an "exclusion" here is an observation of an
 * entity's flag at a moment, and it carries exactly what that record carries:
 * a flag, a URL, and no dates.
 *
 * ── Nothing here decides anything ────────────────────────────────────────────
 *
 * `outcome` is the provider's own word, stored verbatim and never mapped onto a
 * Capiro vocabulary: GAO and the Court of Federal Claims use the same words for
 * different procedural events, and one shared enum would make them look alike.
 * The exclusion flag is stored as TEXT rather than a boolean for the same kind
 * of reason — "the provider said no" and "the provider said nothing" are
 * different facts and only the first is evidence.
 */

/** The `ProtestRecord` fields P45 reads. Source: the SDK's own declaration. */
export const PROTEST_FIELDS = [
  'case_id',
  'case_number',
  'source_system',
  'outcome',
  'case_type',
  'filed_date',
  'decision_date',
  'agency',
  'protester',
  'resolved_agency',
  'resolved_protester',
  'docket',
] as const;

export interface TangoProtestRecord {
  caseId: string;
  caseNumber: string | null;
  sourceSystem: string | null;
  /** The provider's own word. Null means OPEN or unstated — never "failed". */
  outcome: string | null;
  caseType: string | null;
  filedDate: string | null;
  decisionDate: string | null;
  agencyName: string | null;
  protesterName: string | null;
  /** The only key a client match may use. Null when the provider resolved none. */
  protesterUei: string | null;
  docket: unknown[] | null;
  fetchedAt: string;
}

export interface TangoExclusionObservation {
  uei: string;
  /** Verbatim provider value. Not a boolean — see the file doc. */
  exclusionStatusFlag: string | null;
  exclusionUrl: string | null;
  /** Always null today. The Entity resource states neither. */
  exclusionStartDate: string | null;
  exclusionEndDate: string | null;
  observedAt: string;
}

function pickFields(
  raw: Record<string, unknown>,
  fields: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of fields) if (Object.hasOwn(raw, key)) out[key] = raw[key];
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A UEI, or null.
 *
 * Length-checked here as well as in the database, because a wrong-length value
 * that reached a query would silently match nothing — and "no protests found"
 * is exactly the wrong answer to give about a client whose UEI was mangled.
 */
export function uei12(value: unknown): string | null {
  const s = str(value);
  return s && s.length === 12 ? s : null;
}

/**
 * Map one raw protest.
 *
 * Returns null with no case id: a protest with no identity would be re-created
 * as a duplicate on the next sync.
 *
 * `resolved_protester` is preferred over `protester` for the UEI because the
 * first is the provider's own resolution to a canonical entity and the second
 * is the name as typed on a docket. The NAME is taken from whichever carries
 * one, since it is display text and not a key.
 */
export function mapProtest(
  raw: Record<string, unknown>,
  fetchedAt: string,
): TangoProtestRecord | null {
  const r = pickFields(raw, PROTEST_FIELDS);

  const caseId = str(r.case_id) ?? str(r.case_number);
  if (!caseId) return null;

  const resolvedProtester = isRecord(r.resolved_protester) ? r.resolved_protester : {};
  const protester = isRecord(r.protester) ? r.protester : {};
  const agency = isRecord(r.resolved_agency)
    ? r.resolved_agency
    : isRecord(r.agency)
      ? r.agency
      : {};

  return {
    caseId,
    caseNumber: str(r.case_number),
    sourceSystem: str(r.source_system),
    outcome: str(r.outcome),
    caseType: str(r.case_type),
    // Dates only. A protest filing date is a calendar day on a docket, not an
    // instant, and rendering it as one shifts it a day for readers west of
    // Greenwich — the same trap P26's forecast dates had to avoid.
    filedDate: dateOnly(r.filed_date),
    decisionDate: dateOnly(r.decision_date),
    agencyName: str(agency.name) ?? str(agency.agency_name) ?? str(r.agency),
    protesterName:
      str(resolvedProtester.legal_business_name) ??
      str(protester.name) ??
      str(protester.legal_business_name) ??
      str(r.protester),
    protesterUei: uei12(resolvedProtester.uei) ?? uei12(protester.uei),
    docket: Array.isArray(r.docket) ? r.docket : null,
    fetchedAt,
  };
}

/**
 * Map one Entity record's exclusion fields into an observation.
 *
 * Returns null without a well-formed UEI: an exclusion observation attached to
 * nothing is not evidence about anybody, and attaching it to a malformed key is
 * how the wrong company inherits it.
 *
 * Note what is NOT read: no dates, because the Entity resource carries none.
 * The two date fields exist on the record and on the table so the derivation
 * rule can already honour them if a provider release adds them; today they are
 * always null and the freshness of `observedAt` carries expiry instead.
 */
export function mapExclusionObservation(
  raw: Record<string, unknown>,
  observedAt: string,
): TangoExclusionObservation | null {
  const uei = uei12(raw.uei);
  if (!uei) return null;
  return {
    uei,
    exclusionStatusFlag: rawFlag(raw.exclusion_status_flag),
    exclusionUrl: str(raw.exclusion_url),
    exclusionStartDate: dateOnly(raw.exclusion_start_date),
    exclusionEndDate: dateOnly(raw.exclusion_end_date),
    observedAt,
  };
}

/**
 * The provider's flag, verbatim, including a literal `false`.
 *
 * `str()` would collapse a boolean to null and lose the difference between "the
 * provider reported no exclusion" and "the provider reported nothing" — the one
 * distinction this column exists to keep.
 */
function rawFlag(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return str(value);
}

/** `YYYY-MM-DD`, or null. Never an instant — see mapProtest's own note. */
function dateOnly(value: unknown): string | null {
  const stamp = iso(value);
  return stamp ? (stamp.slice(0, 10) ?? null) : null;
}

// ── Persistence shapes ──────────────────────────────────────────────────────

export type TangoProtestRow = Omit<
  Prisma.TangoProcurementProtestCreateInput,
  'id' | 'firstSyncedAt' | 'lastSyncedAt' | 'createdAt' | 'updatedAt'
>;

/**
 * Domain object → row.
 *
 * `samOpportunityId` is a PARAMETER, not something this function derives.
 * Linking is P27's exact-identifier rule applied by a caller that has done the
 * lookup; a mapper that guessed at it from an agency name would be the fuzzy
 * match the whole phase refuses.
 */
export function toProtestRow(
  record: TangoProtestRecord,
  samOpportunityId: string | null,
): TangoProtestRow {
  return {
    tangoCaseId: record.caseId,
    caseNumber: record.caseNumber,
    sourceSystem: record.sourceSystem,
    outcome: record.outcome,
    caseType: record.caseType,
    filedDate: record.filedDate ? new Date(`${record.filedDate}T00:00:00.000Z`) : null,
    decisionDate: record.decisionDate ? new Date(`${record.decisionDate}T00:00:00.000Z`) : null,
    agencyName: record.agencyName,
    protesterName: record.protesterName,
    protesterUei: record.protesterUei,
    docket: (record.docket ?? undefined) as Prisma.InputJsonValue | undefined,
    samOpportunityId,
    snapshot: record as unknown as Prisma.InputJsonValue,
    sourceUrl: null,
  };
}
