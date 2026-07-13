import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { MeriV2FlagsService } from '../meriv2/meriv2-flags.service.js';
import { MeriV2OrchestratorClient } from '../meriv2/meriv2-orchestrator.client.js';
import { AiCredentialService } from './ai-credential.service.js';
import { PeResolverService, type AuthoritativePeRecord } from './pe-resolver.service.js';
import { anonymizeText, type AnonymizeMap } from './anonymize.js';
import { WSC } from '../cascade/cascade.config.js';
import {
  DOMAIN_PRIMER,
  collectPeStructuralWarnings,
  extractCitedPeCodes,
  type PeRecordForValidation,
  type PeStructuralWarning,
} from './domain-grounding.helpers.js';
// Import the deterministic auditor + evidence types from their SUBPATHS (not the
// package barrel): the barrel re-exports the skeptic module, which pulls in zod —
// and zod's internal structure trips the workspace jest resolver. auditor.ts and
// evidence.ts depend only on @capiro/shared, so these subpaths keep zod entirely
// out of the workspace's test-time AND runtime module graph.
import {
  runAuditor,
  type ToolResultLedger,
  type LedgerEntry,
} from '@capiro/meriv2-core/grounding/auditor';
import type { FundingYearRecord } from '@capiro/meriv2-core/grounding/evidence';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const GENERATION_TIMEOUT_MS = 120_000;
const MAX_TOKENS = 4096;

/**
 * "Context used in this draft" provenance (Phase 3.3). Records — at generation
 * time — exactly which grounding sources actually fed the model, so a reviewer
 * can see what a draft was built from. As-of-last-generation (not "currently
 * attached"): it's a snapshot captured when the text was written, persisted into
 * ws_draft.config.contextProvenance and replaced on every regeneration.
 */
export interface ContextUsedItem {
  id: string;
  kind: string;
  label: string;
}
export interface ContextUsedMemoryFile {
  id: string;
  type: string;
  slug: string;
  label: string;
}
export interface ContextProvenance {
  generatedAt: string;
  contextItems: ContextUsedItem[];
  memoryFiles: ContextUsedMemoryFile[];
  linkedPeCodes: string[];
}

export interface GenerateSectionResult {
  section: string;
  content: string;
  model: string;
  usedTenantKey: boolean;
  anonymized: boolean;
  legend?: AnonymizeMap['legend'];
  /** What actually grounded this section (Phase 3.3); identical across a
   *  generate-all run since every section shares the same draft context. */
  provenance: ContextProvenance;
}

/**
 * A claim-level grounding finding (Phase 3.1) from the SHARED Phase 2 auditor
 * (`runAuditor` in @capiro/meriv2-core) run post-hoc over generated document
 * sections — the SAME deterministic checks that guard chat/outreach/alert-memo
 * (reversed funding direction, authorization↔appropriation conflation, a
 * procurement line called a "PE", etc.), not a Workspace-specific reimpl. Purely
 * ADVISORY (Ninja D1: Workspace is gate-less) — persisted on the draft config
 * and surfaced by ChecksService as ordinary entries in the existing checks list.
 */
export interface GroundingFinding {
  check: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  span: string;
  detail: string;
}

