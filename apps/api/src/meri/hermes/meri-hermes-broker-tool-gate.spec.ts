/**
 * Closeout defect A7 — direct coverage for the broker's tool gate.
 *
 * `MeriHermesBrokerService.assertTool()` is the twelve-line method every
 * broker operation sits behind, and a repository-wide search across
 * `*.spec.ts` for `tool_not_allowed`, `tool_denied`, `read_only_run` and
 * `tool_budget_exhausted` returned NOTHING. That absence is how three
 * independent fail-open defects (A3 allow-list, A4 budget, A5 read-only
 * classification) coexisted in it. This suite covers every branch, plus the
 * F-1 release recheck's missing-row path (A6).
 *
 * What runs where: the policy branches need no database at all (assertTool
 * reads the envelope and the run repository, nothing else), so they use the
 * fast in-memory `MeriHermesRunStore`. The budget cap is proved BOTH on the
 * in-memory store and against the LOCAL fixture Postgres through
 * `MeriHermesPrismaRunRepository`, because "is this an atomic cap?" is a
 * property of the storage statement, not of the broker.
 *
 * Local fixture database only (container `capiro-postgres`) — never a
 * remote/production database. Every fixture id is a fresh `randomUUID()` and
 * everything created is cascade-deleted via the fixture tenant in `afterAll`.
 */
import { randomUUID } from 'node:crypto';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { MemoryCandidateService } from '../../memory/memory-candidate.service.js';
import {
  MERI_HERMES_BROKER_TOOLS,
  MERI_HERMES_TOOL_EFFECTS,
  isReadOnlySafeTool,
  type MeriHermesAuthorizationEnvelope,
  type MeriHermesBrokerTool,
} from './hermes-runtime.contracts.js';
import { MeriHermesBrokerService, type MeriHermesBrokerAuth } from './meri-hermes-broker.service.js';
import { MeriHermesPrismaRunRepository } from './meri-hermes-prisma-run-repository.js';
import { MeriHermesRunStore, type MeriHermesRunRecord } from './meri-hermes-run-store.js';
import type { MeriHermesRecallPort, MeriHermesRecallResult } from './meri-hermes-recall.ports.js';
import type { MeriHermesRuntimeAdapter } from './meri-hermes-runtime.adapter.js';
import type { MeriHermesArtifactStorageService } from './meri-hermes-artifact-storage.service.js';
import type { MeriHermesWorkerTokenClaims } from './meri-hermes-worker-token.js';

function assertLocalFixtureDatabase(url: string | undefined): void {
  if (!url) throw new Error('DATABASE_URL is required to run meri-hermes-broker-tool-gate.spec.ts');
  const parsed = new URL(url);
  if (!['localhost', '127.0.0.1'].includes(parsed.hostname)) {
    throw new Error(
      `meri-hermes-broker-tool-gate.spec.ts refuses to run against a non-local DATABASE_URL host (${parsed.hostname}). ` +
        'This suite writes and deletes rows and must only ever target the local fixture Postgres.',
    );
  }
}
assertLocalFixtureDatabase(process.env.DATABASE_URL);

/**
 * A tool name that is NOT in `MERI_HERMES_BROKER_TOOLS` and therefore has no
 * entry in `MERI_HERMES_TOOL_EFFECTS`: the stand-in for "Phase 2 adds a tool
 * and forgets to classify it". The cast is the point of the test — it
 * reproduces a policy built by hand, or by a future dynamic registry, that
 * the compile-time exhaustiveness check never saw.
 */
const UNCLASSIFIED_TOOL = 'meri_send_email' as MeriHermesBrokerTool;

/** `assertTool` never touches these, so a dummy is honest rather than lazy. */
const UNUSED_CANDIDATES = {} as MemoryCandidateService;
const UNUSED_ADAPTER = {} as MeriHermesRuntimeAdapter;
const UNUSED_ARTIFACTS = {} as MeriHermesArtifactStorageService;

function emptyRecallResult(): MeriHermesRecallResult {
  return {
    path: 'direct_memory_items_prototype',
    items: [],
    coverage: { requested: 1, returned: 0, total: 0, sourceStatus: 'ok', complete: true, detail: null },
  };
}

