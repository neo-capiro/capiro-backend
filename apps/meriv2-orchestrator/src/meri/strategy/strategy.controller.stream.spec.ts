import type { Request, Response } from 'express';
import type { MeriContext, MeriGovernedTurnContext } from '@capiro/meriv2-core';
import type { OrchestratorTenantContext } from '../../auth/tenant-context.js';
import type { MeriContextResolver } from '../meri-context.resolver.js';
import type { StrategyAssistantService, StrategyDraftOptions } from './strategy-assistant.service.js';
import type { StrategyReportNarrativeService } from './strategy-report-narrative.service.js';
import { StrategyController } from './strategy.controller.js';
import type { StrategyDraftInput } from './strategy-prompt.js';

/*
 * Coverage for the new `POST strategy-draft/stream` route: the NDJSON wire
 * format (one JSON object per '\n'-terminated line: progress*, then result OR
 * error), the chunked/ndjson headers, and disconnect -> AbortSignal wiring.
 * Constructs StrategyController directly with mocked collaborators, mirroring
 * strategy.controller.assurance.spec.ts's convention (no Nest TestingModule).
 */

const TENANT: OrchestratorTenantContext = {
  tenantId: 'tenant-a',
  clerkUserId: 'clerk-a',
  role: 'org:member',
};
const CONTEXT = {
  tenantId: 'tenant-a',
  userId: 'user-a',
  clerkUserId: 'clerk-a',
  role: 'standard_user',
} as MeriContext;

function governedDraft(): MeriGovernedTurnContext {
  return {
    version: 1,
    operationId: 'strategies.generate',
    prompt: 'draft the plan',
    contextPacket: {
      packetId: 'packet-a',
      persisted: true,
      surface: 'strategy',
      clientId: 'client-a',
      items: [],
      exclusions: [],
      unauthorizedCount: 0,
      degraded: false,
    },
    retrieval: {
      plan: {
        version: 1,
        queryClass: 'lookup',
        subjectScope: 'client',
        targetHint: null,
        recipeTool: null,
        requireCompleteCoverage: false,
        requiredDomains: ['clients'],
        timeWindow: null,
      },
      coverage: {
        version: 1,
        complete: true,
        requestedDomains: ['clients'],
        searchedDomains: ['clients'],
        missingDomains: [],
        partialDomains: [],
        requestedEntityCount: 1,
        searchedEntityCount: 1,
        recordsEvaluated: 1,
        recordsReturned: 1,
        paginationComplete: true,
        truncated: false,
        sourceHealth: [],
        unavailableSources: [],
        toolsInvoked: [],
        stopReason: 'complete',
      },
    },
  };
}

function draftInput(): StrategyDraftInput & { governedContext: MeriGovernedTurnContext } {
  return {
    clientId: 'client-a',
    type: 'legislative',
    goal: 'Win the FY28 plus-up',
    governedContext: governedDraft(),
  } as StrategyDraftInput & { governedContext: MeriGovernedTurnContext };
}

/** Minimal fake Express Request: header lookup + a capturable 'close' listener. */
function fakeRequest(): Request & { emitClose: () => void } {
  const closeListeners: Array<() => void> = [];
  const req = {
    headers: { 'x-internal-service-secret': 'phase26-secret' },
    on: (event: string, cb: () => void) => {
      if (event === 'close') closeListeners.push(cb);
      return req;
    },
    emitClose: () => closeListeners.forEach((cb) => cb()),
  };
  return req as unknown as Request & { emitClose: () => void };
}

/** Minimal fake Express Response: captures headers + written NDJSON lines. */
function fakeResponse() {
  const headers: Record<string, string> = {};
  const lines: string[] = [];
  let ended = false;
  const res: Record<string, unknown> = {
    setHeader: (name: string, value: string) => {
      headers[name] = value;
    },
    write: (chunk: string) => {
      lines.push(chunk);
      return true;
    },
    end: () => {
      ended = true;
    },
    on: () => res,
  };
  Object.defineProperty(res, 'writableEnded', { get: () => ended });
  return { res: res as unknown as Response, headers, lines, isEnded: () => ended };
}