/** Strip HTML tags to plain text for the grounding auditor's sentence scan. */
function stripHtmlToText(html: string): string {
  return String(html ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Meri document generation (Phase 6). Runs Claude Sonnet (tenant-scoped key via
 * AiCredentialService) to draft a section or a whole document, grounded in the
 * draft's setup config + context items. Honors the draft's anonymize flag: the
 * client/office names are stripped from BOTH the prompt and the returned text.
 */
@Injectable()
export class GenerationService {
  private readonly logger = new Logger(GenerationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly creds: AiCredentialService,
    private readonly peResolver: PeResolverService,
    private readonly meriV2Flags: MeriV2FlagsService,
    private readonly meriV2: MeriV2OrchestratorClient,
  ) {}

  async generateSection(
    tenantId: string,
    draftId: string,
    sectionName: string,
    authoritativePes?: AuthoritativePeRecord[],
  ): Promise<GenerateSectionResult> {
    const draft = await this.prisma.wsDraft.findFirst({
      where: { id: draftId, tenantId },
      include: { context: true },
    });
    if (!draft) throw new ServiceUnavailableException('Draft not found');

    const cred = await this.creds.resolveAnthropic(tenantId);
    if (!cred) {
      throw new ServiceUnavailableException(
        'No Anthropic credential available (tenant or global). Configure an AI key.',
      );
    }

    const cfg = draft.config as Record<string, unknown>;
    const anonymize = Boolean(cfg.anonymize);
    const client = (cfg.client as string | null) ?? draft.client;
    const offices = (cfg.offices as string[] | undefined) ?? [];

    // Per-item + total caps so a large/numerous context set (esp. extracted
    // document bodies) can't blow the model's input-context budget — server-side
    // defense-in-depth on top of the Context Builder's per-document clamp.
    const PER_ITEM_CAP = 8000;
    const TOTAL_CONTEXT_CAP = 24000;

    const itemText = (draft.context ?? [])
      .map((c) => {
        const p = c.payload as Record<string, unknown>;
        // Prefer the rich grounding body (payload.text — set by the Context
        // Builder for client data, documents, bills, preps, news); fall back to
        // the short label for older/source items. Without this, added news +
        // documents contribute nothing to generation (they carry no `label`).
        return String(p.text ?? p.label ?? '').slice(0, PER_ITEM_CAP);
      })
      .filter(Boolean);

    // Phase 3.3 provenance: the context items that ACTUALLY contributed a
    // non-empty body (same non-empty filter as itemText above), so the "context
    // used" panel never lists an attached-but-empty item as having grounded text.
    const usedContextItems: ContextUsedItem[] = (draft.context ?? [])
      .filter((c) => {
        const p = c.payload as Record<string, unknown>;
        return String(p.text ?? p.label ?? '').trim().length > 0;
      })
      .map((c) => {
        const p = c.payload as Record<string, unknown>;
        const label =
          String(p.label ?? '').trim() ||
          String(p.text ?? '')
            .trim()
            .slice(0, 80) ||
          c.kind;
        return { id: c.id, kind: c.kind, label };
      });

    // Linked program elements (Setup → Links & data). RETRIEVE-BEFORE-WRITE:
    // prefer the AUTHORITATIVE PE record re-resolved from the DB (real mission,
    // appropriation type, budget activity, budget figures) over whatever thin
    // context was attached in the Context Builder — parity with how the in-editor
    // Meri assistant retrieves PE detail before drafting. Resolve here when the
    // caller (single-section path) didn't pre-resolve; generate-all resolves once
    // and passes the records down to avoid N duplicate lookups.
    const linkedPes =
      (cfg.linkedProgramElements as
        | Array<{ peCode?: string; title?: string; context?: string }>
        | undefined) ?? [];
    const authPes =
      authoritativePes ?? (await this.peResolver.resolve(linkedPes.map((pe) => pe.peCode)));
    const authByCode = new Map(authPes.map((r) => [r.peCode.toUpperCase(), r]));

    const peText = linkedPes
      .map((pe) => {
        const code = (pe.peCode ?? '').toUpperCase();
        const auth = code ? authByCode.get(code) : undefined;
        // Authoritative DB record wins; fall back to the attached context only
        // when the PE couldn't be resolved (e.g. not yet ingested).
        if (auth) return this.peResolver.groundingText(auth).slice(0, PER_ITEM_CAP);
        const head = [pe.peCode, pe.title].filter(Boolean).join(' — ');
        return [head, pe.context].filter(Boolean).join('\n').slice(0, PER_ITEM_CAP);
      })
      .filter(Boolean);

    const contextText = [...itemText, ...peText]
      .filter(Boolean)
      .join('\n- ')
      .slice(0, TOTAL_CONTEXT_CAP);

    // Honor the Setup "Length target" (cfg.pages): buildSectionPrompt scales
    // section length by the ratio of requested pages to the product's suggested
    // pages. Falls back to the suggested length, so an untouched draft (where
    // cfg.pages was seeded from the suggestion) generates exactly as before.
    const product = draft.product ?? 'document';
    const suggestedPages = WSC.suggestedPages(product);
    const targetPages = Number(cfg.pages) > 0 ? Number(cfg.pages) : suggestedPages;

    const steering = await this.loadSteeringMemories(tenantId, draft.ownerId);

    const prompt = this.buildSectionPrompt({
      product,
      docTitle: draft.docTitle,
      industry: draft.industry,
      section: sectionName,
      tone: String(cfg.tone ?? 'Formal'),
      toneContext: String(cfg.toneContext ?? ''),
      committees: (cfg.committees as string[] | undefined) ?? [],
      context: contextText,
      client: anonymize ? null : client,
      targetPages,
      suggestedPages,
      firmContext: steering.firmContext,
      userVoiceContext: steering.userVoiceContext,
    });

    // Strip client/office names from the prompt when anonymizing.
    const finalPrompt = anonymize ? anonymizeText(prompt, { client, offices }).text : prompt;

    const raw = await this.callAnthropic(cred.secret, cred.model, finalPrompt);

    // Strip any client/office names the model may have echoed back.
    const result = anonymize
      ? anonymizeText(raw, { client, offices })
      : { text: raw, map: { legend: {} } };

    const provenance: ContextProvenance = {
      generatedAt: new Date().toISOString(),
      contextItems: usedContextItems,
      memoryFiles: steering.memoryFiles,
      linkedPeCodes: linkedPes
        .map((pe) => (pe.peCode ?? '').toUpperCase())
        .filter((c): c is string => c.length > 0),
    };

    return {
      section: sectionName,
      content: result.text,
      model: cred.model,
      usedTenantKey: cred.usedTenantKey,
      anonymized: anonymize,
      legend: anonymize ? result.map.legend : undefined,
      provenance,
    };
  }

  /**
   * "Context used in this draft" (Phase 3.3): the provenance snapshot captured
   * at the last generation — which context items, memory files, and linked PEs
   * actually grounded the draft. Returns null when the draft has never been
   * generated (or predates provenance capture). Tenant-scoped.
   */
  async getContextUsed(tenantId: string, draftId: string): Promise<ContextProvenance | null> {
    const draft = await this.prisma.wsDraft.findFirst({
      where: { id: draftId, tenantId },
      select: { config: true },
    });
    if (!draft) throw new ServiceUnavailableException('Draft not found');
    const cfg = (draft.config as Record<string, unknown>) ?? {};
    const p = cfg.contextProvenance;
    if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
    const prov = p as Partial<ContextProvenance>;
    // Defensive shape-normalize (old rows / partial writes never crash the panel).
    return {
      generatedAt: typeof prov.generatedAt === 'string' ? prov.generatedAt : '',
      contextItems: Array.isArray(prov.contextItems) ? prov.contextItems : [],
      memoryFiles: Array.isArray(prov.memoryFiles) ? prov.memoryFiles : [],
      linkedPeCodes: Array.isArray(prov.linkedPeCodes) ? prov.linkedPeCodes : [],
    };
  }

  /**
   * Claim-level grounding audit (Phase 3.1): run the SHARED Phase 2 deterministic
   * auditor over the freshly generated document text, grounded in a ToolResultLedger
   * synthesized from the draft's AUTHORITATIVE linked-PE records (the same records
   * that fed generation). Reuses `runAuditor` from @capiro/meriv2-core rather than
   * building a third citation/grounding system — so the funding-direction /
   * vehicle-conflation / LI-as-PE classes that shipped as client incidents on
   * outreach + alert-memo are caught in Workspace's budget-justification / NDAA
   * products too. Pure + best-effort: ADVISORY only (never blocks — Ninja D1), and
   * any error yields zero findings rather than failing generation. `surface:'memo'`
   * — Workspace deliverables are the same "memo/briefing" shape the grounding
   * prompt already models.
   */
  private runGroundingAuditor(
    sectionContent: Record<string, string>,
    authPes: AuthoritativePeRecord[],
  ): GroundingFinding[] {
    try {
      const text = Object.values(sectionContent)
        .map((html) => stripHtmlToText(html))
        .filter(Boolean)
        .join('\n\n');
      if (!text.trim()) return [];

      // One get_pe_budget_timeline-shaped ledger entry per linked PE, built from
      // the authoritative record (request + HASC/SASC + enacted marks; the
      // appropriations marks aren't in Workspace's PE view, so they stay null and
      // the stage-aware checks simply use the furthest-along mark present).
      const entries: LedgerEntry[] = authPes.map((pe) => {
        const years: FundingYearRecord[] = pe.years.map((y) => ({
          fy: y.fy,
          request: y.request,
          hascMark: y.hascMark,
          sascMark: y.sascMark,
          enacted: y.enacted,
        }));
        const result = {
          peCode: pe.peCode,
          years,
          identifierKind: 'pe' as const,
          generatedAt: new Date().toISOString(),
        };
        return {
          tool: 'get_pe_budget_timeline',
          serialized: JSON.stringify(result),
          result,
        };
      });

      const verdict = runAuditor({
        output: text,
        ledger: { entries } as ToolResultLedger,
        surface: 'memo',
        // shadow: compute findings, never alter/act — Workspace is gate-less, the
        // findings ride the advisory checks list.
        mode: 'shadow',
      });
      return verdict.findings.map((f) => ({
        check: f.check,
        severity: f.severity,
        span: f.span.slice(0, 240),
        detail: f.detail,
      }));
    } catch (e) {
      this.logger.warn(`grounding audit failed (non-fatal): ${(e as Error).message}`);
      return [];
    }
  }

  /**
   * "Start with Meri" intake (handoff Q-LIB-3). Resolves a free-text prompt to a
   * work product + cascade, creates the draft, and auto-drafts every section.
   * The product is chosen from the canonical catalog only; pathways/committees
   * are DERIVED from the cascade (never trusted from the model). Section drafting
   * is best-effort + concurrent — a failed section is left empty for the editor.
   * Returns the drafted draft to open directly in the editor.
   */
  async meriIntake(tenantId: string, ownerId: string, prompt: string, clientHint?: string) {
    const cred = await this.creds.resolveAnthropic(tenantId);
    if (!cred) {
      throw new ServiceUnavailableException(
        'No Anthropic credential available (tenant or global). Configure an AI key.',
      );
    }

    const industries = WSC.industries();
    const products = WSC.allLibraryProducts();
    const resolvePrompt = [
      'You are Meri, a government-affairs intake assistant. A lobbyist described a document they need.',
      'Map it to exactly one work product and its setup. Respond with ONLY a JSON object — no prose, no code fences.',
      '',
      `Request: "${prompt}"`,
      clientHint ? `Known client: ${clientHint}` : '',
      '',
      `"product" MUST be exactly one of: ${products.join(' | ')}.`,
      `"industry" MUST be exactly one of: ${industries.join(' | ')}.`,
      'JSON shape: {"product": string, "industry": string, "client": string|null, ' +
        '"docTitle": string (<=80 chars, specific to the request), ' +
        '"confidence": "high"|"medium"|"low", "notes": string (one line naming any low-confidence guesses)}.',
    ]
      .filter(Boolean)
      .join('\n');

    const raw = await this.callAnthropic(cred.secret, cred.model, resolvePrompt);
    const parsed = this.parseIntakeJson(raw, products, industries);

    const product = parsed.product;
    const industry = parsed.industry;
    const client = clientHint || parsed.client || null;
    const meta = WSC.meta(product);
    const pathways = WSC.pathwaysFor(industry, product);
    const committees = WSC.committeesFor(industry, pathways);
    const sections = WSC.suggestedSections(product);
    const pages = WSC.suggestedPages(product);
    const funding = WSC.isFunding(product);

    const config: Record<string, unknown> = {
      industry,
      product,
      client,
      pathways,
      committees,
      personalize: meta.personalize,
      // Office/client personalization always defaults to "No" — opt-in per draft.
      officeAssociated: false,
      offices: [],
      clientAssociated: false,
      clientPersons: [],
      coverLetter: meta.cover,
      selectedTemplate: null,
      sections,
      pages,
      tone: 'Formal',
      toneContext: '',
      // Program-element context is attached via the Setup "Links & data" PE
      // search (cfg.linkedProgramElements), not the legacy industry-data labels.
      linkedData: [],
      anonymize: false,
      letterhead: { custom: false, firmName: '', firmAddr: '' },
      // Provenance for the editor: flag low-confidence guesses for review.
      meriOrigin: { prompt, confidence: parsed.confidence, notes: parsed.notes },
    };

    const draft = await this.prisma.wsDraft.create({
      data: {
        tenantId,
        ownerId,
        docTitle: parsed.docTitle || `${product} draft`,
        industry,
        product,
        client,
        config: config as never,
        ask: funding ? { amount: '', pb: '', delta: '' } : 'n/a',
        isPacket: meta.cover,
        docCount: 1,
      },
    });
    await this.prisma.wsDocument.create({
      data: { tenantId, draftId: draft.id, name: product, ordinal: 0, body: { blocks: [] } },
    });

    // NOTE: intake intentionally does NOT draft section content here. Generation
    // happens AFTER the user reviews Setup + the Context Builder (so Meri grounds
    // the draft in the chosen context, not an empty plan) — the Context Builder's
    // "Open editor" calls generateAllSections. Intake just resolves the product,
    // seeds the section names + config, and returns the draft for that flow.
    return this.prisma.wsDraft.findFirst({
      where: { id: draft.id, tenantId },
      include: { documents: { orderBy: { ordinal: 'asc' } } },
    });
  }

  /**
   * Draft EVERY section of the document concurrently (best-effort), grounded in
   * the draft config + Context Builder plan, and persist the results. Used after
   * the Context Builder ("Open editor") and by the editor's "Regenerate All".
   * Overwrites existing section content (callers gate when that is appropriate).
   */
  async generateAllSections(tenantId: string, draftId: string, opts?: { bearerToken?: string }) {
    // P0-T4 dormant proxy: when meriv2.workspaceGen is ON (AND the MERIV2_ENABLED
    // env kill-switch is set) proxy full-document generation to the MeriV2
    // orchestrator instead of running in-process below. Both flags default OFF,
    // so this branch is dormant and the existing path (everything below) is
    // byte-for-byte unchanged (SC0.2). `as never` defers to this method's
    // inferred return type (the orchestrator returns the same draft shape by
    // contract); the parity harness (SC0.3) is the gate before enablement.
    if (await this.meriV2Flags.isWorkspaceGenEnabled(tenantId)) {
      return (await this.meriV2.proxyGenerateAllSections(
        tenantId,
        draftId,
        opts?.bearerToken,
      )) as never;
    }
    return this.generateAllSectionsInProcess(tenantId, draftId);
  }

  /**
   * The in-process generate-all body (prompt assembly + LLM + anonymization +
   * structural warnings + persist). Extracted verbatim from generateAllSections
   * so BOTH the flag-off path above AND the orchestrator-routed direct endpoint
   * (generate-all-direct → this) share ONE implementation — the compliance-
   * sensitive anonymization and PE grounding stay HERE (apps/workspace owns its
   * data + doctrine), never duplicated into the orchestrator. The orchestrator's
   * /meri-api/workspace-generation is the routing seam; deeper reasoning-
   * consolidation into meriv2-core awaits the ws_* ownership decision (Neo).
   */
  async generateAllSectionsInProcess(tenantId: string, draftId: string) {
    const draft = await this.prisma.wsDraft.findFirst({ where: { id: draftId, tenantId } });
    if (!draft) throw new ServiceUnavailableException('Draft not found');
    const cfg = draft.config as Record<string, unknown>;
    const sections = (cfg.sections as string[] | undefined) ?? [];
    const sectionContent: Record<string, string> = {
      ...((cfg.sectionContent as Record<string, string> | undefined) ?? {}),
    };
    const sectionMeta: Record<string, { status: string }> = {
      ...((cfg.sectionMeta as Record<string, { status: string }> | undefined) ?? {}),
    };

    // RETRIEVE-BEFORE-WRITE: resolve the draft's linked PE codes to their
    // authoritative DB records ONCE up front, then pass them to every section so
    // each draft is grounded in real mission/appropriation/budget data and we
    // don't issue N duplicate lookups. Best-effort: an unresolved PE falls back
    // to attached context inside generateSection.
    const linkedPes = (cfg.linkedProgramElements as Array<{ peCode?: string }> | undefined) ?? [];
    const authPes = await this.peResolver.resolve(linkedPes.map((pe) => pe.peCode));

    // Phase 3.3: capture the "context used" provenance from a generated section.
    // Every section in one generate-all run shares the same draft context /
    // steering memory / linked PEs, so any one section's provenance is the
    // whole-draft provenance.
    let provenance: ContextProvenance | undefined;
    await Promise.all(
      sections.map(async (section) => {
        try {
          const r = await this.generateSection(tenantId, draftId, section, authPes);
          sectionContent[section] = r.content;
          sectionMeta[section] = { status: 'review' };
          provenance ??= r.provenance;
        } catch (e) {
          this.logger.warn(`generate-all: section "${section}" failed: ${(e as Error).message}`);
        }
      }),
    );

    // PARITY with in-editor Meri: run the deterministic PE structural checks
    // (RDT&E-vs-procurement, capability/mission mismatch) over the freshly
    // generated text against the AUTHORITATIVE PE records (real appropriation
    // type / budget activity), and persist them so the editor can surface
    // warnings at creation time — not just on edit.
    const structuralWarnings = this.computeStructuralWarnings(cfg, sectionContent, authPes);
    // Phase 3.1: claim-level grounding audit (shared Phase 2 auditor) over the
    // generated sections — advisory findings persisted for ChecksService to
    // surface in the existing checks list.
    const groundingFindings = this.runGroundingAuditor(sectionContent, authPes);

    return this.persistGeneratedSections(tenantId, draftId, cfg, {
      sectionContent,
      sectionMeta,
      structuralWarnings,
      contextProvenance: provenance,
      groundingFindings,
    });
  }

  /**
   * Persist already-generated section content into the draft's config
   * (REPLACES sectionContent/sectionMeta/structuralWarnings; every other cfg
   * field is preserved). The one write path both `generateAllSections`
   * (in-process reasoning) and `applyGeneratedSections` (orchestrator-driven
   * reasoning) funnel through — "workspace is the only writer" holds no
   * matter which surface computed the content.
   */
  private async persistGeneratedSections(
    tenantId: string,
    draftId: string,
    cfg: Record<string, unknown>,
    sections: {
      sectionContent: Record<string, string>;
      sectionMeta: Record<string, { status: string }>;
      structuralWarnings: PeStructuralWarning[];
      /** Phase 3.3 "context used" snapshot; undefined leaves any prior value. */
      contextProvenance?: ContextProvenance;
      /** Phase 3.1 grounding findings; undefined leaves any prior value. */
      groundingFindings?: GroundingFinding[];
    },
  ) {
    // Only overwrite contextProvenance / groundingFindings when this run computed
    // them; otherwise preserve whatever a prior generation stored (e.g. an
    // orchestrator-driven apply that carries neither must not wipe them).
    const { contextProvenance, groundingFindings, ...rest } = sections;
    const provenancePatch = contextProvenance !== undefined ? { contextProvenance } : {};
    const groundingPatch = groundingFindings !== undefined ? { groundingFindings } : {};
    await this.prisma.wsDraft.update({
      where: { id: draftId },
      data: { config: { ...cfg, ...rest, ...provenancePatch, ...groundingPatch } as never },
    });
    return this.prisma.wsDraft.findFirst({
      where: { id: draftId, tenantId },
      include: { documents: { orderBy: { ordinal: 'asc' } } },
    });
  }

  /**
   * Apply section content the MeriV2 orchestrator generated (the dormant
   * flag-gated proxy branch in `generateAllSections`) — the write-back half of
   * the orchestrator-generation contract. The orchestrator does the
   * REASONING (prompt assembly + LLM call, mirroring this service's own
   * generateSection); apps/workspace still performs the ONLY write to
   * ws_draft.config, so the "workspace is the only writer" doctrine holds
   * literally even when the content came from a different reasoning surface.
   * Tenant-scoped like every other draft mutation — a caller can already set
   * their own draft's section content via the normal editor save path, so this
   * grants no new capability, only a new source for the content.
   */
  async applyGeneratedSections(
    tenantId: string,
    draftId: string,
    input: {
      sectionContent?: Record<string, string>;
      sectionMeta?: Record<string, { status: string }>;
      structuralWarnings?: PeStructuralWarning[];
    },
  ) {
    const draft = await this.prisma.wsDraft.findFirst({ where: { id: draftId, tenantId } });
    if (!draft) throw new ServiceUnavailableException('Draft not found');
    const cfg = draft.config as Record<string, unknown>;

    const sectionContent =
      input.sectionContent && typeof input.sectionContent === 'object'
        ? input.sectionContent
        : ((cfg.sectionContent as Record<string, string> | undefined) ?? {});
    const sectionMeta =
      input.sectionMeta && typeof input.sectionMeta === 'object'
        ? input.sectionMeta
        : ((cfg.sectionMeta as Record<string, { status: string }> | undefined) ?? {});
    const structuralWarnings = Array.isArray(input.structuralWarnings)
      ? input.structuralWarnings
      : [];

    return this.persistGeneratedSections(tenantId, draftId, cfg, {
      sectionContent,
      sectionMeta,
      structuralWarnings,
    });
  }

  /**
   * Deterministic PE structural warnings for a generated document. Validates the
   * draft's linked PEs (full records) against the concatenated section text, and
   * also flags any PE codes cited in the text that aren't among the linked PEs
   * (a bare-code citation we can't structurally vet but should not silently pass).
   * Pure-ish (no IO); safe to call after generation. Mirrors apps/api Meri.
   */
  private computeStructuralWarnings(
    cfg: Record<string, unknown>,
    sectionContent: Record<string, string>,
    authPes: AuthoritativePeRecord[] = [],
  ): PeStructuralWarning[] {
    const fullText = Object.values(sectionContent)
      .join('\n')
      .replace(/<[^>]*>/g, ' ');
    if (!fullText.trim()) return [];
    const linkedPes =
      (cfg.linkedProgramElements as
        | Array<{
            peCode?: string;
            title?: string;
            appropriationType?: string;
            budgetActivity?: string;
          }>
        | undefined) ?? [];
    const pes: PeRecordForValidation[] = [];
    const seen = new Set<string>();
    // Authoritative DB records first — these carry the REAL appropriation type /
    // budget activity the RDT&E-vs-procurement and mission checks depend on, so a
    // thin/wrong attached PE can't suppress a true warning.
    const authByCode = new Map(authPes.map((r) => [r.peCode.toUpperCase(), r]));
    for (const rec of authPes) {
      const code = rec.peCode.toUpperCase();
      if (seen.has(code)) continue;
      seen.add(code);
      pes.push(this.peResolver.toValidationRecord(rec));
    }
    // Linked PEs that didn't resolve → fall back to whatever was attached.
    for (const pe of linkedPes) {
      if (!pe.peCode) continue;
      const code = pe.peCode.toUpperCase();
      if (seen.has(code)) continue;
      seen.add(code);
      pes.push({
        peCode: code,
        title: pe.title ?? null,
        appropriationType: pe.appropriationType ?? null,
        budgetActivity: pe.budgetActivity ?? null,
      });
    }
    // PE codes cited in prose but not linked → include with bare code so the
    // capability/mission rule can still fire if the title is echoed in text.
    for (const code of extractCitedPeCodes(fullText)) {
      if (!seen.has(code)) {
        seen.add(code);
        // A cited code might still be resolvable from the up-front batch.
        const auth = authByCode.get(code);
        pes.push(auth ? this.peResolver.toValidationRecord(auth) : { peCode: code });
      }
    }
    try {
      return collectPeStructuralWarnings(pes, fullText);
    } catch (e) {
      this.logger.warn(`generate-all: structural check failed: ${(e as Error).message}`);
      return [];
    }
  }

  /**
   * "Let Meri draft an edit" (handoff §12.7). Given a comment's quoted text and
   * its thread, draft a concrete replacement for the quote that addresses the
   * feedback. Returns the original quote (before) + the rewrite (after) so the
   * CommentsRail can show a before/after SuggestionCard. Honors the draft's
   * anonymize flag end-to-end (client/office names are stripped from the prompt
   * AND from the model's echoed output).
   */
  async suggestCommentEdit(args: {
    tenantId: string;
    quote: string;
    commentBody: string;
    replies: string[];
    docTitle: string;
    product: string | null;
    client: string | null;
    offices: string[];
    anonymize: boolean;
    /** The draft owner (for "My Writing Style" grounding). Optional — omit if unknown. */
    ownerId?: string | null;
  }): Promise<{ before: string; after: string; model: string }> {
    const cred = await this.creds.resolveAnthropic(args.tenantId);
    if (!cred) {
      throw new ServiceUnavailableException(
        'No Anthropic credential available (tenant or global). Configure an AI key.',
      );
    }

    const steering = await this.loadSteeringMemories(args.tenantId, args.ownerId ?? undefined);

    const thread = [args.commentBody, ...args.replies].filter(Boolean).join('\n- ');
    const prompt = [
      'You are Meri, a government-affairs editing assistant. A reviewer left a comment on a',
      `passage in a ${args.product ?? 'document'} titled "${args.docTitle}".`,
      args.anonymize
        ? 'Do not reference any specific client or program by name; keep neutral placeholders.'
        : args.client
          ? `Client: ${args.client}.`
          : '',
      steering.firmContext ? `\n${steering.firmContext}` : '',
      steering.userVoiceContext
        ? `\nWrite in this author's voice:\n${steering.userVoiceContext}`
        : '',
      '',
      `Highlighted passage:\n"""${args.quote}"""`,
      '',
      `Reviewer feedback:\n- ${thread}`,
      '',
      'Rewrite ONLY the highlighted passage to address the feedback. Output just the revised',
      'passage prose — no quotes, no headers, no preamble, no meta-commentary. Government-affairs register.',
    ]
      .filter(Boolean)
      .join('\n');

    const finalPrompt = args.anonymize
      ? anonymizeText(prompt, { client: args.client, offices: args.offices }).text
      : prompt;

    const raw = await this.callAnthropic(cred.secret, cred.model, finalPrompt);
    const after = args.anonymize
      ? anonymizeText(raw, { client: args.client, offices: args.offices }).text
      : raw;

    return { before: args.quote, after, model: cred.model };
  }

  /**
   * Firm Soul + Firm Compass (unconditional) + the draft owner's "My Writing
   * Style" (if ownerId is known), rendered for prompt injection. `memory_items`
   * is apps/api-owned and RLS-protected (FORCE ROW LEVEL SECURITY, owner-aware
   * policy since Phase 1C) — this workspace service has no withTenant() helper
   * of its own (its own ws_* tables use app-level tenant filtering, not RLS),
   * so the transaction below sets BOTH GUCs itself: `app.current_tenant`
   * always, and `app.current_user` after resolving the Clerk `ownerId` to the
   * Capiro users.id UUID (private user-voice rows are invisible without it).
   * Best-effort: any failure returns empty context rather than blocking
   * generation.
   *
   * @param ownerId the draft owner's CLERK subject id (ws_* stores Clerk
   *   identities) — resolved to a Capiro user UUID internally.
   */
  private async loadSteeringMemories(
    tenantId: string,
    ownerId?: string,
  ): Promise<{
    firmContext?: string;
    userVoiceContext?: string;
    /** The memory files that actually contributed a non-empty human body (for
     *  the Phase 3.3 "context used" provenance). Only items whose rendered body
     *  is non-empty are listed — matching what really reached the prompt. */
    memoryFiles: ContextUsedMemoryFile[];
  }> {
    try {
      const rows = await this.prisma.$transaction(async (tx) => {
        // Parameterized set_config (mirrors apps/api + meriv2-orchestrator's
        // PrismaService.withTenant) — never string-interpolate the GUC value.
        await tx.$executeRaw`SELECT set_config('app.current_tenant', ${tenantId}, true)`;
        // `ownerId` is the draft owner's CLERK subject id (ws_* stores Clerk
        // identities; the engine does not own the Capiro users table) — resolve
        // it to the Capiro users.id UUID here. The previous code cast the Clerk
        // id to ::uuid directly, which threw 22P02 on EVERY call and the
        // best-effort catch swallowed it — so no steering memory (firm identity
        // OR user voice) ever reached a prod prompt. Resolution mirrors
        // apps/meriv2-orchestrator's MeriContextResolver.
        let capiroUserId: string | null = null;
        if (ownerId) {
          const users = await tx.$queryRaw<Array<{ id: string }>>`
            SELECT id FROM users WHERE clerk_user_id = ${ownerId} LIMIT 1
          `;
          capiroUserId = users[0]?.id ?? null;
        }
        // user-voice rows are visibility='user' + owner-scoped: the 1C RLS
        // policy (memory_items_isolation) only exposes them when
        // current_user_id() matches, so app.current_user MUST be set — the
        // tenant GUC alone silently filters private rows to nothing.
        if (capiroUserId) {
          await tx.$executeRaw`SELECT set_config('app.current_user', ${capiroUserId}, true)`;
        }
        // id + slug added (Phase 3.3): the panel needs each contributing memory
        // file's identity, not just its rendered text.
        return tx.$queryRaw<Array<{ id: string; type: string; slug: string; sections: unknown }>>`
          SELECT id, type, slug, sections_jsonb AS sections
          FROM memory_items
          WHERE tenant_id = ${tenantId}::uuid
            AND (
              (type IN ('firm-soul', 'firm-compass') AND slug = 'firm')
              OR (${capiroUserId}::uuid IS NOT NULL AND type = 'user-voice' AND owner_user_id = ${capiroUserId}::uuid)
            )
        `;
      });
      const renderHuman = (sections: unknown): string => {
        if (!Array.isArray(sections)) return '';
        return sections
          .filter((s) => s && typeof s === 'object' && (s as { owner?: string }).owner === 'human')
          .map((s) => {
            const sec = s as { heading?: string; body?: string };
            return sec.body?.trim() ? `${sec.heading}: ${sec.body.trim()}` : '';
          })
          .filter(Boolean)
          .join('\n');
      };
      const memoryLabel = (type: string): string =>
        type === 'firm-soul'
          ? 'Firm Soul'
          : type === 'firm-compass'
            ? 'Firm Compass'
            : type === 'user-voice'
              ? 'My Writing Style'
              : type;
      const firmBlocks: string[] = [];
      let userVoiceContext: string | undefined;
      const memoryFiles: ContextUsedMemoryFile[] = [];
      for (const r of rows) {
        const body = renderHuman(r.sections);
        if (!body) continue;
        if (r.type === 'firm-soul') firmBlocks.push(`Firm identity (Firm Soul):\n${body}`);
        else if (r.type === 'firm-compass')
          firmBlocks.push(`Firm direction (Firm Compass):\n${body}`);
        else if (r.type === 'user-voice') userVoiceContext = body;
        // Only files that actually contributed a body (same filter as the prompt)
        // appear in provenance, so the panel never claims a skipped/empty file.
        memoryFiles.push({ id: r.id, type: r.type, slug: r.slug, label: memoryLabel(r.type) });
      }
      return {
        firmContext: firmBlocks.length ? firmBlocks.join('\n\n') : undefined,
        userVoiceContext,
        memoryFiles,
      };
    } catch (e) {
      this.logger.warn(`Steering memory load failed (non-fatal): ${(e as Error).message}`);
      return { memoryFiles: [] };
    }
  }

  private parseIntakeJson(
    raw: string,
    products: string[],
    industries: string[],
  ): {
    product: string;
    industry: string;
    client: string | null;
    docTitle: string;
    confidence: string;
    notes: string;
  } {
    let obj: Record<string, unknown> = {};
    try {
      const m = raw.match(/\{[\s\S]*\}/);
      if (m) obj = JSON.parse(m[0]) as Record<string, unknown>;
    } catch {
      obj = {};
    }
    const product =
      typeof obj.product === 'string' && products.includes(obj.product)
        ? obj.product
        : 'White paper';
    const industry =
      typeof obj.industry === 'string' && industries.includes(obj.industry)
        ? obj.industry
        : (industries[0] ?? 'Defense & Aerospace');
    const confidence =
      obj.confidence === 'high' || obj.confidence === 'medium' || obj.confidence === 'low'
        ? obj.confidence
        : 'low';
    return {
      product,
      industry,
      client: typeof obj.client === 'string' && obj.client.trim() ? obj.client : null,
      docTitle: typeof obj.docTitle === 'string' ? obj.docTitle.slice(0, 80) : '',
      confidence,
      notes: typeof obj.notes === 'string' ? obj.notes : '',
    };
  }

  private buildSectionPrompt(args: {
    product: string;
    docTitle: string;
    industry: string | null;
    section: string;
    tone: string;
    toneContext: string;
    committees: string[];
    context: string;
    client: string | null;
    /** Setup "Length target" (cfg.pages) + the product's suggested pages. */
    targetPages: number;
    suggestedPages: number;
    /** Firm Soul + Firm Compass, rendered (see loadSteeringMemories). */
    firmContext?: string;
    /** The draft owner's "My Writing Style" file, rendered. */
    userVoiceContext?: string;
  }): string {
    const sectionGuide = WSC.suggestedSections(args.product);
    // E-4: match Meri's length + format to the section's purpose instead of one
    // generic prose block. Output HTML (the editor/preview render sanitized HTML
    // that now permits <p>/<ul>/<li>/<table>).
    const spec = WSC.specFor(args.section);
    // Scale the length-driving formats to the Setup "Length target": a draft set
    // longer than the product's suggested pages gets proportionally longer prose/
    // bullet sections (and shorter when set below), so the whole document lands
    // near the requested page count. Structurally-bounded sections ('short'
    // one-liners, budget 'table's) keep their natural size. Clamped so an extreme
    // target can't produce absurd sections.
    const pageScale =
      args.suggestedPages > 0
        ? Math.min(4, Math.max(0.4, args.targetPages / args.suggestedPages))
        : 1;
    const scalable = spec.format === 'prose' || spec.format === 'bullets';
    const loWords = scalable ? Math.round(spec.targetWords[0] * pageScale) : spec.targetWords[0];
    const hiWords = scalable ? Math.round(spec.targetWords[1] * pageScale) : spec.targetWords[1];
    const formatLine =
      spec.format === 'bullets'
        ? 'Format as a concise HTML bullet list: <ul><li>…</li></ul>.'
        : spec.format === 'table'
          ? 'Format as a simple HTML <table> with a header row (<thead><tr><th>…</th></tr></thead><tbody>…</tbody>).'
          : spec.format === 'short'
            ? 'Write only 1–2 tight sentences (or one short labeled line). Do not pad.'
            : 'Write well-structured prose as one or more <p> paragraphs.';
    return [
      `You are Meri, a government-affairs writing assistant. Draft the "${args.section}" section`,
      `of a ${args.product} titled "${args.docTitle}".`,
      args.industry ? `Industry/sector: ${args.industry}.` : '',
      args.client ? `Client: ${args.client}.` : 'Do not reference any specific client by name.',
      args.committees.length ? `Relevant committees: ${args.committees.join(', ')}.` : '',
      `Tone: ${args.tone}.`,
      args.toneContext ? `Strategic emphasis: ${args.toneContext}.` : '',
      `This section sits within the standard structure: ${sectionGuide.join(' → ')}.`,
      `The full document targets about ${args.targetPages} page${args.targetPages === 1 ? '' : 's'} — size this section proportionally so the whole document lands near that length.`,
      args.context ? `Ground the content in these facts:\n- ${args.context}` : '',
      args.firmContext ? `\n${args.firmContext}` : '',
      args.userVoiceContext ? `\nDraft in this author's voice:\n${args.userVoiceContext}` : '',
      '',
      DOMAIN_PRIMER,
      '',
      `Goal of this section: ${spec.goal}`,
      `Target length: roughly ${loWords}–${hiWords} words — respect it.`,
      formatLine,
      `Output clean HTML using ONLY these tags: <p>, <ul>/<ol>/<li>, <table>/<thead>/<tbody>/<tr>/<th>/<td>, <strong>, <em>. No markdown, no section header/title, no preamble or meta-commentary. Be specific and factual; government-affairs register.`,
    ]
      .filter(Boolean)
      .join('\n');
  }

  private async callAnthropic(secret: string, model: string, prompt: string): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GENERATION_TIMEOUT_MS);
    try {
      const res = await fetch(ANTHROPIC_URL, {
        method: 'POST',
        headers: {
          'x-api-key': secret,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model,
          max_tokens: MAX_TOKENS,
          messages: [{ role: 'user', content: prompt }],
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
        this.logger.warn(
          `Anthropic generation failed: HTTP ${res.status} ${body.error?.message ?? ''}`,
        );
        throw new ServiceUnavailableException(
          body.error?.message ?? `Generation failed (HTTP ${res.status})`,
        );
      }
      const data = (await res.json()) as { content?: { type: string; text?: string }[] };
      return (data.content ?? [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text ?? '')
        .join('')
        .trim();
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        throw new ServiceUnavailableException(
          `Generation timed out after ${GENERATION_TIMEOUT_MS / 1000}s`,
        );
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}
