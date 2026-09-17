import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { Test, type TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { Reflector } from '@nestjs/core';
import { configureApiHttpApp } from '../bootstrap/configure-api-http-app.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { FundingOpportunitiesController } from './funding-opportunities.controller.js';
import { FundingOpportunityPipelineService } from './funding-opportunity-pipeline.js';
import { FundingOpportunityClientAccessGuard } from './funding-opportunity-client-access.guard.js';
import {
  FundingOpportunitiesFlagGuard,
  FundingOpportunitiesPipelineFlagGuard,
} from './funding-opportunities-flag.guard.js';
import { OpportunityTimelineService } from './opportunity-timeline.service.js';
import { OpportunityRequirementService } from './requirements/opportunity-requirement.service.js';
import { GovernmentLandscapeService } from './government-landscape.service.js';
import { MeriOpportunityAssessmentService } from './meri-opportunity-assessment.service.js';
import { OpportunityBudgetContextService } from './opportunity-budget-context.service.js';
import { OpportunityRiskService } from './opportunity-risk.service.js';
import { FundingOpportunityOutcomeService } from './funding-opportunity-outcome.service.js';
import {
  createOpportunityClientProfileReader,
  createPrismaOpportunityCatalogAdapters,
  FUNDING_OPPORTUNITY_V2_CATALOG_ADAPTERS,
  FUNDING_OPPORTUNITY_V2_CLIENT_PROFILE_READER,
  FundingOpportunityV2SearchService,
} from './funding-opportunity-v2-search.service.js';
import { FundingOpportunityV2WorkflowService } from './funding-opportunity-v2-workflow.service.js';
import { FundingOpportunityV2SearchController } from './funding-opportunity-v2-search.controller.js';
import { FundingOpportunityV2DetailController } from './funding-opportunity-v2-detail.controller.js';
import { FundingOpportunityV2DetailService } from './funding-opportunity-v2-detail.service.js';
import { FundingOpportunityV2DecoratorService } from './funding-opportunity-v2-decorator.service.js';

const DATABASE_URL = process.env.FUNDING_OPPORTUNITIES_TEST_DATABASE_URL;
const parsed = DATABASE_URL ? new URL(DATABASE_URL) : null;
const isolated = Boolean(
  DATABASE_URL && process.env.DATABASE_URL === DATABASE_URL
    && parsed?.protocol === 'postgresql:' && parsed.hostname === '127.0.0.1' && parsed.port === '5486'
    && parsed.pathname === '/fo_v2_test' && parsed.searchParams.get('schema') === 'public'
    && parsed.username === 'fo_test' && parsed.password,
);
const describeDb = isolated ? describe : describe.skip;

jest.setTimeout(120_000);

describeDb('Pipeline HTTP: production controller, guards, current sources, transitions', () => {
  const ns = `pipeline-http-${crypto.randomUUID()}`;
  const tenantId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const clientId = crypto.randomUUID();
  const rowId = crypto.randomUUID();
  const conflictRowId = crypto.randomUUID();
  const rollbackRowId = crypto.randomUUID();
  const closedRowId = crypto.randomUUID();
  const topicId = `${ns}-topic`;
  const conflictTopicId = ns + '-conflict-topic';
  const rollbackTopicId = ns + '-rollback-topic';
  const closedTopicId = ns + '-closed-topic';
  const sharedSbirId = `${ns}-shared-sbir-id`;
  const grantId = `${ns}-grant`;
  const samId = crypto.randomUUID();
  const forecastId = `${ns}-forecast`;
  const dibbsId = `${ns}-dibbs`;
  const caId = `${ns}-ca`;
  const allSourceRowIds = {
    grant: crypto.randomUUID(), sam: crypto.randomUUID(), forecast: crypto.randomUUID(),
    dibbs: crypto.randomUUID(), ca: crypto.randomUUID(), topic: crypto.randomUUID(), solicitation: crypto.randomUUID(),
  };
  const masterFlagId = `${ns}-master`;
  const forecastFlagId = `${ns}-forecast-flag`;
  const pipelineFlagId = `${ns}-pipeline`;
  const sbirFlagId = `${ns}-sbir`;
  const asOf = new Date('2026-09-17T12:00:00.000Z');

  let app: INestApplication;
  let prisma: PrismaService;
  let context: TenantContext = {
    tenantId, tenantSlug: ns, userId, clerkUserId: `${ns}-clerk`, role: 'standard_user',
  };

  const row = (id: string, stage: 'pursuing' | 'reviewing' = 'pursuing') => {
    const identity = id === allSourceRowIds.grant
      ? { source: 'grants_gov', sourceRecordType: 'grants_gov_opportunity', sourceRecordKey: grantId, grantOpportunityId: grantId, samOpportunityId: null }
      : id === allSourceRowIds.sam ? { source: 'sam_gov', sourceRecordType: 'sam_notice', sourceRecordKey: samId, grantOpportunityId: null, samOpportunityId: samId }
      : id === allSourceRowIds.forecast ? { source: 'agency_forecast', sourceRecordType: 'tango_procurement_forecast', sourceRecordKey: forecastId, grantOpportunityId: null, samOpportunityId: null }
      : id === allSourceRowIds.dibbs ? { source: 'dibbs', sourceRecordType: 'dibbs_solicitation', sourceRecordKey: dibbsId, grantOpportunityId: null, samOpportunityId: null }
      : id === allSourceRowIds.ca ? { source: 'ca_portal', sourceRecordType: 'ca_grant_opportunity', sourceRecordKey: caId, grantOpportunityId: null, samOpportunityId: null }
      : id === allSourceRowIds.solicitation ? { source: 'sbir_sttr', sourceRecordType: 'sbir_solicitation', sourceRecordKey: sharedSbirId, grantOpportunityId: null, samOpportunityId: null }
      : id === allSourceRowIds.topic ? { source: 'sbir_sttr', sourceRecordType: 'sbir_topic', sourceRecordKey: sharedSbirId, grantOpportunityId: null, samOpportunityId: null }
      : { source: 'sbir_sttr', sourceRecordType: 'sbir_topic', sourceRecordKey: id === rowId ? topicId : id === conflictRowId ? conflictTopicId : id === rollbackRowId ? rollbackTopicId : closedTopicId, grantOpportunityId: null, samOpportunityId: null };
    return {
      id, tenantId, clientId, ...identity,
      workflowStatus: stage === 'pursuing' ? 'pursuing' : 'saved',
      pipelineStage: stage, pipelineStageVersion: 0, pipelineStageAt: asOf,
      pipelineStageByUserId: userId, evidenceSourceType: 'user_action', userCreated: true,
      sourceActiveSnapshot: true, eligibilityState: 'eligible',
    };
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = DATABASE_URL;
    const module: TestingModule = await Test.createTestingModule({
      controllers: [FundingOpportunitiesController, FundingOpportunityV2SearchController, FundingOpportunityV2DetailController],
      providers: [
        PrismaService, Reflector, FundingOpportunityPipelineService,
        { provide: OpportunityTimelineService, useValue: {} },
        { provide: OpportunityRequirementService, useValue: {} },
        { provide: GovernmentLandscapeService, useValue: {} },
        { provide: MeriOpportunityAssessmentService, useValue: {} },
        { provide: OpportunityBudgetContextService, useValue: {} },
        { provide: OpportunityRiskService, useValue: {} },
        { provide: FundingOpportunityOutcomeService, useValue: {} },
        FundingOpportunityV2WorkflowService,
        FundingOpportunityV2SearchService, FundingOpportunityV2DecoratorService, FundingOpportunityV2DetailService,
        {
          provide: FUNDING_OPPORTUNITY_V2_CATALOG_ADAPTERS, inject: [PrismaService],
          useFactory: (db: PrismaService) => createPrismaOpportunityCatalogAdapters(db),
        },
        {
          provide: FUNDING_OPPORTUNITY_V2_CLIENT_PROFILE_READER, inject: [PrismaService],
          useFactory: (db: PrismaService) => createOpportunityClientProfileReader(db),
        },
        RolesGuard, FundingOpportunityClientAccessGuard, FundingOpportunitiesFlagGuard,
        FundingOpportunitiesPipelineFlagGuard,
      ],
    }).compile();
    app = module.createNestApplication();
    configureApiHttpApp(app, {
      includeClerkRawBody: false, includeRecallRawBody: false, includeTangoRawBody: false,
      includeEmailSignatureLargeBody: false, defaultJsonLimit: '1mb',
    });
    app.use((req: Request & { tenantContext?: TenantContext }, _res: Response, next: NextFunction) => {
      if (req.headers.authorization !== `Bearer ${ns}`) return next(new Error('controlled authentication boundary rejection'));
      req.tenantContext = context;
      next();
    });
    await app.init();
    prisma = app.get(PrismaService);
    await prisma.tenant.create({ data: { id: tenantId, slug: ns, name: ns } });
    await prisma.user.create({ data: { id: userId, clerkUserId: `${ns}-clerk`, email: `${ns}@example.invalid` } });
    await prisma.tenantMembership.create({ data: { tenantId, userId, role: 'standard_user', status: 'active' } });
    await prisma.client.create({ data: { id: clientId, tenantId, name: ns, memoryWall: true, profileStatus: 'ACTIVE', applicantTypes: ['Business'], naicsCodes: ['541715'], pscCodes: ['AR15'] } });
    await prisma.clientMemoryAccess.create({ data: { tenantId, clientId, userId, grantedBy: userId } });
    await prisma.$executeRaw`INSERT INTO intel_feature_flag(id, feature, tenant_id, enabled) VALUES
      (${masterFlagId}, 'funding_opportunities', ${tenantId}, true),
      (${pipelineFlagId}, 'funding_opportunities_pipeline_v2', ${tenantId}, true),
      (${sbirFlagId}, 'funding_opportunities_sbir', ${tenantId}, true),
      (${forecastFlagId}, 'funding_opportunities_forecasts', ${tenantId}, true)`;
    await prisma.tangoSbirTopic.createMany({ data: [topicId, conflictTopicId, rollbackTopicId, closedTopicId, sharedSbirId].map((id, index) => ({
      tangoSbirId: id, topicNumber: id === sharedSbirId ? `${ns}-shared-topic` : `${ns}-public-topic-${index}`, title: id === sharedSbirId ? `${ns} shared topic` : `${ns} current topic ${index}`,
      solicitationStatus: 'open', closeDate: new Date('2099-10-15T00:00:00Z'),
    })) });
    await prisma.tangoSbirSolicitation.create({ data: {
      tangoSbirId: sharedSbirId, solicitationNumber: `${ns}-shared-solicitation`, title: `${ns} shared solicitation`,
      program: 'SBIR', solicitationStatus: 'open', endDate: new Date('2099-10-15T00:00:00Z'),
    } });
    await prisma.federalGrant.create({ data: {
      id: grantId, title: `${ns} grant`, agency: `${ns} grant agency`, fundingInstrument: 'Grant',
      eligibility: ['Small businesses'], status: 'posted', closeDate: new Date('2099-10-15T00:00:00Z'),
    } });
    await prisma.samOpportunity.create({ data: {
      id: samId, noticeId: `${ns}-notice`, title: `${ns} sam`, noticeType: 'Solicitation',
      active: true, responseDeadline: new Date('2099-10-15T00:00:00Z'),
    } });
    await prisma.tangoProcurementForecast.create({ data: {
      tangoForecastId: forecastId, title: `${ns} forecast`, isActive: true, snapshot: {},
      anticipatedAwardDate: new Date('2099-10-15T00:00:00Z'),
    } });
    await prisma.tangoDibbsSolicitation.create({ data: {
      tangoDibbsId: dibbsId, documentType: 'rfq', solicitation: `${ns}-dibbs`, isOpen: true,
      closesDate: new Date('2099-10-15T00:00:00Z'),
    } });
    await prisma.californiaGrantOpportunity.create({ data: {
      portalId: caId, title: `${ns} California`, status: 'active',
      applicationDeadlineCalendarDate: new Date('2099-10-15T00:00:00Z'), applicantTypes: ['Business'],
    } });
    await prisma.clientFundingOpportunity.createMany({ data: [
      row(rowId),
      row(conflictRowId, 'reviewing'),
      row(rollbackRowId, 'reviewing'),
      row(closedRowId),
      ...Object.values(allSourceRowIds).map((id) => row(id)),
    ] });
  });

  afterAll(async () => {
    try {
      if (!prisma) return;
      await prisma.withSystem(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.allow_audit_purge','on',true)`;
        await tx.auditLog.deleteMany({ where: { tenantId } });
        await tx.fundingOpportunityStageTransition.deleteMany({ where: { tenantId } });
        await tx.clientFundingOpportunity.deleteMany({ where: { tenantId, clientId } });
        await tx.clientMemoryAccess.deleteMany({ where: { tenantId, clientId } });
        await tx.client.deleteMany({ where: { id: clientId, tenantId } });
        await tx.tenantMembership.deleteMany({ where: { tenantId, userId } });
        await tx.tenant.deleteMany({ where: { id: tenantId, slug: ns } });
        await tx.user.deleteMany({ where: { id: userId, clerkUserId: `${ns}-clerk` } });
        await tx.$executeRaw`DELETE FROM intel_feature_flag WHERE tenant_id = ${tenantId}`;
      });
      await prisma.tangoSbirTopic.deleteMany({ where: { tangoSbirId: { in: [topicId, conflictTopicId, rollbackTopicId, closedTopicId, sharedSbirId] } } });
      await prisma.tangoSbirSolicitation.deleteMany({ where: { tangoSbirId: sharedSbirId } });
      await prisma.federalGrant.deleteMany({ where: { id: grantId } });
      await prisma.samOpportunity.deleteMany({ where: { id: samId } });
      await prisma.tangoProcurementForecast.deleteMany({ where: { tangoForecastId: forecastId } });
      await prisma.tangoDibbsSolicitation.deleteMany({ where: { tangoDibbsId: dibbsId } });
      await prisma.californiaGrantOpportunity.deleteMany({ where: { portalId: caId } });
    } finally {
      await app?.close();
      await prisma?.$disconnect();
    }
  });

  const auth = () => ({ Authorization: 'Bearer ' + ns });
  const boardPath = `/api/intelligence/clients/${clientId}/pipeline`;
  const stagePath = (id: string) => `${boardPath}/${id}/stage`;

  test('real workflow save preserves typed SBIR identity before board reads the same row', async () => {
    const saved = await request(app.getHttpServer())
      .post(`/api/intelligence/clients/${clientId}/opportunities/sbir_sttr/${topicId}/save`)
      .set(auth())
      .send({ status: 'saved', notes: 'HTTP pipeline handoff' })
      .expect(201);
    expect(saved.body.workflow).toMatchObject({ status: 'pursuing', notes: 'HTTP pipeline handoff' });
    const board = await request(app.getHttpServer()).get(boardPath).set(auth()).expect(200);
    expect(board.body.cards.find((value: { rowId: string }) => value.rowId === rowId)).toMatchObject({
      rowId, sourceRecordId: topicId, sourceRecordType: 'sbir_topic',
    });
    const stored = await prisma.clientFundingOpportunity.findUnique({
      where: { id: rowId }, select: { sourceRecordType: true, sourceRecordKey: true },
    });
    expect(stored).toEqual({ sourceRecordType: 'sbir_topic', sourceRecordKey: topicId });
  });

  test('Search -> Save -> Board -> Detail preserves six source identities and typed SBIR pair', async () => {
    const search = await request(app.getHttpServer()).get('/api/intelligence/opportunities/v2/search').query({
      mode: 'all', lifecycle: 'active,forecast', sources: 'grants_gov,sam_gov,agency_forecast,dibbs,sbir_sttr,ca_portal', q: ns,
    }).set(auth()).expect(200);
    expect(new Set(search.body.opportunities.map((value: { source: string }) => value.source))).toEqual(new Set(['grants_gov', 'sam_gov', 'agency_forecast', 'dibbs', 'sbir_sttr', 'ca_portal']));
    expect(search.body.opportunities).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'grants_gov', sourceRecordId: grantId, title: `${ns} grant`, sourceFacts: expect.objectContaining({ provenance: 'federal_grant' }) }),
      expect.objectContaining({ source: 'sam_gov', sourceRecordId: samId, title: `${ns} sam`, sourceFacts: expect.objectContaining({ provenance: 'sam_opportunity' }) }),
      expect.objectContaining({ source: 'agency_forecast', sourceRecordId: forecastId, title: `${ns} forecast`, sourceFacts: expect.objectContaining({ provenance: 'tango_procurement_forecast' }) }),
      expect.objectContaining({ source: 'dibbs', sourceRecordId: dibbsId, sourceFacts: expect.objectContaining({ provenance: 'tango_dibbs_solicitation' }) }),
      expect.objectContaining({ source: 'sbir_sttr', sourceRecordId: topicId, title: `${ns} current topic 0`, sourceFacts: expect.objectContaining({ provenance: 'tango_sbir_topic' }) }),
      expect.objectContaining({ source: 'sbir_sttr', sourceRecordId: sharedSbirId, title: `${ns} shared topic`, sourceFacts: expect.objectContaining({ provenance: 'tango_sbir_topic' }) }),
      expect.objectContaining({ source: 'sbir_sttr', sourceRecordId: sharedSbirId, title: `${ns} shared solicitation`, sourceFacts: expect.objectContaining({ provenance: 'tango_sbir_solicitation' }) }),
      expect.objectContaining({ source: 'ca_portal', sourceRecordId: caId, title: `${ns} California`, sourceFacts: expect.objectContaining({ provenance: 'california_grants_portal' }) }),
    ]));
    expect(search.body.opportunities.filter((value: { source: string }) => value.source === 'sbir_sttr').map((value: { sourceRecordId: string; title: string; sourceFacts: { provenance: string } }) => [value.sourceRecordId, value.title, value.sourceFacts.provenance])).toEqual(expect.arrayContaining([
      [topicId, `${ns} current topic 0`, 'tango_sbir_topic'],
      [sharedSbirId, `${ns} shared topic`, 'tango_sbir_topic'],
      [sharedSbirId, `${ns} shared solicitation`, 'tango_sbir_solicitation'],
    ]));
    const cases = [
      ['grants_gov', grantId, 'grants_gov_opportunity', `${ns} grant`, null, 'federal_grant'],
      ['sam_gov', samId, 'sam_notice', `${ns} sam`, null, 'sam_opportunity'],
      ['agency_forecast', forecastId, 'tango_procurement_forecast', `${ns} forecast`, null, 'tango_procurement_forecast'],
      ['dibbs', dibbsId, 'dibbs_solicitation', `${ns}-dibbs`, `${ns}-dibbs`, 'tango_dibbs_solicitation'],
      ['sbir_sttr', topicId, 'sbir_topic', `${ns} current topic 0`, `${ns}-public-topic-0`, 'tango_sbir_topic'],
      ['ca_portal', caId, 'ca_grant_opportunity', `${ns} California`, `${ns}-ca`, 'california_grant_opportunity'],
    ] as const;
    for (const [source, id, recordType, title, publicReference, sourceModel] of cases) {
      await request(app.getHttpServer()).post(`/api/intelligence/clients/${clientId}/opportunities/${source}/${encodeURIComponent(id)}/save`).set(auth()).send({ status: 'saved' }).expect(201);
      const detail = await request(app.getHttpServer()).get(`/api/intelligence/opportunities/v2/detail/${source}/${encodeURIComponent(id)}`).set(auth()).expect(200);
      expect(detail.body).toMatchObject({ source, sourceRecordId: id, opportunity: {
        source, sourceRecordId: id, title,
        sourceReference: { source, recordType, sourceRecordId: id },
        displayReference: publicReference ? { value: publicReference } : null,
        provenance: { sourceModel },
      } });
    }
    const board = await request(app.getHttpServer()).get(boardPath).set(auth()).expect(200);
    const sharedCards = board.body.cards.filter((value: { source: string; sourceRecordId: string }) => value.source === 'sbir_sttr' && value.sourceRecordId === sharedSbirId);
    expect(sharedCards).toHaveLength(2);
    expect(new Set(sharedCards.map((value: { rowId: string }) => value.rowId)).size).toBe(2);
    expect(sharedCards).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceRecordType: 'sbir_topic', sourceReference: `${ns}-shared-topic`, title: `${ns} shared topic` }),
      expect.objectContaining({ sourceRecordType: 'sbir_solicitation', sourceReference: `${ns}-shared-solicitation`, title: `${ns} shared solicitation` }),
    ]));
    expect(board.body.cards).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'grants_gov', sourceRecordId: grantId, sourceRecordType: 'grants_gov_opportunity' }),
      expect.objectContaining({ source: 'sam_gov', sourceRecordId: samId, sourceRecordType: 'sam_notice' }),
      expect.objectContaining({ source: 'agency_forecast', sourceRecordId: forecastId, sourceRecordType: 'tango_procurement_forecast' }),
      expect.objectContaining({ source: 'dibbs', sourceRecordId: dibbsId, sourceRecordType: 'dibbs_solicitation' }),
      expect.objectContaining({ source: 'sbir_sttr', sourceRecordId: topicId, sourceRecordType: 'sbir_topic' }),
      expect.objectContaining({ source: 'ca_portal', sourceRecordId: caId, sourceRecordType: 'ca_grant_opportunity' }),
    ]));
    expect(board.body.cards.find((value: { sourceRecordId: string }) => value.sourceRecordId === topicId)).toMatchObject({ sourceRecordType: 'sbir_topic', sourceReference: `${ns}-public-topic-0`, title: `${ns} current topic 0` });
    expect(board.body.cards.find((value: { sourceRecordId: string }) => value.sourceRecordId === forecastId)).toMatchObject({ lifecycle: 'forecast', responseDeadline: null, capability: { canPursue: false } });
  });

  test('GET board uses current source facts, opaque row id, public reference, and persisted stage reason', async () => {
    await prisma.fundingOpportunityStageTransition.create({ data: {
      tenantId, clientFundingOpportunityId: rowId, fromStage: 'qualified', toStage: 'pursuing',
      actorUserId: userId, reason: 'Current pursuit basis', occurredAt: asOf,
    } });
    const response = await request(app.getHttpServer()).get(boardPath).set(auth()).expect(200);
    const card = response.body.cards.find((value: { rowId: string }) => value.rowId === rowId);
    expect(card).toMatchObject({
      rowId, source: 'sbir_sttr', sourceRecordId: topicId, sourceRecordType: 'sbir_topic',
      title: `${ns} current topic 0`, stage: 'pursuing', stageReason: 'Current pursuit basis',
      stageExplanation: 'Moved here by a person.', lifecycle: 'active',
    });
    expect(card.rowId).not.toBe(topicId);
    expect(card.sourceReference).toBe(`${ns}-public-topic-0`);
    expect(card.capability.canPursue).toBe(true);
  });

  test('POST stage enforces required Lost reason, transition graph, terminal stages, and expectedVersion', async () => {
    await request(app.getHttpServer()).post(stagePath(rowId)).set(auth()).send({ toStage: 'lost', expectedVersion: 0 }).expect(400);
    const moved = await request(app.getHttpServer()).post(stagePath(rowId)).set(auth()).send({
      toStage: 'lost', expectedVersion: 0, reason: '  No teaming capacity.  ',
    }).expect(201);
    expect(moved.body).toMatchObject({ rowId, from: 'pursuing', to: 'lost', version: 1 });
    const board = await request(app.getHttpServer()).get(boardPath).set(auth()).expect(200);
    expect(board.body.cards.find((value: { rowId: string }) => value.rowId === rowId)).toMatchObject({
      stage: 'lost', stageReason: 'No teaming capacity.', capability: { canPursue: false },
    });
    await request(app.getHttpServer()).post(stagePath(rowId)).set(auth()).send({
      toStage: 'reviewing', expectedVersion: 1,
    }).expect(400);
    await request(app.getHttpServer()).post(stagePath(conflictRowId)).set(auth()).send({
      toStage: 'qualified', expectedVersion: 9,
    }).expect(409);
  });

  test('audit failure at the actual stage-transition create rolls back row, version, and transition', async () => {
    const realWithTenant = prisma.withTenant.bind(prisma);
    let transitionCreateHit = false;
    (prisma as unknown as { withTenant: typeof prisma.withTenant }).withTenant = ((tenant: string, fn: any, options?: any) =>
      realWithTenant(tenant, (tx: any) => Promise.resolve(fn(new Proxy(tx, { get(target, key) {
        if (key === 'fundingOpportunityStageTransition') {
          return { ...target.fundingOpportunityStageTransition, create: async () => {
            transitionCreateHit = true;
            throw new Error('controlled stage transition audit failure');
          } };
        }
        return Reflect.get(target, key);
      } }))), options)) as typeof prisma.withTenant;
    try {
      await request(app.getHttpServer()).post(stagePath(rollbackRowId)).set(auth()).send({
        toStage: 'qualified', expectedVersion: 0,
      }).expect(500);
    } finally {
      (prisma as unknown as { withTenant: typeof prisma.withTenant }).withTenant = realWithTenant;
    }
    expect(transitionCreateHit).toBe(true);
    await expect(prisma.clientFundingOpportunity.findUnique({ where: { id: rollbackRowId }, select: { pipelineStage: true, pipelineStageVersion: true } })).resolves.toEqual({ pipelineStage: 'reviewing', pipelineStageVersion: 0 });
    await expect(prisma.fundingOpportunityStageTransition.count({ where: { clientFundingOpportunityId: rollbackRowId } })).resolves.toBe(0);
  });

  test('missing and ambiguous current identities fail closed while history remains readable', async () => {
    const missingId = crypto.randomUUID();
    await prisma.clientFundingOpportunity.create({ data: { ...row(missingId), sourceRecordKey: missingId } });
    const board = await request(app.getHttpServer()).get(boardPath).set(auth()).expect(200);
    expect(board.body.cards.find((value: { rowId: string }) => value.rowId === missingId)).toMatchObject({
      title: null, sourceReference: null, lifecycle: null, currentEvidence: null, capability: { canPursue: false },
    });
    await prisma.clientFundingOpportunity.delete({ where: { id: missingId } });
    await request(app.getHttpServer()).get(`/api/intelligence/opportunities/v2/detail/sbir_sttr/${sharedSbirId}`).set(auth()).expect(400);
    await prisma.$executeRaw`UPDATE intel_feature_flag SET enabled = false WHERE id = ${sbirFlagId}`;
    try {
      const disabled = await request(app.getHttpServer()).get(boardPath).set(auth()).expect(200);
      expect(disabled.body.cards.find((value: { rowId: string }) => value.rowId === rowId)).toMatchObject({ title: null, sourceReference: null, lifecycle: null, currentEvidence: null, capability: { canPursue: false } });
    } finally {
      await prisma.$executeRaw`UPDATE intel_feature_flag SET enabled = true WHERE id = ${sbirFlagId}`;
    }
  });

  test('current profile ineligibility removes new pursue without hiding source facts', async () => {
    await prisma.client.update({ where: { id: clientId }, data: { applicantTypes: ['State governments'] } });
    const board = await request(app.getHttpServer()).get(boardPath).set(auth()).expect(200);
    expect(board.body.cards.find((value: { rowId: string }) => value.rowId === allSourceRowIds.grant)).toMatchObject({ title: `${ns} grant`, capability: { canPursue: false } });
    await prisma.client.update({ where: { id: clientId }, data: { applicantTypes: ['Business'] } });
  });

  test('other client scope cannot read this tenant client board', async () => {
    const otherClientId = crypto.randomUUID();
    await prisma.client.create({ data: { id: otherClientId, tenantId, name: `${ns}-other-client`, memoryWall: false } });
    try {
      await request(app.getHttpServer()).get(`/api/intelligence/clients/${otherClientId}/pipeline`).set(auth()).expect(200);
      await prisma.client.update({ where: { id: otherClientId }, data: { memoryWall: true } });
      await request(app.getHttpServer()).get(`/api/intelligence/clients/${otherClientId}/pipeline`).set(auth()).expect(404);
    } finally {
      await prisma.client.delete({ where: { id: otherClientId } });
    }
  });

  test('pipeline flag, role, and client grant are enforced without accepting caller tenant identity', async () => {
    context = { ...context, role: 'client_portal_user' };
    await request(app.getHttpServer()).get(boardPath).set(auth()).expect(403);
    context = { ...context, role: 'standard_user' };
    await prisma.$executeRaw`UPDATE intel_feature_flag SET enabled = false WHERE id = ${pipelineFlagId}`;
    await request(app.getHttpServer()).get(boardPath).set(auth()).expect(404);
    await prisma.$executeRaw`UPDATE intel_feature_flag SET enabled = true WHERE id = ${pipelineFlagId}`;
    await prisma.$executeRaw`UPDATE intel_feature_flag SET enabled = false WHERE id = ${masterFlagId}`;
    await request(app.getHttpServer()).get(boardPath).set(auth()).expect(404);
    await prisma.$executeRaw`UPDATE intel_feature_flag SET enabled = true WHERE id = ${masterFlagId}`;
    await prisma.clientMemoryAccess.deleteMany({ where: { tenantId, clientId, userId } });
    await request(app.getHttpServer()).get(boardPath).set(auth()).expect(404);
    await prisma.clientMemoryAccess.create({ data: { tenantId, clientId, userId, grantedBy: userId } });
  });

  test('closed current source blocks new Pursue but preserves historical Pursuing to Submitted', async () => {
    await prisma.tangoSbirTopic.update({ where: { tangoSbirId: closedTopicId }, data: { solicitationStatus: 'closed', closeDate: new Date('2020-01-01T00:00:00Z') } });
    await request(app.getHttpServer()).post(stagePath(closedRowId)).set(auth()).send({ toStage: 'submitted', expectedVersion: 0 }).expect(201);
    await expect(prisma.clientFundingOpportunity.findUnique({ where: { id: closedRowId }, select: { pipelineStage: true } })).resolves.toEqual({ pipelineStage: 'submitted' });
    await prisma.tangoSbirTopic.update({ where: { tangoSbirId: closedTopicId }, data: { solicitationStatus: 'open', closeDate: new Date('2099-10-15T00:00:00Z') } });
  });
});

export {};
