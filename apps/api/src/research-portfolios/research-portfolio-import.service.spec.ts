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
  const prisma = {
    withTenant: jest.fn((_tenant: string, action: (client: unknown) => unknown) => action(tx)),
  };
  return { service: new ResearchPortfolioImportService(prisma as any), prisma };
}

describe('ResearchPortfolioImportService', () => {
  it('rejects malformed CSV before opening a transaction', async () => {
    const { service, prisma } = serviceWith();

    await expect(
      service.createJob(ctx, job.portfolioId, {
        operationKey: 'malformed-1',
        expectedRevision: 7,
        worksheetKind: 'membership',
        fileName: 'bad.csv',
        mediaType: 'text/csv',
        contentBase64: Buffer.from('target_kind,target_id\nprogram_element,"unterminated').toString(
          'base64',
        ),
        schemaVersion: 'membership-v1',
        mapping: {},
      }),
    ).rejects.toThrow('Unterminated quoted field');
    expect(prisma.withTenant).not.toHaveBeenCalled();
  });

  it('classifies resolved, duplicate, invalid, ambiguous, inaccessible, and unresolved rows distinctly', async () => {
    const { service } = serviceWith();
    const tx = {
      programElement: {
        findUnique: jest
          .fn()
          .mockResolvedValue({
            peCode: '0604115A',
            title: 'Future Vertical Lift',
            serviceCode: 'A',
            service: 'Army',
            appropriationType: 'RDTE',
            source: 'R2',
            sourceConfidence: 1,
            firstSeenFy: 2027,
            raw: {},
          }),
      },
      capabilityBudgetLineMatch: { findMany: jest.fn().mockResolvedValue([]) },
      researchPortfolioMember: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    const seen = new Set<string>();

    const values = [];
    values.push(
      await (service as any).classify(
        tx,
        job,
        { target_kind: 'program_element', target_id: '0604115A' },
        seen,
      ),
    );
    values.push(
      await (service as any).classify(
        tx,
        job,
        { target_kind: 'program_element', target_id: '0604115A' },
        seen,
      ),
    );
    values.push(
      await (service as any).classify(tx, job, { target_kind: 'wrong', target_id: 'x' }, seen),
    );
    values.push(
      await (service as any).classify(
        tx,
        job,
        { target_kind: 'program', target_id: '', label: 'Ambiguous program' },
        seen,
      ),
    );
    values.push(
      await (service as any).classify(
        tx,
        job,
        { target_kind: 'program', target_id: 'x', access: 'denied' },
        seen,
      ),
    );
    values.push(
      await (service as any).classify(
        tx,
        job,
        { target_kind: 'program', target_id: 'not-a-uuid' },
        seen,
      ),
    );

    expect(values.map((item) => item.value)).toEqual([
      'resolved',
      'duplicate',
      'invalid',
      'ambiguous',
      'inaccessible',
      'unresolved',
    ]);
  });

  it('creates one canonical member while every duplicate or deselected row receives a terminal outcome', async () => {
    const { service } = serviceWith();
    const rows = [
      {
        id: 'row-1',
        selected: true,
        previewClassification: 'resolved',
        parsedData: { target_kind: 'program_element', target_id: '0604115A', label: 'FVL' },
        rowNumber: 2,
      },
      {
        id: 'row-2',
        selected: true,
        previewClassification: 'duplicate',
        parsedData: { target_kind: 'program_element', target_id: '0604115A' },
        rowNumber: 3,
      },
      {
        id: 'row-3',
        selected: false,
        previewClassification: 'resolved',
        parsedData: { target_kind: 'program_element', target_id: '0609999A' },
        rowNumber: 4,
      },
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
      $executeRawUnsafe: jest.fn(),
      researchPortfolio: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };

    await (service as any).apply(tx, ctx, job, 7, { operationKey: 'apply-1', expectedRevision: 7 });

    expect(tx.researchPortfolioMember.create).toHaveBeenCalledTimes(1);
    expect(tx.researchPortfolioImportRow.update).toHaveBeenCalledTimes(3);
    expect(
      tx.researchPortfolioImportRow.update.mock.calls.map(
        (call: any[]) => call[0].data.finalOutcome,
      ),
    ).toEqual(['applied', 'skipped', 'skipped']);
    expect(tx.researchPortfolioImportJob.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'completed', appliedCount: 1 }),
      }),
    );
  });

  it('supports fenced pause and resume transitions', async () => {
    const { service } = serviceWith();
    const tx = { researchPortfolioImportJob: { update: jest.fn().mockResolvedValue({}) } };

    await (service as any).transition(tx, { ...job, status: 'applying' }, ['applying'], 'paused');
    await (service as any).transition(tx, { ...job, status: 'paused' }, ['paused'], 'applying');

    expect(
      tx.researchPortfolioImportJob.update.mock.calls.map((call: any[]) => call[0].data.status),
    ).toEqual(['paused', 'applying']);
  });

  it('reconciles unknown state from durable row outcomes and effect ownership without reapplying', async () => {
    const { service } = serviceWith();
    const tx = {
      researchPortfolioImportRow: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ finalOutcome: 'applied' }, { finalOutcome: 'skipped' }]),
      },
      researchPortfolioImportEffect: { count: jest.fn().mockResolvedValue(1) },
      researchPortfolioImportJob: { update: jest.fn().mockResolvedValue({}) },
    };

    await (service as any).reconcile(tx, { ...job, status: 'unknown' });

    expect(tx.researchPortfolioImportJob.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'completed', appliedCount: 1 }),
      }),
    );
  });

  it('refuses compensation when the confirmed preview hash is stale', async () => {
    const { service } = serviceWith();
    const tx = {
      researchPortfolioImportEffect: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            {
              id: 'effect-1',
              effectKind: 'member_created',
              targetId: 'member-1',
              targetRevisionAtApply: 1,
            },
          ]),
      },
    };

    await expect(
      (service as any).compensate(tx, ctx, { ...job, status: 'completed' }, 7, {
        operationKey: 'compensate-commit',
        expectedRevision: 7,
        compensationPreviewHash: 'stale',
      }),
    ).rejects.toThrow('Compensation preview is stale');
  });
});

