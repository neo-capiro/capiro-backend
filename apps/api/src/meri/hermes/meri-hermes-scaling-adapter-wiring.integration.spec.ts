/**
 * S-1 / S-2 as the ADAPTER actually uses them — the wiring, not the services.
 *
 * The sibling specs prove the controls are correct in isolation. This one
 * proves the production turn path is actually behind them: that a turn reserves
 * budget before it exists, that a terminal turn reconciles and hands its
 * capacity slot back, that an exhausted tenant's NEW turn is refused before a
 * run record is created, that a capacity refusal finalizes the run honestly
 * instead of leaving it occupying the conversation, and that a queued turn's
 * queued state is VISIBLE in the durable run record.
 *
 * Real local Postgres (container `capiro-postgres`) only. The one test double
 * is the Hermes HTTP worker itself — none runs here — so every turn takes the
 * adapter's own documented runtime-unavailable path, which is a terminal path
 * like any other and is exactly what the settlement assertions need.
 */
import { randomUUID } from 'node:crypto';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { MeriFeatureFlagsService } from '../meri-feature-flags.service.js';
import { MeriHermesPrismaRunRepository } from './meri-hermes-prisma-run-repository.js';
import { MeriHermesRuntimeAdapter } from './meri-hermes-runtime.adapter.js';
import { MeriHermesDbGovernor } from './meri-hermes-db-governor.js';
import { MeriHermesBudgetService } from './meri-hermes-budget.service.js';
import { MeriHermesAdmissionControlService } from './meri-hermes-admission-control.service.js';
import { privateExecutionScopeId } from './meri-hermes-worker-token.js';
import type { MeriHermesRuntimeClient } from './meri-hermes-runtime.client.js';
import type { MeriHermesSecurityEnvelopePort } from './meri-hermes-security.port.js';
import type { MeriTurnMaintenance } from '../meri-turn-maintenance.js';

function assertLocalFixtureDatabase(url: string | undefined): void {
  if (!url) throw new Error('DATABASE_URL is required to run meri-hermes-scaling-adapter-wiring.integration.spec.ts');
  const parsed = new URL(url);
  if (!['localhost', '127.0.0.1'].includes(parsed.hostname)) {
    throw new Error(
      `meri-hermes-scaling-adapter-wiring.integration.spec.ts refuses to run against a non-local DATABASE_URL host (${parsed.hostname}). ` +
        'This suite writes and deletes rows and must only ever target the local fixture Postgres.',
    );
  }
}
assertLocalFixtureDatabase(process.env.DATABASE_URL);

