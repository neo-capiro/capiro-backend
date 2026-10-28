import { describe, it, expect, jest } from '@jest/globals';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { DocumentAgentService, REVISION_CONFLICT_CODE } from './document-agent.service.js';
import {
  computeOutlineHash,
  createInitialAgentState,
  readAgentState,
  type ContextConflict,
  type DocumentAgentRunSummary,
  type DocumentAgentState,
} from './document-agent-state.js';
import type { NativeGenerationTurnPort } from './native-generation.bridge.js';
import type { DocumentAgentRevisionService } from './document-agent-revision.service.js';

jest.mock('../generation/generation.service.js', () => ({ GenerationService: class {} }));

// WS-22: the five SUPPORTED generated phases MUST go through the approved
// greenfield Meri native owner. These specs pin, with a mocked Prisma and a
// recorder in place of the native owner, that:
//   - the legacy reasoning gateway and GenerationService are NEVER consulted;
//   - the explicit paid intent is the CLOSED body field the service passes on
//     (there is no header-carried intent surface, and none is imported here);
//   - the existing state/revision/proposal owners still make the transition;
//   - scope, ACL and revision are enforced before any paid turn;
//   - an UNKNOWN admission is reported, never retried blind;
//   - without the greenfield owner the phase fails loudly instead of falling back;
//   - cancel addresses the EXACT retained native request AND its local state
//     really lands, while a cancelled compare-and-set claims nothing.
// No network, model, database or clock is touched.
//
// The Prisma mock hands out a DEEP CLONE of the stored config and serialises a
// separate snapshot of the stored row for the compare-and-set, so a filter that
// a mutation modified in place cannot compare to itself. That is the boundary
// the cancel and conflict cases below rely on.

const tenant = 'tenant-1';
const draftId = 'draft-1';
const actor = 'member-1';
const credential = 'session-credential';
const pin = {
  blueprintId: '11111111-1111-4111-8111-111111111111',
  versionId: '22222222-2222-4222-8222-222222222222',
  version: 1,
  definitionHash: 'a'.repeat(64),
};
/** The retained native run a cancel must address: the exact request AND run id. */
const retainedRun: DocumentAgentRunSummary = {
  runId: 'run-retained',
  requestId: `wsgen:${'ab'.repeat(32)}`,
  mode: 'standard',
  startedAt: '2026-10-28T00:00:00.000Z',
  status: 'active',
  stages: [],
};
const openConflict: ContextConflict = {
  id: 'conflict-1',
  itemIds: ['item-1', 'item-2'],
  type: 'numeric',
  description: 'Two figures disagree',
  recommendedResolution: 'Keep the newer figure',
  resolved: false,
};
const otherConflict: ContextConflict = {
  id: 'conflict-2',
  itemIds: ['item-3'],
  type: 'freshness',
  description: 'A source may be stale',
  recommendedResolution: 'Attach the newer source',
  resolved: false,
};

