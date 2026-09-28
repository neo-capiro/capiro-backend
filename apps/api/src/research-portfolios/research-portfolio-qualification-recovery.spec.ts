import { ConflictException, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type {
  DefenseFundingCellDto,
  ResearchPortfolioAnalyticsDto,
  TenantContext,
} from '@capiro/shared';
import { ResearchPortfolioAnalyticsService } from './research-portfolio-analytics.service.js';
import {
  ResearchPortfolioOutputService,
  researchPortfolioOutputInternals,
} from './research-portfolio-output.service.js';

const ctx = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
} as TenantContext;
const portfolioId = '33333333-3333-4333-8333-333333333333';
const basis: DefenseFundingCellDto['basis'] = {
  requestEdition: 'PB27',
  fundingFiscalYear: 2027,
  stage: 'request',
  metric: 'funding',
  unit: 'usd_millions',
  currency: 'USD',
  priceBasis: null,
  knownAt: null,
  knowledgeTimeSupported: false,
};
function cell(
  id: string,
  value: string | null,
  disposition: DefenseFundingCellDto['disposition'] = 'observed',
  overrides: Partial<DefenseFundingCellDto['basis']> = {},
): DefenseFundingCellDto {
  return {
    basis: { ...basis, ...overrides },
    value,
    disposition,
    sourceObservationId: id,
    replacedByObservationId: null,
    evidence: [],
  };
}
async function project(cells: DefenseFundingCellDto[][]): Promise<ResearchPortfolioAnalyticsDto> {
  const service = new ResearchPortfolioAnalyticsService(
    {} as never,
    {
      fundingMatrix: jest.fn(async (_kind: string, id: string) => ({ cells: cells[Number(id)] })),
    } as never,
  );
  return (service as any).project(
    portfolioId,
    1,
    cells.map((_items, index) => ({
      id: `member-${index}`,
      targetKind: 'program_element',
      targetId: String(index),
      label: null,
      disposition: 'included',
    })),
  );
}

