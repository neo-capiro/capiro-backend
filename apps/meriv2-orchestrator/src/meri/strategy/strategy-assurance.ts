import {
  buildAssuredClaimLedger,
  evaluateAssuranceRelease,
  inferClaimCategories,
  planGovernmentAffairsEvidence,
  resolveGovernmentAffairsOperatingFrame,
  runGovernmentAffairsChecks,
  type AssuredEvidence,
  type ClaimCandidate,
} from '@capiro/meriv2-core';
import type { DocumentDraftSection } from './strategy-prompt.js';
import type { PackHealth, PackProvenance } from './strategy-context-pack.service.js';

/**
 * CLAIM-LEVEL assurance for a Strategy-generated deliverable.
 *
 * api-strategy already runs `assessGeneratedDocumentForRelease`, but that check is
 * purely STRUCTURAL — model identified, sections non-empty, context health ok,
 * every section carries a provenance entry. A well-formed document full of
 * fabricated dollar figures passes it, because it never asks whether the cited
 * provenance actually resolves to a section the context pack loaded, and never
 * looks at what the section CLAIMS.
 *
 * This closes that from the orchestrator side, which is the only side that can:
 * apps/api-strategy deliberately has NO @capiro/meriv2-core dependency (see the
 * locally-parsed `generationReleaseHoldEnforced`), so the claim ledger cannot run
 * there. The orchestrator therefore DECIDES and reports; api-strategy ENFORCES.
 *
 * Pure — no environment read, no DI. The caller owns the dark switch.
 */

/** The additive wire field api-strategy reads. */
export interface DocumentDraftAssurance {
  /**
   * TRUE only when the orchestrator is armed for the strategy surface AND the
   * claim ledger blocked. api-strategy treats this as a release blocker (behind
   * its own MERI_RELEASE_GATE=enforce), so leaving it false keeps the previous
   * behaviour exactly.
   */
  held: boolean;
  /** Always populated, armed or not, so the hold can be observed before arming. */
  blockers: string[];
  decision: string;
  /** Section headings whose cited provenance does not resolve to a loaded pack section. */
  unresolvedProvenanceSections: string[];
  ledgerHash: string;
}

function plainText(html: string): string {
  return String(html ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The closed set of things a section may cite: the pack sections that ACTUALLY
 * loaded. `provenance.omitted` is deliberately excluded — an omitted section is
 * one the model never saw, so citing it is a fabricated provenance entry, which
 * is exactly the case the structural check waves through.
 */
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
  /** Caller has already read the dark switch. */
  armed: boolean;
}): DocumentDraftAssurance {
  const evidence = packEvidence(input.provenance);
  const known = new Set(evidence.map((item) => item.id));
  const unresolvedProvenanceSections: string[] = [];

  const candidates: ClaimCandidate[] = input.sections.map((section, index) => {
    const text = plainText(section.html);
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
  // An outreach_record leaves the firm; a workspace_draft is a client
  // deliverable. Both classify as external via risk-gate.ts, so both buffer.
  const surface = input.kind === 'outreach_record' ? 'outreach' : 'strategy';
  const plan = planGovernmentAffairsEvidence({ request, frame, surface });
  const ledger = buildAssuredClaimLedger(candidates, evidence, { plan });
  const gate = evaluateAssuranceRelease({
    surface,
    plan,
    ledger,
    findings: runGovernmentAffairsChecks({ ledger, facts: [] }),
    // Degraded/conflicted context health means the pre-release basis itself is
    // incomplete — the same signal api-strategy's structural check uses, applied
    // to the claim decision rather than only to the shape.
    verificationAvailable: (input.health?.status ?? 'ok') === 'ok',
  });

  const blockers = [...gate.blockers];
  for (const heading of unresolvedProvenanceSections) {
    blockers.push(
      `Section "${heading}" cites client-context provenance that the compiled context pack did not load.`,
    );
  }
  const blocked = gate.decision === 'hold' || gate.decision === 'repair' || blockers.length > 0;
  return {
    // Reporting is unconditional; HOLDING is not.
    held: input.armed && blocked,
    blockers: [...new Set(blockers)],
    decision: gate.decision,
    unresolvedProvenanceSections: [...new Set(unresolvedProvenanceSections)],
    ledgerHash: ledger.hash,
  };
}
