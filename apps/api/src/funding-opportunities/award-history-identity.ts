/**
 * Award-history identity: which federal identifiers a client's award history may
 * legitimately be read under, and on what basis.
 *
 * WHAT WAS WRONG BEFORE P02
 * -------------------------
 * One SQL predicate OR'd an exact UEI list with a reviewed-name list:
 *
 *     WHERE recipient_uei = ANY($ueis) OR lower(contractor_name) = ANY($names)
 *
 * Three separate problems, all invisible in the result set:
 *
 *  1. A name matched with the SAME authority as a verified identifier. Any other
 *     federal entity sharing a reviewed name contributed its awards, and nothing
 *     downstream could tell which rows arrived by which route.
 *
 *  2. `contracting` mappings store `externalId = federal_contractor.id`, a UUID —
 *     NOT a UEI. So `normalizeUei(externalId)` never matched for the contract
 *     rail, and the name was in practice the ONLY way a reviewed contracting
 *     mapping contributed history. The exact identifier was sitting one join away
 *     in `federal_contractor.uei` and was never read.
 *
 *  3. `assistance_recipient` mappings are different again: their `externalId` is
 *     `COALESCE(recipient_uei, recipient_name)`, so it is sometimes a UEI and
 *     sometimes a name. The same code treated both rails identically.
 *
 * THE RULE NOW
 * ------------
 * Per rail, exactly one basis:
 *
 *   `exact_uei`              at least one verified 12-character UEI is available.
 *                            Names are NOT queried at all.
 *   `reviewed_name_fallback` no usable UEI exists for this rail, and at least one
 *                            reviewed mapping carries a recorded, non-fuzzy basis.
 *   `none`                   no defensible identifier. No query is issued.
 *
 * The rail-level exclusivity is the point, and it is what the acceptance
 * criterion "a wrong same-name entity cannot add history when an exact UEI is
 * present" requires. A per-mapping rule would let a UEI-less sibling mapping
 * reintroduce a name match for a client that already has a verified identifier.
 *
 * NAMES ARE NEVER FUZZY-MATCHED HERE
 * ----------------------------------
 * The fallback query compares `lower(name) = ANY(...)` — exact equality on a
 * normalized string. There is no trigram, no stemming, no punctuation stripping.
 * Separately, a mapping whose OWN basis was fuzzy (`fuzzy_name`, or the
 * unrecorded legacy basis) may not supply a fallback name at all: a reviewer
 * confirming a fuzzy candidate confirmed a RELATIONSHIP, which is a different
 * claim from "this name is safe to use as an award identifier".
 */

import { normalizeUei } from './client-opportunity-profile.builder.js';
import type { ClientProfileFacts, ProfileMapping } from './client-opportunity-profile.types.js';

export const AWARD_MATCH_BASES = ['exact_uei', 'reviewed_name_fallback', 'none'] as const;
export type AwardMatchBasis = (typeof AWARD_MATCH_BASES)[number];

/**
 * Mapping match bases that may NOT contribute a fallback name.
 *
 * `fuzzy_name` is trigram-similarity output. `legacy_unrecorded` predates the
 * basis column, so nobody recorded how it was matched — and an unrecorded basis
 * is not a reviewed one, whatever the `confirmed` flag says.
 */
export const NON_IDENTIFYING_MATCH_BASES: ReadonlySet<string> = new Set([
  'fuzzy_name',
  'legacy_unrecorded',
]);

/** Identity tier 4 is fuzzy name and is never auto-confirmed. Not an identifier. */
export const FUZZY_MATCH_TIER = 4;

export interface AwardIdentityRail {
  basis: AwardMatchBasis;
  /** Verified UEIs. Non-empty only when `basis` is `exact_uei`. */
  ueis: string[];
  /** Lowercased exact names. Non-empty only when `basis` is `reviewed_name_fallback`. */
  fallbackNames: string[];
  /**
   * Why each reviewed mapping did or did not contribute. Kept so a reviewer can
   * be shown "this mapping was ignored because its basis was never recorded"
   * instead of an unexplained absence of history.
   */
  notes: AwardIdentityNote[];
}

export interface AwardIdentityNote {
  externalId: string | null;
  externalName: string | null;
  outcome:
    | 'own_uei'
    | 'mapping_uei'
    | 'name_available'
    | 'name_suppressed_by_uei'
    | 'name_rejected_unrecorded_basis'
    | 'name_rejected_fuzzy_basis'
    | 'no_usable_identifier';
}

export interface AwardHistoryIdentityV2 {
  contract: AwardIdentityRail;
  assistance: AwardIdentityRail;
}

/** Resolved `federal_contractor.uei`, keyed by `federal_contractor.id`. */
export type ContractorUeiIndex = ReadonlyMap<string, string | null>;

function nameIsUsable(mapping: ProfileMapping): 'ok' | 'unrecorded' | 'fuzzy' {
  if (mapping.matchBasis == null || mapping.matchBasis === '') return 'unrecorded';
  if (mapping.matchBasis === 'legacy_unrecorded') return 'unrecorded';
  if (NON_IDENTIFYING_MATCH_BASES.has(mapping.matchBasis)) return 'fuzzy';
  if (mapping.matchTier != null && mapping.matchTier >= FUZZY_MATCH_TIER) return 'fuzzy';
  return 'ok';
}

