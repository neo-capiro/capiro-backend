jest.mock('../context/context-plane-gateway.service.js', () => ({
  ContextPlaneGatewayService: class ContextPlaneGatewayService {},
}));
jest.mock('../prisma/prisma.service.js', () => ({ PrismaService: class PrismaService {} }));

import { MeriContextPlaneService, planMeriTurn } from './meri-context-plane.service.js';
import { ContextPacketRolloutCompiler } from '@capiro/meriv2-core';
import { extractCitationsFromToolResult, formatCitationsForPrompt } from '@capiro/shared';

test('short steering records cannot expand the model prompt beyond the serialized evidence budget', async () => {
  const rows = Array.from({ length: 512 }, (_, index) => ({
    id: `845d5ac7-4fa1-4ad6-b862-${String(index).padStart(12, '0')}`,
    type: 'client-compass', slug: `clio:845d5ac7-4fa1-4ad6-b862-${String(index).padStart(12, '0')}`,
    title: `Approved memory ${index}`, clientId: 'client-1', status: 'active',
    sections: [{ owner: 'human', heading: 'Approved context', body: 'x'.repeat(70) }],
  }));
  const compiler = new ContextPacketRolloutCompiler({
    loadSteeringRows: async () => rows, loadGovernedSteeringRows: async () => rows,
    persistPacket: async () => 'packet-id',
  } as never);
  const requestContext = async (request: any) => ({
    kind: 'governed_packet',
    packet: await compiler.compile({ ...request.contextRequest, ethicalWallAllowed: true }, 'off'),
    context: { resolution: { status: 'resolved', stopReason: 'resolved',
      subjectScope: { kind: 'client', clientIds: ['client-1'] } },
      retrieval: { records: [], coverage: { requestedDomains: [], searchedDomains: [], sources: [],
        recordsEvaluated: 0, recordsReturned: 0, paginationComplete: true, complete: true } } },
  });
  const tx = {
    clioConversation: { findFirst: async () => ({ clientId: 'client-1' }) },
    client: { findFirst: async () => ({ name: 'Acme' }), findMany: async () => [{ id: 'client-1', name: 'Acme' }] },
    integrationConnection: { findMany: async () => [] },
  };
  const prisma = { withTenant: async (_t: string, fn: (tx: unknown) => unknown) => fn(tx),
    withTenantUser: async (_t: string, _u: string, fn: (tx: unknown) => unknown) => fn(tx) };
  const service = new MeriContextPlaneService(prisma as never, { requestContext } as never);
  const context = await service.resolveChat({ tenantId: 'tenant', userId: 'actor' } as never,
    { conversationId: 'thread', task: 'Export that briefing and give me the file.' });
  const citations = formatCitationsForPrompt(extractCitationsFromToolResult('context_plane', context.evidence, 1, 999));
  const wire = JSON.stringify({ instructions: `${context.prompt}\n${citations}` });
  console.log('SHORT_STEERING_WIRE_BYTES', Buffer.byteLength(wire), 'RECORDS', context.evidence!.records.length);
  expect(Buffer.byteLength(wire)).toBeLessThan(80_000);
  expect(context.evidence!.truncated).toBe(true);
  expect(context.evidence!.sourceRecordCount).toBe(512);
  expect(context.evidence!.projectedRecordCount).toBeLessThan(512);
  expect(context.prompt).toContain('omitted=');
  // Exercise the receiving service's actual wire reservation without adding
  // orchestrator source files to the API production TypeScript build.
  const { composeChatSystemPrompt } = require('../../../meriv2-orchestrator/src/meri/chat/chat-prompt.js');
  const { flattenSystemParts } = require('../../../meriv2-orchestrator/src/meri/prompt-cache.helpers.js');
  const { OpenAiResponsesClient } = require('../../../meriv2-orchestrator/src/meri/meriv3/openai-responses.client.js');
  const { resolveMeriV3ReasoningProfile } = require('../../../meriv2-orchestrator/src/meri/meriv3/meriv3-reasoning.js');
  const instructions = flattenSystemParts(composeChatSystemPrompt({
    messages: [{ role: 'user', text: 'Export that briefing and give me the file.' }],
    clientId: 'client-1', skillAddendum: context.prompt,
  }, { tenantId: 'tenant', userId: 'actor', contextPacket: context.contextPacket } as never)) + '\n' + citations;
  const stop = new Error('STOP_BEFORE_PROVIDER_DISPATCH');
  const reserveProviderAttempt = jest.fn(async (binding: any) => {
    console.log('FINAL_REQUEST_RESERVATION', JSON.stringify(binding));
    expect(binding.maxInputTokens + binding.maxOutputTokens).toBeLessThan(500_000);
    // Reviewed Astra ceiling: $25/M input, $75/M output. Leave room for tools/runtime.
    expect(binding.maxInputTokens * 25 + binding.maxOutputTokens * 75).toBeLessThan(2_700_000);
    throw stop;
  });
  const key = process.env.OPENAI_API_KEY;
  const originalFetch = global.fetch;
  const fetch = jest.fn(async () => { throw new Error('NO_NETWORK_ALLOWED'); });
  try {
    process.env.OPENAI_API_KEY = 'offline-placeholder';
    global.fetch = fetch as never;
    await expect(new OpenAiResponsesClient().complete({
      profile: resolveMeriV3ReasoningProfile('standard', {}), instructions,
      input: [{ role: 'user', content: 'Export that briefing and give me the file.' }],
      tools: [], budget: { reserveProviderAttempt } as never,
    })).rejects.toBe(stop);
    expect(reserveProviderAttempt).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    global.fetch = originalFetch;
    if (key === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = key;
  }
});

test('ordinary chat bounds steering with hundreds of memories in off and shadow rollout', async () => {
  const rows = Array.from({ length: 512 }, (_, index) => ({
    id: `memory-${index}`, type: 'client-compass', slug: `memory-${index}`,
    title: `Approved memory ${index}`, clientId: 'client-1', status: 'active',
    sections: [{ owner: 'human', heading: 'Approved context', body: 'Relevant context. '.repeat(100) }],
  }));
  for (const mode of ['off', 'shadow'] as const) {
    const compiler = new ContextPacketRolloutCompiler({
      loadSteeringRows: async () => rows,
      loadGovernedSteeringRows: async () => rows,
      persistPacket: async () => 'packet-id',
    } as never);
    const boundary = new Error('STOP_AFTER_REAL_COMPILATION');
    let packet: any;
    const requestContext = jest.fn(async (request: any) => {
      packet = await compiler.compile({ ...request.contextRequest, ethicalWallAllowed: true }, mode);
      const { charBudget: _bound, ...previousRequest } = request.contextRequest;
      const unbounded = await compiler.compile({ ...previousRequest, ethicalWallAllowed: true }, mode);
      expect(unbounded.rendered.reduce((n, item) => n + item.body.length, 0)).toBeGreaterThan(500_000);
      throw boundary;
    });
    const tx = {
      clioConversation: { findFirst: async () => ({ clientId: 'client-1' }) },
      client: { findFirst: async () => ({ name: 'Acme' }), findMany: async () => [{ id: 'client-1', name: 'Acme' }] },
      integrationConnection: { findMany: async () => [] },
    };
    const prisma = {
      withTenant: async (_t: string, fn: (tx: unknown) => unknown) => fn(tx),
      withTenantUser: async (_t: string, _u: string, fn: (tx: unknown) => unknown) => fn(tx),
    };
    const service = new MeriContextPlaneService(prisma as never, { requestContext } as never);
    await expect(service.resolveChat({ tenantId: 'tenant', userId: 'actor' } as never,
      { conversationId: 'thread', task: 'What did we approve about Acme?' })).rejects.toBe(boundary);
    expect(packet.rendered.length).toBeGreaterThan(0);
    expect(packet.rendered.reduce((n: number, item: any) => n + item.body.length, 0)).toBeLessThanOrEqual(48_000);
    expect(packet.items.length).toBeLessThan(512);
    expect(packet.exclusions.some((item: any) => item.reason === 'over-budget')).toBe(true);
  }
});

test('qualified clock reaches planning/compiler explicitly without requesting a historical ingestion snapshot', async () => {
  jest.useFakeTimers().setSystemTime(new Date('2026-10-03T12:00:00.000Z'));
  try {
    const semanticClock = { version: 1, kind: 'qualified_original_fixture_semantic_clock',
      instant: '2026-09-26T16:00:00.000Z', timeZone: 'America/New_York', caseId: '01',
      captureRunId: '11111111-1111-4111-8111-111111111111', currentVerifySha256: 'a'.repeat(64),
      observedAt: Date.now() } as const;
    const tx = { clioConversation: { findFirst: async () => ({ clientId: 'client-acme' }) },
      client: { findFirst: async () => ({ name: 'Acme' }), findMany: async () => [{ id: 'client-acme', name: 'Acme' }] },
      integrationConnection: { findMany: async () => [] } };
    const prisma = { withTenant: async (_t: string, fn: (tx: unknown) => unknown) => fn(tx),
      withTenantUser: async (_t: string, _u: string, fn: (tx: unknown) => unknown) => fn(tx) };
    const requestContext = jest.fn(async (_request: unknown) => ({ kind: 'governed_packet', packet: {} }));
    const service = new MeriContextPlaneService(prisma as never, { requestContext } as never);
    const input = { conversationId: 'thread', task: 'Prepare a briefing on changes in the last 7 days',
      now: new Date(semanticClock.instant), semanticClock };
    await expect(service.resolveChat({ tenantId: 'tenant', userId: 'actor' } as never, input))
      .rejects.toThrow('compiler_evidence_missing');
    const call = requestContext.mock.calls[0]![0] as any;
    expect(call.contextRequest.now).toEqual(input.now);
    expect(call.contextRequest.semanticClock).toEqual(semanticClock);
    expect(call.resolverRequest.retrieval.windowEnd.toISOString()).toBe(semanticClock.instant);
    expect(call.resolverRequest.retrieval.windowStart.toISOString()).toBe('2026-09-19T16:00:00.000Z');
    expect(call.resolverRequest.retrieval.observedThrough).toBeUndefined();
    await expect(service.resolveChat({ tenantId: 'tenant', userId: 'actor' } as never,
      { ...input, now: new Date() })).rejects.toThrow('clock_request_mismatch');
    expect(requestContext).toHaveBeenCalledTimes(1);
    const clockUse = { instant: semanticClock.instant, timeZone: semanticClock.timeZone,
      eligibilityAt: new Date().toISOString(), scoring: 'used' as const };
    requestContext.mockResolvedValueOnce({ kind: 'governed_packet',
      packet: { persisted: false, items: [], exclusions: [], rendered: [], clockUse },
      context: { resolution: { status: 'resolved', stopReason: 'resolved',
        subjectScope: { kind: 'client', clientIds: ['client-acme'] } },
        retrieval: { records: [], coverage: { requestedDomains: [], searchedDomains: [], sources: [],
          recordsEvaluated: 0, recordsReturned: 0, paginationComplete: true, complete: true } } },
    } as never);
    const resolved = await service.resolveChat({ tenantId: 'tenant', userId: 'actor' } as never, input);
    expect(resolved.contextPacket.clockUse).toEqual(clockUse);
    expect(resolved.contextPacket.clockUse!.eligibilityAt).not.toBe(semanticClock.instant);
  } finally { jest.useRealTimers(); }
});

describe('client document clarification context', () => {
  test('replans the original meeting/contact request using only this authorized conversation', async () => {
    const task =
      'I uploaded our meeting transcripts. List the meetings and find exact names, positions and contact information.';
    const clarification = 'I uploaded the transcript into the Acme files.';
    const findMany = jest.fn(async () => [
      { role: 'user', body: clarification },
      { role: 'user', body: task },
    ]);
    const tx = {
      clioConversation: { findFirst: jest.fn(async () => ({ clientId: 'client-1' })) },
      client: { findFirst: jest.fn(async () => ({ name: 'Acme' })) },
      clioMessage: { findMany },
    };
    const prisma = {
      withTenant: jest.fn(async (_id: string, fn: (tx: unknown) => unknown) => fn(tx)),
      withTenantUser: jest.fn(async (_id: string, _user: string, fn: (tx: unknown) => unknown) =>
        fn(tx),
      ),
    };
    const service = new MeriContextPlaneService(prisma as never, {} as never);
    const resolve = jest.spyOn(service as any, 'resolve').mockResolvedValue({});
    await service.resolveChat({ tenantId: 'tenant-1', userId: 'user-1' } as never, {
      conversationId: 'thread-1',
      task: clarification,
    });
    expect(tx.clioConversation.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'thread-1',
          tenantId: 'tenant-1',
          userId: 'user-1',
          archivedAt: null,
        },
      }),
    );
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { conversationId: 'thread-1', role: 'user' },
        take: 4,
      }),
    );
    const effective = (resolve.mock.calls[0]![1] as { task: string }).task;
    expect(effective).toContain(task);
    expect(
      planMeriTurn({ task: effective, uiClientId: 'client-1', uiClientName: 'Acme' })
        .requiredDomains,
    ).toEqual(expect.arrayContaining(['meetings', 'contacts']));
  });
});

