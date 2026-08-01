// Imported from the '@capiro/meriv2-core/assurance' SUBPATH (not the package
// barrel) for the same reason generation.service.ts imports the auditor from
// '@capiro/meriv2-core/grounding/auditor': the barrel re-exports the skeptic
// module, which pulls in zod, and zod's internal structure trips the workspace
// jest resolver.
import {
  buildAssuranceEnvelope,
  buildClaimLedgerFromToolResults,
  classifyAssuranceRisk,
  evaluateAssuranceRelease,
  planGovernmentAffairsEvidence,
  resolveAssuranceRolloutMode,
  resolveGovernmentAffairsOperatingFrame,
  runGovernmentAffairsChecks,
  type AssuranceEnvelope,
  type AssurancePolicyBinding,
  type AssuranceReleaseDecision,
  type AssuranceRolloutMode,
} from '@capiro/meriv2-core/assurance';
import type { AuditFinding, LedgerEntry } from '@capiro/meriv2-core/grounding/auditor';
import type { PeStructuralWarning } from './domain-grounding.helpers.js';
import type { SectionCitation } from './citations.js';

/**
 * Exact Phase 16 rollout. A global mode alone never arms Workspace: the
 * server-resolved tenant and the `workspace-gen` surface must both be selected.
 */
export function generationAssuranceRolloutMode(
  tenantId: string,
  globalModeRaw: string | undefined = process.env.MERI_RELEASE_GATE,
  tenantCanariesRaw: string | undefined = process.env.MERI_RELEASE_GATE_TENANTS,
  surfacesRaw: string | undefined = process.env.MERI_RELEASE_GATE_SURFACES,
): AssuranceRolloutMode {
  return resolveAssuranceRolloutMode({
    globalModeRaw,
    tenantCanariesRaw,
    surfacesRaw,
    tenantId,
    surface: 'workspace-gen',
  });
}

/** Backward-compatible parser retained for focused legacy tests. */
export function generationClaimHoldEnforced(
  raw: string | undefined = process.env.MERI_RELEASE_GATE_SURFACES,
): boolean {
  const tokens = String(raw ?? '')
    .split(/[,\s]+/)
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length > 0);
  return tokens.includes('all') || tokens.includes('workspace-gen');
}

export interface SectionClaimVerdict {
  section: string;
  decision: AssuranceReleaseDecision;
  /** Must this section's newly generated content be withheld in enforce mode? */
  held: boolean;
  blockers: string[];
  riskLevel: string;
  envelope: AssuranceEnvelope;
}

export interface GeneratedSectionsAssurance {
  verdicts: SectionClaimVerdict[];
  /** Section names whose content must NOT be persisted in enforce mode. */
  heldSections: string[];
}

function ledgerFromCitations(citations: readonly SectionCitation[]): {
  entries: LedgerEntry[];
  citationLikes: Array<{ n: number; tool: string; id: string; title?: string }>;
} {
  const byTool = new Map<string, string[]>();
  const citationLikes = citations.map((citation) => {
    const tool = citation.kind === 'pe' ? 'get_pe_budget_timeline' : 'get_client_context';
    const bucket = byTool.get(tool) ?? [];
    bucket.push(`${citation.refId} ${citation.label}`);
    byTool.set(tool, bucket);
    return { n: citation.n, tool, id: citation.refId, title: citation.label };
  });
  const entries: LedgerEntry[] = [...byTool.entries()].map(([tool, lines]) => ({
    tool,
    serialized: lines.join('\n'),
    result: { tool, refs: lines },
  }));
  return { entries, citationLikes };
}

