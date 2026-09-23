import type { MeriCitation } from '@capiro/shared';
import {
  JEV_TASK_REGISTRY_VERSION,
  MATCH_LABEL_DISPLAY,
  deriveMatchLabel,
  establishedRelationshipSentence,
  extractMatchFindings,
  type AssuredEvidence,
  type DerivedMatchLabel,
  type MatchLabel,
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
  evaluate?: (input: {
    findingText: string;
    evidence: AssuredEvidence[];
    citations: MeriCitation[];
  }) => Promise<MatchLabelEvaluation>;
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
  if (!derived.downgraded) return reply;
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
        eligibility: { mandatoryRequirementsKnown: false, mandatoryRequirementsSatisfied: true },
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
  for (const item of result.derived) {
    labels[item.label] = (labels[item.label] ?? 0) + 1;
    for (const reason of item.reasons) reasons[reason] = (reasons[reason] ?? 0) + 1;
  }
  return {
    findings: result.findings,
    assertedTiers: result.assertedTiers,
    derivedLabels: labels,
    downgraded: result.derived.filter((item) => item.downgraded).length,
    reasonCounts: reasons,
    jevUsed: result.jevUsed,
    latencyMs,
    registryVersion: JEV_TASK_REGISTRY_VERSION,
    failureReason: result.failureReason,
  };
}
