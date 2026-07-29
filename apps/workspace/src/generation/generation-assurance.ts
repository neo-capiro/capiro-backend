// Imported from the '@capiro/meriv2-core/assurance' SUBPATH (not the package
// barrel) for the same reason generation.service.ts imports the auditor from
// '@capiro/meriv2-core/grounding/auditor': the barrel re-exports the skeptic
// module, which pulls in zod, and zod's internal structure trips the workspace
// jest resolver. Verified: every module under src/assurance imports only
// '@capiro/shared', 'node:crypto', its own siblings, and `import type` from
// ../grounding/auditor — so this subpath keeps zod out of the workspace's
// test-time AND runtime module graph. Adding any zod-using symbol to
// packages/meriv2-core/src/assurance/index.ts would silently break this.
import {
  buildClaimLedgerFromToolResults,
  classifyAssuranceRisk,
  evaluateAssuranceRelease,
  planGovernmentAffairsEvidence,
  resolveGovernmentAffairsOperatingFrame,
  runGovernmentAffairsChecks,
  type AssuranceReleaseDecision,
} from '@capiro/meriv2-core/assurance';
import type { AuditFinding, LedgerEntry } from '@capiro/meriv2-core/grounding/auditor';
import type { PeStructuralWarning } from './domain-grounding.helpers.js';
import type { SectionCitation } from './citations.js';

/**
 * Workspace generation assurance.
 *
 * PROBLEM THIS SOLVES. `generateSectionSetInProcess` computes grounding findings
 * and then persists the generated text unconditionally — the findings are stored
 * ALONGSIDE the content, never consulted (the in-code comment says the auditor
 * decision is "deliberately ignored"). So an unsupported FY27 dollar figure is
 * written into ws_draft.config, snapshotted as an immutable "As generated"
 * WsDocVersion, and surfaced by ChecksService as though verification had run.
 * This module supplies the decision that was missing, BEFORE the write.
 *
 * Pure — no environment read except the one exported switch below, which is a
 * pure parser over a value the caller passes (defaulting to process.env only for
 * ergonomics at the single call site).
 */

/**
 * Master switch for actually WITHHOLDING generated section content. Dark by
 * default.
 *
 * `classifyAssuranceRisk('workspace-gen', …)` buffers EVERY generation, because a
 * Workspace draft is a client-facing artifact — so arming this changes the
 * outcome of ordinary generations, not only bad ones. It therefore ships dark and
 * is armed per environment during the canary.
 *
 * Parsed LOCALLY on purpose, mirroring api-strategy's
 * `generationReleaseHoldEnforced`: importing `resolveAssuranceReleaseSurfaces`
 * would be harmless here (this app already depends on meriv2-core subpaths), but
 * keeping the parse local keeps the withhold decision readable in one file and
 * matches the precedent already set in this monorepo. Keep the accepted format in
 * sync with `resolveAssuranceReleaseSurfaces` in
 * packages/meriv2-core/src/assurance/risk-gate.ts.
 *
 * Format: comma/space separated surface names, or `all`. Unknown tokens are
 * ignored rather than throwing — a typo must never be what arms a withhold.
 * Deliberately NOT `MERI_RELEASE_GATE`: that variable already arms chat's finalize
 * hold and api-strategy's generation hold, and one flip must not arm a third
 * service too.
 */
export function generationClaimHoldEnforced(
  raw: string | undefined = process.env.MERI_RELEASE_GATE_SURFACES,
): boolean {
  const tokens = String(raw ?? '')
    .split(/[,\s]+/)
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length > 0);
  // Exact tokens only. An unrecognized token ('workspacegen', 'true', 'on') is
  // simply not one of these two, so it leaves the hold dark.
  return tokens.includes('all') || tokens.includes('workspace-gen');
}

export interface SectionClaimVerdict {
  section: string;
  decision: AssuranceReleaseDecision;
  /** Must this section's newly generated content be withheld? */
  held: boolean;
  blockers: string[];
  riskLevel: string;
}

export interface GeneratedSectionsAssurance {
  verdicts: SectionClaimVerdict[];
  /** Section names whose content must NOT be persisted. */
  heldSections: string[];
}

/**
 * Evidence a Workspace section may cite, expressed in the shape
 * `buildClaimLedgerFromToolResults` already resolves.
 *
 * The mapping is faithful rather than convenient: a `pe` citation resolves to an
 * AUTHORITATIVE PE record (PeResolverService read it from the database), and a
 * `ctx` citation resolves to a context-packet item (the firm's own system of
 * record). Naming them with the tool families the adapter knows
 * (`get_pe_budget_timeline` / `get_client_context`) is what makes
 * `authoritativeTool` / `primaryTool` / `evidenceClassForTool` classify them
 * correctly instead of defaulting to secondary reporting.
 */
