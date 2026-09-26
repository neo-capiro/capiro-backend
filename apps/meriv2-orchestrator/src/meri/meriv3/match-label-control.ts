import type { MeriCitation } from '@capiro/shared';
import {
  JEV_TASK_REGISTRY_VERSION,
  MATCH_LABEL_DISPLAY,
  buildClientFitQuestion,
  deriveMatchLabel,
  establishedRelationshipSentence,
  extractMatchFindings,
  type AssuredEvidence,
  type ClientFitProvider,
  type DerivedMatchLabel,
  type EvidenceEnvelope,
  type MatchLabel,
  type MatchEligibility,
} from '@capiro/meriv2-core';

export interface MatchLabelEvaluation {
  category: MatchLabel | null;
  confidence: number | null;
  jevUsed: boolean;
}

export interface MatchLabelControlInput {
  mode: 'off' | 'shadow' | 'enforce';
  reply: string;
  citations: readonly MeriCitation[];
  evidence: readonly AssuredEvidence[];
  eligibility?: MatchEligibility;
  evaluate?: (input: {
    findingText: string;
    evidence: AssuredEvidence[];
    citations: MeriCitation[];
  }) => Promise<MatchLabelEvaluation>;
}

export interface ClientFitEvaluatorInput {
  provider: ClientFitProvider;
  tenantId: string;
  clientId?: string | null;
  deadlineAt: number;
  signal?: AbortSignal;
}

