import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { recordAiUsageEvent, type TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  PortfolioAgentService,
  type PortfolioAgentAudit,
} from '../clients/portfolio-agent.service.js';
import { impactAgentConfig } from '../legiwatch-impact/impact-agent.config.js';
import { IMPACT_GROUNDING_INSTRUCTIONS } from '../legiwatch-impact/impact-analysis.schema.js';
import { loadImpactProfileContext } from '../legiwatch-impact/impact-client-evidence.js';
import { requireOwnerClient } from '../clients/client-ordered-owner.access.js';
import {
  clientImpactContext,
  impactPassages,
  verifyImpactDraft,
  verifyImpactReview,
  IMPACT_PROMPT,
  IMPACT_SCHEMA,
  IMPACT_REVIEW_SCHEMA,
  type ImpactVersion,
} from './bill-impact.evidence.js';

export const IMPACT_STATE_SQL = `SELECT document_id AS id, revision_hash AS revision, coalesce(version_type,title,document_id) AS label,
source_url AS "sourceUrl", event_date::text AS "publishedDate", coverage, extraction_state AS "extractionState",
coalesce(octet_length(sections::text)>400000,false) AS oversized,
CASE WHEN octet_length(sections::text)<=400000 THEN sections ELSE '[]'::jsonb END AS sections
FROM legiwatch_research_document_source WHERE bill_id=$1 AND jurisdiction='FL' AND session_key=$2 AND document_kind='text' AND is_current
ORDER BY document_id COLLATE "C" LIMIT 51`;
export const IMPACT_FEDERAL_SQL = `SELECT r.id::text AS id, r.extraction_hash AS revision, r.version_code AS label,
r.source_url AS "sourceUrl", (r.published_at AT TIME ZONE 'UTC')::date::text AS "publishedDate", r.completeness,
length(r.extracted_text)>90000 AS oversized,
CASE WHEN length(r.extracted_text)<=90000 THEN r.extracted_text ELSE '' END AS text
FROM federal_evidence_current c JOIN federal_evidence_revision r ON r.id=c.revision_id
WHERE c.bill_id=$1 AND c.state='present' AND c.collection='BILLS' AND r.bill_id=$1 AND r.version_code IS NOT NULL
ORDER BY r.id LIMIT 51`;
type Client = {
  id: string;
  name: string;
  description: string | null;
  productDescription: string | null;
  evidenceRevision: string;
};
type Lifecycle = {
  title: string;
  latestAction: string | null;
  actionDate: string | null;
  sourceUrl: string | null;
};
type Row = Record<string, any>;
const digest = (value: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(value ?? null))
    .digest('hex');

@Injectable()
export class BillImpactService {
  private readonly logger = new Logger(BillImpactService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly agent: PortfolioAgentService,
  ) {}

