import 'reflect-metadata';
import { EventEmitter } from 'node:events';
import { BadRequestException, ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import type { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import {
  classifyApiToolReadOutcome,
  MERI_CAPABILITY_REGISTRY,
  type TenantContext,
} from '@capiro/shared';
import type { AppConfig } from '../config/config.schema.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { ToolServiceSecretGuard } from '../auth/tool-service-secret.guard.js';
import { structureText } from '../ingestion/bill-document-structure.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { EmbeddingProvider } from '../embeddings/embedding-provider.js';
import { BILL_JURISDICTIONS, type BillTextDocumentRow } from '../retrieval/bill-text-query.js';
import { BillTextService } from '../retrieval/bill-text.service.js';
import { MeriController } from './meri.controller.js';
import { MeriToolsService } from './meri-tools.service.js';
import { currentOwnerResultAuthorizesReplay } from './meri-research-replay-authorization.js';

const CTX: TenantContext = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  tenantSlug: 'synthetic',
  userId: '22222222-2222-4222-8222-222222222222',
  clerkUserId: 'synthetic-user',
  role: 'standard_user',
};
function document(overrides: Partial<BillTextDocumentRow> = {}): BillTextDocumentRow {
  const structure = structureText(
    'SECTION 1. Definitions.\n"eligible person" means a resident.\nSECTION 2. Aid.\nAn eligible person receives housing assistance 😀 under section 1 and section 999.',
  );
  return {
    sourceKind: 'state',
    billId: 'FL-2026-HB1',
    billNumber: 'HB1',
    jurisdiction: 'FL',
    session: '2026',
    version: 'Introduced',
    versionId: 'text:1',
    providerDocumentId: '1',
    revisionId: '00000000-0000-4000-8000-000000000001',
    extractionId: '00000000-0000-4000-8000-000000000002',
    revisionHash: 'a'.repeat(64),
    documentHash: 'b'.repeat(64),
    originalBytesHash: 'b'.repeat(64),
    structureHash: structure.structureHash,
    textHash: structure.textHash,
    extractionVersion: structure.parserVersion,
    sourceUrl: 'https://example.test/public-bill',
    publishedDate: '2025-10-02',
    title: 'Housing',
    kind: 'text',
    status: 'introduced',
    completeness: 'complete',
    warnings: [],
    text: structure.text,
    structure,
    total: 1,
    ...overrides,
  };
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Expected object');
  return value as Record<string, unknown>;
}
function items(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw Error('Expected array');
  return value;
}
function string(value: unknown): string {
  if (typeof value !== 'string') throw Error('Expected string');
  return value;
}
function number(value: unknown): number {
  if (typeof value !== 'number') throw Error('Expected number');
  return value;
}
function identity(row: BillTextDocumentRow) {
  return {
    mode: 'retained',
    billId: row.billId,
    jurisdiction: row.jurisdiction,
    session: row.session,
    revisionId: row.revisionId,
    extractionId: row.extractionId,
  };
}
function fixture(rows: BillTextDocumentRow[] = [document()]) {
  const query = jest.fn().mockResolvedValue(rows);
  const embed = jest.fn().mockResolvedValue(Array(1024).fill(0.01));
  const provider = {
    metadata: { model: 'synthetic-model', dimensions: 1024 },
    embed,
  } as unknown as EmbeddingProvider;
  const legacyFind = jest.fn().mockResolvedValue([]);
  const tx = {
    $queryRawUnsafe: query,
    stateBill: { findMany: legacyFind, count: jest.fn().mockResolvedValue(0) },
  };
  const withSystem = jest.fn((run: (transaction: typeof tx) => unknown) => run(tx));
  const prisma = { withSystem } as unknown as PrismaService;
  const owner = new BillTextService(prisma, provider);
  const tools = Object.assign(Object.create(MeriToolsService.prototype), {
    billText: owner,
    prisma,
  }) as MeriToolsService;
  const controller = Object.assign(Object.create(MeriController.prototype), {
    tools,
    logger: { log: jest.fn() },
  }) as MeriController;
  const configValues: Record<string, unknown> = {
    NODE_ENV: 'production',
    INTERNAL_SERVICE_SECRET: 'synthetic-service',
    MERI_TOOLS_REQUIRE_SERVICE_SECRET: true,
  };
  const serviceGuard = new ToolServiceSecretGuard({
    get: (key: string) => configValues[key],
  } as ConfigService<AppConfig, true>);
  async function route(
    name: string,
    input: Record<string, unknown>,
    options: { user?: boolean; secret?: string } = {},
  ) {
    const req = Object.assign(new EventEmitter(), {
      headers: { 'x-internal-service-secret': options.secret ?? 'synthetic-service' },
      tenantContext: options.user === false ? undefined : CTX,
      method: 'POST',
      path: `/api/clio/tools/${name}`,
    }) as unknown as Request;
    const execution = {
      getClass: () => MeriController,
      getHandler: () => controller.executeTool,
      switchToHttp: () => ({ getRequest: () => req }),
    } as unknown as ExecutionContext;
    new RolesGuard(new Reflector()).canActivate(execution);
    serviceGuard.canActivate(execution);
    return controller.executeTool(CTX, name, input, req);
  }
  return { route, tools, query, embed, legacyFind, withSystem };
}

describe('retained bill text through the existing authenticated tool gateway', () => {
  it('uses the mounted user/service guards and refuses absent user or service identity before a read', async () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, MeriController)).toContain(RolesGuard);
    expect(Reflect.getMetadata(GUARDS_METADATA, MeriController.prototype.executeTool)).toContain(
      ToolServiceSecretGuard,
    );
    const f = fixture();
    await expect(
      f.route('search_state_bills', { mode: 'exact', billId: 'FL-2026-HB1' }, { user: false }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    for (const secret of ['', 'wrong'])
      await expect(
        f.route('search_state_bills', { mode: 'exact', billId: 'FL-2026-HB1' }, { secret }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    expect(f.query).not.toHaveBeenCalled();
    expect(f.embed).not.toHaveBeenCalled();
  });

  it('dispatches exact state section search with every bounded filter to the canonical owner', async () => {
    const row = document(),
      f = fixture([row]);
    const result = record(
      await f.route('search_state_bills', {
        mode: 'exact',
        billNumber: 'HB1',
        state: 'fl',
        session: '2026',
        section: '2',
        status: 'introduced',
        version: 'Introduced',
        kind: 'text',
        dateBasis: 'action',
        dateFrom: '2025-10-01',
        dateBefore: '2026-10-01',
        fiscalYear: 2026,
        limit: 2,
        page: 1,
      }),
    );
    const hit = record(items(result.results)[0]);
    expect(result).toMatchObject({
      tool: 'search_state_bills',
      authoritativeOwner: 'bill_text_extraction',
      mode: 'exact',
      totalRevisions: 1,
    });
    expect(record(hit.identity)).toMatchObject({
      billId: row.billId,
      jurisdiction: 'FL',
      session: '2026',
      revisionId: row.revisionId,
      extractionId: row.extractionId,
    });
    expect(hit.text).toContain('housing assistance 😀');
    expect(row.text!.slice(number(hit.startOffset), number(hit.endOffset))).toBe(hit.text);
    const values = f.query.mock.calls[0]!.slice(1);
    expect(values).toEqual(
      expect.arrayContaining([
        ['FL'],
        '2026',
        'HB1',
        'introduced',
        'Introduced',
        'text',
        '2025-10-01',
        '2026-10-01',
      ]),
    );
    expect(f.withSystem).toHaveBeenCalledWith(expect.any(Function), {
      readOnly: true,
      timeoutMs: 60000,
    });
    expect(f.embed).not.toHaveBeenCalled();
    expect(classifyApiToolReadOutcome('search_state_bills', result)?.kind).toBe('partial');
  });

  it('supports explicit federal phrase and semantic modes without changing the legacy state default', async () => {
    const row = document({
      sourceKind: 'federal',
      billId: '119-hr-1',
      jurisdiction: 'US',
      session: '119',
      kind: 'amendment',
    });
    const f = fixture([row]);
    const phrase = record(
      await f.route('search_congress_bills', {
        mode: 'keyword',
        query: '"housing assistance"',
        kind: 'amendment',
        session: '119',
      }),
    );
    expect(phrase).toMatchObject({ operation: 'search', mode: 'keyword' });
    expect(record(items(phrase.results)[0]).kind).toBe('amendment');
    expect(f.embed).not.toHaveBeenCalled();
    const semantic = record(
      await f.route('search_congress_bills', {
        mode: 'semantic',
        query: 'help residents find affordable homes',
        session: '119',
      }),
    );
    expect(f.embed).toHaveBeenCalledTimes(1);
    expect(f.embed).toHaveBeenCalledWith('help residents find affordable homes');
    expect(semantic).toMatchObject({
      totalRevisions: null,
      approximate: true,
      candidatePassageLimit: 1000,
    });
    expect(f.query.mock.calls[0]!.slice(1)).toContainEqual(['US']);
    const legacy = await f.route('search_state_bills', { query: 'housing', state: 'FL' });
    expect(legacy).toMatchObject({ tool: 'search_state_bills', total: 0, data: [] });
    expect(record(legacy).operation).toBeUndefined();
    expect(f.legacyFind).toHaveBeenCalledTimes(1);
    expect(f.embed).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['search_congress_bills', { mode: 'semantic', query: 'housing', jurisdictions: ['FL'] }],
    ['search_state_bills', { mode: 'semantic', query: 'housing', jurisdictions: ['US'] }],
    ['search_state_bills', { mode: 'exact', billNumber: 'HB1' }],
    [
      'search_state_bills',
      { mode: 'keyword', query: 'housing', state: 'FL', jurisdictions: ['FL'] },
    ],
    ['search_state_bills', { mode: 'keyword', query: 'housing', tenantId: CTX.tenantId }],
    ['search_state_bills', { mode: 'keyword', query: 'housing', jurisdictions: null }],
    ['search_state_bills', { mode: 'keyword', query: 'housing', dateBefore: '2026-02-30' }],
    ['search_congress_bills', { mode: 'keyword', query: 'housing', limit: 21 }],
    ['search_congress_bills', { mode: 'semantic', query: 'housing', page: 1000 }],
    ['search_congress_bills', { mode: 'other', query: 'housing' }],
  ])(
    'rejects invalid full-text arguments before database/model work: %s %j',
    async (tool, input) => {
      const f = fixture();
      await expect(f.route(tool, input)).rejects.toBeInstanceOf(BadRequestException);
      expect(f.query).not.toHaveBeenCalled();
      expect(f.embed).not.toHaveBeenCalled();
    },
  );

  it('reads a historical extraction and keeps definition/reference context and every UTF-16 slice exact', async () => {
    const row = document({ extractionVersion: 'bill-structure-v1' }),
      f = fixture([row]);
    const result = record(
      await f.route('read_bill_text', {
        ...identity(row),
        section: '2',
        length: 1000,
        contextChars: 6000,
      }),
    );
    expect(result.available).toBe(true);
    expect(record(result.identity)).toMatchObject({
      extractionVersion: 'bill-structure-v1',
      revisionId: row.revisionId,
      extractionId: row.extractionId,
    });
    for (const part of [result, ...items(result.context).map(record)])
      expect(row.text!.slice(number(part.startOffset), number(part.endOffset))).toBe(part.text);
    expect(
      items(result.context)
        .map(record)
        .some((part) => part.relation === 'definition'),
    ).toBe(true);
    expect(items(result.references).map(record)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reference: '999', status: 'unresolved_external_or_absent' }),
      ]),
    );
    expect(classifyApiToolReadOutcome('read_bill_text', result)?.kind).toBe('partial');
    const limited = record(
      await f.route('read_bill_text', {
        ...identity(row),
        section: '2',
        length: 1000,
        contextChars: 0,
      }),
    );
    expect(limited.contextTruncated).toBe(true);
    expect(items(limited.definitions).map(record)).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: 'context_limit' })]),
    );
    expect(record(limited.coverage).complete).toBe(false);
    expect(classifyApiToolReadOutcome('read_bill_text', limited)?.kind).toBe('partial');
  });

  it('continues the same immutable cursor and rejects a different bill or caller identity overrides', async () => {
    const row = document(),
      f = fixture([row]);
    const first = record(
      await f.route('read_bill_text', { ...identity(row), length: 40, contextChars: 0 }),
    );
    const cursor = string(first.nextCursor);
    const second = record(
      await f.route('read_bill_text', {
        mode: 'retained',
        billId: row.billId,
        cursor,
        length: 40,
        contextChars: 0,
      }),
    );
    expect(second.startOffset).toBe(first.endOffset);
    expect(second.identity).toEqual(first.identity);
    expect(row.text!.slice(number(second.startOffset), number(second.endOffset))).toBe(second.text);
    const called = f.query.mock.calls.length;
    for (const override of [
      { billId: 'FL-2025-HB1' },
      { revisionId: row.revisionId },
      { offset: 0 },
      { session: '2025' },
    ]) {
      await expect(
        f.route('read_bill_text', { mode: 'retained', billId: row.billId, cursor, ...override }),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(f.query).toHaveBeenCalledTimes(called);
  });

  it.each([
    { length: 9001 },
    { contextChars: 6001 },
    { offset: -1 },
    { offset: 0.5 },
    { session: 2026 },
    { jurisdiction: 'ZZ' },
    { clientId: 'private-selector' },
  ])(
    'rejects retained read bounds and malformed identity before any read: %j',
    async (override) => {
      const f = fixture();
      await expect(
        f.route('read_bill_text', { ...identity(document()), ...override }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(f.query).not.toHaveBeenCalled();
    },
  );

  it('binds replay to the exact immutable result and never promotes partial parsing or missing text to complete', async () => {
    const row = document(),
      f = fixture([row]);
    const result = record(
      await f.route('read_bill_text', { ...identity(row), length: 9000, contextChars: 6000 }),
    );
    expect(classifyApiToolReadOutcome('read_bill_text', result)?.kind).toBe('complete');
    expect(
      currentOwnerResultAuthorizesReplay('read_bill_text', result, {
        ...result,
        generatedAt: 'later',
      }),
    ).toBe(true);
    expect(
      currentOwnerResultAuthorizesReplay('read_bill_text', result, {
        ...result,
        identity: { ...record(result.identity), revisionId: 'different' },
      }),
    ).toBe(false);
    expect(
      classifyApiToolReadOutcome('read_bill_text', { ...result, contextTruncated: true })?.kind,
    ).toBe('failed');
    f.query.mockResolvedValue([{ ...row, completeness: 'partial' }]);
    const partial = await f.route('read_bill_text', {
      ...identity(row),
      length: 9000,
      contextChars: 6000,
    });
    expect(classifyApiToolReadOutcome('read_bill_text', partial)?.kind).toBe('partial');
    f.query.mockResolvedValue([{ ...row, structure: null, text: null, completeness: 'failed' }]);
    expect(
      classifyApiToolReadOutcome('read_bill_text', await f.route('read_bill_text', identity(row)))
        ?.kind,
    ).toBe('unavailable');
    f.query.mockResolvedValue([]);
    await expect(f.route('read_bill_text', identity(row))).rejects.toMatchObject({ status: 404 });
  });

  it('reports global frozen coverage honestly and keeps empty searches partial', async () => {
    const f = fixture([]);
    const coverage = record(await f.route('search_state_bills', { mode: 'coverage' }));
    expect(coverage).toMatchObject({ operation: 'coverage', fiscalYear: 2026, complete: false });
    expect(items(coverage.jurisdictions)).toHaveLength(52);
    expect(
      items(coverage.jurisdictions)
        .map(record)
        .every((row) => row.status === 'unknown'),
    ).toBe(true);
    expect(classifyApiToolReadOutcome('search_state_bills', coverage)?.kind).toBe('partial');
    expect(f.embed).not.toHaveBeenCalled();
    const empty = await f.route('search_state_bills', { mode: 'keyword', query: 'housing' });
    expect(classifyApiToolReadOutcome('search_state_bills', empty)?.kind).toBe('partial');
    await expect(
      f.route('search_state_bills', { mode: 'coverage', state: 'FL' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    const complete = {
      ...coverage,
      complete: true,
      jurisdictions: BILL_JURISDICTIONS.map((jurisdiction) => ({
        jurisdiction,
        status: 'complete_for_frozen_inventory',
      })),
    };
    expect(classifyApiToolReadOutcome('search_state_bills', complete)?.kind).toBe('complete');
    expect(
      classifyApiToolReadOutcome('search_state_bills', {
        ...complete,
        jurisdictions: Array(52).fill(complete.jurisdictions[0]),
      })?.kind,
    ).toBe('failed');
    expect(
      classifyApiToolReadOutcome('search_state_bills', { ...coverage, complete: true })?.kind,
    ).toBe('failed');
  });

  it('advertises the explicit modes on the existing read-only tools while keeping billId required', () => {
    const f = fixture();
    const schemas = f.tools.anthropicToolSchemas();
    const read = schemas.find((schema) => schema.name === 'read_bill_text');
    expect(read?.input_schema.required).toEqual(['billId']);
    for (const tool of ['search_congress_bills', 'search_state_bills', 'read_bill_text']) {
      const schema = schemas.find((item) => item.name === tool);
      expect(record(record(schema?.input_schema).properties).mode).toBeDefined();
      expect(MERI_CAPABILITY_REGISTRY.find((item) => item.name === tool)?.readOnly).toBe(true);
    }
  });
});
