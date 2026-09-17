import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../prisma/prisma.service.js';
import { Reflector } from '@nestjs/core';
import type { TenantContext } from '@capiro/shared';
import { configureApiHttpApp } from '../bootstrap/configure-api-http-app.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { FundingOpportunityClientAccessGuard } from './funding-opportunity-client-access.guard.js';
import { FundingOpportunitiesFlagGuard } from './funding-opportunities-flag.guard.js';
import {
  createOpportunityClientProfileReader,
  createPrismaOpportunityCatalogAdapters,
  FUNDING_OPPORTUNITY_V2_CATALOG_ADAPTERS,
  FUNDING_OPPORTUNITY_V2_CLIENT_PROFILE_READER,
  FundingOpportunityV2SearchService,
} from './funding-opportunity-v2-search.service.js';
import { FundingOpportunityV2DetailController } from './funding-opportunity-v2-detail.controller.js';
import { FundingOpportunityV2DetailService } from './funding-opportunity-v2-detail.service.js';
import { FundingOpportunityV2DecoratorService } from './funding-opportunity-v2-decorator.service.js';
import { OpportunityRequirementService } from './requirements/opportunity-requirement.service.js';
import { OpportunityTimelineService } from './opportunity-timeline.service.js';
import * as crypto from 'node:crypto';


const TEST_DATABASE_URL = 'postgresql://fo_test:fo_test_local@127.0.0.1:5486/fo_v2_test?schema=public';
const useIsolatedDatabase = process.env.FUNDING_OPPORTUNITIES_TEST_DATABASE_URL === TEST_DATABASE_URL && process.env.DATABASE_URL === TEST_DATABASE_URL;
const describeDb = useIsolatedDatabase ? describe : describe.skip;
const namespace = `detail-http-${process.pid}-${Date.now()}`;
const TENANT_ID = crypto.randomUUID();
const OTHER_TENANT_ID = crypto.randomUUID();
const USER_ID = crypto.randomUUID();
const ADMIN_ID = crypto.randomUUID();
const OTHER_USER_ID = crypto.randomUUID();
const CLIENT_ID = crypto.randomUUID();
const RESTRICTED_CLIENT_ID = crypto.randomUUID();
const OTHER_CLIENT_ID = crypto.randomUUID();
const FLAG_ID = `${namespace}-flag`;
const GRANT_ID = `${namespace}-grant`;
const NULL_NUMBER_GRANT_ID = `${namespace}-grant-null-number`;
const SOURCE_IDS = { sam: crypto.randomUUID(), forecast: `${namespace}-forecast`, dibbs: `${namespace}-dibbs`, topic: `${namespace}-topic`, solicitation: `${namespace}-solicitation`, ambiguous: `${namespace}-ambiguous`, ca: `${namespace}-ca` };

jest.setTimeout(60_000);

