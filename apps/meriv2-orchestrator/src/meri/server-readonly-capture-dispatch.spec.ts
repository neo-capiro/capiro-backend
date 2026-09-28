import { createHash } from 'node:crypto';
import { MERI_CAPABILITY_REGISTRY } from '@capiro/shared';
import {
  decodeAndVerifyMeriCapturePolicyTransport,
  MERI_CAPTURE_POLICY_HEADER,
  type MeriServerReadonlyCapturePolicy,
} from '@capiro/meriv2-core';
import type { ConfigService } from '@nestjs/config';
import { RequestCredentialsStore } from '../request/request-credentials.store.js';
import {
  validateServerReadonlyCapturePolicy,
  withTrustedCurrentTurnScope,
} from '../request/trusted-current-turn-scope.js';
import { ApiActionProposalRepo } from './api-action-proposal.repo.js';
import { ApiToolExecutorRepo } from './api-tool-executor.repo.js';
import { ApiManagedMcpRepo } from './meriv3/api-managed-mcp.repo.js';

const SECRET = 'capture-service-secret';
const TENANT_ID = 'f2d6cf8f-057c-479a-8110-62fe5086d43f';
const ACTOR_ID = '11111111-1111-4111-8111-111111111111';
const CONVERSATION_ID = '22222222-2222-4222-8222-222222222222';
const CLIENT_ID = '33333333-3333-4333-8333-333333333333';

function catalogSha256(): string {
  return createHash('sha256')
    .update(
      MERI_CAPABILITY_REGISTRY.filter((tool) => tool.readOnly === true)
        .map((tool) => tool.name)
        .sort()
        .join('\n'),
    )
    .digest('hex');
}

function policy(
  overrides: Partial<MeriServerReadonlyCapturePolicy> = {},
): MeriServerReadonlyCapturePolicy {
  const issuedAt = Date.now();
  return {
    version: 1,
    kind: 'server_readonly_acceptance_capture',
    policyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    fixtureNamespace: 'meri-foundation-20260928',
    tenantId: TENANT_ID,
    tenantSlug: 'meri-foundation-20260928-t1',
    actorUserId: ACTOR_ID,
    conversationId: CONVERSATION_ID,
    clientId: CLIENT_ID,
    issuedAt,
    expiresAt: issuedAt + 60_000,
    toolAuthority: 'shared_static_registry_read_only',
    toolCatalogSha256: catalogSha256(),
    dynamicMcpAllowed: false,
    incidentalWriters: 'suppressed',
    expectedCaptureWrites: [
      'context_packet_and_evidence',
      'conversation_user_message',
      'conversation_assistant_message',
    ],
    ...overrides,
  };
}

function config(): ConfigService {
  const values: Record<string, string> = {
    MERIV2_API_BASE_URL: 'http://api.test',
    MERIV2_TOOL_TIMEOUT_MS: '60000',
    INTERNAL_SERVICE_SECRET: SECRET,
    NODE_ENV: 'test',
  };
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

function inCapturedTurn<T>(run: () => Promise<T>, current = policy()): Promise<T> {
  return RequestCredentialsStore.run({ bearerToken: 'user-bearer' }, () =>
    withTrustedCurrentTurnScope(
      {
        tenantId: TENANT_ID,
        userId: ACTOR_ID,
        conversationId: CONVERSATION_ID,
        selectedClientId: CLIENT_ID,
        capturePolicy: current,
      },
      run,
    ),
  );
}

describe('server read-only capture orchestrator dispatch enforcement', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('denies native writes, action proposals, and dynamic MCP before any controlled sink effect', async () => {
    const effects: string[] = [];
    jest.spyOn(global, 'fetch').mockImplementation(async () => {
      effects.push('network-effect');
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const tools = new ApiToolExecutorRepo(config());
    const proposals = new ApiActionProposalRepo(config());
    const mcp = new ApiManagedMcpRepo(config());

    await expect(
      inCapturedTurn(() => tools.execute({} as never, 'send_email', { to: 'nobody@example.com' })),
    ).rejects.toThrow('denied tool dispatch');
    await expect(
      inCapturedTurn(() =>
        proposals.create({
          tool: 'send_email',
          input: { to: 'nobody@example.com' },
          conversationId: CONVERSATION_ID,
          surface: 'chat',
        }),
      ),
    ).rejects.toThrow('denied action proposal creation');
    await expect(inCapturedTurn(() => mcp.schemas())).resolves.toEqual([]);
    await expect(
      inCapturedTurn(() => mcp.executeRead('hubspot_search_contacts', { query: 'test' })),
    ).rejects.toThrow('denies dynamic MCP dispatch');

    expect(effects).toEqual([]);
  });

  test('authorized static read reaches the existing API executor and carries signed transport identity', async () => {
    const effects: Array<{ url: string; headers: Record<string, string> }> = [];
    jest.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
      effects.push({
        url: String(input),
        headers: init?.headers as Record<string, string>,
      });
      return new Response(JSON.stringify({ result: 'authorized' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const tools = new ApiToolExecutorRepo(config());

    await expect(
      inCapturedTurn(() =>
        tools.execute({} as never, 'query_intelligence', { query: 'appropriations' }),
      ),
    ).resolves.toEqual({ result: 'authorized' });

    expect(effects).toHaveLength(1);
    expect(effects[0]?.url).toBe('http://api.test/api/clio/tools/query_intelligence');
    const encoded = effects[0]?.headers[MERI_CAPTURE_POLICY_HEADER];
    expect(typeof encoded).toBe('string');
    expect(
      decodeAndVerifyMeriCapturePolicyTransport(
        encoded,
        {
          purpose: 'tool',
          toolName: 'query_intelligence',
          tenantId: TENANT_ID,
          actorUserId: ACTOR_ID,
        },
        SECRET,
      ),
    ).toMatchObject({ conversationId: CONVERSATION_ID, clientId: CLIENT_ID });
  });

  test('stale, actor-rebound, client-rebound, and conversation-rebound policy is rejected', () => {
    const binding = {
      tenantId: TENANT_ID,
      actorUserId: ACTOR_ID,
      conversationId: CONVERSATION_ID,
      clientId: CLIENT_ID,
    };
    const cases = [
      policy({ expiresAt: Date.now() - 1 }),
      policy({ actorUserId: '44444444-4444-4444-8444-444444444444' }),
      policy({ clientId: '55555555-5555-4555-8555-555555555555' }),
      policy({ conversationId: '66666666-6666-4666-8666-666666666666' }),
    ];

    for (const candidate of cases) {
      expect(() => validateServerReadonlyCapturePolicy(candidate, binding)).toThrow(
        'stale or scope-mismatched',
      );
    }
  });

  test('ordinary turns retain existing write/proposal paths', async () => {
    const effects: string[] = [];
    jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
      effects.push(String(input));
      return new Response(
        JSON.stringify({
          disposition: 'pending_approval',
          proposal: { proposalId: 'proposal-1' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const proposals = new ApiActionProposalRepo(config());

    await expect(
      RequestCredentialsStore.run({ bearerToken: 'user-bearer' }, () =>
        proposals.create({ tool: 'send_email', input: {}, surface: 'chat' }),
      ),
    ).resolves.toMatchObject({ disposition: 'pending_approval' });
    expect(effects).toEqual(['http://api.test/api/clio/action-proposals']);
  });
});
