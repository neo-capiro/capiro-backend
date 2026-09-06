import { attestMeriGovernedContext, type MeriGovernedTurnContext } from '@capiro/meriv2-core';
import { currentGovernedMeriContext } from '../meri-governed-context.runtime.js';
import { MeriV3Controller } from './meriv3.controller.js';

const actor = {
  tenantId: 'tenant-1',
  userId: 'user-1',
  clerkUserId: 'clerk-1',
  role: 'standard_user',
};
const tenant = { tenantId: actor.tenantId, clerkUserId: actor.clerkUserId, role: 'standard_user' };
const input = {
  conversationId: 'conversation-1',
  clientId: 'client-1',
  messages: [{ role: 'user', text: 'What is the constraint?' }],
};
const secret = 'controller-test-only-secret';
function context(): MeriGovernedTurnContext {
  return {
    version: 1,
    operationId: 'meri.chat',
    prompt: 'Enacted funding only.',
    contextPacket: {
      packetId: 'packet-1',
      items: [],
      exclusions: [],
      unauthorizedCount: 0,
      degraded: false,
    },
    retrieval: {} as MeriGovernedTurnContext['retrieval'],
    evidence: {
      version: 1,
      tenantId: actor.tenantId,
      userId: actor.userId,
      packetId: 'packet-1',
      sourceRecordCount: 0,
      projectedRecordCount: 0,
      truncated: false,
      records: [],
    },
  };
}

describe('MeriV3 governed context HTTP trust boundary', () => {
  const priorSecret = process.env.INTERNAL_SERVICE_SECRET;
  beforeEach(() => {
    process.env.INTERNAL_SERVICE_SECRET = secret;
  });
  afterEach(() => {
    if (priorSecret === undefined) delete process.env.INTERNAL_SERVICE_SECRET;
    else process.env.INTERNAL_SERVICE_SECRET = priorSecret;
  });
  function controller() {
    const run = jest.fn().mockImplementation(async () => {
      expect(currentGovernedMeriContext()?.evidence?.tenantId).toBe(actor.tenantId);
      return {
        reply: 'Enacted funding only.',
        runtime: 'meriv3',
        model: 'test',
        reasoningMode: 'standard',
        reasoningEffort: 'medium',
        steps: [],
      };
    });
    return {
      run,
      instance: new MeriV3Controller(
        { isAllowed: async () => true } as never,
        { resolveIdentity: async () => ({ ...actor }) } as never,
        { run } as never,
      ),
    };
  }
  it('passes only authenticated API context into the request-local runtime and returns a body-free manifest', async () => {
    const { instance, run } = controller();
    const governedContext = attestMeriGovernedContext(context(), input, secret);
    const result = await instance.run({ ...input, governedContext }, tenant, {
      headers: {},
    } as never);
    expect(run).toHaveBeenCalledTimes(1);
    expect(result.evidenceManifest).toMatchObject({
      packetId: 'packet-1',
      projectedRecordCount: 0,
    });
    expect(result).not.toHaveProperty('governedContext');
    expect(currentGovernedMeriContext()).toBeNull();
  });
  it('rejects unsigned caller-supplied evidence before opening an SSE stream', async () => {
    const { instance, run } = controller();
    const setHeader = jest.fn();
    const on = jest.fn();
    await expect(
      instance.stream(
        { ...input, governedContext: context() },
        tenant,
        { headers: {}, on } as never,
        { setHeader, on } as never,
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(run).not.toHaveBeenCalled();
    expect(setHeader).not.toHaveBeenCalled();
    expect(on).not.toHaveBeenCalled();
  });
  it('does not allow a signed context to move to another conversation', async () => {
    const { instance, run } = controller();
    const governedContext = attestMeriGovernedContext(context(), input, secret);
    await expect(
      instance.run({ ...input, conversationId: 'conversation-2', governedContext }, tenant, {
        headers: {},
      } as never),
    ).rejects.toMatchObject({ status: 403 });
    expect(run).not.toHaveBeenCalled();
  });
});
