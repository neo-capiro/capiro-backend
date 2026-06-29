/**
 * Deterministic structural validation for Program Element (PE) claims (P0-7).
 *
 * The grounding verifier (meri-verifier.helpers) answers "do the sources back
 * this claim?" — a retrieval question. It does NOT answer "is this the RIGHT
 * program, and is the strategic framing structurally coherent?" Those are
 * deterministic facts about a PE record (its appropriation type, its budget
 * activity, its mission/title) that an LLM fact-check can miss but a rule check
 * never does.
 *
 * Concretely, these rules catch the two error classes from the Perseus Defense
 * memo forensics:
 *   1. RDT&E-vs-procurement category error — a deliverable that proposes
 *      "directed procurement" of an end item through an RDT&E (BA 4) line.
 *   2. Capability-vs-mission mismatch — a deliverable that anchors a missile/
 *      interceptor strategy to a fire-control-computer PE (the XM32 / LHMBC
 *      "Computer Ballistics" line is a mortar ballistic computer, not a missile).
 *
 * Pure + dependency-free so it unit-tests under the repo's `src/**.spec.ts`
 * matcher; the orchestrating service supplies the cited PEs + deliverable text.
 */

/** A PE record as returned by the `get_program_element` / search tools. */
export interface PeRecordForValidation {
  peCode: string;
  title?: string | null;
  service?: string | null;
  /** e.g. 'RDT&E', 'Procurement', 'O&M' — free text from the J-books. */
  appropriationType?: string | null;
  /** e.g. '02', '04', or 'BA 04' — the budget-activity code. */
  budgetActivity?: string | null;
  budgetActivityName?: string | null;
}

export type PeWarningCode =
  | 'rdte_procurement_mismatch'
  | 'capability_mission_mismatch'
  | 'primary_vehicle_overclaim';

export interface PeStructuralWarning {
  code: PeWarningCode;
  peCode: string;
  /** Human-readable, ready to surface in the verification panel. */
  message: string;
}

/** True when the PE's appropriation/budget-activity marks it an RDT&E line. */
export function isRdtePe(pe: PeRecordForValidation): boolean {
  const appro = (pe.appropriationType ?? '').toLowerCase();
  if (appro.includes('rdt') || appro.includes('research') || appro.includes('r&d')) return true;
  // Budget Activity 4 (and the R-prefixed names) are RDT&E in the DoD taxonomy.
  const ba = (pe.budgetActivity ?? '').toLowerCase().replace(/[^0-9]/g, '');
  if (ba === '4' || ba === '04') return true;
  return false;
}

/** True when the PE is an explicit procurement line. */
export function isProcurementPe(pe: PeRecordForValidation): boolean {
  const appro = (pe.appropriationType ?? '').toLowerCase();
  return appro.includes('procurement') || appro.includes('proc');
}

/**
 * Phrases that indicate the deliverable is proposing END-ITEM PROCUREMENT
 * (buying units), as opposed to evaluation / demonstration / experimentation.
 */
const PROCUREMENT_INTENT_RE =
  /\b(directed\s+procurement|procurement\s+language|procure(?:ment|s|d|\s+of)?\s+(?:the\s+)?(?:system|missile|interceptor|unit|end[\s-]item)|buy\s+(?:units|systems|missiles)|production\s+procurement)\b/i;

/** Capability nouns that denote a kinetic/weapon end item (not a computer/service). Handles plurals. */
const KINETIC_CAPABILITY_RE =
  /\b(missile|interceptor|munition|kinetic|warhead|projectile|rocket)s?\b/i;

/**
 * PE titles that are clearly NOT a kinetic end item even when "ballistics" or
 * "fire control" appears — these are computers / calculators / software.
 */
const NON_KINETIC_TITLE_RE =
  /\b(computer|calculator|fire[\s-]control|ballistics?\s+computer|handheld|software|data\s+system)\b/i;

/**
 * Validate one cited PE against the deliverable text. Returns 0+ warnings.
 * Conservative: only emits a warning when the structural signal is unambiguous.
 */
