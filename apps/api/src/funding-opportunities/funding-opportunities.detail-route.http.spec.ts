import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { TenantContext } from '@capiro/shared';
import { RolesGuard } from '../auth/roles.guard.js';
import { configureApiHttpApp } from '../bootstrap/configure-api-http-app.js';
import { FundingOpportunityClientAccessGuard } from './funding-opportunity-client-access.guard.js';
import { FundingOpportunityFeedService } from './funding-opportunity-feed.service.js';
import { FundingOpportunitiesController } from './funding-opportunities.controller.js';
import { FundingOpportunitiesService } from './funding-opportunities.service.js';
import { FundingOpportunityActionsService } from './funding-opportunity-actions.service.js';
import { FundingOpportunityInboxService } from './funding-opportunity-inbox.service.js';
import { ForecastOpportunityReadService } from './forecast-opportunity-read.service.js';
import { OpportunityTimelineService } from './opportunity-timeline.service.js';
import { OpportunityRequirementService } from './requirements/opportunity-requirement.service.js';
import { GovernmentLandscapeService } from './government-landscape.service.js';
import { FundingOpportunityPipelineService } from './funding-opportunity-pipeline.js';
import { MeriOpportunityAssessmentService } from './meri-opportunity-assessment.service.js';
import { OpportunityBudgetContextService } from './opportunity-budget-context.service.js';
import { OpportunityRiskService } from './opportunity-risk.service.js';
import { FundingOpportunityOutcomeService } from './funding-opportunity-outcome.service.js';
import {
  FundingOpportunitiesBudgetFlagGuard,
  FundingOpportunitiesDocumentsFlagGuard,
  FundingOpportunitiesFlagGuard,
  FundingOpportunitiesForecastFlagGuard,
  FundingOpportunitiesInboxFlagGuard,
  FundingOpportunitiesLandscapeFlagGuard,
  FundingOpportunitiesMeriFlagGuard,
  FundingOpportunitiesNoticeHistoryFlagGuard,
  FundingOpportunitiesPipelineFlagGuard,
  FundingOpportunitiesRiskFlagGuard,
} from './funding-opportunities-flag.guard.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const CLIENT = '492ab348-6600-4fca-9d1b-5f072b4e745e';
const SAM_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
// A real Grants.gov opportunity id: numeric, and NOT a segment name any DTO
// declares. This exact id is the one the 2026-08-18 production 400 was
// reported against.
const GRANT_ID = '362036';

/**
 * HTTP/controller-layer proof for the `opportunities/:source/:id` route family.
 *
 * The app's global ValidationPipe (configure-api-http-app.ts) runs
 * `whitelist: true, forbidNonWhitelisted: true` over EVERY `@Param()`-bound
 * DTO — and the params object Nest hands it contains every segment the route
 * pattern names, not just the ones the DTO declares. So a DTO bound to a
 * `:source/:id` route must whitelist `id` (and `clientId` on the
 * client-scoped writes) or the pipe rejects the request as
 * "property id should not exist" before the handler ever runs — an
 * unconditional 400 for a record the inbox happily lists.
 *
 * That is exactly what shipped: every unit spec in this module calls the
 * controller methods directly, which bypasses the pipe, so only an HTTP-level
 * test can regress this. Mirrors the production pipeline by calling the real
 * configureApiHttpApp() rather than a hand-copied ValidationPipe.
 */
