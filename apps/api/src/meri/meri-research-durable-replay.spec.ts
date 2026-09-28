import { MeriResearchService } from './meri-research.service';
import { researchToolVersion } from './meri-research-durable-result';

const TOOL_SCHEMA = {
  type: 'object',
  properties: { query: { type: 'string' } },
  required: ['query'],
};
const TOOL_VERSION = researchToolVersion(TOOL_SCHEMA);
const ctx = { tenantId: 'tenant-1', userId: 'user-1', tenantSlug: 'tenant' } as never;

function completeMemoryResult(id: string, body = `body-${id}`) {
  const contentHash = `hash-${body}`;
  return {
    tool: 'search_memory',
    coverage: {
      complete: true,
      paginationComplete: true,
      sources: [
        {
          domain: 'institutional_knowledge',
          sourceStatus: 'healthy',
          hasMore: false,
          truncated: false,
          paginationComplete: true,
          coverageComplete: true,
        },
      ],
    },
    factContentUnavailableCount: 0,
    contentStatus: 'available',
    contentTruncated: false,
    nextCursor: null,
    results: [{ id, body }],
    records: [{
      domain: 'institutional_knowledge',
      recordId: id,
      updatedAt: '2026-09-28T00:00:00.000Z',
      provenance: { sourceVersion: 'memory-v1', contentHash },
      payload: {
        sourceKind: 'governed_memory', memoryItemId: id, clientId: null,
        content: { hash: contentHash }, value: body,
      },
    }],
  };
}

function harness() {
  let authorizationAllowed = true;
  let sourceAllowed = true;
  let currentSource = completeMemoryResult('execution-1');
  const artifacts = new Map<string, { bodyText: string }>();
  const session: Record<string, any> = {
    id: 'session-1',
    tenantId: 'tenant-1',
    userId: 'user-1',
    clientId: null,
    title: 'Durable replay',
    topic: 'topic',
    status: 'researching',
    reportArtifactId: null,
    metadata: {
      handoff: {
        version: 1,
        conversationId: 'conversation-1',
        clientId: null,
        messages: [],
        attachments: [],
        reasoningMode: 'deep',
        capturedAt: '2026-09-28T00:00:00.000Z',
      },
      run: {
        id: 'run-1',
        leaseEpoch: 1,
        eventSequence: 0,
        phase: 'research',
        status: 'running',
        stage: 'reading',
        startedAt: '2026-09-28T00:00:00.000Z',
        heartbeatAt: new Date().toISOString(),
      },
    },
  };
  let artifactCounter = 0;
  const tx: any = {
    clioResearchSession: {
      findFirst: jest.fn(async () => session),
    },
    clioConversation: {
      findFirst: jest.fn(async () => (authorizationAllowed ? { id: 'conversation-1' } : null)),
      create: jest.fn(async () => ({ id: 'conversation-created' })),
    },
    clioArtifact: {
      create: jest.fn(async ({ data }: any) => {
        const id = `private-result-${++artifactCounter}`;
        artifacts.set(id, { bodyText: data.bodyText });
        return { id };
      }),
      findFirst: jest.fn(async ({ where }: any) => {
        const value = artifacts.get(where.id);
        return value ? { bodyText: value.bodyText } : null;
      }),
    },
    $queryRawUnsafe: jest.fn(async (...args: any[]) => {
      // query text is arg 0; next_metadata_jsonb is positional arg 10.
      session.metadata = JSON.parse(args[10]);
      return [{ metadata_jsonb: session.metadata }];
    }),
  };
  const prisma: any = {
    withTenant: jest.fn(async (_tenantId: string, callback: any) => callback(tx)),
    withTenantUser: jest.fn(async (_tenantId: string, _userId: string, callback: any) =>
      callback(tx),
    ),
  };
  const tools: any = {
    anthropicToolSchemas: jest.fn(() => [
      { name: 'search_memory', description: 'search', input_schema: TOOL_SCHEMA },
    ]),
    isConcurrencySafe: jest.fn((tool: string) => tool === 'search_memory'),
    execute: jest.fn(async (_ctx: unknown, _tool: string, input: Record<string, unknown>) => {
      if (!sourceAllowed) throw new Error('memory source revoked');
      if (input.query === 'alpha') return completeMemoryResult('execution-a');
      if (input.query === 'beta') return completeMemoryResult('execution-b');
      return currentSource;
    }),
  };
  const service = new MeriResearchService(
    prisma,
    { get: jest.fn() } as never,
    tools,
    {} as never,
    {} as never,
  );
  return {
    service,
    session,
    tx,
    artifacts,
    revoke: () => {
      authorizationAllowed = false;
    },
    revokeSource: () => {
      sourceAllowed = false;
    },
    replaceSource: (result: ReturnType<typeof completeMemoryResult>) => {
      currentSource = result;
    },
    resume: () => {
      session.metadata = {
        ...session.metadata,
        run: {
          ...session.metadata.run,
          id: 'run-2',
          leaseEpoch: 2,
          status: 'running',
          eventSequence: session.metadata.run.eventSequence,
          heartbeatAt: new Date().toISOString(),
        },
      };
    },
  };
}