describe('qualified financial projection regressions', () => {
  it('keeps useful partial values, source qualification and output availability aligned', async () => {
    const result = await project([[cell('partial', '2.5', 'partial')]]);
    expect(result.availability).toBe('partial');
    expect(result.totals[0]!.value).toBe('2.5');
    expect(result.contributions[0]).toMatchObject({
      sourceDisposition: 'partial',
      value: '2.5',
      disposition: 'included',
    });
    const csv = researchPortfolioOutputInternals.projectionCsv(result).toString();
    expect(csv).toContain('"partial"');
    expect(csv).toContain('""sourceDisposition"":""partial""');
    const totalsOnly = researchPortfolioOutputInternals
      .projectionCsv(result, ['totals'], false)
      .toString();
    expect(totalsOnly).toContain('""availability"":""partial""');
  });
  it('does not hide a partial member behind a fully qualified member', async () => {
    const result = await project([[cell('a', '2')], [cell('b', '3', 'partial')]]);
    expect(result.availability).toBe('partial');
    expect(result.totals[0]!.value).toBe('5');
  });
  it.each(['missing', 'withheld', 'unavailable'] as const)(
    'does not treat %s as zero',
    async (disposition) => {
      const result = await project([[cell('absent', null, disposition)]]);
      expect(result.availability).toBe('unavailable');
      expect(result.totals).toEqual([]);
      expect(result.contributions[0]!.value).toBeNull();
    },
  );
  it('does not count an observed null as a qualified numeric contribution', async () => {
    const result = await project([[cell('null', null)]]);
    expect(result.totals).toEqual([]);
    expect(result.contributions[0]!.disposition).toBe('missing');
    expect(result.coverage.includedContributions).toBe(0);
  });
  it('keeps a qualified zero distinct from an absent value', async () => {
    const result = await project([[cell('zero', '0')]]);
    expect(result.availability).toBe('available');
    expect(result.totals[0]!.value).toBe('0');
  });
  it('preserves signed decimal precision beyond Number safe integers', async () => {
    const result = await project([
      [cell('a', '9007199254740993.0000001')],
      [cell('b', '-9007199254740993')],
      [cell('c', '0.0000002')],
    ]);
    expect(result.totals[0]!.value).toBe('0.0000003');
  });
  it('retains nonadditive unit costs without inventing a summed cost', async () => {
    const cost = { metric: 'unit_cost' as const, unit: 'usd_millions_per_unit' as const };
    const result = await project([
      [cell('a', '2', 'observed', cost)],
      [cell('b', '3', 'observed', cost)],
    ]);
    expect(result.totals).toEqual([]);
    expect(result.availability).toBe('partial');
    expect(result.contributions.map((item) => item.value)).toEqual(['2', '3']);
    expect(result.contributions.every((item) => item.disposition === 'incompatible')).toBe(true);
    expect(result.limitations.join(' ')).toMatch(/unit cost/i);
    const csv = researchPortfolioOutputInternals.projectionCsv(result).toString();
    expect(csv.split('\n').filter((line) => line.startsWith('"totals",'))).toEqual([]);
    expect(csv).toContain('"incompatible"');
  });
  it('still sums compatible funding while retaining a nonadditive cost limitation', async () => {
    const result = await project([
      [cell('funding', '10')],
      [cell('cost', '2', 'observed', { metric: 'unit_cost', unit: 'usd_millions_per_unit' })],
    ]);
    expect(result.totals).toHaveLength(1);
    expect(result.totals[0]!.value).toBe('10');
    expect(result.availability).toBe('partial');
  });
  it('partitions request edition and fiscal year instead of adding different bases', async () => {
    const result = await project([
      [cell('a', '2')],
      [cell('b', '3', 'observed', { requestEdition: 'PB26', fundingFiscalYear: 2026 })],
    ]);
    expect(result.totals.map((total) => total.value)).toEqual(['2', '3']);
  });
  it('deduplicates repeated source observations without losing partial qualification', async () => {
    const result = await project([[cell('same', '2', 'partial')], [cell('same', '2', 'partial')]]);
    expect(result.totals[0]!.value).toBe('2');
    expect(result.coverage.overlapContributions).toBe(1);
    expect(result.availability).toBe('partial');
  });
  it('versions corrected calculations while leaving existing snapshot projections untouched', async () => {
    const result = await project([[cell('value', '2')]]);
    expect(result.calculationVersion).toBe('research-portfolio-analytics-v2');
    const legacy = { ...result, calculationVersion: 'research-portfolio-analytics-v1' as const };
    const row = {
      id: 'snapshot',
      portfolioId,
      operationKey: 'old-snapshot',
      contentHash: 'a'.repeat(64),
      name: 'Legacy',
      portfolioRevision: 1,
      createdByUserId: ctx.userId,
      calculationVersion: legacy.calculationVersion,
      capturedAt: new Date(),
      basis: {},
      membership: [],
      projection: legacy,
      structureVersions: {},
      ruleVersions: [],
      decisionVersions: [],
      templateVersions: [],
      taxonomyVersions: [],
      labelVersions: [],
      sourceVersions: [],
      limitations: [],
      clientAccessRequirements: [],
      observedAt: new Date(),
      readAt: new Date(),
    };
    const service = new ResearchPortfolioAnalyticsService({} as never, {} as never);
    const snapshot = (service as any).snapshotDto(row);
    expect(snapshot.projection).toBe(legacy);
    expect(snapshot.calculationVersion).toBe('research-portfolio-analytics-v1');
  });
});

