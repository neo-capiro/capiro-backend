import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import { FundingOpportunityPipelineService } from './funding-opportunity-pipeline.js';

const TEST_DATABASE_URL = process.env.FUNDING_OPPORTUNITIES_TEST_DATABASE_URL;
const parsed = TEST_DATABASE_URL ? new URL(TEST_DATABASE_URL) : null;
const isolated = Boolean(
  parsed?.protocol === 'postgresql:' && parsed.hostname === '127.0.0.1'
    && parsed.port === '5486' && parsed.pathname === '/fo_v2_test'
    && parsed.searchParams.get('schema') === 'public' && parsed.username === 'fo_test'
    && parsed.password.length > 0,
);
const describeDb = isolated ? describe : describe.skip;

jest.setTimeout(90_000);

describeDb('Pipeline current-source access (isolated PostgreSQL)', () => {
  const ns = `pipeline-source-access-${randomUUID()}`;
  const tenantId = randomUUID();
  const userId = randomUUID();
  const clientId = randomUUID();
  const rowId = randomUUID();
  const sourceId = `${ns}-topic`;
  const masterFlagId = `${ns}-master`;
  const sbirFlagId = `${ns}-sbir`;
  const asOf = new Date('2099-10-01T12:00:00Z');
  const prisma = new PrismaService({ datasources: { db: { url: TEST_DATABASE_URL } } });

  beforeAll(async () => {
    await prisma.tenant.create({ data: { id: tenantId, slug: ns, name: ns } });
    await prisma.user.create({ data: { id: userId, clerkUserId: ns, email: `${ns}@example.invalid` } });
    await prisma.tenantMembership.create({ data: { tenantId, userId, role: 'standard_user', status: 'active' } });
    await prisma.client.create({ data: { id: clientId, tenantId, name: ns, memoryWall: false, profileStatus: 'ACTIVE' } });
    await prisma.$executeRaw`INSERT INTO intel_feature_flag (id, feature, tenant_id, enabled)
      VALUES (${masterFlagId}, 'funding_opportunities', ${tenantId}, true),
             (${sbirFlagId}, 'funding_opportunities_sbir', ${tenantId}, true)`;
    await prisma.tangoSbirTopic.create({ data: {
      tangoSbirId: sourceId, title: `${ns} live source title`, topicNumber: `${ns}-public`,
      solicitationStatus: 'open', closeDate: new Date('2099-10-15T00:00:00Z'),
    } });
    await prisma.clientFundingOpportunity.create({ data: {
      id: rowId, tenantId, clientId, source: 'sbir_sttr', sourceRecordType: 'sbir_topic',
      sourceRecordKey: sourceId, workflowStatus: 'pursuing', pipelineStage: 'qualified',
      pipelineStageAt: asOf, pipelineStageByUserId: userId, evidenceSourceType: 'user_action',
      userCreated: true, sourceActiveSnapshot: true, eligibilityState: 'eligible',
    } });
  });

  afterAll(async () => {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.allow_audit_purge','on',true)`;
      await tx.auditLog.deleteMany({ where: { tenantId } });
      await tx.fundingOpportunityStageTransition.deleteMany({ where: { tenantId } });
      await tx.clientFundingOpportunity.deleteMany({ where: { id: rowId, tenantId, clientId } });
    });
    await prisma.tangoSbirTopic.deleteMany({ where: { tangoSbirId: sourceId } });
    await prisma.$executeRaw`DELETE FROM intel_feature_flag WHERE tenant_id = ${tenantId} AND id IN (${masterFlagId}, ${sbirFlagId})`;
    await prisma.client.deleteMany({ where: { id: clientId, tenantId } });
    await prisma.tenantMembership.deleteMany({ where: { tenantId, userId } });
    await prisma.tenant.deleteMany({ where: { id: tenantId, slug: ns } });
    await prisma.user.deleteMany({ where: { id: userId, clerkUserId: ns } });
    await prisma.$disconnect();
  });

  it('removes disabled current facts before board summaries and transition authorization', async () => {
    const service = new FundingOpportunityPipelineService(prisma);
    const enabled = await service.board(tenantId, userId, clientId, 200, asOf);
    expect(enabled.cards[0]).toMatchObject({ title: `${ns} live source title`, lifecycle: 'active', capability: { canPursue: true } });
    expect(enabled.summary).toMatchObject({ inPipeline: 1, deadlinesInside30Days: 1 });

    await prisma.$executeRaw`UPDATE intel_feature_flag SET enabled = false WHERE id = ${sbirFlagId} AND tenant_id = ${tenantId}`;
    const disabled = await service.board(tenantId, userId, clientId, 200, asOf);
    expect(disabled.cards[0]).toMatchObject({
      rowId, title: null, sourceReference: null, responseDeadline: null, lifecycle: null,
      currentEvidence: null, capability: { canPursue: false },
    });
    expect(disabled.cards[0]?.allowedTransitions).not.toContain('pursuing');
    expect(disabled.summary).toMatchObject({ inPipeline: 1, deadlinesInside30Days: 0 });

    await expect(service.transition(tenantId, userId, clientId, rowId, {
      toStage: 'pursuing', expectedVersion: 0,
    }, asOf)).rejects.toThrow(/unavailable|cannot be pursued|closed/i);
    const stored = await prisma.clientFundingOpportunity.findUnique({
      where: { id: rowId }, select: { pipelineStage: true, pipelineStageVersion: true },
    });
    expect(stored).toEqual({ pipelineStage: 'qualified', pipelineStageVersion: 0 });
  });
});
