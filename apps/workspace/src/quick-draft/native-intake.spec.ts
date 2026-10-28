/**
 * WS-22 durable intake → native owner composition test.
 *
 * These cases drive the REAL production objects — `TwoStepDraftController`,
 * `GenerationRunWorkerService` and `NativeIntakeAdapter` — against an in-memory
 * stand-in for the durability layer and a recording stand-in for the native
 * conversation owner. Nothing here is a helper-only port: every assertion is on
 * what the real code derived, called, persisted or refused.
 *
 * External seams mocked:
 *   * `PrismaService`      — the durable rows (`ws_generation_run`, `ws_draft`,
 *                            `ws_blueprint_version`, `ws_intake`) and the atomic
 *                            lease claim;
 *   * `CollaboratorsService` — the current-access owner;
 *   * `VersionsService`    — the as-generated snapshot;
 *   * `GenerationService`   — asserted NEVER to be called (no legacy provider);
 *   * `NATIVE_GENERATION_TURN` — the one native owner call, recorded.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it, jest, beforeEach } from '@jest/globals';

// The withheld `retry-failed` route still delegates to the legacy provider owner.
// Stubbing that module keeps its (dormant, unbuilt-outside-the-app) dependency
// graph out of this suite's compilation entirely, so nothing here can be
// satisfied by the legacy path — the assertions below require it to be untouched.
jest.mock('../generation/generation.service.js', () => ({
  GenerationService: class GenerationService {},
}));

// The as-generated snapshot is the other stage that reaches a heavyweight
// collaborator; it is mocked at the same boundary (and asserted to run once).
jest.mock('../versions/versions.service.js', () => ({
  VersionsService: class VersionsService {},
}));

import { TwoStepDraftController } from './two-step-draft.controller.js';
import { GenerationRunWorkerService } from './generation-run-worker.service.js';
import { NativeIntakeAdapter } from './native-intake.adapter.js';
import {
  NATIVE_GENERATION_PHASES,
  nativeGenerationRequestId,
  type NativeGenerationTurnOutcome,
  type NativeGenerationTurnPort,
  type NativeGenerationTurnRequest,
} from '../document-agent/native-generation.bridge.js';
import { NativeGenerationOwnerError } from '../document-agent/native-generation-conversation.client.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { CollaboratorsService } from '../collaborators/collaborators.service.js';
import type { GenerationService } from '../generation/generation.service.js';
import type { VersionsService } from '../versions/versions.service.js';
import type { IntakeService } from './intake.service.js';
import type { TwoStepDraftFlagsService } from './two-step-draft-flags.service.js';
import type { IntakeRequestDto } from './dto/intake.dto.js';

const TENANT = '11111111-1111-1111-1111-111111111111';
const DRAFT = '22222222-2222-2222-2222-222222222222';
const RUN = '33333333-3333-3333-3333-333333333333';
const CLIENT = '44444444-4444-4444-4444-444444444444';
const BLUEPRINT_VERSION = '55555555-5555-5555-5555-555555555555';
const ACTOR = 'user_intake_author';
const CREDENTIAL = 'live-session-credential-value';
const REVISION = 4;
const DEFINITION_HASH = 'definition-hash-of-pinned-version-2';

const SECTIONS = [
  { id: 'sec-exec', title: 'Executive Summary' },
  { id: 'sec-design', title: 'Program Design' },
];

/** Server-authorized sources of the FROZEN intake snapshot (ids only). */
const RESOLVED_SOURCES = [
  { id: 'att-fact-1', sourceType: 'factual_attachment' },
  { id: 'draft-prior-1', sourceType: 'prior_workspace_draft' },
  { id: BLUEPRINT_VERSION, sourceType: 'blueprint_version' },
];

/** The exact source set the adapter must derive (blueprint version appears once). */
const EXPECTED_SOURCES = [
  { id: DRAFT, kind: 'workspace-draft' },
  { id: BLUEPRINT_VERSION, kind: 'blueprint-version' },
  { id: CLIENT, kind: 'client' },
  { id: 'att-fact-1', kind: 'factual_attachment' },
  { id: 'draft-prior-1', kind: 'prior_workspace_draft' },
  { id: 'sec-exec', kind: 'outline-section' },
  { id: 'sec-design', kind: 'outline-section' },
];

/**
 * The exact canonical native turn request BYTES this run derives. Derived once
 * from the real adapter (recorded owner call), and re-addressed byte-for-byte by
 * every later current-access read. The Meri leaf's crossing test in
 * `apps/control/conversations/workspace-generation/test/intake-crossing.test.mjs`
 * feeds these same bytes to its real request reader.
 */
const EXACT_NATIVE_REQUEST_JSON =
  '{"tenantId":"11111111-1111-1111-1111-111111111111","actorId":"user_intake_author","draftId":"22222222-2222-2222-2222-222222222222","clientId":"44444444-4444-4444-4444-444444444444","phase":"document","expectedRevision":4,"sources":[{"id":"22222222-2222-2222-2222-222222222222","kind":"workspace-draft"},{"id":"55555555-5555-5555-5555-555555555555","kind":"blueprint-version"},{"id":"44444444-4444-4444-4444-444444444444","kind":"client"},{"id":"att-fact-1","kind":"factual_attachment"},{"id":"draft-prior-1","kind":"prior_workspace_draft"},{"id":"sec-exec","kind":"outline-section"},{"id":"sec-design","kind":"outline-section"}],"paidGeneration":true,"requestId":"wsgen:2c4fbb3a93105400aa1510c5e41e64cb72a3d8017f0f63b94c39a4c396211f14"}';

const intakeRequest: IntakeRequestDto = {
  goal: 'Draft a federal grant proposal for the STEM program',
  blueprintVersionId: BLUEPRINT_VERSION,
  factualAttachmentIds: ['att-fact-1'],
  sampleAttachmentIds: [],
  priorWorkspaceDraftIds: ['draft-prior-1'],
};

type Seed = {
  run: Record<string, unknown>;
  draft: Record<string, unknown>;
  blueprint: Record<string, unknown>;
  intake: Record<string, unknown>;
};

