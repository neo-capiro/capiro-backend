import { Injectable } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import { UniversalEntityResolutionOrchestratorService } from '../knowledge/entities/universal-entity-resolution-orchestrator.service.js';
import { PortfolioAgentError, PortfolioAgentService } from './portfolio-agent.service.js';
import {
  ProfileSuggestionSourcesService,
  type ProfileSuggestionSource,
} from './profile-suggestion-sources.service.js';
import { requireOwnerActor } from './client-ordered-owner.access.js';
import type {
  DiscoveredProfileIdentity,
  ProfileIdentityInput,
  ProfileIdentityClaim,
} from './profile-identity.contracts.js';

interface WebsiteIdentity {
  name: string;
  sourceId: string;
  quote: string;
  state: string | null;
  city: string | null;
  claims: Array<{
    kind: ProfileIdentityClaim['kind'];
    name: string;
    sourceId: string;
    quote: string;
  }>;
}

/** Company/state-page acquisition shares the public search owner and bounded Portfolio SDK. */
@Injectable()
export class ProfileIdentityWebService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly publicSources: UniversalEntityResolutionOrchestratorService,
    private readonly reader: ProfileSuggestionSourcesService,
    private readonly agent: PortfolioAgentService,
  ) {}
  async discover(ctx: TenantContext, input: ProfileIdentityInput, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const sourceGaps: string[] = [],
      urls = new Set<string>();
    if (input.website)
      for (const path of ['', '/about', '/contact'])
        urls.add(path ? new URL(path, input.website).toString() : input.website);
    if (input.name)
      try {
        const found = await this.publicSources.previewPublicSources(ctx.tenantId, {
          query: `${input.name} company official website secretary of state business registration`,
          entityTypeHint: 'organization',
          actorUserId: ctx.userId,
        });
        if (found.sourceStatus !== 'complete')
          sourceGaps.push('Public identity and state-record search is unavailable or incomplete.');
        for (const candidate of found.candidates) {
          if (!candidate.sourceUrl) continue;
          const domain = new URL(candidate.sourceUrl).hostname;
          if ((!input.website || domain.endsWith('.gov')) && urls.size < 5)
            urls.add(candidate.sourceUrl);
        }
      } catch {
        signal?.throwIfAborted();
        sourceGaps.push('Public identity and state-record search could not be checked.');
      }
    signal?.throwIfAborted();
    const sources: ProfileSuggestionSource[] = [];
    for (const result of await Promise.allSettled(
      [...urls].map((url) => this.reader.website(url, signal)),
    )) {
      if (result.status === 'fulfilled') {
        const companyWebsite =
          input.website &&
          result.value.url &&
          new URL(input.website).origin === new URL(result.value.url).origin
            ? input.website
            : undefined;
        sources.push({
          ...result.value,
          id: `identity_page_${sources.length}`,
          ...(companyWebsite ? { companyWebsite } : {}),
        });
      } else sourceGaps.push('An identity source page could not be read.');
    }
    signal?.throwIfAborted();
    if (!sources.length) return { candidates: [], sourceGaps };
    const extracted = await this.extract(ctx, input.name, sources, signal);
    return {
      candidates: extracted.candidates,
      sourceGaps: [...sourceGaps, ...extracted.sourceGaps],
    };
  }
  fromDocument(
    ctx: TenantContext,
    name: string,
    source: ProfileSuggestionSource,
    signal?: AbortSignal,
  ) {
    return this.extract(ctx, name, [source], signal);
  }
  private async extract(
    ctx: TenantContext,
    name: string,
    sources: ProfileSuggestionSource[],
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    try {
      const { data } = await this.agent.extract<{ candidates: WebsiteIdentity[] }>({
        subject: { kind: 'draft', id: randomUUID() },
        task: 'identity_candidates',
        schemaVersion: 'profile-identity-v1',
        instructions:
          'Identify only the primary organizations explicitly described in these company About/Contact pages, state records or an uploaded company document. Do not turn customer or partner mentions into the primary company identity. Quote their complete names verbatim. Extract alias, former name, parent and subsidiary relationships only when explicitly stated, with a verbatim relationship quote containing the related name. Never infer ownership from a link or similar name. Return at most four candidates; no mutation or automatic identity selection.',
        prompt: name
          ? `Requested company: ${name}`
          : 'Identify the primary company or companies described by the provided source text. Do not use a filename or URL as the company identity.',
        sources,
        schema: this.websiteSchema(sources.map((source) => source.id)),
        signal,
        maxTurns: 4,
        maxBudgetUsd: 0.5,
        onAudit: (audit) =>
          this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
            await requireOwnerActor(tx, ctx);
            await tx.auditLog.create({
              data: {
                tenantId: ctx.tenantId,
                actorUserId: ctx.userId,
                action: 'profile.identity_source_extraction',
                after: { ...audit },
              },
            });
          }),
      });
      signal?.throwIfAborted();
      const candidates = verifiedWebsiteIdentities(data.candidates, sources);
      return { candidates, sourceGaps: [] };
    } catch (error) {
      // A cancelled HTTP preview is not an unavailable evidence source. Stop
      // acquisition before the caller can start another registry or model read.
      signal?.throwIfAborted();
      if (!(error instanceof PortfolioAgentError)) throw error;
      return {
        candidates: [],
        sourceGaps: ['Identity source evidence could not be extracted.'],
      };
    }
  }

  private websiteSchema(sourceIds: string[]) {
    const text = { type: 'string', minLength: 1, maxLength: 300 },
      quote = { type: 'string', minLength: 2, maxLength: 600 },
      sourceId = { type: 'string', enum: sourceIds };
    return {
      type: 'object',
      additionalProperties: false,
      required: ['candidates'],
      properties: {
        candidates: {
          type: 'array',
          maxItems: 4,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['name', 'sourceId', 'quote', 'state', 'city', 'claims'],
            properties: {
              name: text,
              sourceId,
              quote,
              state: { type: ['string', 'null'] },
              city: { type: ['string', 'null'] },
              claims: {
                type: 'array',
                maxItems: 12,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['kind', 'name', 'sourceId', 'quote'],
                  properties: {
                    kind: {
                      type: 'string',
                      enum: ['alias', 'former_name', 'parent', 'subsidiary'],
                    },
                    name: text,
                    sourceId,
                    quote,
                  },
                },
              },
            },
          },
        },
      },
    };
  }
}

