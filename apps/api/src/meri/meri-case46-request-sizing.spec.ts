jest.mock('../context/context-plane-gateway.service.js', () => ({
  ContextPlaneGatewayService: class ContextPlaneGatewayService {},
}));
jest.mock('../prisma/prisma.service.js', () => ({ PrismaService: class PrismaService {} }));

import { MeriContextPlaneService, planMeriTurn } from './meri-context-plane.service.js';
import { ContextPacketRolloutCompiler } from '@capiro/meriv2-core';
import { extractCitationsFromToolResult, formatCitationsForPrompt } from '@capiro/shared';

test('full Case46 runtime records the provider reservation including assurance and actual tool schema', async () => {
  const rows = Array.from({ length: 512 }, (_, index) => ({
    id: `845d5ac7-4fa1-4ad6-b862-${String(index).padStart(12, '0')}`,
    type: 'client-compass',
    slug: `clio:845d5ac7-4fa1-4ad6-b862-${String(index).padStart(12, '0')}`,
    title: `Approved memory ${index}`,
    clientId: '41f9ec63-3963-479f-b747-59a3767ef44b',
    status: 'active',
    sections: [{ owner: 'human', heading: 'Approved context', body: 'x'.repeat(70) }],
  }));
  const compiler = new ContextPacketRolloutCompiler({
    loadSteeringRows: async () => rows,
    loadGovernedSteeringRows: async () => rows,
    persistPacket: async () => 'packet-id',
  } as never);
  const requestContext = async (request: any) => ({
    kind: 'governed_packet',
    packet: await compiler.compile({ ...request.contextRequest, ethicalWallAllowed: true }, 'off'),
    context: {
      resolution: {
        status: 'resolved',
        stopReason: 'resolved',
        subjectScope: { kind: 'client', clientIds: ['41f9ec63-3963-479f-b747-59a3767ef44b'] },
      },
      retrieval: {
        records: [],
        coverage: {
          requestedDomains: [],
          searchedDomains: [],
          sources: [],
          recordsEvaluated: 0,
          recordsReturned: 0,
          paginationComplete: true,
          complete: true,
        },
      },
    },
  });
  const tx = {
    clioConversation: {
      findFirst: async () => ({ clientId: '41f9ec63-3963-479f-b747-59a3767ef44b' }),
    },
    client: {
      findFirst: async () => ({ name: 'Acme' }),
      findMany: async () => [{ id: '41f9ec63-3963-479f-b747-59a3767ef44b', name: 'Acme' }],
    },
    integrationConnection: { findMany: async () => [] },
  };
  const prisma = {
    withTenant: async (_t: string, fn: (tx: unknown) => unknown) => fn(tx),
    withTenantUser: async (_t: string, _u: string, fn: (tx: unknown) => unknown) => fn(tx),
  };
  const service = new MeriContextPlaneService(prisma as never, { requestContext } as never);
  const context = await service.resolveChat(
    {
      tenantId: 'f2d6cf8f-057c-479a-8110-62fe5086d43f',
      userId: 'b1f758fc-17bd-40f8-bef2-fa2d2380300f',
    } as never,
    { conversationId: 'thread', task: 'Export that briefing and give me the file.' },
  );
  const citations = formatCitationsForPrompt(
    extractCitationsFromToolResult('context_plane', context.evidence, 1, 999),
  );
  const wire = JSON.stringify({ instructions: `${context.prompt}\n${citations}` });
  console.log(
    'SHORT_STEERING_WIRE_BYTES',
    Buffer.byteLength(wire),
    'RECORDS',
    context.evidence!.records.length,
  );
  expect(Buffer.byteLength(wire)).toBeLessThan(80_000);
  expect(context.evidence!.truncated).toBe(true);
  expect(context.evidence!.sourceRecordCount).toBe(512);
  expect(context.evidence!.projectedRecordCount).toBeLessThan(512);
  expect(context.prompt).toContain('omitted=');
  const {
    MeriV3AssistantService,
  } = require('../../../meriv2-orchestrator/src/meri/meriv3/meriv3-assistant.service.js');
  const {
    OpenAiResponsesClient,
  } = require('../../../meriv2-orchestrator/src/meri/meriv3/openai-responses.client.js');
  const {
    governedArtifactTestPolicy,
  } = require('../../../meriv2-orchestrator/src/meri/meriv3/meriv3-governed-artifact.spec-helper.js');
  const {
    withTrustedCurrentTurnScope,
  } = require('../../../meriv2-orchestrator/src/request/trusted-current-turn-scope.js');
  const {
    RequestCredentialsStore,
  } = require('../../../meriv2-orchestrator/src/request/request-credentials.store.js');
  const {
    runWithGovernedMeriContext,
  } = require('../../../meriv2-orchestrator/src/meri/meri-governed-context.runtime.js');
  const schema = {
    name: 'create_word',
    description:
      'Generate a downloadable Word (.docx) or PDF (.pdf) document from a structured spec (title, optional subtitle, and sections with paragraphs, bullets, and tables). Set format to pdf for a PDF; docx is the default. Both export formats use the same saved content. For plain UTF-8 text (.txt), set format to txt, provide exact text and an empty sections array; whitespace and final newlines are preserved. Use when the user asks for a document, memo, report, or briefing as a file.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Document title' },
        format: {
          type: 'string',
          enum: ['docx', 'pdf', 'txt'],
          description:
            'Requested file format. Defaults to docx. Word and PDF downloads share saved content. For txt provide exact text and an empty sections array.',
        },
        text: {
          type: 'string',
          description: 'Exact UTF-8 text for txt only; whitespace and final newline are preserved.',
        },
        subtitle: { type: 'string', description: 'Optional subtitle' },
        sections: {
          type: 'array',
          description: 'Document sections, each with a heading and content',
          items: {
            type: 'object',
            properties: {
              heading: { type: 'string', description: 'Section heading' },
              paragraphs: {
                type: 'array',
                items: { type: 'string' },
                description: 'Prose paragraphs',
              },
              bullets: {
                type: 'array',
                items: { type: 'string' },
                description: 'Bulleted list items',
              },
              tables: {
                type: 'array',
                description: 'Tables in this section',
                items: {
                  type: 'object',
                  properties: {
                    headers: { type: 'array', items: { type: 'string' } },
                    rows: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
                  },
                  required: [],
                },
              },
            },
            required: [],
          },
        },
        clientId: { type: 'string', description: 'Optional client UUID to associate' },
        conversationId: {
          type: 'string',
          description: 'Optional conversation UUID for attribution',
        },
      },
      required: ['title', 'sections'],
    },
  };
  const originalFetch = global.fetch,
    key = process.env.OPENAI_API_KEY;
  const captured: any[] = [];
  try {
    process.env.OPENAI_API_KEY = 'offline-only';
    global.fetch = jest.fn(async (url: any) => {
      if (String(url) !== 'http://api.test/api/clio/tool-schemas')
        throw Error('PROVIDER_NETWORK_FORBIDDEN');
      return new Response(JSON.stringify({ schemas: [schema] }), { status: 200 });
    }) as never;
    for (const reasoningMode of ['standard', 'fast']) {
      const p = governedArtifactTestPolicy();
      const realClient = new OpenAiResponsesClient();
      const complete = async (params: any) =>
        realClient.complete({
          ...params,
          budget: {
            reserveProviderAttempt: async (binding: any) => {
              captured.push({
                reasoningMode,
                model: params.profile.model,
                instructionsBytes: Buffer.byteLength(params.instructions),
                toolsBytes: Buffer.byteLength(JSON.stringify(params.tools)),
                ...binding,
                costMicros: binding.maxInputTokens * 25 + binding.maxOutputTokens * 75,
              });
              throw Error('OFFLINE_STOP_BEFORE_PROVIDER');
            },
          },
        });
      const registry = {
        list: () => ['create_word'],
        get: () => ({ name: 'create_word', readOnly: false }),
        executionMetadata: () => ({
          name: 'create_word',
          readOnly: false,
          executionMode: 'approval_required',
          externalEffect: 'none',
          reversible: true,
          riskTier: 'low',
          displayVerb: 'Create document',
        }),
        invoke: jest.fn(() => {
          throw Error('NO_TOOL_EXECUTION');
        }),
      };
      const assistant = new MeriV3AssistantService(
        { registry, llm: { completeJson: jest.fn(), completeWithSchema: jest.fn() } } as never,
        { complete } as never,
        { create: jest.fn() } as never,
        {} as never,
        {
          get: (k: string) =>
            k === 'MERIV2_API_BASE_URL'
              ? 'http://api.test'
              : k === 'INTERNAL_SERVICE_SECRET'
                ? 'offline-capture-secret'
                : undefined,
        } as never,
      );
      await RequestCredentialsStore.run({ bearerToken: 'unit-only' }, () =>
        withTrustedCurrentTurnScope(
          {
            tenantId: p.tenantId,
            userId: p.actorUserId,
            conversationId: p.conversationId,
            selectedClientId: p.clientId,
            governedArtifactPolicy: p,
          },
          () =>
            runWithGovernedMeriContext(context, () =>
              assistant.run(
                {
                  tenantId: p.tenantId,
                  userId: p.actorUserId,
                  firmMemory: null,
                  userVoice: null,
                  clientSteering: null,
                  clientRoster: [],
                  contextPacket: context.contextPacket,
                },
                {
                  conversationId: p.conversationId,
                  clientId: p.clientId,
                  reasoningMode,
                  skillAddendum: context.prompt,
                  messages: [{ role: 'user', text: 'Export that briefing and give me the file.' }],
                },
              ),
            ),
        ),
      );
    }
    console.log('FULL_CASE46_RUNTIME_RESERVATIONS', JSON.stringify(captured));
    expect(captured.map((x) => x.reasoningMode)).toEqual(['standard', 'fast']);
    expect(
      captured.every(
        (x) => x.model === 'gpt-6-astra' && x.toolsBytes > 1000 && x.instructionsBytes > 50000,
      ),
    ).toBe(true);
    expect(
      (global.fetch as jest.Mock).mock.calls.every(
        ([url]) => String(url) === 'http://api.test/api/clio/tool-schemas',
      ),
    ).toBe(true);
  } finally {
    global.fetch = originalFetch;
    if (key === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = key;
  }
});
