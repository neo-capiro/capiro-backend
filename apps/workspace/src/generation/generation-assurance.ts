import { AsyncLocalStorage } from 'node:async_hooks';
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
 * Request-local tenant binding for the inherited GenerationService call shape.
 * GenerationService already receives the server-resolved tenant, but its legacy
 * hold helper has no tenant parameter. Controllers enter this context before any
 * generation/apply call; AsyncLocalStorage preserves it across concurrent awaits
 * without process-global mutation or browser-supplied authority.
 */
const generationAssuranceTenant = new AsyncLocalStorage<string>();

export function runWithGenerationAssuranceTenant<T>(tenantId: string, work: () => T): T {
  const normalized = String(tenantId ?? '').trim();
  if (!normalized) throw new Error('Workspace assurance requires a server-resolved tenant id.');
  return generationAssuranceTenant.run(normalized, work);
}

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

/**
 * Backward-compatible call shape for the existing generation service.
 *
 * On a live HTTP path, GenerationController establishes a request-local,
 * server-resolved tenant and this helper applies the exact tenant/surface canary.
 * Direct legacy/unit callers with no request context can enforce only through an
 * explicit `all`-tenant canary, preserving the prior fail-closed behavior.
 */
export function generationClaimHoldEnforced(
  raw: string | undefined = process.env.MERI_RELEASE_GATE_SURFACES,
  globalModeRaw: string | undefined = process.env.MERI_RELEASE_GATE,
  tenantCanariesRaw: string | undefined = process.env.MERI_RELEASE_GATE_TENANTS,
): boolean {
  const tenantId = generationAssuranceTenant.getStore();
  return (
    resolveAssuranceRolloutMode({
      globalModeRaw,
      tenantCanariesRaw,
      surfacesRaw: raw,
      tenantId: tenantId ?? '__workspace_global__',
      surface: 'workspace-gen',
    }) === 'enforce'
  );
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
 * outage may still affect every section; one section's bad figure cannot hold its
 * siblings.
 */
export function assessGeneratedSectionsForRelease(input: {
  generated: ReadonlyArray<{ section: string; html: string }>;
  sectionCitations?: Record<string, SectionCitation[]>;
  /** Unscoped legacy input. The adapter attributes spans/details where possible. */
  groundingFindings?: readonly AuditFinding[];
  sectionGroundingFindings?: Record<string, AuditFinding[]>;
  /** Unscoped legacy input. The adapter attributes warning semantics where possible. */
  structuralWarnings?: readonly PeStructuralWarning[];
  sectionStructuralWarnings?: Record<string, PeStructuralWarning[]>;
  peEvidenceAvailable?: boolean;
  requestContext?: string;
  clientId?: string;
  contextPacketId?: string | null;
  policyBinding?: AssurancePolicyBinding | null;
  generatedAt?: string | Date;
}): GeneratedSectionsAssurance {
  const verdicts: SectionClaimVerdict[] = [];
  const generatedText = new Map(
    input.generated.map(({ section, html }) => [section, stripHtml(html)] as const),
  );
  const legacyFindings = [...(input.groundingFindings ?? [])];
  const legacyStructural = [...(input.structuralWarnings ?? [])];
  const attributedFindingSections = new Map<AuditFinding, Set<string>>();
  for (const finding of legacyFindings) {
    const matches = new Set<string>();
    for (const [candidateSection, candidateText] of generatedText) {
      if (findingBelongsToSection(finding, candidateSection, candidateText)) {
        matches.add(candidateSection);
      }
    }
    attributedFindingSections.set(finding, matches);
  }
  const attributedStructuralSections = new Map<PeStructuralWarning, Set<string>>();
  for (const warning of legacyStructural) {
    const matches = new Set<string>();
    for (const [candidateSection, candidateText] of generatedText) {
      if (structuralWarningBelongsToSection(warning, candidateText)) {
        matches.add(candidateSection);
      }
    }
    attributedStructuralSections.set(warning, matches);
  }

  for (const { section } of input.generated) {
    const text = generatedText.get(section) ?? '';
    const runFindings = legacyFindings.filter(
      (finding) => (attributedFindingSections.get(finding)?.size ?? 0) === 0,
    );
    const inferredSectionFindings = legacyFindings.filter((finding) =>
      attributedFindingSections.get(finding)?.has(section),
    );
    const sectionFindings = [
      ...inferredSectionFindings,
      ...(input.sectionGroundingFindings?.[section] ?? []),
    ];
    const runStructural = legacyStructural.filter(
      (warning) => (attributedStructuralSections.get(warning)?.size ?? 0) === 0,
    );
    const inferredSectionStructural = legacyStructural.filter((warning) =>
      attributedStructuralSections.get(warning)?.has(section),
    );
    const sectionStructural = [
      ...inferredSectionStructural,
      ...(input.sectionStructuralWarnings?.[section] ?? []),
    ];

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
      input.peEvidenceAvailable !== false &&
      runStructural.length === 0 &&
      sectionStructural.length === 0;
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

function findingBelongsToSection(
  finding: AuditFinding,
  section: string,
  sectionText: string,
): boolean {
  const normalizedText = sectionText.toLowerCase();
  const span = String(finding.span ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  if (span.length >= 12 && normalizedText.includes(span.slice(0, Math.min(span.length, 180)))) {
    return true;
  }
  const quotedSection = `section "${section.toLowerCase()}"`;
  return finding.detail.toLowerCase().includes(quotedSection);
}

function structuralWarningBelongsToSection(
  warning: PeStructuralWarning,
  sectionText: string,
): boolean {
  const text = sectionText.toLowerCase();
  const hasPe = text.includes(warning.peCode.toLowerCase());
  switch (warning.code) {
    case 'rdte_procurement_mismatch':
      return hasPe && /\b(?:directed procurement|procure|buy|production procurement)\b/i.test(text);
    case 'capability_mission_mismatch':
      return (
        hasPe &&
        /\b(?:missile|interceptor|munition|kinetic|warhead|projectile|rocket)\b/i.test(text)
      );
    case 'primary_vehicle_overclaim':
      return hasPe && /\bprimary\b/i.test(text);
    default:
      return hasPe;
  }
}
