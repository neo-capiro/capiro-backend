import { Injectable, NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { EmbeddingsService } from '../embeddings/embeddings.service.js';
import { OutcomeService } from '../engagement/outcome/outcome.service.js';

export interface CreateCapabilityInput {
  name: string;
  type?: string;
  description?: string;
  sector?: string;
  tags?: unknown[];
  issueCodes?: unknown[];
  trl?: number;
  mrl?: number;
  peNumber?: string;
  peNumbers?: string[];
  keywords?: string[];
  appropriationAccount?: string;
  serviceBranch?: string;
  targetSubcommittee?: string;
  fundingAsk?: number;
  fundingAskLabel?: string;
  justification?: string;
  districtNexus?: string;
  existingContracts?: string;
  notes?: string;
  sortOrder?: number;
}

export type UpdateCapabilityInput = Partial<CreateCapabilityInput>;

export interface CreateSubmissionHistoryInput {
  fiscalYear: string;
  title: string;
  meta?: string;
  outcome?: string;
  outcomeType?: string;
  notes?: string;
}

export type UpdateSubmissionHistoryInput = Partial<CreateSubmissionHistoryInput>;

/**
 * Normalize free-text capability tags so cross-client matching (comment-period
 * alerts, briefing keyword overlap) doesn't lose hits to typos and case drift.
 * Lowercases, trims, collapses whitespace, dedupes; preserves order of first
 * occurrence so the user-visible tag row reads the way it was entered.
 */
function normalizeCapabilityTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of raw) {
    if (typeof value !== 'string') continue;
    const cleaned = value.trim().toLowerCase().replace(/\s+/g, ' ');
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    out.push(cleaned);
  }
  return out;
}

/**
 * Normalize capability LDA issue codes the same way tags are normalized,
 * except codes are canonically UPPERCASE ('DEF', 'BUD') — matching how
 * client-prepopulation merges LDA codes into clients.issue_codes. Trims,
 * dedupes, drops non-strings; preserves order of first occurrence.
 */
function normalizeCapabilityIssueCodes(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of raw) {
    if (typeof value !== 'string') continue;
    const cleaned = value.trim().toUpperCase().replace(/\s+/g, ' ');
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    out.push(cleaned);
  }
  return out;
}

@Injectable()
export class ClientCapabilitiesService {
  constructor(
    private readonly prisma: PrismaService,
    // Embeddings are written asynchronously after create/update so Meri
    // RAG sees the new capability without a wait for the next backfill.
    // Fire-and-forget, embed failures must never bubble up to the user.
    private readonly embeddings: EmbeddingsService,
    // G3: decisive submission outcomes mirror into the structured
    // outcome_event stream (fail-open — never breaks the source write).
    private readonly outcomes: OutcomeService,
  ) {}

  private async assertClient(tenantId: string, clientId: string, tx: typeof this.prisma) {
    const client = await (tx as any).client.findFirst({
      where: { id: clientId, tenantId, status: { not: 'archived' } },
      select: { id: true },
    });
    if (!client) throw new NotFoundException('Client not found');
  }

