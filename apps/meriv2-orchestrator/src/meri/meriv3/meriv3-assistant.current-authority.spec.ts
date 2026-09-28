import {
  createMeriResearchPlanExecutionEnvelope,
  type MeriContext,
  type ToolRegistry,
} from '@capiro/meriv2-core';
import { RequestCredentialsStore } from '../../request/request-credentials.store.js';
import { MeriV3AssistantService } from './meriv3-assistant.service.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const context = {
  tenantId,
  userId: 'actor-current-authority',
  firmMemory: null,
  userVoice: null,
  clientSteering: null,
  clientRoster: [],
} as unknown as MeriContext;
const researchRun = {
  sessionId: 'session-current-authority',
  runId: 'run-current-authority',
  leaseEpoch: 4,
};
const certificationSchema = {
  name: 'get_certification_status',
  description: 'Read current certification status',
  input_schema: {
    type: 'object',
    properties: { program: { type: 'string' }, query: { type: 'string' } },
  },
};

function input() {
  const plan = {
    version: 1,
    title: 'Verify current certification',
    scope: {
      sessionId: researchRun.sessionId,
      tenantId,
      actorId: context.userId,
      clientId: null,
      conversationId: null,
    },
    budget: { toolCalls: 1, tokens: 1_000 },
    steps: [
      {
        id: 'verify-status',
        objective: 'Verify the current certification status',
        dependsOn: [],
        requiredEvidenceDomains: ['regulatory'],
        allowedCapabilities: ['get_certification_status'],
        effect: 'read',
        completionCondition: 'Status is checked or explicitly unverified',
        budget: { toolCalls: 1, tokens: 1_000 },
      },
    ],
    clarifyingQuestions: [],
  };
  return {
    messages: [{ role: 'user' as const, text: 'Check Acme Cloud FedRAMP status.' }],
    toolPolicy: 'read-only' as const,
    researchRun,
    researchPlanExecution: createMeriResearchPlanExecutionEnvelope({
      plan,
      scope: {
        ...researchRun,
        tenantId,
        actorId: context.userId,
        clientId: null,
        conversationId: null,
      },
      allowedReadCapabilities: ['get_certification_status'],
    }),
  };
}

function response(onComplete?: () => void) {
  return jest.fn(async () => {
    onComplete?.();
    return {
      id: 'response-1',
      status: 'completed',
      output: [],
      outputText: 'Acme Cloud is FedRAMP authorized.',
      functionCalls: [],
      usage: { inputTokens: 5, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 },
      model: 'gpt-5.1',
      usedTenantKey: false,
      incompleteReason: null,
      telemetry: {
        requestedModel: 'gpt-5.1',
        effectiveModel: 'gpt-5.1',
        requestedReasoningEffort: 'medium',
        effectiveReasoningEffort: 'medium',
        reasoningFallbackReasons: [],
        finishReason: 'completed',
        partial: false,
      },
    };
  });
}

function assistant(readOnly: boolean, invoke: jest.Mock, complete: jest.Mock) {
  const definition = { name: certificationSchema.name, readOnly };
  const registry = {
    list: () => [definition.name],
    get: (name: string) => (name === definition.name ? definition : undefined),
    invoke,
    executionMetadata: () => ({
      name: definition.name,
      readOnly,
      executionMode: readOnly ? 'read' : 'approval_required',
      externalEffect: readOnly ? 'none' : 'external_send',
      reversible: readOnly,
      riskTier: readOnly ? 'low' : 'high',
      displayVerb: 'read',
    }),
  } as unknown as ToolRegistry;
  return new MeriV3AssistantService(
    { registry, llm: { completeJson: jest.fn(), completeWithSchema: jest.fn() } } as never,
    { complete } as never,
    { create: jest.fn() } as never,
    {
      withTenant: jest.fn(async (_tenant: string, callback: (tx: unknown) => unknown) =>
        callback({ aiUsageEvent: { create: jest.fn() }, meriAuditLedger: { create: jest.fn() } }),
      ),
    } as never,
    {
      get: (key: string) => (key === 'MERIV2_API_BASE_URL' ? 'http://api.test' : undefined),
    } as never,
  );
}

