import {
  buildAssuredClaimLedger,
  classifyAssuranceRisk,
  evaluateAssuranceRelease,
  inferClaimCategories,
  planGovernmentAffairsEvidence,
  resolveGovernmentAffairsOperatingFrame,
  runGovernmentAffairsChecks,
  HIGH_RISK_CLAIM_CATEGORIES,
  type AssuranceGateResult,
  type AssuredEvidence,
  type ClaimCandidate,
} from '@capiro/meriv2-core';
import type { ExtractedConflict, ExtractedFact, StewardRef } from './steward-prompt.js';

/**
 * Context Steward assurance — pure (no DI, no network, no environment read) so
 * the withhold decision is unit-testable and the environment read stays visible
 * at the one call site in steward-extract.service.ts.
 *
 * WHY THE STEWARD NEEDS A GATE AT ALL. Its output is not client-facing prose, so
 * it is deliberately NOT in risk-gate.ts's EXTERNAL_OR_EXECUTION_SURFACES. But it
 * is a claim-ledger PRODUCER: every fact it returns is persisted by api-strategy
 * into sp_context_fact and then feeds the Strategy context pack, where a
 * downstream surface will read it as established client context. A fabricated
 * budget figure anchored to an anchor that does not exist therefore launders
 * itself into authority. Holding it here is the only pre-persistence point the
 * orchestrator controls — api-strategy owns the write.
 */

export interface StewardFactVerdict {
  /** Index in the facts array as handed in. */
  index: number;
  category: string;
  highRisk: boolean;
  /** Did the fact's sourceRef resolve to a ref in the document's closed set? */
  anchorResolved: boolean;
  held: boolean;
  reason?: string;
}

export interface StewardAssuranceOutcome {
  /** Facts to return. Identical to the input unless `armed` and something was held. */
  facts: ExtractedFact[];
  /** Conflicts, with newFactIndex REMAPPED onto the surviving facts array. */
  conflicts: ExtractedConflict[];
  verdicts: StewardFactVerdict[];
  heldCount: number;
  gate: AssuranceGateResult;
  /** Stable hash of the resolved claim ledger, for the audit trail. */
  ledgerHash: string;
}

/**
 * Anchors are the document's own headings/rows, supplied by api-strategy from
 * markdown-locate — not model output. A fact anchored to one of them is anchored
 * to client-approved context; a fact anchored to anything else cites a source
 * that provably does not exist in the document it claims to come from.
 */
function anchorEvidence(refs: readonly StewardRef[]): AssuredEvidence[] {
  return refs.map((ref) => ({
    id: `anchor:${ref.ref}`,
    sourceType: 'context_document_anchor',
    sourceId: ref.ref,
    evidenceClass: 'client_approved_context' as const,
    ...(ref.preview ? { title: ref.preview.slice(0, 300) } : {}),
    primary: true,
    authoritative: true,
    requirementIds: [],
    coverage: {
      // One anchor proves what it says; it never proves the document is complete,
      // so an absence/exhaustive claim stays unsupported.
      description: 'Single document anchor; document-set completeness not established.',
      complete: false,
      truncated: false,
      failedSources: [],
    },
  }));
}

