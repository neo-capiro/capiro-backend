import { objectiveFixture, id } from './objective-generation.fixture.js';
import { admitObjective } from './objective-generation-admission.js';
import { objectivePersistence, safeObjectiveFailure } from './objective-generation-completion.js';
import {
  digest,
  parseObjectiveDraft,
  requestKey,
  publicObjectiveReceipt,
  validObjectiveOutcome,
} from './objective-generation.types.js';
import { DraftJobService } from './draft-job.service.js';
import { DraftJobWorkerService } from './draft-job-worker.service.js';
import { toPublicDraftJob } from './draft-job.types.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('Objective authoritative admission and exact request', () => {
  test('binds every saved field and immutable revision', async () => {
    const f = objectiveFixture();
    const admitted = await admitObjective(f.tx, f.actor, f.request);
    expect(admitted).toEqual({
      source: f.source,
      intent: f.intent,
      sourceDigest: digest({ source: f.source, intent: f.intent }),
    });
  });
  test.each([
    'goal',
    'meriContext',
    'tenantId',
    'actorId',
    'allowIncomplete',
    'activate',
    'taskCap',
  ])('rejects caller %s', (key) => {
    const f = objectiveFixture();
    expect(() => parseObjectiveDraft({ ...f.request, [key]: 'x' })).toThrow();
  });
  test.each([0, -1, 1.1, '7', 2147483648, null])('rejects version %s', (version) => {
    const f = objectiveFixture();
    expect(() =>
      parseObjectiveDraft({
        ...f.request,
        objective: { ...f.request.objective, objectiveVersion: version },
      }),
    ).toThrow();
  });
  test.each(['outcome', 'governmentProblem', 'minimumWin'])(
    'refuses empty required field %s',
    async (key) => {
      const f = objectiveFixture();
      (f.state.snapshot as any)[key] = '';
      await expect(admitObjective(f.tx, f.actor, f.request)).rejects.toThrow();
    },
  );
  test('stale, foreign/revoked membership, wall and not-ready are refused', async () => {
    const f = objectiveFixture();
    f.state.snapshot.version = 8;
    await expect(admitObjective(f.tx, f.actor, f.request)).rejects.toMatchObject({
      response: { code: 'OBJECTIVE_VERSION_CONFLICT' },
    });
    f.state.snapshot.version = 7;
    f.state.authorized = false;
    await expect(admitObjective(f.tx, f.actor, f.request)).rejects.toThrow();
    f.state.authorized = true;
    f.state.wall = true;
    f.state.grant = false;
    await expect(admitObjective(f.tx, f.actor, f.request)).rejects.toThrow();
    f.state.wall = false;
    f.state.snapshot.status = 'draft';
    await expect(admitObjective(f.tx, f.actor, f.request)).rejects.toThrow();
  });
  test('request identity scopes actor and does not impose one Strategy per Objective', () => {
    expect(requestKey('t', 'a', id(1))).not.toBe(requestKey('t', 'b', id(1)));
    expect(requestKey('t', 'a', id(1))).not.toBe(requestKey('t', 'a', id(2)));
  });
  test('canonical digest preserves timestamp changes', () => {
    expect(digest({ at: new Date('2026-10-15T00:00:00Z') })).toBe(
      digest({ at: '2026-10-15T00:00:00.000Z' }),
    );
    expect(digest({ at: new Date('2026-10-15T00:00:00Z') })).not.toBe(
      digest({ at: new Date('2026-10-15T00:00:01Z') }),
    );
  });
  test('same intent replays; changed intent conflicts; new request allows another attempt', async () => {
    const f = objectiveFixture();
    let stored: any;
    f.tx.spDraftJob.findUnique = async () => stored ?? null;
    f.tx.spDraftJob.create = async ({ data }: any) =>
      (stored = { ...data, id: id(5), strategyId: null, errorMessage: null });
    const svc = new DraftJobService(
      { withTenant: async (_: any, fn: any) => fn(f.tx) } as any,
      {} as any,
    );
    const first = await svc.submitObjective(f.actor, f.request);
    expect(await svc.submitObjective(f.actor, f.request)).toEqual(first);
    await expect(
      svc.submitObjective(f.actor, { ...f.request, type: 'authorization' }),
    ).rejects.toMatchObject({ response: { code: 'OBJECTIVE_REQUEST_CONFLICT' } });
    stored = null;
    await expect(
      svc.submitObjective(f.actor, { ...f.request, requestId: id(31) }),
    ).resolves.toHaveProperty('jobId');
  });
  test('concurrent unique-key winner is replayed without another generation row', async () => {
    const f = objectiveFixture();
    let winner: any;
    f.tx.spDraftJob.findUnique = async () => winner ?? null;
    f.tx.spDraftJob.create = async ({ data }: any) => {
      winner = { ...data, id: id(5) };
      throw { code: 'P2002' };
    };
    const svc = new DraftJobService(
      { withTenant: async (_: any, fn: any) => fn(f.tx) } as any,
      {} as any,
    );
    await expect(svc.submitObjective(f.actor, f.request)).resolves.toHaveProperty('jobId', id(5));
    winner.status = 'failed';
    await expect(svc.submitObjective(f.actor, f.request)).resolves.toHaveProperty(
      'status',
      'failed',
    );
  });
  test('job reads require current binding and submitting actor', async () => {
    const f = objectiveFixture();
    f.tx.spDraftJob.findFirst = async () => f.state.job;
    const svc = new DraftJobService(
      { withTenant: async (_: any, fn: any) => fn(f.tx) } as any,
      {} as any,
    );
    await expect(svc.get({ ...f.actor, clerkUserId: 'foreign' }, f.job.id)).rejects.toMatchObject({
      status: 404,
    });
    f.state.snapshot.version++;
    await expect(svc.get(f.actor, f.job.id)).rejects.toMatchObject({
      response: { code: 'OBJECTIVE_VERSION_CONFLICT' },
    });
  });
  test('POST replay uses the same safe unconfirmed projection as GET', async () => {
    const f = objectiveFixture();
    f.state.job.status = 'completed';
    f.state.job.strategyId = id(6);
    f.state.job.errorMessage = null;
    f.state.job.input.objectiveGeneration.receipt.context.reobservedAt = '2026-10-15T00:00:59Z';
    (f.state.job.input.objectiveGeneration.receipt as any).privateText = 'SECRET';
    f.tx.spDraftJob.findUnique = async () => f.state.job;
    const svc = new DraftJobService(
      { withTenant: async (_: any, fn: any) => fn(f.tx) } as any,
      {} as any,
    );
    const value = await svc.submitObjective(f.actor, f.request);
    expect(value.status).toBe('failed');
    expect(value.objectiveGeneration.result).toBeNull();
    expect(value.objectiveGeneration.context.reobservedAt).toBeNull();
    expect(JSON.stringify(value)).not.toContain('SECRET');
    expect(f.state.job.status).toBe('completed');
  });
});

