import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { ledgerToToolResultMap, type MeriContext, type ToolRegistry } from '@capiro/meriv2-core';
import { validateFormBCitations, type TenantContext } from '@capiro/shared';
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
import { captureResearchHandoff, researchHandoffPrompt } from './meri-research-handoff.js';
import { MeriResearchService } from './meri-research.service.js';
import { MeriService } from './meri.service.js';
import { MeriToolsService } from './meri-tools.service.js';
import { ToolServiceSecretGuard } from './tool-service-secret.guard.js';

/** Explicit opt-in to one disposable database; never run against a configured app DB. */
const databaseUrl = process.env.MERI_B6_INTEGRATED_TEST_DATABASE_URL;
const target = databaseUrl ? new URL(databaseUrl) : null;
const isolated = Boolean(
  target?.protocol === 'postgresql:' && target.hostname === '127.0.0.1' &&
  target.port === '55448' && target.pathname === '/capiro' &&
  target.searchParams.get('schema') === 'public' &&
  target.username === 'b6_integrated' && target.password === 'b6_integrated_local_only',
);
const describeDb = isolated ? describe : describe.skip;

function providerResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: 'synthetic-integrated-response', status: 'completed', output: [], outputText: '',
    functionCalls: [], model: 'synthetic-provider', usedTenantKey: false,
    incompleteReason: null,
    usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 },
    telemetry: {
      requestedModel: 'synthetic-provider', effectiveModel: 'synthetic-provider',
      requestedReasoningEffort: 'medium', effectiveReasoningEffort: 'medium',
      reasoningFallbackReasons: [], finishReason: 'completed', partial: false,
    },
    ...overrides,
  };
}

function namedToolCall(name: string, input: Record<string, unknown>, callId: string) {
  const call = {
    type: 'function_call' as const, call_id: callId,
    name, arguments: JSON.stringify(input),
  };
  return providerResponse({ output: [call], functionCalls: [call] });
}

function toolCall(input: Record<string, unknown>, callId: string) {
  return namedToolCall('get_research_evidence', input, callId);
}

function toolOutputs(input: unknown): Array<{ call_id: string; output: string }> {
  if (!Array.isArray(input)) return [];
  return input.filter((item): item is { call_id: string; output: string } =>
    typeof item === 'object' && item !== null &&
    (item as { type?: unknown }).type === 'function_call_output' &&
    typeof (item as { output?: unknown }).output === 'string');
}

function visiblePayload(output: string): unknown {
  return JSON.parse(output.slice(output.lastIndexOf('\n') + 1));
}

