import crypto from 'node:crypto';
import request from 'supertest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { Reflector } from '@nestjs/core';
import { configureApiHttpApp } from '../bootstrap/configure-api-http-app.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { FundingOpportunitiesFlagGuard } from './funding-opportunities-flag.guard.js';
import {
  createOpportunityClientProfileReader,
  createPrismaOpportunityCatalogAdapters,
  FUNDING_OPPORTUNITY_V2_CATALOG_ADAPTERS,
  FUNDING_OPPORTUNITY_V2_CLIENT_PROFILE_READER,
  FundingOpportunityV2SearchService,
} from './funding-opportunity-v2-search.service.js';
import { FundingOpportunityV2SearchController } from './funding-opportunity-v2-search.controller.js';
import { FundingOpportunityV2DecoratorService } from './funding-opportunity-v2-decorator.service.js';

const DATABASE_URL = process.env.FUNDING_OPPORTUNITIES_TEST_DATABASE_URL;
const parsed = DATABASE_URL ? new URL(DATABASE_URL) : null;
const isolated = Boolean(
  DATABASE_URL && process.env.DATABASE_URL === DATABASE_URL
    && parsed?.protocol === 'postgresql:' && parsed.hostname === '127.0.0.1'
    && parsed.port === '5486' && parsed.pathname === '/fo_v2_search'
    && parsed.searchParams.get('schema') === 'public' && parsed.username === 'fo_test'
    && parsed.password.length > 0,
);
const describeDb = isolated ? describe : describe.skip;

jest.setTimeout(120_000);

