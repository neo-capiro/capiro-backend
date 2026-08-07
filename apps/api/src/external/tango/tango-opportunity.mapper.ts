import type { TangoOpportunity } from './tango.types.js';

/**
 * Crosswalking one MakeGov/Tango opportunity to Capiro's own SAM.gov row, and
 * comparing what the two catalogs say about it (Funding Opportunities P27).
 *
 * ── Two separate questions, deliberately answered by two functions ───────────
 *
 * {@link resolveCrosswalk} answers "is this the SAME record" — an IDENTITY
 * question, answered only by an exact identifier match, and answered
 * `ambiguous` rather than guessed when more than one candidate fits.
 *
 * {@link compareParity} answers "do the two agree about it" — a CONTENT
 * question, and it is only ever asked once identity is settled. Comparing
 * fields across two records that might not be the same record produces
 * confident-looking nonsense.
 *
 * ── The identity rule ────────────────────────────────────────────────────────
 *
 * SAM.gov's `noticeId` is the stable key on Capiro's side; Tango's
 * `opportunityId` is the stable key on the provider's. They are DIFFERENT key
 * spaces and the provider does not publish SAM's notice id on this resource,
 * so there is no direct id-to-id match available. What is available is
 * `solicitationNumber`, which both sides carry — and which is NOT unique on
 * either side.
 *
 * That non-uniqueness is the whole problem this phase has to get right. One
 * solicitation number routinely spans a presolicitation, a solicitation and
 * several amendments, each of which is its own `sam_opportunity` row. So:
 *
 *   exactly one candidate    → `linked`, basis `exact_identifier`
 *   more than one candidate  → `ambiguous`, and NOTHING is linked
 *   no candidate             → `unlinked`
 *
 * `ambiguous` is a first-class outcome with its own count in the diagnostic,
 * not a silent skip and never a "pick the newest". Picking one would attach a
 * provider observation — including a deadline — to whichever amendment
 * happened to sort first, which is how a closed presolicitation acquires a
 * live deadline.
 *
 * There is deliberately no title match, no fuzzy fallback and no scoring. P02
 * settled this for award history and the rule is the same here: an identifier
 * or nothing.
 *
 * ── The comparison rule ──────────────────────────────────────────────────────
 *
 * Only fields BOTH catalogs actually carry are compared. A provider-exclusive
 * field has no local counterpart, so comparing it would report a conflict on
 * every single row — noise that buries the real ones. Those fields still reach
 * Capiro; they go to the snapshot, which is what the snapshot is for.
 *
 * `both_absent`, `local_only` and `provider_only` are outcomes in their own
 * right, not collapsed into `conflict`. "SAM states a deadline and Tango does
 * not" is a coverage fact about the provider; "they state DIFFERENT deadlines"
 * is a data-quality finding somebody has to look at. One of those is worth an
 * alert and the other is not.
 */

// ── Identity ─────────────────────────────────────────────────────────────────

export const CROSSWALK_STATES = ['linked', 'ambiguous', 'unlinked'] as const;
export type CrosswalkState = (typeof CROSSWALK_STATES)[number];

/** The minimum of a `sam_opportunity` row this module needs to identify it. */
export interface SamCandidate {
  id: string;
  noticeId: string;
  solicitationNumber: string | null;
}

export interface CrosswalkResult {
  state: CrosswalkState;
  /** Set only for `linked`. */
  samOpportunityId: string | null;
  /** How many local rows the identifier matched. 0, 1, or >1. */
  candidateCount: number;
  /** Operator-readable, and never a suggestion to pick one. */
  reason: string;
}

/**
 * Comparison form for a solicitation number.
 *
 * Uppercase alphanumerics only. SAM.gov and the provider both echo the
 * agency's own string, and agencies are not consistent about hyphens or
 * spacing within one number ("W911QY-26-R-0012" vs "W911QY26R0012" have both
 * been observed for the same notice). Stripping the separators is a
 * normalization of the SAME identifier, not a fuzzy match — no character is
 * added, removed or transposed, and two genuinely different numbers cannot
 * normalize to one another.
 */
