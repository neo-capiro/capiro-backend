import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  ClientAdvocacyMatterService,
  type FederalRegisterCorrelationSuggestion,
} from './client-advocacy-matter.service.js';
import { asRecord, asString } from './client-profile-fill.helpers.js';
import { buildRegulatoryOutcomeFinding } from './client-profile-fill-advocacy-mapping.js';
import type { AdvocacySourceBackfillState } from './client-profile-fill-advocacy-health.js';
import type { TenantAdvocacyDiscoveryPorts } from './client-profile-fill-advocacy-discovery.shared.js';

/** Existing Matter correlations emit review-only government-movement proposals. */
export class ClientProfileFillFederalRegisterDiscovery {
  constructor(
    private readonly prisma: PrismaService,
    private readonly advocacyMatters: ClientAdvocacyMatterService,
    private readonly ports: TenantAdvocacyDiscoveryPorts,
  ) {}

  async gather(
    ctx: TenantContext,
    clientId: string,
    runId: string,
    priorState: Record<string, unknown>,
  ): Promise<AdvocacySourceBackfillState> {
    const startedAt = asString(priorState.startedAt) ?? new Date().toISOString();
    const checkpointId = asString(asRecord(priorState.checkpoint).matterId);
    const backfillComplete = asString(priorState.status) === 'complete';
    const lastSuccessAt = asString(priorState.lastSuccessAt);
    try {
      const matters = await this.readEligibleMatters(
        ctx,
        clientId,
        backfillComplete,
        lastSuccessAt,
        checkpointId,
      );
      const correlations = await this.correlateMatters(ctx, clientId, runId, matters);
      const complete = backfillComplete || matters.length < 50;
      return {
        status: complete ? 'complete' : 'in_progress',
        startedAt,
        completedAt: complete ? new Date().toISOString() : undefined,
        checkpoint: backfillComplete
          ? Object.keys(asRecord(priorState.checkpoint)).length
            ? asRecord(priorState.checkpoint)
            : null
          : matters.at(-1)
            ? { matterId: matters.at(-1)!.id }
            : null,
        historyStart: null,
        examined: Number(priorState.examined ?? 0) + matters.length,
        candidates: Number(priorState.candidates ?? 0) + correlations.candidates,
        lastError: null,
        suggestions: correlations.suggestions,
      };
    } catch (error) {
      const lastError = this.ports.safeError(error);
      this.ports.warn(`Federal Register correlation backfill unavailable: ${lastError}`);
      return {
        status: 'partial',
        startedAt,
        checkpoint: null,
        historyStart: null,
        examined: 0,
        candidates: 0,
        lastError,
      };
    }
  }

  private readEligibleMatters(
    ctx: TenantContext,
    clientId: string,
    backfillComplete: boolean,
    lastSuccessAt: string | null,
    checkpointId: string | null,
  ): Promise<Array<{ id: string }>> {
    return this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT m.id
             FROM client_advocacy_matter m
            WHERE m.tenant_id = $1::uuid AND m.client_id = $2::uuid
              AND EXISTS (
                SELECT 1 FROM client_advocacy_matter_link l
                 WHERE l.tenant_id = m.tenant_id AND l.matter_id = m.id
                   AND l.link_type IN ('regulatory_docket', 'regulatory_document')
              )
              AND (NOT $3::boolean
                OR m.updated_at > $4::timestamptz
                OR EXISTS (
                  SELECT 1 FROM client_advocacy_matter_link changed
                   WHERE changed.tenant_id = m.tenant_id AND changed.matter_id = m.id
                     AND changed.link_type IN ('regulatory_docket', 'regulatory_document')
                     AND changed.created_at > $4::timestamptz
                ))
              AND ($3::boolean OR $5::uuid IS NULL OR m.id > $5::uuid)
            ORDER BY CASE WHEN $3::boolean THEN m.updated_at END ASC NULLS FIRST, m.id ASC
            ${backfillComplete ? '' : 'LIMIT 50'}`,
        ctx.tenantId,
        clientId,
        backfillComplete,
        lastSuccessAt ?? '1970-01-01T00:00:00.000Z',
        checkpointId,
      ),
    );
  }

  private async correlateMatters(
    ctx: TenantContext,
    clientId: string,
    runId: string,
    matters: Array<{ id: string }>,
  ): Promise<{ candidates: number; suggestions: unknown[] }> {
    let candidates = 0;
    const suggestions: unknown[] = [];
    for (const matter of matters) {
      const matterSuggestions = await this.advocacyMatters.suggestFederalRegisterCorrelations(
        ctx,
        clientId,
        matter.id,
      );
      candidates += matterSuggestions.length;
      suggestions.push(
        ...matterSuggestions.map((suggestion) => ({ matterId: matter.id, ...suggestion })),
      );
      await this.emitRegulatoryOutcomeFindings(ctx, clientId, runId, matter.id, matterSuggestions);
    }
    return { candidates, suggestions };
  }

  // Emission remains public for the existing Completion compatibility seam.
  async emitRegulatoryOutcomeFindings(
    ctx: TenantContext,
    clientId: string,
    runId: string,
    matterId: string,
    suggestions: FederalRegisterCorrelationSuggestion[],
  ): Promise<void> {
    const deterministic = suggestions.filter(
      (suggestion) => suggestion.matchedDocketIds.length > 0,
    );
    if (deterministic.length === 0) return;
    const earliest = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.$queryRawUnsafe<Array<{ earliestActivityDate: Date | null }>>(
        `SELECT MIN(activity_date) AS "earliestActivityDate"
           FROM client_advocacy_record
          WHERE tenant_id = $1::uuid AND client_id = $2::uuid AND matter_id = $3::uuid
            AND source_type = 'regulatory_comment'`,
        ctx.tenantId,
        clientId,
        matterId,
      ),
    );
    const attributableActivityDate = earliest[0]?.earliestActivityDate ?? null;
    for (const suggestion of deterministic) {
      const proposedValue = buildRegulatoryOutcomeFinding(
        matterId,
        suggestion,
        attributableActivityDate,
      );
      if (!proposedValue) continue;
      const docketId = proposedValue.docketId as string;
      await this.ports.persistFinding(ctx.tenantId, clientId, runId, {
        kind: 'regulatory_outcome',
        targetKey: `regulatory-outcome:${matterId}:${suggestion.documentNumber}`,
        source: 'federal_register',
        factKind: 'recommendation',
        currentValue: null,
        proposedValue,
        confidence: 0.95,
        status: 'pending',
        evidence: [
          {
            label: `${suggestion.documentType} published on docket ${docketId}, after the client's Regulations.gov submission`,
            url: suggestion.sourceUrl,
            source: 'Federal Register government-movement correlation',
            metadata: {
              documentNumber: suggestion.documentNumber,
              docketId,
              causationClaimed: false,
              matchedOn: 'docket_id',
            },
          },
        ],
      });
    }
  }
}
