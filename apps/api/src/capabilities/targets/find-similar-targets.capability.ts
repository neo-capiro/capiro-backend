import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { TenantContext } from '@capiro/shared';
import type { AuthorizedCapabilityContext } from '../capability-context.js';
import type { CapabilityDefinition, CapabilityRuntimeSchema } from '../capability-definition.js';
import { assertCapabilityResult, type CapabilityResult } from '../capability-result.js';
import {
  outreachTargetLocatorV1Schema,
  type OutreachResolvedTargetRefV1,
} from './outreach-target.contract.js';
import { OutreachTargetReferenceService } from './outreach-target-reference.service.js';
import {
  SearchTargetsCapability,
  type TargetCandidateV1,
} from './search-targets.capability.js';

const inputSchemaZod = z
  .object({
    targetRef: outreachTargetLocatorV1Schema,
    clientId: z.string().uuid().nullable().default(null),
    limit: z.number().int().min(1).max(25).default(10),
  })
  .strict();

export type FindSimilarTargetsInput = z.infer<typeof inputSchemaZod>;

export interface SimilarTargetCandidateV1 extends TargetCandidateV1 {
  similarityScore: number;
  similarityReasons: string[];
}

export interface FindSimilarTargetsDataV1 {
  sourceTargetKey: string;
  candidates: SimilarTargetCandidateV1[];
}

const inputSchema: CapabilityRuntimeSchema<FindSimilarTargetsInput> = {
  name: 'find_similar_targets.input.v1',
  parse(value) {
    return inputSchemaZod.parse(value);
  },
};

const outputSchema: CapabilityRuntimeSchema<CapabilityResult<FindSimilarTargetsDataV1>> = {
  name: 'find_similar_targets.output.v1',
  parse(value) {
    return assertCapabilityResult<FindSimilarTargetsDataV1>(value, 'find_similar_targets');
  },
};

@Injectable()
export class FindSimilarTargetsCapability {
  constructor(
    private readonly targetReferences: OutreachTargetReferenceService,
    private readonly searchTargets: SearchTargetsCapability,
  ) {}

  definition(): CapabilityDefinition<FindSimilarTargetsInput, FindSimilarTargetsDataV1> {
    return {
      name: 'find_similar_targets',
      description:
        'Find current authorized targets with explainable role, jurisdiction, committee, issue or client-contact similarity.',
      version: 1,
      readOnly: true,
      riskClass: 'read',
      surfaces: ['meri_chat', 'outreach', 'workspace', 'strategy', 'internal'],
      supportsClientScope: true,
      requiresClientScope: false,
      timeoutMs: 20_000,
      maxResultCount: 25,
      maxResultBytes: 192_000,
      provenanceRequired: true,
      inputSchema,
      outputSchema,
      execute: (ctx, input) => this.execute(ctx, input),
    };
  }

  async execute(
    ctx: AuthorizedCapabilityContext,
    rawInput: FindSimilarTargetsInput,
  ): Promise<CapabilityResult<FindSimilarTargetsDataV1>> {
    const input = inputSchemaZod.parse(rawInput);
    const source = await this.targetReferences.resolveOne(toTenantContext(ctx), input.targetRef);
    const clientId = input.clientId ?? source.clientId ?? ctx.clientScope?.clientId ?? null;
    const search = await this.searchTargets.execute(ctx, {
      query: null,
      clientId,
      sources: sourcesFor(source, clientId),
      criteria: {
        governmentLevels:
          source.jurisdiction.governmentLevel === 'federal' ||
          source.jurisdiction.governmentLevel === 'state'
            ? [source.jurisdiction.governmentLevel]
            : [],
        chambers: chamberCriteria(source),
        committees: source.jurisdiction.committees,
        agencies: [],
        states: source.jurisdiction.state ? [source.jurisdiction.state] : [],
        relationshipPreference: 'any',
        includeStaff: true,
        includePrincipals: true,
      },
      limit: 50,
      excludeTargetKeys: [source.targetKey],
      rejectedRecommendationRefs: [],
    });

    const candidates = search.data.candidates
      .map((candidate) => scoreSimilarity(source, candidate))
      .filter((candidate) => candidate.similarityScore > 0)
      .sort(
        (a, b) =>
          b.similarityScore - a.similarityScore ||
          b.score - a.score ||
          compare(a.targetKey, b.targetKey),
      )
      .slice(0, input.limit);
    const retrievedAt = new Date().toISOString();
    return {
      capability: 'find_similar_targets',
      schemaVersion: 1,
      data: { sourceTargetKey: source.targetKey, candidates },
      provenance: [
        {
          recordType: source.locator.source,
          recordId: source.locator.id,
          sourceSystem: source.sourceSnapshot.system,
          sourceDate: source.sourceSnapshot.lastVerifiedAt,
          lastVerifiedAt: source.sourceSnapshot.lastVerifiedAt,
          retrievedAt,
          verificationClass:
            source.sourceSnapshot.system === 'capiro_directory'
              ? 'authoritative'
              : source.sourceSnapshot.system === 'user_supplied'
                ? 'unverified'
                : 'first_party',
          classification: 'recommendation',
        },
        ...search.provenance,
      ],
      exclusions: search.exclusions,
      scope: { tenantId: ctx.tenantId, clientId },
      freshness: {
        asOf: retrievedAt,
        degraded: search.freshness.degraded,
        reasons: search.freshness.reasons,
      },
      authorization: search.authorization,
    };
  }
}