describe('Research portfolio import repreview recovery', () => {
  function repreviewHarness() {
    const currentJob: any = {
      ...job,
      originalBytes: Buffer.from(
        'target_kind,target_id\nprogram_element,0604115A\nprogram_element,0609999A',
      ),
      status: 'partial',
    };
    const prior: any = {
      id: 'row-1',
      rowIdentity: '',
      finalOutcome: 'applied',
      selected: true,
      previewClassification: 'resolved',
      parsedData: { target_kind: 'program_element', target_id: '0604115A' },
      expectedRevision: 7,
    };
    const tx: any = {
      researchPortfolioImportMappingVersion: {
        findFirstOrThrow: jest
          .fn()
          .mockResolvedValue({ mapping: { target_kind: 'target_kind', target_id: 'target_id' } }),
      },
      researchPortfolioImportRow: {
        findMany: jest.fn().mockResolvedValue([]),
        upsert: jest.fn(),
        update: jest.fn(),
      },
      researchPortfolioImportJob: {
        update: jest.fn(async ({ data }: any) => Object.assign(currentJob, data)),
      },
      researchPortfolioMember: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'new-member', revision: 1 }),
      },
      researchPortfolioImportEffect: { create: jest.fn() },
      $executeRawUnsafe: jest.fn(),
      researchPortfolio: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      programElement: {
        findUnique: jest.fn(async ({ where }: any) => ({
          peCode: where.peCode,
          title: 'Canonical PE',
          service: 'Army',
          sourceConfidence: 1,
          raw: {},
        })),
      },
      capabilityBudgetLineMatch: { findMany: jest.fn().mockResolvedValue([]) },
    };
    return { currentJob, tx, prior, service: serviceWith(tx).service as any };
  }
  it('rebases job and unfinished rows to the explicitly current revision, then applies once', async () => {
    const { currentJob, tx, service } = repreviewHarness();
    await service.preview(
      tx,
      ctx,
      currentJob,
      { operationKey: 'repreview-8', expectedRevision: 8 },
      8,
    );
    expect(currentJob.targetRevision).toBe(8);
    const previewRows = tx.researchPortfolioImportRow.upsert.mock.calls.map((c: any[]) => ({
      id: 'row-' + c[0].create.rowNumber,
      ...c[0].create,
    }));
    expect(previewRows.every((r: any) => r.expectedRevision === 8)).toBe(true);
    tx.researchPortfolioImportRow.findMany.mockResolvedValue(previewRows);
    await service.apply(tx, ctx, currentJob, 8, { expectedRevision: 8 });
    expect(tx.researchPortfolioMember.create).toHaveBeenCalledTimes(2);
    expect(currentJob.appliedCount).toBe(2);
    expect(tx.researchPortfolio.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ revision: 8 }) }),
    );
  });
  it('preserves committed rows and their effect receipts across repair and retry', async () => {
    const { currentJob, tx, prior, service } = repreviewHarness();
    await service.preview(
      tx,
      ctx,
      currentJob,
      { operationKey: 'first-preview', expectedRevision: 8 },
      8,
    );
    const firstRow = tx.researchPortfolioImportRow.upsert.mock.calls[0][0].create;
    prior.rowIdentity = firstRow.rowIdentity;
    tx.researchPortfolioImportRow.upsert.mockClear();
    tx.researchPortfolioImportRow.findMany.mockResolvedValue([prior]);
    await service.preview(
      tx,
      ctx,
      currentJob,
      {
        operationKey: 'retry-preview',
        expectedRevision: 9,
        repairs: { 'row-1': { label: 'Do not overwrite committed row' } },
        selectedRowIds: [],
      },
      9,
    );
    expect(tx.researchPortfolioImportRow.upsert).toHaveBeenCalledTimes(1);
    expect(prior.expectedRevision).toBe(7);
    const unfinished = {
      id: 'row-2',
      ...tx.researchPortfolioImportRow.upsert.mock.calls[0][0].create,
      selected: true,
    };
    tx.researchPortfolioImportRow.findMany.mockResolvedValue([prior, unfinished]);
    await service.apply(tx, ctx, currentJob, 9, { expectedRevision: 9 });
    expect(tx.researchPortfolioMember.create).toHaveBeenCalledTimes(1);
    expect(tx.researchPortfolioImportEffect.create).toHaveBeenCalledTimes(1);
    expect(
      tx.researchPortfolioImportRow.update.mock.calls.every(
        (c: any[]) => c[0].where.id !== prior.id,
      ),
    ).toBe(true);
    expect(currentJob.appliedCount).toBe(2);
  });
  it('rejects stale preview before row or job changes', async () => {
    const { currentJob, tx, service } = repreviewHarness();
    await expect(service.preview(tx, ctx, currentJob, { expectedRevision: 7 }, 8)).rejects.toThrow(
      'revision mismatch',
    );
    expect(tx.researchPortfolioImportRow.upsert).not.toHaveBeenCalled();
    expect(tx.researchPortfolioImportJob.update).not.toHaveBeenCalled();
  });
  it('captures current server revision for callers that omit preview revision', async () => {
    const h = repreviewHarness();
    await h.service.preview(h.tx, ctx, h.currentJob, { operationKey: 'existing-ui-preview' }, 8);
    expect(h.currentJob.targetRevision).toBe(8);
  });
});

