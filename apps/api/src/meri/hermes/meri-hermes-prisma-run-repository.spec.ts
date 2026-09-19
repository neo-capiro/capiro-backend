/**
 * Real-Postgres integration spec for `MeriHermesPrismaRunRepository` (Phase 1
 * backlog #1 / P1-02). Runs against the LOCAL fixture database only (container
 * `capiro-postgres`) — never a remote/production database. Every fixture id is
 * a fresh `randomUUID()` per run and everything created is cascade-deleted via
 * the fixture tenant in `afterAll`, so repeated runs are idempotent and safe on
 * a database shared with other local sessions/worktrees.
 */
import { randomUUID } from 'node:crypto';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { MeriHermesAuthorizationEnvelope, MeriHermesPendingInteraction } from './hermes-runtime.contracts.js';
import { MeriHermesPrismaRunRepository } from './meri-hermes-prisma-run-repository.js';
import { MeriHermesConversationOccupiedError, type MeriHermesRunRecord } from './meri-hermes-run-store.js';

function assertLocalFixtureDatabase(url: string | undefined): void {
  if (!url) throw new Error('DATABASE_URL is required to run meri-hermes-prisma-run-repository.spec.ts');
  const parsed = new URL(url);
  if (!['localhost', '127.0.0.1'].includes(parsed.hostname)) {
    throw new Error(
      `meri-hermes-prisma-run-repository.spec.ts refuses to run against a non-local DATABASE_URL host (${parsed.hostname}). ` +
        'This suite writes and deletes rows and must only ever target the local fixture Postgres.',
    );
  }
}
assertLocalFixtureDatabase(process.env.DATABASE_URL);

