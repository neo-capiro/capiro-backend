import { BadRequestException } from '@nestjs/common';
import type { UniversalEntityResolutionService } from '../knowledge/entities/universal-entity-resolution.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { RetrievalRequest } from './retrieval-v2.types.js';
import {
  ExactLexicalRetrievalService,
  normalizeExactLexicalQuery,
  normalizeProgramAlias,
} from './exact-lexical-retrieval.service.js';

function exactRequest(overrides: Partial<RetrievalRequest> = {}): RetrievalRequest {
  return {
    queryClass: 'lookup',
    requestedDomains: ['clients'],
    caller: { tenantId: 'tenant-1', userId: 'user-1' },
    exactLexical: { kind: 'domain', value: 'example.com' },
    ...overrides,
  };
}

function serviceWith(
  prisma: Record<string, unknown>,
  preview: jest.Mock = jest.fn().mockResolvedValue({ status: 'unresolved', candidates: [] }),
): ExactLexicalRetrievalService {
  return new ExactLexicalRetrievalService(
    prisma as unknown as PrismaService,
    { preview } as unknown as UniversalEntityResolutionService,
  );
}

describe('Phase 11 exact lexical normalization', () => {
  it('normalizes domains without guessing identifier type', () => {
    expect(
      normalizeExactLexicalQuery({ kind: 'domain', value: 'https://www.Example.COM/path' }),
    ).toMatchObject({ kind: 'domain', normalizedIdentifier: 'example.com' });
  });

  it('normalizes UEI, CAGE, CIK and PE identifiers with the shared entity rules', () => {
    expect(normalizeExactLexicalQuery({ kind: 'uei', value: 'abc1-def2 ghi3' })).toMatchObject({
      normalizedIdentifier: 'ABC1DEF2GHI3',
    });
    expect(normalizeExactLexicalQuery({ kind: 'cage', value: '1a 2-b3' })).toMatchObject({
      normalizedIdentifier: '1A2B3',
    });
    expect(normalizeExactLexicalQuery({ kind: 'cik', value: '320193' })).toMatchObject({
      normalizedIdentifier: '0000320193',
    });
    expect(normalizeExactLexicalQuery({ kind: 'pe_code', value: '0605053-a' })).toMatchObject({
      normalizedIdentifier: '0605053A',
    });
  });

  it('rejects malformed UEI and CAGE values instead of inferring a different identifier', () => {
    expect(() => normalizeExactLexicalQuery({ kind: 'uei', value: 'SHORT' })).toThrow(
      BadRequestException,
    );
    expect(() => normalizeExactLexicalQuery({ kind: 'cage', value: 'TOO-LONG' })).toThrow(
      BadRequestException,
    );
  });

  it('accepts canonical and display federal bill identifiers deterministically', () => {
    expect(normalizeExactLexicalQuery({ kind: 'bill_id', value: '119-HR-8800' })).toMatchObject({
      canonicalBillId: '119-hr-8800',
      billType: 'hr',
      billNumber: '8800',
      congress: 119,
    });
    expect(
      normalizeExactLexicalQuery({ kind: 'bill_id', value: 'H.R. 8800', congress: 119 }),
    ).toMatchObject({
      canonicalBillId: '119-hr-8800',
      billType: 'hr',
      billNumber: '8800',
      congress: 119,
    });
    expect(normalizeExactLexicalQuery({ kind: 'bill_id', value: 'S. 123' })).toMatchObject({
      billType: 's',
      billNumber: '123',
      congress: undefined,
    });
  });

  it('rejects a fuzzy or malformed bill string', () => {
    expect(() => normalizeExactLexicalQuery({ kind: 'bill_id', value: 'the AI bill' })).toThrow(
      BadRequestException,
    );
  });

  it('uses the established ProgramAlias uppercase/punctuation normalization', () => {
    expect(normalizeProgramAlias('  Next-Gen  Aircraft & Sensors ')).toBe(
      'NEXT GEN AIRCRAFT SENSORS',
    );
  });
});