describe('Research portfolio governed rule and review import', () => {
  it('rolls a failed membership effect back before writing its failed row receipt and continues valid rows', async () => {
    const rows: any[] = [
      {
        id: 'effect-failure',
        selected: true,
        previewClassification: 'resolved',
        parsedData: { target_kind: 'program_element', target_id: '0604115A' },
        rowNumber: 2,
      },
      {
        id: 'valid-after-fault',
        selected: true,
        previewClassification: 'resolved',
        parsedData: { target_kind: 'program_element', target_id: '0609999A' },
        rowNumber: 3,
      },
      {
        id: 'invalid-selected',
        selected: true,
        previewClassification: 'unresolved',
        parsedData: {},
        rowNumber: 4,
      },
      {
        id: 'deliberately-unselected',
        selected: false,
        previewClassification: 'invalid',
        parsedData: {},
        rowNumber: 5,
      },
    ];
    const calls: string[] = [];
    const tx: any = {
      researchPortfolioImportRow: {
        findMany: jest.fn().mockResolvedValue(rows),
        update: jest.fn(async ({ where, data }: any) =>
          calls.push(`${where.id}:${data.finalOutcome}`),
        ),
      },
      researchPortfolioImportJob: { update: jest.fn() },
      researchPortfolioMember: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'new-member', revision: 1 }),
      },
      researchPortfolioImportEffect: {
        create: jest
          .fn()
          .mockRejectedValueOnce(new Error('injected effect constraint failure'))
          .mockResolvedValue({}),
      },
      researchPortfolio: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      $executeRawUnsafe: jest.fn(async (sql: string) => calls.push(sql)),
    };
    await (serviceWith(tx).service as any).apply(tx, ctx, job, 7, { expectedRevision: 7 });
    expect(calls.indexOf('ROLLBACK TO SAVEPOINT rp_import_member_row')).toBeLessThan(
      calls.indexOf('effect-failure:failed'),
    );
    expect(calls).toContain('valid-after-fault:applied');
    expect(calls).toContain('invalid-selected:failed');
    expect(calls).toContain('deliberately-unselected:skipped');
    expect(tx.researchPortfolioImportJob.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'partial', appliedCount: 1 }),
      }),
    );
    expect(tx.researchPortfolio.updateMany).toHaveBeenCalledTimes(1);
  });
  function governed(kind: 'rules' | 'reviews', data: any) {
    const currentJob: any = { ...job, worksheetKind: kind, status: 'previewed', targetRevision: 7 };
    const row: any = {
      id: 'row-owned',
      rowIdentity: 'stable-row-hash',
      rowNumber: 2,
      selected: true,
      previewClassification: 'resolved',
      parsedData: data,
      finalOutcome: null,
    };
    let createdReview: any = null;
    const tx: any = {
      researchPortfolioGrant: {
        findUnique: jest
          .fn()
          .mockResolvedValue({
            id: 'grant-1',
            role: 'editor',
            portfolio: { lifecycle: 'active', revision: 7 },
          }),
      },
      researchPortfolio: {
        findUnique: jest.fn().mockResolvedValue({ lifecycle: 'active', revision: 7 }),
        findUniqueOrThrow: jest.fn().mockResolvedValue({ revision: 7 }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      researchPortfolioImportRow: {
        findMany: jest.fn().mockResolvedValue([row]),
        update: jest.fn(async ({ data }: any) => Object.assign(row, data)),
      },
      researchPortfolioImportJob: {
        update: jest.fn(async ({ data }: any) => Object.assign(currentJob, data)),
      },
      researchPortfolioMember: { findMany: jest.fn().mockResolvedValue([]) },
      researchPortfolioRulePreview: {
        upsert: jest.fn(async ({ create }: any) => ({ ...create, id: 'governed-draft-1' })),
      },
      researchPortfolioRuleVersion: {
        create: jest.fn(),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      researchPortfolioReview: {
        findUnique: jest.fn(async ({ where }: any) => (where.id ? createdReview : null)),
        create: jest.fn(
          async ({ data }: any) =>
            (createdReview = { ...data, id: 'import-review-1', revision: 1 }),
        ),
        update: jest.fn(async ({ data }: any) => ({ ...createdReview, ...data, revision: 2 })),
      },
      researchPortfolioDecision: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(async ({ data }: any) => ({ ...data, id: 'import-decision-1' })),
      },
      programIdentityCrosswalk: { findMany: jest.fn().mockResolvedValue([]) },
      researchPortfolioContinuityLedger: { create: jest.fn().mockResolvedValue({}) },
      researchPortfolioEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ occurredAt: new Date('2028-09-30T01:00:00Z') }),
      },
      researchPortfolioImportEffect: { create: jest.fn() },
      programElement: {
        findUnique: jest.fn(async ({ where }: any) => ({
          peCode: where.peCode,
          title: 'PE',
          service: 'Army',
          sourceConfidence: 1,
          raw: {},
        })),
      },
      capabilityBudgetLineMatch: { findMany: jest.fn().mockResolvedValue([]) },
      $executeRawUnsafe: jest.fn(),
    };
    return { tx, row, currentJob, service: serviceWith(tx).service as any };
  }
  it('creates an owned governed draft with actual preview receipt and never publishes automatically', async () => {
    const h = governed('rules', {
      readable_expression: 'Army',
      expression_json: JSON.stringify({
        kind: 'condition',
        field: 'component',
        operator: 'eq',
        value: 'ARMY',
      }),
    });
    await h.service.apply(h.tx, ctx, h.currentJob, 7, { expectedRevision: 7 });
    expect(h.row.finalDisposition).toMatchObject({
      previewId: 'governed-draft-1',
      previewHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      requiresPublish: true,
    });
    expect(h.tx.researchPortfolioImportEffect.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        effectKind: 'rule_preview_created',
        targetId: 'governed-draft-1',
      }),
    });
    expect(
      h.tx.researchPortfolioRulePreview.upsert.mock.calls[0][0].create.manifest.request
        .importOperationKey,
    ).toMatch(/^rpimport:/);
    expect(h.tx.researchPortfolioRuleVersion.create).not.toHaveBeenCalled();
    expect(h.tx.researchPortfolio.updateMany).not.toHaveBeenCalled();
    expect(h.currentJob).toMatchObject({ status: 'completed', appliedCount: 1 });
    expect(h.tx.$executeRawUnsafe.mock.calls.map((c: any[]) => c[0])).toEqual([
      'SAVEPOINT rp_import_governed_row',
      'RELEASE SAVEPOINT rp_import_governed_row',
    ]);
    h.currentJob.status = 'previewed';
    await h.service.apply(h.tx, ctx, h.currentJob, 7, { expectedRevision: 7 });
    expect(h.tx.researchPortfolioRulePreview.upsert).toHaveBeenCalledTimes(1);
    expect(h.tx.researchPortfolioImportEffect.create).toHaveBeenCalledTimes(1);
  });
  it('commits an evidenced legal review decision through the native decision service in the same transaction', async () => {
    const evidence = [
      {
        sourceRevisionId: 'immutable-source-1',
        locator: { page: 3, row: 2 },
        quote: 'Exact claim',
        stance: 'for',
      },
    ];
    const h = governed('reviews', {
      target_kind: 'program_element',
      target_id: '0604115A',
      reason: 'Imported supported decision',
      decision_type: 'include',
      evidence_for: JSON.stringify(evidence),
    });
    await h.service.apply(h.tx, ctx, h.currentJob, 7, { expectedRevision: 7 });
    expect(h.row.finalDisposition).toMatchObject({
      reviewId: 'import-review-1',
      decisionId: 'import-decision-1',
      reviewRevision: 2,
    });
    expect(h.tx.researchPortfolioDecision.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        decisionType: 'include',
        evidenceFor: evidence,
        priorDecisionId: null,
        supersedesId: null,
      }),
    });
    expect(h.tx.researchPortfolioImportEffect.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        effectKind: 'review_decided',
        targetId: 'import-review-1',
        targetRevisionAtApply: 2,
      }),
    });
    expect(h.currentJob).toMatchObject({ status: 'completed', appliedCount: 1 });
    expect(h.tx.researchPortfolio.updateMany).toHaveBeenCalledTimes(1);
  });
  it.each([
    { decision_type: 'invented', evidence_for: '[]' },
    { decision_type: 'include', evidence_for: '[]' },
    {
      decision_type: 'include',
      evidence_for: JSON.stringify([
        { sourceRevisionId: 'immutable-source-1', locator: {}, stance: 'for' },
      ]),
    },
  ])(
    'rolls back an invalid decision row before review/effect creation and records a failed receipt',
    async (bad) => {
      const h = governed('reviews', {
        target_kind: 'program_element',
        target_id: '0604115A',
        reason: 'Invalid evidence',
        ...bad,
      });
      await h.service.apply(h.tx, ctx, h.currentJob, 7, { expectedRevision: 7 });
      expect(h.currentJob.status).toBe('partial');
      expect(h.row.finalOutcome).toBe('failed');
      expect(h.tx.researchPortfolioReview.create).not.toHaveBeenCalled();
      expect(h.tx.researchPortfolioDecision.create).not.toHaveBeenCalled();
      expect(h.tx.researchPortfolioImportEffect.create).not.toHaveBeenCalled();
      expect(h.tx.$executeRawUnsafe).toHaveBeenCalledWith(
        'ROLLBACK TO SAVEPOINT rp_import_governed_row',
      );
    },
  );
  it('retains a published imported rule and a later-edited review during compensation', async () => {
    const { service } = serviceWith();
    const effects: any[] = [
      {
        id: 'effect-rule',
        effectKind: 'rule_preview_created',
        targetId: 'draft-1',
        payload: { previewHash: 'a'.repeat(64), expiresAt: '2028-09-30T01:00:00Z' },
      },
      {
        id: 'effect-review',
        effectKind: 'review_decided',
        targetId: 'review-1',
        targetRevisionAtApply: 2,
        payload: { decisionId: 'decision-1' },
      },
    ];
    const tx: any = {
      researchPortfolioImportEffect: { findMany: jest.fn().mockResolvedValue(effects) },
      researchPortfolioImportCompensationReceipt: {
        create: jest.fn(),
        findFirst: jest.fn().mockResolvedValue({ id: 'preview-receipt' }),
      },
      researchPortfolioRuleVersion: {
        findFirst: jest.fn().mockResolvedValue({ id: 'published-rule' }),
      },
      researchPortfolioRulePreview: { deleteMany: jest.fn() },
      researchPortfolioReview: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    };
    await (service as any).compensate(tx, ctx, { ...job, status: 'completed' }, 7, {
      operationKey: 'preview-owned',
    });
    const previewHash =
      tx.researchPortfolioImportCompensationReceipt.create.mock.calls[0][0].data.previewHash;
    await expect(
      (service as any).compensate(tx, ctx, { ...job, status: 'completed' }, 7, {
        operationKey: 'commit-owned',
        expectedRevision: 7,
        compensationPreviewHash: previewHash,
      }),
    ).rejects.toThrow('changed after apply');
    expect(tx.researchPortfolioRulePreview.deleteMany).not.toHaveBeenCalled();
    expect(tx.researchPortfolioReview.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ revision: 2 }) }),
    );
  });
});