export function validatePeAgainstDeliverable(
  pe: PeRecordForValidation,
  deliverableText: string,
): PeStructuralWarning[] {
  const out: PeStructuralWarning[] = [];
  const text = typeof deliverableText === 'string' ? deliverableText : '';

  // Rule 1: RDT&E line + procurement intent => category mismatch.
  if (isRdtePe(pe) && !isProcurementPe(pe) && PROCUREMENT_INTENT_RE.test(text)) {
    out.push({
      code: 'rdte_procurement_mismatch',
      peCode: pe.peCode,
      message:
        `PE ${pe.peCode} (${pe.title ?? 'untitled'}) is an RDT&E account` +
        `${pe.budgetActivity ? ` (Budget Activity ${pe.budgetActivity})` : ''}, not a procurement line. ` +
        `The deliverable uses end-item procurement language against it. Use "directed requirement" ` +
        `or "evaluation/demonstration" framing for an RDT&E PE, or cite a procurement (BA 2) line.`,
    });
  }

  // Rule 2: capability/mission mismatch — deliverable is about a kinetic end
  // item, but the PE title is a computer / fire-control / software line.
  const title = pe.title ?? '';
  if (
    KINETIC_CAPABILITY_RE.test(text) &&
    NON_KINETIC_TITLE_RE.test(title) &&
    !KINETIC_CAPABILITY_RE.test(title)
  ) {
    out.push({
      code: 'capability_mission_mismatch',
      peCode: pe.peCode,
      message:
        `PE ${pe.peCode} is titled "${title}", which is a fire-control / computer / software ` +
        `line — not a kinetic interceptor or missile program. The deliverable's capability ` +
        `(missile/interceptor/kinetic) does not match this PE's mission. Verify this is the ` +
        `correct program before anchoring strategy to it.`,
    });
  }

  return out;
}

/**
 * Flag a "primary funding vehicle" overclaim: the deliverable calls a PE the
 * "primary" lane, but a materially larger sibling PE exists in the same
 * portfolio. `siblings` are (peCode, latestAmount) the caller already retrieved.
 */
export function validatePrimaryVehicleClaim(
  citedPe: { peCode: string; latestAmount: number | null },
  deliverableText: string,
  siblings: Array<{ peCode: string; title?: string | null; latestAmount: number | null }>,
  // A sibling this many times larger makes "primary" indefensible.
  factor = 3,
): PeStructuralWarning | null {
  const text = typeof deliverableText === 'string' ? deliverableText : '';
  const claimsPrimary =
    /\bprimary\b[^.]*\b(vehicle|lane|line|account|program)\b/i.test(text) ||
    /\b(vehicle|lane|line|account|program)\b[^.]*\bprimary\b/i.test(text);
  if (!claimsPrimary) return null;
  const base = citedPe.latestAmount;
  if (base == null || base <= 0) return null;
  const bigger = siblings
    .filter((s) => s.peCode !== citedPe.peCode && s.latestAmount != null && s.latestAmount > base * factor)
    .sort((a, b) => (b.latestAmount ?? 0) - (a.latestAmount ?? 0));
  if (!bigger.length) return null;
  const top = bigger[0];
  if (!top) return null;
  return {
    code: 'primary_vehicle_overclaim',
    peCode: citedPe.peCode,
    message:
      `The deliverable frames PE ${citedPe.peCode} as the "primary" vehicle, but PE ${top.peCode}` +
      `${top.title ? ` (${top.title})` : ''} is materially larger ` +
      `(${fmtUsdM(top.latestAmount)} vs ${fmtUsdM(base)}). Drop the "primary" framing or ` +
      `re-anchor to the larger line.`,
  };
}

function fmtUsdM(n: number | null): string {
  if (n == null) return 'n/a';
  return `$${(n / 1_000_000).toFixed(2)}M`;
}

/** Aggregate all PE structural warnings for a deliverable. */
export function collectPeStructuralWarnings(
  pes: PeRecordForValidation[],
  deliverableText: string,
): PeStructuralWarning[] {
  const out: PeStructuralWarning[] = [];
  for (const pe of pes) out.push(...validatePeAgainstDeliverable(pe, deliverableText));
  return out;
}
