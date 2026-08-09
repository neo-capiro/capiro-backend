import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { PrismaService } from '../../prisma/prisma.service.js';
import { clientMemoryAllowed } from '../../memory/memory-wall.helpers.js';
import { CapabilityAuthorizationService } from '../capability-authorization.service.js';
import type { AuthorizedCapabilityContext } from '../capability-context.js';
import type { CapabilityDefinition, CapabilityRuntimeSchema } from '../capability-definition.js';
import { assertCapabilityResult, type CapabilityResult } from '../capability-result.js';
import {
  outreachContextScopeV1Schema,
  outreachContextSelectionV1Schema,
  type OutreachContextClass,
  type OutreachContextSelectionV1,
} from './outreach-context.contract.js';

const inputSchemaZod = z
  .object({
    query: z.string().min(2).max(500),
    clientId: z.string().uuid().nullable().default(null),
    intendedClass: z.enum([
      'required_policy',
      'writing_guidance',
      'campaign_fact',
      'target_specific',
      'group_safe',
    ]),
    scope: outreachContextScopeV1Schema,
    limit: z.number().int().min(1).max(50).default(20),
  })
  .strict();

export type SearchMemoryInput = z.infer<typeof inputSchemaZod>;

interface MemorySearchRow {
  id: string;
  client_id: string | null;
  owner_user_id: string | null;
  visibility: string;
  title: string;
  type: string;
  source_excerpt: string | null;
  sections_jsonb: unknown;
  instructions_allowed: boolean | null;
  sensitivity: string | null;
  governed_status: string | null;
  memory_authority: string | null;
  source_type: string | null;
  source_version: string | null;
  updated_at: Date;
}

export interface MemorySearchCandidateV1 {
  title: string;
  summary: string;
  memoryType: string;
  clientId: string | null;
  verificationClass: 'authoritative' | 'first_party' | 'derived' | 'unverified';
  sensitivity: 'normal' | 'confidential' | 'restricted';
  instructionsAllowed: boolean;
  lastVerifiedAt: string;
  selection: OutreachContextSelectionV1;
}

export interface SearchMemoryDataV1 {
  candidates: MemorySearchCandidateV1[];
  totalConsidered: number;
}

const inputSchema: CapabilityRuntimeSchema<SearchMemoryInput> = {
  name: 'search_memory.input.v1',
  parse(value) {
    return inputSchemaZod.parse(value);
  },
};

const outputSchema: CapabilityRuntimeSchema<CapabilityResult<SearchMemoryDataV1>> = {
  name: 'search_memory.output.v1',
  parse(value) {
    return assertCapabilityResult<SearchMemoryDataV1>(value, 'search_memory');
  },
};