describe('Import creation durable recovery authority', () => {
  function harness() {
    const portfolio: any = {
      id: job.portfolioId,
      revision: 7,
      lifecycle: 'active',
      grants: [{ role: 'editor' }],
    };
    let stored: any = null;
    let event: any = null;
    const tx: any = {
      researchPortfolio: {
        findFirst: jest.fn(async () => portfolio),
        findUniqueOrThrow: jest.fn(async () => portfolio),
      },
      researchPortfolioImportJob: {
        findUnique: jest.fn(async () => stored),
        create: jest.fn(async ({ data }: any) => {
          stored = {
            ...data,
            id: 'created-job',
            mappings: [],
            createdAt: new Date(),
            updatedAt: new Date(),
          };
          return stored;
        }),
      },
      researchPortfolioImportMappingVersion: {
        create: jest.fn(async ({ data }: any) => {
          stored.mappings.push(data);
          return data;
        }),
      },
      researchPortfolioEvent: {
        findUnique: jest.fn(async () => event),
        create: jest.fn(async ({ data }: any) => {
          event = data;
          return data;
        }),
      },
    };
    const input: any = {
      operationKey: 'recovery-create',
      expectedRevision: 7,
      worksheetKind: 'membership',
      fileName: 'owned.csv',
      mediaType: 'text/csv',
      contentBase64: Buffer.from('target_kind,target_id\nprogram_element,0604115A').toString(
        'base64',
      ),
      schemaVersion: 'membership-v1',
      mapping: {},
    };
    return { tx, portfolio, input, service: serviceWith(tx).service };
  }
  it('returns the originally created job after revision drift and archival without a second write', async () => {
    const { tx, portfolio, input, service } = harness();
    const first = await service.createJob(ctx, job.portfolioId, input);
    portfolio.revision = 12;
    portfolio.lifecycle = 'archived';
    expect(await service.createJob(ctx, job.portfolioId, input)).toEqual(first);
    expect(tx.researchPortfolioImportJob.create).toHaveBeenCalledTimes(1);
    expect(tx.researchPortfolioEvent.create).toHaveBeenCalledTimes(1);
  });
  it('denies revoked editors and another actor before returning a durable creation receipt', async () => {
    const { portfolio, input, service } = harness();
    await service.createJob(ctx, job.portfolioId, input);
    await expect(
      service.createJob({ ...ctx, userId: 'another-user' }, job.portfolioId, input),
    ).rejects.toThrow('another actor');
    portfolio.grants = [];
    await expect(service.createJob(ctx, job.portfolioId, input)).rejects.toThrow('not found');
  });
  it('rejects changed content under the same key, and fresh archived writes remain blocked', async () => {
    const { tx, portfolio, input, service } = harness();
    await service.createJob(ctx, job.portfolioId, input);
    await expect(
      service.createJob(ctx, job.portfolioId, {
        ...input,
        contentBase64: Buffer.from('target_kind,target_id\nprogram_element,0609999A').toString(
          'base64',
        ),
      }),
    ).rejects.toThrow('different import content');
    tx.researchPortfolioImportJob.findUnique.mockResolvedValue(null);
    portfolio.lifecycle = 'archived';
    await expect(
      service.createJob(ctx, job.portfolioId, { ...input, operationKey: 'fresh-key' }),
    ).rejects.toThrow('Archived');
  });
});

