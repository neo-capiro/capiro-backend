/**
 * R5 District Brief — deterministic brief builder + DOCX export + client save.
 *
 * buildDraft is deterministic: every sentence derives from an R5Fact or R5Gap,
 * no LLM. The brief structure follows the contract: verified_footprint,
 * economic_context, opportunities, representation_and_requests, recent_changes,
 * next_steps (rule-based from gaps), missing_information.
 */

import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { R5DistrictContextService } from './r5-district-context.service.js';
import { ClientDocumentWriterService } from '../../client-documents/client-document-writer.service.js';
import {
  DOCX_MIME,
  formatMemoDate,
  renderMemoDocx,
  type MemoDocInput,
} from '../../intelligence/alert-memo/alert-memo-docx.js';
import type {
  R5Brief,
  R5BriefSection,
  R5BriefExportInput,
  R5BriefSaveInput,
  R5BriefSaveResult,
  R5Fact,
} from './r5-types.js';

// ── Section builders ────────────────────────────────────────────────────────

const SECTION_DEFS: Array<{ key: string; title: string }> = [
  { key: 'verified_footprint', title: 'Verified Footprint' },
  { key: 'economic_context', title: 'Economic Context' },
  { key: 'opportunities', title: 'Opportunities' },
  { key: 'representation_and_requests', title: 'Representation & Requests' },
  { key: 'recent_changes', title: 'Recent Changes' },
  { key: 'next_steps', title: 'Next Steps' },
  { key: 'missing_information', title: 'Missing Information' },
];

function factsBySection(facts: R5Fact[], section: string): R5Fact[] {
  return facts.filter((f) => f.section === section);
}

function formatFact(f: R5Fact): string {
  const parts: string[] = [f.label];
  if (f.value != null) {
    const v = typeof f.value === 'number' ? f.value.toLocaleString('en-US') : f.value;
    parts.push(`: ${v}${f.unit ? ` ${f.unit}` : ''}`);
  }
  if (f.amountStage) {
    parts.push(` (${f.amountStage})`);
  }
  return parts.join('');
}