describe('funding-opportunities :source/:id routes through the real HTTP pipeline', () => {
  let app: INestApplication;

  const patchWorkflow = jest
    .fn()
    .mockResolvedValue({ id: 'workflow-1', status: 'saved', nextAction: 'Confirm agency timing' });
  const feedList = jest.fn().mockResolvedValue({ source: 'agency_forecast', rows: [], total: 0 });
  const feedDetail = jest
    .fn()
    .mockResolvedValue({ source: 'dibbs', sourceRecordId: 'line-1', responseDeadline: null });
  const feedWrite = jest.fn().mockResolvedValue({ id: 'workflow-1', status: 'saved' });
  const action = jest.fn().mockResolvedValue({ workflowId: 'workflow-1', workflowStatus: 'saved' });
  const getOpportunity = jest.fn().mockResolvedValue({
    id: `grants_gov:${GRANT_ID}`,
    source: 'grants_gov',
    title: 'IGNIITE 2026',
  });
  const getTimeline = jest.fn().mockResolvedValue({ entries: [] });
  const composeActionPlan = jest.fn().mockResolvedValue({ actions: [] });
  const getOutcomeHistory = jest.fn().mockResolvedValue([]);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [FundingOpportunitiesController],
      providers: [
        { provide: FundingOpportunitiesService, useValue: { getOpportunity, patchWorkflow } },
        { provide: FundingOpportunityActionsService, useValue: { act: action } },
        {
          provide: FundingOpportunityFeedService,
          useValue: { list: feedList, detail: feedDetail, write: feedWrite },
        },
        { provide: FundingOpportunityInboxService, useValue: {} },
        { provide: ForecastOpportunityReadService, useValue: {} },
        { provide: OpportunityTimelineService, useValue: { getTimeline } },
        { provide: OpportunityRequirementService, useValue: {} },
        { provide: GovernmentLandscapeService, useValue: { composeActionPlan } },
        { provide: FundingOpportunityPipelineService, useValue: {} },
        { provide: MeriOpportunityAssessmentService, useValue: {} },
        { provide: OpportunityBudgetContextService, useValue: {} },
        { provide: OpportunityRiskService, useValue: {} },
        { provide: FundingOpportunityOutcomeService, useValue: { getOutcomeHistory } },
      ],
    })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      // Every guard named anywhere on the controller must be overridden, not
      // just the ones these routes hit: Nest resolves all route guards at
      // init, and the real ones want PrismaService.
      .overrideGuard(FundingOpportunityClientAccessGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(FundingOpportunitiesFlagGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(FundingOpportunitiesInboxFlagGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(FundingOpportunitiesForecastFlagGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(FundingOpportunitiesNoticeHistoryFlagGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(FundingOpportunitiesDocumentsFlagGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(FundingOpportunitiesLandscapeFlagGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(FundingOpportunitiesPipelineFlagGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(FundingOpportunitiesMeriFlagGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(FundingOpportunitiesBudgetFlagGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(FundingOpportunitiesRiskFlagGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication();
    // The REAL production HTTP pipeline — prefix, parsers, ValidationPipe,
    // Prisma filter — not a per-test copy that could drift from main.ts.
    configureApiHttpApp(app, {
      includeClerkRawBody: false,
      includeRecallRawBody: false,
      includeTangoRawBody: false,
      includeEmailSignatureLargeBody: false,
      defaultJsonLimit: '1mb',
    });
    app.use((req: { tenantContext?: TenantContext }, _res: unknown, next: () => void) => {
      req.tenantContext = {
        tenantId: TENANT,
        tenantSlug: 'test',
        userId: USER,
        clerkUserId: `clerk_${USER}`,
        role: 'standard_user',
      };
      next();
    });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET opportunities/grants_gov/:id?clientId= reaches the service (the 2026-08-18 production 400)', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/intelligence/opportunities/grants_gov/${GRANT_ID}`)
      .query({ clientId: CLIENT });
    expect(res.status).toBe(200);
    expect(getOpportunity).toHaveBeenCalledWith(TENANT, 'grants_gov', GRANT_ID, CLIENT);
  });

  it('GET opportunities/sam_gov/:id without clientId reaches the service unscored', async () => {
    const res = await request(app.getHttpServer()).get(
      `/api/intelligence/opportunities/sam_gov/${SAM_ID}`,
    );
    expect(res.status).toBe(200);
    expect(getOpportunity).toHaveBeenCalledWith(TENANT, 'sam_gov', SAM_ID, null);
  });

  it('GET .../timeline (three-segment SourceParamDto route) is not rejected by the pipe', async () => {
    const res = await request(app.getHttpServer()).get(
      `/api/intelligence/opportunities/sam_gov/${SAM_ID}/timeline`,
    );
    expect(res.status).toBe(200);
    expect(getTimeline).toHaveBeenCalledWith('sam_gov', SAM_ID);
  });

  it('GET .../action-plan (InboxSourceParamDto route) is not rejected by the pipe', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/intelligence/opportunities/grants_gov/${GRANT_ID}/action-plan`)
      .query({ clientId: CLIENT });
    expect(res.status).toBe(200);
    expect(composeActionPlan).toHaveBeenCalledWith(TENANT, USER, CLIENT, 'grants_gov', GRANT_ID);
  });

  it('GET clients/:clientId/opportunities/:source/:id/outcome (three path params) is not rejected', async () => {
    const res = await request(app.getHttpServer()).get(
      `/api/intelligence/clients/${CLIENT}/opportunities/grants_gov/${GRANT_ID}/outcome`,
    );
    expect(res.status).toBe(200);
    expect(getOutcomeHistory).toHaveBeenCalledWith(
      { tenantId: TENANT, userId: USER, role: 'standard_user' },
      CLIENT,
      'grants_gov',
      GRANT_ID,
    );
  });

  it('still refuses a planned source: the catalog vocabulary stays exactly two entries wide', async () => {
    const res = await request(app.getHttpServer()).get(
      `/api/intelligence/opportunities/agency_forecast/${GRANT_ID}`,
    );
    expect(res.status).toBe(400);
    expect(getOpportunity).not.toHaveBeenCalledWith(
      TENANT,
      'agency_forecast',
      expect.anything(),
      expect.anything(),
    );
  });
  it('Browse accepts a paginated Tango feed with no client selected', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/intelligence/opportunities/feeds/agency_forecast')
      .query({ page: 2, pageSize: 25, q: 'aircraft' });
    expect(res.status).toBe(200);
    expect(feedList).toHaveBeenCalledWith(
      TENANT,
      USER,
      'agency_forecast',
      expect.objectContaining({ page: 2, pageSize: 25, q: 'aircraft' }),
    );
  });
  it('DIBBS detail validates both source and opaque id', async () => {
    const res = await request(app.getHttpServer()).get(
      '/api/intelligence/opportunities/feeds/dibbs/line-1',
    );
    expect(res.status).toBe(200);
    expect(feedDetail).toHaveBeenCalledWith(TENANT, USER, 'dibbs', 'line-1', undefined);
  });
  it('forecast Save whitelists the client and source path segments', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/intelligence/clients/${CLIENT}/opportunities/agency_forecast/forecast-1/save`)
      .send({ status: 'saved' });
    expect(res.status).toBe(201);
    expect(feedWrite).toHaveBeenCalledWith(TENANT, USER, CLIENT, 'agency_forecast', 'forecast-1', {
      status: 'saved',
    });
  });
  it('forecast Review accepts an explicit team follow-up date', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/intelligence/clients/${CLIENT}/opportunities/agency_forecast/forecast-1/action`)
      .send({
        intent: 'review',
        nextAction: 'Verify agency timing',
        nextActionDueAt: '2026-10-01T00:00:00Z',
      });
    expect(res.status).toBe(201);
    expect(action).toHaveBeenCalledWith(
      TENANT,
      CLIENT,
      'agency_forecast',
      'forecast-1',
      expect.objectContaining({ intent: 'review', nextActionDueAt: '2026-10-01T00:00:00Z' }),
    );
  });

  it('PATCH accepts team-plan fields and forwards explicit null without recording a decision', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/api/intelligence/clients/${CLIENT}/opportunities/sam_gov/${SAM_ID}`)
      .send({
        ownerUserId: null,
        nextAction: 'Confirm agency timing',
        nextActionDueAt: null,
        notes: 'Assigned for review',
      });
    expect(res.status).toBe(200);
    expect(patchWorkflow).toHaveBeenCalledWith(TENANT, CLIENT, 'sam_gov', SAM_ID, {
      actorUserId: USER,
      ownerUserId: null,
      nextAction: 'Confirm agency timing',
      nextActionDueAt: null,
      notes: 'Assigned for review',
    });
  });
  it('PATCH rejects a malformed follow-up date', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/api/intelligence/clients/${CLIENT}/opportunities/sam_gov/${SAM_ID}`)
      .send({ nextActionDueAt: 'next Tuesday' });
    expect(res.status).toBe(400);
  });
  it('PATCH forwards forecast team-plan fields through the same validated route', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/api/intelligence/clients/${CLIENT}/opportunities/agency_forecast/forecast-1`)
      .send({ nextAction: null, nextActionDueAt: null });
    expect(res.status).toBe(200);
    expect(feedWrite).toHaveBeenCalledWith(TENANT, USER, CLIENT, 'agency_forecast', 'forecast-1', {
      nextAction: null,
      nextActionDueAt: null,
    });
  });
});
