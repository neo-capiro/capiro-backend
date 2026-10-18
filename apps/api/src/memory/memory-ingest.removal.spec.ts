import { MemoryIngestService } from './memory-ingest.service.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = '22222222-2222-4222-8222-222222222222';
const CLIO = '33333333-3333-4333-8333-333333333333';
const ITEM = '44444444-4444-4444-8444-444444444444';

function harness(options: {
  item?: { id: string; tenantId: string; type: string; slug: string; status: string; legalHold: boolean } | null;
  deleteCount?: number;
  embeddingError?: Error;
} = {}) {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const executes: Array<{ sql: string; params: unknown[] }> = [];
  const item = options.item === undefined
    ? { id: ITEM, tenantId: TENANT, type: 'note', slug: `clio:${CLIO}`, status: 'revoked', legalHold: false }
    : options.item;
  const tx = {
    $queryRaw: jest.fn(async (strings: TemplateStringsArray, ...params: unknown[]) => {
      queries.push({ sql: strings.join('?'), params });
      return item ? [item] : [];
    }),
    $executeRaw: jest.fn(async (strings: TemplateStringsArray, ...params: unknown[]) => {
      const sql = strings.join('?');
      executes.push({ sql, params });
      if (sql.includes('DELETE FROM context_embeddings') && options.embeddingError) {
        throw options.embeddingError;
      }
      return sql.includes('DELETE FROM memory_items') ? options.deleteCount ?? 1 : 1;
    }),
  };
  const prisma = {
    withSystem: jest.fn(async (callback: (arg: typeof tx) => Promise<unknown>) => callback(tx)),
  } as unknown as ConstructorParameters<typeof MemoryIngestService>[0];
  const service = new MemoryIngestService(
    prisma,
    {} as ConstructorParameters<typeof MemoryIngestService>[1],
    {} as ConstructorParameters<typeof MemoryIngestService>[2],
  );
  return { service, queries, executes, withSystem: prisma.withSystem };
}

describe('MemoryIngestService removeClioMemory', () => {
  it.each(['playbook', 'client-compass', 'user-profile'])(
    'removes the embedding of the exact revoked %s projection and retains its tombstone',
    async (type) => {
      const h = harness({
        item: { id: ITEM, tenantId: TENANT, type, slug: `clio:${CLIO}`, status: 'revoked', legalHold: false },
      });
      await expect(h.service.removeClioMemory(TENANT, CLIO, ITEM)).resolves.toBeUndefined();

      const lookup = h.queries[0]!;
      expect(lookup.sql).toContain('WHERE id = ?::uuid FOR UPDATE');
      expect(lookup.sql).not.toContain("type = 'note'");
      expect(lookup.params).toContain(ITEM);
      expect(h.executes.map(({ sql }) => sql)).toEqual([
        expect.stringContaining('DELETE FROM context_embeddings'),
      ]);
      expect(h.executes.every(({ params }) => params.includes(TENANT))).toBe(true);
      expect(h.executes.every(({ params }) => params.includes(ITEM))).toBe(true);
    },
  );

  it('never deletes a linked item from another tenant', async () => {
    const h = harness({
      item: { id: ITEM, tenantId: OTHER_TENANT, type: 'playbook', slug: `clio:${CLIO}`, status: 'revoked', legalHold: false },
    });
    await expect(h.service.removeClioMemory(TENANT, CLIO, ITEM)).rejects.toThrow(
      'memory_projection_target_mismatch',
    );
    expect(h.executes).toHaveLength(0);
  });

  it('refuses a held linked item before deleting its embedding', async () => {
    const h = harness({
      item: { id: ITEM, tenantId: TENANT, type: 'playbook', slug: `clio:${CLIO}`, status: 'revoked', legalHold: true },
    });
    await expect(h.service.removeClioMemory(TENANT, CLIO, ITEM)).rejects.toThrow(
      'memory_projection_legal_hold',
    );
    expect(h.executes).toHaveLength(0);
  });

  it('refuses an active item so a missed source revocation cannot complete cleanup', async () => {
    const h = harness({
      item: { id: ITEM, tenantId: TENANT, type: 'playbook', slug: `clio:${CLIO}`, status: 'active', legalHold: false },
    });
    await expect(h.service.removeClioMemory(TENANT, CLIO, ITEM)).rejects.toThrow('memory_projection_not_revoked');
    expect(h.executes).toHaveLength(0);
  });

  it('refuses an unrelated canonical slug even when its id is supplied', async () => {
    const h = harness({
      item: { id: ITEM, tenantId: TENANT, type: 'playbook', slug: 'settings-playbook', status: 'revoked', legalHold: false },
    });
    await expect(h.service.removeClioMemory(TENANT, CLIO, ITEM)).rejects.toThrow(
      'memory_projection_target_mismatch',
    );
    expect(h.executes).toHaveLength(0);
  });

  it('propagates an embedding failure and does not delete the item', async () => {
    const h = harness({ embeddingError: new Error('embedding_store_unavailable') });
    await expect(h.service.removeClioMemory(TENANT, CLIO, ITEM)).rejects.toThrow(
      'embedding_store_unavailable',
    );
    expect(h.executes.some(({ sql }) => sql.includes('DELETE FROM memory_items'))).toBe(false);
  });

  it('treats an explicit missing projection as an already removed subject', async () => {
    const h = harness({ item: null });
    await expect(h.service.removeClioMemory(TENANT, CLIO, ITEM)).resolves.toBeUndefined();
    expect(h.executes).toHaveLength(0);
  });

  it('does not read or delete anything when the source had no linked projection', async () => {
    const h = harness();
    await expect(h.service.removeClioMemory(TENANT, CLIO, null)).resolves.toBeUndefined();
    expect(h.withSystem).not.toHaveBeenCalled();
  });

  it('retains the legacy two-argument lookup only for a note at the Clio slug', async () => {
    const h = harness({
      item: { id: ITEM, tenantId: TENANT, type: 'note', slug: `clio:${CLIO}`, status: 'active', legalHold: false },
    });
    await expect(h.service.removeClioMemory(TENANT, CLIO)).resolves.toBeUndefined();
    expect(h.queries[0]!.sql).toContain("type = 'note'");
    expect(h.queries[0]!.params).toContain(`clio:${CLIO}`);
  });
});
