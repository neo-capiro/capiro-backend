import { ResearchPortfolioOutputService } from './research-portfolio-output.service.js';
import { createHash } from 'node:crypto';
const ctx: any = { tenantId: 'tenant-owned', userId: 'actor-owned' };
function fixture() {
  const state = {
    membership: true,
    grant: true,
    link: true,
    wall: true,
    checkpointFails: false,
  };
  const jobs: any[] = [],
    receipts: any[] = [];
  const artifact = {
    id: 'artifact-owned',
    fileName: 'owned.csv',
    mediaType: 'text/csv',
    bytes: Buffer.from('owned'),
    byteSize: 5,
    contentHash: createHash('sha256').update('owned').digest('hex'),
    job: { status: 'completed' },
  };
  const tx: any = {
    tenantMembership: {
      findFirst: jest.fn(async () => (state.membership ? { id: 'membership-owned' } : null)),
    },
    researchPortfolio: {
      findFirst: jest.fn(async () =>
        state.grant
          ? {
              grants: [{ role: 'viewer' }],
              clientLinks: state.link ? [{ clientId: 'client-owned' }] : [],
            }
          : null,
      ),
    },
    $queryRawUnsafe: jest.fn(async () => [{ allowed: state.wall }]),
    researchPortfolioOutputArtifact: {
      findFirst: jest.fn(async () => artifact),
    },
    researchPortfolioOutputClientFileReceipt: {
      findUnique: jest.fn(async ({ where }: any) =>
        where.tenantId_id
          ? (receipts.find((x) => x.id === where.tenantId_id.id) ?? null)
          : (receipts.find((x) => x.operationKey === where.tenantId_operationKey.operationKey) ??
            null),
      ),
      create: jest.fn(async ({ data }: any) => {
        const row = {
          id: 'receipt-' + (receipts.length + 1),
          ...data,
          createdAt: new Date(),
        };
        receipts.push(row);
        return row;
      }),
    },
    researchPortfolioClientFilingJob: {
      findUnique: jest.fn(async ({ where }: any) => {
        const key = where.tenantId_actorUserId_operationKey;
        return (
          jobs.find(
            (x) =>
              x.tenantId === key.tenantId &&
              x.actorUserId === key.actorUserId &&
              x.operationKey === key.operationKey,
          ) ?? null
        );
      }),
      create: jest.fn(async ({ data }: any) => {
        const row = {
          id: 'filing-' + (jobs.length + 1),
          externalCheckpoint: {},
          receiptId: null,
          ...data,
        };
        jobs.push(row);
        return row;
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        if (data.externalCheckpoint && state.checkpointFails)
          throw Error('database unavailable after writer');
        const row = jobs.find((x) =>
          Object.entries(where).every(([key, value]) => x[key] === value),
        );
        if (!row) return { count: 0 };
        Object.assign(
          row,
          data,
          data.writerFence?.increment
            ? { writerFence: row.writerFence + data.writerFence.increment }
            : {},
        );
        return { count: 1 };
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = jobs.find((x) => x.id === where.tenantId_id.id);
        Object.assign(row, data);
        return row;
      }),
    },
  };
  const prisma: any = {
    withTenant: jest.fn(async (_tenant: string, fn: any) => fn(tx)),
    withTenantUser: jest.fn(async (tenant: string, actor: string, fn: any) => {
      expect(tenant).toBe(ctx.tenantId);
      expect(actor).toBe(ctx.userId);
      const priorJobs = structuredClone(jobs),
        priorReceipts = structuredClone(receipts);
      try {
        return await fn(tx);
      } catch (error) {
        jobs.splice(0, jobs.length, ...priorJobs);
        receipts.splice(0, receipts.length, ...priorReceipts);
        throw error;
      }
    }),
  };
  let enteredResolve!: () => void, releaseResolve!: () => void;
  const entered = new Promise<void>((r) => (enteredResolve = r)),
    gate = new Promise<void>((r) => (releaseResolve = r));
  const writer: any = {
    createAttachmentFromBuffer: jest.fn(async () => {
      enteredResolve();
      await gate;
      return {
        id: 'attachment-observed',
        fileName: 'owned.csv',
        lifecycleStatus: 'active',
      };
    }),
  };
  const service = new ResearchPortfolioOutputService(prisma, {} as any, writer);
  const input = { clientId: 'client-owned', operationKey: 'retained-key' };
  const save = () => service.saveToClient(ctx, 'portfolio-owned', artifact.id, input);
  return {
    state,
    jobs,
    receipts,
    tx,
    prisma,
    writer,
    service,
    input,
    save,
    entered,
    release: releaseResolve,
  };
}
const outcomeUnknown = (error: any) =>
  expect(error.getResponse()).toMatchObject({
    code: 'RESEARCH_PORTFOLIO_CLIENT_FILING_OUTCOME_UNKNOWN',
    operationId: expect.any(String),
    status: 'outcome_unknown',
  });
