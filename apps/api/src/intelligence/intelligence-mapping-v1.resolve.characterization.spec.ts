import { NotFoundException } from '@nestjs/common';
import {
  clientId,
  clientRow,
  deferred,
  harness,
  inputOf,
  installHooks,
  ldaRow,
  mappingRow,
  tenantId,
} from '../../test/fixtures/intelligence-mapping.js';

installHooks();

describe('Mapping resolution source catalog order', () => {
  test('keeps source ordering, exact 0.3/three-row searches, sequential upserts and saved references', async () => {
    const saved = [
      mappingRow({ id: 'a' }),
      mappingRow({ id: 'b' }),
      mappingRow({ id: 'c' }),
      mappingRow({ id: 'd' }),
    ];
    const h = harness({
      rows: {
        lda: [ldaRow({ id: 12, similarity: 0.99 }), ldaRow({ id: 13, similarity: 1 })],
        contractors: [{ id: 'contractor', name: 'Contractor', similarity: 0.95 }],
        lobby: [{ id: 'lobby', name: 'Lobby', similarity: 0.8 }],
      },
      queues: { upsert: saved },
    });
    const result = await h.service.resolveMapping(clientId, tenantId);
    expect(result).toEqual(saved);
    expect(result[0]).toBe(saved[0]);
    expect(result[3]).toBe(saved[3]);
    expect(h.calls.filter((call) => call.query).map((call) => call.operation)).toEqual([
      'lda',
      'contractors',
      'lobby',
    ]);
    for (const call of h.calls.filter((row) => row.query)) {
      expect(call.scope).toBe('global');
      expect(call.query!.values).toEqual(['Acme Research', 'Acme Research']);
      expect(call.query!.sql).toContain('> 0.3');
      expect(call.query!.sql).toContain('ORDER BY similarity DESC LIMIT 3');
    }
    expect(h.callsOf('upsert').map((call) => call.transaction)).toEqual([2, 2, 2, 2]);
    expect(
      h
        .callsOf('upsert')
        .map((_, index) => (inputOf(h, 'upsert', index).create as Record<string, unknown>).source),
    ).toEqual(['lda', 'lda', 'contracting', 'lobby_intel']);
    expect(h.callsOf('audit')).toEqual([]);
    expect(h.callsOf('prepopulate')).toEqual([]);
  });
});

describe('Mapping resolution persisted candidate authority', () => {
  test('continues resolving an archived client instead of adopting the base-profile refusal', async () => {
    const h = harness({ rows: { client: clientRow({ status: 'archived' }), lda: [ldaRow()] } });
    expect(await h.service.resolveMapping(clientId, tenantId)).toHaveLength(1);
    expect(inputOf(h, 'client')).toEqual({ where: { id: clientId } });
  });
  test('never auto-confirms high similarity and does not downgrade previously confirmed rows in update', async () => {
    const h = harness({ rows: { lda: [ldaRow({ similarity: 1 })] } });
    await h.service.resolveMapping(clientId, tenantId);
    expect(inputOf(h, 'upsert')).toEqual({
      where: { clientId_source_externalId: { clientId, source: 'lda', externalId: '12' } },
      update: { externalName: 'Acme Research', confidence: 1 },
      create: {
        tenantId,
        clientId,
        source: 'lda',
        externalId: '12',
        externalName: 'Acme Research',
        confidence: 1,
        confirmed: false,
        matchBasis: 'fuzzy_name',
        matchTier: 4,
      },
    });
  });
  test('preserves duplicate catalog results instead of deduplicating the loop', async () => {
    const h = harness({ rows: { lda: [ldaRow(), ldaRow()] } });
    expect(await h.service.resolveMapping(clientId, tenantId)).toHaveLength(2);
    expect(h.callsOf('upsert')).toHaveLength(2);
    expect(inputOf(h, 'upsert', 0)).toEqual(inputOf(h, 'upsert', 1));
  });
  test('opens the final empty tenant loop after all three empty catalogs', async () => {
    const h = harness();
    expect(await h.service.resolveMapping(clientId, tenantId)).toEqual([]);
    expect(h.calls.map((call) => call.operation)).toEqual([
      'withTenant',
      'client',
      'lda',
      'contractors',
      'lobby',
      'withTenant',
    ]);
    expect(h.transactions.map((tx) => tx.outcome)).toEqual(['commit', 'commit']);
  });
  test('awaits the current upsert before invoking the next one', async () => {
    const first = deferred<unknown>();
    const h = harness({
      rows: { lda: [ldaRow({ id: 12 }), ldaRow({ id: 13 })] },
      queues: { upsert: [first.promise, mappingRow({ id: 'second' })] },
    });
    const pending = h.service.resolveMapping(clientId, tenantId);
    await h.started('upsert');
    expect(h.callsOf('upsert')).toHaveLength(1);
    first.resolve(mappingRow({ id: 'first' }));
    expect((await pending).map((row) => row.id)).toEqual(['first', 'second']);
  });
});

describe('Mapping resolution failed reads and writes', () => {
  test('refuses an absent tenant client before catalog searches', async () => {
    const h = harness({ rows: { client: null } });
    await expect(h.service.resolveMapping(clientId, tenantId)).rejects.toThrow(
      new NotFoundException('Client not found'),
    );
    expect(h.calls.filter((call) => call.query)).toEqual([]);
  });
  test.each(['client', 'lda', 'contractors', 'lobby'])(
    'propagates the %s error before a write transaction',
    async (operation) => {
      const error = new Error(`${operation} failed`);
      const h = harness({ errors: { [operation]: error } });
      await expect(h.service.resolveMapping(clientId, tenantId)).rejects.toBe(error);
      expect(h.transactions).toHaveLength(1);
      expect(h.callsOf('upsert')).toEqual([]);
    },
  );
  test('rolls back the entire loop if a later upsert fails', async () => {
    const error = new Error('Second candidate failed');
    const h = harness({
      rows: { lda: [ldaRow({ id: 12 }), ldaRow({ id: 13 })] },
      queues: { upsert: [mappingRow(), error] },
    });
    await expect(h.service.resolveMapping(clientId, tenantId)).rejects.toBe(error);
    expect(h.transactions.map((tx) => tx.outcome)).toEqual(['commit', 'rollback']);
    expect(h.callsOf('upsert')).toHaveLength(2);
    expect(h.callsOf('prepopulate')).toEqual([]);
  });
});