describeDb('Funding Opportunities v2 detail HTTP (isolated PostgreSQL)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let searchService: FundingOpportunityV2SearchService;
  let currentRole: TenantContext['role'] = 'standard_user';

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    prisma = new PrismaService();
    await prisma.$connect();
    await prisma.tenant.createMany({ data: [{ id: TENANT_ID, slug: `${namespace}-tenant`, name: namespace, status: 'active' }, { id: OTHER_TENANT_ID, slug: `${namespace}-other`, name: `${namespace}-other`, status: 'active' }] });
    await prisma.user.createMany({ data: [{ id: USER_ID, clerkUserId: `${namespace}-user`, email: `${namespace}-user@example.test` }, { id: ADMIN_ID, clerkUserId: `${namespace}-admin`, email: `${namespace}-admin@example.test` }, { id: OTHER_USER_ID, clerkUserId: `${namespace}-other`, email: `${namespace}-other@example.test` }] });
    await prisma.tenantMembership.createMany({ data: [{ id: crypto.randomUUID(), tenantId: TENANT_ID, userId: USER_ID, role: 'standard_user', status: 'active', joinedAt: new Date() }, { id: crypto.randomUUID(), tenantId: TENANT_ID, userId: ADMIN_ID, role: 'user_admin', status: 'active', joinedAt: new Date() }, { id: crypto.randomUUID(), tenantId: OTHER_TENANT_ID, userId: OTHER_USER_ID, role: 'standard_user', status: 'active', joinedAt: new Date() }] });
    await prisma.client.createMany({ data: [{ id: CLIENT_ID, tenantId: TENANT_ID, name: `${namespace}-visible`, status: 'active', profileStatus: 'ACTIVE', memoryWall: false, naicsCodes: ['541330'], pscCodes: ['R425'], applicantTypes: ['Small businesses'] }, { id: RESTRICTED_CLIENT_ID, tenantId: TENANT_ID, name: `${namespace}-restricted`, status: 'active', profileStatus: 'ACTIVE', memoryWall: true }, { id: OTHER_CLIENT_ID, tenantId: OTHER_TENANT_ID, name: `${namespace}-other-client`, status: 'active', profileStatus: 'ACTIVE' }] });
    await prisma.clientMemoryAccess.create({ data: { id: crypto.randomUUID(), tenantId: TENANT_ID, clientId: CLIENT_ID, userId: USER_ID, grantedBy: ADMIN_ID } });
    await prisma.clientCapability.create({ data: { id: crypto.randomUUID(), tenantId: TENANT_ID, clientId: CLIENT_ID, name: 'Engineering', keywords: ['engineering'], peNumbers: [] } });
    await prisma.clientFacility.create({ data: { id: crypto.randomUUID(), tenantId: TENANT_ID, clientId: CLIENT_ID, name: 'Main', state: 'CA' } });
    await prisma.$executeRaw`INSERT INTO intel_feature_flag (id, feature, tenant_id, enabled) VALUES (${FLAG_ID}, 'funding_opportunities', ${TENANT_ID}, true), (${FLAG_ID + '-forecasts'}, 'funding_opportunities_forecasts', ${TENANT_ID}, true), (${FLAG_ID + '-sbir'}, 'funding_opportunities_sbir', ${TENANT_ID}, true), (${FLAG_ID + '-documents'}, 'funding_opportunities_documents', ${TENANT_ID}, true), (${FLAG_ID + '-history'}, 'funding_opportunities_notice_history', ${TENANT_ID}, true)`;
    await prisma.federalGrant.create({ data: { id: GRANT_ID, title: `${namespace} Grants`, agency: 'Department of Justice', opportunityNumber: `${namespace}-opportunity-number`, fundingInstrument: 'Grant', eligibility: ['Small businesses'], openDate: new Date('2026-09-01'), closeDate: new Date('2026-12-31'), status: 'posted', description: 'Grant detail', url: `https://www.grants.gov/${GRANT_ID}`, raw: { synopsis: { opportunityId: GRANT_ID, opportunityNumber: `${namespace}-opportunity-number`, postingDate: 'Sep 1, 2026 12:00:00 AM EDT', responseDate: 'Dec 31, 2026 12:00:00 AM EDT', lastUpdatedDate: 'Sep 16, 2026 08:00:24 AM EDT', agencyContactName: 'Justice Contact', agencyContactEmail: 'detail-fixture@example.gov', agencyContactPhone: '202-555-0100', fundingDescLinkUrl: `https://www.justice.gov/${namespace}.pdf`, applicantEligibilityDesc: 'Small businesses' } }, detailSyncedAt: new Date('2026-09-16T12:00:00Z') } });
    await prisma.federalGrant.create({ data: { id: NULL_NUMBER_GRANT_ID, title: `${namespace} Grants null number`, agency: `${namespace} Unique Agency`, fundingInstrument: 'Grant', eligibility: ['Small businesses'], openDate: new Date('2026-09-01'), closeDate: null, status: 'posted', url: `https://www.grants.gov/${NULL_NUMBER_GRANT_ID}`, raw: { synopsis: { agencyContactName: 'Nullable number contact', fundingDescLinkUrl: `https://www.justice.gov/${namespace}-nullable.pdf`, responseDate: 'Dec 31, 2026 12:00:00 AM EDT' } } } });
    await prisma.samOpportunity.create({ data: { id: SOURCE_IDS.sam, noticeId: `${namespace}-notice`, title: `${namespace} SAM`, noticeType: 'Solicitation', agency: 'DOD', solicitationNumber: `${namespace}-SAM`, postedDate: new Date('2026-09-01T12:00:00Z'), responseDeadline: new Date('2026-12-31T12:00:00Z'), archiveDate: new Date('2027-01-31T12:00:00Z'), active: true, sourceUrl: `https://sam.example/${namespace}`, raw: { lastModifiedDate: '2026-09-16T12:00:00Z', postedDate: '2026-09-01', responseDeadLine: '2026-12-31T23:59:00-05:00' } } });
    await prisma.tangoProcurementForecast.create({ data: { id: crypto.randomUUID(), tangoForecastId: SOURCE_IDS.forecast, externalId: `${namespace}-PUBLIC-FORECAST`, title: `${namespace} forecast`, agency: 'DOD', anticipatedAwardDate: new Date('2027-03-01'), primaryContactName: 'Forecast contact', primaryContactEmail: `${namespace}-forecast@example.test`, sourceUrl: `https://forecast.example/${namespace}`, status: 'open', isActive: true, snapshot: { anticipatedAwardDate: '2027-03-01' } } });
    await prisma.tangoDibbsSolicitation.create({ data: { id: crypto.randomUUID(), tangoDibbsId: SOURCE_IDS.dibbs, documentType: 'rfp', solicitation: `${namespace}-DIBBS`, nomenclature: 'DIBBS item', issuedDate: new Date('2026-09-01'), closesDate: new Date('2026-12-31'), isOpen: true, documentUrl: `https://dibbs.example/${namespace}.pdf`, techDocsUrl: `https://dibbs.example/${namespace}-tech.pdf` } });
    await prisma.tangoSbirTopic.create({ data: { id: crypto.randomUUID(), tangoSbirId: SOURCE_IDS.topic, topicNumber: `${namespace}-TOPIC`, title: `${namespace} topic`, agency: 'NASA', solicitationNumber: `${namespace}-CYCLE`, openDate: new Date('2026-09-01'), closeDate: new Date('2026-12-31'), solicitationStatus: 'open', topicUrl: `https://sbir.example/${namespace}-topic` } });
    await prisma.tangoSbirSolicitation.create({ data: { id: crypto.randomUUID(), tangoSbirId: SOURCE_IDS.solicitation, solicitationNumber: `${namespace}-CYCLE`, title: `${namespace} solicitation`, program: 'SBIR', startDate: new Date('2026-09-01'), endDate: new Date('2026-12-31'), solicitationStatus: 'open', solDownloadUrl: `https://sbir.example/${namespace}-sol.pdf` } });
    await prisma.tangoSbirTopic.create({ data: { id: crypto.randomUUID(), tangoSbirId: SOURCE_IDS.ambiguous, title: 'ambiguous topic', openDate: new Date('2026-09-01'), closeDate: new Date('2026-12-31'), solicitationStatus: 'open' } });
    await prisma.tangoSbirSolicitation.create({ data: { id: crypto.randomUUID(), tangoSbirId: SOURCE_IDS.ambiguous, solicitationNumber: `${namespace}-AMB`, title: 'ambiguous solicitation', startDate: new Date('2026-09-01'), endDate: new Date('2026-12-31'), solicitationStatus: 'open' } });
    await prisma.californiaGrantOpportunity.create({ data: { portalId: SOURCE_IDS.ca, title: `${namespace} CA`, agencyDept: 'CA Agency', status: 'Active', openDateCalendarDate: new Date('2026-09-01'), applicationDeadlineCalendarDate: new Date('2026-12-31'), grantUrl: `https://ca.example/${namespace}`, electronicSubmissionUrls: [`https://ca.example/${namespace}/apply`], applicantTypes: ['Business'], raw: {} } });


    const moduleRef = await Test.createTestingModule({
      controllers: [FundingOpportunityV2DetailController],
      providers: [
        Reflector,
        PrismaService,
        FundingOpportunityV2DetailService,
        FundingOpportunityV2DecoratorService,
        OpportunityRequirementService,
        OpportunityTimelineService,

        FundingOpportunityV2SearchService,
        {
          provide: FUNDING_OPPORTUNITY_V2_CATALOG_ADAPTERS,
          inject: [PrismaService],
          useFactory: (db: PrismaService) => createPrismaOpportunityCatalogAdapters(db),
        },
        {
          provide: FUNDING_OPPORTUNITY_V2_CLIENT_PROFILE_READER,
          inject: [PrismaService],
          useFactory: (db: PrismaService) => createOpportunityClientProfileReader(db),
        },
        RolesGuard,
        FundingOpportunitiesFlagGuard,
        FundingOpportunityClientAccessGuard,
      ],
    })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .compile();

    app = moduleRef.createNestApplication();
    configureApiHttpApp(app, {
      includeClerkRawBody: false,
      includeRecallRawBody: false,
      includeTangoRawBody: false,
      includeEmailSignatureLargeBody: false,
      defaultJsonLimit: '1mb',
    });
    app.use((req: { tenantContext?: TenantContext }, _res: unknown, next: () => void) => {
      req.tenantContext = {
        tenantId: TENANT_ID,
        tenantSlug: 'detail-http-test',
        userId: USER_ID,
        clerkUserId: `clerk_${USER_ID}`,
        role: currentRole,
      };
      next();
    });
    await app.init();
    searchService = app.get(FundingOpportunityV2SearchService);
  });

  afterAll(async () => {
    try { if (app) await app.close(); } finally {
      if (prisma) {
        await prisma.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.allow_audit_purge','on',true)`;
          await tx.$executeRaw`DELETE FROM audit_logs WHERE tenant_id = ${TENANT_ID}::uuid`;
          await tx.clientMemoryAccess.deleteMany({ where: { tenantId: TENANT_ID } });
          await tx.clientCapability.deleteMany({ where: { tenantId: TENANT_ID } });
          await tx.clientFacility.deleteMany({ where: { tenantId: TENANT_ID } });
          await tx.client.deleteMany({ where: { id: { in: [CLIENT_ID, RESTRICTED_CLIENT_ID, OTHER_CLIENT_ID] } } });
          await tx.tenantMembership.deleteMany({ where: { tenantId: { in: [TENANT_ID, OTHER_TENANT_ID] } } });
          await tx.tenant.deleteMany({ where: { id: { in: [TENANT_ID, OTHER_TENANT_ID] } } });
          await tx.user.deleteMany({ where: { id: { in: [USER_ID, ADMIN_ID, OTHER_USER_ID] } } });
          await tx.$executeRaw`DELETE FROM intel_feature_flag WHERE id LIKE ${namespace + '%'}`;
        });
        await prisma.federalGrant.deleteMany({ where: { id: { in: [GRANT_ID, NULL_NUMBER_GRANT_ID] } } });
        await prisma.samOpportunity.deleteMany({ where: { id: SOURCE_IDS.sam } });
        await prisma.tangoProcurementForecast.deleteMany({ where: { tangoForecastId: SOURCE_IDS.forecast } });
        await prisma.tangoDibbsSolicitation.deleteMany({ where: { tangoDibbsId: SOURCE_IDS.dibbs } });
        await prisma.tangoSbirTopic.deleteMany({ where: { tangoSbirId: { in: [SOURCE_IDS.topic, SOURCE_IDS.ambiguous] } } });
        await prisma.tangoSbirSolicitation.deleteMany({ where: { tangoSbirId: { in: [SOURCE_IDS.solicitation, SOURCE_IDS.ambiguous] } } });
        await prisma.californiaGrantOpportunity.deleteMany({ where: { portalId: SOURCE_IDS.ca } });
        await prisma.$disconnect();
      }
    }
  });

  test.each([
    ['grants_gov', GRANT_ID], ['sam_gov', SOURCE_IDS.sam], ['agency_forecast', SOURCE_IDS.forecast], ['dibbs', SOURCE_IDS.dibbs], ['sbir_sttr', SOURCE_IDS.topic], ['ca_portal', SOURCE_IDS.ca],
  ])('GET detail returns exact source and opaque identity for %s', async (source, id) => {
    const response = await request(app.getHttpServer()).get(`/api/intelligence/opportunities/v2/detail/${source}/${id}`).expect(200);
    expect(response.body.source).toBe(source); expect(response.body.sourceRecordId).toBe(id); expect(response.body.opportunity.source).toBe(source); expect(response.body.opportunity.sourceRecordId).toBe(id); expect(response.body.opportunity.decoration).toBeTruthy();
  });

  test('SBIR topic and solicitation preserve distinct provenance models', async () => {
    const topic = await request(app.getHttpServer()).get(`/api/intelligence/opportunities/v2/detail/sbir_sttr/${SOURCE_IDS.topic}`).expect(200);
    const solicitation = await request(app.getHttpServer()).get(`/api/intelligence/opportunities/v2/detail/sbir_sttr/${SOURCE_IDS.solicitation}`).expect(200);
    expect(topic.body.opportunity.provenance.sourceModel).toBe('tango_sbir_topic'); expect(solicitation.body.opportunity.provenance.sourceModel).toBe('tango_sbir_solicitation');
  });

  test('matched mode requires a visible client and keeps capabilities while all suppresses match display', async () => {
    const all = await request(app.getHttpServer()).get(`/api/intelligence/opportunities/v2/detail/grants_gov/${GRANT_ID}`).query({ mode: 'all', clientId: CLIENT_ID }).expect(200);
    const matched = await request(app.getHttpServer()).get(`/api/intelligence/opportunities/v2/detail/grants_gov/${GRANT_ID}`).query({ mode: 'matched', clientId: CLIENT_ID }).expect(200);
    expect(all.body.opportunity.capabilities.pursue.allowed).toBe(matched.body.opportunity.capabilities.pursue.allowed); expect(all.body.opportunity.capabilities.save).toEqual(matched.body.opportunity.capabilities.save); expect(all.body.opportunity.relevanceScore).toBeNull(); expect(all.body.opportunity.matchedSignals).toEqual([]); expect(matched.body.opportunity.source).toBe('grants_gov'); expect(matched.body.opportunity.sourceReference.sourceRecordId).toBe(GRANT_ID);
    await request(app.getHttpServer()).get(`/api/intelligence/opportunities/v2/detail/grants_gov/${GRANT_ID}`).query({ mode: 'matched' }).expect(400);
    await request(app.getHttpServer()).get(`/api/intelligence/opportunities/v2/detail/grants_gov/${GRANT_ID}`).query({ clientId: RESTRICTED_CLIENT_ID }).expect(404);
    await request(app.getHttpServer()).get(`/api/intelligence/opportunities/v2/detail/grants_gov/${GRANT_ID}`).query({ clientId: OTHER_CLIENT_ID }).expect(404);
    await prisma.client.update({ where: { id: CLIENT_ID }, data: { memoryWall: true } });
    await prisma.clientMemoryAccess.deleteMany({ where: { tenantId: TENANT_ID, clientId: CLIENT_ID, userId: USER_ID } });
    await request(app.getHttpServer()).get(`/api/intelligence/opportunities/v2/detail/grants_gov/${GRANT_ID}`).query({ clientId: CLIENT_ID }).expect(404);
    await prisma.clientMemoryAccess.create({ data: { id: crypto.randomUUID(), tenantId: TENANT_ID, clientId: CLIENT_ID, userId: USER_ID, grantedBy: ADMIN_ID } });
    await prisma.client.update({ where: { id: CLIENT_ID }, data: { memoryWall: false } });
  });

  test('real flags and role fail closed', async () => {
    currentRole = 'client_portal_user';
    await request(app.getHttpServer()).get(`/api/intelligence/opportunities/v2/detail/grants_gov/${GRANT_ID}`).expect(403);
    currentRole = 'standard_user';
    await prisma.$executeRaw`UPDATE intel_feature_flag SET enabled = false WHERE id = ${FLAG_ID + '-forecasts'}`;
    await request(app.getHttpServer()).get(`/api/intelligence/opportunities/v2/detail/agency_forecast/${SOURCE_IDS.forecast}`).expect(404);
    await prisma.$executeRaw`UPDATE intel_feature_flag SET enabled = true WHERE id = ${FLAG_ID + '-forecasts'}`;
    await prisma.$executeRaw`UPDATE intel_feature_flag SET enabled = false WHERE id = ${FLAG_ID + '-sbir'}`;
    await request(app.getHttpServer()).get(`/api/intelligence/opportunities/v2/detail/sbir_sttr/${SOURCE_IDS.topic}`).expect(404);
    await prisma.$executeRaw`UPDATE intel_feature_flag SET enabled = true WHERE id = ${FLAG_ID + '-sbir'}`;
    await prisma.$executeRaw`UPDATE intel_feature_flag SET enabled = false WHERE id = ${FLAG_ID}`;
    await request(app.getHttpServer()).get(`/api/intelligence/opportunities/v2/detail/grants_gov/${GRANT_ID}`).expect(404);
    await prisma.$executeRaw`UPDATE intel_feature_flag SET enabled = true WHERE id = ${FLAG_ID}`;
  });

  test('detail keeps document and notice-history readers behind independent flags', async () => {
    const url = `/api/intelligence/opportunities/v2/detail/sam_gov/${SOURCE_IDS.sam}`;
    const requirementsReader = jest.spyOn(OpportunityRequirementService.prototype, 'getRequirements');
    const timelineReader = jest.spyOn(OpportunityTimelineService.prototype, 'getTimeline');
    try {
      requirementsReader.mockClear();
      timelineReader.mockClear();
      await request(app.getHttpServer()).get(url).expect(200);
      expect(requirementsReader).toHaveBeenCalledTimes(1);
      expect(timelineReader).toHaveBeenCalledTimes(1);
      requirementsReader.mockClear();
      timelineReader.mockClear();
      await prisma.$executeRaw`UPDATE intel_feature_flag SET enabled = false WHERE id = ${FLAG_ID + '-documents'}`;
      const documentsOff = await request(app.getHttpServer()).get(url).expect(200);
      expect(requirementsReader).not.toHaveBeenCalled();
      expect(timelineReader).toHaveBeenCalledTimes(1);
      expect(documentsOff.body.opportunity.responseInstructions.details).toEqual([]);
      await prisma.$executeRaw`UPDATE intel_feature_flag SET enabled = true WHERE id = ${FLAG_ID + '-documents'}`;
      await prisma.$executeRaw`UPDATE intel_feature_flag SET enabled = false WHERE id = ${FLAG_ID + '-history'}`;
      requirementsReader.mockClear();
      timelineReader.mockClear();
      const historyOff = await request(app.getHttpServer()).get(url).expect(200);
      expect(requirementsReader).toHaveBeenCalledTimes(1);
      expect(timelineReader).not.toHaveBeenCalled();
      expect(historyOff.body.opportunity.activity).toEqual([]);
      expect(historyOff.body.opportunity.activityCoverage).toMatch(/disabled/i);
    } finally {
      await prisma.$executeRaw`UPDATE intel_feature_flag SET enabled = true WHERE id IN (${FLAG_ID + '-documents'}, ${FLAG_ID + '-history'})`;
      requirementsReader.mockRestore();
      timelineReader.mockRestore();
    }
  });

  test('source-click resolves authoritative destinations and records exact audit payload', async () => {
    for (const input of [
      { source: 'grants_gov', sourceRecordId: GRANT_ID, destinationKind: 'source_page' },
      { source: 'grants_gov', sourceRecordId: GRANT_ID, destinationKind: 'document:funding_announcement' },
      { source: 'agency_forecast', sourceRecordId: SOURCE_IDS.forecast, destinationKind: 'contact_email:primary' },
      { source: 'ca_portal', sourceRecordId: SOURCE_IDS.ca, destinationKind: 'application:1' },
    ]) {
      const response = await request(app.getHttpServer()).post('/api/intelligence/opportunities/v2/source-clicks').send({ ...input, clientId: null }).expect(201);
      expect(response.body.audited).toBe(true); expect(response.body.authoritativeUrl).toMatch(/^(https:|mailto:)/);
    }
    const audits = await prisma.auditLog.findMany({ where: { tenantId: TENANT_ID, action: 'funding_opportunity.source_click' }, orderBy: { occurredAt: 'asc' } });
    expect(audits).toHaveLength(4);
    expect(audits.every((audit) => audit.tenantId === TENANT_ID && audit.actorUserId === USER_ID && audit.actorRole === 'standard_user' && audit.entityType === 'funding_opportunity_v2')).toBe(true);
    expect(audits.map((audit) => ({ destinationKind: (audit.after as { destinationKind: string }).destinationKind, authoritativeUrl: (audit.after as { authoritativeUrl: string }).authoritativeUrl }))).toEqual([
      { destinationKind: 'source_page', authoritativeUrl: `https://www.grants.gov/${GRANT_ID}` },
      { destinationKind: 'document:funding_announcement', authoritativeUrl: `https://www.justice.gov/${namespace}.pdf` },
      { destinationKind: 'contact_email:primary', authoritativeUrl: `mailto:${namespace}-forecast@example.test` },
      { destinationKind: 'application:1', authoritativeUrl: `https://ca.example/${namespace}/apply` },
    ]);
    expect(audits[0]).toMatchObject({ tenantId: TENANT_ID, actorUserId: USER_ID, actorRole: 'standard_user', entityType: 'funding_opportunity_v2', entityId: `grants_gov:${GRANT_ID}` });
    expect(audits.every((audit) => audit.occurredAt instanceof Date)).toBe(true);
  });

  test('source-click rejects unavailable identity, destination, client, and caller URL', async () => {
    const before = await prisma.auditLog.count({ where: { tenantId: TENANT_ID, action: 'funding_opportunity.source_click' } });
    await request(app.getHttpServer()).post('/api/intelligence/opportunities/v2/source-clicks').send({ source: 'grants_gov', sourceRecordId: `${namespace}-missing`, clientId: null, destinationKind: 'source_page' }).expect(404);
    await request(app.getHttpServer()).post('/api/intelligence/opportunities/v2/source-clicks').send({ source: 'grants_gov', sourceRecordId: GRANT_ID, clientId: RESTRICTED_CLIENT_ID, destinationKind: 'source_page' }).expect(404);
    await request(app.getHttpServer()).post('/api/intelligence/opportunities/v2/source-clicks').send({ source: 'grants_gov', sourceRecordId: GRANT_ID, clientId: null, destinationKind: 'document:nope' }).expect(400);
    await request(app.getHttpServer()).post('/api/intelligence/opportunities/v2/source-clicks').send({ source: 'grants_gov', sourceRecordId: GRANT_ID, clientId: null, destinationKind: 'source_page', url: 'https://caller.example.invalid' }).expect(400);
    await request(app.getHttpServer()).get(`/api/intelligence/opportunities/v2/detail/sbir_sttr/${SOURCE_IDS.ambiguous}`).expect(400);
    await request(app.getHttpServer()).get(`/api/intelligence/opportunities/v2/detail/grants_gov/${GRANT_ID}`).query({ clientId: 'not-a-uuid' }).expect(404);
    await request(app.getHttpServer()).get(`/api/intelligence/opportunities/v2/detail/not-a-source/${GRANT_ID}`).expect(404);
    expect(await prisma.auditLog.count({ where: { tenantId: TENANT_ID, action: 'funding_opportunity.source_click' } })).toBe(before);
  });

  test('audit transaction failure does not return a success URL or create an audit row', async () => {
    const before = await prisma.auditLog.count({ where: { tenantId: TENANT_ID, action: 'funding_opportunity.source_click' } });
    const originalWithTenant = prisma.withTenant.bind(prisma);
    const failingAuditCreate = jest.fn().mockRejectedValue(new Error('deliberate audit transaction failure'));
    const failing = jest.spyOn(prisma, 'withTenant').mockImplementationOnce(async (tenant, fn) => originalWithTenant(tenant, async (tx) => {
      const auditLog = tx.auditLog;
      Object.defineProperty(tx, 'auditLog', { value: { ...auditLog, create: failingAuditCreate } });
      return fn(tx);
    }));
    const response = await request(app.getHttpServer()).post('/api/intelligence/opportunities/v2/source-clicks').send({ source: 'grants_gov', sourceRecordId: GRANT_ID, clientId: null, destinationKind: 'source_page' });
    failing.mockRestore();
    expect(response.status).toBe(500); expect(response.body.authoritativeUrl).toBeUndefined(); expect(failingAuditCreate).toHaveBeenCalledTimes(1);
    expect(await prisma.auditLog.count({ where: { tenantId: TENANT_ID, action: 'funding_opportunity.source_click' } })).toBe(before);
  });

  test('detail date facts preserve independent raw fields and timezone precision', async () => {
    const response = await request(app.getHttpServer()).get(`/api/intelligence/opportunities/v2/detail/grants_gov/${GRANT_ID}`).expect(200);
    expect(response.body.opportunity.dates.posted.sourceRaw).toBe('Sep 1, 2026 12:00:00 AM EDT');
    expect(response.body.opportunity.dates.responseDeadline.sourceRaw).toBe('Dec 31, 2026 12:00:00 AM EDT');
    expect(response.body.opportunity.dates.responseDeadline.timezone).toBe('EDT');
    expect(response.body.opportunity.dates.posted.sourceRaw).not.toBe(response.body.opportunity.dates.responseDeadline.sourceRaw);
    expect(response.body.opportunity.dates.forecast.anticipatedAwardDate.unavailableReason).toMatch(/not a forecast/i);
  });

  test('forecast provenance does not relabel ingestion as publication', async () => {
    const response = await request(app.getHttpServer()).get(`/api/intelligence/opportunities/v2/detail/agency_forecast/${SOURCE_IDS.forecast}`).expect(200);
    expect(response.body.opportunity.sourceFacts.ingestedAt).toBeTruthy();
    expect(response.body.opportunity.sourceFacts.firstSyncedAt).toBeTruthy();
    expect(response.body.opportunity.sourceFacts.publishedAt).toBeUndefined();
  });

  test('nullable Grants opportunity number preserves cached synopsis facts', async () => {
    const response = await request(app.getHttpServer()).get(`/api/intelligence/opportunities/v2/detail/grants_gov/${NULL_NUMBER_GRANT_ID}`).expect(200);
    expect(response.body.opportunity.displayReference).toBeNull();
    expect(response.body.opportunity.contacts).toEqual([expect.objectContaining({ name: 'Nullable number contact' })]);
    expect(response.body.opportunity.destinations).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'document:funding_announcement', authoritativeUrl: `https://www.justice.gov/${namespace}-nullable.pdf` })]));
    expect(response.body.opportunity.dates.responseDeadline.sourceRaw).toBe('Dec 31, 2026 12:00:00 AM EDT');
  });

  test('similar search failure is distinguishable from a successful detail read', async () => {
    const search = jest.spyOn(searchService, 'search').mockRejectedValueOnce(new Error('deliberate similar search failure'));
    const response = await request(app.getHttpServer()).get(`/api/intelligence/opportunities/v2/detail/grants_gov/${NULL_NUMBER_GRANT_ID}`).expect(200);
    search.mockRestore();
    expect(response.body.opportunity.similarOpportunities).toEqual([]);
    expect(response.body.opportunity.similarOpportunitiesUnavailableReason).toBe('Similar opportunities are temporarily unavailable.');
    const successful = await request(app.getHttpServer()).get(`/api/intelligence/opportunities/v2/detail/grants_gov/${NULL_NUMBER_GRANT_ID}`).expect(200);
    expect(successful.body.opportunity.similarOpportunitiesUnavailableReason).toBeNull();
  });

  test('SAM raw date forms retain date-only and explicit-offset precision', async () => {
    const response = await request(app.getHttpServer()).get(`/api/intelligence/opportunities/v2/detail/sam_gov/${SOURCE_IDS.sam}`).expect(200);
    expect(response.body.opportunity.dates.posted).toMatchObject({ value: '2026-09-01', precision: 'date', sourceRaw: '2026-09-01' });
    expect(response.body.opportunity.dates.responseDeadline).toMatchObject({ sourceRaw: '2026-12-31T23:59:00-05:00', precision: 'raw' });
    expect(Date.parse(response.body.opportunity.dates.responseDeadline.value)).toBe(Date.parse('2027-01-01T04:59:00.000Z'));
    expect(response.body.opportunity.dates.responseDeadline.timezone).toBe('-05:00');
    expect(response.body.opportunity.displayReference).toEqual({ label: 'Solicitation number', value: `${namespace}-SAM`, sourceField: 'SAM solicitationNumber' });
  });

  test('raw response deadline remains source-backed with EDT precision when normalized close is absent', async () => {
    const response = await request(app.getHttpServer()).get(`/api/intelligence/opportunities/v2/detail/grants_gov/${NULL_NUMBER_GRANT_ID}`).expect(200);
    expect(response.body.opportunity.dates.responseDeadline).toMatchObject({ sourceRaw: 'Dec 31, 2026 12:00:00 AM EDT', precision: 'raw', unavailableReason: null });
    expect(response.body.opportunity.dates.responseDeadline.timezone).toBe('EDT');
    expect(Number.isFinite(Date.parse(response.body.opportunity.dates.responseDeadline.value))).toBe(true);
  });

});
