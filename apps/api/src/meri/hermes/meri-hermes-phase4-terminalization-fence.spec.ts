import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TenantContext } from '@capiro/shared';
import type { MeriHermesAuthorizationEnvelope } from './hermes-runtime.contracts.js';
import { MeriHermesRuntimeAdapter } from './meri-hermes-runtime.adapter.js';
import { MeriHermesRunStore } from './meri-hermes-run-store.js';

type Phase4State = 'prepared' | 'claimed' | 'sealed_absent' | null;

class Phase4AwareRunStore extends MeriHermesRunStore {
  constructor(readonly phase4State: Phase4State) { super(); }

  override async phase4DispatchIntentState(): Promise<Phase4State> {
    return this.phase4State;
  }
}

function fixture(state: Phase4State) {
  const tenantId = randomUUID();
  const userId = randomUUID();
  const conversationId = randomUUID();
  const runId = randomUUID();
  const actor: TenantContext = {
    tenantId, tenantSlug: 'phase4-terminalization-fence', userId,
    clerkUserId: userId, role: 'standard_user',
  };
  const envelope: MeriHermesAuthorizationEnvelope = {
    version: 1, tenantId, actorType: 'user', actorId: userId,
    workspaceId: null, executionScopeId: `tenant:${tenantId}:user:${userId}`,
    audience: 'private', authorizedClientIds: [], authorizedMailboxConnectionIds: [],
    toolPolicy: { allow: [], deny: [], readOnly: true }, authorizationVersion: 'v1',
    conversationId, runId, traceId: randomUUID(), issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    budget: { maxToolCalls: 1, maxOutputTokens: 100, maxWallClockMs: 10_000 },
  };
  const store = new Phase4AwareRunStore(state);
  const adapter = new MeriHermesRuntimeAdapter(
    {} as never, {} as never, {} as never, store, {} as never, {} as never,
  );
  const finalize = jest.fn(async () => undefined);
  (adapter as unknown as { finalize: typeof finalize }).finalize = finalize;
  return { actor, envelope, store, adapter, finalize };
}

describe('Phase 4 generic terminalization fences', () => {
  test.each(['prepared', 'claimed'] as const)(
    'Stop leaves an unbound %s intent cancelling for authoritative recovery',
    async (state) => {
      const f = fixture(state);
      const run = await f.store.create({
        envelope: f.envelope, actorContext: f.actor,
        idempotencyKey: `phase4-${state}-${randomUUID()}`, userMessageId: null,
      });
      const stopped = await f.adapter.requestStop(run);
      expect(stopped.status).toBe('cancelling');
      expect(stopped.stopRequestedAt).not.toBeNull();
      expect(f.finalize).not.toHaveBeenCalled();
    },
  );

  test.each([null, 'sealed_absent'] as const)(
    'Stop may terminalize an unbound %s intent path',
    async (state) => {
      const f = fixture(state);
      const run = await f.store.create({
        envelope: f.envelope, actorContext: f.actor,
        idempotencyKey: `phase4-closed-${String(state)}-${randomUUID()}`,
        userMessageId: null,
      });
      await f.adapter.requestStop(run);
      expect(f.finalize).toHaveBeenCalledTimes(1);
    },
  );

  test.each(['prepared', 'claimed'] as const)(
    'stuck-dispatch sweep leaves an old %s intent nonterminal',
    async (state) => {
      const f = fixture(state);
      const run = await f.store.create({
        envelope: f.envelope, actorContext: f.actor,
        idempotencyKey: `phase4-sweep-${state}-${randomUUID()}`, userMessageId: null,
      });
      const reconciled = await f.store.reconcileStuckDispatches(
        30_000, new Date(Date.parse(run.createdAt) + 60_000),
      );
      expect(reconciled).toBe(0);
      expect((await f.store.get(run.runId))?.status).toBe('queued');
    },
  );

  test('Prisma sweep uses one atomic NOT EXISTS fence for prepared/claimed intents', () => {
    const source = readFileSync(join(__dirname, 'meri-hermes-prisma-run-repository.ts'), 'utf8');
    expect(source).toContain('AND NOT EXISTS');
    expect(source).toContain("intent.state IN ('prepared', 'claimed')");
    expect(source).toContain("UPDATE meri_agent_runs AS run");
  });
});
