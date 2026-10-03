import {
  MERI_CASE46,
  MERI_GOVERNED_ARTIFACT_HEADER,
  MERI_CAPTURE_POLICY_HEADER,
  MERI_FIXTURE_SEMANTIC_INSTANT,
  MERI_FIXTURE_SEMANTIC_ZONE,
  attestMeriGovernedContext,
  decodeMeriGovernedArtifactTransport,
  type MeriGovernedTurnContext,
} from '@capiro/meriv2-core';
import { governedArtifactTestPolicy } from './meriv3-governed-artifact.spec-helper.js';
import {
  withTrustedCurrentTurnScope,
  currentGovernedArtifactCapturePolicy,
} from '../../request/trusted-current-turn-scope.js';
import { RequestCredentialsStore } from '../../request/request-credentials.store.js';
import { ApiActionProposalRepo } from '../api-action-proposal.repo.js';
import { ApiToolExecutorRepo } from '../api-tool-executor.repo.js';
import { ApiManagedMcpRepo } from './api-managed-mcp.repo.js';
import { MeriV3Controller } from './meriv3.controller.js';
const secret = 'unit-only-case46-service';
const config = {
  get: (name: string) =>
    ({ INTERNAL_SERVICE_SECRET: secret, MERIV2_API_BASE_URL: 'https://api.invalid' })[name],
} as never;
function scoped<T>(p: ReturnType<typeof governedArtifactTestPolicy>, fn: () => Promise<T>) {
  return RequestCredentialsStore.run({ bearerToken: 'unit-only-bearer' }, () =>
    withTrustedCurrentTurnScope(
      {
        tenantId: p.tenantId,
        userId: p.actorUserId,
        conversationId: p.conversationId,
        selectedClientId: p.clientId,
        governedArtifactPolicy: p,
      },
      fn,
    ),
  );
}
afterEach(() => jest.restoreAllMocks());
test('only exact canonical proposal bridge dispatches; raw executor and dynamic MCP never execute', async () => {
  const p = governedArtifactTestPolicy();
  const calls: Array<{ url: string; init: RequestInit }> = [];
  jest.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
    calls.push({ url: String(url), init: init! });
    return new Response(
      JSON.stringify({
        disposition: 'pending_approval',
        proposal: { proposalId: 'pending', status: 'proposed' },
      }),
      { status: 200 },
    );
  });
  const input = {
    title: 'aster-synthetic-briefing',
    format: 'txt',
    text: MERI_CASE46.text,
    clientId: p.clientId,
    conversationId: p.conversationId,
  };
  const repo = new ApiActionProposalRepo(config);
  await scoped(p, () =>
    repo.create({ tool: 'create_word', input, conversationId: p.conversationId, surface: 'chat' }),
  );
  expect(calls).toHaveLength(1);
  expect(calls[0]!.url).toBe('https://api.invalid/api/clio/action-proposals');
  const headers = new Headers(calls[0]!.init.headers);
  expect(headers.has(MERI_CAPTURE_POLICY_HEADER)).toBe(false);
  expect(
    decodeMeriGovernedArtifactTransport(
      headers.get(MERI_GOVERNED_ARTIFACT_HEADER)!,
      {
        purpose: 'action_proposal',
        tenantId: p.tenantId,
        actorUserId: p.actorUserId,
      },
      secret,
    ).turnId,
  ).toBe(p.turnId);
  for (const request of [
    { tool: 'send_email', input },
    { tool: 'create_word', input: { ...input, text: 'changed' } },
    { tool: 'create_word', input: { ...input, clientId: 'other' } },
  ])
    await expect(
      scoped(p, () =>
        repo.create({ ...request, conversationId: p.conversationId, surface: 'chat' }),
      ),
    ).rejects.toThrow();
  await expect(
    scoped(p, () => new ApiToolExecutorRepo(config).execute({} as never, 'create_word', input)),
  ).rejects.toThrow('canonical_proposal_required');
  const mcp = new ApiManagedMcpRepo(config);
  await expect(scoped(p, () => mcp.schemas())).resolves.toEqual([]);
  await expect(scoped(p, () => mcp.executeRead('anything', {}))).rejects.toThrow(
    'denies dynamic MCP',
  );
  expect(calls).toHaveLength(1);
});
test('real governed-context MAC binds exact original turn into separate trusted scope', async () => {
  const prior = process.env.INTERNAL_SERVICE_SECRET;
  process.env.INTERNAL_SERVICE_SECRET = secret;
  try {
    const p = governedArtifactTestPolicy();
    const identity = {
      tenantId: p.tenantId,
      userId: p.actorUserId,
      clerkUserId: 'synthetic-clerk',
      role: 'standard_user',
    };
    const tenant = {
      tenantId: p.tenantId,
      clerkUserId: identity.clerkUserId,
      role: 'standard_user',
    };
    const input = {
      conversationId: p.conversationId,
      clientId: p.clientId,
      messages: [{ role: 'user', text: MERI_CASE46.prompt }],
    };
    const governed: MeriGovernedTurnContext = {
      version: 1,
      operationId: 'meri.chat',
      prompt: 'verified source',
      contextPacket: {
        packetId: 'packet',
        items: [],
        exclusions: [],
        unauthorizedCount: 0,
        degraded: false,
        clockUse: {
          instant: MERI_FIXTURE_SEMANTIC_INSTANT,
          timeZone: MERI_FIXTURE_SEMANTIC_ZONE,
          eligibilityAt: new Date(p.issuedAt).toISOString(),
          scoring: 'not_run',
        },
      },
      retrieval: {} as MeriGovernedTurnContext['retrieval'],
      evidence: {
        version: 1,
        tenantId: p.tenantId,
        userId: p.actorUserId,
        packetId: 'packet',
        sourceRecordCount: 0,
        projectedRecordCount: 0,
        truncated: false,
        records: [],
      },
      governedArtifactCapturePolicy: p,
      // Synthetic compiler/owner evidence for this MAC transport unit test.
      // Actual case46 clock capture remains a separate acceptance requirement.
      semanticClock: {
        version: 1,
        kind: 'qualified_original_fixture_semantic_clock',
        instant: MERI_FIXTURE_SEMANTIC_INSTANT,
        timeZone: MERI_FIXTURE_SEMANTIC_ZONE,
        caseId: p.caseId,
        captureRunId: p.captureRunId,
        currentVerifySha256: p.currentVerifySha256,
        observedAt: p.issuedAt,
      },
    };
    const run = jest.fn(async () => {
      expect(currentGovernedArtifactCapturePolicy()).toEqual(p);
      return { reply: 'Awaiting approval', steps: [] };
    });
    const instance = new MeriV3Controller(
      { isAllowed: async () => true } as never,
      { resolveIdentity: async () => identity } as never,
      { run } as never,
    );
    await instance.run(
      { ...input, governedContext: attestMeriGovernedContext(governed, input, secret) },
      tenant,
      { headers: { authorization: 'Bearer unit-only' } } as never,
    );
    expect(run).toHaveBeenCalledTimes(1);
    for (const altered of [
      { ...governed, semanticClock: undefined },
      { ...governed, contextPacket: { ...governed.contextPacket, clockUse: undefined } },
      {
        ...governed,
        semanticClock: { ...governed.semanticClock!, currentVerifySha256: 'd'.repeat(64) },
      },
    ]) {
      await expect(
        instance.run(
          { ...input, governedContext: attestMeriGovernedContext(altered, input, secret) },
          tenant,
          { headers: {} } as never,
        ),
      ).rejects.toThrow();
    }
    for (const patch of [
      { messages: [{ role: 'user', text: 'Send email' }] },
      { pageWrite: true },
      { currentTurnImages: [{ mediaType: 'image/png', dataBase64: 'AA==' }] },
      { messages: [...input.messages, ...input.messages] },
    ]) {
      const altered = { ...input, ...patch };
      await expect(
        instance.run(
          { ...altered, governedContext: attestMeriGovernedContext(governed, altered, secret) },
          tenant,
          { headers: {} } as never,
        ),
      ).rejects.toThrow();
    }
    const tampered = attestMeriGovernedContext(governed, input, secret);
    tampered.governedArtifactCapturePolicy = {
      ...p,
      turnId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    };
    await expect(
      instance.run({ ...input, governedContext: tampered }, tenant, { headers: {} } as never),
    ).rejects.toThrow();
    expect(run).toHaveBeenCalledTimes(1);
  } finally {
    if (prior === undefined) delete process.env.INTERNAL_SERVICE_SECRET;
    else process.env.INTERNAL_SERVICE_SECRET = prior;
  }
});
