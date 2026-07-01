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

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const GENERATION_TIMEOUT_MS = 120_000;
const MAX_TOKENS = 4096;

export interface GenerateSectionResult {
  section: string;
  content: string;
  model: string;
  usedTenantKey: boolean;
  anonymized: boolean;
  legend?: AnonymizeMap['legend'];
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
      authoritativePes ??
      (await this.peResolver.resolve(linkedPes.map((pe) => pe.peCode)));
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
    });

    // Strip client/office names from the prompt when anonymizing.
    const finalPrompt = anonymize ? anonymizeText(prompt, { client, offices }).text : prompt;

    const raw = await this.callAnthropic(cred.secret, cred.model, finalPrompt);

    // Strip any client/office names the model may have echoed back.
    const result = anonymize
      ? anonymizeText(raw, { client, offices })
      : { text: raw, map: { legend: {} } };

    return {
      section: sectionName,
      content: result.text,
      model: cred.model,
      usedTenantKey: cred.usedTenantKey,
      anonymized: anonymize,
      legend: anonymize ? result.map.legend : undefined,
    };
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
      return (await this.meriV2.proxyGenerateAllSections(tenantId, draftId, opts?.bearerToken)) as never;
    }
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
    const linkedPes =
      (cfg.linkedProgramElements as Array<{ peCode?: string }> | undefined) ?? [];
    const authPes = await this.peResolver.resolve(linkedPes.map((pe) => pe.peCode));

    await Promise.all(
      sections.map(async (section) => {
        try {
          const r = await this.generateSection(tenantId, draftId, section, authPes);
          sectionContent[section] = r.content;
          sectionMeta[section] = { status: 'review' };
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

    await this.prisma.wsDraft.update({
      where: { id: draftId },
      data: { config: { ...cfg, sectionContent, sectionMeta, structuralWarnings } as never },
    });
    return this.prisma.wsDraft.findFirst({
      where: { id: draftId, tenantId },
      include: { documents: { orderBy: { ordinal: 'asc' } } },
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
    const fullText = Object.values(sectionContent).join('\n').replace(/<[^>]*>/g, ' ');
    if (!fullText.trim()) return [];
    const linkedPes =
      (cfg.linkedProgramElements as
        | Array<{ peCode?: string; title?: string; appropriationType?: string; budgetActivity?: string }>
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
  }): Promise<{ before: string; after: string; model: string }> {
    const cred = await this.creds.resolveAnthropic(args.tenantId);
    if (!cred) {
      throw new ServiceUnavailableException(
        'No Anthropic credential available (tenant or global). Configure an AI key.',
      );
    }

    const thread = [args.commentBody, ...args.replies].filter(Boolean).join('\n- ');
    const prompt = [
      'You are Meri, a government-affairs editing assistant. A reviewer left a comment on a',
      `passage in a ${args.product ?? 'document'} titled "${args.docTitle}".`,
      args.anonymize
        ? 'Do not reference any specific client or program by name; keep neutral placeholders.'
        : args.client
          ? `Client: ${args.client}.`
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