function seed(): Seed {
  return {
    run: {
      id: RUN,
      tenantId: TENANT,
      draftId: DRAFT,
      actorId: ACTOR,
      status: 'queued',
      stage: 'queued',
      agentRevision: 0,
      leaseHolder: null,
      leaseExpiresAt: null,
      attemptCount: 0,
      provider: null,
      model: null,
      reasoningLevel: null,
      sectionStates: {},
      stages: [],
      errorMessage: null,
      startedAt: null,
      completedAt: null,
    },
    draft: {
      id: DRAFT,
      tenantId: TENANT,
      prospectId: null,
      clientId: CLIENT,
      config: {
        docTitle: 'STEM program proposal',
        sections: [],
        sectionContent: {},
        documentAgent: { revision: REVISION },
        quickDraftIntake: {
          schemaVersion: 1,
          intakeId: 'intake-row-1',
          runId: RUN,
          blueprintId: 'bbbbbbbb-1111-1111-1111-111111111111',
          blueprintVersionId: BLUEPRINT_VERSION,
          blueprintVersion: 2,
          blueprintDefinitionHash: DEFINITION_HASH,
        },
      },
    },
    blueprint: {
      id: BLUEPRINT_VERSION,
      version: 2,
      definitionHash: DEFINITION_HASH,
      definition: { sections: SECTIONS },
    },
    intake: {
      id: 'intake-row-1',
      tenantId: TENANT,
      runId: RUN,
      intakeSnapshot: {
        schemaVersion: 1,
        blueprintVersionId: BLUEPRINT_VERSION,
        resolvedSources: { sources: RESOLVED_SOURCES, domainLabels: [] },
      },
    },
  };
}

/** The durable layer, mutated in place exactly as the production code drives it. */
function fakePrisma(state: Seed) {
  const claimAttempts: string[] = [];
  /** Lets a case interleave a competing draft write between this run's own writes. */
  const draftWriteHook: { current: ((state: Seed) => void) | null } = { current: null };
  /** Lets a case land a competing draft write just after one of this run's reads. */
  const draftReadHook: { current: ((state: Seed) => void) | null } = { current: null };
  const prisma = {
    claimAttempts,
    draftWriteHook,
    draftReadHook,
    wsGenerationRun: {
      findFirst: async ({ where }: { where: { id: string; tenantId: string } }) =>
        state.run.id === where.id && state.run.tenantId === where.tenantId ? { ...state.run } : null,
      findUnique: async ({ where }: { where: { id: string } }) =>
        state.run.id === where.id ? { ...state.run } : null,
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        if (state.run.id !== where.id) throw new Error('run not found');
        Object.assign(state.run, data);
        return { ...state.run };
      },
    },
    wsDraft: {
      // A read hands back a COPY of the row, exactly as a database read does: a
      // competing write after the read must not be visible through it (that is
      // what makes the compare-and-set meaningful).
      findFirst: async ({ where }: { where: { id: string; tenantId: string } }) => {
        if (state.draft.id !== where.id || state.draft.tenantId !== where.tenantId) return null;
        const row = structuredClone(state.draft);
        draftReadHook.current?.(state);
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        if (state.draft.id !== where.id) throw new Error('draft not found');
        Object.assign(state.draft, data);
        return { ...state.draft };
      },
      // The compare-and-set the owner's own config writers use: the WHERE clause
      // must match the row's CURRENT config bytes, or nothing is written at all.
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: string; tenantId: string; config: { equals: unknown } };
        data: { config: Record<string, unknown> };
      }) => {
        if (state.draft.id !== where.id || state.draft.tenantId !== where.tenantId) {
          return { count: 0 };
        }
        if (JSON.stringify(where.config.equals) !== JSON.stringify(state.draft.config)) {
          return { count: 0 };
        }
        state.draft.config = structuredClone(data.config);
        draftWriteHook.current?.(state);
        return { count: 1 };
      },
    },
    wsBlueprintVersion: {
      findFirst: async ({ where }: { where: { id: string } }) =>
        state.blueprint.id === where.id ? { ...state.blueprint } : null,
    },
    wsIntake: {
      findFirst: async ({ where }: { where: { tenantId: string; runId: string } }) =>
        state.intake.tenantId === where.tenantId && state.intake.runId === where.runId
          ? { ...state.intake }
          : null,
    },
    // The atomic lease claim, with the same predicate the production SQL uses
    // (worker id, lease seconds, run id — the run id is the last interpolation).
    $executeRaw: async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      const id = String(values[values.length - 1]);
      claimAttempts.push(id);
      if (state.run.id !== id) return 0;
      const status = state.run.status as string;
      const lease = state.run.leaseExpiresAt as Date | null;
      const free = status === 'queued' || (status === 'active' && (lease === null || lease.getTime() < Date.now()));
      if (!free) return 0;
      state.run.status = 'active';
      state.run.leaseHolder = 'test-worker';
      state.run.leaseExpiresAt = new Date(Date.now() + 300_000);
      state.run.attemptCount = (state.run.attemptCount as number) + 1;
      state.run.startedAt = state.run.startedAt ?? new Date();
      return 1;
    },
    $queryRaw: async () => [],
  };
  return prisma as unknown as PrismaService & {
    claimAttempts: string[];
    draftWriteHook: { current: ((state: Seed) => void) | null };
    draftReadHook: { current: ((state: Seed) => void) | null };
  };
}

/** The one native owner call, recorded. */
class RecordingNativeOwner implements NativeGenerationTurnPort {
  readonly turns: NativeGenerationTurnRequest[] = [];
  readonly reads: NativeGenerationTurnRequest[] = [];
  readonly credentials: string[] = [];
  constructor(
    private readonly answer: (
      request: NativeGenerationTurnRequest,
      call: 'turn' | 'read',
      credential: string,
    ) => NativeGenerationTurnOutcome | null,
  ) {}
  async turn(
    request: NativeGenerationTurnRequest,
    options: { credential: string },
  ): Promise<NativeGenerationTurnOutcome> {
    this.turns.push(request);
    this.credentials.push(options.credential);
    const outcome = this.answer(request, 'turn', options.credential);
    if (outcome === null) throw new Error('the recording owner has no turn answer');
    return outcome;
  }
  async readTurn(
    request: NativeGenerationTurnRequest,
    credential: string,
  ): Promise<NativeGenerationTurnOutcome | null> {
    this.reads.push(request);
    this.credentials.push(credential);
    return this.answer(request, 'read', credential);
  }
  async cancel(): Promise<void> {}
}