export function createClientFitEvaluator(input: ClientFitEvaluatorInput): NonNullable<MatchLabelControlInput['evaluate']> {
  return async ({ findingText, evidence, citations }) => {
    const citationById = new Map(citations.flatMap((citation) =>
      [citation.id, citation.stableId].filter(Boolean).map((id) => [id as string, citation] as const)));
    const envelope: EvidenceEnvelope = {
      envelopeVersion: 'meri-evidence-envelope-v1',
      claimId: `client-fit-${evidence.map((item) => item.id).sort().join('-') || 'unresolved'}`,
      claimText: findingText,
      claimKind: 'recommendation',
      claimCategory: 'client_fit',
      tenantId: input.tenantId,
      clientId: input.clientId ?? null,
      scopeQualifiers: [],
      asOf: null,
      sources: evidence.map((item) => {
        const citation = citationById.get(item.id) ?? citationById.get(item.sourceId);
        return {
          evidenceId: item.id, sourceType: item.sourceType, sourceId: item.sourceId,
          documentId: citation?.documentEvidence?.documentId ?? null,
          version: citation?.source?.version ?? null,
          locator: citation?.source?.section ?? null,
          passage: citation?.snippet ?? '', sourceDate: item.asOf ?? null,
          publishedAt: item.publishedAt ?? null, effectiveAt: item.effectiveAt ?? null,
          retrievedAt: item.retrievedAt ?? citation?.source?.observedAt ?? null,
          provenance: { evidenceClass: item.evidenceClass, primary: item.primary, authoritative: item.authoritative },
        };
      }),
    };
    const question = buildClientFitQuestion(envelope, {
      client: { clientId: input.clientId ?? null },
      opportunity: { citations: citations.map((citation) => citation.n) },
      finding: { text: findingText },
    });
    const decision = await input.provider.assess(envelope, question, {
      deadlineAt: input.deadlineAt,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (decision.kind === 'failure') return { category: null, confidence: null, jevUsed: false };
    return { category: decision.category.value, confidence: decision.category.confidence, jevUsed: true };
  };
}

export interface MatchLabelControlResult {
  reply: string;
  findings: number;
  derived: DerivedMatchLabel[];
  jevUsed: boolean;
  failureReason: string | null;
  assertedTiers: Record<string, number>;
}

function evidenceForFinding(
  refs: readonly number[],
  citations: readonly MeriCitation[],
  evidence: readonly AssuredEvidence[],
): { citations: MeriCitation[]; evidence: AssuredEvidence[] } {
  const cited = citations.filter((citation) => refs.includes(citation.n));
  const ids = new Set(cited.flatMap((citation) => [citation.id, citation.stableId].filter(Boolean) as string[]));
  return {
    citations: cited,
    evidence: evidence.filter((item) => ids.has(item.id) || ids.has(item.sourceId)),
  };
}

function replaceTier(reply: string, findingText: string, asserted: string, derived: DerivedMatchLabel): string {
  if (!derived.downgraded) {
    if (derived.label !== 'explicit_linkage' || derived.eligibility !== 'unknown') return reply;
    const findingAt = reply.indexOf(findingText);
    if (findingAt < 0) return reply;
    const findingEnd = findingAt + findingText.length;
    return `${reply.slice(0, findingEnd)} Eligibility has not been assessed; verify mandatory requirements before pursuing.${reply.slice(findingEnd)}`;
  }
  const display = MATCH_LABEL_DISPLAY[derived.label];
  const findingAt = reply.indexOf(findingText);
  if (findingAt < 0) return reply;
  const prefix = reply.slice(0, findingAt);
  const labelAt = prefix.toLowerCase().lastIndexOf(asserted.toLowerCase());
  if (labelAt < 0) return reply;
  const relabelled = `${reply.slice(0, labelAt)}${display}${reply.slice(labelAt + asserted.length)}`;
  const adjustedFindingAt = findingAt + display.length - asserted.length;
  const findingEnd = adjustedFindingAt + findingText.length;
  return `${relabelled.slice(0, findingEnd)} ${establishedRelationshipSentence(derived)}${relabelled.slice(findingEnd)}`;
}

export async function applyMatchLabelControl(input: MatchLabelControlInput): Promise<MatchLabelControlResult> {
  if (input.mode === 'off') {
    return { reply: input.reply, findings: 0, derived: [], jevUsed: false, failureReason: null, assertedTiers: {} };
  }
  const findings = extractMatchFindings(input.reply);
  if (!findings.length) {
    return { reply: input.reply, findings: 0, derived: [], jevUsed: false, failureReason: null, assertedTiers: {} };
  }
  try {
    let reply = input.reply;
    let jevUsed = false;
    const derived: DerivedMatchLabel[] = [];
    for (const finding of findings) {
      const scoped = evidenceForFinding(finding.citationRefs, input.citations, input.evidence);
      const evaluation = input.evaluate
        ? await input.evaluate({ findingText: finding.findingText, ...scoped })
        : { category: null, confidence: null, jevUsed: false };
      jevUsed ||= evaluation.jevUsed;
      const result = deriveMatchLabel({
        assertedTier: finding.tier,
        jevCategory: evaluation.category,
        jevConfidence: evaluation.confidence,
        evidence: scoped.evidence,
        eligibility: input.eligibility ?? { mandatoryRequirementsKnown: false, mandatoryRequirementsSatisfied: false },
      });
      derived.push(result);
      if (input.mode === 'enforce') {
        const asserted = finding.tier === 'direct_match' ? 'Direct match'
          : finding.tier === 'conditional_niche' ? 'Conditional niche' : 'Adjacency';
        reply = replaceTier(reply, finding.findingText, asserted, result);
      }
    }
    const assertedTiers: Record<string, number> = {};
    for (const finding of findings) assertedTiers[finding.tier] = (assertedTiers[finding.tier] ?? 0) + 1;
    return { reply, findings: findings.length, derived, jevUsed, failureReason: null, assertedTiers };
  } catch (error) {
    return {
      reply: input.reply,
      findings: findings.length,
      derived: [],
      jevUsed: false,
      failureReason: error instanceof Error ? error.name : 'unknown_error',
      assertedTiers: {},
    };
  }
}

export function matchLabelEvent(
  result: MatchLabelControlResult,
  latencyMs: number,
): Record<string, unknown> {
  const labels: Record<string, number> = {};
  const reasons: Record<string, number> = {};
  const eligibility: Record<string, number> = {};
  for (const item of result.derived) {
    labels[item.label] = (labels[item.label] ?? 0) + 1;
    eligibility[item.eligibility] = (eligibility[item.eligibility] ?? 0) + 1;
    for (const reason of item.reasons) reasons[reason] = (reasons[reason] ?? 0) + 1;
  }
  return {
    findings: result.findings,
    assertedTiers: result.assertedTiers,
    derivedLabels: labels,
    eligibilityStatuses: eligibility,
    downgraded: result.derived.filter((item) => item.downgraded).length,
    reasonCounts: reasons,
    jevUsed: result.jevUsed,
    latencyMs,
    registryVersion: JEV_TASK_REGISTRY_VERSION,
    failureReason: result.failureReason,
  };
}
