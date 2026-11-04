import { Injectable } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { requireOwnerActor } from './client-ordered-owner.access.js';
import { requireProfileSubject } from './profile-subject.js';
import { assertSharedProfileEvidence } from './profile-shared-evidence.js';
import {
  PortfolioAgentError,
  PortfolioAgentService,
  type PortfolioAgentAudit,
} from './portfolio-agent.service.js';
import {
  ProfileSuggestionSourcesService,
  type ProfileSuggestionSource,
} from './profile-suggestion-sources.service.js';
import {
  registrationSuggestionCatalog,
  type SuggestionCatalogEntry,
} from './profile-suggestion-catalog.js';
import {
  parseRegistrationSuggestionRequest,
  type RegistrationSuggestion,
  type RegistrationSuggestionRequest,
  type RegistrationSuggestionResult,
} from './profile-suggestion.contracts.js';

interface ExtractedSuggestions {
  suggestions: Array<{
    code: string;
    reason: string;
    sourceId: string;
    quote: string;
    confidence: number;
  }>;
}

/** The draft stays unsaved. Only explicit person acceptance can enter profile facts. */
@Injectable()
export class ProfileRegistrationSuggestionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly agent: PortfolioAgentService,
    private readonly reader: ProfileSuggestionSourcesService,
  ) {}

  private access(ctx: TenantContext, input: RegistrationSuggestionRequest) {
    return this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      await requireOwnerActor(tx, ctx);
      if (input.subject) await requireProfileSubject(tx, ctx, input.subject);
      if (input.subject && input.attachmentIds?.length)
        await assertSharedProfileEvidence(
          tx,
          ctx.tenantId,
          input.subject,
          input.attachmentIds.map((attachmentId) => ({ attachmentId })),
          ctx,
        );
    });
  }

  async suggest(
    ctx: TenantContext,
    raw: unknown,
    signal?: AbortSignal,
  ): Promise<RegistrationSuggestionResult> {
    const input = parseRegistrationSuggestionRequest(raw);
    await this.access(ctx, input);
    const sourceGaps: string[] = [];
    const sources: ProfileSuggestionSource[] = [
      {
        id: 'person_context',
        label: 'Person-provided company context',
        source: 'person_context',
        observedAt: new Date().toISOString(),
        text: JSON.stringify({
          identity: input.identity,
          context: input.contextText ?? '',
          identifiers: input.existingIdentifiers ?? {},
        }),
      },
    ];
    if (input.identity.website) {
      try {
        sources.push(await this.reader.website(input.identity.website, signal));
      } catch {
        sourceGaps.push('The provided company website could not be read.');
      }
    }
    for (const id of [...new Set(input.attachmentIds ?? [])]) {
      try {
        sources.push(await this.reader.document(ctx, input.subject!, id, signal));
      } catch {
        sourceGaps.push('A selected document could not be read.');
      }
    }
    await this.access(ctx, input);
    signal?.throwIfAborted();
    const catalog = await registrationSuggestionCatalog(this.prisma, input.field);
    const classify = ['naicsCodes', 'pscCodes', 'issueCodes'].includes(input.field);
    const base = { requestId: input.requestId, field: input.field, sourceGaps };
    if (classify && !catalog.entries.size)
      return {
        ...base,
        status: 'unavailable',
        message: 'The official code reference is unavailable.',
        suggestions: [],
      };
    const schema = this.schema(
      sources.map((source) => source.id),
      classify ? [...catalog.entries.keys()] : undefined,
    );
    try {
      const { data } = await this.agent.extract<ExtractedSuggestions>({
        subject: { kind: 'draft', id: input.requestId },
        task: 'registration_suggestions',
        instructions: `Suggest values only for ${input.field}. Use the person-provided company context, provided website or selected documents. ${classify ? 'Choose codes only from the supplied official reference. Classification fit is a suggestion, never a claim that the company is officially registered with that code.' : 'UEI and CAGE are exact identifiers: return only a complete literal identifier stated in a company source; never infer, complete or invent one.'} Every suggestion must cite a verbatim quote from company context, website or document, not just the reference catalog. Omit weak or unsupported suggestions. Return no more than six. Do not mutate or save anything.`,
        prompt: JSON.stringify({
          field: input.field,
          company: input.identity.name,
          alreadyEntered: input.currentValue ?? null,
        }),
        sources: [...sources, ...catalog.sources],
        schema,
        schemaVersion: 'registration-suggestions-v1',
        maxTurns: 4,
        maxBudgetUsd: 0.5,
        timeoutMs: 60_000,
        signal,
        onAudit: (audit) => this.audit(ctx, input, audit),
      });
      await this.access(ctx, input);
      const suggestions = this.verifiedSuggestions(input, data, sources, catalog.entries);
      return {
        ...base,
        status: suggestions.length ? 'complete' : 'empty',
        suggestions,
        message: suggestions.length
          ? 'Review each suggestion and its sources before accepting it.'
          : 'No additional source-supported values were found.',
      };
    } catch (error) {
      if (!(error instanceof PortfolioAgentError)) throw error;
      await this.access(ctx, input);
      return {
        ...base,
        status: 'unavailable',
        suggestions: [],
        message: 'Meri could not produce verified suggestions. Your entered values are unchanged.',
      };
    }
  }

  private schema(sourceIds: string[], codes?: string[]): Record<string, unknown> {
    return {
      type: 'object',
      additionalProperties: false,
      required: ['suggestions'],
      properties: {
        suggestions: {
          type: 'array',
          maxItems: 6,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['code', 'reason', 'sourceId', 'quote', 'confidence'],
            properties: {
              code: { type: 'string', maxLength: 12, ...(codes ? { enum: codes } : {}) },
              reason: { type: 'string', minLength: 1, maxLength: 600 },
              sourceId: { type: 'string', enum: sourceIds },
              quote: { type: 'string', minLength: 1, maxLength: 240 },
              confidence: { type: 'number', minimum: 0, maximum: 1 },
            },
          },
        },
      },
    };
  }

  private verifiedSuggestions(
    input: RegistrationSuggestionRequest,
    data: ExtractedSuggestions,
    sources: ProfileSuggestionSource[],
    catalog: Map<string, SuggestionCatalogEntry>,
  ): RegistrationSuggestion[] {
    const existing = new Set(
      (Array.isArray(input.currentValue) ? input.currentValue : [input.currentValue ?? '']).map(
        (value) => value.trim().toUpperCase(),
      ),
    );
    const result = new Map<string, RegistrationSuggestion>();
    for (const suggestion of data.suggestions ?? []) {
      const code = suggestion.code.trim().toUpperCase(),
        source = sources.find((item) => item.id === suggestion.sourceId);
      if (
        !source ||
        !suggestion.quote.trim() ||
        !source.text.includes(suggestion.quote) ||
        existing.has(code)
      )
        continue;
      const reference = catalog.get(code);
      const identifier = input.field === 'uei' || input.field === 'cageCode';
      if (
        identifier
          ? !(input.field === 'uei' ? /^[A-Z0-9]{12}$/ : /^[A-Z0-9]{5}$/).test(code) ||
            !new RegExp(`\\b${code}\\b`, 'i').test(suggestion.quote)
          : !reference
      )
        continue;
      const evidence = [
        {
          label: source.label,
          ...(source.url ? { url: source.url } : {}),
          ...(source.attachmentId ? { attachmentId: source.attachmentId } : {}),
          excerpt: suggestion.quote,
          source: source.source,
          observedAt: source.observedAt,
        },
      ];
      result.set(code, {
        code,
        label: reference?.label ?? (input.field === 'uei' ? 'Unique Entity ID (UEI)' : 'CAGE code'),
        reason: suggestion.reason,
        confidence: suggestion.confidence,
        evidence,
        ...(reference?.reference ? { reference: reference.reference } : {}),
      });
    }
    return [...result.values()];
  }

  private audit(
    ctx: TenantContext,
    input: RegistrationSuggestionRequest,
    audit: PortfolioAgentAudit,
  ) {
    return this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      await requireOwnerActor(tx, ctx);
      await tx.auditLog.create({
        data: {
          tenantId: ctx.tenantId,
          actorUserId: ctx.userId,
          actorRole: ctx.role,
          action: 'profile.registration_suggestions',
          entityType: 'profile_draft',
          entityId: input.requestId,
          after: JSON.parse(JSON.stringify({ field: input.field, audit })) as Prisma.InputJsonValue,
        },
      });
    });
  }
}