describe('Import action immutable request and actor replay', () => {
  function harness() {
    const portfolio: any = {
      id: job.portfolioId,
      revision: 7,
      lifecycle: 'active',
      grants: [{ role: 'editor' }],
    };
    const ownedJob: any = {
      ...job,
      status: 'applying',
      rows: [],
      mappings: [],
      attempts: [],
      effects: [],
      receipts: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    let stored: any = null;
    const tx: any = {
      researchPortfolio: {
        findFirst: jest.fn(async () => portfolio),
        findUniqueOrThrow: jest.fn(async () => portfolio),
      },
      researchPortfolioImportJob: {
        findFirst: jest.fn(async () => ownedJob),
        findUniqueOrThrow: jest.fn(async () => ownedJob),
        update: jest.fn(async ({ data }: any) => Object.assign(ownedJob, data)),
      },
      researchPortfolioImportAttempt: {
        findUnique: jest.fn(async () => stored),
        create: jest.fn(async ({ data }: any) => {
          stored = { ...data, id: 'attempt-1', createdAt: new Date() };
          ownedJob.attempts.push(stored);
          return stored;
        }),
      },
      researchPortfolioEvent: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({}),
      },
    };
    const input: any = {
      operationKey: 'owned-pause',
      expectedRevision: 7,
      selectedRowIds: ['row-owned'],
      repairs: { 'row-owned': { reason: 'Original repair' } },
    };
    return {
      tx,
      portfolio,
      ownedJob,
      input,
      service: serviceWith(tx).service,
      legacy: () => {
        stored.receipt = { status: 'paused' };
      },
    };
  }
  it('recovers a real successful original action after mutable revision and archival without repeating effects', async () => {
    const h = harness();
    const first = await h.service.action(ctx, job.portfolioId, job.id, 'pause', h.input);
    expect(first.status).toBe('paused');
    h.portfolio.revision = 12;
    h.portfolio.lifecycle = 'archived';
    expect((await h.service.action(ctx, job.portfolioId, job.id, 'pause', h.input)).status).toBe(
      'paused',
    );
    expect(h.tx.researchPortfolioImportJob.update).toHaveBeenCalledTimes(1);
    expect(h.tx.researchPortfolioImportAttempt.create).toHaveBeenCalledTimes(1);
    expect(h.ownedJob.attempts[0].receipt).toMatchObject({
      receiptVersion: 1,
      requestFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      status: 'paused',
    });
  });
  it.each([
    { expectedRevision: 8 },
    { selectedRowIds: ['another-row'] },
    { repairs: { 'row-owned': { reason: 'Changed repair' } } },
  ])('rejects changed semantic request fields under an already committed key', async (change) => {
    const h = harness();
    await h.service.action(ctx, job.portfolioId, job.id, 'pause', h.input);
    await expect(
      h.service.action(ctx, job.portfolioId, job.id, 'pause', { ...h.input, ...change }),
    ).rejects.toThrow('different import request');
    expect(h.tx.researchPortfolioImportJob.update).toHaveBeenCalledTimes(1);
  });
  it('requires the original actor and current editor authority before a durable replay', async () => {
    const h = harness();
    await h.service.action(ctx, job.portfolioId, job.id, 'pause', h.input);
    await expect(
      h.service.action(
        { ...ctx, userId: 'another-editor' },
        job.portfolioId,
        job.id,
        'pause',
        h.input,
      ),
    ).rejects.toThrow('another actor');
    h.portfolio.grants = [];
    await expect(h.service.action(ctx, job.portfolioId, job.id, 'pause', h.input)).rejects.toThrow(
      'not found',
    );
  });
  it('refuses ambiguous legacy request replay while keeping its durable job readable', async () => {
    const h = harness();
    await h.service.action(ctx, job.portfolioId, job.id, 'pause', h.input);
    h.legacy();
    await expect(h.service.action(ctx, job.portfolioId, job.id, 'pause', h.input)).rejects.toThrow(
      'Legacy import action receipt',
    );
    expect((await h.service.getJob(ctx, job.portfolioId, job.id)).status).toBe('paused');
    expect(h.tx.researchPortfolioImportJob.update).toHaveBeenCalledTimes(1);
  });
});