/** A complete document answer keyed to the request's retained outline sections. */
const documentAnswer = (request: NativeGenerationTurnRequest, runId: string): NativeGenerationTurnOutcome => ({
  status: 'complete',
  runId,
  result: {
    document: {
      sections: request.sources
        .filter((source) => source.kind === 'outline-section')
        .map((source) => ({ id: source.id, text: `<p>Generated body for ${source.id}</p>` })),
    },
  },
});

type Harness = {
  state: Seed;
  prisma: PrismaService & {
    claimAttempts: string[];
    draftWriteHook: { current: ((state: Seed) => void) | null };
    draftReadHook: { current: ((state: Seed) => void) | null };
  };
  worker: GenerationRunWorkerService;
  adapter: NativeIntakeAdapter;
  generation: { generateAllSections: jest.Mock; retryFailedSections: jest.Mock };
  assertCan: jest.Mock;
  versionsCreate: jest.Mock;
};

function harness(
  answer: ConstructorParameters<typeof RecordingNativeOwner>[0],
  options: { composeOwner?: boolean; accessGranted?: boolean } = {},
): Harness & { owner: RecordingNativeOwner } {
  const state = seed();
  const prisma = fakePrisma(state);
  const assertCan = options.accessGranted === false
    ? jest.fn(async () => {
        throw new NativeGenerationOwnerError('authority', 403, 'current access refused');
      })
    : jest.fn(async () => undefined);
  const collaborators = { assertCan } as unknown as CollaboratorsService;
  const generation = {
    generateAllSections: jest.fn(async () => ({}) as never),
    retryFailedSections: jest.fn(async () => ({}) as never),
  } as unknown as GenerationService;
  const versionsCreate = jest.fn(async () => ({}) as never);
  const versions = { create: versionsCreate } as unknown as VersionsService;
  const owner = new RecordingNativeOwner(answer);
  const adapter = new NativeIntakeAdapter(
    prisma,
    collaborators,
    options.composeOwner === false ? null : owner,
  );
  const worker = new GenerationRunWorkerService(prisma, collaborators, generation, versions, adapter);
  return { state, prisma, worker, adapter, owner, generation: generation as never, assertCan, versionsCreate };
}

const runStatusOf = (state: Seed) => state.run.status as string;
const configOf = (state: Seed) => state.draft.config as Record<string, unknown>;
const intakeBlockOf = (state: Seed) =>
  configOf(state).quickDraftIntake as Record<string, unknown>;
const bindingOf = (state: Seed) => intakeBlockOf(state).native as Record<string, unknown> | undefined;
const stagesOf = (state: Seed) => state.run.stages as Array<{ name: string; status: string; detail?: string }>;
const sectionStatesOf = (state: Seed) =>
  state.run.sectionStates as Record<string, { status: string; error?: string; contentHash?: string }>;