describe('MeriContextPlaneService Phase 19 planning', () => {
  test.each([
    ['Research RTX', 'RTX'],
    ['Research "RTX"', 'RTX'],
    ['RESEARCH RTX', 'RTX'],
    ['Research RTX instead of this client', 'RTX'],
    ['Do not use this client; Research RTX', 'RTX'],
    ['Compare RTX and LMT', 'RTX'],
    ['Tell me about SAC Capital', 'SAC Capital'],
    ['Tell me about PE Systems', 'PE Systems'],
  ])('preserves an explicitly requested external organization: %s', (task, targetHint) => {
    const plan = planMeriTurn({ task, uiClientId: 'client-acme', uiClientName: 'Acme Defense' });
    expect(plan).toMatchObject({ subjectScope: 'external_entity', targetHint, query: targetHint });
  });

  test.each([
    'Analyze FY27 appropriations for this client',
    'Find eligible grant funding for this client',
    'Check NIH grants for this client',
    'Compare FY 2027 and FY 2026 for this client',
    'Compare RTX and LMT for this client',
    'Prepare a meeting briefing for HASC staff',
    'Prepare hearing intelligence on FY27 appropriations',
    'Analyze NDAA implementation implications for this client',
    'Prepare an executive briefing with the constraint "Enacted only"',
  ])('keeps the selected client and strategy inputs for professional work: %s', (task) => {
    const plan = planMeriTurn({ task, uiClientId: 'client-acme', uiClientName: 'Acme Defense' });
    expect(plan.subjectScope).toBe('client');
    expect(plan.requestedDomains).toEqual(
      expect.arrayContaining(['clients', 'contacts', 'strategies_work', 'institutional_knowledge']),
    );
    expect(plan.query).toBeUndefined();
  });

  test('meeting preparation keeps the meeting rail as well as client strategy', () => {
    const plan = planMeriTurn({
      task: 'Prepare a meeting briefing',
      uiClientId: 'client-acme',
      uiClientName: 'Acme Defense',
    });
    expect(plan.requestedDomains).toContain('meetings');
    expect(plan.requestedDomains).toContain('strategies_work');
  });

  test('selected-client strategies are retrieved without requiring the client name in their bodies', () => {
    const plan = planMeriTurn({
      task: 'Review our strategies and unresolved work',
      uiClientId: 'client-acme',
      uiClientName: 'Acme Defense',
    });
    expect(plan.subjectScope).toBe('client');
    expect(plan.requestedDomains).toContain('strategies_work');
    expect(plan.query).toBeUndefined();
  });

  test('client briefings and recent changes include strategy work', () => {
    for (const task of ['Prepare a briefing', 'What changed recently?']) {
      const plan = planMeriTurn({ task, uiClientId: 'client-acme', uiClientName: 'Acme Defense' });
      expect(plan.requestedDomains).toContain('strategies_work');
      expect(plan.query).toBeUndefined();
    }
  });

  test.each([
    'What has changed with the commitments and deliverables we owe this client?',
    'Audit every commitment we promised and what needs follow-up.',
  ])('commitments audit requests every governed evidence rail: %s', (task) => {
    const plan = planMeriTurn({
      task,
      uiClientId: 'client-acme',
      uiClientName: 'Acme Defense',
    });

    expect(plan).toMatchObject({
      subjectScope: 'client',
      queryClass: 'lookup',
      requireComplete: true,
      query: undefined,
      mondayBoardContext: task,
    });
    expect(plan.requiredDomains).toEqual([
      'mail',
      'meetings',
      'tasks',
      'action_recommendations',
      'monday',
    ]);
    expect(plan.requestedDomains).toEqual(
      expect.arrayContaining([
        'clients',
        'mail',
        'meetings',
        'tasks',
        'action_recommendations',
        'monday',
        'strategies_work',
        'institutional_knowledge',
      ]),
    );
  });

  test('forwards a supplied monday board link without widening client scope', async () => {
    const task =
      'Audit our commitments for this client using https://example.monday.com/boards/18431248553';
    const requestContext = jest.fn(async (_request: unknown) => ({
      kind: 'governed_packet',
      context: {
        resolution: {
          status: 'resolved',
          stopReason: 'resolved',
          subjectScope: { kind: 'client', clientIds: ['client-acme'] },
        },
        retrieval: {
          records: [],
          coverage: {
            requestedDomains: ['monday'],
            searchedDomains: [],
            requestedEntityCount: 1,
            searchedEntityCount: 0,
            recordsEvaluated: 0,
            recordsReturned: 0,
            paginationComplete: false,
            unavailableSources: ['monday'],
            sources: [
              {
                domain: 'monday',
                sourceStatus: 'unavailable',
                stopReason: 'monday_not_connected',
                coverageComplete: false,
                paginationComplete: false,
                truncated: false,
              },
            ],
            complete: false,
            stopReason: 'source_unavailable',
          },
        },
      },
      packet: { persisted: false, items: [], exclusions: [], rendered: [] },
    }));
    const tx = {
      clioConversation: { findFirst: jest.fn(async () => ({ clientId: 'client-acme' })) },
      client: {
        findFirst: jest.fn(async () => ({ name: 'Acme Defense' })),
        findMany: jest.fn(async () => [{ id: 'client-acme' }]),
      },
      integrationConnection: { findMany: jest.fn(async () => []) },
    };
    const prisma = {
      withTenant: jest.fn(async (_id: string, fn: (value: unknown) => unknown) => fn(tx)),
      withTenantUser: jest.fn(async (_id: string, _user: string, fn: (value: unknown) => unknown) =>
        fn(tx),
      ),
    };
    const service = new MeriContextPlaneService(prisma as never, { requestContext } as never);

    const result = await service.resolveChat({ tenantId: 'tenant-1', userId: 'user-1' } as never, {
      conversationId: 'thread-1',
      task,
    });
    const call = requestContext.mock.calls[0]![0] as any;
    const retrieval = call.resolverRequest.retrieval;
    expect(call.resolverRequest).toMatchObject({
      tenantId: 'tenant-1',
      actorUserId: 'user-1',
      clientId: 'client-acme',
      subjectScope: 'client',
    });
    expect(retrieval.query).toBeNull();
    expect(retrieval.mondayBoardContext).toBe(task);
    expect(retrieval.requestedDomains).toContain('monday');
    expect(retrieval.requestedDomains).toContain('tasks');
    expect(result.retrieval.coverage.unavailableSources).toContainEqual({
      source: 'monday',
      reason: 'monday_not_connected',
    });
    expect(result.prompt).toContain('monday_not_connected');
  });

  test('named external entity wins over an unrelated selected client', () => {
    const plan = planMeriTurn({
      task: 'Tell me everything we know about RTX',
      uiClientId: 'client-acme',
      uiClientName: 'Acme Defense',
      now: new Date('2026-08-18T12:00:00.000Z'),
    });

    expect(plan).toMatchObject({
      subjectScope: 'external_entity',
      targetHint: 'RTX',
      queryClass: 'lookup',
      query: 'RTX',
    });
    expect(plan.requestedDomains).toEqual(['clients', 'contacts', 'institutional_knowledge']);
  });

  test('explicitly naming the selected client keeps the client as subject', () => {
    const plan = planMeriTurn({
      task: 'What do we know about ACME DEFENSE?',
      uiClientId: 'client-acme',
      uiClientName: 'ACME DEFENSE',
    });

    expect(plan.subjectScope).toBe('client');
    expect(plan.targetHint).toBeNull();
  });

  test('portfolio language preserves the authorized portfolio subject', () => {
    const plan = planMeriTurn({
      task: 'What changed across our clients?',
      uiClientId: 'client-acme',
      uiClientName: 'ACME DEFENSE',
    });

    expect(plan).toMatchObject({
      subjectScope: 'portfolio',
      queryClass: 'portfolio_scan',
      requireComplete: true,
    });
    expect(plan.requestedDomains).toEqual([
      'clients',
      'contacts',
      'tasks',
      'outreach',
      'strategies_work',
    ]);
  });

  test('a client memory question preserves the selected client subject', () => {
    const plan = planMeriTurn({
      task: 'What do you remember about this client?',
      uiClientId: 'client-acme',
      uiClientName: 'Acme Defense',
    });
    expect(plan).toMatchObject({
      subjectScope: 'client',
      targetHint: null,
      queryClass: 'semantic_recall',
      requestedDomains: ['institutional_knowledge'],
    });
  });

  test.each([
    ['What do we know about Aster’s briefing preferences?', 'Aster Defense'],
    ["Tell me about Acme's writing preferences", 'Acme Systems'],
    ['What do you remember about Meridian’s communication preferences?', 'Meridian Robotics'],
    ["Tell me about Acme Systems's tone", 'Acme Systems'],
  ])('possessive memory attributes retain an unambiguous selected client: %s', (task, name) => {
    const plan = planMeriTurn({
      task, uiClientId: 'selected', uiClientName: name,
      authorizedClientNames: [name, 'Unrelated Holdings'],
    });
    expect(plan).toMatchObject({ subjectScope: 'client', targetHint: null });
  });

  test.each([
    ["What do we know about Aster's preferences?", ['Aster Defense', 'Aster Robotics']],
    ["What do we know about Aster's preferences?", ['Aster Defense', 'Aster Defense']],
    ["What do we know about Aster's preferences?", []],
    ["What do we know about Ast's preferences?", ['Aster Defense']],
    ["What do we know about Bluehaven's preferences?", ['Aster Defense', 'Bluehaven Robotics']],
    ["What do we know about Aster's preferences and Bluehaven's preferences?", ['Aster Defense']],
    ["Tell me about Aster's competitor's preferences", ['Aster Defense']],
    ["Tell me about Aster's preferences. Research RTX instead.", ['Aster Defense']],
    ["What do we know about Aster's preferences? Research RTX.", ['Aster Defense']],
    ["Tell me about Aster's preferences, research RTX", ['Aster Defense']],
    ["Tell me about Aster's preferences\nResearch RTX", ['Aster Defense']],
  ])('ambiguous, foreign or mixed possessives cannot acquire selected-client scope: %s', (task, names) => {
    expect(planMeriTurn({ task, uiClientId: 'selected', uiClientName: 'Aster Defense',
      authorizedClientNames: names }).subjectScope).toBe('external_entity');
  });

  test('possessive matching cannot create selected-client scope without a selected client', () => {
    expect(planMeriTurn({ task: "What do we know about Aster's preferences?", uiClientId: null,
      uiClientName: null, authorizedClientNames: ['Aster Defense'] }).subjectScope).toBe('external_entity');
  });

  test('real chat planner uses only current server-scoped names and keeps the original request', async () => {
    const task = 'What do we know about Aster’s briefing preferences?';
    const boundary = new Error('STOP_BEFORE_CONTEXT_OR_PROVIDER');
    const requestContext = jest.fn(async () => { throw boundary; });
    const tx = {
      clioConversation: { findFirst: jest.fn(async () => ({ clientId: 'selected' })) },
      client: {
        findFirst: jest.fn(async () => ({ name: 'Aster Defense' })),
        findMany: jest.fn(async () => [{ id: 'selected', name: 'Aster Defense' },
          { id: 'other', name: 'Bluehaven Robotics' }]),
      },
      integrationConnection: { findMany: jest.fn(async () => []) },
    };
    const prisma = {
      withTenant: jest.fn(async (_tenant: string, fn: (value: unknown) => unknown) => fn(tx)),
      withTenantUser: jest.fn(async (_tenant: string, _actor: string, fn: (value: unknown) => unknown) => fn(tx)),
    };
    const service = new MeriContextPlaneService(prisma as never, { requestContext } as never);
    await expect(service.resolveChat({ tenantId: 'tenant', userId: 'actor' } as never,
      { conversationId: 'conversation', task })).rejects.toBe(boundary);
    expect(tx.client.findMany).toHaveBeenCalledWith({
      where: { tenantId: 'tenant', OR: [{ memoryWall: false },
        { memoryAccessGrants: { some: { userId: 'actor' } } }] },
      select: { id: true, name: true }, orderBy: { id: 'asc' },
    });
    expect(requestContext).toHaveBeenCalledWith(expect.objectContaining({
      resolverRequest: expect.objectContaining({ task, clientId: 'selected', subjectScope: 'client',
        retrieval: expect.objectContaining({ requestedDomains: ['institutional_knowledge'], query: task }),
        securityScope: { authorizedClientIds: ['selected', 'other'], allowExternalLookup: true },
      }),
    }));
    // Names are planner-only context; other security-envelope consumers retain their contract.
    expect(await service.securityEnvelope({ tenantId: 'tenant', userId: 'actor' } as never))
      .toEqual({ authorizedClientIds: ['selected', 'other'], authorizedMailboxConnectionIds: [] });
  });

  test('explicit external memory questions are not silently attributed to the selected client', () => {
    const plan = planMeriTurn({
      task: 'What do you remember about RTX?',
      uiClientId: 'client-acme',
      uiClientName: 'Acme Defense',
    });
    expect(plan).toMatchObject({
      subjectScope: 'external_entity',
      targetHint: 'RTX',
      queryClass: 'semantic_recall',
    });
  });

  test('personal recall is routed through governed institutional knowledge', () => {
    const plan = planMeriTurn({
      task: 'What do you remember about my writing preferences?',
      uiClientId: null,
      uiClientName: null,
    });

    expect(plan).toMatchObject({
      subjectScope: 'general',
      queryClass: 'semantic_recall',
      requestedDomains: ['institutional_knowledge'],
    });
  });

  test('trivial conversation does not manufacture retrieval coverage', () => {
    const plan = planMeriTurn({
      task: 'Thanks!',
      uiClientId: 'client-acme',
      uiClientName: 'ACME DEFENSE',
    });

    expect(plan.subjectScope).toBe('general');
    expect(plan.requestedDomains).toEqual([]);
  });

  test('relationship history asks only domains that support relationship_history', () => {
    const plan = planMeriTurn({
      task: 'Show me our communications and relationship history with RTX',
      uiClientId: null,
      uiClientName: null,
      now: new Date('2026-08-18T12:00:00.000Z'),
    });

    expect(plan.queryClass).toBe('relationship_history');
    expect(plan.requestedDomains).toEqual(['contacts', 'mail', 'meetings']);
    expect(plan.requestedDomains).not.toContain('outreach');
  });
});