function sourcesFor(
  source: OutreachResolvedTargetRefV1,
  clientId: string | null,
): Array<
  | 'directory_member'
  | 'directory_staff'
  | 'state_legislator'
  | 'client_person'
  | 'engagement_contact'
  | 'client_recommendation'
> {
  const sources: Array<
    | 'directory_member'
    | 'directory_staff'
    | 'state_legislator'
    | 'client_person'
    | 'engagement_contact'
    | 'client_recommendation'
  > = [];
  if (source.jurisdiction.governmentLevel === 'state') sources.push('state_legislator');
  else sources.push('directory_member', 'directory_staff');
  if (clientId) sources.push('client_person', 'engagement_contact', 'client_recommendation');
  return sources;
}

function chamberCriteria(
  source: OutreachResolvedTargetRefV1,
): Array<'house' | 'senate' | 'state_house' | 'state_senate'> {
  const chamber = source.jurisdiction.chamber?.toLowerCase() ?? '';
  if (source.jurisdiction.governmentLevel === 'state') {
    if (chamber.includes('lower') || chamber.includes('house')) return ['state_house'];
    if (chamber.includes('upper') || chamber.includes('senate')) return ['state_senate'];
    return [];
  }
  if (chamber.includes('house')) return ['house'];
  if (chamber.includes('senate')) return ['senate'];
  return [];
}

function scoreSimilarity(
  source: OutreachResolvedTargetRefV1,
  candidate: TargetCandidateV1,
): SimilarTargetCandidateV1 {
  let score = 0;
  const reasons: string[] = [];
  if (
    source.jurisdiction.governmentLevel !== 'unknown' &&
    source.jurisdiction.governmentLevel === candidate.jurisdiction.governmentLevel
  ) {
    score += 0.15;
    reasons.push('Same government level.');
  }
  if (
    source.jurisdiction.chamber &&
    candidate.jurisdiction.chamber &&
    source.jurisdiction.chamber.toLowerCase() === candidate.jurisdiction.chamber.toLowerCase()
  ) {
    score += 0.15;
    reasons.push('Same chamber.');
  }
  if (
    source.jurisdiction.state &&
    candidate.jurisdiction.state &&
    source.jurisdiction.state.toLowerCase() === candidate.jurisdiction.state.toLowerCase()
  ) {
    score += 0.1;
    reasons.push('Same state.');
  }
  const committeeMatches = intersection(
    source.jurisdiction.committees,
    candidate.jurisdiction.committees,
  );
  if (committeeMatches.length) {
    score += Math.min(0.35, committeeMatches.length * 0.15);
    reasons.push(`Shared committee jurisdiction: ${committeeMatches.slice(0, 2).join(', ')}.`);
  }
  const issueMatches = intersection(
    source.jurisdiction.issueAreas,
    candidate.jurisdiction.issueAreas,
  );
  if (issueMatches.length) {
    score += Math.min(0.2, issueMatches.length * 0.1);
    reasons.push(`Shared issue portfolio: ${issueMatches.slice(0, 2).join(', ')}.`);
  }
  if (source.title && candidate.title && roleFamily(source.title) === roleFamily(candidate.title)) {
    score += 0.15;
    reasons.push('Similar role family.');
  }
  return {
    ...candidate,
    similarityScore: Math.round(Math.min(1, score) * 1000) / 1000,
    similarityReasons: reasons,
  };
}

function intersection(a: readonly string[], b: readonly string[]): string[] {
  const normalized = new Map(b.map((value) => [value.toLowerCase().trim(), value]));
  return a
    .filter((value) => normalized.has(value.toLowerCase().trim()))
    .map((value) => normalized.get(value.toLowerCase().trim()) ?? value)
    .sort(compare);
}

function roleFamily(title: string): string {
  const value = title.toLowerCase();
  if (value.includes('chief of staff')) return 'chief_of_staff';
  if (value.includes('legislative director')) return 'legislative_director';
  if (value.includes('legislative assistant')) return 'legislative_assistant';
  if (value.includes('policy director')) return 'policy_director';
  if (value.includes('counsel')) return 'counsel';
  if (value.includes('member') || value.includes('representative') || value.includes('senator')) {
    return 'principal';
  }
  return value.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function toTenantContext(ctx: AuthorizedCapabilityContext): TenantContext {
  return {
    tenantId: ctx.tenantId,
    tenantSlug: ctx.tenantSlug ?? '',
    userId: ctx.actorUserId,
    clerkUserId: ctx.clerkUserId ?? '',
    role: ctx.role as TenantContext['role'],
  };
}