function stripHtml(html: string): string {
  return String(html ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Per-section release decision over freshly generated content. Findings and PE
 * warnings are attributed at their originating section. A genuinely run-wide
 * outage (for example PE evidence unavailable for the complete run) may still
 * affect every section; one section's bad figure cannot hold its siblings.
 */
export function assessGeneratedSectionsForRelease(input: {
  generated: ReadonlyArray<{ section: string; html: string }>;
  sectionCitations?: Record<string, SectionCitation[]>;
  /** Only genuinely run-wide deterministic findings belong here. */
  groundingFindings?: readonly AuditFinding[];
  /** Findings derived from exactly one generated section. */
  sectionGroundingFindings?: Record<string, AuditFinding[]>;
  /** Only genuinely run-wide structural warnings belong here. */
  structuralWarnings?: readonly PeStructuralWarning[];
  /** Structural warnings derived from exactly one generated section. */
  sectionStructuralWarnings?: Record<string, PeStructuralWarning[]>;
  peEvidenceAvailable?: boolean;
  requestContext?: string;
  clientId?: string;
  contextPacketId?: string | null;
  policyBinding?: AssurancePolicyBinding | null;
  generatedAt?: string | Date;
}): GeneratedSectionsAssurance {
  const verdicts: SectionClaimVerdict[] = [];
  const runFindings = [...(input.groundingFindings ?? [])];
  const runStructural = [...(input.structuralWarnings ?? [])];

  for (const { section, html } of input.generated) {
    const text = stripHtml(html);
    const frame = resolveGovernmentAffairsOperatingFrame({
      request: [input.requestContext ?? '', section, text].filter(Boolean).join('\n'),
      ...(input.clientId ? { explicit: { clientId: input.clientId } } : {}),
    });
    const sectionRequest = `${section}\n${text}`;
    const bare = planGovernmentAffairsEvidence({ request: sectionRequest, frame });
    const assertsFactualCategory = bare.requestCategories.some(
      (category) => category !== 'general_background',
    );
    const plan = assertsFactualCategory
      ? planGovernmentAffairsEvidence({
          request: sectionRequest,
          frame,
          surface: 'workspace-gen',
        })
      : bare;
    const { entries, citationLikes } = ledgerFromCitations(input.sectionCitations?.[section] ?? []);
    const ledger = buildClaimLedgerFromToolResults({
      output: text,
      ledgerEntries: entries,
      citations: citationLikes,
      plan,
    });
    const sectionFindings = [...(input.sectionGroundingFindings?.[section] ?? [])];
    const sectionStructural = [...(input.sectionStructuralWarnings?.[section] ?? [])];
    const structuralFindings: AuditFinding[] = [...runStructural, ...sectionStructural].map(
      (warning) => ({
        check: `PE:${warning.code}`,
        severity: 'high',
        span: section,
        detail: warning.message,
      }),
    );
    const domainFindings = runGovernmentAffairsChecks({ ledger, facts: [], outputText: text });
    const findings = [...runFindings, ...sectionFindings, ...structuralFindings, ...domainFindings];
    const verificationAvailable =
      input.peEvidenceAvailable !== false && runStructural.length === 0 && sectionStructural.length === 0;
    const gate = evaluateAssuranceRelease({
      surface: 'workspace-gen',
      plan,
      ledger,
      findings,
      verificationAvailable,
    });
    const envelope = buildAssuranceEnvelope({
      surface: 'workspace-gen',
      operatingFrame: frame,
      evidencePlan: plan,
      claimLedger: ledger,
      gate,
      contextPacketId: input.contextPacketId ?? null,
      policyBinding: input.policyBinding ?? null,
      generatedAt: input.generatedAt,
      findings: [
        ...runFindings.map((finding) => ({
          ...finding,
          attribution: { scope: 'run' as const },
        })),
        ...sectionFindings.map((finding) => ({
          ...finding,
          attribution: { scope: 'section' as const, subjectId: section },
        })),
        ...structuralFindings.map((finding) => ({
          ...finding,
          attribution: { scope: 'section' as const, subjectId: section },
        })),
        ...domainFindings.map((finding) => ({
          ...finding,
          attribution: { scope: 'section' as const, subjectId: section },
        })),
      ],
      defaultAttribution: { scope: 'section', subjectId: section },
    });
    const held = gate.decision === 'hold' || gate.decision === 'repair';
    verdicts.push({
      section,
      decision: gate.decision,
      held,
      blockers: gate.blockers,
      riskLevel: classifyAssuranceRisk('workspace-gen', plan).level,
      envelope,
    });
  }

  return {
    verdicts,
    heldSections: verdicts.filter((verdict) => verdict.held).map((verdict) => verdict.section),
  };
}
