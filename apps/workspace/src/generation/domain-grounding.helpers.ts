/**
 * Domain grounding for the Workspace generation engine — PARITY with the
 * in-editor Meri assistant (apps/api/src/meri). This engine is a separate
 * deployable that depends only on @capiro/shared (not apps/api), so the pure
 * primer + PE structural rules are copied here verbatim. Keep in sync with
 * apps/api/src/meri/meri-domain-fanout.helpers.ts and meri-pe-structural.helpers.ts.
 *
 * Two concerns:
 *  1. DOMAIN_PRIMER — budget-structure invariants (RDT&E vs procurement, NDAA vs
 *     appropriations, validate-the-PE) injected into the generation prompt so the
 *     WRITER has the structural knowledge ChatGPT had "for free".
 *  2. collectPeStructuralWarnings — deterministic post-generation checks that
 *     catch the Perseus-memo error classes (RDT&E/procurement category error,
 *     capability/mission mismatch) the model can still make.
 */

/** Kept ≤ ~1.2k chars so it never blows the prompt budget. */
export const DOMAIN_PRIMER = [
  'DEFENSE BUDGET STRUCTURE — validate, never assume:',
  '• A Program Element (PE) is a typed record, not just a number. Before citing one, confirm its appropriation type and budget activity match the ask.',
  '• RDT&E (Budget Activity 4) funds research, prototyping, evaluation and demonstration — NOT end-item procurement. Do not propose "directed procurement" of a system through an RDT&E line; use "directed requirement" or "evaluation/demonstration" framing, or cite a Procurement (BA 2) line.',
  '• Procurement (BA 2) funds buying fielded end items.',
  '• Authorization (NDAA) sets policy, requirements and ceilings; Appropriations bills provide the money. They are different bills, committees (HASC/SASC vs HAC-D/SAC-D) and staff. Company-specific directed language lives in the NDAA, not an appropriations bill.',
  '• A PE\'s title states its mission. A "Computer/Fire-Control/Ballistics Computer" line is software/hardware for crews, not a missile. Match capability to mission.',
  '• Do not call a PE the "primary" vehicle without checking that no materially larger sibling PE exists in the same portfolio.',
  '• Markup status (HASC/SASC marks) changes weekly. If a mark is absent from the data, say so explicitly and date it — do not imply the committee has not acted.',
].join('\n');

/** A PE record as carried on the draft config's linkedProgramElements. */
export interface PeRecordForValidation {
  peCode: string;
  title?: string | null;
  service?: string | null;
  appropriationType?: string | null;
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
  message: string;
}

export function isRdtePe(pe: PeRecordForValidation): boolean {
  const appro = (pe.appropriationType ?? '').toLowerCase();
  if (appro.includes('rdt') || appro.includes('research') || appro.includes('r&d')) return true;
  const ba = (pe.budgetActivity ?? '').toLowerCase().replace(/[^0-9]/g, '');
  if (ba === '4' || ba === '04') return true;
  return false;
}

export function isProcurementPe(pe: PeRecordForValidation): boolean {
  const appro = (pe.appropriationType ?? '').toLowerCase();
  return appro.includes('procurement') || appro.includes('proc');
}

const PROCUREMENT_INTENT_RE =
  /\b(directed\s+procurement|procurement\s+language|procure(?:ment|s|d|\s+of)?\s+(?:the\s+)?(?:system|missile|interceptor|unit|end[\s-]item)|buy\s+(?:units|systems|missiles)|production\s+procurement)\b/i;

const KINETIC_CAPABILITY_RE =
  /\b(missile|interceptor|munition|kinetic|warhead|projectile|rocket)s?\b/i;

const NON_KINETIC_TITLE_RE =
  /\b(computer|calculator|fire[\s-]control|ballistics?\s+computer|handheld|software|data\s+system)\b/i;

export function validatePeAgainstDeliverable(
  pe: PeRecordForValidation,
  deliverableText: string,
): PeStructuralWarning[] {
  const out: PeStructuralWarning[] = [];
  const text = typeof deliverableText === 'string' ? deliverableText : '';

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

// Extract distinct PE codes AND procurement line-item codes (BLINs) cited in
// text. Consolidated into @capiro/shared (RC2) so the accepted code shape can't
// drift between this generation engine, apps/api and the orchestrator;
// re-exported here so existing importers are unchanged.
export { extractCitedPeCodes } from '@capiro/shared';

/** Aggregate PE structural warnings for a generated deliverable. */
export function collectPeStructuralWarnings(
  pes: PeRecordForValidation[],
  deliverableText: string,
): PeStructuralWarning[] {
  const out: PeStructuralWarning[] = [];
  for (const pe of pes) out.push(...validatePeAgainstDeliverable(pe, deliverableText));
  return out;
}