describe('StrategyController.draftStream', () => {
  const originalSecret = process.env.INTERNAL_SERVICE_SECRET;

  beforeEach(() => {
    process.env.INTERNAL_SERVICE_SECRET = 'phase26-secret';
  });

  afterAll(() => {
    if (originalSecret === undefined) delete process.env.INTERNAL_SERVICE_SECRET;
    else process.env.INTERNAL_SERVICE_SECRET = originalSecret;
  });

  function build(
    draftImpl: (
      ctx: MeriContext,
      dto: StrategyDraftInput,
      opts?: StrategyDraftOptions,
    ) => Promise<unknown>,
  ) {
    const resolveIdentity = jest.fn().mockResolvedValue({ ...CONTEXT });
    const draft = jest.fn(draftImpl);
    const controller = new StrategyController(
      { resolveIdentity } as unknown as MeriContextResolver,
      { draft } as unknown as StrategyAssistantService,
      { generate: jest.fn() } as unknown as StrategyReportNarrativeService,
    );
    return { controller, resolveIdentity, draft };
  }

  it('sets ndjson/chunked headers and streams progress lines then a result line matching strategy-draft\'s return shape', async () => {
    const { controller } = build(async (_ctx, _dto, opts) => {
      opts?.onProgress?.({ stage: 'drafting', attempt: 1, round: 1, delta: 'Hel' });
      opts?.onProgress?.({ stage: 'drafting', attempt: 1, round: 1, delta: 'lo' });
      return {
        summary: 'A plan.',
        nodes: [{ kind: 'action', subject: 'deliverable', title: 'x', startsOn: '2027-01-01' }],
        provenance: { sections: [], omitted: [] },
        violations: [],
        groundingHealth: { status: 'ok', missingRequired: [], omittedOptional: [] },
      };
    });
    const req = fakeRequest();
    const { res, headers, lines, isEnded } = fakeResponse();

    await controller.draftStream(draftInput(), TENANT, req, res);

    expect(headers['Content-Type']).toBe('application/x-ndjson');
    expect(headers['Transfer-Encoding']).toBe('chunked');
    expect(isEnded()).toBe(true);

    lines.forEach((l) => expect(l.endsWith('\n')).toBe(true));
    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed).toEqual([
      { type: 'progress', stage: 'drafting', attempt: 1, round: 1, delta: 'Hel' },
      { type: 'progress', stage: 'drafting', attempt: 1, round: 1, delta: 'lo' },
      {
        type: 'result',
        summary: 'A plan.',
        nodes: [{ kind: 'action', subject: 'deliverable', title: 'x', startsOn: '2027-01-01' }],
        provenance: { sections: [], omitted: [] },
        violations: [],
        groundingHealth: { status: 'ok', missingRequired: [], omittedOptional: [] },
      },
    ]);
  });

  it('writes a type:"error" line (and still ends the response) when draft() throws', async () => {
    const { controller } = build(async () => {
      throw new Error('pack compile failed');
    });
    const req = fakeRequest();
    const { res, lines, isEnded } = fakeResponse();

    await controller.draftStream(draftInput(), TENANT, req, res);

    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed).toEqual([{ type: 'error', message: 'pack compile failed' }]);
    expect(isEnded()).toBe(true);
  });

  it('aborts the AbortSignal passed to draft() when the request closes early', async () => {
    let capturedSignal: AbortSignal | undefined;
    const { controller, draft } = build(async (_ctx, _dto, opts) => {
      capturedSignal = opts?.signal;
      return { summary: '', nodes: [], provenance: {}, violations: [], groundingHealth: {} };
    });
    const req = fakeRequest();
    const { res } = fakeResponse();

    const pending = controller.draftStream(draftInput(), TENANT, req, res);
    // The 'close' listener is registered synchronously before draftStream's
    // first `await`, so firing it here (before awaiting `pending`) simulates a
    // disconnect that happens while identity resolution / drafting is in flight.
    req.emitClose();
    await pending;

    expect(draft).toHaveBeenCalledTimes(1);
    expect(capturedSignal?.aborted).toBe(true);
  });

  it('rejects a missing internal-service-secret before resolving identity or calling draft()', async () => {
    const { controller, resolveIdentity, draft } = build(async () => ({}));
    const req = { headers: {}, on: () => req } as unknown as Request;
    const { res } = fakeResponse();

    await expect(controller.draftStream(draftInput(), TENANT, req, res)).rejects.toThrow(
      'Strategy governed context must come from the trusted API proxy',
    );
    expect(resolveIdentity).not.toHaveBeenCalled();
    expect(draft).not.toHaveBeenCalled();
  });
});
