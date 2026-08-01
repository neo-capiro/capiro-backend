import {
  buildAssuranceEnvelope,
  buildAssuredClaimLedger,
  evaluateAssuranceRelease,
  inferClaimCategories,
  planGovernmentAffairsEvidence,
  resolveGovernmentAffairsOperatingFrame,
  runGovernmentAffairsChecks,
  type AssuranceEnvelope,
  type AssurancePolicyBinding,
  type AssuranceRolloutMode,
  type AssuredEvidence,
  type ClaimCandidate,
} from '@capiro/meriv2-core';
import type { DocumentDraftSection } from './strategy-prompt.js';
import type { PackHealth, PackProvenance } from './strategy-context-pack.service.js';

/** The additive wire field api-strategy reads. */
export interface DocumentDraftAssurance {
  /** True only in enforce mode when the server-owned envelope blocks release. */
  held: boolean;
  /** Always populated, armed or not, so shadow can be observed before enforcement. */
  blockers: string[];
  decision: string;
  unresolvedProvenanceSections: string[];
  ledgerHash: string;
  envelope: AssuranceEnvelope;
}

function plainText(html: string): string {
  return String(html ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function packEvidence(provenance: PackProvenance | undefined): AssuredEvidence[] {
  return (provenance?.sections ?? [])
    .filter((section) => section.name && section.count > 0)
    .map((section) => ({
      id: `pack:${section.name}`,
      sourceType: 'strategy_context_pack',
      sourceId: section.name,
      evidenceClass: 'client_approved_context' as const,
      title: section.name,
      primary: true,
      authoritative: true,
      requirementIds: [],
      coverage: {
        description: `Context pack section "${section.name}" (${section.count} item(s)); result-set completeness not established.`,
        complete: false,
        truncated: false,
        failedSources: [],
      },
    }));
}

export function assessStrategyDocumentClaims(input: {
  sections: readonly DocumentDraftSection[];
  provenance?: PackProvenance;
  health?: PackHealth;
  kind: 'workspace_draft' | 'outreach_record';
  goal?: string | null;
  clientId?: string;
  contextPacketId?: string | null;
  policyBinding?: AssurancePolicyBinding | null;
  generatedAt?: string | Date;
  /** Phase 16 effective mode. */
  mode?: AssuranceRolloutMode;
  /** Backward-compatible pre-Phase-16 call shape. */
  armed?: boolean;
}): DocumentDraftAssurance {
  const evidence = packEvidence(input.provenance);
  const known = new Set(evidence.map((item) => item.id));
  const unresolvedProvenanceSections: string[] = [];
  const sectionText = new Map<string, string>();

  const candidates: ClaimCandidate[] = input.sections.map((section, index) => {
    const text = plainText(section.html);
    sectionText.set(`section-${index + 1}`, text);
    const sourceIds = (section.sources ?? []).map((source) => `pack:${source.section}`);
    if (sourceIds.length && !sourceIds.some((id) => known.has(id))) {
      unresolvedProvenanceSections.push(section.heading);
    }
    return {
      id: `section-${index + 1}`,
      text: text || section.heading,
      type: 'fact',
      category: inferClaimCategories(text)[0] ?? 'general_background',
      sourceIds,
    };
  });

  const request = [
    input.kind,
    input.goal ?? '',
    ...input.sections.map((section) => `${section.heading} ${plainText(section.html)}`),
  ]
    .join('\n')
    .slice(0, 12_000);
  const frame = resolveGovernmentAffairsOperatingFrame({
    request,
    ...(input.clientId ? { explicit: { clientId: input.clientId } } : {}),
  });
  const surface = input.kind === 'outreach_record' ? 'outreach' : 'strategy';
  const plan = planGovernmentAffairsEvidence({ request, frame, surface });
  const ledger = buildAssuredClaimLedger(candidates, evidence, { plan });
  const findings = runGovernmentAffairsChecks({ ledger, facts: [] });
  const gate = evaluateAssuranceRelease({
    surface,
    plan,
    ledger,
    findings,
    verificationAvailable: (input.health?.status ?? 'ok') === 'ok',
  });

  const blockers = [...gate.blockers];
  for (const heading of unresolvedProvenanceSections) {
    blockers.push(
      `Section "${heading}" cites client-context provenance that the compiled context pack did not load.`,
    );
  }
  const effectiveGate = blockers.length === gate.blockers.length ? gate : { ...gate, blockers };
  const mode: AssuranceRolloutMode = input.mode ?? (input.armed ? 'enforce' : 'off');
  const envelope = buildAssuranceEnvelope({
    surface,
    operatingFrame: frame,
    evidencePlan: plan,
    claimLedger: ledger,
    gate: effectiveGate,
    contextPacketId: input.contextPacketId ?? null,
    policyBinding: input.policyBinding ?? null,
    generatedAt: input.generatedAt,
    findings: findings.map((finding) => ({
      ...finding,
      attribution: attributionForFinding(finding.span, input.sections),
    })),
  });
  const blocked = gate.decision === 'hold' || gate.decision === 'repair' || blockers.length > 0;
  return {
    held: mode === 'enforce' && blocked,
    blockers: [...new Set(blockers)],
    decision: gate.decision,
    unresolvedProvenanceSections: [...new Set(unresolvedProvenanceSections)],
    ledgerHash: ledger.hash,
    envelope,
  };
}

function attributionForFinding(
  span: string,
  sections: readonly DocumentDraftSection[],
): { scope: 'section'; subjectId: string } | { scope: 'run' } {
  const normalized = String(span ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  if (normalized.length >= 12) {
    const match = sections.find((section) =>
      plainText(section.html)
        .toLowerCase()
        .includes(normalized.slice(0, Math.min(180, normalized.length))),
    );
    if (match) return { scope: 'section', subjectId: match.heading };
  }
  return { scope: 'run' };
}