describe('Known compensation failure commits its receipt after atomic effect rollback', () => {
  function harness(laterEdit = true) {
    const portfolio: any = {
      id: job.portfolioId,
      revision: 7,
      lifecycle: 'active',
      grants: [{ role: 'editor' }],
    };
    const members: any[] = [
      { id: 'owned-a', revision: 1, disposition: 'included' },
      { id: 'owned-b', revision: laterEdit ? 2 : 1, disposition: 'included' },
    ];
    const effects: any[] = members.map((member, i) => ({
      id: `effect-${i}`,
      effectKind: 'member_created',
      targetId: member.id,
      targetRevisionAtApply: 1,
      appliedAt: new Date(),
    }));
    const ownedJob: any = {
      ...job,
      status: 'completed',
      rows: [],
      mappings: [],
      attempts: [],
      effects,
      receipts: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const tx: any = {
      researchPortfolio: {
        findFirst: jest.fn(async () => portfolio),
        findUniqueOrThrow: jest.fn(async () => portfolio),
        updateMany: jest.fn(async () => {
          portfolio.revision++;
          return { count: 1 };
        }),
      },
      researchPortfolioImportJob: {
        findFirst: jest.fn(async () => ownedJob),
        findUniqueOrThrow: jest.fn(async () => ownedJob),
        update: jest.fn(async ({ data }: any) => Object.assign(ownedJob, data)),
      },
      researchPortfolioImportAttempt: {
        findUnique: jest.fn(
          async ({ where }: any) =>
            ownedJob.attempts.find(
              (row: any) => row.operationKey === where.tenantId_operationKey.operationKey,
            ) ?? null,
        ),
        create: jest.fn(async ({ data }: any) => {
          const row = { ...data, id: `attempt-${ownedJob.attempts.length}`, createdAt: new Date() };
          ownedJob.attempts.push(row);
          return row;
        }),
      },
      researchPortfolioImportEffect: { findMany: jest.fn(async () => effects) },
      researchPortfolioImportCompensationReceipt: {
        findFirst: jest.fn(async () =>
          ownedJob.receipts.find((row: any) => row.status === 'previewed'),
        ),
        create: jest.fn(async ({ data }: any) => {
          const row = { ...data, id: `receipt-${ownedJob.receipts.length}`, createdAt: new Date() };
          ownedJob.receipts.push(row);
          return row;
        }),
      },
      researchPortfolioMember: {
        updateMany: jest.fn(async ({ where, data }: any) => {
          const member = members.find((row) => row.id === where.id);
          if (!member || member.revision !== where.revision) return { count: 0 };
          member.disposition = data.disposition;
          member.revision++;
          return { count: 1 };
        }),
      },
      researchPortfolioEvent: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({}),
      },
    };
    let savepoint: any = null;
    let commits = 0;
    let rollbacks = 0;
    const snapshot = () => ({
      members: members.map((row) => ({ ...row })),
      receiptCount: ownedJob.receipts.length,
      attemptCount: ownedJob.attempts.length,
      revision: portfolio.revision,
      status: ownedJob.status,
    });
    const restore = (state: any) => {
      members.splice(0, members.length, ...state.members);
      ownedJob.receipts.splice(state.receiptCount);
      ownedJob.attempts.splice(state.attemptCount);
      portfolio.revision = state.revision;
      ownedJob.status = state.status;
    };
    tx.$executeRawUnsafe = jest.fn(async (sql: string) => {
      if (sql.startsWith('SAVEPOINT')) savepoint = snapshot();
      if (sql.startsWith('ROLLBACK TO')) restore(savepoint);
    });
    const service = new ResearchPortfolioImportService({
      withTenant: async (_tenant: string, work: any) => {
        const initial = snapshot();
        try {
          const result = await work(tx);
          commits++;
          return result;
        } catch (error) {
          restore(initial);
          rollbacks++;
          throw error;
        }
      },
    } as any);
    const preview = async () => {
      await service.action(ctx, job.portfolioId, job.id, 'compensate', {
        operationKey: 'compensation-preview',
      });
      return ownedJob.receipts[0].previewHash;
    };
    return {
      tx,
      service,
      portfolio,
      members,
      effects,
      ownedJob,
      preview,
      counts: () => ({ commits, rollbacks }),
    };
  }
  it('returns conflict after committing a failed receipt/attempt while all earlier effects stay unchanged', async () => {
    const h = harness();
    const previewHash = await h.preview();
    const before = JSON.stringify(h.members);
    const input = {
      operationKey: 'compensation-known-failure',
      expectedRevision: 7,
      compensationPreviewHash: previewHash,
    };
    await expect(
      h.service.action(ctx, job.portfolioId, job.id, 'compensate', input),
    ).rejects.toThrow('changed after apply');
    expect(JSON.stringify(h.members)).toBe(before);
    expect(h.counts()).toEqual({ commits: 2, rollbacks: 0 });
    expect(h.ownedJob.receipts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: 'failed',
          operationKey: input.operationKey,
          actorUserId: ctx.userId,
        }),
      ]),
    );
    expect(h.ownedJob.attempts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          outcome: 'known_failure',
          errorCode: 'compensation_conflict',
          receipt: expect.objectContaining({
            receiptVersion: 1,
            requestFingerprint: expect.any(String),
            failureMessage: expect.stringContaining('changed after apply'),
          }),
        }),
      ]),
    );
    const raw = h.tx.$executeRawUnsafe.mock.calls.map((row: any[]) => row[0]);
    expect(raw).toContain('ROLLBACK TO SAVEPOINT rp_import_compensation_action');
    expect(
      (await h.service.getJob(ctx, job.portfolioId, job.id)).compensationReceipts.some(
        (row) => row.status === 'failed',
      ),
    ).toBe(true);
    h.tx.researchPortfolioMember.updateMany.mockClear();
    h.portfolio.revision = 12;
    h.portfolio.lifecycle = 'archived';
    await expect(
      h.service.action(ctx, job.portfolioId, job.id, 'compensate', input),
    ).rejects.toThrow('changed after apply');
    expect(h.tx.researchPortfolioMember.updateMany).not.toHaveBeenCalled();
    await expect(
      h.service.action(
        { ...ctx, userId: 'another-actor' },
        job.portfolioId,
        job.id,
        'compensate',
        input,
      ),
    ).rejects.toThrow('another actor');
  });
  it('keeps successful compensation atomic and records committed history once', async () => {
    const h = harness(false);
    const previewHash = await h.preview();
    const result = await h.service.action(ctx, job.portfolioId, job.id, 'compensate', {
      operationKey: 'compensation-success',
      expectedRevision: 7,
      compensationPreviewHash: previewHash,
    });
    expect(result.status).toBe('compensated');
    expect(h.members.map((row) => row.disposition)).toEqual(['withdrawn', 'withdrawn']);
    expect(h.ownedJob.receipts.filter((row: any) => row.status === 'committed')).toHaveLength(1);
    expect(h.ownedJob.effects).toHaveLength(2);
  });
  it('fails closed when an old effect lacks the revision required to protect later edits', async () => {
    const h = harness(false);
    h.effects[0].targetRevisionAtApply = null;
    const before = JSON.stringify(h.members);
    const previewHash = await h.preview();
    await expect(
      h.service.action(ctx, job.portfolioId, job.id, 'compensate', {
        operationKey: 'compensation-unqualified-effect',
        expectedRevision: 7,
        compensationPreviewHash: previewHash,
      }),
    ).rejects.toThrow('changed after apply');
    expect(JSON.stringify(h.members)).toBe(before);
    expect(h.tx.researchPortfolioMember.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: 'owned-a', revision: -1 }) }),
    );
  });
});