function buildRail(input: {
  ownUei: string | null;
  mappings: ProfileMapping[];
  /** How to read a verified UEI out of one mapping. Differs per rail. */
  mappingUei: (mapping: ProfileMapping) => string | null;
}): AwardIdentityRail {
  const notes: AwardIdentityNote[] = [];
  const ueis: string[] = [];
  const candidateNames: Array<{ mapping: ProfileMapping; name: string }> = [];

  if (input.ownUei) {
    ueis.push(input.ownUei);
    notes.push({ externalId: null, externalName: null, outcome: 'own_uei' });
  }

  for (const mapping of input.mappings) {
    const uei = input.mappingUei(mapping);
    if (uei) {
      ueis.push(uei);
      notes.push({
        externalId: mapping.externalId,
        externalName: mapping.externalName,
        outcome: 'mapping_uei',
      });
      continue;
    }

    const name = mapping.externalName?.trim();
    if (!name) {
      notes.push({
        externalId: mapping.externalId,
        externalName: mapping.externalName,
        outcome: 'no_usable_identifier',
      });
      continue;
    }

    const usable = nameIsUsable(mapping);
    if (usable === 'unrecorded') {
      notes.push({
        externalId: mapping.externalId,
        externalName: mapping.externalName,
        outcome: 'name_rejected_unrecorded_basis',
      });
      continue;
    }
    if (usable === 'fuzzy') {
      notes.push({
        externalId: mapping.externalId,
        externalName: mapping.externalName,
        outcome: 'name_rejected_fuzzy_basis',
      });
      continue;
    }
    candidateNames.push({ mapping, name });
  }

  const dedupedUeis = Array.from(new Set(ueis));

  // Rail-level exclusivity. A verified identifier is available, so no name is
  // queried — including names belonging to mappings that have no UEI of their own.
  if (dedupedUeis.length > 0) {
    for (const candidate of candidateNames) {
      notes.push({
        externalId: candidate.mapping.externalId,
        externalName: candidate.mapping.externalName,
        outcome: 'name_suppressed_by_uei',
      });
    }
    return { basis: 'exact_uei', ueis: dedupedUeis, fallbackNames: [], notes };
  }

  const fallbackNames = Array.from(
    new Set(candidateNames.map((c) => c.name.toLowerCase())),
  );
  if (fallbackNames.length === 0) {
    return { basis: 'none', ueis: [], fallbackNames: [], notes };
  }
  for (const candidate of candidateNames) {
    notes.push({
      externalId: candidate.mapping.externalId,
      externalName: candidate.mapping.externalName,
      outcome: 'name_available',
    });
  }
  return { basis: 'reviewed_name_fallback', ueis: [], fallbackNames, notes };
}

/**
 * Build both identity rails.
 *
 * Pure. `contractorUeis` is passed in rather than looked up here so the decision
 * logic stays testable without a database — the lookup itself lives in the
 * repository, alongside every other read.
 */
export function buildAwardHistoryIdentity(
  facts: ClientProfileFacts,
  contractorUeis: ContractorUeiIndex = new Map(),
): AwardHistoryIdentityV2 {
  const ownUei = normalizeUei(facts.uei);

  return {
    // A `contracting` mapping's externalId is a federal_contractor UUID, so the
    // verified UEI comes from the resolved index, never from externalId itself.
    contract: buildRail({
      ownUei,
      mappings: facts.contractingMappings,
      mappingUei: (m) =>
        m.externalId ? normalizeUei(contractorUeis.get(m.externalId) ?? null) : null,
    }),
    // An `assistance_recipient` mapping's externalId is COALESCE(uei, name), so a
    // UEI-shaped value IS the verified identifier and anything else is a name.
    assistance: buildRail({
      ownUei,
      mappings: facts.assistanceMappings,
      mappingUei: (m) => normalizeUei(m.externalId),
    }),
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `federal_contractor.id` values worth resolving to a UEI.
 *
 * NON-UUID VALUES ARE FILTERED OUT, AND THAT IS NOT DEFENSIVE PADDING.
 * The lookup casts this list to `uuid[]`. Postgres rejects the WHOLE statement
 * with 22P02 on the first malformed member, so one legacy or hand-pinned
 * `contracting` mapping whose `externalId` is not a UUID would abort the entire
 * nightly producer run for every tenant — not degrade that one client.
 *
 * A filtered-out id simply has no resolved UEI, which sends its rail to the name
 * fallback and is recorded in the rail's notes.
 */
export function contractorIdsToResolve(facts: ClientProfileFacts[]): string[] {
  const ids = new Set<string>();
  for (const client of facts) {
    for (const mapping of client.contractingMappings) {
      if (mapping.externalId && UUID_RE.test(mapping.externalId)) ids.add(mapping.externalId);
    }
  }
  return [...ids];
}