describe('S-1/S-2 wired into the real turn path (real local Postgres)', () => {
  let prisma: PrismaService;
  let runs: MeriHermesPrismaRunRepository;
  let tenantId: string;
  let userId: string;
  let ctx: TenantContext;
  let scopeId: string;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
    runs = new MeriHermesPrismaRunRepository(prisma);
    tenantId = randomUUID();
    userId = randomUUID();
    ctx = {
      tenantId,
      tenantSlug: `meri-hermes-wiring-spec-${tenantId}`,
      userId,
      clerkUserId: userId,
      role: 'standard_user',
    };
    scopeId = privateExecutionScopeId(tenantId, userId);
    await prisma.withSystem(async (tx) => {
      await tx.tenant.create({
        data: {
          id: tenantId,
          slug: `meri-hermes-wiring-spec-${tenantId}`,
          name: 'Meri Hermes scaling-wiring spec fixture',
          status: 'active',
        },
      });
      await tx.user.create({ data: { id: userId, clerkUserId: userId, email: `${userId}@example.test` } });
    });
  });

  afterEach(async () => {
    await prisma.withSystem(
      (tx) => tx.$executeRaw`DELETE FROM meri_agent_admission_slots WHERE tenant_id = ${tenantId}::uuid`,
    );
  });

  afterAll(async () => {
    await prisma.withSystem((tx) => tx.tenant.delete({ where: { id: tenantId } })).catch(() => undefined);
    await prisma.withSystem((tx) => tx.user.delete({ where: { id: userId } })).catch(() => undefined);
    await prisma.$disconnect();
  });

  async function makeConversation(title: string): Promise<string> {
    const id = randomUUID();
    await prisma.withTenant(tenantId, (tx) => tx.clioConversation.create({ data: { id, tenantId, userId, title } }));
    return id;
  }

  function governor(): MeriHermesDbGovernor {
    const g = new MeriHermesDbGovernor();
    g.env = { ...process.env, MERI_HERMES_DB_MAX_CONCURRENCY: '24' };
    return g;
  }

  function makeAdapter(overrides: Record<string, string> = {}): {
    adapter: MeriHermesRuntimeAdapter;
    budgets: MeriHermesBudgetService;
    admission: MeriHermesAdmissionControlService;
  } {
    const fakeClient = {
      forScope: jest.fn(() => ({
        createRun: jest.fn(async () => {
          throw new Error('no Hermes worker in this test');
        }),
      })),
    } as unknown as MeriHermesRuntimeClient;
    const adapter = new MeriHermesRuntimeAdapter(
      prisma,
      new MeriFeatureFlagsService(prisma),
      fakeClient,
      runs,
      { securityEnvelope: async () => ({ authorizedClientIds: [], authorizedMailboxConnectionIds: [] }) } as MeriHermesSecurityEnvelopePort,
      { scheduleAfterTurnMaintenance: () => undefined } as MeriTurnMaintenance,
    );
    adapter.env = {
      ...process.env,
      MERI_COMPLIANCE_BLOCK: 'false',
      MERI_HERMES_RUNTIME_URL: 'http://127.0.0.1:19999',
      MERI_HERMES_API_KEY: 'scaling-wiring-spec-placeholder-key',
      MERI_HERMES_BROKER_SIGNING_KEY: 'scaling-wiring-spec-signing-key-0123456789',
    };
    const env = { ...process.env, ...overrides };
    const budgets = new MeriHermesBudgetService(prisma, governor());
    budgets.env = env;
    const admission = new MeriHermesAdmissionControlService(prisma, governor());
    admission.env = env;
    adapter.budgets = budgets;
    adapter.admission = admission;
    return { adapter, budgets, admission };
  }

  function collector() {
    const frames: Array<Record<string, unknown>> = [];
    return {
      frames,
      sse: {
        write(data: string) {
          const match = /^data: (.*)\n\n$/.exec(data);
          if (match) frames.push(JSON.parse(match[1]!));
        },
      },
    };
  }

  // -------------------------------------------------------------------------

  test('1. a normal turn RESERVES at admission and RECONCILES at terminal, and hands its capacity slot back', async () => {
    const conversationId = await makeConversation('wiring: reserve and reconcile');
    const { adapter, budgets, admission } = makeAdapter({
      MERI_HERMES_MAX_RUN_TOKENS: '4000',
      MERI_HERMES_TENANT_DAILY_TOKENS: '100000',
    });
    const { sse } = collector();

    await adapter.streamMessage(ctx, conversationId, 'a turn that reserves and settles', sse);

    const [run] = await runs.listForConversation(tenantId, userId, conversationId);
    expect(run).toBeDefined();

    // The parent reservation exists, is keyed by THIS run, and is settled.
    const reservation = await budgets.getReservation(tenantId, run!.runId);
    expect(reservation).not.toBeNull();
    expect(reservation!.maxRunTokens).toBe(4000);
    expect(reservation!.estimatedTokens).toBe(4000);
    expect(reservation!.state).toBe('reconciled');
    // The run never reached Hermes, so it drew nothing and the whole estimate
    // went back to the tenant's window instead of being held until midnight.
    expect(reservation!.actualTokens).toBe(0);

    const snapshot = await budgets.snapshot(tenantId);
    expect(snapshot.admittedRuns).toBeGreaterThanOrEqual(1);
    expect(snapshot.settledRuns).toBeGreaterThanOrEqual(1);
    expect(snapshot.committedTokens).toBe(0);

    // And the capacity slot is gone, so the next turn is not queued behind a
    // run that has already finished.
    await expect(admission.slotState(run!.runId)).resolves.toBeNull();
    expect((await admission.counts(tenantId, scopeId)).scopeActive).toBe(0);
  });

  test('2. an EXHAUSTED tenant is refused BEFORE a run record exists, with an actionable error frame and a clean done', async () => {
    const conversationId = await makeConversation('wiring: exhausted tenant');
    const { adapter, budgets } = makeAdapter({
      MERI_HERMES_MAX_RUN_TOKENS: '1000',
      MERI_HERMES_TENANT_DAILY_TOKENS: '1000',
    });
    // Someone else already used the whole day.
    await budgets.reserveAdmission({
      runId: randomUUID(),
      tenantId,
      scopeId,
      conversationId: randomUUID(),
    });

    const { frames, sse } = collector();
    await adapter.streamMessage(ctx, conversationId, 'a turn there is no budget for', sse);

    const error = frames.find((f) => f.type === 'error');
    expect(error).toBeDefined();
    expect(error!.code).toBe('hermes_budget_exhausted');
    expect(error!.ceiling).toBe('tenant_daily_tokens');
    expect(String(error!.message)).toMatch(/Runs already in progress will finish normally/);
    expect(typeof error!.resetsAt).toBe('string');
    expect(frames[frames.length - 1]).toMatchObject({ type: 'done', finishReason: 'error', partial: true });

    // No run was created at all: the refusal is an admission refusal, not a
    // run that starts and then dies.
    await expect(runs.listForConversation(tenantId, userId, conversationId)).resolves.toHaveLength(0);
  });

  test('3. a CAPACITY refusal finalizes the run honestly instead of leaving the conversation occupied forever', async () => {
    const conversationId = await makeConversation('wiring: capacity refusal');
    const { adapter, budgets, admission } = makeAdapter({
      MERI_HERMES_MAX_CONCURRENT_RUNS_SCOPE: '1',
      MERI_HERMES_TENANT_QUEUE_DEPTH: '1',
    });
    // The scope's one slot and its one queue place are already taken by other
    // conversations of the same user.
    const occupying = randomUUID();
    const waiting = randomUUID();
    await admission.admit({ runId: occupying, tenantId, scopeId, conversationId: randomUUID() });
    await admission.admit({ runId: waiting, tenantId, scopeId, conversationId: randomUUID() });

    const { frames, sse } = collector();
    await adapter.streamMessage(ctx, conversationId, 'a turn with nowhere to run', sse);

    const error = frames.find((f) => f.type === 'error');
    expect(error?.code).toBe('hermes_capacity_exhausted');
    expect(String(error!.message)).toMatch(/Nothing was started and nothing was charged/);

    const [run] = await runs.listForConversation(tenantId, userId, conversationId);
    expect(run).toBeDefined();
    // TERMINAL, so the conversation's single-writer lease is free again and the
    // user's next message is not met with `conversation_occupied` forever.
    expect(['failed', 'cancelled', 'interrupted', 'expired']).toContain(run!.status);
    expect(run!.finishedAt).not.toBeNull();
    // And its budget reservation was settled on the way out.
    expect((await budgets.getReservation(tenantId, run!.runId))?.state).toBe('reconciled');

    // The refusal consumed no capacity of its own.
    expect((await admission.counts(tenantId, scopeId)).scopeActive).toBe(1);
  });

  test('4. a QUEUED turn makes its queued state visible in the durable run record, and starts when capacity frees', async () => {
    const conversationId = await makeConversation('wiring: queued then promoted');
    const { adapter, admission } = makeAdapter({
      MERI_HERMES_MAX_CONCURRENT_RUNS_SCOPE: '1',
      MERI_HERMES_TENANT_QUEUE_DEPTH: '4',
      MERI_HERMES_QUEUE_WAIT_MS: '10000',
      MERI_HERMES_QUEUE_POLL_MS: '25',
    });
    const occupying = randomUUID();
    await admission.admit({ runId: occupying, tenantId, scopeId, conversationId: randomUUID() });

    const { frames, sse } = collector();
    const turn = adapter.streamMessage(ctx, conversationId, 'a turn that has to wait its turn', sse);
    // Let it get as far as queueing, then free the slot the way a finishing
    // run does.
    await new Promise((r) => setTimeout(r, 300));
    await admission.release(occupying);
    await turn;

    const [run] = await runs.listForConversation(tenantId, userId, conversationId);
    expect(run).toBeDefined();
    const events = await runs.eventsAfter(run!.runId, 0, 'all');

    const queued = events.find((e) => e.payload.reason === 'capacity_queue' && e.payload.status === 'queued');
    expect(queued).toBeDefined();
    expect(queued!.visibility).toBe('public'); // replayed to a reconnecting browser
    expect(queued!.payload.queuePosition).toBe(1);
    // The browser saw it live too, and then saw it start.
    expect(frames.some((f) => f.state === 'queued' && f.queuePosition === 1)).toBe(true);
    expect(frames.some((f) => f.state === 'starting')).toBe(true);

    // It really did run afterwards (and then hit the absent worker, which is
    // this suite's terminal path).
    expect(events.some((e) => e.payload.status === 'provisioning')).toBe(true);
    const finished = await runs.get(run!.runId);
    expect(['failed', 'cancelled', 'interrupted', 'expired', 'completed']).toContain(finished!.status);
  });

  test('5. disconnect while queued detaches delivery but preserves admission, and an identical retry reattaches', async () => {
    const conversationId = await makeConversation('wiring: queued disconnect and retry');
    const { adapter, admission } = makeAdapter({
      MERI_HERMES_MAX_CONCURRENT_RUNS_SCOPE: '1',
      MERI_HERMES_TENANT_QUEUE_DEPTH: '4',
      MERI_HERMES_QUEUE_WAIT_MS: '10000',
      MERI_HERMES_QUEUE_POLL_MS: '25',
    });
    const occupying = randomUUID();
    await admission.admit({ runId: occupying, tenantId, scopeId, conversationId: randomUUID() });

    const body = 'a queued turn that survives the phone going away';
    const clientIdempotencyKey = randomUUID();
    const first = collector();
    const disconnect = new AbortController();
    const accepted = adapter.streamMessage(
      ctx,
      conversationId,
      body,
      first.sse,
      disconnect.signal,
      'new',
      [],
      undefined,
      undefined,
      clientIdempotencyKey,
    );

    let queuedRunId: string | null = null;
    for (let attempt = 0; attempt < 80 && !queuedRunId; attempt += 1) {
      const [candidate] = await runs.listForConversation(tenantId, userId, conversationId);
      if (candidate && (await admission.slotState(candidate.runId))?.state === 'queued') queuedRunId = candidate.runId;
      if (!queuedRunId) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(queuedRunId).not.toBeNull();

    disconnect.abort();
    await new Promise((resolve) => setTimeout(resolve, 75));
    await expect(admission.slotState(queuedRunId!)).resolves.toMatchObject({ state: 'queued' });

    // Same request fingerprint: no second user message and no second run.
    const retry = collector();
    const reattached = adapter.streamMessage(
      ctx,
      conversationId,
      body,
      retry.sse,
      undefined,
      'new',
      [],
      undefined,
      undefined,
      clientIdempotencyKey,
    );
    await admission.release(occupying);
    await Promise.all([accepted, reattached]);

    const conversationRuns = await runs.listForConversation(tenantId, userId, conversationId);
    expect(conversationRuns).toHaveLength(1);
    const finished = conversationRuns[0]!;
    expect(finished.runId).toBe(queuedRunId);
    expect(finished.detached).toBe(true);
    expect(['failed', 'cancelled', 'interrupted', 'expired', 'completed']).toContain(finished.status);
    const events = await runs.eventsAfter(finished.runId, 0, 'all');
    expect(events.filter((event) => event.kind === 'client.detached')).toHaveLength(1);

    // A delayed retry after terminal completion remains bound to the same
    // durable request. Explicit client keys never roll to a new generation.
    const terminalRetry = collector();
    await adapter.streamMessage(
      ctx,
      conversationId,
      body,
      terminalRetry.sse,
      undefined,
      'new',
      [],
      undefined,
      undefined,
      clientIdempotencyKey,
    );
    expect((await runs.listForConversation(tenantId, userId, conversationId))).toHaveLength(1);
    expect(terminalRetry.frames.some((frame) => frame.runId === finished.runId && frame.seq === 1)).toBe(true);
    await expect(
      prisma.withTenant(tenantId, (tx) =>
        tx.clioMessage.count({ where: { tenantId, userId, conversationId, role: 'user' } }),
      ),
    ).resolves.toBe(1);
  });

  test('6. two conversations of one user both run: the per-scope allowance of 2 is a real allowance, not a formality', async () => {
    const conversationOne = await makeConversation('wiring: parallel one');
    const conversationTwo = await makeConversation('wiring: parallel two');
    const { adapter, admission } = makeAdapter({ MERI_HERMES_MAX_CONCURRENT_RUNS_SCOPE: '2' });

    const { frames: framesOne, sse: sseOne } = collector();
    const { frames: framesTwo, sse: sseTwo } = collector();
    await Promise.all([
      adapter.streamMessage(ctx, conversationOne, 'first parallel turn', sseOne),
      adapter.streamMessage(ctx, conversationTwo, 'second parallel turn', sseTwo),
    ]);

    // Neither was refused for capacity, and neither was queued.
    for (const frames of [framesOne, framesTwo]) {
      expect(frames.find((f) => f.code === 'hermes_capacity_exhausted')).toBeUndefined();
      expect(frames.find((f) => f.state === 'queued')).toBeUndefined();
    }
    await expect(runs.listForConversation(tenantId, userId, conversationOne)).resolves.toHaveLength(1);
    await expect(runs.listForConversation(tenantId, userId, conversationTwo)).resolves.toHaveLength(1);
    // Both finished, so both slots came back.
    expect((await admission.counts(tenantId, scopeId)).scopeActive).toBe(0);
  });
});
