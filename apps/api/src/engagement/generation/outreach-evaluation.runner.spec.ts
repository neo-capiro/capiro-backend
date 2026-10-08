import { describe, expect, jest, test } from '@jest/globals';
import type { TenantContext } from '@capiro/shared';
import { OutreachEvaluationRunner, type OutreachEvaluationInput } from './outreach-evaluation.runner.js';
import { GenerationVerifierService } from './generation-verifier.service.js';
import { GATEWAY_PROMPT_SPEC_VERSION } from './gateway-prompt.js';
import { REVISION_JSON_SCHEMA } from './draft-revision.js';
import type { EvidencePacketV2 } from './evidence-packet.types.js';
import type { GenerationRequest } from './generation-gateway.types.js';
import type { OutreachGovernedContext } from './outreach-context-plane.service.js';

const CTX = { tenantId: 't1', tenantSlug: 'tenant', userId: 'u1', clerkUserId: 'clerk_u1', role: 'user' } as unknown as TenantContext;

const CRED = { provider: 'anthropic' as const, apiKey: 'k', model: 'claude-sonnet-4-6', usedTenantKey: false, modelOverridden: false };

function basePacket(over: Partial<EvidencePacketV2> = {}): EvidencePacketV2 {
  return {
    packetId: 'packet-1',
    packetVersion: 2,
    tenantId: 't1',
    userId: 'u1',
    clientId: 'c1',
    surface: 'outreach_email',
    ref: {},
    directives: [],
    evidence: [],
    standingMemory: [],
    standingMemoryExclusions: [],
    failures: [],
    modelPolicy: { provider: 'anthropic', model: 'claude-sonnet-4-6', promptSpecVersion: GATEWAY_PROMPT_SPEC_VERSION },
    criticalFailureCount: 0,
    freshestSourceAt: null,
    stalestSourceAt: null,
    compiledAt: new Date('2026-08-22T00:00:00.000Z').toISOString(),
    packetHash: 'hash',
    emailScope: 'mine',
    ...over,
  } as EvidencePacketV2;
}

function baseRequest(over: Partial<GenerationRequest> = {}): GenerationRequest {
  return {
    surface: 'outreach_email',
    clientId: 'c1',
    outreachRecordId: 'rec-1',
    items: [],
    templateId: 'meeting_request',
    templatePrompt: 'Request a meeting.',
    tone: 'professional',
    direction: 'on-behalf',
    audienceKind: 'individual',
    recipient: {
      generationKey: 'individual:dana',
      scopeKeys: ['dana'],
      recipientKey: 'dana',
      name: 'Dana Reed',
      email: 'dana.reed@mail.house.gov',
      title: 'Representative',
      office: 'House',
      state: 'CA',
      district: '12',
      sourceType: 'congress',
      chamber: 'House',
      snapshot: {},
    },
    now: new Date('2026-08-22T00:00:00.000Z'),
    ...over,
  } as GenerationRequest;
}

function baseGoverned(over: Partial<OutreachGovernedContext> = {}): OutreachGovernedContext {
  return {
    packetId: 'gov-1',
    packet: {
      items: [{ layer: 'user-voice', id: 'm1', type: 'user-voice', slug: 'me', chars: 10 }],
      rendered: [{ layer: 'user-voice', id: 'm1', type: 'user-voice', slug: 'me', body: 'be concise' }],
      exclusions: [],
    },
    kind: 'governed_packet',
    retrievalCompleteness: 'complete',
    retrievalStopReason: 'complete',
    evidence: [],
    standingMemory: [{ layer: 'user-voice', id: 'm1', type: 'user-voice', slug: 'me', chars: 10 } as never],
    standingMemoryExclusions: [],
    failures: [],
    coverage: {
      complete: true,
      requestedDomains: ['clients'],
      searchedDomains: ['clients'],
      missingDomains: [],
      partialDomains: [],
      stopReason: 'complete',
      truncated: false,
      recordsReturned: 0,
    },
    promptBlock: 'COVERAGE:\ncomplete=true',
    ...over,
  } as OutreachGovernedContext;
}

