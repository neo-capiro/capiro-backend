import {
  buildAssuranceEnvelope,
  buildAssuredClaimLedger,
  classifyAssuranceRisk,
  evaluateAssuranceRelease,
  inferClaimCategories,
  planGovernmentAffairsEvidence,
  resolveGovernmentAffairsOperatingFrame,
  runGovernmentAffairsChecks,
  HIGH_RISK_CLAIM_CATEGORIES,
  type AssuranceEnvelope,
  type AssuranceGateResult,
  type AssurancePolicyBinding,
  type AssuranceRolloutMode,
  type AssuredEvidence,
  type ClaimCandidate,
} from '@capiro/meriv2-core';
import type { ExtractedConflict, ExtractedFact, StewardRef } from './steward-prompt.js';

export interface StewardFactVerdict {
  index: number;
  category: string;
  highRisk: boolean;
  anchorResolved: boolean;
  /** Would the canonical verifier withhold this fact in enforce mode? */
  held: boolean;
  reason?: string;
}

export interface StewardAssuranceOutcome {
  facts: ExtractedFact[];
  conflicts: ExtractedConflict[];
  verdicts: StewardFactVerdict[];
  heldCount: number;
  gate: AssuranceGateResult;
  ledgerHash: string;
  envelope: AssuranceEnvelope;
}

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
  contextPacketId?: string | null;
  policyBinding?: AssurancePolicyBinding | null;
  generatedAt?: string | Date;
  mode?: AssuranceRolloutMode;
  /** Backward-compatible pre-Phase-16 call shape. */
  armed?: boolean;
}): StewardAssuranceOutcome {
  const evidence = anchorEvidence(input.refs);
  const known = new Set(evidence.map((item) => item.id));
  const categories = input.facts.map(
    (fact) => inferClaimCategories(fact.fact)[0] ?? 'general_background',
  );
  const candidates: ClaimCandidate[] = input.facts.map((fact, index) => ({
    id: `fact-${index}`,
    text: fact.fact,
    type: 'fact',
    category: categories[index]!,
    sourceIds: [`anchor:${fact.sourceRef}`],
    ...(fact.asOf ? { asOf: fact.asOf } : {}),
  }));

  const request = [input.templateKey, ...input.facts.map((fact) => fact.fact)]
    .join('\n')
    .slice(0, 8_000);
  const frame = resolveGovernmentAffairsOperatingFrame({
    request,
    ...(input.clientId ? { explicit: { clientId: input.clientId } } : {}),
  });
  const plan = planGovernmentAffairsEvidence({ request, frame });
  const ledger = buildAssuredClaimLedger(candidates, evidence, { plan });
  const findings = runGovernmentAffairsChecks({ ledger, facts: [] });
  const gate = evaluateAssuranceRelease({
    surface: 'steward',
    plan,
    ledger,
    findings,
  });

  const unsupported = new Set(ledger.unsupportedClaimIds);
  const conflicted = new Set(ledger.conflictedClaimIds);
  const verdicts: StewardFactVerdict[] = input.facts.map((fact, index) => {
    const id = `fact-${index}`;
    const category = categories[index]!;
    const highRisk = HIGH_RISK_CLAIM_CATEGORIES.has(category);
    const anchorResolved = known.has(`anchor:${fact.sourceRef}`);
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

  const envelope = buildAssuranceEnvelope({
    surface: 'steward',
    operatingFrame: frame,
    evidencePlan: plan,
    claimLedger: ledger,
    gate,
    findings: findings.map((finding) => ({
      ...finding,
      attribution: findingAttribution(finding.span, input.facts),
    })),
    contextPacketId: input.contextPacketId ?? null,
    policyBinding: input.policyBinding ?? null,
    generatedAt: input.generatedAt,
  });
  const heldCount = verdicts.filter((verdict) => verdict.held).length;
  const mode: AssuranceRolloutMode = input.mode ?? (input.armed ? 'enforce' : 'off');
  if (mode !== 'enforce' || heldCount === 0) {
    return {
      facts: [...input.facts],
      conflicts: [...input.conflicts],
      verdicts,
      heldCount,
      gate,
      ledgerHash: ledger.hash,
      envelope,
    };
  }

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

  return { facts, conflicts, verdicts, heldCount, gate, ledgerHash: ledger.hash, envelope };
}

export function stewardRiskLevel(templateKey: string): string {
  return classifyAssuranceRisk(
    'steward',
    planGovernmentAffairsEvidence({
      request: templateKey,
      frame: resolveGovernmentAffairsOperatingFrame({ request: templateKey }),
    }),
  ).level;
}

function findingAttribution(
  span: string,
  facts: readonly ExtractedFact[],
): { scope: 'claim'; subjectId: string } | { scope: 'run' } {
  const normalized = String(span ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  if (normalized.length >= 12) {
    const index = facts.findIndex((fact) =>
      fact.fact.toLowerCase().includes(normalized.slice(0, Math.min(180, normalized.length))),
    );
    if (index >= 0) return { scope: 'claim', subjectId: `fact-${index}` };
  }
  return { scope: 'run' };
}