describe('Phase 11 exact lexical retrieval closeout', () => {
  it('keeps healthy domains and reports a failed domain explicitly instead of rejecting the response', async () => {
    const preview = jest.fn().mockResolvedValue({ status: 'unresolved', candidates: [] });
    const service = serviceWith(
      {
        withTenant: jest.fn().mockRejectedValue(new Error('database unavailable')),
      },
      preview,
    );

    const results = await service.retrieve(
      exactRequest({
        requestedDomains: ['clients', 'institutional_knowledge'],
        exactLexical: { kind: 'canonical_name', value: 'RTX' },
      }),
    );

    expect(results).toEqual([
      expect.objectContaining({
        domain: 'clients',
        sourceStatus: 'error',
        coverageComplete: false,
        stopReason: 'exact_lexical_source_failed',
      }),
      expect.objectContaining({
        domain: 'institutional_knowledge',
        sourceStatus: 'healthy',
        coverageComplete: true,
      }),
    ]);
    expect(preview).toHaveBeenCalledTimes(1);
  });

  it('scans past 501 substring-domain decoys before declaring exact client-domain coverage complete', async () => {
    const updatedAt = new Date('2026-08-17T00:00:00.000Z');
    const client = (index: number, website: string) => ({
      id: `client-${String(index).padStart(4, '0')}`,
      name: `Client ${index}`,
      website,
      uei: null,
      cageCode: null,
      status: 'active',
      updatedAt,
    });
    const firstPage = Array.from({ length: 250 }, (_, index) =>
      client(index + 1, `https://example.com.evil.test/${index + 1}`),
    );
    const secondPage = Array.from({ length: 250 }, (_, index) =>
      client(index + 251, `https://example.com.evil.test/${index + 251}`),
    );
    const finalPage = [
      client(501, 'https://example.com.evil.test/501'),
      client(502, 'https://www.example.com/path'),
    ];
    const findMany = jest
      .fn()
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce(secondPage)
      .mockResolvedValueOnce(finalPage);
    const withTenant = jest.fn(
      async (_tenantId: string, callback: (tx: unknown) => Promise<unknown>) =>
        callback({ client: { findMany } }),
    );
    const service = serviceWith({ withTenant });

    const [result] = await service.retrieve(exactRequest());

    expect(findMany).toHaveBeenCalledTimes(3);
    expect(findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ cursor: { id: firstPage.at(-1)!.id }, skip: 1 }),
    );
    expect(findMany).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ cursor: { id: secondPage.at(-1)!.id }, skip: 1 }),
    );
    expect(result).toMatchObject({
      sourceStatus: 'healthy',
      returned: 1,
      recordsEvaluated: 502,
      searchedEntityCount: 502,
      pagesRead: 3,
      paginationComplete: true,
      coverageComplete: true,
    });
    expect(result?.records[0]).toMatchObject({ recordId: finalPage[1]!.id });
  });

  it('uses the same normalized canonical-program expression as the Phase 11 index', async () => {
    const updatedAt = new Date('2026-08-17T00:00:00.000Z');
    const queryRaw = jest.fn().mockResolvedValue([
      {
        id: 'program-1',
        canonical_name: 'F-35 Lightning II',
        component: 'AF',
        mdap_code: 'F35',
        updated_at: updatedAt,
      },
    ]);
    const service = serviceWith({
      $queryRaw: queryRaw,
      programAlias: { findMany: jest.fn().mockResolvedValue([]) },
    });

    const [result] = await service.retrieve(
      exactRequest({
        requestedDomains: ['program_elements'],
        exactLexical: { kind: 'program_name', value: 'F-35   Lightning II' },
      }),
    );

    const [template, normalizedValue] = queryRaw.mock.calls[0]! as unknown as [
      TemplateStringsArray,
      string,
    ];
    expect(template.join('?')).toContain(
      "btrim(upper(regexp_replace(btrim(canonical_name), '[^[:alnum:]]+', ' ', 'g')))",
    );
    expect(normalizedValue).toBe('F 35 LIGHTNING II');
    expect(result).toMatchObject({
      sourceStatus: 'healthy',
      returned: 1,
      coverageComplete: true,
    });
    expect(result?.records[0]).toMatchObject({
      recordId: 'program-1',
      payload: expect.objectContaining({ canonicalName: 'F-35 Lightning II' }),
    });
  });
});