describe('WS-22 durable intake → native conversation owner', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('derives the exact canonical request from the run’s retained facts', async () => {
    const h = harness((request, _call, _credential) => documentAnswer(request, 'native-run-1'));
    const { request } = await h.adapter.exactRequest({
      tenantId: TENANT,
      runId: RUN,
      draftId: DRAFT,
      actorId: ACTOR,
    });

    expect(request.phase).toBe('document');
    expect(NATIVE_GENERATION_PHASES).toContain(request.phase);
    expect(request.paidGeneration).toBe(true);
    expect(request.tenantId).toBe(TENANT);
    expect(request.actorId).toBe(ACTOR);
    expect(request.draftId).toBe(DRAFT);
    expect(request.clientId).toBe(CLIENT);
    expect(request.expectedRevision).toBe(REVISION);
    expect(request.sources).toEqual(EXPECTED_SOURCES);
    // The identity is the bridge's own derivation over exactly those facts.
    expect(request.requestId).toBe(
      nativeGenerationRequestId({
        tenantId: TENANT,
        actorId: ACTOR,
        draftId: DRAFT,
        clientId: CLIENT,
        phase: 'document',
        expectedRevision: REVISION,
        sources: EXPECTED_SOURCES,
      }),
    );
    expect(request.requestId).toMatch(/^wsgen:[a-f0-9]{64}$/);
  });

  it('addresses a different retained request when the draft revision has moved (request equality)', async () => {
    const h = harness((request, _call, _credential) => documentAnswer(request, 'native-run-1'));
    const ref = { tenantId: TENANT, runId: RUN, draftId: DRAFT, actorId: ACTOR };
    const before = await h.adapter.exactRequest(ref);
    (configOf(h.state).documentAgent as Record<string, unknown>).revision = REVISION + 1;
    const after = await h.adapter.exactRequest(ref);
    expect(after.request.requestId).not.toBe(before.request.requestId);
    expect(after.request.expectedRevision).toBe(REVISION + 1);
  });

  it('admits exactly one native turn and lands the document in the draft’s own fields', async () => {
    const h = harness((request, _call, _credential) => documentAnswer(request, 'native-run-1'));
    const status = await h.worker.claim(RUN, { credential: CREDENTIAL });

    expect(status).toBe('complete');
    // ONE paid turn, carrying the attended caller's current credential.
    expect(h.owner.turns).toHaveLength(1);
    expect(h.owner.reads).toHaveLength(0);
    expect(h.owner.credentials).toEqual([CREDENTIAL]);
    expect(h.owner.turns[0]!.phase).toBe('document');
    expect(h.owner.turns[0]!.sources).toEqual(EXPECTED_SOURCES);
    // The exact canonical request BYTES Core derived for this durable run: the
    // same bytes every later current-access read re-addresses, and the same bytes
    // the Meri leaf's own crossing test feeds to its real request reader.
    expect(JSON.stringify(h.owner.turns[0])).toBe(EXACT_NATIVE_REQUEST_JSON);
    expect(createHash('sha256').update(EXACT_NATIVE_REQUEST_JSON).digest('hex')).toBe(
      '872204ceede6bedd4e08a7b3175bf8a42374689ae1a64256d90c8400c9654faa',
    );
    // The legacy provider owner is never consulted.
    expect(h.generation.generateAllSections).not.toHaveBeenCalled();
    expect(h.generation.retryFailedSections).not.toHaveBeenCalled();

    // The retained binding records the request identity and the owner's run, and
    // the document landed under the pinned blueprint's section titles.
    expect(bindingOf(h.state)).toMatchObject({
      owner: 'meri-greenfield-native-conversation',
      phase: 'document',
      requestId: h.owner.turns[0]!.requestId,
      nativeRunId: 'native-run-1',
      outcome: 'complete',
      expectedRevision: REVISION,
      sectionIds: ['sec-exec', 'sec-design'],
    });
    expect(configOf(h.state).sections).toEqual(['Executive Summary', 'Program Design']);
    expect(configOf(h.state).sectionContent).toEqual({
      'Executive Summary': '<p>Generated body for sec-exec</p>',
      'Program Design': '<p>Generated body for sec-design</p>',
    });
    expect(sectionStatesOf(h.state)['Executive Summary']!.status).toBe('succeeded');
    expect(sectionStatesOf(h.state)['Executive Summary']!.contentHash).toBeTruthy();
    expect(sectionStatesOf(h.state)['Program Design']!.status).toBe('succeeded');

    // Run telemetry names the real owner, and the durable stage machine finished.
    expect(runStatusOf(h.state)).toBe('complete');
    expect(h.state.run.provider).toBe('meri-greenfield-native-conversation');
    expect(stagesOf(h.state).map((stage) => stage.name)).toEqual([
      'preflight',
      'evidence_plan',
      'narrative_plan',
      'drafting',
      'editorial_pass',
      'assurance',
      'snapshot',
      'complete',
    ]);
    expect(h.versionsCreate).toHaveBeenCalledTimes(1);

    // The current session credential is nowhere in the durable rows.
    expect(JSON.stringify(h.state)).not.toContain(CREDENTIAL);
  });

  it('refuses to draft an intake run without current access — and never claims, calls or falls back', async () => {
    const h = harness((request, _call, _credential) => documentAnswer(request, 'native-run-1'));
    const status = await h.worker.claim(RUN);

    expect(status).toBe('awaiting-current-access');
    expect(h.prisma.claimAttempts).toEqual([]);
    expect(h.owner.turns).toHaveLength(0);
    expect(h.generation.generateAllSections).not.toHaveBeenCalled();
    // The run is untouched: still queued, no lease, no attempt burned.
    expect(runStatusOf(h.state)).toBe('queued');
    expect(h.state.run.attemptCount).toBe(0);
    expect(stagesOf(h.state)).toEqual([]);
  });

  it('records an owner-unavailable refusal instead of any legacy generation', async () => {
    const h = harness((request, _call, _credential) => documentAnswer(request, 'native-run-1'), {
      composeOwner: false,
    });
    const status = await h.worker.claim(RUN, { credential: CREDENTIAL });

    expect(status).toBe('active');
    expect(h.generation.generateAllSections).not.toHaveBeenCalled();
    expect(stagesOf(h.state).at(-1)).toMatchObject({ name: 'drafting', status: 'failed' });
    expect(stagesOf(h.state).at(-1)!.detail).toContain('owner-unavailable');
    expect(String(h.state.run.errorMessage)).toContain('is not composed for this deployment');
    // Not terminal: a deployment that configures the owner can still resolve it.
    expect(h.state.run.completedAt).toBeNull();
  });

  it('records a current-access refusal as non-terminal rather than failing the run', async () => {
    const h = harness((request, _call, _credential) => documentAnswer(request, 'native-run-1'), {
      accessGranted: false,
    });
    const status = await h.worker.claim(RUN, { credential: CREDENTIAL });

    expect(status).toBe('active');
    expect(h.owner.turns).toHaveLength(0);
    expect(h.generation.generateAllSections).not.toHaveBeenCalled();
    expect(String(h.state.run.errorMessage)).toContain('current access refused');
    expect(
      sectionStatesOf(h.state)['Executive Summary']?.status ??
        stagesOf(h.state).at(-1)!.status,
    ).toBeDefined();
  });

  it('honours UNKNOWN by retaining the request, then re-reads the SAME request on an attended status read', async () => {
    let call = 0;
    const h = harness((request, kind) => {
      call += 1;
      // First the turn answers UNKNOWN; the read that follows publishes a result.
      if (kind === 'turn') return { status: 'unknown', requestId: request.requestId };
      return documentAnswer(request, 'native-run-1');
    });
    const intakeStatus = await h.worker.claim(RUN, { credential: CREDENTIAL });
    expect(intakeStatus).toBe('active');
    expect(h.owner.turns).toHaveLength(1);
    expect(call).toBe(1);

    const retainedRequestId = bindingOf(h.state)!.requestId as string;
    expect(bindingOf(h.state)).toMatchObject({ outcome: 'unknown', nativeRunId: null });
    expect(retainedRequestId).toBe(h.owner.turns[0]!.requestId);
    // The run is not terminal, keeps a resumable stage and releases its lease.
    expect(runStatusOf(h.state)).toBe('active');
    expect(h.state.run.completedAt).toBeNull();
    expect((h.state.run.leaseExpiresAt as Date).getTime()).toBe(0);

    // The authoritative read reconciles the SAME stored request.
    const status = await h.worker.getRunStatus(TENANT, RUN, {
      actorId: ACTOR,
      credential: CREDENTIAL,
    });
    expect(h.owner.turns).toHaveLength(1); // no second generation
    expect(h.owner.reads).toHaveLength(1);
    expect(h.owner.reads[0]).toEqual(h.owner.turns[0]); // byte-identical request
    expect(h.owner.reads[0]!.requestId).toBe(retainedRequestId);
    expect(status.status).toBe('complete');
    expect(configOf(h.state).sectionContent).toEqual({
      'Executive Summary': '<p>Generated body for sec-exec</p>',
      'Program Design': '<p>Generated body for sec-design</p>',
    });
  });

  it('does not reconcile (and does not read the owner) for a caller with no current access', async () => {
    const h = harness((request, kind) =>
      kind === 'turn' ? { status: 'unknown', requestId: request.requestId } : documentAnswer(request, 'native-run-1'),
    );
    // One attended admission: the request is issued once and retained UNKNOWN.
    await h.worker.claim(RUN, { credential: CREDENTIAL });
    expect(h.owner.turns).toHaveLength(1);
    expect(h.owner.reads).toHaveLength(0);

    // A revoked caller polls the run: current access is refused by the same owner
    // the interactive route uses, so nothing is read, re-issued or written.
    h.assertCan.mockImplementation(async () => {
      throw new NativeGenerationOwnerError('authority', 403, 'current access refused');
    });
    const status = await h.worker.getRunStatus(TENANT, RUN, {
      actorId: 'user_revoked',
      credential: 'other-callers-credential',
    });
    expect(h.owner.reads).toHaveLength(0);
    expect(h.owner.turns).toHaveLength(1);
    expect(status.status).toBe('active');
    expect(configOf(h.state).sectionContent).toEqual({});
  });

  it('re-issues the SAME request only when the owner confirms it holds none', async () => {
    const h = harness((request, kind) =>
      kind === 'read' ? null : { status: 'unknown', requestId: request.requestId },
    );
    await h.worker.claim(RUN, { credential: CREDENTIAL });
    const firstRequestId = h.owner.turns[0]!.requestId;

    await h.worker.claim(RUN, { credential: CREDENTIAL });
    expect(h.owner.reads).toHaveLength(1);
    expect(h.owner.turns).toHaveLength(2);
    expect(h.owner.turns[1]).toEqual(h.owner.turns[0]);
    expect(h.owner.turns[1]!.requestId).toBe(firstRequestId);
  });

  it('reports a failed native run terminally and writes no content', async () => {
    const h = harness(() => ({ status: 'failed', runId: 'native-run-9', state: 'failed' }));
    const status = await h.worker.claim(RUN, { credential: CREDENTIAL });

    expect(status).toBe('failed');
    expect(configOf(h.state).sections).toEqual([]);
    expect(configOf(h.state).sectionContent).toEqual({});
    expect(sectionStatesOf(h.state)['Executive Summary']!.status).toBe('failed');
    expect(bindingOf(h.state)).toMatchObject({ outcome: 'failed', nativeRunId: 'native-run-9' });
    expect(h.generation.generateAllSections).not.toHaveBeenCalled();
  });

  it('refuses an answer that does not key the pinned blueprint sections', async () => {
    const h = harness((request) => ({
      status: 'complete',
      runId: 'native-run-3',
      result: {
        document: {
          sections: request.sources
            .filter((source) => source.kind === 'outline-section')
            .map((source) => ({ id: `${source.id}-wrong`, text: 'body' })),
        },
      },
    }));
    const status = await h.worker.claim(RUN, { credential: CREDENTIAL });

    expect(status).toBe('failed');
    expect(configOf(h.state).sectionContent).toEqual({});
    expect(String(h.state.run.errorMessage)).toContain('did not key the pinned blueprint sections');
    expect(stagesOf(h.state).at(-1)!.detail).toContain('answer-mismatch');
  });

  it('refuses a run whose pinned blueprint bytes no longer match the retained hash', async () => {
    const h = harness((request, _call, _credential) => documentAnswer(request, 'native-run-1'));
    h.state.blueprint.definitionHash = 'definition-hash-of-later-version';
    const status = await h.worker.claim(RUN, { credential: CREDENTIAL });

    expect(status).toBe('failed');
    expect(h.owner.turns).toHaveLength(0);
    expect(String(h.state.run.errorMessage)).toContain('no longer matches the definition hash');
  });

  it('refuses to record a retained request when the draft was edited while the turn was in flight — and never issues a second paid turn', async () => {
    const h = harness((request, call) => {
      if (call === 'turn') {
        // The human's save lands while the native turn is in flight, so the next
        // draft read — the binding write's own snapshot — is already stale by the
        // time that write is attempted.
        h.prisma.draftReadHook.current = (state) => {
          const config = state.draft.config as Record<string, unknown>;
          config.sectionContent = { 'Human note': '<p>typed while the run was in flight</p>' };
          config.docTitle = 'STEM program proposal (edited)';
          h.prisma.draftReadHook.current = null;
        };
      }
      return documentAnswer(request, 'native-run-1');
    });

    const status = await h.worker.claim(RUN, { credential: CREDENTIAL });

    // The write that records the request identity is refused by the config
    // compare-and-set, so the run stops instead of continuing with a request
    // nobody can address again.
    expect(status).toBe('failed');
    expect(bindingOf(h.state)).toBeUndefined();
    expect(configOf(h.state).sectionContent).toEqual({
      'Human note': '<p>typed while the run was in flight</p>',
    });
    expect(configOf(h.state).docTitle).toBe('STEM program proposal (edited)');
    expect(configOf(h.state).sections).toEqual([]);
    expect(stagesOf(h.state).at(-1)!.detail).toContain('config conflict');
    expect(sectionStatesOf(h.state)['Executive Summary']).toMatchObject({ status: 'failed' });
    expect(runStatusOf(h.state)).toBe('failed');

    // Terminal, so no later pass can re-drive this run into a second paid turn.
    const again = await h.worker.claim(RUN, { credential: CREDENTIAL });
    expect(again).toBe('busy');
    expect(h.owner.turns).toHaveLength(1);
    expect(h.owner.reads).toHaveLength(0);
  });

  it('preserves a concurrent human edit instead of writing the generated body, then lands it from the retained replay', async () => {
    const h = harness((request, _call, _credential) => documentAnswer(request, 'native-run-1'));
    // The human's save lands AFTER the request identity was retained and
    // immediately after the generated body's own snapshot read — the copy that
    // read hands back is already taken, so the save leaves that snapshot stale
    // against the compare-and-set it feeds and the body write is refused instead
    // of silently applied over the human's work. The result path takes exactly
    // ONE draft read after the binding (the body snapshot its write compares
    // against), so the FIRST post-binding read is the window this case targets.
    h.prisma.draftWriteHook.current = () => {
      h.prisma.draftWriteHook.current = null;
      h.prisma.draftReadHook.current = (state) => {
        state.draft.config = {
          ...(state.draft.config as Record<string, unknown>),
          sectionContent: { 'Human note': '<p>typed between the two writes</p>' },
        };
        h.prisma.draftReadHook.current = null;
      };
    };

    const status = await h.worker.claim(RUN, { credential: CREDENTIAL });

    // Nothing of the answer landed, the human's bytes are intact, and the run is
    // left resumable rather than half-written.
    expect(status).toBe('active');
    expect(configOf(h.state).sectionContent).toEqual({
      'Human note': '<p>typed between the two writes</p>',
    });
    expect(configOf(h.state).sections).toEqual([]);
    expect(sectionStatesOf(h.state)['Executive Summary']!.status).toBe('failed');
    expect(stagesOf(h.state).at(-1)!.detail).toContain('content not written');
    expect(bindingOf(h.state)).toMatchObject({ outcome: 'complete', nativeRunId: 'native-run-1' });
    expect((h.state.run.leaseExpiresAt as Date).getTime()).toBe(0);

    // The RETAINED request — never a new one — is what a later attended pass
    // reads, and the body lands then, merged with the human's own content.
    const resumed = await h.worker.getRunStatus(TENANT, RUN, {
      actorId: ACTOR,
      credential: CREDENTIAL,
    });
    expect(resumed.status).toBe('complete');
    expect(h.owner.turns).toHaveLength(1);
    expect(h.owner.reads).toHaveLength(1);
    expect(h.owner.reads[0]!.requestId).toBe(h.owner.turns[0]!.requestId);
    expect(configOf(h.state).sectionContent).toEqual({
      'Human note': '<p>typed between the two writes</p>',
      'Executive Summary': '<p>Generated body for sec-exec</p>',
      'Program Design': '<p>Generated body for sec-design</p>',
    });
  });

  it('refuses a pinned blueprint whose sections do not have unique titles before any native call', async () => {
    const h = harness((request, _call, _credential) => documentAnswer(request, 'native-run-1'));
    // Two sections of the pinned version carry the same title. The document body
    // is keyed by title, so one section's body would silently replace the other's.
    h.state.blueprint.definition = {
      sections: [
        { id: 'sec-exec', title: 'Executive Summary' },
        { id: 'sec-design', title: 'Executive Summary' },
      ],
    };

    const status = await h.worker.claim(RUN, { credential: CREDENTIAL });

    expect(status).toBe('failed');
    expect(h.owner.turns).toHaveLength(0);
    expect(h.owner.reads).toHaveLength(0);
    expect(String(h.state.run.errorMessage)).toContain('more than one section titled');
    expect(stagesOf(h.state).at(-1)!.detail).toContain('blueprint-ambiguous-titles');
    // Nothing was written, and the retained ids / pinned hash / order are untouched.
    expect(bindingOf(h.state)).toBeUndefined();
    expect(configOf(h.state).sectionContent).toEqual({});
    expect(configOf(h.state).sections).toEqual([]);
    expect(sectionStatesOf(h.state)).toEqual({});
    expect(h.state.draft.config).toMatchObject({
      quickDraftIntake: { blueprintVersionId: BLUEPRINT_VERSION, blueprintDefinitionHash: DEFINITION_HASH },
    });
  });

  it('describes the marker stages as what they are — one document turn, no per-stage call', async () => {
    const h = harness((request, _call, _credential) => documentAnswer(request, 'native-run-1'));
    const status = await h.worker.claim(RUN, { credential: CREDENTIAL });
    expect(status).toBe('complete');

    for (const name of ['evidence_plan', 'narrative_plan', 'editorial_pass', 'assurance']) {
      const stage = stagesOf(h.state).find((entry) => entry.name === name)!;
      expect(stage.detail).toContain('single native document turn');
      expect(stage.detail).not.toContain('delegated');
    }
    // The real work is unchanged: exactly one document turn and one snapshot.
    expect(h.owner.turns.map((request) => request.phase)).toEqual(['document']);
    expect(h.versionsCreate).toHaveBeenCalledTimes(1);
  });

  it('never derives a second paid request for a run that already retained one (draft moved after the run started)', async () => {
    // The owner's own journal holds the FIRST request only: any other identity is
    // answered with null — "I hold no run for that request".
    const held = { requestId: '' };
    const h = harness((request, call, _credential) => {
      if (call === 'turn') {
        held.requestId = held.requestId || request.requestId;
        return { status: 'unknown', requestId: request.requestId };
      }
      return request.requestId === held.requestId
        ? { status: 'unknown', requestId: request.requestId }
        : null;
    });
    // These intake runs start at documentAgent revision 0, where the drafting
    // revision guard is inert (the run keeps agentRevision 0).
    (configOf(h.state).documentAgent as Record<string, unknown>).revision = 0;
    h.state.run.agentRevision = 0;

    const claimed = await h.worker.claim(RUN, { credential: CREDENTIAL });
    expect(claimed).toBe('active');
    expect(h.owner.turns).toHaveLength(1);
    const retainedRequestId = h.owner.turns[0]!.requestId;
    expect(bindingOf(h.state)!.requestId).toBe(retainedRequestId);

    // An ordinary attended pass on the UNCHANGED draft still continues from the
    // SAME retained request — the same identity is re-read, not re-issued.
    const sameDraft = await h.worker.getRunStatus(TENANT, RUN, {
      actorId: ACTOR,
      credential: CREDENTIAL,
    });
    expect(sameDraft.status).toBe('active');
    expect(h.owner.turns).toHaveLength(1);
    expect(h.owner.reads).toHaveLength(1);
    expect(h.owner.reads[0]!.requestId).toBe(retainedRequestId);
    expect(bindingOf(h.state)!.requestId).toBe(retainedRequestId);
    // From here on nothing may write this binding.
    const retainedBytes = JSON.stringify(bindingOf(h.state));

    // A human save moves the draft's revision. The run's captured revision is 0,
    // so the drafting guard cannot catch this: the request Core derives now has a
    // DIFFERENT identity from the one this run retained.
    (configOf(h.state).documentAgent as Record<string, unknown>).revision = 1;
    (configOf(h.state).sectionContent as Record<string, string>)['Human note'] =
      '<p>typed after the paid request went out</p>';

    const afterEdit = await h.worker.getRunStatus(TENANT, RUN, {
      actorId: ACTOR,
      credential: CREDENTIAL,
    });

    // Refused before ANY owner call: no second paid turn, no read of a re-derived
    // identity, and the original binding is exactly as it was retained.
    expect(h.owner.turns).toHaveLength(1);
    expect(h.owner.reads).toHaveLength(1);
    expect(afterEdit.status).toBe('failed');
    expect(JSON.stringify(bindingOf(h.state))).toBe(retainedBytes);
    expect(stagesOf(h.state).at(-1)!.detail).toContain('retained-request-mismatch');
    expect(sectionStatesOf(h.state)['Executive Summary']).toMatchObject({ status: 'failed' });
    // The human's own bytes are untouched, and the terminal run cannot be claimed
    // again into any further native work.
    expect(configOf(h.state).documentAgent).toMatchObject({ revision: 1 });
    expect(configOf(h.state).sectionContent).toMatchObject({
      'Human note': '<p>typed after the paid request went out</p>',
    });
    expect(await h.worker.claim(RUN, { credential: CREDENTIAL })).toBe('busy');
    expect(h.owner.turns).toHaveLength(1);
  });

  it('keeps a save that lands between the request identity and the body’s compare-and-set', async () => {
    const h = harness((request, _call, _credential) => documentAnswer(request, 'native-run-1'));
    // The human's save lands in exactly the window the previous shape left open:
    // after the request identity was retained and at the body's own read — the
    // read whose bytes the write is compared against.
    h.prisma.draftWriteHook.current = () => {
      h.prisma.draftWriteHook.current = null;
      h.prisma.draftReadHook.current = (state) => {
        state.draft.config = {
          ...(state.draft.config as Record<string, unknown>),
          sectionContent: { 'Human note': '<p>typed between the two reads</p>' },
        };
        h.prisma.draftReadHook.current = null;
      };
    };

    const status = await h.worker.claim(RUN, { credential: CREDENTIAL });

    // The save survived: nothing was written over it, and the run is left
    // resumable instead of silently dropping the human's section.
    expect(status).toBe('active');
    expect(configOf(h.state).sectionContent).toEqual({
      'Human note': '<p>typed between the two reads</p>',
    });
    expect(configOf(h.state).sections).toEqual([]);
    expect(sectionStatesOf(h.state)['Executive Summary']!.status).toBe('failed');
    expect(stagesOf(h.state).at(-1)!.detail).toContain('content not written');

    // The SAME retained request is what the later attended pass reads, and the
    // body then lands MERGED with the human's own entry.
    const resumed = await h.worker.getRunStatus(TENANT, RUN, {
      actorId: ACTOR,
      credential: CREDENTIAL,
    });
    expect(resumed.status).toBe('complete');
    expect(h.owner.turns).toHaveLength(1);
    expect(h.owner.reads).toHaveLength(1);
    expect(h.owner.reads[0]!.requestId).toBe(h.owner.turns[0]!.requestId);
    expect(configOf(h.state).sectionContent).toEqual({
      'Human note': '<p>typed between the two reads</p>',
      'Executive Summary': '<p>Generated body for sec-exec</p>',
      'Program Design': '<p>Generated body for sec-design</p>',
    });
  });

  it('does not consult the legacy provider for a durable-intake run on the retry-failed route', async () => {
    const h = harness((request, kind) =>
      kind === 'turn'
        ? { status: 'unknown', requestId: request.requestId }
        : documentAnswer(request, 'native-run-1'),
    );
    await h.worker.claim(RUN, { credential: CREDENTIAL });
    expect(h.owner.turns).toHaveLength(1);

    await h.worker.retryFailedSections(TENANT, RUN, ACTOR);

    // This run's drafting is served by the native owner, so the legacy provider
    // owner is not reachable from its retry route at all.
    expect(h.generation.retryFailedSections).not.toHaveBeenCalled();
    expect(h.generation.generateAllSections).not.toHaveBeenCalled();
    expect(h.owner.turns).toHaveLength(1);
  });
});

