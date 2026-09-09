import { IntelligenceService } from './intelligence.service.js';
import { fecCycles } from './fec-cycles.js';

describe('client PAC giving', () => {
  const committeeId = 'C00763623';
  const completedAt = new Date('2026-08-01T00:00:00Z');

  function setup(options: { mapped?: boolean; rows?: unknown[]; states?: unknown[] } = {}) {
    const mappingRead = jest.fn(async ({ where }: any) => where.source === 'fec_committee'
      && options.mapped !== false ? [{ externalId: committeeId }] : []);
    const tx = {
      client: { findFirst: jest.fn(async () => ({ id: 'client', name: 'Anduril' })) },
      clientIntelMapping: { findMany: mappingRead },
    };
    const prisma: any = {
      withTenant: jest.fn(async (_tenant: string, run: any) => run(tx)),
      fecCommittee: { findMany: jest.fn(async () => [{ id: committeeId, name: 'ANDURIL PAC' }]) },
      fecPacSyncState: { findMany: jest.fn(async () => options.states ?? []) },
      $queryRaw: jest.fn(async () => options.rows ?? []),
    };
    return { service: new IntelligenceService(prisma), prisma, mappingRead };
  }

  it('keeps an unmapped client distinct from a zero-giving PAC', async () => {
    const { service, prisma } = setup({ mapped: false });
    const result = await service.getFecMoneyFlow('client', 'tenant');
    expect(result.pacGiving.tracked).toBe(false);
    expect(result.pacGiving.coverage.status).toBe('unmapped');
    expect(prisma.fecPacSyncState.findMany).not.toHaveBeenCalled();
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('preserves the mapped committee link while its first import is pending', async () => {
    const { service, mappingRead } = setup();
    const result = await service.getFecMoneyFlow('client', 'tenant');
    expect(result.pacGiving.coverage.status).toBe('pending');
    expect(result.pacGiving.committees[0]).toMatchObject({
      committeeId, committeeName: 'ANDURIL PAC', totalAmount: 0,
    });
    expect(mappingRead).toHaveBeenCalledWith(expect.objectContaining({
      where: { clientId: 'client', source: 'fec_committee', confirmed: true },
    }));
  });

  it('reports complete empty only when every requested cycle has a completed snapshot', async () => {
    const { service } = setup({ states: fecCycles().map((cycle) => ({
      committeeId, cycle, status: 'complete', completedAt,
    })) });
    const result = await service.getFecMoneyFlow('client', 'tenant');
    expect(result.pacGiving.coverage.status).toBe('complete');
    expect(result.pacGiving.summary.totalAmount).toBe(0);
    expect(result.pacGiving.coverage.cycles).toEqual(fecCycles());
  });

  it('includes recipients beyond 500 and negative corrections in the headline total', async () => {
    const rows = Array.from({ length: 501 }, (_, index) => ({
      committee_id: committeeId,
      committee_name: 'ANDURIL PAC',
      recipient_name: `Committee ${index}`,
      candidate_name: null,
      total_amount: index === 500 ? -25 : 100,
      disbursement_count: 1,
    }));
    const { service, prisma } = setup({ rows });
    const result = await service.getFecMoneyFlow('client', 'tenant');
    expect(result.pacGiving.summary).toEqual({
      totalAmount: 49975, disbursementCount: 501, recipientCount: 501,
    });
    expect(result.pacGiving.coverage.status).toBe('partial');
    const [strings, ids, cycles] = prisma.$queryRaw.mock.calls[0];
    expect(strings.join(' ')).not.toContain('LIMIT 500');
    expect(strings.join(' ')).toContain('AND cycle = ANY(');
    expect(ids).toEqual([committeeId]);
    expect(cycles).toEqual(fecCycles());
  });

  it('keeps old snapshot totals visible but marks a failed refresh', async () => {
    const { service } = setup({
      states: [{ committeeId, cycle: fecCycles()[0], status: 'error', completedAt }],
      rows: [{ committee_id: committeeId, committee_name: 'ANDURIL PAC', recipient_name: 'Candidate',
        candidate_name: 'Candidate', total_amount: 5000, disbursement_count: 1 }],
    });
    const result = await service.getFecMoneyFlow('client', 'tenant');
    expect(result.pacGiving.summary.totalAmount).toBe(5000);
    expect(result.pacGiving.coverage.status).toBe('error');
  });

  it('searches official PAC IDs and exposes unknown active status honestly', async () => {
    const { service, prisma } = setup();
    prisma.$queryRaw.mockResolvedValue([{ id: committeeId, name: 'ANDURIL PAC', committee_type: 'Q',
      cycles: [2022, 2026], last_synced_at: completedAt }]);
    expect(await service.searchFecCommittees(` ${committeeId.toLowerCase()} `)).toEqual([{
      id: committeeId, name: 'ANDURIL PAC', committeeType: 'Q', active: null,
      cycle: 2026, sourceSyncedAt: completedAt.toISOString(),
    }]);
    const call = prisma.$queryRaw.mock.calls[0];
    expect(call.slice(1)).toContain(committeeId);
    expect(call[0].join(' ')).toContain("committee_type IN ('Q', 'N', 'O', 'V', 'W')");
  });

  it('validates a manual PAC pin against the catalog and stores its official name', async () => {
    const upsert = jest.fn(async (args: any) => ({ id: 'mapping', ...args.create }));
    const tx = {
      client: { findFirst: jest.fn(async () => ({ id: 'client' })) },
      clientIntelMapping: { findUnique: jest.fn(async () => null), upsert },
      auditLog: { create: jest.fn() },
    };
    const prisma: any = {
      withTenant: jest.fn(async (_tenant: string, run: any) => run(tx)),
      fecCommittee: { findUnique: jest.fn(async () => ({ name: 'ANDURIL PAC', committeeType: 'Q' })) },
    };
    const service = new IntelligenceService(prisma);
    const input = { source: 'fec_committee', externalId: ` ${committeeId.toLowerCase()} `,
      externalName: 'Untrusted label', actorUserId: 'actor' };
    expect(await service.createManualMapping('client', 'tenant', input)).toMatchObject({
      externalId: committeeId, externalName: 'ANDURIL PAC', confirmed: true,
    });
    prisma.fecCommittee.findUnique.mockResolvedValue({ name: 'Campaign', committeeType: 'H' });
    await expect(service.createManualMapping('client', 'tenant', input)).rejects.toThrow('Select a PAC');
    await expect(service.createManualMapping('client', 'tenant', { ...input, externalId: 'invalid' }))
      .rejects.toThrow('valid FEC');
    expect(upsert).toHaveBeenCalledTimes(1);
    tx.client.findFirst.mockResolvedValue(null as any);
    await expect(service.createManualMapping('outside-client', 'tenant', input))
      .rejects.toThrow('Client not found');
    expect(upsert).toHaveBeenCalledTimes(1);
  });
});
