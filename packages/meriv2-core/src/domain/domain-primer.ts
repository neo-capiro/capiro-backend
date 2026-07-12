/**
 * DOMAIN_PRIMER — the compact, authoritative statement of the defense-budget
 * structural invariants Meri kept getting wrong (RDT&E vs procurement,
 * authorization vs appropriations, NDAA vs approps bill, "validate the PE, don't
 * assume it"). Injected into BOTH surfaces that draft/check government-affairs
 * content — the full-Meri deliverable prompt (apps/api) AND the MeriV2
 * orchestrator's in-editor assistant — so the WRITER and the CHECKER share the
 * same ground truth.
 *
 * SYNC NOTE: apps/api keeps an identical copy in
 * `apps/api/src/meri/meri-domain-fanout.helpers.ts` (apps/api does not depend on
 * this package), so the two are kept in sync by hand — edit one, edit the other.
 * Kept ≤ ~2k chars so it never blows the prompt budget.
 */
export const DOMAIN_PRIMER = [
  'DEFENSE BUDGET STRUCTURE — validate, never assume:',
  '• A Program Element (PE) is a typed record, not just a number. Before citing one, confirm its appropriation type and budget activity match the ask.',
  '• RDT&E (Budget Activity 4) funds research, prototyping, evaluation and demonstration — NOT end-item procurement. Do not propose "directed procurement" of a system through an RDT&E line; use "directed requirement" or "evaluation/demonstration" framing, or cite a Procurement (BA 2) line.',
  '• Procurement (BA 2) funds buying fielded end items. A P-1 procurement line item is NOT a "Program Element" (the R-1/R-2 construct) — state each line by its exhibit type (the tools return budgetExhibitType); never call a procurement line a "PE".',
  '• A budget book shows the current-cycle request plus outyear FYDP projection years. Cite only the FY the timeline labels cycle:"current" as "the request"; never quote an "outyear" projection FY as the current ask.',
  '• Never state WHY a mark rose or fell unless get_pe_report_language returned language for it. If it is empty, say the justification is not in the data — do not infer it from the PE title or the dollar delta.',
  '• Authorization (NDAA) sets policy, requirements and ceilings; Appropriations bills provide the money. They are different bills, committees (HASC/SASC vs HAC-D/SAC-D) and staff. Company-specific directed language lives in the NDAA, not an appropriations bill.',
  '• A PE\'s title states its mission. A "Computer/Fire-Control/Ballistics Computer" line is software/hardware for crews, not a missile. Match capability to mission.',
  '• Do not call a PE the "primary" vehicle without checking that no materially larger sibling PE exists in the same portfolio.',
  '• Markup status (HASC/SASC marks) changes weekly. If a mark is absent from the data, say so explicitly and date it — do not imply the committee has not acted.',
].join('\n');

// Extract PE codes AND procurement line-item codes (BLINs) cited in free text,
// so the structural verifier can flag one cited only in prose (not returned by
// a detail tool). Consolidated into @capiro/shared (RC2) — one canonical code
// shape across this orchestrator, apps/api and the workspace engine; re-exported
// so existing importers (and the package index) are unchanged.
export { extractCitedPeCodes } from '@capiro/shared';