describe('WS-22 attended intake boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const context = { tenantId: TENANT, clerkUserId: ACTOR } as never;

  function controller(h: Harness, receipt: Record<string, unknown>) {
    const intakeService = {
      createIntake: jest.fn(async () => receipt as never),
    } as unknown as IntakeService;
    const flags = { isTwoStepDraftEnabled: jest.fn(async () => true) } as unknown as TwoStepDraftFlagsService;
    return {
      intakeService,
      controller: new TwoStepDraftController(intakeService, h.worker, flags),
    };
  }

  it('forwards the request’s own Bearer credential into the one native turn and returns the durable receipt', async () => {
    const h = harness((request, _call, _credential) => documentAnswer(request, 'native-run-1'));
    const receipt = { draftId: DRAFT, runId: RUN, status: 'queued', agentRevision: REVISION };
    const { controller: api, intakeService } = controller(h, receipt);

    const answer = await api.createIntake(context, 'idem-key-0001', intakeRequest, `Bearer ${CREDENTIAL}`);

    expect(answer).toBe(receipt);
    expect(intakeService.createIntake).toHaveBeenCalledWith(TENANT, ACTOR, 'idem-key-0001', intakeRequest);
    expect(h.owner.credentials).toEqual([CREDENTIAL]);
    expect(h.owner.turns).toHaveLength(1);
  });

  it('leaves the run for an attended caller when the request carries no credential', async () => {
    const h = harness((request, _call, _credential) => documentAnswer(request, 'native-run-1'));
    const receipt = { draftId: DRAFT, runId: RUN, status: 'queued', agentRevision: REVISION };
    const { controller: api } = controller(h, receipt);

    await api.createIntake(context, 'idem-key-0002', intakeRequest, undefined);

    expect(h.owner.turns).toHaveLength(0);
    expect(h.prisma.claimAttempts).toEqual([]);
    expect(runStatusOf(h.state)).toBe('queued');
  });

  it('replays an intake without dispatching a second paid run', async () => {
    const h = harness((request, _call, _credential) => documentAnswer(request, 'native-run-1'));
    const receipt = { draftId: DRAFT, runId: RUN, status: 'queued', agentRevision: REVISION };
    const { controller: api } = controller(h, receipt);

    await api.createIntake(context, 'idem-key-0003', intakeRequest, `Bearer ${CREDENTIAL}`);
    await api.createIntake(context, 'idem-key-0003', intakeRequest, `Bearer ${CREDENTIAL}`);

    // The replayed receipt is the same one, the run is terminal, and the owner
    // sees exactly one turn for this exact request identity.
    expect(h.owner.turns).toHaveLength(1);
    expect(h.owner.reads).toHaveLength(0);
  });

  it('reconciles a retained request from the status read, never from a new turn', async () => {
    const h = harness((request, kind) =>
      kind === 'turn' ? { status: 'unknown', requestId: request.requestId } : documentAnswer(request, 'native-run-1'),
    );
    const receipt = { draftId: DRAFT, runId: RUN, status: 'queued', agentRevision: REVISION };
    const { controller: api } = controller(h, receipt);
    await api.createIntake(context, 'idem-key-0004', intakeRequest, `Bearer ${CREDENTIAL}`);

    const status = await api.getRunStatus(context, RUN, `Bearer ${CREDENTIAL}`);
    expect(status.status).toBe('complete');
    expect(h.owner.turns).toHaveLength(1);
    expect(h.owner.reads).toHaveLength(1);
    expect(h.owner.reads[0]!.requestId).toBe(h.owner.turns[0]!.requestId);
  });

  it('continues a durable-intake retry from the RETAINED request with the caller’s own credential', async () => {
    const h = harness((request, kind) =>
      kind === 'turn'
        ? { status: 'unknown', requestId: request.requestId }
        : documentAnswer(request, 'native-run-1'),
    );
    const receipt = { draftId: DRAFT, runId: RUN, status: 'queued', agentRevision: REVISION };
    const { controller: api } = controller(h, receipt);
    await api.createIntake(context, 'idem-key-0005', intakeRequest, `Bearer ${CREDENTIAL}`);
    expect(h.owner.turns).toHaveLength(1);

    const answer = await api.retryFailed(context, RUN, `Bearer ${CREDENTIAL}`);

    // The response keeps its shape; the status is the run's real one.
    expect(answer).toEqual({ runId: RUN, status: 'complete' });
    // The SAME retained request was re-read with this caller's credential: no
    // second paid turn, and the legacy provider was never consulted.
    expect(h.owner.turns).toHaveLength(1);
    expect(h.owner.reads).toHaveLength(1);
    expect(h.owner.reads[0]!.requestId).toBe(h.owner.turns[0]!.requestId);
    expect(h.generation.retryFailedSections).not.toHaveBeenCalled();
    expect(h.generation.generateAllSections).not.toHaveBeenCalled();
    expect(configOf(h.state).sectionContent).toEqual({
      'Executive Summary': '<p>Generated body for sec-exec</p>',
      'Program Design': '<p>Generated body for sec-design</p>',
    });
  });

  it('leaves a durable-intake retry untouched when the request carries no credential', async () => {
    const h = harness((request, kind) =>
      kind === 'turn'
        ? { status: 'unknown', requestId: request.requestId }
        : documentAnswer(request, 'native-run-1'),
    );
    const receipt = { draftId: DRAFT, runId: RUN, status: 'queued', agentRevision: REVISION };
    const { controller: api } = controller(h, receipt);
    await api.createIntake(context, 'idem-key-0006', intakeRequest, `Bearer ${CREDENTIAL}`);

    const answer = await api.retryFailed(context, RUN);

    expect(answer).toEqual({ runId: RUN, status: 'awaiting-current-access' });
    expect(h.owner.reads).toHaveLength(0);
    expect(h.owner.turns).toHaveLength(1);
    expect(h.generation.retryFailedSections).not.toHaveBeenCalled();
  });

  it('never resubmits a durable-intake run with nothing retained as new work', async () => {
    const h = harness((request, _call, _credential) => documentAnswer(request, 'native-run-1'));
    const receipt = { draftId: DRAFT, runId: RUN, status: 'queued', agentRevision: REVISION };
    const { controller: api } = controller(h, receipt);

    await api.retryFailed(context, RUN, `Bearer ${CREDENTIAL}`);

    expect(h.owner.turns).toHaveLength(0);
    expect(h.owner.reads).toHaveLength(0);
    expect(h.generation.retryFailedSections).not.toHaveBeenCalled();
  });

  it('keeps the legacy retry — and its response — for a run that is not a durable intake', async () => {
    const h = harness((request, _call, _credential) => documentAnswer(request, 'native-run-1'));
    Reflect.deleteProperty(configOf(h.state), 'quickDraftIntake');
    const receipt = { draftId: DRAFT, runId: RUN, status: 'queued', agentRevision: REVISION };
    const { controller: api } = controller(h, receipt);

    const answer = await api.retryFailed(context, RUN, `Bearer ${CREDENTIAL}`);

    expect(answer).toEqual({ runId: RUN, status: 'queued' });
    expect(h.generation.retryFailedSections).toHaveBeenCalledTimes(1);
    expect(h.owner.turns).toHaveLength(0);
  });
});