describe('Objective worker durable outcomes', () => {
  function workerFixture() {
    const f = objectiveFixture();
    const calls: any[] = [];
    const rawUpdate = f.tx.spDraftJob.updateMany;
    f.tx.spDraftJob.updateMany = async (args: any) => {
      calls.push(args);
      return rawUpdate(args);
    };
    f.tx.spDraftJob.findFirst = async () => structuredClone(f.state.job);
    const prisma: any = {
      withTenant: async (_: string, fn: any) => fn(f.tx),
      withSystem: async (fn: any) => fn(f.tx),
    };
    const draft = jest.fn();
    const context = { recheckObjective: jest.fn(async () => '2026-10-15T00:00:59Z') };
    const worker = new DraftJobWorkerService(
      prisma,
      { draft } as any,
      {} as any,
      { get: () => undefined } as any,
      context as any,
    );
    return {
      ...f,
      calls,
      prisma,
      draft,
      context,
      run: () => (worker as any).processJob(f.job),
      worker,
    };
  }
  test('lost completion response reconciles the atomically completed job with no second completion or regeneration', async () => {
    const f = workerFixture();
    f.draft.mockImplementation(async (...args: any[]) => {
      const rt = args[4];
      await rt.objective.onCompiled(f.admission);
      await rt.persistence.beforeTransaction();
      await rt.persistence.beforeWrite(f.tx);
      await rt.persistence.afterWrite(f.tx, { strategyId: id(6), strategyVersionId: id(7) });
      throw new Error('connection lost after database commit');
    });
    await f.run();
    expect(f.draft).toHaveBeenCalledTimes(1);
    expect(f.state.job.status).toBe('completed');
    expect(f.state.events.filter((s) => s.includes("SET status='completed'"))).toHaveLength(1);
    expect(f.calls.some((c) => c.data.status === 'failed')).toBe(false);
  });
  test('late progress/failure from a reclaimed worker cannot overwrite the new claim', async () => {
    const f = workerFixture();
    f.draft.mockImplementation(async (...args: any[]) => {
      const rt = args[4];
      await rt.objective.onCompiled(f.admission);
      f.state.job.claimedBy = 'same-instance:new-claim';
      f.state.job.attempt++;
      rt.onStage('persisting', 'Saving');
      rt.onStreamDelta('SECRET_MODEL_TEXT');
      throw new Error('SECRET_UPSTREAM');
    });
    await f.run();
    expect(f.state.job.status).toBe('running');
    expect(f.state.job.claimedBy).toBe('same-instance:new-claim');
    expect(JSON.stringify(f.state.job)).not.toContain('SECRET');
    expect(
      f.calls.every(
        (c) => c.where.claimedBy === f.job.claimToken && c.where.attempt === f.job.attempt,
      ),
    ).toBe(true);
  });
  test('records a safe failed receipt and never returns upstream exceptions or stream text', async () => {
    const f = workerFixture();
    f.draft.mockRejectedValue(new Error('SECRET bearer upstream stack'));
    await f.run();
    expect(f.state.job.status).toBe('failed');
    expect(f.state.job.strategyId).toBeNull();
    expect(f.state.job.input.objectiveGeneration.receipt.failure.code).toBe(
      'OBJECTIVE_GENERATION_FAILED',
    );
    expect(JSON.stringify(f.state.job)).not.toContain('SECRET');
  });
  test('an unavailable reconciliation read does not assert failure or blindly regenerate', async () => {
    const f = workerFixture();
    f.draft.mockRejectedValue(new Error('ambiguous transaction'));
    f.tx.spDraftJob.findFirst = async () => {
      throw new Error('database unavailable');
    };
    await f.run();
    expect(f.draft).toHaveBeenCalledTimes(1);
    expect(f.state.job.status).toBe('running');
    expect(f.calls.some((c) => c.data.status === 'failed')).toBe(false);
  });
  test('claim tokens differ on every claim even on the same instance', async () => {
    const f = workerFixture();
    const tokens: string[] = [];
    f.tx.$queryRawUnsafe = async (_: string, token: string) => {
      tokens.push(token);
      return [];
    };
    await (f.worker as any).claimNext();
    await (f.worker as any).claimNext();
    expect(tokens).toHaveLength(2);
    expect(tokens[0]).not.toBe(tokens[1]);
  });
});

