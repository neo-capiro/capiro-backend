/**
 * Shared domain primer + verify-time fan-out planning for Meri (P0-9 / P0-10).
 *
 * TWO concerns, both about giving Meri the structural knowledge ChatGPT had
 * "for free" from pretraining:
 *
 * 1. DOMAIN_PRIMER — a compact, authoritative statement of the budget-structure
 *    invariants Meri kept getting wrong (RDT&E vs procurement, authorization vs
 *    appropriations, NDAA vs approps bill, "validate the PE, don't assume it").
 *    Injected into BOTH the full-Meri deliverable prompt and the in-editor
 *    workspace-assistant system prompt so the WRITER and the CHECKER share it.
 *
 * 2. planFanOutQueries — given the entities a deliverable cites (PEs), decide
 *    which ADJACENT read-only lookups to run at verify time to catch the errors
 *    a literal claim-check misses: a better-fit funding lane, the current markup
 *    status, sibling lines that undercut a "primary vehicle" claim.
 *
 * Pure + dependency-free for `src/**.spec.ts`; the service executes the planned
 * tool calls and feeds findings into the verification result.
 */

/**
 * Kept ≤ ~1.2k chars so it never blows the prompt budget (asserted in spec).
 * SYNC NOTE: an identical copy lives in @capiro/meriv2-core
 * (src/domain/domain-primer.ts) for the MeriV2 orchestrator's in-editor
 * assistant — apps/api does not depend on that package, so the two are kept in
 * sync by hand. If you edit one, edit the other. (Follow-up: unify via a shared
 * dep once apps/api takes a meriv2-core dependency.)
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

export interface CitedPe {
  peCode: string;
  title?: string | null;
}

export type FanOutQuery =
  | { kind: 'better_fit_lane'; peCode: string; reason: string }
  | { kind: 'markup_status'; peCode: string; reason: string }
  | { kind: 'primary_vehicle_siblings'; peCode: string; reason: string };

/**
 * Decide which adjacent verify-time lookups to run for a deliverable. Emits, per
 * cited PE: a markup-status check (always — freshness), a better-fit-lane check
 * when the deliverable is about a kinetic/affordable-mass capability, and a
 * sibling check when the text makes a "primary vehicle" claim. Deduped by
 * (kind, peCode); capped to keep verify-time cost bounded.
 */
export function planFanOutQueries(
  citedPes: CitedPe[],
  deliverableText: string,
  maxQueries = 8,
): FanOutQuery[] {
  const text = typeof deliverableText === 'string' ? deliverableText : '';
  const out: FanOutQuery[] = [];
  const seen = new Set<string>();
  const push = (q: FanOutQuery) => {
    const key = `${q.kind}:${q.peCode}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (out.length < maxQueries) out.push(q);
  };

  const aboutKinetic = /\b(missile|interceptor|munition|kinetic|counter-?uas|c-?uas|drone)\b/i.test(
    text,
  );
  const aboutAffordableMass = /\b(affordable|mass[\s-]produc|low[\s-]cost|sub-?\$?\d)/i.test(text);
  const claimsPrimary =
    /\bprimary\b[^.]*\b(vehicle|lane|line|account|program)\b/i.test(text) ||
    /\b(vehicle|lane|line|account|program)\b[^.]*\bprimary\b/i.test(text);

  for (const pe of citedPes) {
    push({
      kind: 'markup_status',
      peCode: pe.peCode,
      reason: 'Markup status changes weekly; verify HASC/SASC marks are current.',
    });
    if (aboutKinetic || aboutAffordableMass) {
      push({
        kind: 'better_fit_lane',
        peCode: pe.peCode,
        reason:
          'Check for a better-fit funding lane for this capability (e.g. an affordable-mass-missiles line).',
      });
    }
    if (claimsPrimary) {
      push({
        kind: 'primary_vehicle_siblings',
        peCode: pe.peCode,
        reason: 'Deliverable claims a "primary" vehicle; check for a materially larger sibling PE.',
      });
    }
  }
  return out;
}

/** Extract distinct PE codes referenced in deliverable text (e.g. "PE 0207179F", "0604041F"). */
export function extractCitedPeCodes(text: string): string[] {
  if (typeof text !== 'string') return [];
  const out: string[] = [];
  const re = /\b(?:PE\s*)?(\d{7}[A-Z]|\d{4}[A-Z]\d{5})\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) != null) {
    const raw = m[1];
    if (!raw) continue;
    const code = raw.toUpperCase();
    if (!out.includes(code)) out.push(code);
  }
  return out;
}
