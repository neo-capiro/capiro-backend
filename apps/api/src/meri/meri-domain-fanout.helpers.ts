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

/** Canonical primer from the lowest common dependency; no hand-synced copy. */
export { DEFENSE_BUDGET_DOMAIN_PRIMER as DOMAIN_PRIMER } from '@capiro/shared';

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

// Extract distinct PE codes AND procurement line-item codes (BLINs) cited in
// deliverable text. Consolidated into @capiro/shared (RC2) so the accepted
// code shape can't drift between this surface, the workspace generation engine
// and the orchestrator; re-exported here so existing importers are unchanged.
export { extractCitedPeCodes } from '@capiro/shared';