function makeRunner(opts: {
  completeImpl?: () => Promise<{ text: string; usage: unknown }>;
} = {}) {
  const recordDecision = jest.fn(async (_input: Record<string, unknown>) => ({ status: 'recorded' as const, id: 'eval-1' }));
  const markRunning = jest.fn(async (_tenantId: string, _id: string) => undefined);
  const markCompleted = jest.fn(async (_tenantId: string, _id: string, _result: Record<string, unknown>) => undefined);
  const markFailed = jest.fn(async (_tenantId: string, _id: string, _reason: string) => undefined);
  const evaluation = { recordDecision, markRunning, markCompleted, markFailed };

  const compileOutreachPacket = jest.fn(async (_ctx: unknown, req: { governedContext: OutreachGovernedContext }) =>
    basePacket({ standingMemory: (req.governedContext.packet as { items: unknown[] }).items as never }),
  );
  const packets = { compileOutreachPacket };

  const buildPlan = jest.fn(async () => ({
    plan: {
      intent: 'meeting_request',
      jurisdiction: 'federal',
      audienceType: 'congressional_office',
      clientRepresented: 'Aperture',
      desiredOutcome: 'A meeting.',
      whyRecipient: [],
      whyNow: [],
      clientAsk: ['A 20-minute meeting.'],
      supportedClaims: [],
      unsupportedOrRiskyClaims: [],
      tone: 'professional',
      callToAction: 'Could we find 20 minutes?',
      missingCriticalContext: [],
    } as never,
    planModel: 'claude-haiku-4-5-20251001',
    provider: 'anthropic',
    usage: { inputTokens: 10, outputTokens: 5 },
  }));
  const plans = { buildPlan };

  const getProfile = jest.fn(async () => null);
  const renderProfileBlock = jest.fn(() => '');
  const styles = { getProfile, renderProfileBlock };

  const complete = jest.fn(
    opts.completeImpl ??
      (async () => ({
        text: JSON.stringify({ subject: 'Control subject', body: 'Control body', contextNote: '' }),
        usage: { inputTokens: 90, outputTokens: 40 },
      })),
  );
  const llm = { complete };

  const verifier = new GenerationVerifierService();

  const runner = new OutreachEvaluationRunner(
    evaluation as never,
    packets as never,
    plans as never,
    styles as never,
    llm as never,
    verifier,
  );
  return { runner, evaluation, recordDecision, markRunning, markCompleted, markFailed, compileOutreachPacket, complete };
}

function baseInput(over: Partial<OutreachEvaluationInput> = {}): OutreachEvaluationInput {
  return {
    request: baseRequest(),
    enrichment: { channels: [], clientBrief: null, clientName: null, topicTerms: [], auditLedger: [], includeRelevantEmail: false },
    pinned: { provider: 'anthropic', model: 'claude-sonnet-4-6', planModel: 'claude-haiku-4-5-20251001', promptSpecVersion: GATEWAY_PROMPT_SPEC_VERSION } as never,
    pinnedCreds: [CRED] as never,
    governed: baseGoverned(),
    packet: basePacket(),
    plan: { intent: 'meeting_request' } as never,
    styleProfile: null,
    styleSamples: [],
    recipientBrief: 'Name: Dana Reed',
    requestDirectives: [],
    wallAllowsClient: true,
    scanRequired: false,
    treatmentSubject: 'Treatment subject',
    treatmentBody: 'Treatment body text',
    treatmentArtifactId: 'v1',
    treatmentArtifactVersionSeq: 1,
    contextPacketId: 'gov-1',
    ...over,
  };
}

