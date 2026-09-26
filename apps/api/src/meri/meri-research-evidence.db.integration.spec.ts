import { createHash } from 'node:crypto';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { TenantContext } from '@capiro/shared';
import { wrapToolResultForPrompt } from '@capiro/meriv2-core';
import { RolesGuard } from '../auth/roles.guard.js';
import type { AppConfig } from '../config/config.schema.js';
import { ClientKbService } from '../embeddings/client-kb.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { MeriApprovalService } from './meri-approval.service.js';
import { MeriClaimWriterService } from './meri-claim-writer.js';
import { MeriComplianceAuditService } from './meri-compliance-audit.service.js';
import { MeriController } from './meri.controller.js';
import { MeriFirmSkillsService } from './meri-firm-skills.service.js';
import { MeriMcpOAuthService } from './meri-mcp-oauth.service.js';
import { MeriMcpService } from './meri-mcp.service.js';
import { getResearchEvidence } from './meri-research-evidence.helpers.js';
import { captureResearchHandoff, researchHandoffPrompt, type MeriResearchHandoff } from './meri-research-handoff.js';
import { MeriResearchService } from './meri-research.service.js';
import { MeriService } from './meri.service.js';
import { MeriToolsService } from './meri-tools.service.js';
import { ToolServiceSecretGuard } from './tool-service-secret.guard.js';

/** Opt in only to this disposable, migrated PostgreSQL container. */
const databaseUrl = process.env.MERI_B6_RESEARCH_TEST_DATABASE_URL;
const parsed = databaseUrl ? new URL(databaseUrl) : null;
const isolated = Boolean(
  parsed?.protocol === 'postgresql:' && parsed.hostname === '127.0.0.1' &&
  parsed.port === '55446' && parsed.pathname === '/capiro' &&
  parsed.searchParams.get('schema') === 'public' &&
  parsed.username === 'b6_research' && parsed.password === 'b6_research_local_only',
);
const describeDb = isolated ? describe : describe.skip;