export function assessStewardFacts(input: {
  facts: readonly ExtractedFact[];
  conflicts: readonly ExtractedConflict[];
  refs: readonly StewardRef[];
  templateKey: string;
  clientId?: string;
  /** Caller has already read the dark switch. False ⇒ observe only, withhold nothing. */
  armed: boolean;
}): StewardAssuranceOutcome {
  const evidence = anchorEvidence(input.refs);
  const known = new Set(evidence.map((item) => item.id));
  const categories = input.facts.map(
    (fact) => inferClaimCategories(fact.fact)[0] ?? 'general_background',
  );
  const candidates: ClaimCandidate[] = input.facts.map((fact, index) => ({
    id: `fact-${index}`,
    text: fact.fact,
    // Extraction claims are asserted as FACT — that is what api-strategy persists
    // them as. Calling them inferences here would launder the same problem.
    type: 'fact',
    category: categories[index]!,
    // An unknown anchor is passed through as an UNRESOLVABLE source id on purpose:
    // claim-ledger.ts then reports "one or more cited evidence identifiers do not
    // resolve" rather than us silently treating the fact as uncited.
    sourceIds: [`anchor:${fact.sourceRef}`],
    ...(fact.asOf ? { asOf: fact.asOf } : {}),
  }));

  // The Steward answers "what does this document say", so the request text is the
  // document's own template key + the fact texts; there is no user turn to frame.
  const request = [input.templateKey, ...input.facts.map((fact) => fact.fact)]
    .join('\n')
    .slice(0, 8_000);
  const frame = resolveGovernmentAffairsOperatingFrame({
    request,
    ...(input.clientId ? { explicit: { clientId: input.clientId } } : {}),
  });
  // `surface` is intentionally omitted: the steward is not a client-facing
  // surface, so it must not inherit the `surface.high-risk-primary-basis`
  // requirement that would make every extraction run report an evidence gap.
  const plan = planGovernmentAffairsEvidence({ request, frame });
  const ledger = buildAssuredClaimLedger(candidates, evidence, { plan });
  const gate = evaluateAssuranceRelease({
    surface: 'steward',
    plan,
    ledger,
    findings: runGovernmentAffairsChecks({ ledger, facts: [] }),
  });

  const unsupported = new Set(ledger.unsupportedClaimIds);
  const conflicted = new Set(ledger.conflictedClaimIds);
  const verdicts: StewardFactVerdict[] = input.facts.map((fact, index) => {
    const id = `fact-${index}`;
    const category = categories[index]!;
    const highRisk = HIGH_RISK_CLAIM_CATEGORIES.has(category);
    const anchorResolved = known.has(`anchor:${fact.sourceRef}`);
    // HOLD CRITERION: a high-risk factual category whose citation does not
    // resolve. Deliberately narrow — a low-risk fact with a bad anchor is a
    // quality problem api-strategy can surface, not a fabricated authority.
    const held = highRisk && (unsupported.has(id) || conflicted.has(id));
    return {
      index,
      category,
      highRisk,
      anchorResolved,
      held,
      ...(held
        ? {
            reason: anchorResolved
              ? `High-risk ${category} fact could not be resolved against its cited anchor.`
              : `High-risk ${category} fact cites an anchor that is not in the document's closed set.`,
          }
        : {}),
    };
  });

  const heldCount = verdicts.filter((verdict) => verdict.held).length;
  if (!input.armed || heldCount === 0) {
    return {
      facts: [...input.facts],
      conflicts: [...input.conflicts],
      verdicts,
      heldCount,
      gate,
      ledgerHash: ledger.hash,
    };
  }

  // Withhold the held facts and REMAP surviving conflict indices. A conflict
  // whose new fact was held is dropped with it — never silently re-paired against
  // whichever fact shifted into that slot (same invariant as
  // sanitizeExtractedFactsIndexed).
  const facts: ExtractedFact[] = [];
  const oldToNew = new Map<number, number>();
  verdicts.forEach((verdict) => {
    if (verdict.held) return;
    oldToNew.set(verdict.index, facts.length);
    facts.push(input.facts[verdict.index]!);
  });
  const conflicts = input.conflicts
    .filter((conflict) => oldToNew.has(conflict.newFactIndex))
    .map((conflict) => ({ ...conflict, newFactIndex: oldToNew.get(conflict.newFactIndex)! }));

  return { facts, conflicts, verdicts, heldCount, gate, ledgerHash: ledger.hash };
}

/** Risk classification for the metric dimensions, without re-running the gate. */
export function stewardRiskLevel(templateKey: string): string {
  return classifyAssuranceRisk(
    'steward',
    planGovernmentAffairsEvidence({
      request: templateKey,
      frame: resolveGovernmentAffairsOperatingFrame({ request: templateKey }),
    }),
  ).level;
}