function outcome(executionId: string, query: string, result = completeMemoryResult(executionId)) {
  return {
    executionId,
    leaseEpoch: 1,
    providerCallId: `provider-${executionId}`,
    tool: 'search_memory',
    toolVersion: TOOL_VERSION,
    input: { query },
    result,
  };
}

describe('Meri durable safe-read commit and replay', () => {
  it('replays the committed owner result after a crash boundary without another execution', async () => {
    const h = harness();
    const toolExecute = jest.fn(async () => completeMemoryResult('execution-1'));
    const executed = await toolExecute();
    await h.service.commitSafeReadOutcome(
      ctx,
      'session-1',
      'run-1',
      outcome('execution-1', 'radar', executed),
    );
    // Simulated crash: no source/result delivery occurs after the commit.
    h.resume();
    const replay = await h.service.replaySafeReadOutcome(ctx, 'session-1', 'run-2', {
      leaseEpoch: 2,
      tool: 'search_memory',
      toolVersion: TOOL_VERSION,
      input: { query: 'radar' },
    });

    expect(replay.replayed).toBe(true);
    expect(replay.result).toEqual(executed);
    expect(toolExecute).toHaveBeenCalledTimes(1);
    expect(h.artifacts.size).toBe(1);
  });

  it('rejects an old run epoch and does not match different exact input', async () => {
    const h = harness();
    await h.service.commitSafeReadOutcome(
      ctx,
      'session-1',
      'run-1',
      outcome('execution-1', 'radar'),
    );
    h.resume();
    await expect(
      h.service.commitSafeReadOutcome(
        ctx,
        'session-1',
        'run-1',
        outcome('late-execution', 'radar'),
      ),
    ).rejects.toThrow('lease');
    await expect(
      h.service.replaySafeReadOutcome(ctx, 'session-1', 'run-2', {
        leaseEpoch: 1,
        tool: 'search_memory',
        toolVersion: TOOL_VERSION,
        input: { query: 'radar' },
      }),
    ).rejects.toThrow('lease');
    await expect(
      h.service.replaySafeReadOutcome(ctx, 'session-1', 'run-2', {
        leaseEpoch: 2,
        tool: 'search_memory',
        toolVersion: TOOL_VERSION,
        input: { query: 'different' },
      }),
    ).resolves.toEqual({ replayed: false });
  });

  it('fails closed when current conversation visibility is revoked', async () => {
    const h = harness();
    await h.service.commitSafeReadOutcome(
      ctx,
      'session-1',
      'run-1',
      outcome('execution-1', 'radar'),
    );
    h.resume();
    h.revoke();
    await expect(
      h.service.replaySafeReadOutcome(ctx, 'session-1', 'run-2', {
        leaseEpoch: 2,
        tool: 'search_memory',
        toolVersion: TOOL_VERSION,
        input: { query: 'radar' },
      }),
    ).rejects.toThrow('conversation');
  });

  it('declines replay when current source authority is revoked or its version changed', async () => {
    const request = {
      leaseEpoch: 2,
      tool: 'search_memory',
      toolVersion: TOOL_VERSION,
      input: { query: 'radar' },
    };
    const revoked = harness();
    await revoked.service.commitSafeReadOutcome(
      ctx, 'session-1', 'run-1', outcome('execution-1', 'radar'),
    );
    revoked.resume();
    revoked.revokeSource();
    await expect(revoked.service.replaySafeReadOutcome(ctx, 'session-1', 'run-2', request))
      .resolves.toEqual({ replayed: false });

    const changed = harness();
    await changed.service.commitSafeReadOutcome(
      ctx, 'session-1', 'run-1', outcome('execution-1', 'radar'),
    );
    changed.resume();
    changed.replaceSource(completeMemoryResult('execution-1', 'corrected body'));
    await expect(changed.service.replaySafeReadOutcome(ctx, 'session-1', 'run-2', request))
      .resolves.toEqual({ replayed: false });
  });

  it('treats an absent or corrupt private result as a replay miss', async () => {
    const h = harness();
    await h.service.commitSafeReadOutcome(
      ctx, 'session-1', 'run-1', outcome('execution-1', 'radar'),
    );
    h.resume();
    const request = {
      leaseEpoch: 2,
      tool: 'search_memory',
      toolVersion: TOOL_VERSION,
      input: { query: 'radar' },
    };
    h.artifacts.clear();
    await expect(h.service.replaySafeReadOutcome(ctx, 'session-1', 'run-2', request))
      .resolves.toEqual({ replayed: false });
    h.artifacts.set('private-result-1', { bodyText: '{corrupt' });
    await expect(h.service.replaySafeReadOutcome(ctx, 'session-1', 'run-2', request))
      .resolves.toEqual({ replayed: false });
  });

  it('keeps same-name invocations separate by execution ID and exact input', async () => {
    const h = harness();
    await h.service.commitSafeReadOutcome(
      ctx,
      'session-1',
      'run-1',
      outcome('execution-a', 'alpha'),
    );
    await h.service.commitSafeReadOutcome(
      ctx,
      'session-1',
      'run-1',
      outcome('execution-b', 'beta'),
    );
    h.resume();
    const replay = await h.service.replaySafeReadOutcome(ctx, 'session-1', 'run-2', {
      leaseEpoch: 2,
      tool: 'search_memory',
      toolVersion: TOOL_VERSION,
      input: { query: 'alpha' },
    });

    expect(replay.replayed).toBe(true);
    expect(replay.durableSafeRead?.executionId).toBe('execution-a');
    expect((replay.result as any).records[0].recordId).toBe('execution-a');
    expect(h.artifacts.size).toBe(2);
  });

  it('does not commit HTTP-200 logical errors or partial owner payloads', async () => {
    const h = harness();
    await expect(
      h.service.commitSafeReadOutcome(ctx, 'session-1', 'run-1', {
        ...outcome('logical-error', 'radar'),
        result: { status: 'error', error: 'upstream logical failure' },
      }),
    ).rejects.toThrow('not a qualified');
    await expect(
      h.service.commitSafeReadOutcome(ctx, 'session-1', 'run-1', {
        ...outcome('partial', 'radar'),
        result: {
          ...completeMemoryResult('partial'),
          nextCursor: 'next',
          coverage: {
            ...completeMemoryResult('partial').coverage,
            complete: false,
          },
        },
      }),
    ).rejects.toThrow('not a qualified');
    expect(h.artifacts.size).toBe(0);
  });

  it('redacts private refs, hashes, inputs, and owner results from the ordinary session response', async () => {
    const h = harness();
    const privateBody = completeMemoryResult('private', 'never expose this owner body');
    await h.service.commitSafeReadOutcome(
      ctx,
      'session-1',
      'run-1',
      outcome('execution-private', 'private query', privateBody),
    );
    const response = await h.service.getSession(ctx, 'session-1');
    const publicJson = JSON.stringify(response.metadata);

    expect(publicJson).not.toContain('private-result-');
    expect(publicJson).not.toContain('private query');
    expect(publicJson).not.toContain('never expose this owner body');
    expect(publicJson).not.toContain('Sha256');
    expect(publicJson).toContain('execution-private');
  });
});