describe('MW-07 explicit subject contract', () => {
  const instructions = [
    'QA Sep 9: In one sentence, explain the difference between authorization and appropriations.',
    'Extract fields from the attached synthetic QA brief.',
    'Create a Word document and PDF using the synthetic brief.',
    'Reply with exactly READY. Do not use tools or save memory.',
    'Make a brief for QA in PDF format.',
    'Draft for our meeting on READY status.',
    'Assess PDF extraction results.',
    'Reply with exactly "Search across clients".',
    'Rewrite this sentence: Search across clients.',
    'Reply with exactly "Research READY". Do not use tools or save memory.',
    'Summarize the attached brief titled "Research QA".',
    'Rewrite this sentence: Research PDF extraction results.',
    'Reply with exactly "Research READY. Tell me about PDF".',
    'Rewrite this paragraph: Research QA. Tell me about READY.',
    'Summarize the attachment: QA, FY2027, BLUE-ORBIT-47.',
  ];
  test.each(instructions)('keeps a general instruction general: %s', (task) => {
    expect(planMeriTurn({ task, uiClientId: null, uiClientName: null })).toMatchObject({
      subjectScope: 'general',
      targetHint: null,
    });
  });
  test.each(instructions)('preserves explicit client focus: %s', (task) => {
    expect(
      planMeriTurn({ task, uiClientId: 'client-acme', uiClientName: 'Acme Defense' }),
    ).toMatchObject({
      subjectScope: 'client',
      targetHint: null,
    });
  });
  test.each([
    ['Research https://www.saronic.com/ and provide a PDF.', 'saronic.com'],
    ['Could you please research "RTX"?', 'RTX'],
    ['Research "Johnson and Johnson"', 'Johnson and Johnson'],
    ['what does overland ai do', 'overland ai'],
    ['Give me a summary of my emails from Powers Interactive', 'Powers Interactive'],
    ['Compare my client with Shield AI', 'Shield AI'],
    ['What is our relationship with Anduril?', 'Anduril'],
    ['What is our engagement history with Anduril?', 'Anduril'],
    ['Check my inbox and tell me about Anduril', 'Anduril'],
    ['Compare RTX and LMT', 'RTX'],
  ])('still resolves an explicit external inquiry: %s', (task, targetHint) => {
    expect(
      planMeriTurn({ task, uiClientId: 'client-acme', uiClientName: 'Acme Defense' }),
    ).toMatchObject({
      subjectScope: 'external_entity',
      targetHint,
    });
  });
  test.each([
    'Compare all our clients for a PDF briefing',
    'Compare all clients',
    'Search across clients',
  ])('portfolio comparison remains portfolio-wide: %s', (task) => {
    expect(
      planMeriTurn({ task, uiClientId: 'client-acme', uiClientName: 'Acme Defense' }),
    ).toMatchObject({
      subjectScope: 'portfolio',
      targetHint: null,
    });
  });
});
