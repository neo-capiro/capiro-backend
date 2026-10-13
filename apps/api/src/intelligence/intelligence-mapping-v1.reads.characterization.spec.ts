import { NotFoundException } from '@nestjs/common';
import {
  clientId,
  clientRow,
  harness,
  inputOf,
  installHooks,
  mappingRow,
  tenantId,
} from '../../test/fixtures/intelligence-mapping.js';

installHooks();

describe('Mapping client-specific read scope', () => {
  test('guards membership then returns the exact confidence-ordered mapping array in the same transaction', async () => {
    const mappings = ['candidate', 'confirmed', 'rejected', 'superseded'].map((reviewStatus) =>
      mappingRow({ reviewStatus }),
    );
    const h = harness({ rows: { mappings } });
    expect(await h.service.getMappings(clientId, tenantId)).toBe(mappings);
    expect(inputOf(h, 'client')).toEqual({ where: { id: clientId }, select: { id: true } });
    expect(inputOf(h, 'mappings')).toEqual({
      where: { clientId },
      orderBy: { confidence: 'desc' },
    });
    expect(h.callsOf('client')[0]).toMatchObject({ tenantId, transaction: 1 });
    expect(h.callsOf('mappings')[0]).toMatchObject({ tenantId, transaction: 1 });
    expect(h.transactions[0]!.outcome).toBe('commit');
  });
  test('fails a foreign client before reading mappings', async () => {
    const h = harness({ rows: { client: null } });
    await expect(h.service.getMappings(clientId, tenantId)).rejects.toThrow(
      new NotFoundException('Client not found'),
    );
    expect(h.callsOf('mappings')).toEqual([]);
    expect(h.transactions[0]!.outcome).toBe('rollback');
  });
  test.each(['client', 'mappings'])(
    'propagates %s failures in the client-specific scope',
    async (operation) => {
      const error = new Error(`${operation} failed`);
      const h = harness({ errors: { [operation]: error } });
      await expect(h.service.getMappings(clientId, tenantId)).rejects.toBe(error);
      expect(h.transactions[0]!.outcome).toBe('rollback');
    },
  );
});

describe('Mapping tenant admin read scope', () => {
  test('excludes archived clients before a separate mapping read and preserves shallow field references', async () => {
    const row = mappingRow({ clientName: 'Stale name' });
    const h = harness({
      rows: {
        clients: [clientRow(), clientRow({ id: 'second-client', name: 'Second Client' })],
        mappings: [row, mappingRow({ id: 'foreign-row', clientId: 'unknown-client' })],
      },
    });
    const result = await h.service.getAllMappingsForTenant(tenantId);
    expect(inputOf(h, 'clients')).toEqual({
      where: { status: { not: 'archived' } },
      select: { id: true, name: true },
    });
    expect(inputOf(h, 'mappings')).toEqual({
      where: { clientId: { in: [clientId, 'second-client'] } },
      orderBy: { confidence: 'desc' },
    });
    expect(h.callsOf('clients')[0]!.transaction).toBe(1);
    expect(h.callsOf('mappings')[0]!.transaction).toBe(2);
    expect(result.map((mapping) => mapping.clientName)).toEqual(['Acme Research', '']);
    expect(result[0]).not.toBe(row);
    expect(result[0]!.matchEvidence).toBe(row.matchEvidence);
    expect(result[0]!.createdAt).toBe(row.createdAt);
    expect(row).toHaveProperty('clientName', 'Stale name');
  });
  test('returns early for an empty active client set', async () => {
    const h = harness();
    expect(await h.service.getAllMappingsForTenant(tenantId)).toEqual([]);
    expect(h.callsOf('mappings')).toEqual([]);
    expect(h.transactions).toHaveLength(1);
  });
  test('retains duplicate client ID binding and last client-name lookup value', async () => {
    const h = harness({
      rows: { clients: [clientRow(), clientRow({ name: 'Latest' })], mappings: [mappingRow()] },
    });
    expect((await h.service.getAllMappingsForTenant(tenantId))[0]!.clientName).toBe('Latest');
    expect(inputOf(h, 'mappings')).toMatchObject({
      where: { clientId: { in: [clientId, clientId] } },
    });
  });
  test.each(['clients', 'mappings'])('propagates tenant-admin %s failures', async (operation) => {
    const error = new Error(`${operation} failed`);
    const h = harness({ rows: { clients: [clientRow()] }, errors: { [operation]: error } });
    await expect(h.service.getAllMappingsForTenant(tenantId)).rejects.toBe(error);
    expect(h.transactions.at(-1)!.outcome).toBe('rollback');
  });
});
