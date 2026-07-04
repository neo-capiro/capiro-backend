import { Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import type { AppConfig } from '../../config/config.schema.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { ActionRecommendationReadService } from '../actions/action-recommendation-read.service.js';
import type { ActionCard } from '../actions/action-recommendation-read.service.js';
import { buildFactSheet, describeSourceRef } from './fact-sheet.js';
import { renderArtifactDocx } from './artifact-docx.js';
import { verifyArtifact } from './artifact-verifier.js';
import type { ArtifactType, Claim, FactSheet, GeneratedParagraph } from './artifact-types.js';

/**
 * Step 3.3 — source-backed artifact generator (plan §18).
 *
 * Generates an editable, 100%-source-backed deliverable (one-pager / memo /
 * email / talking points / watch note) FROM an action card. Flow:
 *   1. load the card (read service, tenant-scoped);
 *   2. {@link buildFactSheet} — deterministic, typed claims from the card's
 *      evidence + the numbers in its narrative;
 *   3. call the LLM with HARD constraints ("use ONLY these claims by id; return
 *      JSON {paragraphs:[{text,claimIds}]}") — the call is behind the injectable
 *      {@link callArtifactLlm} so specs mock it (NO live call in tests);
 *   4. {@link verifyArtifact} — drop any paragraph that is ungrounded or quotes an
 *      unsourced numeral;
 *   5. assemble bodyText (kept prose + a **Sources** appendix mapping claim ids to
 *      human citations + a **Caveats** section from the card's `uncertainty`);
 *   6. persist a ClioArtifact (kind = the artifact type, metadata carries the
 *      action link + claim ids + verification + version).
 *
 * No schema change: we reuse the existing `ClioArtifact` model. Like Deep Research,
 * an artifact needs a backing ClioConversation (the FK is required), created lazily
 * and reused per action via `clio_artifact_action` metadata lookup.
 *
 * Money convention: $ MILLIONS throughout (project-wide).
 */

const AI_TIMEOUT_MS = 90_000;
const ARTIFACT_VERSION = 1;

const ARTIFACT_KIND_PREFIX = 'artifact_';

/** Title-cased label per artifact type for the document header + ClioArtifact.title. */
const TYPE_LABELS: Record<ArtifactType, string> = {
  internal_brief: 'Internal Brief',
  client_email: 'Client Email',
  member_one_pager: 'Member One-Pager',
  committee_staff_memo: 'Committee Staff Memo',
  talking_points: 'Talking Points',
  procurement_watch_note: 'Procurement Watch Note',
};

const VALID_TYPES = new Set<ArtifactType>([
  'internal_brief',
  'client_email',
  'member_one_pager',
  'committee_staff_memo',
  'talking_points',
  'procurement_watch_note',
]);

const SYSTEM_PROMPT = `You are a senior federal government affairs analyst drafting a source-backed deliverable for a lobbying firm. You are given a FACT SHEET: a closed, numbered list of claims, each with an id (c1, c2, ...). You MUST write prose that restates ONLY these claims. Hard rules:
- Use ONLY the supplied claims. Never introduce a fact, number, dollar figure, date, or name that is not in a claim.
- Every paragraph MUST cite the claim ids it draws on.
- Do not invent citations, statistics, or quotes.
Return ONLY JSON of the form {"paragraphs":[{"text":"...","claimIds":["c1","c2"]}]} with no prose outside the JSON.`;

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new ServiceUnavailableException(`AI request timed out after ${AI_TIMEOUT_MS / 1000}s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function extractAnthropicText(json: Record<string, unknown>): string {
  const content = Array.isArray(json.content) ? json.content : [];
  return content
    .map((part) => {
      const record = part && typeof part === 'object' ? (part as Record<string, unknown>) : {};
      return record.type === 'text' && typeof record.text === 'string' ? record.text : '';
    })
    .join('\n')
    .trim();
}

/** Tolerant JSON-object parse: strips fences/prose and reads the first {...} block. */
function parseParagraphs(text: string): GeneratedParagraph[] {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return [];
  let parsed: { paragraphs?: unknown };
  try {
    parsed = JSON.parse(trimmed) as { paragraphs?: unknown };
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) return [];
    try {
      parsed = JSON.parse(match[0]) as { paragraphs?: unknown };
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed.paragraphs)) return [];
  const out: GeneratedParagraph[] = [];
  for (const raw of parsed.paragraphs) {
    if (!raw || typeof raw !== 'object') continue;
    const p = raw as Record<string, unknown>;
    if (typeof p.text !== 'string' || !p.text.trim()) continue;
    const claimIds = Array.isArray(p.claimIds)
      ? p.claimIds.filter((id): id is string => typeof id === 'string')
      : [];
    out.push({ text: p.text.trim(), claimIds });
  }
  return out;
}

/** Render the fact sheet as the numbered claim list injected into the prompt. */
function renderFactSheetForPrompt(factSheet: FactSheet): string {
  return factSheet.claims
    .map((c) => {
      const value = c.value ? ` [value: ${c.value}]` : '';
      return `${c.id}: ${c.claimText}${value} (source: ${describeSourceRef(c.sourceRef)})`;
    })
    .join('\n');
}

/** Result of the artifact assembly, before persistence. */
export interface GeneratedArtifact {
  id: string;
  title: string;
  kind: string;
  bodyText: string;
  metadata: ArtifactMetadata;
}

export interface ArtifactMetadata {
  actionId: string;
  claimIds: string[];
  verification: { ok: boolean; rejected: { index: number; reason: string }[] };
  version: number;
  artifactType: ArtifactType;
}

@Injectable()
export class ArtifactGeneratorService {
  private readonly logger = new Logger(ArtifactGeneratorService.name);
  private readonly anthropicKey?: string;
  private readonly model: string;

  constructor(
    config: ConfigService<AppConfig, true>,
    private readonly prisma: PrismaService,
    private readonly readService: ActionRecommendationReadService,
  ) {
    this.anthropicKey = config.get('ANTHROPIC_API_KEY', { infer: true });
    this.model = config.get('CLIO_RESEARCH_MODEL', { infer: true });
  }

  /**
   * Generate an artifact of `type` from the given action card, verify it, assemble
   * the body + appendix + caveats, and persist a ClioArtifact (version 1).
   */
  async generate(
    ctx: TenantContext,
    actionId: string,
    type: ArtifactType,
  ): Promise<GeneratedArtifact> {
    if (!VALID_TYPES.has(type)) {
      throw new NotFoundException(`Unknown artifact type: ${type}`);
    }

    const card = await this.readService.getOne(ctx, actionId);
    const factSheet = buildFactSheet(card);

    // 3) LLM call (injectable -> mocked in tests). Empty fact sheets still get a
    //    deterministic fallback paragraph so a card with no figures still produces
    //    a usable, grounded artifact.
    let paragraphs: GeneratedParagraph[];
    if (factSheet.claims.length === 0) {
      paragraphs = [];
    } else {
      const raw = await this.callArtifactLlm(factSheet, card, type);
      paragraphs = parseParagraphs(raw);
    }

    // 4) Verify. Caveat text is appended by us (not the LLM) so there is no caveat
    //    paragraph in this array — every LLM paragraph is checked.
    const verification = verifyArtifact(paragraphs, factSheet);
    const kept = paragraphs.filter((_, i) => !verification.rejected.some((r) => r.index === i));

    if (verification.rejected.length > 0) {
      this.logger.warn(
        `Artifact ${type} for action ${actionId}: dropped ${verification.rejected.length} unsourced paragraph(s).`,
      );
    }

    // 5) Assemble bodyText: prose -> Sources appendix -> Caveats.
    const bodyText = assembleBody({ card, type, paragraphs: kept, factSheet });

    const usedClaimIds = uniqueClaimIds(kept);
    const metadata: ArtifactMetadata = {
      actionId,
      claimIds: usedClaimIds,
      verification: { ok: verification.ok, rejected: verification.rejected },
      version: ARTIFACT_VERSION,
      artifactType: type,
    };

    // 6) Persist.
    const persisted = await this.persist(ctx, card, type, bodyText, metadata);
    return {
      id: persisted.id,
      title: persisted.title,
      kind: persisted.kind,
      bodyText,
      metadata,
    };
  }

  /** List the artifacts generated for an action, newest first. Tenant-scoped. */
  async listForAction(ctx: TenantContext, actionId: string): Promise<GeneratedArtifact[]> {
    const rows = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.clioArtifact.findMany({
        where: {
          tenantId: ctx.tenantId,
          kind: { startsWith: ARTIFACT_KIND_PREFIX },
          metadata: { path: ['actionId'], equals: actionId },
        },
        orderBy: { createdAt: 'desc' },
        select: { id: true, title: true, kind: true, bodyText: true, metadata: true },
      }),
    );
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      kind: row.kind,
      bodyText: row.bodyText ?? '',
      metadata: (row.metadata as unknown as ArtifactMetadata) ?? emptyMetadata(actionId),
    }));
  }

  /**
   * Persist a user edit. Stores the edited body and bumps `metadata.version`
   * WITHOUT regenerating — user edits are never clobbered by the LLM. Tenant-scoped.
   */
  async updateContent(
    ctx: TenantContext,
    artifactId: string,
    bodyText: string,
  ): Promise<GeneratedArtifact> {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const existing = await tx.clioArtifact.findFirst({
        where: { id: artifactId, tenantId: ctx.tenantId },
        select: { id: true, title: true, kind: true, metadata: true },
      });
      if (!existing) throw new NotFoundException(`Artifact ${artifactId} not found`);

      const prevMeta =
        existing.metadata &&
        typeof existing.metadata === 'object' &&
        !Array.isArray(existing.metadata)
          ? (existing.metadata as Record<string, unknown>)
          : {};
      const prevVersion =
        typeof prevMeta.version === 'number' ? prevMeta.version : ARTIFACT_VERSION;
      const nextMeta = {
        ...prevMeta,
        version: prevVersion + 1,
        editedAt: new Date().toISOString(),
        editedByUserId: ctx.userId,
      };

      const { count } = await tx.clioArtifact.updateMany({
        where: { id: artifactId, tenantId: ctx.tenantId },
        data: {
          bodyText,
          metadata: nextMeta as Prisma.InputJsonObject,
        },
      });
      if (count !== 1) throw new NotFoundException(`Artifact ${artifactId} not found`);

      return {
        id: existing.id,
        title: existing.title,
        kind: existing.kind,
        bodyText,
        metadata: nextMeta as unknown as ArtifactMetadata,
      };
    });
  }

  /**
   * Render a stored artifact as a client-ready .docx. Tenant-scoped (same
   * ownership guard as updateContent); returns the buffer + a safe filename so
   * the controller can stream it as a download. NO LLM call — pure serialization
   * of the already-verified, already-persisted bodyText.
   */
  async renderDocx(
    ctx: TenantContext,
    artifactId: string,
  ): Promise<{ filename: string; buffer: Buffer }> {
    const artifact = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.clioArtifact.findFirst({
        where: { id: artifactId, tenantId: ctx.tenantId },
        select: { title: true, bodyText: true },
      }),
    );
    if (!artifact) throw new NotFoundException(`Artifact ${artifactId} not found`);

    const title = artifact.title || 'Intelligence Artifact';
    const buffer = await renderArtifactDocx({ title, bodyText: artifact.bodyText ?? '' });
    return { filename: `${slugifyFilename(title)}.docx`, buffer };
  }

  /**
   * The ONLY method that touches the network. Overridable/mockable so specs never
   * make a live call. Reuses the canonical direct-Anthropic pattern from
   * insight-generator (fetch -> api.anthropic.com, extractAnthropicText).
   */
  protected async callArtifactLlm(
    factSheet: FactSheet,
    card: ActionCard,
    type: ArtifactType,
  ): Promise<string> {
    if (!this.anthropicKey) {
      throw new ServiceUnavailableException('ANTHROPIC_API_KEY not configured');
    }
    const prompt = buildPrompt(factSheet, card, type);
    const res = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': this.anthropicKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 2000,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const json = (await res.json()) as Record<string, unknown>;
    if (!res.ok) {
      throw new ServiceUnavailableException(
        `Anthropic failed: ${JSON.stringify(json).slice(0, 200)}`,
      );
    }
    return extractAnthropicText(json);
  }

  /**
   * Persist the artifact as a ClioArtifact. Reuses the Deep Research pattern: the
   * ClioArtifact.conversationId FK is required, so we anchor on a lazily-created
   * backing ClioConversation (one per action, reused across its artifacts).
   */
  private async persist(
    ctx: TenantContext,
    card: ActionCard,
    type: ArtifactType,
    bodyText: string,
    metadata: ArtifactMetadata,
  ): Promise<{ id: string; title: string; kind: string }> {
    const title = `${TYPE_LABELS[type]}: ${card.issueTitle}`;
    const kind = `${ARTIFACT_KIND_PREFIX}${type}`;
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const conversationId = await this.ensureBackingConversation(tx, ctx, card);
      const artifact = await tx.clioArtifact.create({
        data: {
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          clientId: card.clientId ?? null,
          conversationId,
          title,
          kind,
          contentType: 'text/markdown',
          bodyText,
          metadata: metadata as unknown as Prisma.InputJsonObject,
        },
        select: { id: true, title: true, kind: true },
      });
      return artifact;
    });
  }

  /**
   * Find-or-create the backing conversation for an action's artifacts. Keyed by an
   * `actionArtifactBacking` marker in the conversation metadata so all artifacts for
   * one action share a single backing conversation.
   */
  private async ensureBackingConversation(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    card: ActionCard,
  ): Promise<string> {
    const existing = await tx.clioConversation.findFirst({
      where: {
        tenantId: ctx.tenantId,
        metadata: { path: ['actionArtifactBacking'], equals: card.id },
      },
      select: { id: true },
    });
    if (existing) return existing.id;

    const conversation = await tx.clioConversation.create({
      data: {
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        clientId: card.clientId ?? null,
        title: `Artifacts: ${card.issueTitle}`,
        status: 'active',
        metadata: { actionArtifactBacking: card.id } as Prisma.InputJsonObject,
      },
      select: { id: true },
    });
    return conversation.id;
  }
}

/** Unique, order-preserving claim ids across all kept paragraphs. */
function uniqueClaimIds(paragraphs: GeneratedParagraph[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of paragraphs) {
    for (const id of p.claimIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

function emptyMetadata(actionId: string): ArtifactMetadata {
  return {
    actionId,
    claimIds: [],
    verification: { ok: true, rejected: [] },
    version: ARTIFACT_VERSION,
    artifactType: 'internal_brief',
  };
}

/** Build the user prompt: the framed task + the numbered fact sheet. */
function buildPrompt(factSheet: FactSheet, card: ActionCard, type: ArtifactType): string {
  return [
    `Draft a ${TYPE_LABELS[type]} for the issue: "${card.issueTitle}".`,
    card.targetAudience.length
      ? `Target audience: ${card.targetAudience.map((a) => a.label).join(', ')}.`
      : '',
    `Why it matters (context, do not assert beyond the claims): ${card.whyItMatters}`,
    '',
    'FACT SHEET (the ONLY material you may assert; cite ids):',
    renderFactSheetForPrompt(factSheet),
    '',
    'Return JSON: {"paragraphs":[{"text":"...","claimIds":["c1"]}]}',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Assemble the final markdown body: header, kept prose, a Sources appendix mapping
 * each cited claim id to a human citation, and a Caveats section from the card's
 * uncertainty (ALWAYS present when uncertainty is non-empty).
 */
function assembleBody(args: {
  card: ActionCard;
  type: ArtifactType;
  paragraphs: GeneratedParagraph[];
  factSheet: FactSheet;
}): string {
  const { card, type, paragraphs, factSheet } = args;
  const claimById = new Map<string, Claim>(factSheet.claims.map((c) => [c.id, c]));

  const lines: string[] = [];
  lines.push(`# ${TYPE_LABELS[type]}: ${card.issueTitle}`);
  lines.push('');

  if (paragraphs.length) {
    for (const p of paragraphs) lines.push(p.text, '');
  } else {
    // No grounded prose survived — surface the issue itself rather than ship empty.
    lines.push(card.whatChanged.trim(), '');
  }

  // Sources appendix — only the claim ids actually cited by kept prose.
  const citedIds = uniqueClaimIds(paragraphs);
  if (citedIds.length) {
    lines.push('## Sources', '');
    for (const id of citedIds) {
      const claim = claimById.get(id);
      if (!claim) continue;
      lines.push(`- ${id}: ${describeSourceRef(claim.sourceRef)}`);
    }
    lines.push('');
  }

  // Caveats — ALWAYS present when the card carries uncertainty.
  const uncertainty = (card.uncertainty ?? '').trim();
  if (uncertainty) {
    lines.push('## Caveats', '');
    lines.push(uncertainty);
    lines.push('');
  }

  return lines.join('\n').trimEnd() + '\n';
}

/** Filesystem-safe slug for a download filename. */
function slugifyFilename(title: string): string {
  const slug = (title || 'artifact')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug || 'artifact';
}
