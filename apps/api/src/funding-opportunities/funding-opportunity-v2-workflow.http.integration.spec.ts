import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { Test, type TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { configureApiHttpApp } from '../bootstrap/configure-api-http-app.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from '../auth/roles.guard.js';
import { FundingOpportunitiesController } from './funding-opportunities.controller.js';
import { FundingOpportunityV2WorkflowController } from './funding-opportunity-v2-workflow.controller.js';
import { OpportunityTimelineService } from './opportunity-timeline.service.js';
import { OpportunityRequirementService } from './requirements/opportunity-requirement.service.js';
import { GovernmentLandscapeService } from './government-landscape.service.js';
import { FundingOpportunityPipelineService } from './funding-opportunity-pipeline.js';
import { MeriOpportunityAssessmentService } from './meri-opportunity-assessment.service.js';
import { OpportunityBudgetContextService } from './opportunity-budget-context.service.js';
import { OpportunityRiskService } from './opportunity-risk.service.js';
import { FundingOpportunityOutcomeService } from './funding-opportunity-outcome.service.js';
import { FundingOpportunityV2WorkflowService } from './funding-opportunity-v2-workflow.service.js';
import { FundingOpportunityClientAccessGuard } from './funding-opportunity-client-access.guard.js';
import {
  FundingOpportunitiesFlagGuard,
  FundingOpportunitiesNoticeHistoryFlagGuard,
  FundingOpportunitiesDocumentsFlagGuard,
  FundingOpportunitiesLandscapeFlagGuard,
  FundingOpportunitiesPipelineFlagGuard,
  FundingOpportunitiesMeriFlagGuard,
  FundingOpportunitiesBudgetFlagGuard,
  FundingOpportunitiesRiskFlagGuard,
} from './funding-opportunities-flag.guard.js';
import { FUNDING_OPPORTUNITY_V2_CATALOG_ADAPTERS, FUNDING_OPPORTUNITY_V2_CLIENT_PROFILE_READER } from './funding-opportunity-v2-search.service.js';
import { createPrismaOpportunityCatalogAdapters, createOpportunityClientProfileReader } from './funding-opportunity-v2-search.service.js';

const TEST_DATABASE_URL = process.env.FUNDING_OPPORTUNITIES_TEST_DATABASE_URL;
const parsed = TEST_DATABASE_URL ? new URL(TEST_DATABASE_URL) : null;
const isolated = Boolean(parsed?.protocol === 'postgresql:' && parsed.hostname === '127.0.0.1' && parsed.port === '5486' && parsed.pathname === '/fo_v2_test' && parsed.searchParams.get('schema') === 'public' && parsed.username === 'fo_test' && parsed.password);
const describeDb = isolated ? describe : describe.skip;
const ns = `workflow-http-${crypto.randomUUID()}`;
const tenantId = crypto.randomUUID();
const userId = crypto.randomUUID();
const clientId = crypto.randomUUID();
const otherClientId = crypto.randomUUID();
const otherTenantId = crypto.randomUUID();
const otherTenantClientId = crypto.randomUUID();
const facilityId = crypto.randomUUID();
const grantId = `${ns}-grant`;
const samId = crypto.randomUUID();
const forecastId = `${ns}-forecast`;
const dibbsId = `${ns}-dibbs`;
const sbirTopicId = `${ns}-topic`;
const sbirSolicitationId = `${ns}-solicitation`;
const caId = `${ns}-ca`;
const rollbackGrantId = `${ns}-rollback-grant`;
const flagId = `${ns}-flag`;
const sbirFlagId = `${ns}-sbir-flag`;
const forecastFlagId = `${ns}-forecast-flag`;

jest.setTimeout(120_000);

describeDb('funding opportunity workflow HTTP: production controllers, ValidationPipe, guards, SQL catalog, and V2 workflow', () => {
  // Authentication/JWT verification and PostgreSQL non-bypass RLS are excluded: the
  // test injects only an authenticated TenantContext at the middleware boundary.
  // All route guards, source/profile reads, workflow persistence, and ValidationPipe
  // remain production implementations. The audit failure test is deliberately
  // injected into the transaction proxy to prove rollback after writes begin.
  let app: INestApplication;
  let prisma: PrismaService;
  let context = { tenantId, tenantSlug: ns, userId, clerkUserId: ns, role: 'standard_user' };

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    const module: TestingModule = await Test.createTestingModule({
      controllers: [FundingOpportunitiesController, FundingOpportunityV2WorkflowController],
      providers: [
        PrismaService, Reflector,
                { provide: OpportunityTimelineService, useValue: {} },
        { provide: OpportunityRequirementService, useValue: {} },
        { provide: GovernmentLandscapeService, useValue: {} },
        { provide: FundingOpportunityPipelineService, useValue: {} },
        { provide: MeriOpportunityAssessmentService, useValue: {} },
        { provide: OpportunityBudgetContextService, useValue: {} },
        { provide: OpportunityRiskService, useValue: {} },
        { provide: FundingOpportunityOutcomeService, useValue: {} },
        FundingOpportunityV2WorkflowService,
        { provide: FUNDING_OPPORTUNITY_V2_CATALOG_ADAPTERS, inject: [PrismaService], useFactory: (db: PrismaService) => createPrismaOpportunityCatalogAdapters(db) },
        { provide: FUNDING_OPPORTUNITY_V2_CLIENT_PROFILE_READER, inject: [PrismaService], useFactory: (db: PrismaService) => createOpportunityClientProfileReader(db) },
        RolesGuard, FundingOpportunityClientAccessGuard, FundingOpportunitiesFlagGuard,
        FundingOpportunitiesNoticeHistoryFlagGuard,
        FundingOpportunitiesDocumentsFlagGuard, FundingOpportunitiesLandscapeFlagGuard, FundingOpportunitiesPipelineFlagGuard,
        FundingOpportunitiesMeriFlagGuard, FundingOpportunitiesBudgetFlagGuard, FundingOpportunitiesRiskFlagGuard,
      ],
    }).compile();
    app = module.createNestApplication();
    configureApiHttpApp(app, { includeClerkRawBody: false, includeRecallRawBody: false, includeTangoRawBody: false, includeEmailSignatureLargeBody: false, defaultJsonLimit: '1mb' });
    app.use((req: Request & { tenantContext?: typeof context }, _res: Response, next: NextFunction) => {
      if (req.headers.authorization !== 'Bearer workflow-http-auth') return next(new Error('controlled authentication boundary rejection'));
      req.tenantContext = context;
      next();
    });
    await app.init();
    prisma = app.get(PrismaService);
    await prisma.tenant.create({ data: { id: tenantId, slug: ns, name: ns } });
    await prisma.tenant.create({ data: { id: otherTenantId, slug: `${ns}-other`, name: `${ns}-other` } });
    await prisma.user.create({ data: { id: userId, clerkUserId: ns, email: `${ns}@example.invalid`, firstName: 'Workflow', lastName: 'Owner' } });
    await prisma.tenantMembership.create({ data: { tenantId, userId, role: 'standard_user', status: 'active' } });
    await prisma.client.createMany({ data: [
      { id: clientId, tenantId, name: `${ns} client`, memoryWall: true },
      { id: otherClientId, tenantId, name: `${ns} other client`, memoryWall: true },
      { id: otherTenantClientId, tenantId: otherTenantId, name: `${ns} other tenant client`, memoryWall: true },
    ] });
    await prisma.clientMemoryAccess.create({ data: { tenantId, clientId, userId, grantedBy: userId } });
    await prisma.clientFacility.create({ data: { id: facilityId, tenantId, clientId, name: 'Virginia site', state: 'va', congressionalDistrict: '7' } });
    await prisma.$executeRaw`INSERT INTO intel_feature_flag(id, feature, tenant_id, enabled) VALUES (${flagId}, 'funding_opportunities', ${tenantId}, true), (${forecastFlagId}, 'funding_opportunities_forecasts', ${tenantId}, true), (${sbirFlagId}, 'funding_opportunities_sbir', ${tenantId}, true)`;
    await prisma.federalGrant.create({ data: { id: grantId, title: `${ns} grant`, agency: 'Workflow agency', fundingInstrument: 'Grant', eligibility: ['Small businesses'], status: 'posted', closeDate: new Date('2099-12-31T00:00:00Z') } });
    await prisma.federalGrant.create({ data: { id: rollbackGrantId, title: `${ns} rollback grant`, agency: 'Workflow agency', fundingInstrument: 'Grant', eligibility: ['Small businesses'], status: 'posted', closeDate: new Date('2099-12-31T00:00:00Z') } });
    await prisma.samOpportunity.create({ data: { id: samId, noticeId: `${ns}-sam`, title: `${ns} SAM`, noticeType: 'Solicitation', active: true, responseDeadline: new Date('2099-12-31T00:00:00Z') } });
    await prisma.tangoProcurementForecast.create({ data: { tangoForecastId: forecastId, title: `${ns} forecast`, isActive: true, snapshot: {} } });
    await prisma.tangoDibbsSolicitation.create({ data: { tangoDibbsId: dibbsId, documentType: 'rfq', solicitation: `${ns}-sol`, isOpen: true } });
    await prisma.tangoSbirTopic.create({ data: { tangoSbirId: sbirTopicId, topicNumber: `${ns}-topic-number`, title: `${ns} topic`, closeDate: new Date('2099-12-31T00:00:00Z') } });
    await prisma.tangoSbirSolicitation.create({ data: { tangoSbirId: sbirSolicitationId, solicitationNumber: `${ns}-sol-number`, title: `${ns} solicitation`, endDate: new Date('2099-12-31T00:00:00Z') } });
    await prisma.californiaGrantOpportunity.create({ data: { portalId: caId, title: `${ns} California`, status: 'Active', applicantTypes: ['Business'], applicationDeadlineCalendarDate: new Date('2099-12-31T00:00:00Z') } });
  });

  afterAll(async () => {
    try {
      if (!prisma) return;
      await prisma.withSystem(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.allow_audit_purge','on',true)`;
        await tx.auditLog.deleteMany({ where: { tenantId } });
        await tx.opportunityBookmark.deleteMany({ where: { tenantId } });
        await tx.clientFundingOpportunity.deleteMany({ where: { tenantId } });
        await tx.engagementTask.deleteMany({ where: { tenantId } });
        await tx.clientFacility.deleteMany({ where: { id: facilityId } });
        await tx.clientMemoryAccess.deleteMany({ where: { tenantId } });
        await tx.client.deleteMany({ where: { id: { in: [clientId, otherClientId, otherTenantClientId] } } });
        await tx.tenantMembership.deleteMany({ where: { tenantId } });
        await tx.$executeRaw`DELETE FROM intel_feature_flag WHERE tenant_id = ${tenantId}`;
        await tx.tenant.deleteMany({ where: { id: { in: [tenantId, otherTenantId] } } });
        await tx.user.deleteMany({ where: { id: userId } });
      });
      await prisma.federalGrant.deleteMany({ where: { id: { in: [grantId, rollbackGrantId] } } });
      await prisma.samOpportunity.deleteMany({ where: { id: samId } });
      await prisma.tangoProcurementForecast.deleteMany({ where: { tangoForecastId: forecastId } });
      await prisma.tangoDibbsSolicitation.deleteMany({ where: { tangoDibbsId: dibbsId } });
      await prisma.tangoSbirTopic.deleteMany({ where: { tangoSbirId: sbirTopicId } });
      await prisma.tangoSbirSolicitation.deleteMany({ where: { tangoSbirId: { in: [sbirSolicitationId, sbirTopicId] } } });
      await prisma.californiaGrantOpportunity.deleteMany({ where: { portalId: caId } });
    } finally { await app?.close(); await prisma?.$disconnect(); }
  });

  const auth = () => ({ Authorization: 'Bearer workflow-http-auth' });
  const path = (source: string, id: string) => `/api/intelligence/clients/${clientId}/opportunities/${source}/${encodeURIComponent(id)}`;

  test.each([
    ['grants_gov', grantId], ['sam_gov', samId], ['agency_forecast', forecastId], ['dibbs', dibbsId], ['sbir_sttr', sbirTopicId], ['ca_portal', caId],
  ])('Save and PATCH accept six-source identity through ValidationPipe (%s)', async (source, id) => {
    const save = await request(app.getHttpServer()).post(`${path(source, id)}/save`).set(auth()).send({ status: 'saved', ownerUserId: userId, facilityId, notes: 'HTTP workflow', nextAction: 'Check source', nextActionDueAt: '2099-10-01T00:00:00.000Z' });
    expect(save.status).toBe(201);
    const patch = await request(app.getHttpServer()).patch(path(source, id)).set(auth()).send({ notes: 'HTTP patched', nextAction: 'Confirm', nextActionDueAt: null });
    expect(patch.status).toBe(200);
    expect(patch.body.owner).toMatchObject({ userId, name: 'Workflow Owner', email: `${ns}@example.invalid` });
    expect(patch.body.facility).toMatchObject({ id: facilityId, state: 'va', districtKey: 'VA-07' });
  });

  test('parallel pursue actions create one task and one workflow through both production controllers', async () => {
    const responses = await Promise.all(Array.from({ length: 6 }, () =>
      request(app.getHttpServer()).post(`${path('grants_gov', grantId)}/action`).set(auth()).send({ intent: 'pursuit', ownerUserId: userId, nextAction: 'Prepare final proposal', nextActionDueAt: '2099-11-03T00:00:00.000Z' }),
    ));
    expect(responses.every((response) => response.status === 201)).toBe(true);
    const firstResponse = responses[0];
    expect(firstResponse).toBeDefined();
    expect(new Set(responses.map((response) => response.body.task.id)).size).toBe(1);
    expect(firstResponse!.body.decision).toBe('pursue');
    expect(firstResponse!.body.task.title).toBe('Prepare final proposal');
    const [tasks, workflows] = await Promise.all([
      prisma.engagementTask.findMany({ where: { tenantId, clientId, sourceType: 'funding_opportunity' } }),
      prisma.clientFundingOpportunity.findMany({ where: { tenantId, clientId, source: 'grants_gov', sourceRecordKey: grantId } }),
    ]);
    expect(tasks).toHaveLength(1);
    expect(workflows).toHaveLength(1);
    const retry = await request(app.getHttpServer()).post(`${path('grants_gov', grantId)}/action`).set(auth()).send({ intent: 'pursuit' });
    expect(retry.status).toBe(201);
    expect(retry.body.task.id).toBe(firstResponse!.body.task.id);
    expect(retry.body.task.title).toBe('Prepare final proposal');
    const audits = await prisma.auditLog.findMany({ where: { tenantId, entityType: 'client_funding_opportunity' } });
    expect(audits.some((row) => row.action === 'funding_opportunity.decision.pursue')).toBe(true);
    expect(audits.some((row) => row.action === 'funding_opportunity.not_fit')).toBe(false);
  });

  test('workspace save is independent and client unsave preserves workflow', async () => {
    const workspace = await request(app.getHttpServer()).post(`/api/intelligence/opportunities/ca_portal/${caId}/save`).set(auth()).send({ status: 'saved' });
    expect(workspace.status).toBe(201);
    const clientUnsave = await request(app.getHttpServer()).delete(`${path('ca_portal', caId)}/save`).set(auth());
    expect(clientUnsave.status).toBe(200);
    expect(clientUnsave.body.workflow).not.toBeUndefined();
  });

  test('ValidationPipe rejects caller identity fields and unsupported sources/reasons', async () => {
    await request(app.getHttpServer()).post(`${path('grants_gov', grantId)}/save`).set(auth()).send({ status: 'saved', clientId: crypto.randomUUID(), tenantId }).expect(400);
    await request(app.getHttpServer()).post(`${path('grants_gov', grantId)}/action`).set(auth()).send({ intent: 'pursue' }).expect(400);
    await request(app.getHttpServer()).post(`/api/intelligence/clients/${clientId}/opportunities/not-a-source/${grantId}/not-fit`).set(auth()).send({ reason: 'capability' }).expect(400);
  });

  test('client grant revocation is rechecked by the real guard/profile reader', async () => {
    await prisma.clientMemoryAccess.deleteMany({ where: { tenantId, clientId, userId } });
    await request(app.getHttpServer()).post(`${path('grants_gov', grantId)}/save`).set(auth()).send({ status: 'saved' }).expect(404);
    await prisma.clientMemoryAccess.create({ data: { tenantId, clientId, userId, grantedBy: userId } });
  });

  test('action route exercises review/pursuit for every pursuable source family and forecast gating', async () => {
    const reviews = [
      ['sam_gov', samId], ['dibbs', dibbsId], ['sbir_sttr', sbirTopicId],
      ['sbir_sttr', sbirSolicitationId], ['ca_portal', caId],
    ] as const;
    for (const [source, id] of reviews) {
      const response = await request(app.getHttpServer()).post(`${path(source, id)}/action`).set(auth()).send({ intent: 'review', nextAction: 'Review source facts' });
      expect(response.status).toBe(201);
      expect(response.body.decision).toBe('monitor');
    }
    const forecastReview = await request(app.getHttpServer()).post(`${path('agency_forecast', forecastId)}/action`).set(auth()).send({ intent: 'review' });
    expect(forecastReview.status).toBe(201);
    await request(app.getHttpServer()).post(`${path('agency_forecast', forecastId)}/action`).set(auth()).send({ intent: 'pursuit' }).expect(400);
    for (const [source, id] of reviews) {
      const response = await request(app.getHttpServer()).post(`${path(source, id)}/action`).set(auth()).send({ intent: 'pursuit' });
      expect(response.status).toBe(201);
      expect(response.body.decision).toBe('pursue');
    }
  });

  test('not-fit accepts exactly four reasons, preserves a blank note, and audits source identity', async () => {
    for (const reason of ['capability', 'eligibility', 'economics', 'capacity'] as const) {
      const response = await request(app.getHttpServer()).post(`${path('ca_portal', caId)}/not-fit`).set(auth()).send({ reason, note: reason === 'capacity' ? '  ' : `${reason} note` });
      expect(response.status).toBe(201);
    }
    await request(app.getHttpServer()).post(`${path('ca_portal', caId)}/not-fit`).set(auth()).send({ reason: 'price' }).expect(400);
    const workflow = await prisma.clientFundingOpportunity.findFirst({ where: { tenantId, clientId, source: 'ca_portal', sourceRecordKey: caId } });
    expect(workflow?.notes).toBe('economics note');
    expect(workflow?.humanDecision).toBe('pass');
    const audits = await prisma.auditLog.findMany({ where: { tenantId, action: 'funding_opportunity.not_fit', entityId: workflow?.id }, orderBy: { occurredAt: 'asc' } });
    expect(audits.at(-1)?.after).toEqual(expect.objectContaining({ source: 'ca_portal', sourceRecordId: caId, decision: 'pass' }));
  });

  test('current closed source and definitive ineligible gates reject pursuit while unknown remains trackable', async () => {
    await prisma.federalGrant.update({ where: { id: grantId }, data: { status: 'closed', closeDate: new Date('2020-01-01T00:00:00Z') } });
    await request(app.getHttpServer()).post(`${path('grants_gov', grantId)}/action`).set(auth()).send({ intent: 'pursuit' }).expect(400);
    await prisma.federalGrant.update({ where: { id: grantId }, data: { status: 'posted', closeDate: new Date('2099-12-31T00:00:00Z'), eligibility: ['State governments'] } });
    await prisma.client.update({ where: { id: clientId }, data: { applicantTypes: ['Small businesses'] } });
    await request(app.getHttpServer()).post(`${path('grants_gov', grantId)}/action`).set(auth()).send({ intent: 'pursuit' }).expect(400);
    await prisma.federalGrant.update({ where: { id: grantId }, data: { eligibility: [] } });
    const unknown = await request(app.getHttpServer()).post(`${path('grants_gov', grantId)}/action`).set(auth()).send({ intent: 'pursuit' });
    expect(unknown.status).toBe(201);
    expect(unknown.body.decision).toBe('pursue');
  });

  test('role, master/source flag, and terminal gates are enforced by real guards and service', async () => {
    context = { ...context, role: 'client_portal_user' };
    await request(app.getHttpServer()).post(`${path('grants_gov', grantId)}/save`).set(auth()).send({ status: 'saved' }).expect(403);
    context = { ...context, role: 'standard_user' };
    await prisma.$executeRaw`UPDATE intel_feature_flag SET enabled = false WHERE id = ${flagId}`;
    await request(app.getHttpServer()).post(`${path('grants_gov', grantId)}/save`).set(auth()).send({ status: 'saved' }).expect(404);
    await prisma.$executeRaw`UPDATE intel_feature_flag SET enabled = true WHERE id = ${flagId}`;
    await prisma.$executeRaw`UPDATE intel_feature_flag SET enabled = false WHERE id = ${forecastFlagId}`;
    await request(app.getHttpServer()).post(`${path('agency_forecast', forecastId)}/action`).set(auth()).send({ intent: 'review' }).expect(404);
    await prisma.$executeRaw`UPDATE intel_feature_flag SET enabled = true WHERE id = ${forecastFlagId}`;
    await request(app.getHttpServer()).post(`${path('ca_portal', caId)}/action`).set(auth()).send({ intent: 'pursuit' }).expect(409);
  });

  test('invalid owner/facility is rejected before any workflow/task/audit partial write', async () => {
    const before = await Promise.all([
      prisma.clientFundingOpportunity.count({ where: { tenantId, clientId, source: 'dibbs' } }),
      prisma.engagementTask.count({ where: { tenantId, clientId } }),
      prisma.auditLog.count({ where: { tenantId } }),
    ]);
    await request(app.getHttpServer()).post(`${path('dibbs', dibbsId)}/save`).set(auth()).send({ status: 'saved', ownerUserId: crypto.randomUUID(), facilityId: crypto.randomUUID() }).expect(404);
    const after = await Promise.all([
      prisma.clientFundingOpportunity.count({ where: { tenantId, clientId, source: 'dibbs' } }),
      prisma.engagementTask.count({ where: { tenantId, clientId } }),
      prisma.auditLog.count({ where: { tenantId } }),
    ]);
    expect(after).toEqual(before);
  });

  test('other-client and other-tenant client scopes stay hidden', async () => {
    await request(app.getHttpServer()).post(`/api/intelligence/clients/${otherClientId}/opportunities/grants_gov/${grantId}/save`).set(auth()).send({ status: 'saved' }).expect(404);
    await request(app.getHttpServer()).post(`/api/intelligence/clients/${otherTenantClientId}/opportunities/grants_gov/${grantId}/save`).set(auth()).send({ status: 'saved' }).expect(404);
  });

  test('injected audit failure rolls back the action task, workflow, and audit atomically', async () => {
    const before = await Promise.all([
      prisma.clientFundingOpportunity.findFirst({ where: { tenantId, clientId, source: 'grants_gov', sourceRecordKey: rollbackGrantId } }),
      prisma.engagementTask.findMany({ where: { tenantId, clientId, sourceType: 'funding_opportunity', sourceId: { contains: rollbackGrantId } } }),
      prisma.auditLog.count({ where: { tenantId } }),
    ]);
    const realWithTenant = prisma.withTenant.bind(prisma);
    let auditFailureHit = false;
    (prisma as any).withTenant = (tid: string, fn: any, options?: any) => realWithTenant(tid, (tx: any) => fn(new Proxy(tx, { get(target, key) {
      if (key === 'auditLog') return { ...target.auditLog, create: async () => { auditFailureHit = true; throw new Error('controlled audit failure'); } };
      return Reflect.get(target, key);
    } })), options);
    try {
      await request(app.getHttpServer()).post(`${path('grants_gov', rollbackGrantId)}/action`).set(auth()).send({ intent: 'pursuit', nextAction: 'This must roll back' }).expect(500);
    } finally {
      (prisma as any).withTenant = realWithTenant;
    }
    expect(auditFailureHit).toBe(true);
    const after = await Promise.all([
      prisma.clientFundingOpportunity.findFirst({ where: { tenantId, clientId, source: 'grants_gov', sourceRecordKey: rollbackGrantId } }),
      prisma.engagementTask.findMany({ where: { tenantId, clientId, sourceType: 'funding_opportunity', sourceId: { contains: rollbackGrantId } } }),
      prisma.auditLog.count({ where: { tenantId } }),
    ]);
    expect(after[0]).toEqual(before[0]);
    expect(after[1]).toEqual(before[1]);
    expect(after[2]).toBe(before[2]);
  });

  test('same-key SBIR topic/solicitation ambiguity fails safely', async () => {
    await prisma.tangoSbirSolicitation.create({ data: { tangoSbirId: sbirTopicId, solicitationNumber: `${ns}-ambiguous`, title: 'ambiguous', endDate: new Date('2099-12-31T00:00:00Z') } });
    const response = await request(app.getHttpServer()).post(`${path('sbir_sttr', sbirTopicId)}/action`).set(auth()).send({ intent: 'review' });
    expect(response.status).toBe(400);
  });
});

export {};