  private async client(ctx: TenantContext, clientId: string): Promise<Client> {
    if (!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(clientId ?? ''))
      throw new BadRequestException('Select a client.');
    return this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      const flags = await tx.$queryRawUnsafe<Array<{ enabled: boolean }>>(
        'SELECT enabled FROM intel_feature_flag WHERE tenant_id=$1 AND feature=$2',
        ctx.tenantId,
        'bill_360',
      );
      if (!(flags[0]?.enabled ?? process.env.CAPIRO_INTERNAL_TENANT_ID === ctx.tenantId))
        throw new NotFoundException('Bill impact is unavailable.');
      await requireOwnerClient(tx, ctx, clientId, false, false, 'share');
      const client = await tx.client.findFirst({
        where: { tenantId: ctx.tenantId, id: clientId },
        select: { id: true, name: true },
      });
      if (!client) throw new NotFoundException('Client unavailable.');
      const context = await loadImpactProfileContext(tx, ctx, clientId);
      return { id: client.id, name: client.name, ...context };
    });
  }

  private async source(
    billId: string,
  ): Promise<{ versions: ImpactVersion[]; lifecycle: Lifecycle }> {
    let versions: ImpactVersion[], lifecycle: Lifecycle[];
    const state = /^fl-(\d{4}(?:x\d+)?)-[a-z]+\d+[a-z]?$/i.exec(billId);
    if (state) {
      lifecycle = await this.prisma.$queryRawUnsafe<Lifecycle[]>(
        `SELECT title,latest_action_text AS "latestAction",latest_action_date::text AS "actionDate",coalesce(state_url,url) AS "sourceUrl" FROM state_bill WHERE id=$1 AND state='FL' AND session_key=$2`,
        billId,
        state[1],
      );
      const rows = await this.prisma.$queryRawUnsafe<Row[]>(IMPACT_STATE_SQL, billId, state[1]);
      versions = rows.map((r) => {
        const valid =
          Array.isArray(r.sections) &&
          r.sections.length > 0 &&
          r.sections.every(
            (s: Row) =>
              s &&
              typeof s.locator === 'string' &&
              typeof s.text === 'string' &&
              typeof s.hash === 'string',
          );
        return {
          id: r.id,
          revision: r.revision,
          label: r.label,
          sourceUrl: r.sourceUrl ?? '',
          publishedDate: r.publishedDate,
          complete:
            valid && r.coverage === 'complete_document' && r.extractionState === 'extracted',
          unavailableReason: r.oversized
            ? 'This complete text exceeds the draft limit. Review it in Research; no partial impact draft was generated.'
            : undefined,
          sections: valid ? r.sections.map((s: Row) => ({ locator: s.locator, text: s.text })) : [],
        };
      });
    } else if (/^\d{3}-(?:hr|s|hjres|sjres|hconres|sconres|hres|sres)-\d+$/.test(billId)) {
      lifecycle = await this.prisma.$queryRawUnsafe<Lifecycle[]>(
        `SELECT title,latest_action_text AS "latestAction",latest_action_date::text AS "actionDate",url AS "sourceUrl" FROM congress_bill WHERE id=$1`,
        billId,
      );
      const rows = await this.prisma.$queryRawUnsafe<Row[]>(IMPACT_FEDERAL_SQL, billId);
      versions = rows.map((r) => ({
        id: r.id,
        revision: r.revision,
        label: r.label,
        sourceUrl: r.sourceUrl ?? '',
        publishedDate: r.publishedDate,
        complete:
          r.completeness === 'complete' && typeof r.text === 'string' && r.text.trim().length > 0,
        unavailableReason: r.oversized
          ? 'This complete text exceeds the draft limit. Review it in Research; no partial impact draft was generated.'
          : undefined,
        sections:
          typeof r.text === 'string'
            ? r.text
                .split(/\n\s*\n/)
                .filter((s: string) => s.trim())
                .map((text: string, i: number) => ({ locator: `Paragraph ${i + 1}`, text }))
            : [],
      }));
    } else throw new BadRequestException('Select an exact federal or Florida bill.');
    if (!lifecycle[0]) throw new NotFoundException('Bill not found.');
    if (versions.length > 50)
      throw new BadRequestException(
        'The retained version list exceeds the draft limit. Review the bill in Research.',
      );
    return { versions, lifecycle: lifecycle[0] };
  }

  async options(ctx: TenantContext, billId: string, clientId: string) {
    const client = await this.client(ctx, clientId);
    const source = await this.source(billId);
    let contextUnavailable: string | null = null;
    try {
      clientImpactContext(client);
    } catch (error) {
      contextUnavailable = (error as Error).message;
    }
    return {
      client: { id: client.id, name: client.name },
      lifecycle: source.lifecycle,
      contextUnavailable,
      versions: source.versions.map((v) => {
        let unavailableReason: string | null = null;
        try {
          impactPassages(v);
        } catch (error) {
          unavailableReason = (error as Error).message;
        }
        const { sections: _, ...metadata } = v;
        return { ...metadata, unavailableReason };
      }),
    };
  }

  async generate(
    ctx: TenantContext,
    billId: string,
    input: { clientId: string; versionId: string; revision: string },
  ) {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new ServiceUnavailableException('The impact draft timed out. No draft was saved.'));
      }, 145_000);
    });
    try {
      return await Promise.race([
        this.generateWithinBudget(ctx, billId, input, controller.signal),
        deadline,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async generateWithinBudget(
    ctx: TenantContext,
    billId: string,
    input: { clientId: string; versionId: string; revision: string },
    signal: AbortSignal,
  ) {
    const client = await this.client(ctx, input.clientId);
    const context = clientImpactContext(client),
      source = await this.source(billId);
    const version = source.versions.find(
      (v) => v.id === input.versionId && v.revision === input.revision,
    );
    if (!version)
      throw new ConflictException(
        'The selected text version changed or is unavailable. Reload the version list.',
      );
    const passages = impactPassages(version);
    signal.throwIfAborted();
    const usage: PortfolioAgentAudit[] = [];
    let result: ReturnType<typeof verifyImpactDraft>;
    try {
      const config = impactAgentConfig();
      const request = {
        ...config,
        subject: { kind: 'client' as const, id: client.id },
        signal,
        sources: [
          {
            id: 'bill-text',
            url: version.sourceUrl,
            text: passages
              .map((passage) => `${passage.id} | ${passage.locator}\n${passage.text}`)
              .join('\n\n'),
          },
          {
            id: 'client-profile',
            text: context.map((fact) => `${fact.id} | ${fact.label}\n${fact.text}`).join('\n\n'),
          },
        ],
        onAudit: async (audit: PortfolioAgentAudit) => {
          usage.push(audit);
        },
      };
      const prompt = {
        billId,
        version: { id: version.id, revision: version.revision, label: version.label },
        lifecycle: source.lifecycle,
        client: { name: client.name },
      };
      const completion = await this.agent.extract({
        ...request,
        task: 'bill_impact_review',
        schemaVersion: 'bill-impact-review-v1',
        instructions: IMPACT_PROMPT,
        prompt: JSON.stringify(prompt),
        schema: IMPACT_SCHEMA,
        timeoutMs: Math.floor((config.timeoutMs! * 2) / 3),
        maxBudgetUsd: (config.maxBudgetUsd! * 2) / 3,
      });
      result = verifyImpactDraft(completion.data, passages, context);
      // Quotation membership is not entailment; retain the independent substantive check.
      if (result.impacts.length) {
        const review = await this.agent.extract({
          ...request,
          task: 'bill_impact_grounding',
          schemaVersion: 'bill-impact-grounding-v1',
          instructions: IMPACT_GROUNDING_INSTRUCTIONS,
          schema: IMPACT_REVIEW_SCHEMA,
          prompt: JSON.stringify({
            ...prompt,
            impacts: result.impacts.map((item, index) => ({
              index,
              possibleImplication: item.possibleImplication,
              assumptions: item.assumptions,
              verificationStep: item.verificationStep,
              evidenceIds: item.evidence.map((e) => e.id),
              clientIds: item.clientBasis.map((c) => c.id),
            })),
          }),
          timeoutMs: Math.floor(config.timeoutMs! / 3),
          maxBudgetUsd: config.maxBudgetUsd! / 3,
        });
        signal.throwIfAborted();
        verifyImpactReview(review.data, result.impacts.length);
      }
    } catch {
      // No source/client prose is logged, and no unsupported fallback is returned.
      throw new ServiceUnavailableException(
        'The impact draft could not be verified. No draft was saved.',
      );
    } finally {
      for (const audit of usage)
        await recordAiUsageEvent(
          { prisma: this.prisma, logger: this.logger },
          { tenantId: ctx.tenantId, userId: ctx.userId },
          audit.task,
          {
            provider: audit.provider,
            model: audit.model,
            usage: {
              inputTokens: audit.inputTokens,
              outputTokens: audit.outputTokens,
              cacheReadTokens: audit.cacheReadTokens,
              cacheCreationTokens: audit.cacheWriteTokens,
            },
            usedTenantKey: false,
          },
        );
    }
    // Reauthorize and detect revoked access or changed evidence/profile during generation.
    signal.throwIfAborted();
    const currentClient = await this.client(ctx, input.clientId),
      current = await this.source(billId);
    if (
      digest(currentClient) !== digest(client) ||
      digest(current.versions.find((v) => v.id === version.id)) !== digest(version) ||
      digest(current.lifecycle) !== digest(source.lifecycle)
    )
      throw new ConflictException(
        'The bill evidence or client context changed. Generate a fresh draft.',
      );
    signal.throwIfAborted();
    return {
      ...result,
      billId,
      client: { id: client.id, name: client.name },
      lifecycle: current.lifecycle,
      version: {
        id: version.id,
        revision: version.revision,
        label: version.label,
        sourceUrl: version.sourceUrl,
        publishedDate: version.publishedDate,
      },
      reviewRequired: true,
      generatedAt: new Date().toISOString(),
      coverage:
        'Complete selected text supplied; other versions, amendments and companion bills are not assessed.',
    };
  }
}