@Injectable()
export class SearchMemoryCapability {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: CapabilityAuthorizationService,
  ) {}

  definition(): CapabilityDefinition<SearchMemoryInput, SearchMemoryDataV1> {
    return {
      name: 'search_memory',
      description:
        'Search active governed institutional memory with owner, client-wall, freshness, instruction and evidence boundaries preserved.',
      version: 1,
      readOnly: true,
      riskClass: 'read',
      surfaces: ['meri_chat', 'outreach', 'workspace', 'strategy', 'internal'],
      supportsClientScope: true,
      requiresClientScope: false,
      timeoutMs: 15_000,
      maxResultCount: 50,
      maxResultBytes: 192_000,
      provenanceRequired: true,
      inputSchema,
      outputSchema,
      execute: (ctx, input) => this.execute(ctx, input),
    };
  }

  async execute(
    ctx: AuthorizedCapabilityContext,
    rawInput: SearchMemoryInput,
  ): Promise<CapabilityResult<SearchMemoryDataV1>> {
    const input = inputSchemaZod.parse(rawInput);
    if (ctx.clientScope && input.clientId && ctx.clientScope.clientId !== input.clientId) {
      throw new Error('The requested memory scope does not match the authorized client scope.');
    }
    if (input.clientId) await this.authorization.authorizeClient(ctx, input.clientId);
    const pattern = `%${escapeLike(input.query.trim())}%`;
    const rows = await this.prisma.withTenantUser(ctx.tenantId, ctx.actorUserId, (tx) =>
      tx.$queryRaw<MemorySearchRow[]>`
        SELECT id, client_id, owner_user_id, visibility, title, type,
               source_excerpt, sections_jsonb, instructions_allowed, sensitivity,
               governed_status, memory_authority, source_type, source_version,
               updated_at
        FROM memory_items
        WHERE tenant_id = ${ctx.tenantId}::uuid
          ${input.clientId ? Prisma.sql`AND client_id = ${input.clientId}::uuid` : Prisma.empty}
          AND status NOT IN ('revoked', 'rejected', 'withdrawn')
          AND (expires_at IS NULL OR expires_at > now())
          AND (visibility = 'tenant' OR owner_user_id = ${ctx.actorUserId}::uuid)
          AND (
            title ILIKE ${pattern} ESCAPE '\\'
            OR COALESCE(source_excerpt, '') ILIKE ${pattern} ESCAPE '\\'
            OR sections_jsonb::text ILIKE ${pattern} ESCAPE '\\'
            OR tags::text ILIKE ${pattern} ESCAPE '\\'
          )
        ORDER BY updated_at DESC, id
        LIMIT ${Math.min(150, input.limit * 3)}
      `,
    );

    const candidates: MemorySearchCandidateV1[] = [];
    for (const row of rows) {
      if (
        row.client_id &&
        !(await this.prisma.withTenantUser(ctx.tenantId, ctx.actorUserId, (tx) =>
          clientMemoryAllowed(tx, ctx.tenantId, ctx.actorUserId, row.client_id!),
        ))
      ) {
        continue;
      }
      if (!compatibleWithClass(row, input.intendedClass)) continue;
      const selection = outreachContextSelectionV1Schema.parse({
        locator: { source: 'memory_item', id: row.id, clientId: row.client_id },
        contextClass: input.intendedClass,
        scope: input.scope,
      });
      candidates.push({
        title: row.title,
        summary: memorySummary(row),
        memoryType: row.type,
        clientId: row.client_id,
        verificationClass: verificationClass(row),
        sensitivity: sensitivity(row.sensitivity),
        instructionsAllowed: Boolean(row.instructions_allowed),
        lastVerifiedAt: row.updated_at.toISOString(),
        selection,
      });
      if (candidates.length >= input.limit) break;
    }
    const retrievedAt = new Date().toISOString();
    return {
      capability: 'search_memory',
      schemaVersion: 1,
      data: { candidates, totalConsidered: rows.length },
      provenance: candidates.map((candidate) => ({
        recordType: 'memory_item',
        recordId: candidate.selection.locator.source === 'memory_item'
          ? candidate.selection.locator.id
          : '',
        sourceSystem: 'capiro_memory',
        sourceDate: candidate.lastVerifiedAt,
        lastVerifiedAt: candidate.lastVerifiedAt,
        retrievedAt,
        verificationClass:
          candidate.verificationClass === 'authoritative'
            ? 'authoritative'
            : candidate.verificationClass === 'unverified'
              ? 'unverified'
              : 'first_party',
        classification:
          input.intendedClass === 'writing_guidance' ? 'instruction' : 'fact',
      })),
      exclusions: [],
      scope: { tenantId: ctx.tenantId, clientId: input.clientId },
      freshness: {
        asOf: retrievedAt,
        degraded: false,
        reasons: [],
      },
      authorization: { filtered: rows.length !== candidates.length, restrictedCount: rows.length - candidates.length },
    };
  }
}

function compatibleWithClass(row: MemorySearchRow, contextClass: OutreachContextClass): boolean {
  if (contextClass === 'writing_guidance') return Boolean(row.instructions_allowed);
  if (contextClass === 'required_policy') {
    return row.memory_authority === 'authoritative' || row.governed_status === 'approved';
  }
  if (contextClass === 'group_safe') return sensitivity(row.sensitivity) === 'normal';
  return true;
}

function verificationClass(row: MemorySearchRow): MemorySearchCandidateV1['verificationClass'] {
  if (row.memory_authority === 'authoritative') return 'authoritative';
  if (row.governed_status === 'approved') return 'first_party';
  if (row.governed_status === 'pending' || row.governed_status === 'proposed') return 'unverified';
  return 'derived';
}

function sensitivity(value: string | null): MemorySearchCandidateV1['sensitivity'] {
  if (value === 'restricted' || value === 'high') return 'restricted';
  if (value === 'confidential') return 'confidential';
  return 'normal';
}

function memorySummary(row: MemorySearchRow): string {
  const value = row.source_excerpt?.trim() || jsonText(row.sections_jsonb) || `${row.type}: ${row.title}`;
  return value.slice(0, 2_000);
}

function jsonText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return value.map(jsonText).filter(Boolean).join('\n');
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>)
      .map(jsonText)
      .filter(Boolean)
      .join('\n');
  }
  return value == null ? '' : String(value);
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}