describe('MeriV3 alternate registry current-authority boundary', () => {
  const originalFetch = global.fetch;
  const originalMode = process.env.MERI_STATUS_PROVENANCE_MODE;
  const originalTenants = process.env.MERI_STATUS_PROVENANCE_TENANTS;
  const originalSurfaces = process.env.MERI_STATUS_PROVENANCE_SURFACES;

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalMode === undefined) delete process.env.MERI_STATUS_PROVENANCE_MODE;
    else process.env.MERI_STATUS_PROVENANCE_MODE = originalMode;
    if (originalTenants === undefined) delete process.env.MERI_STATUS_PROVENANCE_TENANTS;
    else process.env.MERI_STATUS_PROVENANCE_TENANTS = originalTenants;
    if (originalSurfaces === undefined) delete process.env.MERI_STATUS_PROVENANCE_SURFACES;
    else process.env.MERI_STATUS_PROVENANCE_SURFACES = originalSurfaces;
  });

  test.each([
    {
      label: 'absent from the authenticated catalog',
      readOnly: true,
      withdrawAfterProvider: false,
      revokeAfterProvider: false,
      catalogInitially: false,
    },
    {
      label: 'withdrawn from the authenticated catalog',
      readOnly: true,
      withdrawAfterProvider: true,
      revokeAfterProvider: false,
      catalogInitially: true,
    },
    {
      label: 'reclassified as a registry write',
      readOnly: false,
      withdrawAfterProvider: false,
      revokeAfterProvider: false,
      catalogInitially: true,
    },
    {
      label: 'research lease revoked after provider completion',
      readOnly: true,
      withdrawAfterProvider: false,
      revokeAfterProvider: true,
      catalogInitially: true,
    },
  ])('retains an unverified status without registry effects when $label', async (scenario) => {
    process.env.MERI_STATUS_PROVENANCE_MODE = 'enforce';
    process.env.MERI_STATUS_PROVENANCE_TENANTS = tenantId;
    process.env.MERI_STATUS_PROVENANCE_SURFACES = 'research';
    let catalogCurrent = scenario.catalogInitially;
    let active = true;
    const complete = response(() => {
      if (scenario.withdrawAfterProvider) catalogCurrent = false;
      if (scenario.revokeAfterProvider) active = false;
    });
    const invoke = jest.fn(async () => ({ found: false }));
    const instance = assistant(scenario.readOnly, invoke, complete);
    global.fetch = jest.fn(async (url) => {
      if (String(url).endsWith('/tool-schemas')) {
        return new Response(
          JSON.stringify({ schemas: catalogCurrent ? [certificationSchema] : [] }),
          {
            status: 200,
          },
        );
      }
      if (String(url).endsWith('/active')) {
        return new Response(JSON.stringify({ active }), { status: active ? 200 : 409 });
      }
      throw new Error(`Unexpected endpoint: ${String(url)}`);
    });

    const result = await RequestCredentialsStore.run({ bearerToken: 'test-bearer' }, () =>
      instance.run(context, input()),
    );

    expect(complete).toHaveBeenCalledTimes(1);
    expect(invoke).not.toHaveBeenCalled();
    expect(result.reply).toContain('unverified against the FedRAMP Marketplace');
  });

  test.each([true, false])(
    'dispatches a current catalog-selected read only with reservation admission=%s',
    async (dispatchAllowed) => {
      process.env.MERI_STATUS_PROVENANCE_MODE = 'enforce';
      process.env.MERI_STATUS_PROVENANCE_TENANTS = tenantId;
      process.env.MERI_STATUS_PROVENANCE_SURFACES = 'research';
      const complete = response();
      const invoke = jest.fn(async () => ({
        found: true,
        ambiguous: false,
        record: {
          productId: 'acme-cloud',
          cspName: 'Acme',
          csoName: 'Acme Cloud',
          status: 'FedRAMP Authorized',
          sourceUrl: 'https://marketplace.fedramp.gov/products/acme-cloud',
          observedAt: '2026-09-28T00:00:00.000Z',
        },
      }));
      const instance = assistant(true, invoke, complete);
      const reserve = jest.fn(
        async () =>
          new Response(
            JSON.stringify({
              dispatchAllowed,
              reservationId: 'owned-certification-reservation',
            }),
            { status: 200 },
          ),
      );
      global.fetch = jest.fn(async (url) => {
        if (String(url).endsWith('/tool-schemas')) {
          return new Response(JSON.stringify({ schemas: [certificationSchema] }), { status: 200 });
        }
        if (String(url).endsWith('/active')) {
          return new Response(JSON.stringify({ active: true }), { status: 200 });
        }
        if (String(url).endsWith('/safe-read/reservations')) return reserve();
        throw new Error(`Unexpected endpoint: ${String(url)}`);
      });

      const result = await RequestCredentialsStore.run({ bearerToken: 'test-bearer' }, () =>
        instance.run(context, input()),
      );

      expect(reserve).toHaveBeenCalledTimes(1);
      expect(global.fetch).toHaveBeenCalledWith(
        `http://api.test/api/clio/research/${researchRun.sessionId}/runs/${researchRun.runId}/safe-read/reservations`,
        expect.objectContaining({
          method: 'POST',
          body: expect.any(String),
        }),
      );
      const reservationCall = (global.fetch as jest.Mock).mock.calls.find(([url]) =>
        String(url).endsWith('/safe-read/reservations'),
      );
      expect(JSON.parse(reservationCall![1].body)).toEqual(
        expect.objectContaining({
          leaseEpoch: researchRun.leaseEpoch,
          providerCallId: expect.any(String),
          tool: 'get_certification_status',
          input: expect.objectContaining({ program: 'fedramp', query: 'Acme Cloud' }),
        }),
      );
      if (!dispatchAllowed) {
        expect(invoke).not.toHaveBeenCalled();
        expect(result.reply).toContain('unverified against the FedRAMP Marketplace');
        return;
      }
      expect(invoke).toHaveBeenCalledTimes(1);
      expect(reserve.mock.invocationCallOrder[0]).toBeLessThan(invoke.mock.invocationCallOrder[0]!);
      expect(invoke).toHaveBeenCalledWith(
        'get_certification_status',
        expect.objectContaining({ program: 'fedramp', query: 'Acme Cloud' }),
        context,
        expect.any(Object),
      );
      expect(result.reply).toContain('Acme Cloud is FedRAMP Authorized');
      expect(result.reply).not.toContain('unverified against the FedRAMP Marketplace');
    },
  );
});