describeDb('B6 integrated migrated DB → guarded API tool → V3 answer', () => {
  const tenantId = '9aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const userId = '9bbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const clientId = '9ccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const conversationId = '9ddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const messageId = '9eeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const sessionId = '9fffffff-ffff-4fff-8fff-ffffffffffff';
  const textId = '94444444-4444-4444-8444-000000000000';
  const scanId = '94444444-4444-4444-8444-000000000001';
  const federalBillId = '119-hr-8800';
  const federalBillUrl = 'https://www.congress.gov/bill/119th-congress/house-bill/8800';
  const clippedBillId = '119-hr-8801';
  const clippedBillUrl = 'https://www.congress.gov/bill/119th-congress/house-bill/8801';
  const clippedBillTitle = 'Unread bill detail. '.repeat(2_000);
  const billEventDate = new Date('2026-06-03T00:00:00.000Z');
  const billUpdatedAt = new Date('2026-06-03T18:00:00.000Z');
  const billSyncedAt = new Date('2026-06-04T08:00:00.000Z');
  const sentence = 'Appropriated amount: $17 million.';
  const scanText = 'Partial scan only.';
  const serviceSecret = 'b6-integrated-local-service-secret';
  const tenantContext = { tenantId, userId, role: 'standard_user' } as TenantContext;
  const modelContext = {
    tenantId, userId, firmMemory: null, userVoice: null,
    clientSteering: null, clientRoster: [],
  } as unknown as MeriContext;
  const originalFetch = global.fetch;
  let db: PrismaService;
  let app: INestApplication;
  let handoffPrompt: string;

  beforeAll(async () => {
    db = new PrismaService({ datasources: { db: { url: databaseUrl } } });
    await db.$connect();
    const migrations = await db.$queryRawUnsafe<Array<{ applied: bigint; unfinished: bigint }>>(
      'SELECT count(*) FILTER (WHERE finished_at IS NOT NULL) AS applied, count(*) FILTER (WHERE finished_at IS NULL AND rolled_back_at IS NULL) AS unfinished FROM _prisma_migrations',
    );
    expect(Number(migrations[0]?.applied)).toBeGreaterThanOrEqual(420);
    expect(Number(migrations[0]?.unfinished)).toBe(0);

    await db.tenant.upsert({ where: { id: tenantId }, create: {
      id: tenantId, slug: 'b6-integrated-disposable', name: 'B6 Integrated Disposable', status: 'active',
    }, update: {} });
    await db.user.upsert({ where: { id: userId }, create: {
      id: userId, clerkUserId: 'b6-integrated-user', email: 'b6-integrated@example.invalid',
    }, update: {} });
    await db.client.upsert({ where: { id: clientId }, create: {
      id: clientId, tenantId, name: 'B6 Integrated Client', status: 'active', memoryWall: true,
    }, update: { memoryWall: true } });
    await db.clientMemoryAccess.upsert({
      where: { tenantId_clientId_userId: { tenantId, clientId, userId } },
      create: { tenantId, clientId, userId, grantedBy: userId }, update: {},
    });
    await db.clioConversation.upsert({ where: { id: conversationId }, create: {
      id: conversationId, tenantId, userId, clientId, title: 'B6 integrated origin',
    }, update: { clientId, archivedAt: null } });
    await db.clioMessage.upsert({ where: { id: messageId }, create: {
      id: messageId, tenantId, userId, clientId, conversationId, role: 'user',
      body: 'What amount does the attached appropriation page state?',
    }, update: { clientId, conversationId } });
    const attachmentRows = [
      { id: textId, tenantId, userId, messageId, filename: 'appropriation.txt',
        kind: 'text', status: 'parsed', mediaType: 'text/plain', byteSize: sentence.length,
        textContent: sentence },
      { id: scanId, tenantId, userId, messageId, filename: 'scan.pdf',
        kind: 'pdf', status: 'truncated', mediaType: 'application/pdf', byteSize: 250,
        textContent: scanText, reason: 'Scanned page could not be fully extracted' },
    ];
    for (const row of attachmentRows) {
      await db.clioAttachment.upsert({ where: { id: row.id }, create: row, update: row });
    }
    const handoff = await db.withTenantUser(tenantId, userId, (tx) =>
      captureResearchHandoff(tx, tenantContext, {
        topic: 'Report the appropriation amount and disclose incomplete pages.',
        conversationId, clientId, attachmentIds: [textId, scanId],
      }));
    expect(handoff.attachments.map((attachment) => attachment.id).sort()).toEqual([scanId, textId].sort());
    await db.clioResearchSession.upsert({ where: { id: sessionId }, create: {
      id: sessionId, tenantId, userId, clientId, title: 'B6 integrated lease',
      topic: 'Report the appropriation amount', status: 'researching',
      metadata: { handoff } as never,
    }, update: { clientId, metadata: { handoff } as never } });
    const lease = await db.clioResearchSession.findUniqueOrThrow({ where: { id: sessionId } });
    const persistedHandoff = (lease.metadata as { handoff?: typeof handoff })?.handoff;
    handoffPrompt = researchHandoffPrompt(persistedHandoff ?? null, sessionId,
      { includeAttachmentContent: false });
    expect(handoffPrompt).toContain(textId);
    expect(handoffPrompt).not.toContain(sentence);

    await db.congressBill.upsert({ where: { id: federalBillId }, create: {
      id: federalBillId, congress: 119, billType: 'hr', billNumber: '8800',
      title: 'B6 synthetic federal bill', status: 'committee',
      latestActionText: 'Referred to the House Armed Services Committee.',
      latestActionDate: billEventDate, url: federalBillUrl,
      updateDate: billUpdatedAt, lastSyncedAt: billSyncedAt,
    }, update: {} });
    await db.congressBill.upsert({ where: { id: clippedBillId }, create: {
      id: clippedBillId, congress: 119, billType: 'hr', billNumber: '8801',
      title: clippedBillTitle, status: 'committee',
      latestActionText: 'Referred to committee.',
      latestActionDate: billEventDate, url: clippedBillUrl,
      updateDate: billUpdatedAt, lastSyncedAt: billSyncedAt,
    }, update: { title: clippedBillTitle } });

    const tools = Object.create(MeriToolsService.prototype) as MeriToolsService;
    (tools as unknown as { prisma: PrismaService }).prisma = db;
    const moduleRef = await Test.createTestingModule({
      controllers: [MeriController],
      providers: [
        RolesGuard, ToolServiceSecretGuard,
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
    // Test-only identity injection. JWT verification is outside this fixture.
    app.use((req: { tenantContext?: TenantContext }, _res: unknown, next: () => void) => {
      req.tenantContext = tenantContext;
      next();
    });
    await app.init();
  }, 120_000);

  afterAll(async () => {
    global.fetch = originalFetch;
    await app?.close();
    await db?.$disconnect();
  }, 120_000);

  function buildV3Assistant(names: string[], invoke: jest.Mock, complete: jest.Mock) {
    const definitions = new Map(names.map((name) => [name, { name, readOnly: true }]));
    const registry = {
      list: () => names,
      get: (name: string) => definitions.get(name),
      executionMetadata: (name: string) => definitions.has(name)
        ? { name, readOnly: true, executionMode: 'read', externalEffect: 'none',
            reversible: true, riskTier: 'low', displayVerb: name }
        : undefined,
      invoke,
    } as unknown as ToolRegistry;
    // Dynamic require keeps the API package typecheck bounded to its own root.
    // Jest executes the actual V3 service, not a stand-in.
    const { MeriV3AssistantService } = require('../../../meriv2-orchestrator/src/meri/meriv3/meriv3-assistant.service.js');
    const prisma = { withTenant: jest.fn(async (_tenantId: string, callback: (tx: unknown) => unknown) =>
      callback({ aiUsageEvent: { create: jest.fn(async () => ({})) },
        meriAuditLedger: { create: jest.fn(async () => ({})) } })) };
    return new MeriV3AssistantService(
      { registry, llm: { completeJson: jest.fn(), completeWithSchema: jest.fn() } },
      { complete }, { create: jest.fn() }, prisma,
      { get: jest.fn(() => 'http://fixture-api.test') },
    );
  }

  function installSchemas(schemas: Array<Record<string, unknown>>) {
    global.fetch = jest.fn(async (url) => {
      if (String(url) !== 'http://fixture-api.test/api/clio/tool-schemas') {
        throw new Error(`Unexpected network request: ${String(url)}`);
      }
      return new Response(JSON.stringify({ schemas }), { status: 200 });
    }) as typeof fetch;
  }

  function secretBackedInvoke(raw: Array<{ name: string; input: Record<string, unknown>; result: Record<string, unknown> }>) {
    return jest.fn(async (name: string, args: Record<string, unknown>) => {
      const response = await request(app.getHttpServer()).post(`/api/clio/tools/${name}`)
        .set('x-internal-service-secret', serviceSecret).send(args).expect(201);
      raw.push({ name, input: args, result: response.body as Record<string, unknown> });
      return response.body;
    });
  }

  test('passes exact persisted values through the protected route and V3 model-visible evidence', async () => {
    const endpoint = '/api/clio/tools/get_research_evidence';
    const denied = await request(app.getHttpServer()).post(endpoint)
      .send({ sessionId, clientId, limit: 1 }).expect(403);
    expect(JSON.stringify(denied.body)).not.toContain(sentence);

    const observedRaw: Array<Record<string, unknown>> = [];
    const invoke = jest.fn(async (name: string, args: Record<string, unknown>) => {
      expect(name).toBe('get_research_evidence');
      const response = await request(app.getHttpServer()).post(endpoint)
        .set('x-internal-service-secret', serviceSecret).send(args).expect(201);
      observedRaw.push(response.body as Record<string, unknown>);
      return response.body;
    });
    const providerInputs: unknown[] = [];
    const expectedAnswer =
      `The attached appropriations page states $17 million [S:get_research_evidence:${textId}]. The scan is incomplete, so I cannot verify its remaining content.`;
    const complete = jest.fn(async (providerRequest: { input: unknown }) => {
      providerInputs.push(JSON.parse(JSON.stringify(providerRequest.input)));
      switch (providerInputs.length) {
        case 1:
          return toolCall({ sessionId: 'guessed-chat-session', limit: 1 }, 'page-one');
        case 2: {
          const firstOutput = toolOutputs(providerRequest.input)[0]?.output;
          const firstPage = visiblePayload(firstOutput!) as { coverage: { nextCursor: string } };
          expect(firstPage.coverage.nextCursor).toEqual(expect.any(String));
          return toolCall({ sessionId: 'guessed-chat-session', limit: 1,
            cursor: firstPage.coverage.nextCursor }, 'page-two');
        }
        case 3:
          return providerResponse({ outputText: expectedAnswer });
        default:
          throw new Error('Unexpected synthetic provider round');
      }
    });
    const schema = {
      name: 'get_research_evidence', description: 'Read original research attachment evidence',
      input_schema: { type: 'object', properties: {
        sessionId: { type: 'string' }, clientId: { type: 'string' },
        limit: { type: 'number' }, cursor: { type: 'string' },
      }, required: ['sessionId'] },
    };
    global.fetch = jest.fn(async (url) => new Response(JSON.stringify(
      String(url).includes('/runs/') ? { active: true } : { schemas: [schema] }),
      { status: 200 },
    )) as typeof fetch;
    const definitions = new Map([[schema.name, { name: schema.name, readOnly: true }]]);
    const registry = {
      list: () => [schema.name],
      get: (name: string) => definitions.get(name),
      executionMetadata: (name: string) => definitions.has(name)
        ? { name, readOnly: true, executionMode: 'read', externalEffect: 'none',
            reversible: true, riskTier: 'low', displayVerb: name }
        : undefined,
      invoke,
    } as unknown as ToolRegistry;
    // Dynamic requires keep the API package typecheck bounded to its own root.
    // Jest still executes the actual V3 service rather than a stand-in.
    const { MeriV3AssistantService } = require('../../../meriv2-orchestrator/src/meri/meriv3/meriv3-assistant.service.js');
    const { RequestCredentialsStore } = require('../../../meriv2-orchestrator/src/request/request-credentials.store.js');
    const prisma = { withTenant: jest.fn(async (_tenantId: string, callback: (tx: unknown) => unknown) =>
      callback({ aiUsageEvent: { create: jest.fn(async () => ({})) },
        meriAuditLedger: { create: jest.fn(async () => ({})) } })) };
    const assistant = new MeriV3AssistantService(
      { registry, llm: { completeJson: jest.fn(), completeWithSchema: jest.fn() } },
      { complete }, { create: jest.fn() }, prisma,
      { get: jest.fn(() => 'http://fixture-api.test') },
    );
    const result = await RequestCredentialsStore.run({ bearerToken: 'synthetic-bearer' }, () =>
      assistant.run(modelContext, {
        conversationId, clientId, toolPolicy: 'read-only',
        researchRun: { sessionId, runId: 'synthetic-run' },
        messages: [{ role: 'user', text: handoffPrompt }],
      }));

    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke.mock.calls[0]?.[1]).toMatchObject({ sessionId, clientId, limit: 1 });
    expect(invoke.mock.calls[1]?.[1]).toMatchObject({
      sessionId, clientId, limit: 1, cursor: expect.any(String),
    });
    expect(observedRaw[0]).toMatchObject({
      tool: 'get_research_evidence', sessionId,
      coverage: { total: 2, returned: 1, paginationComplete: false,
        contentComplete: false, complete: false, nextCursor: expect.any(String) },
      records: [{ recordId: textId, payload: { title: 'appropriation.txt',
        textContent: sentence }, provenance: { originalAttachmentId: textId } }],
    });
    expect(observedRaw[1]).toMatchObject({
      coverage: { total: 2, returned: 1, paginationComplete: true,
        contentComplete: false, complete: false, nextCursor: null },
      records: [{ recordId: scanId, payload: { textContent: scanText,
        status: 'truncated' }, provenance: { originalAttachmentId: scanId } }],
    });
    const visibleOutputs = toolOutputs(providerInputs[2]);
    expect(visibleOutputs.map((output) => output.call_id)).toEqual(['page-one', 'page-two']);
    const visiblePages = visibleOutputs.map((output) => visiblePayload(output.output)) as Array<Record<string, unknown>>;
    expect(visiblePages).toEqual(observedRaw);
    expect(JSON.stringify(providerInputs[0])).not.toContain(sentence);
    expect(JSON.stringify(providerInputs[1])).toContain(sentence);
    expect(JSON.stringify(providerInputs[2])).toContain(scanText);
    expect(result.ledgerEntries?.map((entry: { result: unknown }) => entry.result)).toEqual(observedRaw);
    expect(result.ledgerEntries?.[0]?.serialized).toContain(`[1] appropriation.txt`);
    expect(result.ledgerEntries?.[0]?.serialized).toContain(textId);
    // Research reports use Form B source markers. Numeric citations are only
    // released when the final prose actually uses a [N] marker.
    expect(result.citations).toBeUndefined();
    expect(result.reply).toBe(expectedAnswer);
    expect(result.reply).toContain(`[S:get_research_evidence:${textId}]`);
    expect(validateFormBCitations(
      result.reply, ledgerToToolResultMap(result.ledgerEntries ?? []),
    )).toMatchObject({ invalid: [], sanitizedText: expectedAnswer });
  }, 120_000);

  test('carries a source-qualified federal bill from DB through guarded route and V3 answer', async () => {
    const prompt = 'What happened to H.R. 8800 in the 119th Congress? Cite the source record.';
    const expectedAnswer =
      'H.R. 8800 in the 119th Congress was referred to the House Armed Services Committee on June 3, 2026 [1]. The status reader reports no recorded roll-call vote on the bill.';
    const callArgs = [
      { query: 'H.R. 8800', type: 'bill', congress: 119 },
      { billId: federalBillId },
      { query: federalBillId, congress: 119 },
    ];
    const names = ['resolve_entity', 'get_bill_status', 'search_congress_bills'];
    const raw: Array<{ name: string; input: Record<string, unknown>; result: Record<string, unknown> }> = [];
    const invoke = secretBackedInvoke(raw);
    const providerInputs: unknown[] = [];
    const scripted = [
      namedToolCall(names[0]!, callArgs[0]!, 'resolve'),
      namedToolCall(names[1]!, callArgs[1]!, 'status'),
      namedToolCall(names[2]!, callArgs[2]!, 'source'),
      providerResponse({ outputText: expectedAnswer }),
    ];
    const complete = jest.fn(async (providerRequest: { input: unknown }) => {
      providerInputs.push(JSON.parse(JSON.stringify(providerRequest.input)));
      return scripted.shift()!;
    });
    installSchemas([
      { name: names[0], description: 'Resolve source-qualified entity',
        input_schema: { type: 'object', properties: { query: {}, type: {}, congress: {} } } },
      { name: names[1], description: 'Read exact bill status',
        input_schema: { type: 'object', properties: { billId: {} } } },
      { name: names[2], description: 'Read indexed bill source',
        input_schema: { type: 'object', properties: { query: {}, congress: {} } } },
    ]);
    const assistant = buildV3Assistant(names, invoke, complete);
    const { RequestCredentialsStore } = require('../../../meriv2-orchestrator/src/request/request-credentials.store.js');
    const result = await RequestCredentialsStore.run({ bearerToken: 'synthetic-bearer' }, () =>
      assistant.run(modelContext, {
        conversationId: 'b6-federal-integrated', toolPolicy: 'read-only',
        messages: [{ role: 'user', text: prompt }],
      }));

    const persisted = await db.congressBill.findUniqueOrThrow({ where: { id: federalBillId } });
    expect(persisted).toMatchObject({
      id: federalBillId, congress: 119, status: 'committee',
      latestActionText: 'Referred to the House Armed Services Committee.',
      latestActionDate: billEventDate, url: federalBillUrl,
      updateDate: billUpdatedAt, lastSyncedAt: billSyncedAt,
    });
    expect(raw.map(({ name, input }) => [name, input])).toEqual(names.map((name, index) => [name, callArgs[index]]));
    expect(raw[0]?.result).toMatchObject({
      resolution: 'resolved', matchesFound: 1,
      matches: [{ canonicalId: federalBillId, congress: 119,
        sourceRef: { namespace: 'congress_bill', recordId: federalBillId,
          sourceUrl: federalBillUrl, eventDate: billEventDate.toISOString(),
          sourceUpdatedAt: billUpdatedAt.toISOString(), sourceCheckedAt: null,
          syncedAt: billSyncedAt.toISOString() } }],
    });
    expect(raw[1]?.result).toMatchObject({
      tool: 'get_bill_status', billId: federalBillId, found: true,
      status: 'committee', congress: 119,
      latestAction: { text: 'Referred to the House Armed Services Committee.',
        date: billEventDate.toISOString() },
      floorVotes: [],
    });
    expect(raw[1]?.result.note).toContain('No recorded roll-call vote on this bill itself.');
    expect(raw[2]?.result).toMatchObject({
      tool: 'search_congress_bills', total: 1, resolvedBy: 'bill-id',
      data: [{ id: federalBillId, congress: 119, title: 'B6 synthetic federal bill',
        status: 'committee', url: federalBillUrl }],
    });
    const visible = toolOutputs(providerInputs[3]).map((item) => visiblePayload(item.output));
    expect(visible).toEqual(raw.map(({ result: rawResult }) => rawResult));
    expect(JSON.stringify(providerInputs[3])).toContain(federalBillId);
    expect(JSON.stringify(providerInputs[3])).toContain(billEventDate.toISOString());
    expect(JSON.stringify(providerInputs[3])).toContain(federalBillUrl);
    expect(result.ledgerEntries?.map((entry: { result: unknown }) => entry.result)).toEqual(visible);
    expect(result.citations).toEqual([
      expect.objectContaining({ n: 1, tool: 'search_congress_bills',
        id: federalBillId, url: federalBillUrl }),
    ]);
    expect(result.reply).toBe(expectedAnswer);
  }, 120_000);

  test('marks an oversized DB-backed bill result partial before V3 synthesizes a limitation', async () => {
    const prompt = 'What does the indexed 119th-Congress H.R. 8801 say?';
    const expectedAnswer =
      'One indexed bill row matched, but its content was clipped from the evidence I could review. I cannot verify its details from this result.';
    const callArgs = { query: clippedBillId, congress: 119 };
    const raw: Array<{ name: string; input: Record<string, unknown>; result: Record<string, unknown> }> = [];
    const invoke = secretBackedInvoke(raw);
    const providerInputs: unknown[] = [];
    const scripted = [
      namedToolCall('search_congress_bills', callArgs, 'clipped-source'),
      providerResponse({ outputText: expectedAnswer }),
    ];
    const complete = jest.fn(async (providerRequest: { input: unknown }) => {
      providerInputs.push(JSON.parse(JSON.stringify(providerRequest.input)));
      return scripted.shift()!;
    });
    installSchemas([{ name: 'search_congress_bills', description: 'Read indexed bill source',
      input_schema: { type: 'object', properties: { query: {}, congress: {}, limit: {} } } }]);
    const assistant = buildV3Assistant(['search_congress_bills'], invoke, complete);
    const { RequestCredentialsStore } = require('../../../meriv2-orchestrator/src/request/request-credentials.store.js');
    const result = await RequestCredentialsStore.run({ bearerToken: 'synthetic-bearer' }, () =>
      assistant.run(modelContext, {
        conversationId: 'b6-clipped-integrated', toolPolicy: 'read-only',
        messages: [{ role: 'user', text: prompt }],
      }));

    expect(raw.map(({ name, input }) => [name, input])).toEqual([['search_congress_bills', callArgs]]);
    expect(raw[0]?.result).toMatchObject({
      total: 1, data: [{ id: clippedBillId, url: clippedBillUrl,
        title: clippedBillTitle }],
    });
    const visible = result.ledgerEntries?.[0]?.result as Record<string, any>;
    expect(visible).toMatchObject({
      total: 1, data: [], returned: 0, truncated: true, partial: true,
      complete: false, nextCursor: null,
      projection: { sourceRecordCount: 1, shownRecordCount: 0,
        omittedRecordCount: 1, identitiesAreNotEvidence: true,
        omittedRecordIdentities: [{ id: clippedBillId, url: clippedBillUrl,
          congress: 119 }] },
    });
    expect(visiblePayload(toolOutputs(providerInputs[1])[0]!.output)).toEqual(visible);
    expect(JSON.stringify(providerInputs[1])).not.toContain('Unread bill detail.');
    expect(result.citations ?? []).toEqual([]);
    expect(result.reply).toBe(expectedAnswer);
  }, 120_000);
});
