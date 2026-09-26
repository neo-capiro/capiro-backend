import type { TenantContext } from '@capiro/shared';
import { ResearchPortfolioImportService } from './research-portfolio-import.service.js';

const ctx: TenantContext = {
  tenantId: 'tenant-1',
  tenantSlug: 'tenant',
  userId: 'user-1',
  clerkUserId: 'clerk-1',
  role: 'standard_user',
};

const job = {
  id: 'job-1',
  tenantId: ctx.tenantId,
  portfolioId: 'portfolio-1',
  operationKey: 'create-1',
  worksheetKind: 'membership',
  status: 'previewed',
  targetRevision: 7,
};

function serviceWith(tx: any = {}) {
  const prisma = { withTenant: jest.fn((_tenant: string, action: (client: unknown) => unknown) => action(tx)) };
  return { service: new ResearchPortfolioImportService(prisma as any), prisma };
}

describe('ResearchPortfolioImportService', () => {
  it('rejects malformed CSV before opening a transaction', async () => {
    const { service, prisma } = serviceWith();

    await expect(service.createJob(ctx, job.portfolioId, {
      operationKey: 'malformed-1',
      expectedRevision: 7,
      worksheetKind: 'membership',
      fileName: 'bad.csv',
      mediaType: 'text/csv',
      contentBase64: Buffer.from('target_kind,target_id\nprogram_element,"unterminated').toString('base64'),
      schemaVersion: 'membership-v1',
      mapping: {},
    })).rejects.toThrow('Unterminated quoted field');
    expect(prisma.withTenant).not.toHaveBeenCalled();
  });

  it('classifies resolved, duplicate, invalid, ambiguous, inaccessible, and unresolved rows distinctly', async () => {
    const { service } = serviceWith();
    const tx = {
      programElement: { findUnique: jest.fn().mockResolvedValue({ peCode: '0604115A', title: 'Future Vertical Lift', serviceCode: 'A', service: 'Army', appropriationType: 'RDTE', source: 'R2', sourceConfidence: 1, firstSeenFy: 2027, raw: {} }) },
      capabilityBudgetLineMatch: { findMany: jest.fn().mockResolvedValue([]) },
      researchPortfolioMember: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    const seen = new Set<string>();

    const values = [];
    values.push(await (service as any).classify(tx, job, { target_kind: 'program_element', target_id: '0604115A' }, seen));
    values.push(await (service as any).classify(tx, job, { target_kind: 'program_element', target_id: '0604115A' }, seen));
    values.push(await (service as any).classify(tx, job, { target_kind: 'wrong', target_id: 'x' }, seen));
    values.push(await (service as any).classify(tx, job, { target_kind: 'program', target_id: '', label: 'Ambiguous program' }, seen));
    values.push(await (service as any).classify(tx, job, { target_kind: 'program', target_id: 'x', access: 'denied' }, seen));
    values.push(await (service as any).classify(tx, job, { target_kind: 'program', target_id: 'not-a-uuid' }, seen));

    expect(values.map((item) => item.value)).toEqual([
      'resolved', 'duplicate', 'invalid', 'ambiguous', 'inaccessible', 'unresolved',
    ]);
  });

  it('creates one canonical member while every duplicate or deselected row receives a terminal outcome', async () => {
    const { service } = serviceWith();
    const rows = [
      { id: 'row-1', selected: true, previewClassification: 'resolved', parsedData: { target_kind: 'program_element', target_id: '0604115A', label: 'FVL' }, rowNumber: 2 },
      { id: 'row-2', selected: true, previewClassification: 'duplicate', parsedData: { target_kind: 'program_element', target_id: '0604115A' }, rowNumber: 3 },
      { id: 'row-3', selected: false, previewClassification: 'resolved', parsedData: { target_kind: 'program_element', target_id: '0609999A' }, rowNumber: 4 },
    ];
    const tx = {
      researchPortfolioImportRow: {
        findMany: jest.fn().mockResolvedValue(rows),
        update: jest.fn().mockResolvedValue({}),
      },
      researchPortfolioImportJob: { update: jest.fn().mockResolvedValue({}) },
      researchPortfolioMember: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'member-1', revision: 1 }),
      },
      researchPortfolioImportEffect: { create: jest.fn().mockResolvedValue({}) },
      researchPortfolio: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };

    await (service as any).apply(tx, ctx, job, 7, { operationKey: 'apply-1', expectedRevision: 7 });

    expect(tx.researchPortfolioMember.create).toHaveBeenCalledTimes(1);
    expect(tx.researchPortfolioImportRow.update).toHaveBeenCalledTimes(3);
    expect(tx.researchPortfolioImportRow.update.mock.calls.map((call: any[]) => call[0].data.finalOutcome)).toEqual(['applied', 'skipped', 'skipped']);
    expect(tx.researchPortfolioImportJob.update).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'completed', appliedCount: 1 }) }));
  });

  it('supports fenced pause and resume transitions', async () => {
    const { service } = serviceWith();
    const tx = { researchPortfolioImportJob: { update: jest.fn().mockResolvedValue({}) } };

    await (service as any).transition(tx, { ...job, status: 'applying' }, ['applying'], 'paused');
    await (service as any).transition(tx, { ...job, status: 'paused' }, ['paused'], 'applying');

    expect(tx.researchPortfolioImportJob.update.mock.calls.map((call: any[]) => call[0].data.status)).toEqual(['paused', 'applying']);
  });

  it('reconciles unknown state from durable row outcomes and effect ownership without reapplying', async () => {
    const { service } = serviceWith();
    const tx = {
      researchPortfolioImportRow: { findMany: jest.fn().mockResolvedValue([{ finalOutcome: 'applied' }, { finalOutcome: 'skipped' }]) },
      researchPortfolioImportEffect: { count: jest.fn().mockResolvedValue(1) },
      researchPortfolioImportJob: { update: jest.fn().mockResolvedValue({}) },
    };

    await (service as any).reconcile(tx, { ...job, status: 'unknown' });

    expect(tx.researchPortfolioImportJob.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'completed', appliedCount: 1 }),
    }));
  });

  it('refuses compensation when the confirmed preview hash is stale', async () => {
    const { service } = serviceWith();
    const tx = {
      researchPortfolioImportEffect: {
        findMany: jest.fn().mockResolvedValue([{ id: 'effect-1', effectKind: 'member_created', targetId: 'member-1', targetRevisionAtApply: 1 }]),
      },
    };

    await expect((service as any).compensate(tx, ctx, { ...job, status: 'completed' }, 7, {
      operationKey: 'compensate-commit',
      expectedRevision: 7,
      compensationPreviewHash: 'stale',
    })).rejects.toThrow('Compensation preview is stale');
  });
});
