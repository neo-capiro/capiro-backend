import { createHash } from 'node:crypto';
import { describe, expect, jest, test } from '@jest/globals';
import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { MemoryIngestService } from './memory-ingest.service.js';
import { StrictMemoryProjectorService } from './strict-memory-projector.service.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const CLIO = '22222222-2222-4222-8222-222222222222';
const ITEM = '33333333-3333-4333-8333-333333333333';

function sqlText(strings: TemplateStringsArray | unknown): string {
  return Array.isArray((strings as TemplateStringsArray).raw)
    ? (strings as unknown as string[]).join('?')
    : String(strings);
}

function sourceRow() {
  return {
    id: CLIO,
    tenantId: TENANT,
    scope: 'firm',
    ownerUserId: null,
    clientId: null,
    expiresAt: null,
    key: 'Firm position',
    value: 'Support the full authorization and appropriation request.',
    source: 'explicit_user',
    metadata: {},
    createdAt: new Date('2026-07-30T00:00:00Z'),
    updatedAt: new Date('2026-07-30T00:00:00Z'),
  };
}

function harness(options: { source?: boolean; projected?: boolean; embedded?: boolean } = {}) {
  const sqls: string[] = [];
  const tx = {
    $queryRaw: jest.fn(async (strings: TemplateStringsArray) => {
      const sql = sqlText(strings);
      sqls.push(sql);
      if (sql.includes('FROM clio_memory')) return options.source === false ? [] : [sourceRow()];
      if (sql.includes('FROM memory_items')) return options.projected === false ? [] : [{ id: ITEM }];
      if (sql.includes('FROM context_embeddings')) {
        return options.embedded === false ? [] : [{ source_id: ITEM }];
      }
      return [];
    }),
  } as unknown as Prisma.TransactionClient;
  const prisma = {
    withSystem: jest.fn(async <T>(fn: (arg: Prisma.TransactionClient) => Promise<T>) => fn(tx)),
  } as unknown as PrismaService;
  const ingest = {
    projectClioMemory: jest.fn(async () => undefined),
  } as unknown as MemoryIngestService;
  return { service: new StrictMemoryProjectorService(prisma, ingest), ingest, sqls };
}

describe('StrictMemoryProjectorService', () => {
  test('treats a deleted source as an idempotent vanished job', async () => {
    const h = harness({ source: false });
    await expect(h.service.projectClioMemoryStrict(TENANT, CLIO)).resolves.toBe('vanished');
    expect(h.ingest.projectClioMemory).not.toHaveBeenCalled();
  });

  test('uses the existing projector and verifies both item and expected embedding', async () => {
    const h = harness();
    await expect(h.service.projectClioMemoryStrict(TENANT, CLIO)).resolves.toBe('projected');
    expect(h.ingest.projectClioMemory).toHaveBeenCalledWith(TENANT, CLIO);
    expect(h.sqls.some((sql) => sql.includes('FROM memory_items'))).toBe(true);
    expect(h.sqls.some((sql) => sql.includes('FROM context_embeddings'))).toBe(true);
    expect(createHash('sha256').update('x').digest('hex')).toHaveLength(64);
  });

  test('turns the legacy projector’s swallowed item failure into a retryable error', async () => {
    const h = harness({ projected: false });
    await expect(h.service.projectClioMemoryStrict(TENANT, CLIO)).rejects.toThrow(
      'memory_projection_missing',
    );
  });

  test('does not report completion when the expected embedding is absent', async () => {
    const h = harness({ embedded: false });
    await expect(h.service.projectClioMemoryStrict(TENANT, CLIO)).rejects.toThrow(
      'memory_embedding_missing',
    );
  });
});