describe('A7 — MeriHermesBrokerService.assertTool() tool gate', () => {
  let prisma: PrismaService;
  const tenantId = randomUUID();
  const actorId = randomUUID();
  let actorContext: TenantContext;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
    await prisma.withSystem(async (tx) => {
      await tx.tenant.create({
        data: {
          id: tenantId,
          slug: `meri-hermes-tool-gate-${tenantId}`,
          name: 'Meri Hermes tool-gate fixture',
          status: 'active',
        },
      });
      await tx.user.create({
        data: { id: actorId, clerkUserId: actorId, email: `${actorId}@meri-hermes-tool-gate.example.test` },
      });
      await tx.tenantMembership.create({
        data: { tenantId, userId: actorId, role: 'standard_user', status: 'active', joinedAt: new Date() },
      });
    });
    actorContext = {
      tenantId,
      tenantSlug: `meri-hermes-tool-gate-${tenantId}`,
      userId: actorId,
      clerkUserId: actorId,
      role: 'standard_user',
    };
  });

  afterAll(async () => {
    await prisma.withSystem((tx) => tx.tenant.delete({ where: { id: tenantId } })).catch(() => undefined);
    await prisma.withSystem((tx) => tx.user.delete({ where: { id: actorId } })).catch(() => undefined);
    await prisma.$disconnect();
  });

  function envelope(over: Partial<MeriHermesAuthorizationEnvelope> = {}): MeriHermesAuthorizationEnvelope {
    return {
      version: 1,
      tenantId,
      actorType: 'user',
      actorId,
      conversationId: randomUUID(),
      workspaceId: null,
      executionScopeId: `tenant:${tenantId}:user:${actorId}`,
      audience: 'private',
      authorizedClientIds: [],
      authorizedMailboxConnectionIds: [],
      toolPolicy: { allow: [...MERI_HERMES_BROKER_TOOLS], deny: [], readOnly: false },
      authorizationVersion: 'v1',
      runId: randomUUID(),
      traceId: randomUUID(),
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      budget: { maxToolCalls: 40, maxOutputTokens: 1000, maxWallClockMs: 60_000 },
      ...over,
    };
  }

  /**
   * `assertTool` reads only `auth.run`, so the auth envelope is built
   * directly rather than minted through `authorize()` — which is covered in
   * its own suite (meri-hermes-broker-isolation.spec.ts) and would add a
   * token round trip to every one of these policy assertions.
   */
  function authFor(run: MeriHermesRunRecord): MeriHermesBrokerAuth {
    return {
      claims: {
        v: 1,
        kind: 'meri-hermes-worker',
        jti: randomUUID(),
        executionScopeId: run.envelope.executionScopeId,
        tenantId: run.envelope.tenantId,
        actorType: 'user',
        actorId: run.envelope.actorId,
        authorizationVersion: run.envelope.authorizationVersion,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      } satisfies MeriHermesWorkerTokenClaims,
      run,
      membershipRole: 'standard_user',
    };
  }

  function brokerOn(
    runs: MeriHermesRunStore | MeriHermesPrismaRunRepository,
    recallPort: MeriHermesRecallPort = {} as MeriHermesRecallPort,
    adapter: MeriHermesRuntimeAdapter = UNUSED_ADAPTER,
  ): MeriHermesBrokerService {
    const broker = new MeriHermesBrokerService(
      prisma,
      runs,
      UNUSED_CANDIDATES,
      recallPort,
      adapter,
      UNUSED_ARTIFACTS,
    );
    broker.env = { MERI_HERMES_BROKER_SIGNING_KEY: 'tool-gate-spec-signing-key-0123456789-abcdef' };
    return broker;
  }

  async function inMemoryRun(
    over: Partial<MeriHermesAuthorizationEnvelope> = {},
    store = new MeriHermesRunStore(),
  ): Promise<{ store: MeriHermesRunStore; run: MeriHermesRunRecord }> {
    const created = await store.create({
      envelope: envelope(over),
      actorContext,
      idempotencyKey: `meri:${randomUUID()}`,
      userMessageId: null,
    });
    await store.update(created.runId, { hermesRunId: `hermes-${randomUUID()}`, status: 'running' });
    return { store, run: (await store.get(created.runId))! };
  }

  async function expectForbidden(
    promise: Promise<unknown>,
    body: { code: string; tool?: string },
  ): Promise<void> {
    let caught: unknown;
    try {
      await promise;
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ForbiddenException);
    expect((caught as ForbiddenException).getStatus()).toBe(403);
    expect((caught as ForbiddenException).getResponse()).toMatchObject(body);
  }

  // -------------------------------------------------------------------------
  // A3 — the allow-list is an allow-list
  // -------------------------------------------------------------------------

  describe('A3 — allow-list', () => {
    test('an EMPTY allow-list permits NOTHING (it used to permit everything)', async () => {
      const { store, run } = await inMemoryRun({ toolPolicy: { allow: [], deny: [], readOnly: false } });
      const broker = brokerOn(store);
      for (const tool of MERI_HERMES_BROKER_TOOLS) {
        await expectForbidden(broker.assertTool(authFor(run), tool), { code: 'tool_not_allowed', tool });
      }
      // The regression in one line: `policy.allow.length &&` short-circuited
      // on falsy 0, so every one of those six calls used to succeed.
      expect((await store.get(run.runId))!.brokerCalls).toBe(0);
    });

    test('a tool named in the allow-list is admitted; one not named is refused', async () => {
      const { store, run } = await inMemoryRun({
        toolPolicy: { allow: ['meri_memory_search'], deny: [], readOnly: false },
      });
      const broker = brokerOn(store);
      await expect(broker.assertTool(authFor(run), 'meri_memory_search')).resolves.toBeUndefined();
      await expectForbidden(broker.assertTool(authFor(run), 'meri_record_turn'), {
        code: 'tool_not_allowed',
        tool: 'meri_record_turn',
      });
    });

    test('the deny-list wins over the allow-list', async () => {
      const { store, run } = await inMemoryRun({
        toolPolicy: {
          allow: ['meri_memory_search', 'meri_record_turn'],
          deny: ['meri_memory_search'],
          readOnly: false,
        },
      });
      const broker = brokerOn(store);
      await expectForbidden(broker.assertTool(authFor(run), 'meri_memory_search'), {
        code: 'tool_denied',
        tool: 'meri_memory_search',
      });
      await expect(broker.assertTool(authFor(run), 'meri_record_turn')).resolves.toBeUndefined();
    });

    test('deny is evaluated BEFORE the allow-list: a tool in neither list reports tool_denied when denied', async () => {
      const { store, run } = await inMemoryRun({
        toolPolicy: { allow: [], deny: ['meri_publish_artifact'], readOnly: false },
      });
      const broker = brokerOn(store);
      await expectForbidden(broker.assertTool(authFor(run), 'meri_publish_artifact'), {
        code: 'tool_denied',
        tool: 'meri_publish_artifact',
      });
    });

    test('a refusal consumes no budget', async () => {
      const { store, run } = await inMemoryRun({
        toolPolicy: { allow: ['meri_memory_search'], deny: ['meri_memory_search'], readOnly: false },
      });
      const broker = brokerOn(store);
      await expectForbidden(broker.assertTool(authFor(run), 'meri_memory_search'), { code: 'tool_denied' });
      await expectForbidden(broker.assertTool(authFor(run), 'meri_record_turn'), { code: 'tool_not_allowed' });
      expect((await store.get(run.runId))!.brokerCalls).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // A5 — read-only classification is fail-closed
  // -------------------------------------------------------------------------

  describe('A5 — read-only runs', () => {
    test('every declared broker tool is classified, and the not-read-only-safe set is exactly the two writers', () => {
      expect(Object.keys(MERI_HERMES_TOOL_EFFECTS).sort()).toEqual([...MERI_HERMES_BROKER_TOOLS].sort());
      const refusedOnReadOnly = MERI_HERMES_BROKER_TOOLS.filter((tool) => !isReadOnlySafeTool(tool));
      expect(refusedOnReadOnly.sort()).toEqual(['meri_memory_propose', 'meri_publish_artifact']);
    });

    test('an UNCLASSIFIED tool is not read-only-safe (fail-closed by default, not fail-open)', () => {
      expect(isReadOnlySafeTool(UNCLASSIFIED_TOOL)).toBe(false);
      expect(isReadOnlySafeTool('')).toBe(false);
      expect(isReadOnlySafeTool('toString')).toBe(false);
    });

    test('a readOnly run refuses a mutating tool even when it is explicitly allowed', async () => {
      const { store, run } = await inMemoryRun({
        toolPolicy: { allow: [...MERI_HERMES_BROKER_TOOLS], deny: [], readOnly: true },
      });
      const broker = brokerOn(store);
      await expectForbidden(broker.assertTool(authFor(run), 'meri_memory_propose'), {
        code: 'read_only_run',
        tool: 'meri_memory_propose',
      });
      await expectForbidden(broker.assertTool(authFor(run), 'meri_publish_artifact'), {
        code: 'read_only_run',
        tool: 'meri_publish_artifact',
      });
    });

    test('a readOnly run refuses an UNCLASSIFIED new tool — the A5 regression', async () => {
      const { store, run } = await inMemoryRun({
        toolPolicy: { allow: [UNCLASSIFIED_TOOL], deny: [], readOnly: true },
      });
      const broker = brokerOn(store);
      // Under the old hand-maintained MUTATING_TOOLS set this call SUCCEEDED:
      // the tool was absent from the set, so it was assumed read-only.
      await expectForbidden(broker.assertTool(authFor(run), UNCLASSIFIED_TOOL), {
        code: 'read_only_run',
        tool: UNCLASSIFIED_TOOL,
      });
      expect((await store.get(run.runId))!.brokerCalls).toBe(0);
    });

    test('a readOnly run still admits reads and run-local tools', async () => {
      const { store, run } = await inMemoryRun({
        toolPolicy: { allow: [...MERI_HERMES_BROKER_TOOLS], deny: [], readOnly: true },
      });
      const broker = brokerOn(store);
      for (const tool of ['meri_memory_search', 'meri_fetch_attachment', 'meri_record_turn', 'meri_request_clarification'] as const) {
        await expect(broker.assertTool(authFor(run), tool)).resolves.toBeUndefined();
      }
      expect((await store.get(run.runId))!.brokerCalls).toBe(4);
    });

    test('a non-readOnly run admits a mutating tool', async () => {
      const { store, run } = await inMemoryRun({
        toolPolicy: { allow: ['meri_memory_propose'], deny: [], readOnly: false },
      });
      const broker = brokerOn(store);
      await expect(broker.assertTool(authFor(run), 'meri_memory_propose')).resolves.toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // A4 — the tool budget is an actual cap
  // -------------------------------------------------------------------------

  describe('A4 — tool budget', () => {
    test('sequential calls: the budget admits exactly maxToolCalls and then refuses', async () => {
      const { store, run } = await inMemoryRun({
        budget: { maxToolCalls: 3, maxOutputTokens: 1000, maxWallClockMs: 60_000 },
      });
      const broker = brokerOn(store);
      for (let i = 0; i < 3; i += 1) {
        await expect(broker.assertTool(authFor(run), 'meri_record_turn')).resolves.toBeUndefined();
      }
      await expectForbidden(broker.assertTool(authFor(run), 'meri_record_turn'), {
        code: 'tool_budget_exhausted',
        tool: 'meri_record_turn',
      });
      expect((await store.get(run.runId))!.brokerCalls).toBe(3);
    });

    test('a budget of 0 admits nothing', async () => {
      const { store, run } = await inMemoryRun({
        budget: { maxToolCalls: 0, maxOutputTokens: 1000, maxWallClockMs: 60_000 },
      });
      const broker = brokerOn(store);
      await expectForbidden(broker.assertTool(authFor(run), 'meri_record_turn'), {
        code: 'tool_budget_exhausted',
      });
      expect((await store.get(run.runId))!.brokerCalls).toBe(0);
    });

    test('CONCURRENCY (in-memory store): 12 concurrent calls against a budget of 5 admit exactly 5', async () => {
      const maxToolCalls = 5;
      const concurrent = 12;
      const { store, run } = await inMemoryRun({
        budget: { maxToolCalls, maxOutputTokens: 1000, maxWallClockMs: 60_000 },
      });
      const broker = brokerOn(store);

      // Every call reads the SAME entry-time snapshot, which is exactly the
      // shape the old `auth.run.brokerCalls + 1` computation saw.
      const snapshot = authFor(run);
      const settled = await Promise.all(
        Array.from({ length: concurrent }, () =>
          broker
            .assertTool({ ...snapshot, run: { ...run, brokerCalls: 0 } }, 'meri_record_turn')
            .then(() => 'admitted' as const)
            .catch((error: unknown) => {
              expect(error).toBeInstanceOf(ForbiddenException);
              expect((error as ForbiddenException).getResponse()).toMatchObject({
                code: 'tool_budget_exhausted',
              });
              return 'refused' as const;
            }),
        ),
      );

      expect(settled.filter((r) => r === 'admitted')).toHaveLength(maxToolCalls);
      expect(settled.filter((r) => r === 'refused')).toHaveLength(concurrent - maxToolCalls);
      expect((await store.get(run.runId))!.brokerCalls).toBe(maxToolCalls);
    });

    test('CONCURRENCY (real Postgres): 12 concurrent calls against a budget of 5 admit exactly 5', async () => {
      const maxToolCalls = 5;
      const concurrent = 12;
      const repo = new MeriHermesPrismaRunRepository(prisma);
      const conversationId = randomUUID();
      await prisma.withTenant(tenantId, (tx) =>
        tx.clioConversation.create({
          data: { id: conversationId, tenantId, userId: actorId, title: 'Tool-gate budget fixture' },
        }),
      );
      const created = await repo.create({
        envelope: envelope({
          conversationId,
          budget: { maxToolCalls, maxOutputTokens: 1000, maxWallClockMs: 60_000 },
        }),
        actorContext,
        idempotencyKey: `meri:${randomUUID()}`,
        userMessageId: null,
      });
      const run = (await repo.get(created.runId))!;
      expect(run.brokerCalls).toBe(0);
      const broker = brokerOn(repo);
      const snapshot = authFor(run);

      const settled = await Promise.all(
        Array.from({ length: concurrent }, () =>
          broker
            .assertTool({ ...snapshot, run: { ...run, brokerCalls: 0 } }, 'meri_record_turn')
            .then(() => 'admitted' as const)
            .catch((error: unknown) => {
              expect(error).toBeInstanceOf(ForbiddenException);
              expect((error as ForbiddenException).getResponse()).toMatchObject({
                code: 'tool_budget_exhausted',
              });
              return 'refused' as const;
            }),
        ),
      );

      expect(settled.filter((r) => r === 'admitted')).toHaveLength(maxToolCalls);
      expect(settled.filter((r) => r === 'refused')).toHaveLength(concurrent - maxToolCalls);

      // The durable counter, read straight from the row, is the cap — not
      // `snapshot + 1` written N times.
      const row = await prisma.withTenant(tenantId, (tx) =>
        tx.meriAgentRun.findUnique({ where: { id: created.runId }, select: { brokerCalls: true } }),
      );
      expect(row?.brokerCalls).toBe(maxToolCalls);
    }, 60_000);

    test('reserveBrokerCall throws (never quietly refuses) for an unknown run', async () => {
      const store = new MeriHermesRunStore();
      await expect(store.reserveBrokerCall(randomUUID(), 5)).rejects.toThrow(/Unknown Hermes run/);
      const repo = new MeriHermesPrismaRunRepository(prisma);
      await expect(repo.reserveBrokerCall(randomUUID(), 5)).rejects.toThrow(/Unknown Hermes run/);
    });
  });

  // -------------------------------------------------------------------------
  // A6 — the F-1 release recheck has no fail-open fallback
  // -------------------------------------------------------------------------

  describe('A6 — pre-release authorization recheck', () => {
    /**
     * A store whose `get()` can be made to return null, reproducing "the run
     * record is gone by the time the governed read resolves". The old guard
     * was `(await this.runs.get(run.runId)) ?? run`, which silently swapped
     * in the ENTRY-TIME snapshot and validated that instead.
     */
    class VanishingRunStore extends MeriHermesRunStore {
      vanished = false;
      override async get(runId: string): Promise<MeriHermesRunRecord | null> {
        return this.vanished ? null : super.get(runId);
      }
    }

    test('a missing run row at release is a hard run_not_live, and the payload is withheld', async () => {
      const store = new VanishingRunStore();
      const { run } = await inMemoryRun(
        { toolPolicy: { allow: ['meri_memory_search'], deny: [], readOnly: true } },
        store,
      );

      let recallCalled = 0;
      const recallPort: MeriHermesRecallPort = {
        async recall() {
          recallCalled += 1;
          // The revocation/disappearance lands WHILE the governed read is in
          // flight — the exact window F-1 exists to close.
          store.vanished = true;
          return {
            ...emptyRecallResult(),
            items: [
              {
                sourceId: randomUUID(),
                domain: 'institutional_knowledge',
                title: 'secret',
                scope: 'firm',
                clientId: null,
                excerpt: 'must-not-be-released',
                updatedAt: null,
                provenance: null,
              },
            ],
          };
        },
      };
      const broker = brokerOn(store, recallPort);

      let caught: unknown;
      try {
        await broker.recall(authFor(run), { query: 'anything' });
      } catch (error) {
        caught = error;
      }
      expect(recallCalled).toBe(1);
      expect(caught).toBeInstanceOf(ConflictException);
      expect((caught as ConflictException).getStatus()).toBe(409);
      expect((caught as ConflictException).getResponse()).toMatchObject({
        code: 'run_not_live',
        status: 'missing',
      });
    });

    test('a Stop committed during recall withholds the result at release', async () => {
      const store = new MeriHermesRunStore();
      const { run } = await inMemoryRun(
        { toolPolicy: { allow: ['meri_memory_search'], deny: [], readOnly: true } },
        store,
      );
      let recallCalled = 0;
      const recallPort: MeriHermesRecallPort = {
        async recall() {
          recallCalled += 1;
          await store.update(run.runId, { status: 'cancelling', stopRequestedAt: new Date().toISOString() });
          return {
            ...emptyRecallResult(),
            items: [
              {
                sourceId: randomUUID(),
                domain: 'institutional_knowledge',
                title: 'stopped-run-secret',
                scope: 'firm',
                clientId: null,
                excerpt: 'must-not-be-released-after-stop',
                updatedAt: null,
                provenance: null,
              },
            ],
          };
        },
      };
      const broker = brokerOn(store, recallPort);
      // The in-memory store mutates its own object on update. Keep the entry
      // snapshot separate so this only passes if release re-reads the row.
      const entryAuth = authFor({ ...run });

      let caught: unknown;
      try {
        await broker.recall(entryAuth, { query: 'anything' });
      } catch (error) {
        caught = error;
      }
      expect(recallCalled).toBe(1);
      expect(entryAuth.run.status).toBe('running');
      expect(caught).toBeInstanceOf(ConflictException);
      expect((caught as ConflictException).getStatus()).toBe(409);
      expect((caught as ConflictException).getResponse()).toMatchObject({ code: 'run_not_live', status: 'cancelling' });
      expect((await store.eventsAfter(run.runId, 0, 'all')).some((event) => event.kind === 'memory.recalled')).toBe(false);
    });

    test('control: with the row present and authorization unchanged, the same read returns its payload', async () => {
      const store = new VanishingRunStore();
      const { run } = await inMemoryRun(
        { toolPolicy: { allow: ['meri_memory_search'], deny: [], readOnly: true } },
        store,
      );
      const recallPort: MeriHermesRecallPort = { async recall() { return emptyRecallResult(); } };
      const broker = brokerOn(store, recallPort);
      const result = await broker.recall(authFor(run), { query: 'anything' });
      expect(result.path).toBe('direct_memory_items_prototype');
      expect((await store.get(run.runId))!.brokerCalls).toBe(1);
    });
  });
});
