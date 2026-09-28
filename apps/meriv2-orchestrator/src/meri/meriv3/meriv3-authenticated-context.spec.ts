import { attestMeriGovernedContext, type MeriGovernedTurnContext } from '@capiro/meriv2-core';
import { EventEmitter } from 'node:events';
import { currentGovernedMeriContext } from '../meri-governed-context.runtime.js';
import { currentTrustedCurrentTurnScope } from '../../request/trusted-current-turn-scope.js';
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
      expect(currentTrustedCurrentTurnScope()).toEqual({
        tenantId: actor.tenantId,
        userId: actor.userId,
        conversationId: input.conversationId,
        selectedClientId: input.clientId,
      });
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
  it('establishes the same trusted current-turn scope for authenticated SSE execution', async () => {
    const { instance, run } = controller();
    const req = Object.assign(new EventEmitter(), {
      headers: {},
      aborted: false,
    });
    const frames: string[] = [];
    const res = Object.assign(new EventEmitter(), {
      writableEnded: false,
      destroyed: false,
      setHeader: jest.fn(),
      write: jest.fn((frame: string) => {
        frames.push(frame);
        return true;
      }),
      end: jest.fn(function (this: { writableEnded: boolean }) {
        this.writableEnded = true;
      }),
    });
    const governedContext = attestMeriGovernedContext(context(), input, secret);
    await instance.stream({ ...input, governedContext }, tenant, req as never, res as never);
    expect(run).toHaveBeenCalledTimes(1);
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream');
    expect(frames.some((frame) => frame.includes('"type":"done"'))).toBe(true);
    expect(currentTrustedCurrentTurnScope()).toBeUndefined();
  });
  it('returns later tool receipts with the original signed context, rather than overwriting them with initial coverage', async () => {
    const { instance, run } = controller();
    const ctx = context();
    ctx.retrieval = {
      plan: {
        version: 1,
        queryClass: 'lookup',
        subjectScope: 'client',
        targetHint: null,
        recipeTool: null,
        requireCompleteCoverage: true,
        requiredDomains: ['institutional_knowledge'],
        timeWindow: null,
      },
      coverage: {
        version: 1,
        complete: false,
        requestedDomains: ['institutional_knowledge'],
        searchedDomains: [],
        missingDomains: ['institutional_knowledge'],
        partialDomains: [],
        requestedEntityCount: 1,
        searchedEntityCount: 0,
        recordsReturned: 0,
        recordsEvaluated: 0,
        paginationComplete: false,
        truncated: false,
        sourceHealth: [{ source: 'institutional_knowledge', status: 'error' }],
        unavailableSources: [{ source: 'institutional_knowledge', reason: 'source_error' }],
        toolsInvoked: [],
        stopReason: 'source_error',
      },
    };
    run.mockResolvedValueOnce({
      reply: 'Approved fact',
      toolCoverage: [
        {
          source: 'institutional_knowledge',
          tool: 'search_memory',
          status: 'partial',
          recordsReturned: 3,
          recordsEvaluated: 404,
          paginationComplete: false,
          truncated: false,
        },
      ],
    });
    const result = await instance.run(
      { ...input, governedContext: attestMeriGovernedContext(ctx, input, secret) },
      tenant,
      { headers: {} } as never,
    );
    expect(result.retrieval.coverage).toMatchObject({
      phase: 'turn',
      missingDomains: [],
      partialDomains: ['institutional_knowledge'],
      restoredSources: ['institutional_knowledge'],
      initialContext: { missingDomains: ['institutional_knowledge'] },
      toolReads: [{ recordsReturned: 3, recordsEvaluated: 404 }],
    });
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