function fixture(options: { role?: string } = {}) {
  let config: Record<string, unknown> = {};
  const draft = {
    id: draftId,
    tenantId: tenant,
    ownerId: actor,
    clientId: 'client-9',
    updatedAt: new Date(),
  };
  const version = {
    id: pin.versionId,
    blueprintId: pin.blueprintId,
    version: 1,
    definitionHash: pin.definitionHash,
    status: 'published',
    publishedAt: new Date(),
    definition: { sections: [] },
  };
  const db = {
    wsDraft: {
      // A deep clone is handed out, so the object the service may hand back as
      // the compare-and-set filter is never the object the store holds.
      findFirst: jest.fn(
        async ({ where }: { where: { id: string; tenantId: string } }) =>
          where.id === draftId && where.tenantId === tenant
            ? { ...draft, config: structuredClone(config) }
            : null,
      ),
      updateMany: jest.fn(
        async ({
          where,
          data,
        }: {
          where: { config: { equals: unknown } };
          data: { config: Record<string, unknown> };
        }) => {
          // The stored row is serialised separately from the filter: a filter a
          // mutation wrote through in place no longer matches it.
          if (JSON.stringify(where.config.equals) !== JSON.stringify(config)) return { count: 0 };
          config = structuredClone(data.config);
          return { count: 1 };
        },
      ),
    },
    wsContextItem: { findMany: jest.fn(async () => []) },
    wsAgentMessage: { create: jest.fn(), findMany: jest.fn(async () => []) },
    wsAgentProposal: {
      create: jest.fn(async () => ({ id: 'prop-row-1' })),
      findFirst: jest.fn(async () => null),
      findMany: jest.fn(async () => []),
      update: jest.fn(async () => ({})),
    },
    wsBlueprintVersion: {
      findFirst: jest.fn(
        async ({ where }: { where: { id: string; blueprintId: string } }) =>
          where.id === version.id && where.blueprintId === version.blueprintId
            ? { ...version }
            : null,
      ),
    },
  };
  const collaborators = {
    assertCan: jest.fn(
      async (
        _tenant: string,
        _draft: string,
        _actor: string,
        predicate: (role: string) => boolean,
      ) => {
        if (!predicate(options.role ?? 'owner')) throw new ForbiddenException();
      },
    ),
  };
  // The legacy owners: still present in the module, never used by these phases.
  const reasoning = {
    synthesizeBrief: jest.fn(async () => ({})),
    recommendContext: jest.fn(async () => ({})),
    analyzeContext: jest.fn(async () => ({})),
    generateOutline: jest.fn(async () => ({ sections: [] })),
  };
  const generation = {
    generateAllSections: jest.fn(async () => ({})),
    retryFailedSections: jest.fn(async () => ({})),
  };
  // The recorder signatures mirror NativeGenerationTurnPort exactly, so the
  // recorded arguments are typed as the port receives them.
  const createProposal = jest.fn(async (_params: unknown) => ({ proposalId: 'prop-1' }));
  const turn = jest.fn(
    async (request: { requestId: string }, _options: { credential: string; signal?: AbortSignal }) =>
      ({ status: 'unknown', requestId: request.requestId }) as never,
  );
  const readTurn = jest.fn(async (_request: unknown, _credential: string) => null as never);
  const cancel = jest.fn(async (_subject: unknown, _credential: string) => undefined);
  const seed = (over: Partial<DocumentAgentState> = {}) => {
    const state = createInitialAgentState();
    state.revision = 4;
    state.phase = 'brief';
    state.goal = {
      text: 'Defend the program',
      createdAt: '2026-10-28T00:00:00.000Z',
    } as DocumentAgentState['goal'];
    state.brief.objective = 'Secure $5M';
    Object.assign(state, over);
    config = { documentAgent: state };
    return state;
  };
  const build = (
    parts: {
      turn?: NativeGenerationTurnPort | null | undefined;
      proposals?: { createProposal: unknown } | null | undefined;
    } = {},
  ) =>
    new DocumentAgentService(
      db as never,
      collaborators as never,
      reasoning as never,
      generation as never,
      (parts.proposals === undefined
        ? { createProposal }
        : parts.proposals) as unknown as DocumentAgentRevisionService,
      (parts.turn === undefined
        ? { turn, readTurn, cancel }
        : parts.turn) as unknown as NativeGenerationTurnPort,
    );
  return {
    db,
    reasoning,
    generation,
    createProposal,
    turn,
    cancel,
    seed,
    build,
    saved: () => readAgentState(config),
    /** The arguments of the nth persisted config write, as the mock received them. */
    write: (index = 0) =>
      db.wsDraft.updateMany.mock.calls[index]![0] as unknown as {
        where: { config: { equals: Record<string, unknown> } };
        data: { config: Record<string, unknown> };
      },
    /** The mock write surface, stated once (a jest mock at runtime). */
    writeMock: () =>
      db.wsDraft.updateMany as unknown as jest.Mock<
        (args: unknown) => Promise<{ count: number }>
      >,
  };
}

type Fixture = ReturnType<typeof fixture>;