  async listCapabilities(ctx: TenantContext, clientId: string) {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await this.assertClient(ctx.tenantId, clientId, tx as any);
      return tx.clientCapability.findMany({
        where: { tenantId: ctx.tenantId, clientId },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      });
    });
  }

  async createCapability(ctx: TenantContext, clientId: string, input: CreateCapabilityInput) {
    const created = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await this.assertClient(ctx.tenantId, clientId, tx as any);
      return tx.clientCapability.create({
        data: {
          tenantId: ctx.tenantId,
          clientId,
          name: input.name,
          type: input.type ?? 'product',
          description: input.description ?? null,
          sector: input.sector ?? null,
          tags: normalizeCapabilityTags(input.tags) as object,
          issueCodes: normalizeCapabilityIssueCodes(input.issueCodes) as object,
          trl: input.trl ?? null,
          mrl: input.mrl ?? null,
          peNumber: input.peNumber ?? null,
          peNumbers: input.peNumbers ?? [],
          keywords: input.keywords ?? [],
          appropriationAccount: input.appropriationAccount ?? null,
          serviceBranch: input.serviceBranch ?? null,
          targetSubcommittee: input.targetSubcommittee ?? null,
          fundingAsk: input.fundingAsk ?? null,
          fundingAskLabel: input.fundingAskLabel ?? null,
          justification: input.justification ?? null,
          districtNexus: input.districtNexus ?? null,
          existingContracts: input.existingContracts ?? null,
          notes: input.notes ?? null,
          sortOrder: input.sortOrder ?? 0,
        },
      });
    });
    // Embed asynchronously, the capability is searchable via Meri within
    // a second or two of the create response landing.
    this.embeddings.embedCapabilityFireAndForget(created.id);
    return created;
  }

  async updateCapability(
    ctx: TenantContext,
    clientId: string,
    id: string,
    input: UpdateCapabilityInput,
  ) {
    const updated = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const existing = await tx.clientCapability.findFirst({
        where: { id, tenantId: ctx.tenantId, clientId },
        select: { id: true },
      });
      if (!existing) throw new NotFoundException('Capability not found');
      return tx.clientCapability.update({
        where: { id },
        data: {
          ...('name' in input ? { name: input.name } : {}),
          ...('type' in input ? { type: input.type } : {}),
          ...('description' in input ? { description: input.description ?? null } : {}),
          ...('sector' in input ? { sector: input.sector ?? null } : {}),
          ...('tags' in input ? { tags: normalizeCapabilityTags(input.tags) as object } : {}),
          ...('issueCodes' in input
            ? { issueCodes: normalizeCapabilityIssueCodes(input.issueCodes) as object }
            : {}),
          ...('trl' in input ? { trl: input.trl ?? null } : {}),
          ...('mrl' in input ? { mrl: input.mrl ?? null } : {}),
          ...('peNumber' in input ? { peNumber: input.peNumber ?? null } : {}),
          ...('peNumbers' in input ? { peNumbers: input.peNumbers ?? [] } : {}),
          ...('keywords' in input ? { keywords: input.keywords ?? [] } : {}),
          ...('appropriationAccount' in input
            ? { appropriationAccount: input.appropriationAccount ?? null }
            : {}),
          ...('serviceBranch' in input ? { serviceBranch: input.serviceBranch ?? null } : {}),
          ...('targetSubcommittee' in input
            ? { targetSubcommittee: input.targetSubcommittee ?? null }
            : {}),
          ...('fundingAsk' in input ? { fundingAsk: input.fundingAsk ?? null } : {}),
          ...('fundingAskLabel' in input ? { fundingAskLabel: input.fundingAskLabel ?? null } : {}),
          ...('justification' in input ? { justification: input.justification ?? null } : {}),
          ...('districtNexus' in input ? { districtNexus: input.districtNexus ?? null } : {}),
          ...('existingContracts' in input
            ? { existingContracts: input.existingContracts ?? null }
            : {}),
          ...('notes' in input ? { notes: input.notes ?? null } : {}),
          ...('sortOrder' in input ? { sortOrder: input.sortOrder ?? 0 } : {}),
        },
      });
    });
    // Re-embed asynchronously. content_hash skips when the text-relevant
    // fields didn't actually change (e.g. user only tweaked sortOrder).
    this.embeddings.embedCapabilityFireAndForget(id);
    return updated;
  }

  async deleteCapability(ctx: TenantContext, clientId: string, id: string) {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const existing = await tx.clientCapability.findFirst({
        where: { id, tenantId: ctx.tenantId, clientId },
        select: { id: true },
      });
      if (!existing) throw new NotFoundException('Capability not found');
      await tx.clientCapability.delete({ where: { id } });
      // Cleanup the orphan embedding row. ON DELETE CASCADE on client_id
      // FK doesn't fire because the embedding's client_id may already be
      // NULL'd; delete by source_type/source_id explicitly.
      await tx.$executeRawUnsafe(
        `DELETE FROM context_embeddings
           WHERE source_type = 'capability' AND source_id = $1
             AND tenant_id = $2::uuid`,
        id,
        ctx.tenantId,
      );
      return { deleted: true };
    });
  }

  /** All submission history rows for a client across capabilities (read-only, for Meri context). */
  async listClientHistory(ctx: TenantContext, clientId: string) {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await this.assertClient(ctx.tenantId, clientId, tx as any);
      return tx.clientSubmissionHistory.findMany({
        where: { tenantId: ctx.tenantId, clientId },
        orderBy: { fiscalYear: 'desc' },
        take: 50,
      });
    });
  }

  async listHistory(ctx: TenantContext, clientId: string, capabilityId: string) {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const cap = await tx.clientCapability.findFirst({
        where: { id: capabilityId, tenantId: ctx.tenantId, clientId },
        select: { id: true },
      });
      if (!cap) throw new NotFoundException('Capability not found');
      return tx.clientSubmissionHistory.findMany({
        where: { tenantId: ctx.tenantId, clientId, capabilityId },
        orderBy: { fiscalYear: 'desc' },
      });
    });
  }

  async createHistory(
    ctx: TenantContext,
    clientId: string,
    capabilityId: string,
    input: CreateSubmissionHistoryInput,
  ) {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const cap = await tx.clientCapability.findFirst({
        where: { id: capabilityId, tenantId: ctx.tenantId, clientId },
        select: { id: true },
      });
      if (!cap) throw new NotFoundException('Capability not found');
      const created = await tx.clientSubmissionHistory.create({
        data: {
          tenantId: ctx.tenantId,
          clientId,
          capabilityId,
          fiscalYear: input.fiscalYear,
          title: input.title,
          meta: input.meta ?? null,
          outcome: input.outcome ?? null,
          outcomeType: input.outcomeType ?? 'in_progress',
          notes: input.notes ?? null,
        },
      });
      this.mirrorOutcome(ctx.tenantId, clientId, created.id, input.outcomeType, input.outcome);
      return created;
    });
  }

  /**
   * G3: a DECISIVE submission outcome (won/success/partial/lost/failed) is a
   * real-world advocacy result — mirror it into the structured outcome_event
   * stream so artifacts/outreach/results connect. in_progress is not a result
   * and is never mirrored. Fire-and-forget by contract.
   */
  private mirrorOutcome(
    tenantId: string,
    clientId: string,
    submissionId: string,
    outcomeType: string | null | undefined,
    outcomeText: string | null | undefined,
  ): void {
    const t = (outcomeType ?? '').toLowerCase();
    const kind =
      t === 'won' || t === 'success' || t === 'partial'
        ? ('funding_changed' as const)
        : t === 'lost' || t === 'failed'
          ? ('no_action' as const)
          : null;
    if (!kind) return;
    void this.outcomes.recordSystem(tenantId, {
      kind,
      sourceType: 'submission',
      sourceId: submissionId,
      clientId,
      evidence: { outcomeType: t, ...(outcomeText ? { outcome: outcomeText } : {}) },
    });
  }

  async updateHistory(
    ctx: TenantContext,
    clientId: string,
    id: string,
    input: UpdateSubmissionHistoryInput,
  ) {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const existing = await tx.clientSubmissionHistory.findFirst({
        where: { id, tenantId: ctx.tenantId, clientId },
        select: { id: true },
      });
      if (!existing) throw new NotFoundException('Submission history entry not found');
      const updated = await tx.clientSubmissionHistory.update({
        where: { id },
        data: {
          ...('fiscalYear' in input ? { fiscalYear: input.fiscalYear } : {}),
          ...('title' in input ? { title: input.title } : {}),
          ...('meta' in input ? { meta: input.meta ?? null } : {}),
          ...('outcome' in input ? { outcome: input.outcome ?? null } : {}),
          ...('outcomeType' in input ? { outcomeType: input.outcomeType ?? 'in_progress' } : {}),
          ...('notes' in input ? { notes: input.notes ?? null } : {}),
        },
      });
      if ('outcomeType' in input) {
        this.mirrorOutcome(ctx.tenantId, clientId, id, input.outcomeType, input.outcome ?? null);
      }
      return updated;
    });
  }

  async deleteHistory(ctx: TenantContext, clientId: string, id: string) {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const existing = await tx.clientSubmissionHistory.findFirst({
        where: { id, tenantId: ctx.tenantId, clientId },
        select: { id: true },
      });
      if (!existing) throw new NotFoundException('Submission history entry not found');
      await tx.clientSubmissionHistory.delete({ where: { id } });
      return { deleted: true };
    });
  }
}