function outputHarness(status = 'outcome_unknown') {
  const bytes = Buffer.from('section,value\nfunding,2.5\n');
  const artifact = {
    id: 'artifact-1',
    bytes,
    byteSize: bytes.length,
    contentHash: createHash('sha256').update(bytes).digest('hex'),
  };
  const attempt = {
    id: 'attempt-1',
    action: 'process',
    outcome: 'partial',
    completedAt: new Date(),
    checkpoint: { leaseFence: 5 },
    receipt: {
      artifactId: artifact.id,
      contentHash: artifact.contentHash,
      byteSize: artifact.byteSize,
    },
  };
  const state: any = {
    id: 'job-1',
    requestId: 'request-1',
    operationKey: 'op-1',
    status,
    leaseOwner: null,
    leaseUntil: null,
    leaseFence: 5,
    attemptCount: 1,
    artifacts: [artifact],
    attempts: [attempt],
  };
  const tx = {
    researchPortfolio: {
      findFirst: jest.fn(async () => ({ grants: [{ role: 'viewer' }], clientLinks: [] })),
    },
    researchPortfolioOutputJob: {
      findFirst: jest.fn(async () => ({ ...state })),
      update: jest.fn(async ({ data }: any) => {
        Object.assign(state, data);
        return state;
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        if (
          where.status !== state.status ||
          where.leaseFence !== state.leaseFence ||
          where.attemptCount !== state.attemptCount
        )
          return { count: 0 };
        state.status = data.status;
        if (data.attemptCount?.increment) state.attemptCount += data.attemptCount.increment;
        if (data.leaseFence?.increment) state.leaseFence += data.leaseFence.increment;
        return { count: 1 };
      }),
    },
    researchPortfolioOutputRequest: { update: jest.fn(async () => ({})) },
    researchPortfolioOutputAttempt: { create: jest.fn(async () => ({})) },
  };
  const service = new ResearchPortfolioOutputService(
    { withTenant: async (_tenant: string, work: any) => work(tx) } as never,
    {} as never,
    {} as never,
  );
  jest.spyOn(service, 'get').mockImplementation(async () => ({ status: state.status }) as any);
  return { service, tx, state, artifact, attempt };
}

