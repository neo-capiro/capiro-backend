import {
  admitMeriTelemetryContext,
  buildMeriTelemetryEvent,
  createMeriTelemetryContext,
  meriTelemetryIdentifier,
  meriTelemetryOperationId,
  meriTelemetryUsage,
} from './meri-joined-telemetry.js';

const ID = '12345678-abcd-1234-5678-1234567890ab';
describe('Meri joined telemetry', () => {
  test('server identity owns trace admission and hashed identities remain joinable', () => {
    const identity = { tenantId: 'tenant-a', actorId: 'actor-a', conversationId: ID };
    const context = createMeriTelemetryContext({
      ...identity,
      browserRequestId: 'PrivateBrowserLabel',
      callerTraceparent: '00-11111111111111111111111111111111-2222222222222222-01',
    });
    expect(context.traceId).not.toBe(context.callerTraceId);
    expect(admitMeriTelemetryContext(context, identity)).toEqual(context);
    expect(admitMeriTelemetryContext(context, { ...identity, actorId: 'actor-b' })).toBeNull();
    expect(
      admitMeriTelemetryContext(
        { ...context, tenantId: null, actorId: null },
        { tenantId: '', actorId: '' },
      ),
    ).toBeNull();
    expect(JSON.stringify(context)).not.toContain('PrivateBrowserLabel');
  });

  test('preserves UUIDs and hashes explicit noncanonical IDs consistently without truncating collisions', () => {
    expect(meriTelemetryIdentifier(ID)).toBe(ID);
    const hashed = meriTelemetryIdentifier('operation-PrivateClient');
    expect(hashed).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(meriTelemetryIdentifier(hashed)).toBe(hashed);
    expect(meriTelemetryIdentifier('x'.repeat(160) + 'a')).not.toBe(
      meriTelemetryIdentifier('x'.repeat(160) + 'b'),
    );
    expect(meriTelemetryIdentifier('x'.repeat(4097))).toBeNull();
    expect(meriTelemetryOperationId({ operationId: ID })).toBe(ID);
    expect(meriTelemetryOperationId({ operation: { id: ID } })).toBe(ID);
    expect(
      meriTelemetryOperationId({ executionResult: { operationKey: 'operation-PrivateClient' } }),
    ).toBe(hashed);
    expect(meriTelemetryOperationId({ executionResult: { id: ID } })).toBeNull();
    expect(meriTelemetryOperationId({ taskKey: ID, flowId: ID })).toBeNull();
  });

  test('projects bounded source/artifact/operation fields without raw private labels or usage extras', () => {
    const event = buildMeriTelemetryEvent(
      createMeriTelemetryContext({ tenantId: ID, actorId: ID }),
      {
        name: 'meri.tool.finalized',
        boundary: 'orchestrator_tool',
        operationId: 'operation-PrivateClient',
        proposalId: ID,
        artifactIds: ['artifact-PrivateClient', ID],
        sourceRefs: [
          { sourceId: ID, version: 'private-version', hash: 'a'.repeat(64), tool: 'search_memory' },
          { sourceId: 'source-PrivateClient', version: 'v3', hash: 'PrivateHash' },
        ],
        invokedTools: ['search_memory', 'secret@example.test'],
        usage: {
          ...meriTelemetryUsage({ unknownAttempts: 2 }),
          rawPrompt: 'private prompt',
        } as never,
      },
    );
    expect(event.sourceRefs).toEqual([
      {
        sourceId: ID,
        version: meriTelemetryIdentifier('private-version'),
        hash: 'a'.repeat(64),
        tool: 'search_memory',
      },
      {
        sourceId: meriTelemetryIdentifier('source-PrivateClient'),
        version: meriTelemetryIdentifier('v3'),
        hash: null,
        tool: null,
      },
    ]);
    expect(event.proposalId).toBe(ID);
    expect(event.invokedTools).toEqual(['search_memory', 'unknown_tool']);
    const serialized = JSON.stringify(event);
    for (const secret of [
      'PrivateClient',
      'private-version',
      'PrivateHash',
      'secret@example.test',
      'private prompt',
    ])
      expect(serialized).not.toContain(secret);
    expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(16384);
  });

  test.each([{}, 'private revision', -1, 1.5, NaN, Infinity])(
    'rejects invalid goal revision %p',
    (value) => {
      const event = buildMeriTelemetryEvent(
        createMeriTelemetryContext({ tenantId: ID, actorId: ID }),
        {
          name: 'meri.turn',
          boundary: 'turn',
          goalRevision: value as never,
        },
      );
      expect(event.goalRevision).toBeUndefined();
    },
  );
  test.each([3, '3'])('retains numeric goal revisions %p', (value) => {
    expect(
      buildMeriTelemetryEvent(createMeriTelemetryContext({ tenantId: ID, actorId: ID }), {
        name: 'meri.turn',
        boundary: 'turn',
        goalRevision: value,
      }).goalRevision,
    ).toBe(3);
  });
  test('requires both token counts and cost for known usage, preserving reported zero', () => {
    expect(meriTelemetryUsage()).toMatchObject({
      status: 'unknown',
      inputTokens: null,
      outputTokens: null,
      knownEstimatedCostUsd: null,
    });
    expect(meriTelemetryUsage({ inputTokens: 100, knownEstimatedCostUsd: 0 })).toMatchObject({
      status: 'partial',
      outputTokens: null,
    });
    expect(
      meriTelemetryUsage({ inputTokens: 0, outputTokens: 0, knownEstimatedCostUsd: 0 }),
    ).toMatchObject({ status: 'known', inputTokens: 0, outputTokens: 0 });
    expect(
      meriTelemetryUsage({
        inputTokens: 120,
        outputTokens: 45,
        knownEstimatedCostUsd: 0.01,
        unknownAttempts: 1,
      }),
    ).toMatchObject({ status: 'partial', knownEstimatedCostUsd: 0.01, unknownAttempts: 1 });
    expect(
      meriTelemetryUsage({ inputTokens: NaN, outputTokens: -1, unknownAttempts: NaN }),
    ).toMatchObject({
      status: 'unknown',
      inputTokens: null,
      outputTokens: null,
      unknownAttempts: 0,
    });
    expect(meriTelemetryUsage({ inputTokens: 0.1 })).toMatchObject({
      status: 'unknown',
      inputTokens: null,
    });
  });

  test('projects admitted durable identities and known budget values without payloads or authority rebinding', () => {
    const context = createMeriTelemetryContext({ tenantId: ID, actorId: ID });
    const event = buildMeriTelemetryEvent(context, {
      name: 'meri.research.checkpoint',
      boundary: 'research_checkpoint',
      durableRunId: ID,
      researchSessionId: 'private-session',
      authorizedConversationId: 'private-conversation',
      leaseEpoch: 0,
      checkpointSequence: 12,
      cancellationIssuer: 'user',
      terminalReason: 'partial',
      verificationVerdict: 'not_run',
      sourceCoverage: 'partial',
      modelEffort: 'high',
      promptVersion: 'private-prompt-version',
      toolVersion: ID,
      skillVersion: ID,
      artifactVersion: ID,
      remainingBudget: {
        attempts: 0,
        tokens: 20,
        costMicros: null,
        timeMs: 10,
        privatePayload: 'PRIVATE',
      },
      rawPrompt: 'PRIVATE',
      runId: 'forged',
      tenantId: 'forged',
    } as never);
    expect(event).toMatchObject({
      runId: context.runId,
      tenantId: context.tenantId,
      durableRunId: ID,
      researchSessionId: meriTelemetryIdentifier('private-session'),
      authorizedConversationId: meriTelemetryIdentifier('private-conversation'),
      leaseEpoch: 0,
      checkpointSequence: 12,
      cancellationIssuer: 'user',
      terminalReason: 'partial',
      verificationVerdict: 'not_run',
      sourceCoverage: 'partial',
      modelEffort: 'high',
      promptVersion: meriTelemetryIdentifier('private-prompt-version'),
      toolVersion: ID,
      skillVersion: ID,
      artifactVersion: ID,
      remainingBudget: { attempts: 0, tokens: 20, timeMs: 10 },
    });
    expect(event.remainingBudget).toEqual({ attempts: 0, tokens: 20, timeMs: 10 });
    for (const secret of [
      'PRIVATE',
      'private-session',
      'private-conversation',
      'private-prompt-version',
      'forged',
    ])
      expect(JSON.stringify(event)).not.toContain(secret);
  });

  test.each([null, undefined, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '3', {}, []])(
    'omits invalid durable integers and unknown budget quantities %p',
    (value) => {
      const event = buildMeriTelemetryEvent(
        createMeriTelemetryContext({ tenantId: ID, actorId: ID }),
        {
          name: 'meri.research.budget',
          boundary: 'research_budget',
          leaseEpoch: value,
          checkpointSequence: value,
          remainingBudget: { attempts: value, tokens: value, costMicros: value, timeMs: value },
        } as never,
      );
      expect(event.leaseEpoch).toBeUndefined();
      expect(event.checkpointSequence).toBeUndefined();
      expect(event.remainingBudget).toBeUndefined();
    },
  );

  test.each(['private-reason', '', null, {}, ['complete']])(
    'rejects non-enum durable metadata %p',
    (value) => {
      const event = buildMeriTelemetryEvent(
        createMeriTelemetryContext({ tenantId: ID, actorId: ID }),
        {
          name: 'meri.research.run',
          boundary: 'research_run',
          cancellationIssuer: value,
          terminalReason: value,
          verificationVerdict: value,
          sourceCoverage: value,
          modelEffort: value,
        } as never,
      );
      for (const key of [
        'cancellationIssuer',
        'terminalReason',
        'verificationVerdict',
        'sourceCoverage',
        'modelEffort',
      ])
        expect(event[key]).toBeUndefined();
    },
  );
});
