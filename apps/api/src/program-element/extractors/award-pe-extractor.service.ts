import { Injectable } from '@nestjs/common';
import { isValidProgramCode } from '../jbook/jbook-extract.js';

/**
 * Extracts a Program Element code or procurement BLIN from a USAspending award
 * and validates it against the known program_element universe (Step 28).
 *
 * Resolution order:
 *   1. An explicit PE/BLIN field on the award (program_element / pe_code), if present.
 *   2. Otherwise, regex on the award description.
 * The first valid, DB-known code wins. An award with no resolvable/known code
 * keeps pe_code NULL — it is NOT quarantined (awards legitimately span many that
 * have no R-2 PE line, e.g. O&M / services).
 */

// PE code OR procurement BLIN in free text. Same canon as the rest of the
// pipeline (jbook isValidProgramCode = isValidPeCode || isValidProcurementCode).
// NB: a bare 7-digit number is only a PE when followed by the service letter.
const PE_IN_TEXT = /\b(?:[0-9]{7}[A-Z][A-Z0-9]*|[0-9]{4}[A-Z]{1,2}[0-9A-Z]{2,14})\b/g;

export interface AwardLike {
  /** Explicit PE field if USAspending/source provides one. */
  programElement?: string | null;
  peCode?: string | null;
  description?: string | null;
  /** DoD acquisition / MDAP program code off the contract record. */
  dodAcqProgramCode?: string | null;
}

/** How a PE was resolved for an award — surfaced for provenance + honest UI. */
export type AwardPeSource = 'explicit' | 'dod_acquisition_program' | 'description_regex';

export interface ResolvedAwardPe {
  peCode: string;
  source: AwardPeSource;
}

/**
 * Map from a DoD acquisition (MDAP) program code, exactly as USAspending emits
 * it, to the set of known PE codes it links to. Built from the reviewed
 * program_element_acquisition_program table. Codes that mean "no program"
 * ('000' / 'NONE' / blank) MUST NOT be present in this map.
 */
export type AcqProgramToPeCodes = ReadonlyMap<string, ReadonlySet<string>>;

// MDAP codes that explicitly mean "not a program" — never linkable.
const NON_PROGRAM_ACQ_CODES = new Set(['', '000', 'NONE', 'N/A', 'NA']);

@Injectable()
export class AwardPeExtractorService {
  /**
   * Resolve a PE code for an award against the set of known PE codes.
   * Returns the uppercased PE if a valid, known one is found; otherwise null.
   *
   * NOTE: preserved verbatim for backward compatibility (existing callers + spec).
   * New code should prefer {@link resolvePe}, which adds the DoD-acquisition-program
   * tier and returns provenance.
   */
  extractPeCode(award: AwardLike, knownPeCodes: ReadonlySet<string>): string | null {
    // 1) explicit field
    const explicit = (award.programElement ?? award.peCode ?? '').toString().trim().toUpperCase();
    if (explicit && isValidProgramCode(explicit) && knownPeCodes.has(explicit)) {
      return explicit;
    }

    // 2) regex on description — first valid, known candidate wins
    const desc = award.description ?? '';
    if (desc) {
      const matches = desc.toUpperCase().match(PE_IN_TEXT);
      if (matches) {
        for (const m of matches) {
          const candidate = m.trim().toUpperCase();
          if (isValidProgramCode(candidate) && knownPeCodes.has(candidate)) {
            return candidate;
          }
        }
      }
    }

    return null;
  }

  /**
   * Tiered PE resolution with provenance. Order, highest trust first:
   *   1. explicit PE field on the award (rare for USAspending contracts).
   *   2. DoD acquisition / MDAP program code -> reviewed PE map. This is the
   *      primary production tier: the program code is government-assigned on the
   *      contract itself, and the PE link comes from a curated map, so it is
   *      defensible with zero text inference. When a program maps to exactly ONE
   *      known PE, that PE is attributed; when it maps to several, we do NOT guess
   *      a single PE here (the contractor read path fans the award across all
   *      linked PEs instead) — so this tier only auto-resolves the unambiguous
   *      1:1 case to keep federal_award.pe_code honest.
   *   3. description regex (legacy; effectively never fires for USAspending).
   *
   * Returns null when nothing resolves — the award keeps pe_code NULL (NOT
   * quarantined), exactly as before.
   */
  resolvePe(
    award: AwardLike,
    knownPeCodes: ReadonlySet<string>,
    acqProgramToPeCodes: AcqProgramToPeCodes = new Map(),
  ): ResolvedAwardPe | null {
    // 1) explicit field
    const explicit = (award.programElement ?? award.peCode ?? '').toString().trim().toUpperCase();
    if (explicit && isValidProgramCode(explicit) && knownPeCodes.has(explicit)) {
      return { peCode: explicit, source: 'explicit' };
    }

    // 2) DoD acquisition program code -> PE map (1:1 only, see doc above)
    const acqCode = (award.dodAcqProgramCode ?? '').toString().trim().toUpperCase();
    if (acqCode && !NON_PROGRAM_ACQ_CODES.has(acqCode)) {
      const linked = acqProgramToPeCodes.get(acqCode);
      if (linked && linked.size === 1) {
        const only = linked.values().next().value as string | undefined;
        if (only && knownPeCodes.has(only.toUpperCase())) {
          return { peCode: only.toUpperCase(), source: 'dod_acquisition_program' };
        }
      }
    }

    // 3) regex on description — first valid, known candidate wins
    const desc = award.description ?? '';
    if (desc) {
      const matches = desc.toUpperCase().match(PE_IN_TEXT);
      if (matches) {
        for (const m of matches) {
          const candidate = m.trim().toUpperCase();
          if (isValidProgramCode(candidate) && knownPeCodes.has(candidate)) {
            return { peCode: candidate, source: 'description_regex' };
          }
        }
      }
    }

    return null;
  }
}