function formatCurrency(n: number): string {
  return `$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

@Injectable()
export class R5DistrictBriefService {
  private readonly logger = new Logger(R5DistrictBriefService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly contextService: R5DistrictContextService,
    private readonly clientDocuments: ClientDocumentWriterService,
  ) {}

  // ── Draft ─────────────────────────────────────────────────────────────────

  async buildDraft(
    tenantId: string,
    clientId: string,
    state: string,
    district: string,
  ): Promise<R5Brief> {
    const ctx = await this.contextService.getContext(tenantId, clientId, state, district);

    const sections: R5BriefSection[] = SECTION_DEFS.map((def) => {
      const relevant = factsBySection(ctx.facts, def.key);
      const paragraphs = buildParagraphs(def.key, relevant, ctx);
      return {
        key: def.key,
        title: def.title,
        paragraphs,
        factIds: relevant.map((f) => f.id),
      };
    });

    return {
      clientId: ctx.clientId,
      clientName: ctx.clientName,
      state: ctx.state,
      district: ctx.district,
      sections,
      facts: ctx.facts,
      gaps: ctx.gaps,
      sourceHealth: ctx.sourceHealth,
      generatedAt: ctx.generatedAt,
    };
  }

  // ── Export DOCX ───────────────────────────────────────────────────────────

  async exportDocx(
    tenantId: string,
    clientId: string,
    state: string,
    district: string,
    sections: Array<{ key: string; title: string; paragraphs: string[] }>,
    factIds: string[],
  ): Promise<{ buffer: Buffer; fileName: string }> {
    const ctx = await this.contextService.getContext(tenantId, clientId, state, district);

    // Validate factIds — reject unknowns
    const knownIds = new Set(ctx.facts.map((f) => f.id));
    const unknowns = factIds.filter((id) => !knownIds.has(id));
    if (unknowns.length > 0) {
      throw new BadRequestException(
        `Unknown factIds: ${unknowns.slice(0, 5).join(', ')}${unknowns.length > 5 ? ` and ${unknowns.length - 5} more` : ''}`,
      );
    }

    const sources = factIds
      .map((id) => ctx.facts.find((f) => f.id === id))
      .filter((f): f is R5Fact => f != null)
      .map((f) => ({
        source: f.source,
        date: f.asOf.date,
        fiscalYear: f.asOf.fiscalYear,
        sourceYear: f.asOf.sourceYear,
        unit: f.unit,
        amountStage: f.amountStage,
        geography: f.geography,
        freshness: f.freshness,
        coverage: f.coverage,
      }));

    const memoInput: MemoDocInput = {
      clientName: ctx.clientName,
      dateStr: formatMemoDate(),
      reLine: `District Brief — ${ctx.state}-${ctx.district}`,
      sections: sections.map((s) => ({
        heading: s.title,
        paragraphs: s.paragraphs.length ? s.paragraphs : ['No information available.'],
      })),
      sources: sources.map((s) => ({
        label: `${s.source.label}${s.date ? ` (${s.date.slice(0, 10)})` : ''}${s.fiscalYear ? ` FY${s.fiscalYear}` : ''}`,
        url: s.source.url,
      })),
    };

    const buffer = await renderMemoDocx(memoInput);
    const fileName = `district-brief-${ctx.state}-${ctx.district}.docx`.toLowerCase();

    return { buffer, fileName };
  }

  // ── Save to client ────────────────────────────────────────────────────────

  async saveToClient(
    ctx: TenantContext,
    input: R5BriefSaveInput,
  ): Promise<R5BriefSaveResult> {
    const { buffer, fileName } = await this.exportDocx(
      ctx.tenantId,
      input.clientId,
      input.state,
      input.district,
      input.sections,
      input.factIds,
    );

    const contentHash = createHash('sha256').update(buffer).digest('hex').slice(0, 32);
    const stateDistrict = `${input.state}-${input.district}`;
    const idempotencyKey = `district-nexus-brief:${input.clientId}:${stateDistrict}:${contentHash}`;

    const saved = await this.clientDocuments.createAttachmentFromBuffer(ctx, {
      clientId: input.clientId,
      fileName,
      contentType: DOCX_MIME,
      buffer,
      source: 'district_nexus_brief',
      sourceEntityType: 'district',
      sourceEntityId: stateDistrict,
      idempotencyKey,
    });

    return { attachmentId: saved.id, fileName: saved.fileName };
  }
}

// ── Deterministic paragraph builders ────────────────────────────────────────

function buildParagraphs(
  sectionKey: string,
  facts: R5Fact[],
  ctx: R5Brief['facts'] extends (infer F)[] ? { facts: F[]; gaps: R5Brief['gaps'] } : never,
): string[] {
  switch (sectionKey) {
    case 'verified_footprint':
      return buildVerifiedFootprint(facts as R5Fact[]);
    case 'economic_context':
      return buildEconomicContext(facts as R5Fact[]);
    case 'opportunities':
      return buildOpportunities(facts as R5Fact[]);
    case 'representation_and_requests':
      return buildRepresentation(facts as R5Fact[]);
    case 'recent_changes':
      return buildChanges(facts as R5Fact[]);
    case 'next_steps':
      return buildNextSteps((ctx as { gaps: R5Brief['gaps'] }).gaps);
    case 'missing_information':
      return buildMissingInfo((ctx as { gaps: R5Brief['gaps'] }).gaps);
    default:
      return ['No information available for this section.'];
  }
}

function buildVerifiedFootprint(facts: R5Fact[]): string[] {
  const paragraphs: string[] = [];
  const facilities = facts.filter((f) => f.source.type === 'facility');
  const evidence = facts.filter((f) => f.section === 'footprint' && f.source.type !== 'facility');

  if (facilities.length > 0) {
    const totalEmployees = facilities.reduce((sum, f) => sum + (typeof f.value === 'number' ? f.value : 0), 0);
    paragraphs.push(
      `${facilities.length} client facility location${facilities.length > 1 ? 's' : ''} identified in this district${
        totalEmployees > 0 ? `, with ${totalEmployees.toLocaleString('en-US')} employees` : ''
      }.`,
    );
    for (const f of facilities) {
      const emp = typeof f.value === 'number' && f.value > 0 ? ` (${f.value} employees)` : '';
      paragraphs.push(`- ${f.label}${emp}`);
    }
  }

  if (evidence.length > 0) {
    const totalAwarded = evidence.reduce((sum, f) => {
      return sum + (typeof f.value === 'number' && f.amountStage !== 'forecast' ? f.value : 0);
    }, 0);
    if (totalAwarded > 0) {
      paragraphs.push(`Total identified federal obligations: ${formatCurrency(totalAwarded)}.`);
    }
    for (const e of evidence) {
      paragraphs.push(`- ${formatFact(e)} [${e.basis === 'verified_client_nexus' ? 'verified' : 'public'}, ${e.coverage}]`);
    }
  }

  if (facilities.length === 0 && evidence.length === 0) {
    paragraphs.push('No verified federal footprint identified for this client in this district.');
  }

  return paragraphs;
}

function buildEconomicContext(facts: R5Fact[]): string[] {
  const paragraphs: string[] = [];
  const metrics = facts.filter((f) => f.section === 'economic');

  if (metrics.length === 0) {
    paragraphs.push('No public economic data available for this district.');
    return paragraphs;
  }

  for (const m of metrics) {
    paragraphs.push(`- ${formatFact(m)}`);
  }

  return paragraphs;
}

function buildOpportunities(facts: R5Fact[]): string[] {
  const paragraphs: string[] = [];
  const opps = facts.filter((f) => f.section === 'opportunities');

  if (opps.length === 0) {
    paragraphs.push('No grant opportunities identified for this district.');
    return paragraphs;
  }

  const totalForecast = opps.reduce((sum, f) => sum + (typeof f.value === 'number' ? f.value : 0), 0);
  paragraphs.push(`${opps.length} opportunity sources identified, with ${formatCurrency(totalForecast)} in estimated funding.`);
  for (const o of opps) {
    paragraphs.push(`- ${formatFact(o)}`);
  }

  return paragraphs;
}

function buildRepresentation(facts: R5Fact[]): string[] {
  const paragraphs: string[] = [];
  const reps = facts.filter((f) => f.section === 'representation');
  const cpfRequested = facts.filter((f) => f.section === 'cpf_cds' && f.amountStage === 'requested');
  const cpfEnacted = facts.filter((f) => f.section === 'cpf_cds' && f.amountStage === 'enacted');

  if (reps.length > 0) {
    const house = reps.filter((f) => f.source.type === 'congress_member' && f.source.label === 'US House member');
    const senate = reps.filter((f) => f.source.type === 'congress_member' && f.source.label === 'US Senator');
    if (house.length > 0) {
      paragraphs.push(`House representation: ${house.map((f) => f.label).join(', ')}.`);
    }
    if (senate.length > 0) {
      paragraphs.push(`Senate representation: ${senate.map((f) => f.label).join(', ')}.`);
    }
  }

  // CPF/CDS — requested vs enacted kept separate
  if (cpfRequested.length > 0) {
    const totalRequested = cpfRequested.reduce((sum, f) => sum + (typeof f.value === 'number' ? f.value : 0), 0);
    paragraphs.push(`CPF/CDS funding requested: ${formatCurrency(totalRequested)} across ${cpfRequested.length} request(s).`);
  }
  if (cpfEnacted.length > 0) {
    const totalEnacted = cpfEnacted.reduce((sum, f) => sum + (typeof f.value === 'number' ? f.value : 0), 0);
    paragraphs.push(`CPF/CDS funding enacted: ${formatCurrency(totalEnacted)} across ${cpfEnacted.length} item(s).`);
  }

  if (reps.length === 0 && cpfRequested.length === 0) {
    paragraphs.push('No representation data or CPF/CDS requests available.');
  }

  return paragraphs;
}

function buildChanges(facts: R5Fact[]): string[] {
  const paragraphs: string[] = [];
  const changes = facts.filter((f) => f.section === 'changes');

  if (changes.length === 0) {
    paragraphs.push('No recent changes detected for this district.');
    return paragraphs;
  }

  paragraphs.push(`${changes.length} recent change(s) detected:`);
  for (const c of changes) {
    paragraphs.push(`- ${c.label}`);
  }

  return paragraphs;
}

function buildNextSteps(gaps: R5Brief['gaps']): string[] {
  const paragraphs: string[] = [];
  const identityGaps = gaps.some((g) => g.section === 'footprint' && g.reason.includes('Client not found'));
  const missingFootprint = gaps.some((g) => g.section === 'footprint');

  if (identityGaps || missingFootprint) {
    paragraphs.push('Confirm contracting identity to unlock verified footprint data.');
  }
  if (gaps.some((g) => g.section === 'cpf_cds')) {
    paragraphs.push('Review CPF/CDS data availability for this district.');
  }
  if (gaps.some((g) => g.section === 'economic')) {
    paragraphs.push('Review economic context data for completeness.');
  }

  if (paragraphs.length === 0) {
    paragraphs.push('Review this brief with the client team to identify engagement priorities.');
  }

  return paragraphs;
}

function buildMissingInfo(gaps: R5Brief['gaps']): string[] {
  if (gaps.length === 0) {
    return ['All data rails loaded successfully.'];
  }

  const paragraphs: string[] = ['The following data sources are unavailable or incomplete:'];
  for (const g of gaps) {
    paragraphs.push(`- ${g.section}: ${g.reason}${g.source ? ` (source: ${g.source})` : ''}`);
  }

  return paragraphs;
}