describe('output outcome and lease reconciliation regressions', () => {
  it.each(['completed', 'partial', 'failed', 'cancelled', 'queued'])(
    'preserves the known %s state without a fabricated receipt',
    async (status) => {
      const h = outputHarness(status);
      await expect(h.service.reconcile(ctx, portfolioId, 'job-1')).resolves.toMatchObject({
        status,
      });
      expect(h.tx.researchPortfolioOutputJob.update).not.toHaveBeenCalled();
      expect(h.tx.researchPortfolioOutputJob.updateMany).not.toHaveBeenCalled();
      expect(h.tx.researchPortfolioOutputAttempt.create).not.toHaveBeenCalled();
    },
  );
  it.each(['partial', 'completed'])(
    'recovers %s only from a matching immutable execution receipt',
    async (outcome) => {
      const h = outputHarness();
      h.attempt.outcome = outcome;
      await expect(h.service.reconcile(ctx, portfolioId, 'job-1')).resolves.toMatchObject({
        status: outcome,
      });
      expect(h.tx.researchPortfolioOutputRequest.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: outcome } }),
      );
      expect(h.tx.researchPortfolioOutputJob.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            tenantId: ctx.tenantId,
            portfolioId,
            status: 'outcome_unknown',
            leaseFence: 5,
            attemptCount: 1,
          }),
          data: expect.objectContaining({ leaseFence: { increment: 1 } }),
        }),
      );
    },
  );
  it.each([
    'no receipt',
    'wrong hash',
    'wrong artifact',
    'wrong fence',
    'wrong size',
    'tampered bytes',
    'reconcile receipt',
  ])('keeps an unknown outcome unknown for %s', async (mismatch) => {
    const h = outputHarness();
    if (mismatch === 'no receipt') h.state.attempts = [];
    if (mismatch === 'wrong hash') h.attempt.receipt.contentHash = 'b'.repeat(64);
    if (mismatch === 'wrong artifact') h.attempt.receipt.artifactId = 'different-artifact';
    if (mismatch === 'wrong fence') h.attempt.checkpoint.leaseFence = 4;
    if (mismatch === 'wrong size') h.attempt.receipt.byteSize += 1;
    if (mismatch === 'tampered bytes') h.artifact.bytes = Buffer.from('changed');
    if (mismatch === 'reconcile receipt') h.attempt.action = 'reconcile';
    await expect(h.service.reconcile(ctx, portfolioId, 'job-1')).resolves.toMatchObject({
      status: 'outcome_unknown',
    });
  });
  it('does not reconcile an active worker lease', async () => {
    const h = outputHarness('running');
    h.state.leaseOwner = 'worker';
    h.state.leaseUntil = new Date(Date.now() + 60_000);
    await expect(h.service.reconcile(ctx, portfolioId, 'job-1')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(h.tx.researchPortfolioOutputRequest.update).not.toHaveBeenCalled();
  });
  it('does not overwrite concurrent finalization or create a stale receipt', async () => {
    const h = outputHarness();
    h.tx.researchPortfolioOutputJob.updateMany.mockResolvedValue({ count: 0 });
    await expect(h.service.reconcile(ctx, portfolioId, 'job-1')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(h.tx.researchPortfolioOutputRequest.update).not.toHaveBeenCalled();
    expect(h.tx.researchPortfolioOutputAttempt.create).not.toHaveBeenCalled();
  });
  it('reauthorizes a revoked portfolio before reconciliation', async () => {
    const h = outputHarness();
    h.tx.researchPortfolio.findFirst.mockResolvedValue(null as never);
    await expect(h.service.reconcile(ctx, portfolioId, 'job-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(h.tx.researchPortfolioOutputJob.updateMany).not.toHaveBeenCalled();
  });
  it.each(['cancelled', 'new fence'])(
    'does not let a stale worker failure clobber %s',
    async (change) => {
      const state: any = {
        id: 'job',
        status: 'queued',
        leaseFence: 0,
        leaseOwner: null,
        attemptCount: 0,
        requestId: 'request',
        request: { operationKey: 'op', snapshotId: null },
      };
      const tx = {
        researchPortfolioOutputJob: {
          findFirst: jest.fn(async () => ({ ...state })),
          updateMany: jest.fn(async ({ where, data }: any) => {
            if (where.status && where.status !== state.status) return { count: 0 };
            if (where.leaseOwner && where.leaseOwner !== state.leaseOwner) return { count: 0 };
            if (where.leaseFence !== undefined && where.leaseFence !== state.leaseFence)
              return { count: 0 };
            state.status = data.status;
            state.leaseOwner = data.leaseOwner;
            if (data.leaseFence?.increment) state.leaseFence += 1;
            return { count: 1 };
          }),
        },
        researchPortfolioOutputRequest: { update: jest.fn(async () => ({})) },
        researchPortfolioOutputAttempt: { create: jest.fn(async () => ({})) },
      };
      const analytics = {
        analytics: jest.fn(async () => {
          if (change === 'cancelled') state.status = 'cancelled';
          else state.leaseFence += 1;
          throw new Error('render failed after concurrent state change');
        }),
      };
      const service = new ResearchPortfolioOutputService(
        { withTenant: async (_tenant: string, work: any) => work(tx) } as never,
        analytics as never,
        {} as never,
      );
      await (service as any).process(ctx, portfolioId, 'job');
      expect(
        tx.researchPortfolioOutputRequest.update.mock.calls.map(([args]: any) => args.data.status),
      ).toEqual(['running']);
      expect(tx.researchPortfolioOutputAttempt.create).not.toHaveBeenCalled();
      expect(state.status).toBe(change === 'cancelled' ? 'cancelled' : 'running');
    },
  );
});

describe('output worker qualification and final authorization', () => {
  function workerHarness(projection: ResearchPortfolioAnalyticsDto) {
    const state: any = {
      id: 'job',
      status: 'queued',
      leaseFence: 0,
      leaseOwner: null,
      leaseUntil: null,
      attemptCount: 0,
      requestId: 'request',
      request: { id: 'request', operationKey: 'op', snapshotId: null },
    };
    const tx = {
      researchPortfolio: {
        findFirst: jest.fn(async () => ({ grants: [{ role: 'viewer' }], clientLinks: [] })),
      },
      researchPortfolioOutputJob: {
        findFirst: jest.fn(async () => ({ ...state })),
        updateMany: jest.fn(async ({ where, data }: any) => {
          if (where.status && where.status !== state.status) return { count: 0 };
          if (where.leaseOwner && where.leaseOwner !== state.leaseOwner) return { count: 0 };
          if (where.leaseFence !== undefined && where.leaseFence !== state.leaseFence)
            return { count: 0 };
          if (
            where.leaseUntil?.gt &&
            (!state.leaseUntil || state.leaseUntil <= where.leaseUntil.gt)
          )
            return { count: 0 };
          Object.assign(state, {
            status: data.status,
            leaseOwner: data.leaseOwner,
            leaseUntil: data.leaseUntil,
          });
          if (data.leaseFence?.increment) state.leaseFence += data.leaseFence.increment;
          if (data.attemptCount?.increment) state.attemptCount += data.attemptCount.increment;
          return { count: 1 };
        }),
      },
      researchPortfolioOutputRequest: { update: jest.fn(async () => ({})) },
      researchPortfolioOutputArtifact: {
        create: jest.fn(async ({ data }: any) => ({ id: 'artifact', ...data })),
      },
      researchPortfolioOutputAttempt: { create: jest.fn(async () => ({})) },
    };
    const analytics = { analytics: jest.fn(async () => projection) };
    const service = new ResearchPortfolioOutputService(
      { withTenant: async (_tenant: string, work: any) => work(tx) } as never,
      analytics as never,
      {} as never,
    );
    return { service, tx, state, analytics };
  }

  it.each(['observed', 'partial'] as const)(
    'writes validated bytes and preserves the %s qualification in the terminal result',
    async (disposition) => {
      const projection = await project([[cell('source', '2.5', disposition)]]);
      const h = workerHarness(projection);
      await (h.service as any).process(ctx, portfolioId, 'job');
      const terminal = disposition === 'partial' ? 'partial' : 'completed';
      expect(h.state.status).toBe(terminal);
      expect(
        h.tx.researchPortfolioOutputRequest.update.mock.calls.map(
          ([args]: any) => args.data.status,
        ),
      ).toEqual(['running', terminal]);
      expect(h.tx.researchPortfolio.findFirst).toHaveBeenCalledTimes(1);
      const written = (h.tx.researchPortfolioOutputArtifact.create.mock.calls[0]![0] as any).data;
      expect(written.contentHash).toBe(createHash('sha256').update(written.bytes).digest('hex'));
      expect(written.byteSize).toBe(written.bytes.length);
      expect(written.bytes.toString()).toContain('2.5');
      expect(h.tx.researchPortfolioOutputAttempt.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ outcome: terminal }) }),
      );
    },
  );

  it('reauthorizes access after rendering before any artifact can be written', async () => {
    const projection = await project([[cell('source', '2.5')]]);
    const h = workerHarness(projection);
    h.analytics.analytics.mockImplementation(async () => {
      h.tx.researchPortfolio.findFirst.mockResolvedValue(null as never);
      return projection;
    });
    await (h.service as any).process(ctx, portfolioId, 'job');
    expect(h.state.status).toBe('failed');
    expect(h.tx.researchPortfolioOutputArtifact.create).not.toHaveBeenCalled();
    expect(h.tx.researchPortfolioOutputAttempt.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ outcome: 'failed' }) }),
    );
  });

  it('does not finalize successfully after its worker lease expires', async () => {
    const projection = await project([[cell('source', '2.5')]]);
    const h = workerHarness(projection);
    h.analytics.analytics.mockImplementation(async () => {
      h.state.leaseUntil = new Date(Date.now() - 1000);
      return projection;
    });
    await (h.service as any).process(ctx, portfolioId, 'job');
    expect(h.state.status).toBe('failed');
    expect(
      h.tx.researchPortfolioOutputRequest.update.mock.calls.map(([args]: any) => args.data.status),
    ).toEqual(['running', 'failed']);
    // Prisma.withTenant rolls back the rejected finalization transaction. This
    // dependency-level test asserts the externally visible request outcome;
    // populated-database rollback proof remains a separate release gate.
  });
});

describe('Generic output reconcile owning-domain role guard', () => {
  it('reauthorizes editor inside the actual domain service before observing or mutating a checkpoint', async () => {
    const h = outputHarness();
    await expect(h.service.reconcile(ctx, portfolioId, 'job-1', 'editor')).rejects.toMatchObject({
      status: 403,
    });
    expect(h.tx.researchPortfolioOutputJob.findFirst).not.toHaveBeenCalled();
    expect(h.tx.researchPortfolioOutputJob.updateMany).not.toHaveBeenCalled();
    expect(h.tx.researchPortfolioOutputAttempt.create).not.toHaveBeenCalled();
  });
});