export function normalizeSolicitationNumber(value: string | null | undefined): string {
  return (value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Resolve one provider opportunity against the local candidates its
 * solicitation number matched.
 *
 * `candidates` is what the caller's own query returned for
 * `normalizeSolicitationNumber(opportunity.solicitationNumber)`. This function
 * makes the DECISION; the query is the caller's, so this stays pure.
 */
export function resolveCrosswalk(
  opportunity: Pick<TangoOpportunity, 'opportunityId' | 'solicitationNumber'>,
  candidates: readonly SamCandidate[],
): CrosswalkResult {
  const normalized = normalizeSolicitationNumber(opportunity.solicitationNumber);
  if (!normalized) {
    return {
      state: 'unlinked',
      samOpportunityId: null,
      candidateCount: 0,
      reason:
        'The provider states no solicitation number for this opportunity, and no other identifier is shared between the two catalogs.',
    };
  }

  // Defensive: the caller queries by the normalized number, but a caller that
  // passed a wider set must not have it silently accepted. Re-filtering here
  // is what makes this function's contract checkable on its own.
  const matching = candidates.filter(
    (c) => normalizeSolicitationNumber(c.solicitationNumber) === normalized,
  );

  if (matching.length === 0) {
    return {
      state: 'unlinked',
      samOpportunityId: null,
      candidateCount: 0,
      reason: `No SAM.gov notice in Capiro carries solicitation number ${opportunity.solicitationNumber}.`,
    };
  }

  if (matching.length > 1) {
    return {
      state: 'ambiguous',
      samOpportunityId: null,
      candidateCount: matching.length,
      reason:
        `${matching.length} SAM.gov notices share solicitation number ${opportunity.solicitationNumber} ` +
        '(a presolicitation, a solicitation and its amendments are separate notices under one number). ' +
        'No link is recorded: attaching a provider observation to whichever one sorted first is how a ' +
        'closed notice acquires a live deadline.',
    };
  }

  const only = matching[0]!;
  return {
    state: 'linked',
    samOpportunityId: only.id,
    candidateCount: 1,
    reason: `Exactly one SAM.gov notice (${only.noticeId}) carries solicitation number ${opportunity.solicitationNumber}.`,
  };
}

// ── Parity ───────────────────────────────────────────────────────────────────

/**
 * The lifecycle fields compared. Must stay in sync with
 * `tango_opportunity_parity_field_chk` — `tango-opportunity.mapper.spec.ts`
 * asserts that against the migration SQL directly.
 */
export const PARITY_FIELDS = [
  'title',
  'solicitation_number',
  'response_deadline',
  'active',
  'set_aside',
  'naics_code',
  'psc_code',
  'agency',
] as const;
export type ParityField = (typeof PARITY_FIELDS)[number];

export const PARITY_AGREEMENTS = [
  'agree',
  'conflict',
  'local_only',
  'provider_only',
  'both_absent',
] as const;
export type ParityAgreement = (typeof PARITY_AGREEMENTS)[number];

export interface ParityRow {
  field: ParityField;
  localValue: string | null;
  providerValue: string | null;
  agreement: ParityAgreement;
}

/** The `sam_opportunity` columns compared. Typed, not stringified, on the way in. */
export interface SamParitySource {
  title: string | null;
  solicitationNumber: string | null;
  responseDeadline: Date | null;
  active: boolean | null;
  setAside: string | null;
  naicsCode: string | null;
  pscCode: string | null;
  agency: string | null;
}

/**
 * Per-field comparison values, as a canonical STRING for storage plus the
 * comparison key the outcome is decided on.
 *
 * The two are separate because for three of the eight fields they differ:
 *
 *   `response_deadline` — stored as full ISO (an operator needs the time), but
 *     COMPARED to the minute. The two catalogs round the same SAM.gov value
 *     differently at the seconds place, and a seconds-level disagreement about
 *     a deadline weeks away is not a finding, it is a rounding artefact that
 *     would fill the ledger with false conflicts.
 *   `naics_code` / `psc_code` — compared as bare alphanumerics for the same
 *     reason `normalizeSolicitationNumber` exists: the same code, punctuated
 *     differently, is the same code.
 *   `title` / `set_aside` / `agency` — compared case-insensitively with runs of
 *     whitespace collapsed. An agency that re-cases its own title has not
 *     changed it.
 *
 * Everything else is compared on the stored value exactly.
 */
function comparable(field: ParityField, stored: string | null): string | null {
  if (stored == null) return null;
  switch (field) {
    case 'response_deadline':
      // Trim to minute precision: '2026-09-01T17:00:00.000Z' -> '2026-09-01T17:00'.
      return stored.slice(0, 16);
    case 'naics_code':
    case 'psc_code':
      return stored.toUpperCase().replace(/[^A-Z0-9]/g, '') || null;
    case 'solicitation_number':
      return normalizeSolicitationNumber(stored) || null;
    case 'title':
    case 'set_aside':
    case 'agency':
      return stored.toLowerCase().replace(/\s+/g, ' ').trim() || null;
    case 'active':
      return stored;
  }
}

function storedString(value: string | number | boolean | Date | null | undefined): string | null {
  if (value == null) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  const asString = String(value).trim();
  return asString === '' ? null : asString;
}

function decide(local: string | null, provider: string | null): ParityAgreement {
  if (local == null && provider == null) return 'both_absent';
  if (provider == null) return 'local_only';
  if (local == null) return 'provider_only';
  return local === provider ? 'agree' : 'conflict';
}

/**
 * Compare one linked pair, field by field.
 *
 * Returns a row for EVERY field, including `both_absent` ones. A ledger that
 * only stored disagreements could not answer "has this been checked", and
 * "checked and both silent" is exactly the coverage fact the parity diagnostic
 * reports on.
 */
export function compareParity(
  local: SamParitySource,
  provider: TangoOpportunity,
): ParityRow[] {
  const pairs: Array<{
    field: ParityField;
    local: string | null;
    provider: string | null;
  }> = [
    { field: 'title', local: storedString(local.title), provider: storedString(provider.title) },
    {
      field: 'solicitation_number',
      local: storedString(local.solicitationNumber),
      provider: storedString(provider.solicitationNumber),
    },
    {
      field: 'response_deadline',
      local: storedString(local.responseDeadline),
      // The provider states an ISO string; normalize it through Date so the two
      // sides are stored in one format rather than compared across two.
      provider: storedString(provider.responseDeadline ? new Date(provider.responseDeadline) : null),
    },
    { field: 'active', local: storedString(local.active), provider: storedString(provider.active) },
    { field: 'set_aside', local: storedString(local.setAside), provider: storedString(provider.setAside) },
    { field: 'naics_code', local: storedString(local.naicsCode), provider: storedString(provider.naicsCode) },
    { field: 'psc_code', local: storedString(local.pscCode), provider: storedString(provider.pscCode) },
    { field: 'agency', local: storedString(local.agency), provider: storedString(provider.agency) },
  ];

  return pairs.map(({ field, local: l, provider: p }) => ({
    field,
    localValue: l,
    providerValue: p,
    agreement: decide(comparable(field, l), comparable(field, p)),
  }));
}

/**
 * The provider observation, normalized for `tango_resource_snapshot`.
 *
 * The FULL normalized domain object, not a subset and not the raw wire
 * payload — the same choice `tango-forecast.mapper.ts` makes and for the same
 * reason: a reader of the snapshot should see exactly what Capiro's own mapper
 * decided the record means, not a second differently-shaped copy to reconcile.
 *
 * `provenance` is dropped: `tango_resource_snapshot` already stores fetched-at,
 * provider-updated-at and the resource type as COLUMNS, and duplicating them
 * inside the JSON is how the two come to disagree.
 */
export function toOpportunitySnapshot(
  opportunity: TangoOpportunity,
): Record<string, unknown> {
  const { provenance: _provenance, ...rest } = opportunity;
  return { ...rest };
}