describeDb('B6 research evidence on migrated disposable PostgreSQL', () => {
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const foreignTenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab';
  const userId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const otherUserId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbc';
  const clientId = '22222222-2222-4222-8222-222222222222';
  const otherClientId = '33333333-3333-4333-8333-333333333333';
  const conversationId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const otherConversationId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccd';
  const messageId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const otherMessageId = 'dddddddd-dddd-4ddd-8ddd-ddddddddddde';
  const sessionId = '11111111-1111-4111-8111-111111111111';
  const otherSessionId = '11111111-1111-4111-8111-111111111112';
  const attachmentIds = [
    '44444444-4444-4444-8444-000000000000',
    '44444444-4444-4444-8444-000000000001',
    '44444444-4444-4444-8444-000000000002',
  ];
  const sentence = 'Appropriated amount: $17 million.';
  const scanText = 'Partial scan only.';
  const imageBytes = Buffer.from('verified-research-image');
  const serviceSecret = 'b6-research-local-service-secret';
  const ctx = { tenantId, userId, role: 'standard_user' } as TenantContext;
  let db: PrismaService;
  let app: INestApplication;
  let handoff: MeriResearchHandoff;

  const attachmentRows = () => [
    { id: attachmentIds[0]!, tenantId, userId, messageId, filename: 'appropriation.txt',
      kind: 'text', status: 'parsed', mediaType: 'text/plain', byteSize: sentence.length,
      textContent: sentence, reason: null, data: null },
    { id: attachmentIds[1]!, tenantId, userId, messageId: null, filename: 'scan.pdf',
      kind: 'pdf', status: 'truncated', mediaType: 'application/pdf', byteSize: 250,
      textContent: scanText, reason: 'Scanned page could not be fully extracted', data: null },
    { id: attachmentIds[2]!, tenantId, userId, messageId: null, filename: 'image.png',
      kind: 'image', status: 'image_ready', mediaType: 'image/png', byteSize: imageBytes.length,
      textContent: null, reason: null, data: imageBytes },
  ];

  const read = (input: Record<string, unknown> = {}, scope = ctx) =>
    getResearchEvidence(scope, { sessionId, clientId, ...input }, db);

  beforeAll(async () => {
    db = new PrismaService({ datasources: { db: { url: databaseUrl } } });
    await db.$connect();
    const migrationRows = await db.$queryRawUnsafe<Array<{ applied: bigint; unfinished: bigint }>>(
      'SELECT count(*) FILTER (WHERE finished_at IS NOT NULL) AS applied, count(*) FILTER (WHERE finished_at IS NULL AND rolled_back_at IS NULL) AS unfinished FROM _prisma_migrations',
    );
    expect(Number(migrationRows[0]?.applied)).toBeGreaterThanOrEqual(420);
    expect(Number(migrationRows[0]?.unfinished)).toBe(0);

    await db.tenant.createMany({ skipDuplicates: true, data: [
      { id: tenantId, slug: 'b6-research-disposable', name: 'B6 Research Disposable', status: 'active' },
      { id: foreignTenantId, slug: 'b6-research-foreign', name: 'B6 Research Foreign', status: 'active' },
    ] });
    await db.user.createMany({ skipDuplicates: true, data: [
      { id: userId, clerkUserId: 'b6-research-user', email: 'b6-research@example.invalid' },
      { id: otherUserId, clerkUserId: 'b6-research-other', email: 'b6-research-other@example.invalid' },
    ] });
    await db.client.createMany({ skipDuplicates: true, data: [
      { id: clientId, tenantId, name: 'B6 Walled Client', status: 'active', memoryWall: true },
      { id: otherClientId, tenantId, name: 'B6 Other Client', status: 'active', memoryWall: false },
    ] });
    await db.clientMemoryAccess.upsert({
      where: { tenantId_clientId_userId: { tenantId, clientId, userId } },
      create: { tenantId, clientId, userId, grantedBy: userId }, update: {},
    });
    await db.clioConversation.createMany({ skipDuplicates: true, data: [
      { id: conversationId, tenantId, userId, clientId, title: 'B6 research origin' },
      { id: otherConversationId, tenantId, userId, clientId, title: 'B6 other conversation' },
    ] });
    await db.clioMessage.createMany({ skipDuplicates: true, data: [
      { id: messageId, tenantId, userId, clientId, conversationId, role: 'user',
        body: 'What amount does my attached appropriation page state?' },
      { id: otherMessageId, tenantId, userId, clientId, conversationId, role: 'user',
        body: 'A later message without the attachment.' },
    ] });
    await db.clioConversation.update({ where: { id: conversationId }, data: { clientId, archivedAt: null } });
    await db.clioMessage.update({ where: { id: messageId }, data: { conversationId, clientId } });
    for (const row of attachmentRows()) {
      await db.clioAttachment.upsert({ where: { id: row.id }, create: row, update: row });
    }
    handoff = await db.withTenantUser(tenantId, userId, (tx) => captureResearchHandoff(tx, ctx, {
      topic: 'Report the appropriation amount and disclose incomplete pages.',
      conversationId, clientId, attachmentIds,
    }));
    expect(handoff.attachments.map((attachment) => attachment.id).sort()).toEqual([...attachmentIds].sort());
    await db.clioResearchSession.createMany({ skipDuplicates: true, data: [
      { id: sessionId, tenantId, userId, clientId, title: 'B6 research lease',
        topic: 'Report the appropriation amount', status: 'researching', metadata: { handoff } as never },
      { id: otherSessionId, tenantId, userId, clientId, title: 'B6 other lease',
        topic: 'Another lease', status: 'researching', metadata: { handoff } as never },
    ] });

    const tools = Object.create(MeriToolsService.prototype) as MeriToolsService;
    (tools as unknown as { prisma: PrismaService }).prisma = db;
    const moduleRef = await Test.createTestingModule({
      controllers: [MeriController],
      providers: [
        RolesGuard,
        ToolServiceSecretGuard,
        { provide: ConfigService, useValue: { get: (key: keyof AppConfig) =>
          key === 'NODE_ENV' ? 'production' :
          key === 'INTERNAL_SERVICE_SECRET' ? serviceSecret :
          key === 'MERI_TOOLS_REQUIRE_SERVICE_SECRET' ? true : undefined } },
        { provide: MeriToolsService, useValue: tools },
        { provide: MeriService, useValue: {} },
        { provide: MeriResearchService, useValue: {} },
        { provide: ClientKbService, useValue: {} },
        { provide: MeriMcpService, useValue: {} },
        { provide: MeriMcpOAuthService, useValue: {} },
        { provide: MeriFirmSkillsService, useValue: {} },
        { provide: MeriApprovalService, useValue: {} },
        { provide: MeriComplianceAuditService, useValue: {} },
        { provide: MeriClaimWriterService, useValue: {} },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    // Test-only authenticated context injection. This does not emulate JWT
    // verification or change the application's tenant middleware.
    app.use((req: { headers: Record<string, unknown>; tenantContext?: TenantContext }, _res: unknown, next: () => void) => {
      req.tenantContext = {
        ...ctx,
        tenantId: typeof req.headers['x-b6-test-tenant'] === 'string' ? req.headers['x-b6-test-tenant'] : tenantId,
        userId: typeof req.headers['x-b6-test-user'] === 'string' ? req.headers['x-b6-test-user'] : userId,
      };
      next();
    });
    await app.init();
  }, 120_000);

  beforeEach(async () => {
    await db.clientMemoryAccess.upsert({
      where: { tenantId_clientId_userId: { tenantId, clientId, userId } },
      create: { tenantId, clientId, userId, grantedBy: userId }, update: {},
    });
    await db.clioConversation.update({ where: { id: conversationId },
      data: { clientId, archivedAt: null } });
    await db.clioMessage.update({ where: { id: messageId }, data: { conversationId, clientId } });
    for (const row of attachmentRows()) {
      await db.clioAttachment.upsert({ where: { id: row.id }, create: row, update: row });
    }
    await db.clioResearchSession.update({ where: { id: sessionId },
      data: { clientId, metadata: { handoff } as never } });
    await db.clioResearchSession.update({ where: { id: otherSessionId },
      data: { clientId, metadata: { handoff } as never } });
  });

  afterAll(async () => {
    await app?.close();
    await db?.$disconnect();
  }, 120_000);

  test('server-captured research handoff pages through original IDs and separates pagination from content completeness', async () => {
    const prompt = researchHandoffPrompt(handoff, sessionId, { includeAttachmentContent: false });
    expect(prompt).toContain(sessionId);
    expect(prompt).toContain(attachmentIds[0]!);
    expect(prompt).not.toContain(sentence);
    expect(prompt).not.toContain(scanText);

    const pages = [];
    let cursor: string | null = null;
    do {
      const page = await read({ limit: 1, ...(cursor ? { cursor } : {}) });
      pages.push(page);
      cursor = page.coverage.nextCursor;
    } while (cursor);
    expect(pages.map((page) => page.records[0]?.recordId)).toEqual(attachmentIds);
    expect(pages[0]!.records[0]).toMatchObject({
      recordId: attachmentIds[0], payload: { textContent: sentence },
      provenance: { originalAttachmentId: attachmentIds[0], sessionId },
    });
    expect(pages[0]!.coverage).toMatchObject({ total: 3, returned: 1, paginationComplete: false, contentComplete: false, complete: false });
    expect(pages[2]!.coverage).toMatchObject({ total: 3, returned: 1, paginationComplete: true, contentComplete: false, complete: false });
    expect(pages[2]!.records[0]?.payload).toMatchObject({ kind: 'image', contentSha256: createHash('sha256').update(imageBytes).digest('hex'), textContent: null });
    expect(JSON.stringify(pages)).not.toContain(imageBytes.toString('base64'));

    const selected = await read({ attachmentIds: [attachmentIds[0]] });
    expect(selected.coverage).toMatchObject({ total: 1, complete: true });
    expect(selected.records.map((record) => record.recordId)).toEqual([attachmentIds[0]]);
    const modelVisibleSelected = wrapToolResultForPrompt('get_research_evidence', selected, 12_000);
    expect(modelVisibleSelected).toContain(sentence);
    if (process.env.MERI_B6_RESEARCH_ORACLE === '1') {
      console.info('B6_RESEARCH_DB_ORACLE=' + JSON.stringify({
        selectedRuntime: 'migrated-DB handoff/evidence helper',
        researchSession: { sessionId, clientId, conversationId },
        inputPrompt: prompt,
        toolArguments: [
          { sessionId, clientId, limit: 1 },
          ...pages.slice(0, -1).map((page) => ({ sessionId, clientId, limit: 1, cursor: page.coverage.nextCursor })),
          { sessionId, clientId, attachmentIds: [attachmentIds[0]] },
        ],
        rawPages: pages, rawSelected: selected, modelVisibleSelected,
        expectedFinalClaim: `${sentence} [S:get_research_evidence:${attachmentIds[0]}]; the scanned page remains incomplete.`,
        displayedAnswer: null,
      }));
    }
  });

  test('denies wrong tenant/user/client, revoked wall, archived or changed origin, and outside selection', async () => {
    await expect(read({}, { ...ctx, tenantId: foreignTenantId })).rejects.toBeInstanceOf(NotFoundException);
    await expect(read({}, { ...ctx, userId: otherUserId })).rejects.toBeInstanceOf(NotFoundException);
    await expect(read({ clientId: otherClientId })).rejects.toBeInstanceOf(NotFoundException);
    await expect(read({ attachmentIds: ['55555555-5555-4555-8555-555555555555'] })).rejects.toBeInstanceOf(NotFoundException);
    await db.clientMemoryAccess.deleteMany({ where: { tenantId, clientId, userId } });
    await expect(read()).rejects.toBeInstanceOf(NotFoundException);
    await db.clientMemoryAccess.create({ data: { tenantId, clientId, userId, grantedBy: userId } });
    await db.clioConversation.update({ where: { id: conversationId }, data: { archivedAt: new Date() } });
    await expect(read()).rejects.toBeInstanceOf(NotFoundException);
    await db.clioConversation.update({ where: { id: conversationId }, data: { archivedAt: null, clientId: otherClientId } });
    await expect(read()).rejects.toBeInstanceOf(NotFoundException);
  });

  test('denies a deleted, reparented, or changed-source attachment', async () => {
    await db.clioAttachment.delete({ where: { id: attachmentIds[0] } });
    await expect(read({ attachmentIds: [attachmentIds[0]] })).rejects.toBeInstanceOf(NotFoundException);
    await db.clioAttachment.create({ data: attachmentRows()[0]! });
    await db.clioAttachment.update({ where: { id: attachmentIds[0] }, data: { messageId: otherMessageId } });
    await expect(read({ attachmentIds: [attachmentIds[0]] })).rejects.toThrow('source message');
    await db.clioAttachment.update({ where: { id: attachmentIds[0] }, data: { messageId } });
    await db.clioMessage.update({ where: { id: messageId }, data: { conversationId: otherConversationId } });
    await expect(read({ attachmentIds: [attachmentIds[0]] })).rejects.toBeInstanceOf(NotFoundException);
  });

  test('denies changed image bytes/status and cross-session or cross-selection cursor reuse', async () => {
    const first = await read({ limit: 1 });
    await expect(read({ limit: 1, cursor: first.coverage.nextCursor, sessionId: otherSessionId }))
      .rejects.toBeInstanceOf(BadRequestException);
    await expect(read({ limit: 1, cursor: first.coverage.nextCursor, attachmentIds: [attachmentIds[0]] }))
      .rejects.toBeInstanceOf(BadRequestException);
    await db.clioAttachment.update({ where: { id: attachmentIds[2] }, data: { data: Buffer.from('changed-image') } });
    await expect(read({ attachmentIds: [attachmentIds[2]] })).rejects.toThrow('changed since the snapshot');
    await db.clioAttachment.update({ where: { id: attachmentIds[2] }, data: { data: imageBytes, status: 'scanned' } });
    await expect(read({ attachmentIds: [attachmentIds[2]] })).rejects.toThrow('changed since the snapshot');
  });

  test('retains coverage and cursor in a fully truncated model projection and rejects a changed snapshot cursor', async () => {
    await db.clioAttachment.update({ where: { id: attachmentIds[0] }, data: { textContent: 'x'.repeat(30_000) } });
    const changedHandoff = await db.withTenantUser(tenantId, userId, (tx) => captureResearchHandoff(tx, ctx, {
      topic: 'Report the appropriation amount and disclose incomplete pages.',
      conversationId, clientId, attachmentIds,
    }));
    await db.clioResearchSession.update({ where: { id: sessionId }, data: { metadata: { handoff: changedHandoff } as never } });
    const first = await read({ limit: 1 });
    const visible = wrapToolResultForPrompt('get_research_evidence', first, 12_000);
    expect(visible).toContain(first.coverage.nextCursor);
    expect(visible).toContain('"complete": false');
    expect(visible).toContain('[truncated tool result]');
    await db.clioResearchSession.update({ where: { id: sessionId }, data: { metadata: { handoff } as never } });
    await expect(read({ limit: 1, cursor: first.coverage.nextCursor })).rejects.toThrow('cursor no longer matches');
  });

  test('reports unavailable handoff as incomplete rather than an empty success', async () => {
    await db.clioResearchSession.update({ where: { id: sessionId }, data: { metadata: {} } });
    const result = await read();
    expect(result.coverage).toMatchObject({ status: 'unavailable', total: null, complete: false, reason: 'research_handoff_unavailable' });
    expect(result.records).toEqual([]);
  });

  test('guarded HTTP tool route returns scoped evidence and denies missing identity or revoked access', async () => {
    const endpoint = '/api/clio/tools/get_research_evidence';
    const selected = { sessionId, clientId, attachmentIds: [attachmentIds[0]] };
    const missing = await request(app.getHttpServer()).post(endpoint).send(selected).expect(403);
    const wrong = await request(app.getHttpServer()).post(endpoint)
      .set('x-internal-service-secret', 'wrong').send(selected).expect(403);
    expect(JSON.stringify([missing.body, wrong.body])).not.toContain(sentence);

    const permitted = await request(app.getHttpServer()).post(endpoint)
      .set('x-internal-service-secret', serviceSecret).send(selected).expect(201);
    expect(permitted.body).toMatchObject({
      tool: 'get_research_evidence', sessionId,
      coverage: { total: 1, returned: 1, complete: true },
      records: [{ recordId: attachmentIds[0], payload: { textContent: sentence } }],
    });
    const first = await request(app.getHttpServer()).post(endpoint)
      .set('x-internal-service-secret', serviceSecret).send({ sessionId, clientId, limit: 1 }).expect(201);
    expect(first.body.coverage).toMatchObject({ total: 3, paginationComplete: false, contentComplete: false });
    expect(first.body.coverage.nextCursor).toEqual(expect.any(String));

    for (const headers of [
      { 'x-b6-test-tenant': foreignTenantId },
      { 'x-b6-test-user': otherUserId },
    ]) {
      const denied = await request(app.getHttpServer()).post(endpoint)
        .set('x-internal-service-secret', serviceSecret).set(headers).send(selected).expect(404);
      expect(JSON.stringify(denied.body)).not.toContain(sentence);
    }
    const wrongClient = await request(app.getHttpServer()).post(endpoint)
      .set('x-internal-service-secret', serviceSecret)
      .send({ ...selected, clientId: otherClientId }).expect(404);
    expect(JSON.stringify(wrongClient.body)).not.toContain(sentence);
    await db.clientMemoryAccess.deleteMany({ where: { tenantId, clientId, userId } });
    const revoked = await request(app.getHttpServer()).post(endpoint)
      .set('x-internal-service-secret', serviceSecret).send(selected).expect(404);
    expect(JSON.stringify(revoked.body)).not.toContain(sentence);
  });
});