describe('MeriHermesPrismaRunRepository (real local Postgres)', () => {
  let prisma: PrismaService;
  let repo: MeriHermesPrismaRunRepository;
  let tenantId: string;
  let userId: string;
  let actor: TenantContext;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
    repo = new MeriHermesPrismaRunRepository(prisma);
    tenantId = randomUUID();
    userId = randomUUID();
    actor = { tenantId, tenantSlug: `meri-hermes-repo-spec-${tenantId}`, userId, clerkUserId: userId, role: 'standard_user' };
    await prisma.withSystem(async (tx) => {
      await tx.tenant.create({
        data: { id: tenantId, slug: `meri-hermes-repo-spec-${tenantId}`, name: 'Meri Hermes repo spec fixture', status: 'active' },
      });
      await tx.user.create({ data: { id: userId, clerkUserId: userId, email: `${userId}@example.test` } });
    });
  });

  afterAll(async () => {
    // Cascades: tenant -> meri_execution_scopes, tenant -> clio_conversations
    // -> meri_agent_runs -> meri_agent_run_events / meri_agent_interactions.
    await prisma.withSystem((tx) => tx.tenant.delete({ where: { id: tenantId } })).catch(() => undefined);
    await prisma.withSystem((tx) => tx.user.delete({ where: { id: userId } })).catch(() => undefined);
    await prisma.$disconnect();
  });

  async function makeConversation(): Promise<string> {
    const id = randomUUID();
    await prisma.withTenant(tenantId, (tx) =>
      tx.clioConversation.create({ data: { id, tenantId, userId, title: 'Fixture conversation' } }),
    );
    return id;
  }

  function envelope(over: Partial<MeriHermesAuthorizationEnvelope> & { conversationId: string }): MeriHermesAuthorizationEnvelope {
    return {
      version: 1,
      tenantId,
      actorType: 'user',
      actorId: userId,
      workspaceId: null,
      executionScopeId: `tenant:${tenantId}:user:${userId}`,
      audience: 'private',
      authorizedClientIds: [],
      authorizedMailboxConnectionIds: [],
      toolPolicy: { allow: [], deny: [], readOnly: true },
      authorizationVersion: 'v1',
      runId: randomUUID(),
      traceId: randomUUID(),
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      budget: { maxToolCalls: 10, maxOutputTokens: 1000, maxWallClockMs: 60_000 },
      ...over,
    };
  }

  function createRun(conversationId: string, idempotencyKey: string): Promise<MeriHermesRunRecord> {
    return repo.create({
      envelope: envelope({ conversationId }),
      actorContext: actor,
      idempotencyKey,
      userMessageId: null,
    });
  }

  test('1. idempotent replay: the same idempotency key on the same conversation returns the same run, no second row', async () => {
    const conversationId = await makeConversation();
    const key = `meri:${randomUUID()}`;
    const first = await createRun(conversationId, key);
    const second = await createRun(conversationId, key);
    expect(second.runId).toBe(first.runId);
    const count = await prisma.withTenant(tenantId, (tx) => tx.meriAgentRun.count({ where: { conversationId } }));
    expect(count).toBe(1);
  });

  test('2. a competing distinct submission to an occupied conversation throws and creates no second row', async () => {
    const conversationId = await makeConversation();
    const first = await createRun(conversationId, `meri:${randomUUID()}`);
    let caught: unknown;
    try {
      await createRun(conversationId, `meri:${randomUUID()}`);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MeriHermesConversationOccupiedError);
    expect((caught as MeriHermesConversationOccupiedError).occupyingRunId).toBe(first.runId);
    const count = await prisma.withTenant(tenantId, (tx) => tx.meriAgentRun.count({ where: { conversationId } }));
    expect(count).toBe(1);
  });

  test('3. a new conversation is never blocked by another conversation being occupied', async () => {
    const occupiedConversationId = await makeConversation();
    const freshConversationId = await makeConversation();
    await createRun(occupiedConversationId, `meri:${randomUUID()}`);
    const run = await createRun(freshConversationId, `meri:${randomUUID()}`);
    expect(run.envelope.conversationId).toBe(freshConversationId);
    expect(run.status).toBe('queued');
  });

  test('4. append() under concurrency produces distinct consecutive seqs, replayed in order with no gaps or dupes', async () => {
    const conversationId = await makeConversation();
    const run = await createRun(conversationId, `meri:${randomUUID()}`);
    // seq 1 is the run.accepted event create() already inserted.
    const concurrency = 10;
    const events = await Promise.all(
      Array.from({ length: concurrency }, (_, i) => repo.append(run.runId, 'message.delta', { i }, 'public')),
    );
    const seqs = events.map((e) => e.seq).sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: concurrency }, (_, i) => i + 2));
    expect(new Set(seqs).size).toBe(concurrency);
    const replayed = await repo.eventsAfter(run.runId, 1, 'all');
    expect(replayed.map((e) => e.seq)).toEqual(seqs);
  });

  test('5. update() to a terminal status wins exactly once under a race', async () => {
    const conversationId = await makeConversation();
    const run = await createRun(conversationId, `meri:${randomUUID()}`);
    await repo.update(run.runId, { status: 'running' });
    const [a, b] = await Promise.all([
      repo.update(run.runId, { status: 'completed', finishReason: 'stop' }),
      repo.update(run.runId, { status: 'cancelled', finishReason: 'aborted' }),
    ]);
    // Both calls observe the SAME winning status: whichever guarded write
    // matched first, the loser's own updateMany matched zero rows and its
    // re-fetch returned the row the winner already produced.
    expect(a.status).toBe(b.status);
    expect(['completed', 'cancelled']).toContain(a.status);
    expect(a.finishReason).toBe(b.finishReason);
    expect(a.finishedAt).not.toBeNull();
    expect(a.finishedAt).toBe(b.finishedAt);
    const finalRow = await repo.get(run.runId);
    expect(finalRow?.status).toBe(a.status);
  });

  test('6. finalize-style transactional write: ClioMessage create + update() + append() in one $transaction commit together', async () => {
    const conversationId = await makeConversation();
    const run = await createRun(conversationId, `meri:${randomUUID()}`);
    await repo.update(run.runId, { status: 'running' });
    let messageId = '';
    await prisma.withTenant(tenantId, async (tx) => {
      const message = await tx.clioMessage.create({
        data: { tenantId, userId, conversationId, role: 'assistant', body: 'Final answer', metadata: {} },
        select: { id: true },
      });
      messageId = message.id;
      await repo.update(run.runId, { status: 'completed', finishReason: 'stop', assistantMessageId: message.id }, tx);
      await repo.append(run.runId, 'run.status', { status: 'completed', final: true, frames: [] }, 'public', tx);
    });
    const updatedRun = await repo.get(run.runId);
    expect(updatedRun?.status).toBe('completed');
    expect(updatedRun?.assistantMessageId).toBe(messageId);
    const events = await repo.eventsAfter(run.runId, 0, 'all');
    expect(events.some((e) => e.kind === 'run.status' && e.payload.final === true)).toBe(true);
    const message = await prisma.withTenant(tenantId, (tx) => tx.clioMessage.findUnique({ where: { id: messageId } }));
    expect(message).not.toBeNull();
  });

  test('7. reconcileStuckDispatches flips an old pending-dispatch run to interrupted/failed and leaves a recent one alone', async () => {
    const oldConversationId = await makeConversation();
    const recentConversationId = await makeConversation();
    const oldRun = await createRun(oldConversationId, `meri:${randomUUID()}`);
    const recentRun = await createRun(recentConversationId, `meri:${randomUUID()}`);
    expect(oldRun.dispatchStatus).toBe('pending');
    // Backdate only the old run past the reconciliation threshold.
    await prisma.withSystem((tx) =>
      tx.meriAgentRun.update({ where: { id: oldRun.runId }, data: { createdAt: new Date(Date.now() - 60 * 60 * 1000) } }),
    );
    const reconciled = await repo.reconcileStuckDispatches(30 * 60 * 1000);
    expect(reconciled).toBeGreaterThanOrEqual(1);
    const oldAfter = await repo.get(oldRun.runId);
    expect(oldAfter?.status).toBe('interrupted');
    expect(oldAfter?.dispatchStatus).toBe('failed');
    expect(oldAfter?.finishReason).toBe('interrupted');
    expect(oldAfter?.finishedAt).not.toBeNull();
    const recentAfter = await repo.get(recentRun.runId);
    expect(recentAfter?.status).toBe('queued');
    expect(recentAfter?.dispatchStatus).toBe('pending');
  });

  test('8. sweep removes an old terminal run and its cascaded events/interactions, leaves a recent terminal and a non-terminal run alone', async () => {
    const oldConversationId = await makeConversation();
    const recentTerminalConversationId = await makeConversation();
    const nonTerminalConversationId = await makeConversation();
    const oldRun = await createRun(oldConversationId, `meri:${randomUUID()}`);
    const recentTerminalRun = await createRun(recentTerminalConversationId, `meri:${randomUUID()}`);
    const nonTerminalRun = await createRun(nonTerminalConversationId, `meri:${randomUUID()}`);

    const interaction: MeriHermesPendingInteraction = {
      requestId: `req-${randomUUID()}`,
      kind: 'clarification',
      createdAt: new Date().toISOString(),
      expiresAt: null,
      prompt: 'Which client?',
      choices: [],
      multiSelect: false,
      continuation: 'durable_continuation',
      resolution: null,
    };
    await repo.addInteraction(oldRun.runId, interaction);
    await repo.append(oldRun.runId, 'message.delta', { delta: 'x' });
    await repo.update(oldRun.runId, { status: 'completed', finishReason: 'stop' });
    await repo.update(recentTerminalRun.runId, { status: 'completed', finishReason: 'stop' });
    // Backdate only the old run's finishedAt past the 24h TTL.
    await prisma.withSystem((tx) =>
      tx.meriAgentRun.update({ where: { id: oldRun.runId }, data: { finishedAt: new Date(Date.now() - 25 * 60 * 60 * 1000) } }),
    );

    const removed = await repo.sweep();
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(await repo.get(oldRun.runId)).toBeNull();
    const oldEventCount = await prisma.withSystem((tx) => tx.meriAgentRunEvent.count({ where: { runId: oldRun.runId } }));
    expect(oldEventCount).toBe(0);
    const oldInteractionCount = await prisma.withSystem((tx) =>
      tx.meriAgentInteraction.count({ where: { runId: oldRun.runId } }),
    );
    expect(oldInteractionCount).toBe(0);
    expect(await repo.get(recentTerminalRun.runId)).not.toBeNull();
    expect(await repo.get(nonTerminalRun.runId)).not.toBeNull();
  });
});
