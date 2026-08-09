import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { TenantContext } from '@capiro/shared';
import type { AuthorizedCapabilityContext } from '../capability-context.js';
import type { CapabilityDefinition, CapabilityRuntimeSchema } from '../capability-definition.js';
import { assertCapabilityResult, type CapabilityResult } from '../capability-result.js';
import { outreachTargetLocatorV1Schema } from './outreach-target.contract.js';
import { OutreachTargetReferenceService } from './outreach-target-reference.service.js';
import { deriveTargetCoverage, type TargetCoverageV1 } from './target-coverage.js';

const criteriaSchema = z
  .object({
    chambers: z.array(z.string().min(1).max(120)).max(20).default([]),
    committees: z.array(z.string().min(1).max(120)).max(100).default([]),
    states: z.array(z.string().min(1).max(120)).max(100).default([]),
    relationshipPreference: z.enum(['any', 'existing', 'new', 'mixed']).default('any'),
    includeStaff: z.boolean().default(true),
    includePrincipals: z.boolean().default(true),
  })
  .strict();

const inputSchemaZod = z
  .object({
    criteria: criteriaSchema.nullable().default(null),
    targetRefs: z.array(outreachTargetLocatorV1Schema).max(500),
  })
  .strict();

export type AnalyzeTargetCoverageInput = z.infer<typeof inputSchemaZod>;

export interface AnalyzeTargetCoverageDataV1 {
  coverage: TargetCoverageV1;
  resolvedTargetKeys: string[];
}

const inputSchema: CapabilityRuntimeSchema<AnalyzeTargetCoverageInput> = {
  name: 'analyze_target_coverage.input.v1',
  parse(value) {
    return inputSchemaZod.parse(value);
  },
};

const outputSchema: CapabilityRuntimeSchema<CapabilityResult<AnalyzeTargetCoverageDataV1>> = {
  name: 'analyze_target_coverage.output.v1',
  parse(value) {
    return assertCapabilityResult<AnalyzeTargetCoverageDataV1>(value, 'analyze_target_coverage');
  },
};

@Injectable()
export class AnalyzeTargetCoverageCapability {
  constructor(private readonly targetReferences: OutreachTargetReferenceService) {}

  definition(): CapabilityDefinition<AnalyzeTargetCoverageInput, AnalyzeTargetCoverageDataV1> {
    return {
      name: 'analyze_target_coverage',
      description:
        'Resolve an authorized target set and deterministically identify contactability and requested audience-coverage gaps.',
      version: 1,
      readOnly: true,
      riskClass: 'read',
      surfaces: ['meri_chat', 'outreach', 'workspace', 'strategy', 'internal'],
      supportsClientScope: true,
      requiresClientScope: false,
      timeoutMs: 15_000,
      maxResultCount: 500,
      maxResultBytes: 192_000,
      provenanceRequired: true,
      inputSchema,
      outputSchema,
      execute: (ctx, input) => this.execute(ctx, input),
    };
  }

  async execute(
    ctx: AuthorizedCapabilityContext,
    rawInput: AnalyzeTargetCoverageInput,
  ): Promise<CapabilityResult<AnalyzeTargetCoverageDataV1>> {
    const input = inputSchemaZod.parse(rawInput);
    const targets = await this.targetReferences.resolveMany(toTenantContext(ctx), input.targetRefs);
    const coverage = deriveTargetCoverage(input.criteria, targets);
    const retrievedAt = new Date().toISOString();
    return {
      capability: 'analyze_target_coverage',
      schemaVersion: 1,
      data: {
        coverage,
        resolvedTargetKeys: targets.map((target) => target.targetKey),
      },
      provenance: targets.map((target) => ({
        recordType: target.locator.source,
        recordId: target.locator.id,
        sourceSystem: target.sourceSnapshot.system,
        sourceDate: target.sourceSnapshot.lastVerifiedAt,
        lastVerifiedAt: target.sourceSnapshot.lastVerifiedAt,
        retrievedAt,
        verificationClass:
          target.sourceSnapshot.system === 'capiro_directory'
            ? 'authoritative'
            : target.sourceSnapshot.system === 'user_supplied'
              ? 'unverified'
              : 'first_party',
        classification: 'inference',
      })),
      exclusions: [
        {
          category: 'relationship_proof',
          reasonCode: 'requires_analyze_relationships_per_target',
          count: input.criteria?.relationshipPreference === 'existing' ? targets.length : 0,
        },
      ],
      scope: { tenantId: ctx.tenantId, clientId: ctx.clientScope?.clientId ?? null },
      freshness: {
        asOf: retrievedAt,
        degraded: coverage.gaps.some((gap) => gap.code === 'EXISTING_RELATIONSHIP_NOT_PROVEN'),
        reasons: coverage.gaps.map((gap) => gap.code),
      },
      authorization: { filtered: false, restrictedCount: 0 },
    };
  }
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