describe('Objective transaction persistence fence', () => {
  test('external recheck precedes locks; exact writer version receipt completes one checked row', async () => {
    const f = objectiveFixture();
    const external = jest.fn(async () => {
      expect(f.state.events).toEqual([]);
      return '2026-10-15T00:00:59Z';
    });
    const hooks = objectivePersistence(
      f.job,
      { recheckObjective: external } as any,
      () => f.admission,
    );
    await hooks.beforeTransaction!();
    await hooks.beforeWrite(f.tx);
    await hooks.afterWrite(f.tx, { strategyId: id(6), strategyVersionId: id(7) });
    expect(f.state.job.status).toBe('completed');
    expect(f.state.job.input.objectiveGeneration.receipt.result).toMatchObject({
      strategyId: id(6),
      strategyVersionId: id(7),
      contextPacketId: id(8),
    });
    expect(f.state.events.findIndex((s) => s.includes('FOR UPDATE'))).toBeLessThan(
      f.state.events.findIndex((s) => s.includes('LOCK TABLE')),
    );
    expect(f.state.events.findIndex((s) => s.includes('FROM tenants'))).toBeLessThan(
      f.state.events.findIndex((s) => s.includes('deadline_at > clock_timestamp()')),
    );
  });
  test('deadline expiring during persistence prevents the final completion write', async () => {
    const f = objectiveFixture();
    const hooks = objectivePersistence(f.job, {} as any, () => f.admission);
    await hooks.beforeWrite(f.tx);
    f.state.deadline = false;
    await expect(
      hooks.afterWrite(f.tx, { strategyId: id(6), strategyVersionId: id(7) }),
    ).rejects.toThrow();
    expect(f.state.job.status).toBe('running');
  });
  test('invalid completed receipt never discloses an unverified result identity', () => {
    const f = objectiveFixture();
    f.state.job.status = 'completed';
    f.state.job.strategyId = id(6);
    f.state.job.errorMessage = null;
    const view = toPublicDraftJob(f.state.job);
    expect(view.status).toBe('failed');
    expect(view.strategyId).toBeNull();
    expect(view.objectiveGeneration!.result).toBeNull();
    expect(view.objectiveGeneration!.failure!.code).toBe(
      'OBJECTIVE_GENERATION_OUTCOME_UNCONFIRMED',
    );
    expect(
      validObjectiveOutcome(
        view.objectiveGeneration!,
        view.status,
        view.strategyId,
        view.errorMessage,
      ),
    ).toBe(true);
  });
  test('public wire examples enforce completion identity, safe failure and as-of timestamps', () => {
    const wire = JSON.parse(
      readFileSync(
        resolve(__dirname, '../../../../docs/objective-generation-backend/WIRE-EXAMPLES.json'),
        'utf8',
      ),
    );
    expect(parseObjectiveDraft(wire.request.body)).toEqual(wire.request.body);
    for (const name of ['pendingPoll', 'completedPoll', 'incompleteContextPoll']) {
      const body = wire[name].body;
      expect(
        validObjectiveOutcome(
          body.objectiveGeneration,
          body.status,
          body.strategyId,
          body.errorMessage,
        ),
      ).toBe(true);
    }
    expect(wire.completedPoll.body.objectiveGeneration.context.reobservedAt).not.toBeNull();
    expect(wire.pendingPoll.body.objectiveGeneration.context.reobservedAt).toBeNull();
  });
  test.each([
    'claim',
    'attempt',
    'deadline',
    'authority',
    'wall',
    'version',
    'source-insert',
    'source-move',
    'source-delete',
    'rowcount',
  ])('refuses %s before successful publication', async (which) => {
    const f = objectiveFixture();
    const hooks = objectivePersistence(f.job, {} as any, () => f.admission);
    if (which === 'claim') f.state.job.claimedBy = 'replacement';
    if (which === 'attempt') f.state.job.attempt++;
    if (which === 'deadline') f.state.deadline = false;
    if (which === 'authority') f.state.authorized = false;
    if (which === 'wall') {
      f.state.wall = true;
      f.state.grant = false;
    }
    if (which === 'version') f.state.snapshot.version++;
    if (which === 'source-insert')
      f.state.sources.government_targets.push({
        ...f.state.sources.government_targets[0]!,
        id: id(32),
      });
    if (which === 'source-move') f.state.sources.represented_facilities[0]!.state = 'NY';
    if (which === 'source-delete') f.state.sources.government_targets.pop();
    if (which === 'rowcount') {
      await hooks.beforeWrite(f.tx);
      f.state.rowcount = 0;
      await expect(
        hooks.afterWrite(f.tx, { strategyId: id(6), strategyVersionId: id(7) }),
      ).rejects.toThrow();
    } else await expect(hooks.beforeWrite(f.tx)).rejects.toThrow();
    expect(f.state.job.status).toBe('running');
    expect(f.state.job.strategyId).toBeNull();
  });
  test('public projection excludes extra private fields, safe failures hide upstream details', () => {
    const f = objectiveFixture();
    (f.input.objectiveGeneration!.receipt as any).privateMail = 'SECRET';
    expect(
      JSON.stringify(publicObjectiveReceipt(f.input.objectiveGeneration!.receipt)),
    ).not.toContain('SECRET');
    expect(safeObjectiveFailure(new Error('bearer SECRET provider stack'))).toEqual({
      code: 'OBJECTIVE_GENERATION_FAILED',
      message: 'This Objective strategy could not be generated.',
    });
  });
});
