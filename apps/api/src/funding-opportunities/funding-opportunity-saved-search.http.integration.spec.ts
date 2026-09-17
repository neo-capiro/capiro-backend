import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { Test, type TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { configureApiHttpApp } from '../bootstrap/configure-api-http-app.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RolesGuard } from '../auth/roles.guard.js';
import {
  FUNDING_OPPORTUNITY_V2_CATALOG_ADAPTERS,
  FUNDING_OPPORTUNITY_V2_CLIENT_PROFILE_READER,
  FundingOpportunityV2SearchService,
  createOpportunityClientProfileReader,
  createPrismaOpportunityCatalogAdapters,
} from './funding-opportunity-v2-search.service.js';
import { FundingOpportunityV2DecoratorService } from './funding-opportunity-v2-decorator.service.js';
import { FundingOpportunitySavedSearchController } from './funding-opportunity-saved-search.controller.js';
import {
  FundingOpportunitySavedSearchService,
  SAVED_SEARCH_APPLY_EXECUTOR,
} from './funding-opportunity-saved-search.service.js';
import { FundingOpportunitiesFlagGuard } from './funding-opportunities-flag.guard.js';

const TEST_DATABASE_URL = process.env.FUNDING_OPPORTUNITIES_TEST_DATABASE_URL;
const parsedUrl = TEST_DATABASE_URL ? new URL(TEST_DATABASE_URL) : null;
const isolated = Boolean(
  parsedUrl?.protocol === 'postgresql:' && parsedUrl.hostname === '127.0.0.1'
    && parsedUrl.port === '5486' && parsedUrl.pathname === '/fo_v2_saved'
    && parsedUrl.searchParams.get('schema') === 'public' && parsedUrl.username === 'fo_test'
    && parsedUrl.password.length > 0,
);
const describeDb = isolated ? describe : describe.skip;

jest.setTimeout(120_000);

describeDb('saved-search actual HTTP wiring and canonical SQL apply', () => {
  const namespace = `saved-http-${crypto.randomUUID()}`;
  const tenantId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const readerId = crypto.randomUUID();
  const adminId = crypto.randomUUID();
  const otherTenantId = crypto.randomUUID();
  const clientAId = crypto.randomUUID();
  const clientBId = crypto.randomUUID();
  const archivedClientId = crypto.randomUUID();
  const grantId = `${namespace}-grant`;
  const flagId = crypto.randomUUID();
  let app: INestApplication;
  let module: TestingModule;
  let prisma: PrismaService;
  let currentContext = { tenantId, tenantSlug: namespace, userId, clerkUserId: namespace, role: 'standard_user' };

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    module = await Test.createTestingModule({
      controllers: [FundingOpportunitySavedSearchController],
      providers: [
        PrismaService,
        FundingOpportunitySavedSearchService,
        FundingOpportunityV2SearchService,
        FundingOpportunityV2DecoratorService,
        RolesGuard,
        FundingOpportunitiesFlagGuard,
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
        {
          provide: SAVED_SEARCH_APPLY_EXECUTOR,
          inject: [FundingOpportunityV2SearchService],
          useFactory: (search: FundingOpportunityV2SearchService) =>
            (ctx: { tenantId: string; userId: string }, criteria: Parameters<FundingOpportunityV2SearchService['search']>[1]) =>
              search.search(ctx, criteria),
        },
      ],
    }).compile();
    app = module.createNestApplication();
    configureApiHttpApp(app, {
      includeClerkRawBody: false,
      includeRecallRawBody: false,
      includeTangoRawBody: false,
      includeEmailSignatureLargeBody: false,
      defaultJsonLimit: '1mb',
    });
    // This is the only injected boundary: an authenticated request context.
    // RolesGuard, the feature guard, Prisma, saved persistence, and search are production implementations.
    app.use((req: Request & { tenantContext?: unknown }, _res: Response, next: NextFunction) => {
      if (req.headers.authorization !== 'Bearer saved-http-auth') {
        next(new Error('test authentication boundary rejected request'));
        return;
      }
      req.tenantContext = currentContext;
      next();
    });
    await app.init();
    prisma = app.get(PrismaService);

    await prisma.tenant.create({ data: { id: tenantId, slug: namespace, name: namespace } });
    await prisma.user.createMany({ data: [
      { id: userId, clerkUserId: namespace, email: `${namespace}@example.invalid` },
      { id: readerId, clerkUserId: `${namespace}-reader`, email: `${namespace}-reader@example.invalid` },
      { id: adminId, clerkUserId: `${namespace}-admin`, email: `${namespace}-admin@example.invalid` },
    ] });
    await prisma.tenant.create({ data: { id: otherTenantId, slug: `${namespace}-other`, name: `${namespace}-other` } });
    await prisma.client.createMany({ data: [
      { id: clientAId, tenantId, name: `${namespace} client A`, memoryWall: true },
      { id: clientBId, tenantId, name: `${namespace} client B`, memoryWall: true },
      { id: archivedClientId, tenantId, name: `${namespace} archived client`, memoryWall: false },
    ] });
    await prisma.clientMemoryAccess.create({ data: { tenantId, clientId: clientAId, userId, grantedBy: adminId } });
    await prisma.$executeRaw`INSERT INTO intel_feature_flag(id, feature, tenant_id, enabled)
      VALUES (${flagId}, 'funding_opportunities', ${tenantId}, true)`;
    await prisma.federalGrant.create({
      data: {
        id: grantId,
        title: `${namespace} canonical SQL fixture`,
        agency: 'Saved HTTP fixture agency',
        fundingInstrument: 'Grant',
        eligibility: ['Small businesses'],
        status: 'posted',
        openDate: new Date('2026-09-01T00:00:00.000Z'),
        closeDate: new Date('2099-12-31T00:00:00.000Z'),
        description: `${namespace} canonical SQL fixture description`,
      },
    });
  });

  afterAll(async () => {
    try {
      if (!prisma) return;
      await prisma.withSystem(async (tx) => {
        await tx.savedOpportunitySearch.deleteMany({ where: { tenantId } });
        await tx.$executeRaw`DELETE FROM intel_feature_flag WHERE id = ${flagId} AND tenant_id = ${tenantId}`;
        await tx.federalGrant.deleteMany({ where: { id: grantId } });
        await tx.clientMemoryAccess.deleteMany({ where: { tenantId } });
        await tx.client.deleteMany({ where: { id: { in: [clientAId, clientBId, archivedClientId] }, tenantId } });
        await tx.tenant.deleteMany({ where: { id: { in: [tenantId, otherTenantId] } } });
        await tx.user.deleteMany({ where: { id: { in: [userId, readerId, adminId] } } });
      });
    } finally {
      if (app) await app.close();
    }
  });

  const http = {
    get: (path: string) => request(app.getHttpServer()).get(path).set('Authorization', 'Bearer saved-http-auth'),
    post: (path: string) => request(app.getHttpServer()).post(path).set('Authorization', 'Bearer saved-http-auth'),
    patch: (path: string) => request(app.getHttpServer()).patch(path).set('Authorization', 'Bearer saved-http-auth'),
    delete: (path: string) => request(app.getHttpServer()).delete(path).set('Authorization', 'Bearer saved-http-auth'),
  };

  test('creates, reads, lists, and applies a persisted search through real HTTP and canonical SQL', async () => {
    const criteria = {
      schemaVersion: 2,
      mode: 'all',
      clientId: null,
      query: namespace,
      sources: ['grants_gov'],
      types: ['grant'],
      lifecycle: ['active'],
      agencies: ['Saved HTTP fixture agency'],
      sectors: [], naicsCodes: [], pscCodes: [], setAsideCodes: [], eligibility: [], posted: [],
      geography: [], applicantTypes: [], funding: [], costShare: [], methods: [], disbursement: [],
      grantPrerequisites: [], codes: [], deadlineWindow: 'any', deadlineFrom: null, deadlineTo: null,
      sort: 'title', direction: 'asc', page: 1, pageSize: 7,
    };
    const created = await http.post('/api/intelligence/opportunities/v2/searches').send({
      name: '  Canonical SQL saved search  ', visibility: 'private', clientId: null, criteria,
    }).expect(201);
    expect(created.body.name).toBe('Canonical SQL saved search');
    expect(created.body.criteria).toMatchObject({ query: namespace, mode: 'all', clientId: null, sort: 'title', pageSize: 7 });

    const id = created.body.id as string;
    await http.get(`/api/intelligence/opportunities/v2/searches/${id}`).expect(200).then((response) => {
      expect(response.body.criteria).toMatchObject({ query: namespace, sources: ['grants_gov'], mode: 'all' });
    });
    await http.get('/api/intelligence/opportunities/v2/searches').expect(200).then((response) => {
      expect(response.body.searches.map((row: { id: string }) => row.id)).toContain(id);
    });

    const applied = await http.post(`/api/intelligence/opportunities/v2/searches/${id}/apply`).expect(201);
    expect(applied.body.criteria).toMatchObject({ query: namespace, mode: 'all', clientId: null, sort: 'title', pageSize: 7 });
    expect(applied.body.total).toBe(1);
    expect(applied.body.opportunities).toEqual([expect.objectContaining({ source: 'grants_gov', sourceRecordId: grantId })]);
    expect(applied.body.search.lastRunResultCount).toBe(1);

    const stored = await prisma.savedOpportunitySearch.findUniqueOrThrow({ where: { id } });
    expect(stored.criteriaJson).toMatchObject({ query: namespace, mode: 'all', clientId: null, sort: 'title', pageSize: 7 });
    expect(stored.lastRunResultCount).toBe(1);
  });

  test('enforces HTTP validation, visibility, client grants, mutation roles, archive round trips, and tenant scope', async () => {
    const baseCriteria = {
      mode: 'all', clientId: null, query: namespace, sources: ['grants_gov'], types: ['grant'], lifecycle: ['active'],
      agencies: [], sectors: [], naicsCodes: [], pscCodes: [], setAsideCodes: [], eligibility: [], posted: [], geography: [],
      applicantTypes: [], funding: [], costShare: [], methods: [], disbursement: [], grantPrerequisites: [], codes: [],
      deadlineWindow: 'any', deadlineFrom: null, deadlineTo: null, sort: 'deadline', direction: 'asc', page: 1, pageSize: 20,
    };
    const clientSearch = await http.post('/api/intelligence/opportunities/v2/searches').send({
      name: 'Client A search', visibility: 'tenant', clientId: clientAId,
      criteria: { ...baseCriteria, clientId: clientAId },
    }).expect(201);
    const tenantSearch = await http.post('/api/intelligence/opportunities/v2/searches').send({
      name: 'Tenant-wide search', visibility: 'tenant', clientId: null, criteria: baseCriteria,
    }).expect(201);
    const privateSearch = await http.post('/api/intelligence/opportunities/v2/searches').send({
      name: 'Private search', visibility: 'private', clientId: null, criteria: baseCriteria,
    }).expect(201);
    const validDuplicate = await http.post(`/api/intelligence/opportunities/v2/searches/${tenantSearch.body.id}/duplicate`).send({ name: 'Valid copy' }).expect(201);
    expect(validDuplicate.body.criteria).toMatchObject({ query: namespace, mode: 'all' });
    await http.get(`/api/intelligence/opportunities/v2/searches?clientId=${clientAId}`).expect(200).then((res) => {
      expect(res.body.searches.map((row: { id: string }) => row.id)).toEqual(expect.arrayContaining([
        clientSearch.body.id, tenantSearch.body.id, privateSearch.body.id,
      ]));
    });
    await http.get(`/api/intelligence/opportunities/v2/searches?clientId=${clientBId}`).expect(404);
    await http.get('/api/intelligence/opportunities/v2/searches/not-a-uuid').expect(400);
    await http.post('/api/intelligence/opportunities/v2/searches').send({
      name: 'bad', visibility: 'tenant', criteria: baseCriteria, unexpected: true,
    }).expect(400);
    await http.post('/api/intelligence/opportunities/v2/searches').send({
      name: '   ', visibility: 'tenant', criteria: baseCriteria,
    }).expect(400);
    await http.post('/api/intelligence/opportunities/v2/searches').send({
      name: 'scope mismatch', visibility: 'tenant', clientId: clientAId, criteria: baseCriteria,
    }).expect(400);

    currentContext = { tenantId, tenantSlug: namespace, userId: readerId, clerkUserId: `${namespace}-reader`, role: 'standard_user' };
    await http.get(`/api/intelligence/opportunities/v2/searches/${privateSearch.body.id}`).expect(404);
    await http.patch(`/api/intelligence/opportunities/v2/searches/${tenantSearch.body.id}`).send({ name: 'reader rename' }).expect(404);
    await http.post(`/api/intelligence/opportunities/v2/searches/${tenantSearch.body.id}/duplicate`).send({}).expect(404);
    await http.delete(`/api/intelligence/opportunities/v2/searches/${tenantSearch.body.id}`).expect(404);

    currentContext = { tenantId, tenantSlug: namespace, userId, clerkUserId: namespace, role: 'standard_user' };
    await prisma.clientMemoryAccess.deleteMany({ where: { tenantId, clientId: clientAId, userId } });
    const archivedSearch = await http.post('/api/intelligence/opportunities/v2/searches').send({
      name: 'Archived client search', visibility: 'private', clientId: archivedClientId,
      criteria: { ...baseCriteria, clientId: archivedClientId },
    }).expect(201);
    await prisma.client.update({ where: { id: archivedClientId }, data: { status: 'archived' } });
    const archivedClientRead = await http.get(`/api/intelligence/opportunities/v2/searches/${archivedSearch.body.id}`).expect(200);
    expect(archivedClientRead.body.clientId).toBe(archivedClientId);
    expect(archivedClientRead.body.archivedAt).toEqual(expect.any(String));
    await http.post(`/api/intelligence/opportunities/v2/searches/${archivedSearch.body.id}/apply`).expect(400);

    await prisma.savedOpportunitySearch.update({
      where: { id: tenantSearch.body.id },
      data: { criteriaJson: { ...baseCriteria, retiredFilter: 'unsafe' }, migrationWarnings: [] },
    });
    await http.get(`/api/intelligence/opportunities/v2/searches/${tenantSearch.body.id}`).expect(200).then((res) => {
      expect(res.body.warnings).toEqual(expect.arrayContaining([{ key: 'retiredFilter', reason: 'unsupported' }]));
    });
    await http.patch(`/api/intelligence/opportunities/v2/searches/${tenantSearch.body.id}`).send({ name: 'Renamed unsafe-preserving' }).expect(200);
    await http.post(`/api/intelligence/opportunities/v2/searches/${tenantSearch.body.id}/apply`).expect(400);
    const duplicateUnsafe = await http.post(`/api/intelligence/opportunities/v2/searches/${tenantSearch.body.id}/duplicate`).send({ name: 'Unsafe copy' }).expect(201);
    expect(duplicateUnsafe.body.warnings).toEqual(expect.arrayContaining([{ key: 'retiredFilter', reason: 'unsupported' }]));
    expect(duplicateUnsafe.body.originalCriteriaJson).toMatchObject({ retiredFilter: 'unsafe' });
    await http.post(`/api/intelligence/opportunities/v2/searches/${duplicateUnsafe.body.id}/apply`).expect(400);

    await prisma.savedOpportunitySearch.update({
      where: { id: tenantSearch.body.id },
      data: {
        criteriaJson: { ...baseCriteria, schemaVersion: 99, futureFilter: 'future-only' },
        schemaVersion: 2,
        originalCriteriaJson: { ...baseCriteria, schemaVersion: 99, futureFilter: 'future-only' },
        migrationWarnings: [],
      },
    });
    const futureRead = await http.get(`/api/intelligence/opportunities/v2/searches/${tenantSearch.body.id}`).expect(200);
    expect(futureRead.body.schemaVersion).toBe(2);
    expect(futureRead.body.warnings).toEqual(expect.arrayContaining([
      { key: 'schemaVersion', reason: 'unsupported' },
      { key: 'futureFilter', reason: 'unsupported' },
    ]));
    await http.patch(`/api/intelligence/opportunities/v2/searches/${tenantSearch.body.id}`).send({ name: 'Future schema metadata rename' }).expect(200);
    await http.post(`/api/intelligence/opportunities/v2/searches/${tenantSearch.body.id}/apply`).expect(400);
    const futureDuplicate = await http.post(`/api/intelligence/opportunities/v2/searches/${tenantSearch.body.id}/duplicate`).send({ name: 'Future schema copy' }).expect(201);
    expect(futureDuplicate.body.originalCriteriaJson).toMatchObject({ schemaVersion: 99, futureFilter: 'future-only' });
    await http.post(`/api/intelligence/opportunities/v2/searches/${futureDuplicate.body.id}/apply`).expect(400);

    const scalarFuture = await http.post('/api/intelligence/opportunities/v2/searches').send({
      name: 'Scalar future row', visibility: 'tenant', clientId: null, criteria: baseCriteria,
    }).expect(201);
    await prisma.savedOpportunitySearch.update({
      where: { id: scalarFuture.body.id },
      data: { schemaVersion: 99, criteriaJson: baseCriteria, migrationWarnings: [] },
    });
    const scalarRead = await http.get(`/api/intelligence/opportunities/v2/searches/${scalarFuture.body.id}`).expect(200);
    expect(scalarRead.body).toMatchObject({
      schemaVersion: 2,
      warnings: [{ key: 'schemaVersion', reason: 'unsupported' }],
      originalCriteriaJson: baseCriteria,
    });
    await http.patch(`/api/intelligence/opportunities/v2/searches/${scalarFuture.body.id}`).send({ name: 'Renamed scalar future' }).expect(200);
    const scalarRenamed = await http.get(`/api/intelligence/opportunities/v2/searches/${scalarFuture.body.id}`).expect(200);
    expect(scalarRenamed.body.warnings).toEqual([{ key: 'schemaVersion', reason: 'unsupported' }]);
    expect((await prisma.savedOpportunitySearch.findUniqueOrThrow({ where: { id: scalarFuture.body.id } })).schemaVersion).toBe(99);
    await http.post(`/api/intelligence/opportunities/v2/searches/${scalarFuture.body.id}/apply`).expect(400);
    const scalarDuplicate = await http.post(`/api/intelligence/opportunities/v2/searches/${scalarFuture.body.id}/duplicate`).send({}).expect(201);
    expect(scalarDuplicate.body).toMatchObject({
      warnings: [{ key: 'schemaVersion', reason: 'unsupported' }],
      originalCriteriaJson: baseCriteria,
    });
    await http.post(`/api/intelligence/opportunities/v2/searches/${scalarDuplicate.body.id}/apply`).expect(400);

    const compatibleV1 = await http.post('/api/intelligence/opportunities/v2/searches').send({
      name: 'Compatible v1 row', visibility: 'tenant', clientId: null, criteria: { ...baseCriteria, schemaVersion: 1 },
    }).expect(201);
    await prisma.savedOpportunitySearch.update({
      where: { id: compatibleV1.body.id },
      data: { schemaVersion: 1, criteriaJson: { ...baseCriteria, schemaVersion: 1 }, migrationWarnings: [] },
    });
    const v1Read = await http.get(`/api/intelligence/opportunities/v2/searches/${compatibleV1.body.id}`).expect(200);
    expect(v1Read.body.schemaVersion).toBe(2);
    const v1Applied = await http.post(`/api/intelligence/opportunities/v2/searches/${compatibleV1.body.id}/apply`).expect(201);
    expect(v1Applied.body.search.lastRunResultCount).toBe(1);

    await http.get(`/api/intelligence/opportunities/v2/searches/${clientSearch.body.id}`).expect(404);
    await http.post(`/api/intelligence/opportunities/v2/searches/${clientSearch.body.id}/apply`).expect(404);
    await http.post(`/api/intelligence/opportunities/v2/searches/${clientSearch.body.id}/duplicate`).send({}).expect(404);
    await http.get(`/api/intelligence/opportunities/v2/searches?clientId=${clientAId}`).expect(404);


    const archived = await http.patch(`/api/intelligence/opportunities/v2/searches/${tenantSearch.body.id}`).send({ archived: true }).expect(200);
    expect(archived.body.archivedAt).toEqual(expect.any(String));
    await http.post(`/api/intelligence/opportunities/v2/searches/${tenantSearch.body.id}/apply`).expect(400);
    const restored = await http.patch(`/api/intelligence/opportunities/v2/searches/${tenantSearch.body.id}`).send({ archived: false }).expect(200);
    expect(restored.body.archivedAt).toBeNull();
    await http.delete(`/api/intelligence/opportunities/v2/searches/${privateSearch.body.id}`).expect(200);

    currentContext = { tenantId: otherTenantId, tenantSlug: `${namespace}-other`, userId, clerkUserId: namespace, role: 'standard_user' };
    await http.get(`/api/intelligence/opportunities/v2/searches/${tenantSearch.body.id}`).expect(404);
    currentContext = { tenantId, tenantSlug: namespace, userId: adminId, clerkUserId: `${namespace}-admin`, role: 'user_admin' };
    await http.delete(`/api/intelligence/opportunities/v2/searches/${tenantSearch.body.id}`).expect(200);
    currentContext = { tenantId, tenantSlug: namespace, userId, clerkUserId: namespace, role: 'client_portal_user' };
    await http.get('/api/intelligence/opportunities/v2/searches').expect(403);
    await prisma.$executeRaw`DELETE FROM intel_feature_flag WHERE id = ${flagId} AND tenant_id = ${tenantId}`;
    currentContext = { tenantId, tenantSlug: namespace, userId, clerkUserId: namespace, role: 'standard_user' };
    await http.get('/api/intelligence/opportunities/v2/searches').expect(404);
  });
});

export {};