describe('OutreachEvaluationRunner', () => {
  test('revision replay uses the same edit schema and original draft as the product path', async () => {
    process.env.LEARNING_EVALUATION = 'enabled';
    process.env.LEARNING_EVALUATION_SAMPLE_RATE = '1';
    const { runner, complete, markCompleted } = makeRunner({
      completeImpl: async () => ({ text: JSON.stringify({ edits: [{ field: 'body', find: 'government affairs', replacement: 'Lobbying Firm', occurrence: 1 }], contextNote: '' }), usage: {} }),
    });
    await runner.considerAndRun(CTX, baseInput({ request: baseRequest({ existingSubject: 'Keep subject', existingBody: 'Our government affairs team.', reviseInstruction: 'Replace government affairs with Lobbying Firm.' }) }));
    const call = (complete.mock.calls as unknown as Array<[{ jsonSchema: unknown; userVolatile: string }]>)[0]![0];
    expect(call.jsonSchema).toEqual(REVISION_JSON_SCHEMA);
    expect(call.userVolatile).toContain('Replace government affairs with Lobbying Firm.');
    expect(markCompleted).toHaveBeenCalledWith('t1', 'eval-1', expect.objectContaining({ metrics: expect.objectContaining({ controlProducedOutput: true, controlBodyLength: 'Our Lobbying Firm team.'.length }) }));
  });

  const priorEnabled = process.env.LEARNING_EVALUATION;
  const priorRate = process.env.LEARNING_EVALUATION_SAMPLE_RATE;
  afterEach(() => {
    if (priorEnabled === undefined) delete process.env.LEARNING_EVALUATION;
    else process.env.LEARNING_EVALUATION = priorEnabled;
    if (priorRate === undefined) delete process.env.LEARNING_EVALUATION_SAMPLE_RATE;
    else process.env.LEARNING_EVALUATION_SAMPLE_RATE = priorRate;
  });

  test('records nothing while the kill switch is off (dark by default)', async () => {
    delete process.env.LEARNING_EVALUATION;
    const { runner, recordDecision } = makeRunner();
    await runner.considerAndRun(CTX, baseInput());
    expect(recordDecision).not.toHaveBeenCalled();
  });

  test('skips with no_institutional_context when the packet carried nothing to withhold', async () => {
    process.env.LEARNING_EVALUATION = 'enabled';
    process.env.LEARNING_EVALUATION_SAMPLE_RATE = '1';
    const { runner, recordDecision, compileOutreachPacket } = makeRunner();
    await runner.considerAndRun(CTX, baseInput({ governed: baseGoverned({ standingMemory: [] }) }));
    expect(recordDecision).toHaveBeenCalledTimes(1);
    const call = recordDecision.mock.calls[0]?.[0] as { status: string; skipReason: string };
    expect(call.status).toBe('skipped');
    expect(call.skipReason).toBe('no_institutional_context');
    expect(compileOutreachPacket).not.toHaveBeenCalled();
  });

  test('skips with not_sampled at sample rate 0 without running the replay', async () => {
    process.env.LEARNING_EVALUATION = 'enabled';
    process.env.LEARNING_EVALUATION_SAMPLE_RATE = '0';
    const { runner, recordDecision, compileOutreachPacket } = makeRunner();
    await runner.considerAndRun(CTX, baseInput());
    const call = recordDecision.mock.calls[0]?.[0] as { status: string; skipReason: string };
    expect(call.status).toBe('skipped');
    expect(call.skipReason).toBe('not_sampled');
    expect(compileOutreachPacket).not.toHaveBeenCalled();
  });

  test('at sample rate 1: records pending, runs the control replay with institutional items withheld, then marks completed', async () => {
    process.env.LEARNING_EVALUATION = 'enabled';
    process.env.LEARNING_EVALUATION_SAMPLE_RATE = '1';
    const { runner, recordDecision, markRunning, markCompleted, compileOutreachPacket, complete } = makeRunner();
    await runner.considerAndRun(CTX, baseInput());

    expect(recordDecision).toHaveBeenCalledTimes(1);
    expect((recordDecision.mock.calls[0]?.[0] as { status: string }).status).toBe('pending');
    expect(markRunning).toHaveBeenCalledWith('t1', 'eval-1');

    expect(compileOutreachPacket).toHaveBeenCalledTimes(1);
    const compileArgs = compileOutreachPacket.mock.calls[0]?.[1] as { governedContext: OutreachGovernedContext; packetId?: string };
    expect((compileArgs.governedContext.packet as { items: unknown[] }).items).toEqual([]);
    expect(compileArgs.packetId).toBeUndefined();

    expect(complete).toHaveBeenCalledTimes(1);
    expect(markCompleted).toHaveBeenCalledTimes(1);
    const completedArgs = markCompleted.mock.calls[0]?.[2] as { metrics: Record<string, unknown> };
    expect(completedArgs.metrics.controlProducedOutput).toBe(true);
    expect(typeof completedArgs.metrics.normalizedEditDistance).toBe('number');
  });

  test('a replay failure marks the row failed instead of throwing', async () => {
    process.env.LEARNING_EVALUATION = 'enabled';
    process.env.LEARNING_EVALUATION_SAMPLE_RATE = '1';
    const { runner, markFailed, markCompleted } = makeRunner({
      completeImpl: async () => {
        throw new Error('provider timeout');
      },
    });
    await expect(runner.considerAndRun(CTX, baseInput())).resolves.toBeUndefined();
    expect(markFailed).toHaveBeenCalledTimes(1);
    expect(markCompleted).not.toHaveBeenCalled();
  });

  test('a duplicate decision (idempotent retry) never re-runs the replay', async () => {
    process.env.LEARNING_EVALUATION = 'enabled';
    process.env.LEARNING_EVALUATION_SAMPLE_RATE = '1';
    const { runner, compileOutreachPacket } = makeRunner();
    const evaluation = {
      recordDecision: jest.fn(async () => ({ status: 'duplicate', id: 'existing-eval' })),
      markRunning: jest.fn(),
      markCompleted: jest.fn(),
      markFailed: jest.fn(),
    };
    const dupRunner = new OutreachEvaluationRunner(
      evaluation as never,
      { compileOutreachPacket } as never,
      { buildPlan: jest.fn() } as never,
      { getProfile: jest.fn(), renderProfileBlock: jest.fn() } as never,
      { complete: jest.fn() } as never,
      new GenerationVerifierService(),
    );
    await dupRunner.considerAndRun(CTX, baseInput());
    expect(compileOutreachPacket).not.toHaveBeenCalled();
    expect(evaluation.markRunning).not.toHaveBeenCalled();
  });
});