function ledgerFromCitations(citations: readonly SectionCitation[]): {
  entries: LedgerEntry[];
  citationLikes: Array<{ n: number; tool: string; id: string; title?: string }>;
} {
  const byTool = new Map<string, string[]>();
  const citationLikes = citations.map((citation) => {
    const tool = citation.kind === 'pe' ? 'get_pe_budget_timeline' : 'get_client_context';
    const bucket = byTool.get(tool) ?? [];
    // `serialized` must literally contain the refId: the adapter proves a citation
    // resolves by substring-matching the id against what the tool returned.
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
 * Per-section release decision over freshly generated content.
 *
 * PER SECTION on purpose: a run that produced eight good sections and one
 * unsupported budget section should preserve the eight and fail the one, so
 * `failureFor`/`failedMeta` can keep the section's PRIOR content. An all-or-nothing
 * verdict would either discard good work or persist bad work.
 */
export function assessGeneratedSectionsForRelease(input: {
  /** Only the sections this run actually generated — never pre-existing content. */
  generated: ReadonlyArray<{ section: string; html: string }>;
  sectionCitations?: Record<string, SectionCitation[]>;
  /** Run-level findings (citation + auditor) folded into every section's decision. */
  groundingFindings?: readonly AuditFinding[];
  structuralWarnings?: readonly PeStructuralWarning[];
  /**
   * Could the authoritative PE records be loaded at all? False means the
   * deterministic structural pass could not run, which is NOT the same as running
   * and finding nothing — so it must not read as "verified clean".
   */
  peEvidenceAvailable?: boolean;
  /** Draft context used to frame the request (product / industry / ask). */
  requestContext?: string;
  clientId?: string;
}): GeneratedSectionsAssurance {
  const verdicts: SectionClaimVerdict[] = [];
  // Same-turn verification counts as AVAILABLE only when the deterministic
  // structural pass actually ran AND came back clean. A structural PE warning
  // (RDT&E-vs-procurement, mission mismatch) means it ran and did not.
  const verificationAvailable =
    input.peEvidenceAvailable !== false && (input.structuralWarnings ?? []).length === 0;
  const runFindings = [...(input.groundingFindings ?? [])];

  for (const { section, html } of input.generated) {
    const text = stripHtml(html);
    if (!text) {
      verdicts.push({
        section,
        decision: 'deliver',
        held: false,
        blockers: [],
        riskLevel: 'low',
      });
      continue;
    }
    // Frame from the WHOLE draft context (jurisdiction / fiscal year / client are
    // properties of the document, not of one section), but the evidence PLAN from
    // the section's own text — so a background section is never held for failing a
    // budget requirement that only the funding section's text triggered.
    const frame = resolveGovernmentAffairsOperatingFrame({
      request: [input.requestContext ?? '', section, text].filter(Boolean).join('\n'),
      ...(input.clientId ? { explicit: { clientId: input.clientId } } : {}),
    });
    const sectionRequest = `${section}\n${text}`;
    const bare = planGovernmentAffairsEvidence({ request: sectionRequest, frame });
    // `surface: 'workspace-gen'` adds `surface.high-risk-primary-basis`, a REQUIRED
    // requirement that no uncited section can satisfy. Applying it to a section
    // that asserts no factual category at all (a cover page, a signature block,
    // "Prepared for the leadership team") would hold every such section — which
    // would make this gate unusable and therefore never armed, i.e. worse than no
    // gate. So the client-facing upgrade applies exactly where it has something to
    // bite on: a section whose own text asserts a real claim category.
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
    const findings = [
      ...runFindings,
      ...runGovernmentAffairsChecks({ ledger, facts: [], outputText: text }),
    ];
    const gate = evaluateAssuranceRelease({
      surface: 'workspace-gen',
      plan,
      ledger,
      findings,
      verificationAvailable,
    });
    verdicts.push({
      section,
      decision: gate.decision,
      held: gate.decision === 'hold' || gate.decision === 'repair',
      blockers: gate.blockers,
      riskLevel: classifyAssuranceRisk('workspace-gen', plan).level,
    });
  }

  return {
    verdicts,
    heldSections: verdicts.filter((verdict) => verdict.held).map((verdict) => verdict.section),
  };
}