describe('document-agent native generation phases', () => {
  it('synthesizes the brief through the native owner and never the reasoning gateway', async () => {
    const f = fixture();
    f.seed();
    f.turn.mockImplementation(
      async (request: { requestId: string }) =>
        ({
          status: 'complete',
          runId: 'run-1',
          result: {
            brief: {
              objective: 'Secure $5M for the program',
              audience: 'Hill staff',
              assumptions: [],
              provenance: {},
            },
          },
          requestId: request.requestId,
        }) as never,
    );
    const service = f.build();

    const result = await service.synthesizeBrief(tenant, draftId, actor, 4, true, credential);

    expect(f.turn).toHaveBeenCalledTimes(1);
    expect(f.reasoning.synthesizeBrief).not.toHaveBeenCalled();
    // The paid intent is the CLOSED body field the service passes for every
    // supported phase, and the current session credential travels with it.
    const sent = f.turn.mock.calls[0]![0] as unknown as Record<string, unknown>;
    expect(sent.paidGeneration).toBe(true);
    expect(sent.phase).toBe('brief');
    expect(f.turn.mock.calls[0]![1].credential).toBe(credential);
    expect(result.status).toBe('result');
    expect(result.requestId).toMatch(/^wsgen:/);
    expect(f.saved().brief.objective).toBe('Secure $5M for the program');
    // The existing revision owner still makes the transition.
    expect(f.saved().revision).toBe(5);
    expect(result.state.revision).toBe(5);
  });

  it('admits an outline as a pending proposal with the accept-path base hash, without writing it', async () => {
    const f = fixture();
    f.seed({ blueprintPin: { ...pin } as DocumentAgentState['blueprintPin'] });
    f.turn.mockImplementation(
      async (request: { requestId: string }) =>
        ({
          status: 'complete',
          runId: 'run-2',
          result: { outline: [{ id: 's1', title: 'The ask', purpose: 'state it' }] },
          requestId: request.requestId,
        }) as never,
    );
    const service = f.build();

    const result = await service.generateOutline(tenant, draftId, actor, 4, true, credential);

    expect(f.reasoning.generateOutline).not.toHaveBeenCalled();
    expect(f.createProposal).toHaveBeenCalledTimes(1);
    const created = f.createProposal.mock.calls[0]![0] as unknown as Record<string, unknown>;
    expect(created.type).toBe('outline_revision');
    expect(created.baseRevision).toBe(4);
    expect(created.baseHash).toBe(computeOutlineHash(f.saved().outline.sections));
    expect(result.status).toBe('proposed');
    expect(result.proposal).toEqual({ proposalId: 'prop-1' });
    // No autonomous write: the outline is still empty until an editor accepts.
    expect(f.saved().outline.sections).toHaveLength(0);
  });

  it('reports an UNKNOWN document admission with the same request id and never re-issues the turn', async () => {
    const f = fixture();
    f.seed({
      phase: 'generate',
      brief: { ...createInitialAgentState().brief, approvedAt: '2026-10-28T00:00:00.000Z' },
      contextPlan: {
        ...createInitialAgentState().contextPlan,
        approvedAt: '2026-10-28T00:00:00.000Z',
      },
      outline: { ...createInitialAgentState().outline, approvedAt: '2026-10-28T00:00:00.000Z' },
    });
    const service = f.build();

    const result = await service.generate(tenant, draftId, actor, 4, 'standard', true, credential);

    expect(f.turn).toHaveBeenCalledTimes(1);
    expect(f.generation.generateAllSections).not.toHaveBeenCalled();
    expect(result.status).toBe('unknown');
    expect(result.requestId).toMatch(/^wsgen:/);
    // The UNKNOWN admission RETAINS its own request identity — a later status read can
    // only reconcile a run it can address — while starting nothing: no active run, no
    // proposal, no per-unit facts, and no second turn.
    expect(result.run).toMatchObject({
      runId: result.requestId,
      requestId: result.requestId,
      status: 'active',
    });
    expect(result.run?.sectionResults).toBeUndefined();
    expect(result.run?.retry).toBeUndefined();
    expect(f.createProposal).not.toHaveBeenCalled();
    expect(f.saved().generation.activeRunId).toBeUndefined();
  });

  it('enforces tenant scope, ACL and the current revision before spending a turn', async () => {
    const f = fixture();
    f.seed();
    const service = f.build();

    await expect(
      service.synthesizeBrief('other-tenant', draftId, actor, 4, true, credential),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.synthesizeBrief(tenant, draftId, actor, 3, true, credential),
    ).rejects.toBeInstanceOf(ConflictException);
    const reader = fixture({ role: 'viewer' });
    reader.seed();
    await expect(
      reader.build().synthesizeBrief(tenant, draftId, actor, 4, true, credential),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(f.turn).not.toHaveBeenCalled();
    expect(reader.turn).not.toHaveBeenCalled();
  });

  it('answers 503 when the approved native owner is not composed, and never the legacy path', async () => {
    const f = fixture();
    f.seed();
    const service = f.build({ turn: null, proposals: null });

    await expect(
      service.synthesizeBrief(tenant, draftId, actor, 4, true, credential),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(f.turn).not.toHaveBeenCalled();
    expect(f.reasoning.synthesizeBrief).not.toHaveBeenCalled();
    expect(f.generation.generateAllSections).not.toHaveBeenCalled();
  });

  it('refuses a phase without the explicit paid-generation intent', async () => {
    const f = fixture();
    f.seed();
    const service = f.build();

    await expect(
      service.synthesizeBrief(tenant, draftId, actor, 4, false, credential),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(f.turn).not.toHaveBeenCalled();
  });

  it('refuses a phase without the current session credential', async () => {
    const f = fixture();
    f.seed();
    const service = f.build();

    await expect(service.synthesizeBrief(tenant, draftId, actor, 4, true)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(f.turn).not.toHaveBeenCalled();
  });
});

describe('document-agent cancel of the retained native run', () => {
  it('cancels the exact retained request and lands the cancel in ONE write that survives a reload', async () => {
    const f = fixture();
    f.seed({
      phase: 'generate',
      generation: { mode: 'standard', activeRunId: retainedRun.runId, lastRun: { ...retainedRun } },
    });
    const service = f.build();

    const cancelled = await service.cancelGeneration(tenant, draftId, actor, 4, credential);

    // The native cancel addresses the EXACT retained request AND run identity,
    // with the current credential, before any local write.
    expect(f.cancel).toHaveBeenCalledTimes(1);
    expect(f.cancel.mock.calls[0]![0]).toEqual({
      requestId: retainedRun.requestId,
      tenantId: tenant,
      actorId: actor,
      draftId,
      clientId: 'client-9',
      runId: retainedRun.runId,
    });
    expect(f.cancel.mock.calls[0]![1]).toBe(credential);

    // EXACTLY one optimistic write, and its filter still describes the row as it
    // was READ: the mutation replaced the nested run summary instead of writing
    // through the object the compare-and-set compares.
    expect(f.db.wsDraft.updateMany).toHaveBeenCalledTimes(1);
    expect(f.write().where.config.equals).toEqual(
      expect.objectContaining({
        documentAgent: expect.objectContaining({
          generation: expect.objectContaining({
            activeRunId: retainedRun.runId,
            lastRun: expect.objectContaining({ status: 'active' }),
          }),
        }),
      }),
    );
    expect(cancelled.state.status).toBe('partial');
    expect(cancelled.state.generation.activeRunId).toBeUndefined();
    expect(cancelled.state.generation.lastRun?.status).toBe('partial');
    expect(cancelled.state.revision).toBe(5);

    // A reload reads the cancel the caller asked for, not the pre-cancel state.
    const reloaded = await service.getAgentState(tenant, draftId, actor);
    expect(reloaded.state.status).toBe('partial');
    expect(reloaded.state.generation.activeRunId).toBeUndefined();
    expect(reloaded.state.generation.lastRun?.status).toBe('partial');
    expect(reloaded.state.generation.lastRun?.requestId).toBe(retainedRun.requestId);
  });

  it('cancels with nothing retained without inventing a run identity', async () => {
    const f = fixture();
    f.seed({ generation: { mode: 'standard' } });
    const service = f.build();

    const cancelled = await service.cancelGeneration(tenant, draftId, actor, 4, credential);

    // Nothing retained means nothing to cancel at the owner, but the local
    // answer is still one write and it clears the pointer.
    expect(f.cancel).not.toHaveBeenCalled();
    expect(f.db.wsDraft.updateMany).toHaveBeenCalledTimes(1);
    expect(cancelled.state.status).toBe('partial');
    expect(cancelled.state.generation.activeRunId).toBeUndefined();
    expect(cancelled.state.generation.lastRun).toBeUndefined();
  });

  it('a failed compare-and-set claims nothing locally, though the native cancel was issued', async () => {
    const f = fixture();
    f.seed({
      phase: 'generate',
      generation: { mode: 'standard', activeRunId: retainedRun.runId, lastRun: { ...retainedRun } },
    });
    const service = f.build();
    f.writeMock().mockResolvedValueOnce({ count: 0 });

    const failure = await service
      .cancelGeneration(tenant, draftId, actor, 4, credential)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ConflictException);
    expect((failure as ConflictException).getResponse()).toMatchObject({
      message: REVISION_CONFLICT_CODE,
    });
    expect(f.cancel).toHaveBeenCalledTimes(1);
    // The stored row is untouched: no partially applied cancel is presented as
    // success, and the retained pointer is still the one the caller must retry.
    const stored = f.saved();
    expect(stored.status).not.toBe('partial');
    expect(stored.generation.activeRunId).toBe(retainedRun.runId);
    expect(stored.generation.lastRun?.status).toBe('active');
    expect(stored.revision).toBe(4);
  });

  it('refuses a stale caller BEFORE the effect: no native cancel, no write, and the newer run stays bound', async () => {
    // The stale tab still holds revision 4 and saw run-A; the row has since
    // advanced to revision 5 and bound a DISTINCT newer run. Both runs differ in
    // requestId AND runId, so a witness cannot pass by cancelling the wrong run.
    const newerRun: DocumentAgentRunSummary = {
      runId: 'run-newer',
      requestId: `wsgen:${'cd'.repeat(32)}`,
      mode: 'standard',
      startedAt: '2026-10-28T00:10:00.000Z',
      status: 'active',
      stages: [],
    };
    const f = fixture();
    f.seed({
      revision: 5,
      generation: { mode: 'standard', activeRunId: newerRun.runId, lastRun: { ...newerRun } },
    });
    const service = f.build();

    const refusal = await service
      .cancelGeneration(tenant, draftId, actor, 4, credential)
      .catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(ConflictException);
    expect((refusal as ConflictException).getResponse()).toMatchObject({
      message: REVISION_CONFLICT_CODE,
    });
    // ZERO native calls and ZERO writes: the refusal happens BEFORE the effect, so
    // the run that is bound now — a run this caller never saw — is never stopped.
    expect(f.cancel).not.toHaveBeenCalled();
    expect(f.db.wsDraft.updateMany).not.toHaveBeenCalled();
    // The row is untouched and still owns the newer run; nothing is claimed local.
    const stored = f.saved();
    expect(stored.revision).toBe(5);
    expect(stored.status).not.toBe('partial');
    expect(stored.generation.activeRunId).toBe(newerRun.runId);
    expect(stored.generation.lastRun?.status).toBe('active');
    expect(stored.generation.lastRun?.requestId).toBe(newerRun.requestId);
  });
});

describe('document-agent context conflict resolution', () => {
  const seedConflicts = (f: Fixture, conflicts: ContextConflict[] = [openConflict, otherConflict]) =>
    f.seed({
      contextPlan: {
        ...createInitialAgentState().contextPlan,
        conflicts,
        includedItemIds: ['item-1', 'item-2', 'item-3'],
      },
    });

  it('replaces only the matched conflict element, and the write survives the compare-and-set', async () => {
    const f = fixture();
    seedConflicts(f);
    const service = f.build();

    const result = await service.resolveContextConflict(
      tenant,
      draftId,
      actor,
      openConflict.id,
      { resolution: 'Keep the newer figure', excludedItemIds: ['item-2'] },
      4,
    );

    // One optimistic write whose filter still describes the row as it was READ.
    expect(f.db.wsDraft.updateMany).toHaveBeenCalledTimes(1);
    expect(f.write().where.config.equals).toEqual(
      expect.objectContaining({
        documentAgent: expect.objectContaining({
          contextPlan: expect.objectContaining({ conflicts: [openConflict, otherConflict] }),
        }),
      }),
    );

    const saved = f.saved();
    expect(saved.contextPlan.conflicts[0]).toMatchObject({
      id: openConflict.id,
      resolved: true,
      resolution: 'Keep the newer figure',
    });
    expect(saved.contextPlan.conflicts[1]).toEqual(otherConflict);
    expect(saved.contextPlan.includedItemIds).toEqual(['item-1', 'item-3']);
    expect(saved.contextPlan.excludedItems).toHaveLength(1);
    expect(result.state.revision).toBe(5);
  });

  it('resolves a conflict with no exclusions and keeps the resolution/ACL/revision contract', async () => {
    const f = fixture();
    seedConflicts(f, [otherConflict]);
    const service = f.build();

    const result = await service.resolveContextConflict(
      tenant,
      draftId,
      actor,
      otherConflict.id,
      { resolution: 'Attach the newer source' },
      4,
    );

    expect(result.state.contextPlan.conflicts).toEqual([
      { ...otherConflict, resolved: true, resolution: 'Attach the newer source' },
    ]);
    expect(result.state.contextPlan.excludedItems).toHaveLength(0);
    // A viewer cannot resolve, and the refusal writes nothing.
    const reader = fixture({ role: 'viewer' });
    seedConflicts(reader);
    await expect(
      reader
        .build()
        .resolveContextConflict(tenant, draftId, actor, openConflict.id, { resolution: 'x' }, 4),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(reader.db.wsDraft.updateMany).not.toHaveBeenCalled();
  });

  it('refuses an unknown or already-resolved conflict without writing', async () => {
    const f = fixture();
    seedConflicts(f, [openConflict, { ...otherConflict, resolved: true, resolution: 'done' }]);
    const service = f.build();

    await expect(
      service.resolveContextConflict(tenant, draftId, actor, 'missing', { resolution: 'x' }, 4),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.resolveContextConflict(tenant, draftId, actor, otherConflict.id, { resolution: 'x' }, 4),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(f.db.wsDraft.updateMany).not.toHaveBeenCalled();
  });
});
