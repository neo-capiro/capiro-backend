import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { TenantContext } from '@capiro/shared';
import type { AuthorizedCapabilityContext } from '../capability-context.js';
import type { CapabilityDefinition, CapabilityRuntimeSchema } from '../capability-definition.js';
import { CapabilityError } from '../capability-errors.js';
import { assertCapabilityResult, type CapabilityResult } from '../capability-result.js';
import {
  outreachContextScopeV1Schema,
  outreachContextSelectionV1Schema,
  type OutreachContextSelectionV1,
  type OutreachResolvedContextRefV1,
} from './outreach-context.contract.js';
import { OutreachContextReferenceService } from './outreach-context-reference.service.js';

const inputSchemaZod = z
  .object({
    documentId: z.string().uuid(),
    clientId: z.string().uuid().nullable().default(null),
    intendedClass: z.enum([
      'required_policy',
      'writing_guidance',
      'campaign_fact',
      'target_specific',
      'group_safe',
    ]),
    scope: outreachContextScopeV1Schema,
  })
  .strict();
export type GetDocumentInput = z.infer<typeof inputSchemaZod>;

export interface GetDocumentDataV1 {
  document: OutreachResolvedContextRefV1;
  selection: OutreachContextSelectionV1;
  contentStatus: 'metadata_only' | 'indexed_or_extracted';
  limitations: string[];
}

const inputSchema: CapabilityRuntimeSchema<GetDocumentInput> = {
  name: 'get_document.input.v1',
  parse(value) {
    return inputSchemaZod.parse(value);
  },
};

const outputSchema: CapabilityRuntimeSchema<CapabilityResult<GetDocumentDataV1>> = {
  name: 'get_document.output.v1',
  parse(value) {
    return assertCapabilityResult<GetDocumentDataV1>(value, 'get_document');
  },
};

@Injectable()
export class GetDocumentCapability {
  constructor(private readonly contexts: OutreachContextReferenceService) {}

  definition(): CapabilityDefinition<GetDocumentInput, GetDocumentDataV1> {
    return {
      name: 'get_document',
      description:
        'Inspect one authorized Capiro document as a bounded governed-context candidate without exposing raw S3 credentials or unrestricted file bytes. A null client scope resolves tenant-neutral documents only.',
      version: 1,
      readOnly: true,
      riskClass: 'read',
      surfaces: ['meri_chat', 'outreach', 'workspace', 'strategy', 'internal'],
      supportsClientScope: true,
      requiresClientScope: false,
      timeoutMs: 10_000,
      maxResultCount: 1,
      maxResultBytes: 96_000,
      provenanceRequired: true,
      inputSchema,
      outputSchema,
      execute: (ctx, input) => this.execute(ctx, input),
    };
  }

  async execute(
    ctx: AuthorizedCapabilityContext,
    rawInput: GetDocumentInput,
  ): Promise<CapabilityResult<GetDocumentDataV1>> {
    const input = inputSchemaZod.parse(rawInput);
    const inheritedClientId = ctx.clientScope?.clientId ?? null;
    if (inheritedClientId && input.clientId && inheritedClientId !== input.clientId) {
      throw new CapabilityError(
        'CAPABILITY_INVALID_SCOPE',
        'The requested document scope does not match the authorized client scope.',
      );
    }
    const effectiveClientId = input.clientId ?? inheritedClientId;
    const selection = outreachContextSelectionV1Schema.parse({
      locator: {
        source: 'document',
        id: input.documentId,
        clientId: effectiveClientId,
      },
      contextClass: input.intendedClass,
      scope: input.scope,
    });
    const document = await this.contexts.resolveOne(toTenantContext(ctx), selection);
    const retrievedAt = new Date().toISOString();
    const indexedOrExtracted = /Indexed:|Extraction: (extracted|truncated)/i.test(document.summary);
    return {
      capability: 'get_document',
      schemaVersion: 1,
      data: {
        document,
        selection,
        contentStatus: indexedOrExtracted ? 'indexed_or_extracted' : 'metadata_only',
        limitations: [
          'This capability returns bounded metadata and an authorized context snapshot, not raw file bytes.',
          'Document existence is not approval; the snapshot records whether the source is usable as evidence.',
        ],
      },
      provenance: [
        {
          recordType: 'document',
          recordId: input.documentId,
          sourceSystem: document.sourceSnapshot.system,
          sourceDate: document.sourceSnapshot.lastVerifiedAt,
          lastVerifiedAt: document.sourceSnapshot.lastVerifiedAt,
          retrievedAt,
          verificationClass:
            document.verificationClass === 'authoritative'
              ? 'authoritative'
              : document.verificationClass === 'unverified'
                ? 'unverified'
                : 'first_party',
          classification:
            document.contextClass === 'writing_guidance' ? 'instruction' : 'fact',
        },
      ],
      exclusions: [
        { category: 'raw_file_bytes', reasonCode: 'not_required_for_context_review', count: 1 },
      ],
      scope: { tenantId: ctx.tenantId, clientId: document.clientId },
      freshness: {
        asOf: document.sourceSnapshot.lastVerifiedAt ?? retrievedAt,
        degraded: document.verificationClass === 'unverified',
        reasons: document.verificationClass === 'unverified' ? ['DOCUMENT_NOT_APPROVED'] : [],
      },
      authorization: { filtered: true, restrictedCount: 1 },
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