export function verifiedWebsiteIdentities(
  items: WebsiteIdentity[],
  sources: ProfileSuggestionSource[],
): DiscoveredProfileIdentity[] {
  const candidates: DiscoveredProfileIdentity[] = [];
  for (const item of items) {
    const source = sources.find((source) => source.id === item.sourceId);
    if (
      !source ||
      (!source.url && !source.attachmentId) ||
      !source.text.includes(item.quote) ||
      !item.quote.includes(item.name)
    )
      continue;
    const claims = item.claims.flatMap((claim) => {
      const evidence = sources.find((s) => s.id === claim.sourceId);
      return evidence &&
        (evidence.url || evidence.attachmentId) &&
        evidence.text.includes(claim.quote) &&
        claim.quote.includes(claim.name)
        ? [
            {
              kind: claim.kind,
              name: claim.name,
              ...(evidence.attachmentId
                ? { attachmentId: evidence.attachmentId }
                : { sourceUrl: evidence.url! }),
              quote: claim.quote,
            },
          ]
        : [];
    });
    candidates.push({
      sourceCandidate: {
        source: source.attachmentId ? 'document' : 'website',
        externalId: source.attachmentId ?? source.url!,
        name: item.name,
        ...(source.companyWebsite ? { website: source.companyWebsite } : {}),
      },
      sourceType: source.attachmentId ? 'person_confirmed_document' : 'person_confirmed_website',
      identifiers: [],
      ...(item.state && source.text.includes(item.state) ? { state: item.state } : {}),
      ...(item.city && source.text.includes(item.city) ? { city: item.city } : {}),
      claims,
      evidence: [
        {
          label: source.label,
          ...(source.attachmentId ? { attachmentId: source.attachmentId } : { url: source.url! }),
          excerpt: item.quote,
          source: source.source,
          observedAt: source.observedAt,
        },
      ],
    });
  }

  return candidates;
}