describeDb('Funding Opportunity v2 search HTTP and canonical profile (isolated PostgreSQL)', () => {
  const namespace = `search-http-${process.pid}-${Date.now()}-${crypto.randomUUID()}`;
  const tenantId = crypto.randomUUID();
  const otherTenantId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const otherUserId = crypto.randomUUID();
  const visibleClientId = crypto.randomUUID();
  const fallbackClientId = crypto.randomUUID();
  const fuzzyClientId = crypto.randomUUID();
  const sectorClientId = crypto.randomUUID();
  const capabilityOnlyClientId = crypto.randomUUID();
  const walledClientId = crypto.randomUUID();
  const otherClientId = crypto.randomUUID();
  const contractorId = crypto.randomUUID();
  const flagId = `${namespace}-flag`;
  const forecastFlagId = `${namespace}-forecast-flag`;
  const sbirFlagId = `${namespace}-sbir-flag`;
  const samId = crypto.randomUUID();
  const fallbackSamId = crypto.randomUUID();
  const sectorSamId = crypto.randomUUID();
  const capabilityOnlySamId = crypto.randomUUID();
  const topicId = `${namespace}-topic`;
  const solicitationId = `${namespace}-solicitation`;
  const grantId = `${namespace}-grant`;
  const forecastId = `${namespace}-forecast`;
  const dibbsId = `${namespace}-dibbs`;
  const caId = `${namespace}-ca`;

  let app: INestApplication;
  let prisma: PrismaService;
  let role: TenantContext['role'] = 'standard_user';

  const context = (): TenantContext => ({
    tenantId, tenantSlug: namespace, userId, clerkUserId: `${namespace}-clerk`, role,
  });

  beforeAll(async () => {
    prisma = new PrismaService({ datasources: { db: { url: DATABASE_URL } } });
    await prisma.$connect();
    await prisma.tenant.createMany({ data: [
      { id: tenantId, slug: `${namespace}-tenant`, name: namespace, status: 'active' },
      { id: otherTenantId, slug: `${namespace}-other`, name: `${namespace}-other`, status: 'active' },
    ] });
    await prisma.user.createMany({ data: [
      { id: userId, clerkUserId: `${namespace}-user`, email: `${namespace}@example.invalid` },
      { id: otherUserId, clerkUserId: `${namespace}-other-user`, email: `${namespace}-other@example.invalid` },
    ] });
    await prisma.tenantMembership.createMany({ data: [
      { id: crypto.randomUUID(), tenantId, userId, role: 'standard_user', status: 'active', joinedAt: new Date() },
      { id: crypto.randomUUID(), tenantId: otherTenantId, userId: otherUserId, role: 'standard_user', status: 'active', joinedAt: new Date() },
    ] });
    await prisma.client.createMany({ data: [
      { id: visibleClientId, tenantId, name: `${namespace} visible`, status: 'active', profileStatus: 'ACTIVE', uei: 'ABC123456789', naicsCodes: ['541715'], pscCodes: ['AR15'], applicantTypes: [] },
      { id: fallbackClientId, tenantId, name: `${namespace} fallback`, status: 'active', profileStatus: 'ACTIVE', naicsCodes: [], pscCodes: [], applicantTypes: [] },
      { id: fuzzyClientId, tenantId, name: `${namespace} fuzzy`, status: 'active', profileStatus: 'ACTIVE', naicsCodes: [], pscCodes: [], applicantTypes: [] },
      { id: sectorClientId, tenantId, name: `${namespace} sector`, status: 'active', profileStatus: 'ACTIVE', sectorTag: 'defense', naicsCodes: [], pscCodes: [], applicantTypes: [] },
      { id: capabilityOnlyClientId, tenantId, name: `${namespace} capability only`, status: 'active', profileStatus: 'ACTIVE', naicsCodes: [], pscCodes: [], applicantTypes: [] },
      { id: walledClientId, tenantId, name: `${namespace} walled`, status: 'active', profileStatus: 'ACTIVE', memoryWall: true },
      { id: otherClientId, tenantId: otherTenantId, name: `${namespace} other`, status: 'active', profileStatus: 'ACTIVE' },
    ] });
    await prisma.clientCapability.createMany({ data: [
      { id: crypto.randomUUID(), tenantId, clientId: visibleClientId, name: 'Quantum propulsion', keywords: ['quantum propulsion'], peNumbers: [], tags: [] },
      { id: crypto.randomUUID(), tenantId, clientId: capabilityOnlyClientId, name: 'Orbital refueling', keywords: ['orbital refueling'], peNumbers: [], tags: [] },
    ] });
    await prisma.clientMemoryAccess.createMany({ data: [
      { id: crypto.randomUUID(), tenantId, clientId: visibleClientId, userId, grantedBy: userId },
      { id: crypto.randomUUID(), tenantId, clientId: capabilityOnlyClientId, userId, grantedBy: userId },
      { id: crypto.randomUUID(), tenantId, clientId: walledClientId, userId, grantedBy: userId },
    ] });
    await prisma.clientIntelMapping.createMany({ data: [
      { id: crypto.randomUUID(), tenantId, clientId: fallbackClientId, source: 'contracting', externalId: `${namespace}-name-id`, externalName: `${namespace} fallback llc`, confidence: 1, confirmed: true, matchBasis: 'exact_legal_name', matchTier: 2, relationshipType: 'self', rollUpAwards: true, reviewStatus: 'confirmed' },
      { id: crypto.randomUUID(), tenantId, clientId: fuzzyClientId, source: 'contracting', externalId: `${namespace}-fuzzy-id`, externalName: `${namespace} fuzzy llc`, confidence: 0.8, confirmed: true, matchBasis: 'fuzzy_name', matchTier: 4, relationshipType: 'self', rollUpAwards: true, reviewStatus: 'confirmed' },
    ] });
    await prisma.federalContractor.create({ data: { id: contractorId, name: `${namespace} contractor`, uei: 'ABC123456789' } });
    await prisma.clientIntelMapping.create({ data: { id: crypto.randomUUID(), tenantId, clientId: visibleClientId, source: 'contracting', externalId: contractorId, externalName: `${namespace} contractor`, confidence: 1, confirmed: true, matchBasis: 'exact_uei', matchTier: 1, relationshipType: 'self', rollUpAwards: true, reviewStatus: 'confirmed' } });
    await prisma.federalAward.createMany({ data: [
      { id: crypto.randomUUID(), awardUniqueId: `${namespace}-award-exact`, awardingAgency: 'Department of Defense', awardingSubTier: 'DEPT OF THE NAVY', contractorName: `${namespace} contractor`, recipientUei: 'ABC123456789' },
      { id: crypto.randomUUID(), awardUniqueId: `${namespace}-award-fallback`, awardingAgency: 'Fallback Awarding Agency', awardingSubTier: 'Fallback Sub-Tier', contractorName: `${namespace} fallback llc` },
      { id: crypto.randomUUID(), awardUniqueId: `${namespace}-award-fuzzy`, awardingAgency: 'Fuzzy Awarding Agency', awardingSubTier: 'Fuzzy Sub-Tier', contractorName: `${namespace} fuzzy llc` },
    ] });
    await prisma.$executeRaw`INSERT INTO intel_feature_flag(id, feature, tenant_id, enabled) VALUES
      (${flagId}, 'funding_opportunities', ${tenantId}, true),
      (${forecastFlagId}, 'funding_opportunities_forecasts', ${tenantId}, true),
      (${sbirFlagId}, 'funding_opportunities_sbir', ${tenantId}, true)`;
    await prisma.federalGrant.create({ data: { id: grantId, title: `${namespace} grant`, agency: 'Department of Energy', fundingInstrument: 'Grant', status: 'posted', eligibility: [], closeDate: new Date('2099-12-31') } });
    await prisma.samOpportunity.createMany({ data: [
      { id: samId, noticeId: `${namespace}-sam`, title: `${namespace} quantum propulsion`, agency: 'Department of Defense', noticeType: 'Solicitation', active: true, naicsCode: '541715', pscCode: 'AR15', responseDeadline: new Date('2099-12-31') },
      { id: fallbackSamId, noticeId: `${namespace}-fallback-sam`, title: `${namespace} fallback`, agency: 'Fallback Sub-Tier', noticeType: 'Solicitation', active: true, responseDeadline: new Date('2099-12-31') },
      { id: sectorSamId, noticeId: `${namespace}-sector-sam`, title: `${namespace} defense mission`, agency: 'Defense Sector Agency', noticeType: 'Solicitation', active: true, responseDeadline: new Date('2099-12-31'), description: 'defense mission opportunity' },
      { id: capabilityOnlySamId, noticeId: `${namespace}-capability-only-sam`, title: `${namespace} orbital refueling`, agency: 'Capability Agency', noticeType: 'Solicitation', active: true, responseDeadline: new Date('2099-12-31'), description: 'orbital refueling opportunity' },
    ] });
    await prisma.tangoProcurementForecast.create({ data: { tangoForecastId: forecastId, title: `${namespace} forecast`, agency: 'Forecast Agency', anticipatedAwardDate: new Date('2099-12-31'), snapshot: {} } });
    await prisma.tangoDibbsSolicitation.create({ data: { tangoDibbsId: dibbsId, documentType: 'rfq', solicitation: `${namespace} dibbs`, nomenclature: 'test part', statusCode: 'OPEN', closesDate: new Date('2099-12-31'), isOpen: true } });
    await prisma.tangoSbirTopic.create({ data: { tangoSbirId: topicId, topicNumber: `${namespace}-topic-number`, title: `${namespace} topic`, agency: 'SBIR Agency', openDate: new Date('2026-01-01'), closeDate: new Date('2099-12-31'), solicitationStatus: 'Open' } });
    await prisma.tangoSbirSolicitation.create({ data: { tangoSbirId: solicitationId, solicitationNumber: `${namespace}-cycle`, title: `${namespace} solicitation`, program: 'SBIR', startDate: new Date('2026-01-01'), endDate: new Date('2099-12-31'), solicitationStatus: 'Open' } });
    await prisma.californiaGrantOpportunity.create({ data: { portalId: caId, title: `${namespace} California`, status: 'active', type: 'Grant', agencyDept: 'California Agency', applicationDeadlineCalendarDate: new Date('2099-12-31') } });

    const moduleRef = await Test.createTestingModule({
      controllers: [FundingOpportunityV2SearchController],
      providers: [
        Reflector, PrismaService, FundingOpportunityV2SearchService, FundingOpportunityV2DecoratorService,
        { provide: FUNDING_OPPORTUNITY_V2_CATALOG_ADAPTERS, inject: [PrismaService], useFactory: (db: PrismaService) => createPrismaOpportunityCatalogAdapters(db) },
        { provide: FUNDING_OPPORTUNITY_V2_CLIENT_PROFILE_READER, inject: [PrismaService], useFactory: (db: PrismaService) => createOpportunityClientProfileReader(db) },
        RolesGuard, FundingOpportunitiesFlagGuard,
      ],
    }).overrideProvider(PrismaService).useValue(prisma).compile();
    app = moduleRef.createNestApplication();
    configureApiHttpApp(app, { includeClerkRawBody: false, includeRecallRawBody: false, includeTangoRawBody: false, includeEmailSignatureLargeBody: false, defaultJsonLimit: '1mb' });
    app.use((req: { tenantContext?: TenantContext }, _res: unknown, next: () => void) => { req.tenantContext = context(); next(); });
    await app.init();
  });

  afterAll(async () => {
    try { if (app) await app.close(); } finally {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.allow_audit_purge','on',true)`;
        await tx.$executeRaw`DELETE FROM audit_logs WHERE tenant_id IN (${tenantId}::uuid, ${otherTenantId}::uuid)`;
        await tx.clientIntelMapping.deleteMany({ where: { tenantId } });
        await tx.clientMemoryAccess.deleteMany({ where: { tenantId } });
        await tx.clientCapability.deleteMany({ where: { tenantId } });
        await tx.client.deleteMany({ where: { id: { in: [visibleClientId, fallbackClientId, fuzzyClientId, sectorClientId, capabilityOnlyClientId, walledClientId, otherClientId] } } });
        await tx.tenantMembership.deleteMany({ where: { tenantId: { in: [tenantId, otherTenantId] } } });
        await tx.tenant.deleteMany({ where: { id: { in: [tenantId, otherTenantId] } } });
        await tx.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
        await tx.$executeRaw`DELETE FROM intel_feature_flag WHERE id IN (${flagId}, ${forecastFlagId}, ${sbirFlagId})`;
      });
      await prisma.federalAward.deleteMany({ where: { awardUniqueId: { startsWith: namespace } } });
      await prisma.federalContractor.deleteMany({ where: { id: contractorId } });
      await prisma.federalGrant.deleteMany({ where: { id: grantId } });
      await prisma.samOpportunity.deleteMany({ where: { id: { in: [samId, fallbackSamId, sectorSamId, capabilityOnlySamId] } } });
      await prisma.tangoProcurementForecast.deleteMany({ where: { tangoForecastId: forecastId } });
      await prisma.tangoDibbsSolicitation.deleteMany({ where: { tangoDibbsId: dibbsId } });
      await prisma.tangoSbirTopic.deleteMany({ where: { tangoSbirId: topicId } });
      await prisma.tangoSbirSolicitation.deleteMany({ where: { tangoSbirId: solicitationId } });
      await prisma.californiaGrantOpportunity.deleteMany({ where: { portalId: caId } });
      await prisma.$disconnect();
    }
  });

  test('exercises the actual controller across all six sources and production normalization', async () => {
    const response = await request(app.getHttpServer()).get('/api/intelligence/opportunities/v2/search').query({
      mode: 'all', lifecycle: 'active,forecast', sources: 'grants_gov,sam_gov,agency_forecast,dibbs,sbir_sttr,ca_portal', q: namespace, size: 20,
    }).expect(200);
    const sources = new Set(response.body.opportunities.map((row: { source: string }) => row.source));
    expect(sources).toEqual(new Set(['grants_gov', 'sam_gov', 'agency_forecast', 'dibbs', 'sbir_sttr', 'ca_portal']));
    expect(response.body.opportunities.filter((row: { source: string }) => row.source === 'sbir_sttr')).toHaveLength(2);
    expect(response.body.criteria.sources).toEqual(['grants_gov', 'sam_gov', 'agency_forecast', 'dibbs', 'sbir_sttr', 'ca_portal']);
    await request(app.getHttpServer()).get('/api/intelligence/opportunities/v2/search').query({ mode: 'matched' }).expect(400);
    await request(app.getHttpServer()).get('/api/intelligence/opportunities/v2/search').query({ unsupportedFilter: 'x' }).expect(400);
  });

  test('accepts a full client-profile import as 100 repeated keyword parameters', async () => {
    const params = new URLSearchParams({ mode: 'matched', clientId: visibleClientId });
    for (let i = 0; i < 99; i += 1) params.append('keyword', `not-present-${i}`);
    params.append('keyword', namespace);
    const response = await request(app.getHttpServer())
      .get(`/api/intelligence/opportunities/v2/search?${params.toString()}`)
      .expect(200);
    expect(response.body.criteria.keywordTerms).toHaveLength(100);
    expect(response.body.opportunities.some((row: { sourceRecordId: string }) => row.sourceRecordId === samId)).toBe(true);
  });

  test('uses visible-client access and keeps All capability while suppressing relevance', async () => {
    const all = await request(app.getHttpServer()).get('/api/intelligence/opportunities/v2/search').query({ mode: 'all', clientId: visibleClientId, sources: 'sam_gov', q: namespace }).expect(200);
    expect(all.body.opportunities.find((row: { sourceRecordId: string }) => row.sourceRecordId === samId)).toMatchObject({ relevanceScore: null, matchedSignals: [], clientCapability: { allowed: true } });
    const matched = await request(app.getHttpServer()).get('/api/intelligence/opportunities/v2/search').query({ mode: 'matched', clientId: visibleClientId, sources: 'sam_gov', q: namespace }).expect(200);
    const exact = matched.body.opportunities.find((row: { sourceRecordId: string }) => row.sourceRecordId === samId);
    expect(exact.relevanceScore).toBe(85);
    expect(exact.matchedSignals).toEqual(expect.arrayContaining([
      { signal: 'naicsExact', strength: 'strong', matchedOn: '541715' },
      { signal: 'pscExact', strength: 'strong', matchedOn: 'AR15' },
      { signal: 'capabilityKeyword', strength: 'moderate', matchedOn: 'Quantum propulsion' },
      { signal: 'agency', strength: 'moderate', matchedOn: 'Department of Defense' },
    ]));
    expect(exact.clientCapability.allowed).toBe(true);
    await request(app.getHttpServer()).get('/api/intelligence/opportunities/v2/search').query({ mode: 'all', clientId: walledClientId }).expect(200);
    await prisma.clientMemoryAccess.deleteMany({ where: { tenantId, clientId: walledClientId, userId } });
    await request(app.getHttpServer()).get('/api/intelligence/opportunities/v2/search').query({ mode: 'all', clientId: walledClientId }).expect(404);
    await request(app.getHttpServer()).get('/api/intelligence/opportunities/v2/search').query({ mode: 'all', clientId: otherClientId }).expect(404);
  });

  test('keeps capability matching independent from sector metadata', async () => {
    const capabilityOnly = await request(app.getHttpServer()).get('/api/intelligence/opportunities/v2/search').query({ mode: 'matched', clientId: capabilityOnlyClientId, sources: 'sam_gov', q: namespace }).expect(200);
    const capabilityOnlyRow = capabilityOnly.body.opportunities.find((row: { sourceRecordId: string }) => row.sourceRecordId === capabilityOnlySamId);
    expect(capabilityOnlyRow).toMatchObject({ relevanceScore: 30, matchedSignals: [{ signal: 'capabilityKeyword', strength: 'moderate', matchedOn: 'Orbital refueling' }] });
  });

  test('returns honest health/disabled states and canonical identity evidence', async () => {
    const health = await request(app.getHttpServer()).get('/api/intelligence/opportunities/v2/sources').expect(200);
    expect(health.body.sources).toHaveLength(6);
    await prisma.$executeRaw`UPDATE intel_feature_flag SET enabled = false WHERE id = ${flagId}`;
    try {
      await request(app.getHttpServer()).get('/api/intelligence/opportunities/v2/search').query({ mode: 'all' }).expect(404);
    } finally {
      await prisma.$executeRaw`UPDATE intel_feature_flag SET enabled = true WHERE id = ${flagId}`;
    }
    expect(health.body.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'grants_gov', state: 'never_synced', recordCount: 1, lastSyncedAt: null, latestAttemptAt: null, lastSuccessAt: null }),
      expect.objectContaining({ source: 'sam_gov', state: 'never_synced', recordCount: 4, lastSyncedAt: null, latestAttemptAt: null, lastSuccessAt: null }),
      expect.objectContaining({ source: 'agency_forecast', state: 'never_synced', recordCount: 1, lastSyncedAt: null, latestAttemptAt: null, lastSuccessAt: null }),
      expect.objectContaining({ source: 'dibbs', state: 'never_synced', recordCount: 1, lastSyncedAt: null, latestAttemptAt: null, lastSuccessAt: null }),
      expect.objectContaining({ source: 'sbir_sttr', state: 'never_synced', recordCount: 2, lastSyncedAt: null, latestAttemptAt: null, lastSuccessAt: null }),
      expect.objectContaining({ source: 'ca_portal', state: 'never_synced', recordCount: 1, lastSyncedAt: null, latestAttemptAt: null, lastSuccessAt: null }),
    ]));
    await prisma.$executeRaw`UPDATE intel_feature_flag SET enabled = false WHERE id = ${forecastFlagId}`;
    await prisma.$executeRaw`UPDATE intel_feature_flag SET enabled = false WHERE id = ${sbirFlagId}`;
    try {
      const disabled = await request(app.getHttpServer()).get('/api/intelligence/opportunities/v2/search').query({ mode: 'all', sources: 'agency_forecast', q: namespace }).expect(200);
      expect(disabled.body.opportunities).toEqual([]);
      expect(disabled.body.total).toBe(0);
      expect(disabled.body.freshness).toEqual([expect.objectContaining({ source: 'agency_forecast', state: 'not_enabled', recordCount: null, activeRecordCount: null })]);
      const sbirDisabled = await request(app.getHttpServer()).get('/api/intelligence/opportunities/v2/search').query({ mode: 'all', sources: 'sbir_sttr', q: namespace }).expect(200);
      expect(sbirDisabled.body.freshness).toEqual([expect.objectContaining({ source: 'sbir_sttr', state: 'not_enabled', recordCount: null, activeRecordCount: null })]);
      expect(sbirDisabled.body.total).toBe(0);
    } finally {
      await prisma.$executeRaw`UPDATE intel_feature_flag SET enabled = true WHERE id IN (${forecastFlagId}, ${sbirFlagId})`;
    }

    const exact = await request(app.getHttpServer()).get('/api/intelligence/opportunities/v2/search').query({ mode: 'matched', clientId: visibleClientId, sources: 'sam_gov', q: namespace }).expect(200);
    const exactRow = exact.body.opportunities.find((row: { sourceRecordId: string }) => row.sourceRecordId === samId);
    expect(exactRow.matchedSignals).toEqual(expect.arrayContaining([
      { signal: 'agency', strength: 'moderate', matchedOn: 'Department of Defense' },
    ]));
    const sector = await request(app.getHttpServer()).get('/api/intelligence/opportunities/v2/search').query({ mode: 'matched', clientId: sectorClientId, sources: 'sam_gov', q: namespace }).expect(200);
    const sectorRow = sector.body.opportunities.find((row: { sourceRecordId: string }) => row.sourceRecordId === sectorSamId);
    expect(sectorRow).toMatchObject({ relevanceScore: 10, matchedSignals: [{ signal: 'genericTopical', strength: 'weak', matchedOn: 'defense' }] });
    const fallback = await request(app.getHttpServer()).get('/api/intelligence/opportunities/v2/search').query({ mode: 'matched', clientId: fallbackClientId, sources: 'sam_gov', q: namespace }).expect(200);
    const fallbackRow = fallback.body.opportunities.find((row: { sourceRecordId: string }) => row.sourceRecordId === fallbackSamId);
    expect(fallbackRow.matchedSignals).toEqual(expect.arrayContaining([{ signal: 'agency', strength: 'moderate', matchedOn: 'Fallback Sub-Tier' }]));
    const fuzzy = await request(app.getHttpServer()).get('/api/intelligence/opportunities/v2/search').query({ mode: 'matched', clientId: fuzzyClientId, sources: 'sam_gov', q: namespace }).expect(200);
    const fuzzyRow = fuzzy.body.opportunities.find((row: { sourceRecordId: string }) => row.sourceRecordId === fallbackSamId);
    expect(fuzzyRow).toMatchObject({ sourceRecordId: fallbackSamId, relevanceScore: null, matchedSignals: [] });
    role = 'viewer' as TenantContext['role'];
    await request(app.getHttpServer()).get('/api/intelligence/opportunities/v2/search').query({ mode: 'all' }).expect(403);
    role = 'standard_user';
  });
});

export {};
