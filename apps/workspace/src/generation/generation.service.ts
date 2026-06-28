import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { AiCredentialService } from './ai-credential.service.js';
import { anonymizeText, type AnonymizeMap } from './anonymize.js';
import { WSC } from '../cascade/cascade.config.js';

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
  ) {}

  async generateSection(
    tenantId: string,
    draftId: string,
    sectionName: string,
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

    // Linked program elements (Setup → Links & data): the user attaches PEs and
    // we persist the full associated context (mission + financials) on the
    // config so Meri grounds the draft in real budget data.
    const linkedPes =
      (cfg.linkedProgramElements as
        | Array<{ peCode?: string; title?: string; context?: string }>
        | undefined) ?? [];
    const peText = linkedPes
      .map((pe) => {
        const head = [pe.peCode, pe.title].filter(Boolean).join(' — ');
        return [head, pe.context].filter(Boolean).join('\n').slice(0, PER_ITEM_CAP);
      })
      .filter(Boolean);

    const contextText = [...itemText, ...peText]
      .filter(Boolean)
      .join('\n- ')
      .slice(0, TOTAL_CONTEXT_CAP);

    const prompt = this.buildSectionPrompt({
      product: draft.product ?? 'document',
      docTitle: draft.docTitle,
      industry: draft.industry,
      section: sectionName,
      tone: String(cfg.tone ?? 'Formal'),
      toneContext: String(cfg.toneContext ?? ''),
      committees: (cfg.committees as string[] | undefined) ?? [],
      context: contextText,
      client: anonymize ? null : client,
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

    // Auto-draft each section concurrently (best-effort). Statuses default to
    // "review" so the user signs off before the doc is treated as final (Q-ED-9).
    const sectionContent: Record<string, string> = {};
    const sectionMeta: Record<string, { status: string }> = {};
    await Promise.all(
      sections.map(async (section) => {
        try {
          const r = await this.generateSection(tenantId, draft.id, section);
          sectionContent[section] = r.content;
          sectionMeta[section] = { status: 'review' };
        } catch (e) {
          this.logger.warn(`Meri intake: section "${section}" failed: ${(e as Error).message}`);
        }
      }),
    );

    await this.prisma.wsDraft.update({
      where: { id: draft.id },
      data: { config: { ...config, sectionContent, sectionMeta } as never },
    });

    return this.prisma.wsDraft.findFirst({
      where: { id: draft.id, tenantId },
      include: { documents: { orderBy: { ordinal: 'asc' } } },
    });
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
  }): string {
    const sectionGuide = WSC.suggestedSections(args.product);
    return [
      `You are Meri, a government-affairs writing assistant. Draft the "${args.section}" section`,
      `of a ${args.product} titled "${args.docTitle}".`,
      args.industry ? `Industry/sector: ${args.industry}.` : '',
      args.client ? `Client: ${args.client}.` : 'Do not reference any specific client by name.',
      args.committees.length ? `Relevant committees: ${args.committees.join(', ')}.` : '',
      `Tone: ${args.tone}.`,
      args.toneContext ? `Strategic emphasis: ${args.toneContext}.` : '',
      `This section sits within the standard structure: ${sectionGuide.join(' → ')}.`,
      args.context ? `Ground the content in these facts:\n- ${args.context}` : '',
      '',
      `Write only the prose for the "${args.section}" section — no headers, no preamble,`,
      `no meta-commentary. Be specific, factual, and concise. Government-affairs register.`,
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