describe('durable client filing reauthorization and uncertain recovery', () => {
  for (const permission of ['membership', 'grant', 'link', 'wall'] as const) {
    it(
      'retains the canonical checkpoint after pending ' +
        permission +
        ' revocation and reconciles without another writer',
      async () => {
        const h = fixture(),
          work = h.save().catch((error) => error);
        await h.entered;
        expect(h.jobs).toHaveLength(1);
        expect(h.jobs[0].status).toBe('pending');
        h.state[permission] = false;
        h.release();
        outcomeUnknown(await work);
        expect(h.receipts).toHaveLength(0);
        expect(h.jobs[0]).toMatchObject({
          status: 'outcome_unknown',
          externalCheckpoint: { attachmentId: 'attachment-observed' },
        });
        expect(h.prisma.withTenant).not.toHaveBeenCalled();
        h.state[permission] = true;
        const receipt = await h.save();
        expect(receipt.attachmentId).toBe('attachment-observed');
        expect(receipt.operationKey).toBe(h.input.operationKey);
        expect(h.writer.createAttachmentFromBuffer).toHaveBeenCalledTimes(1);
        expect(h.receipts).toHaveLength(1);
        expect(h.jobs[0].status).toBe('completed');
        expect(await h.save()).toEqual(receipt);
        expect(h.receipts).toHaveLength(1);
        h.state[permission] = false;
        await expect(h.save()).rejects.toThrow();
        expect(h.writer.createAttachmentFromBuffer).toHaveBeenCalledTimes(1);
      },
    );
  }
  it('never starts another write while an existing writer is pending', async () => {
    const h = fixture(),
      work = h.save();
    await h.entered;
    outcomeUnknown(await h.save().catch((error) => error));
    expect(h.writer.createAttachmentFromBuffer).toHaveBeenCalledTimes(1);
    h.release();
    expect((await work).attachmentId).toBe('attachment-observed');
  });
  it('a thrown writer is honestly unknown without a fabricated checkpoint or a second write', async () => {
    const h = fixture();
    h.writer.createAttachmentFromBuffer.mockRejectedValueOnce(
      Error('connection lost after external commit'),
    );
    outcomeUnknown(await h.save().catch((error) => error));
    outcomeUnknown(await h.save().catch((error) => error));
    expect(h.jobs[0]).toMatchObject({
      status: 'outcome_unknown',
      externalCheckpoint: {},
    });
    expect(h.receipts).toHaveLength(0);
    expect(h.writer.createAttachmentFromBuffer).toHaveBeenCalledTimes(1);
  });
  it('a lost checkpoint persists the pending attempt and exact retry cannot call the writer again', async () => {
    const h = fixture(),
      work = h.save().catch((error) => error);
    await h.entered;
    h.state.checkpointFails = true;
    h.release();
    outcomeUnknown(await work);
    h.state.checkpointFails = false;
    outcomeUnknown(await h.save().catch((error) => error));
    expect(h.jobs[0].status).toBe('pending');
    expect(h.receipts).toHaveLength(0);
    expect(h.writer.createAttachmentFromBuffer).toHaveBeenCalledTimes(1);
  });
  it('binds retained actor operation identity to its exact content', async () => {
    const h = fixture(),
      work = h.save();
    await h.entered;
    h.release();
    await work;
    h.input.clientId = 'different-client';
    await expect(h.save()).rejects.toThrow();
    h.input.clientId = 'client-owned';
    h.tx.researchPortfolioOutputArtifact.findFirst.mockResolvedValueOnce({
      id: 'artifact-owned',
      fileName: 'owned.csv',
      mediaType: 'text/csv',
      bytes: Buffer.from('changed'),
      byteSize: 7,
      contentHash: createHash('sha256').update('changed').digest('hex'),
      job: { status: 'completed' },
    });
    await expect(h.save()).rejects.toThrow('different content');
    expect(h.writer.createAttachmentFromBuffer).toHaveBeenCalledTimes(1);
  });
  it('fails closed on a legacy receipt without actor provenance', async () => {
    const h = fixture();
    h.receipts.push({ id: 'legacy', operationKey: h.input.operationKey });
    await expect(h.save()).rejects.toThrow('legacy filing receipt');
    expect(h.jobs).toHaveLength(0);
    expect(h.writer.createAttachmentFromBuffer).not.toHaveBeenCalled();
  });
  it.each([
    { byteSize: 6 },
    { contentHash: 'b'.repeat(64) },
    { fileName: '../unsafe.csv' },
    { mediaType: 'application/json' },
  ])('rejects altered immutable artifacts before acquiring a writer: %j', async (change) => {
    const h = fixture();
    h.tx.researchPortfolioOutputArtifact.findFirst.mockResolvedValueOnce({
      id: 'artifact-owned',
      fileName: 'owned.csv',
      mediaType: 'text/csv',
      bytes: Buffer.from('owned'),
      byteSize: 5,
      contentHash: createHash('sha256').update('owned').digest('hex'),
      job: { status: 'completed' },
      ...change,
    });
    await expect(h.save()).rejects.toThrow('immutable artifact');
    expect(h.jobs).toHaveLength(0);
    expect(h.writer.createAttachmentFromBuffer).not.toHaveBeenCalled();
  });
});

describe('Checkpoint-only generic filing reconciliation guards', () => {
  it('cannot start a document writer when the original checkpoint has disappeared', async () => {
    const h = fixture();
    await expect(
      h.service.saveToClient(ctx, 'portfolio-owned', 'artifact-owned', h.input, 'viewer', true),
    ).rejects.toMatchObject({ status: 404 });
    expect(h.writer.createAttachmentFromBuffer).not.toHaveBeenCalled();
    expect(h.tx.researchPortfolioClientFilingJob.create).not.toHaveBeenCalled();
    expect(h.jobs).toHaveLength(0);
    expect(h.receipts).toHaveLength(0);
  });
  it('reauthorizes the generic editor requirement inside the domain transaction', async () => {
    const h = fixture();
    await expect(
      h.service.saveToClient(ctx, 'portfolio-owned', 'artifact-owned', h.input, 'editor', true),
    ).rejects.toMatchObject({ status: 403 });
    expect(h.tx.researchPortfolioOutputArtifact.findFirst).not.toHaveBeenCalled();
    expect(h.writer.createAttachmentFromBuffer).not.toHaveBeenCalled();
  });
});
