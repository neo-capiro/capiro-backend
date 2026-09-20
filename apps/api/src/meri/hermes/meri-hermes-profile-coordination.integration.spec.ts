/**
 * S-3 — profile-write coordination for two parallel conversations of ONE user.
 * Real local Postgres, real adapter, real repository.
 *
 * Runs against the LOCAL fixture database only (container `capiro-postgres`) —
 * never a remote/production database. One fixture tenant and user, fresh
 * conversation/scope ids, everything cascade-deleted through the tenant in
 * `afterAll`.
 *
 * Two conversations of one user share ONE execution scope and therefore one
 * writable Hermes home. The suite separates the two things that could go wrong
 * there, because they have different owners:
 *
 *   §A TRANSCRIPT CONTAMINATION — already solved by the per-conversation
 *      session key, and VERIFIED here through the real adapter (what it
 *      actually hands Hermes as `X-Hermes-Session-Key`) rather than
 *      reimplemented or asserted from the source.
 *   §B LOST SHARED-FILE UPDATES — not previously addressed. The suite first
 *      demonstrates that the hazard is real on an unguarded read-modify-write
 *      of the same column, then that the fenced single-writer path does not
 *      have it.
 *   §C STALE-WRITER REJECTION and VISIBLE serialization.
 */
import { randomUUID } from 'node:crypto';
import type { TenantContext } from '@capiro/shared';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';
import { MeriFeatureFlagsService } from '../meri-feature-flags.service.js';
import { MeriHermesPrismaRunRepository } from './meri-hermes-prisma-run-repository.js';
import { MeriHermesRuntimeAdapter } from './meri-hermes-runtime.adapter.js';
import { MeriHermesDbGovernor } from './meri-hermes-db-governor.js';
import {
  MeriHermesProfileBusyError,
  MeriHermesProfileLeaseService,
  MeriHermesStaleProfileWriterError,
} from './meri-hermes-profile-lease.service.js';
import { privateExecutionScopeId } from './meri-hermes-worker-token.js';
import type { MeriHermesRuntimeClient } from './meri-hermes-runtime.client.js';
import type { MeriHermesSecurityEnvelopePort } from './meri-hermes-security.port.js';
import type { MeriTurnMaintenance } from '../meri-turn-maintenance.js';

function assertLocalFixtureDatabase(url: string | undefined): void {
  if (!url) throw new Error('DATABASE_URL is required to run meri-hermes-profile-coordination.integration.spec.ts');
  const parsed = new URL(url);
  if (!['localhost', '127.0.0.1'].includes(parsed.hostname)) {
    throw new Error(
      `meri-hermes-profile-coordination.integration.spec.ts refuses to run against a non-local DATABASE_URL host (${parsed.hostname}). ` +
        'This suite writes and deletes rows and must only ever target the local fixture Postgres.',
    );
  }
}
assertLocalFixtureDatabase(process.env.DATABASE_URL);

describe('S-3 profile-write coordination for parallel conversations of one user (real local Postgres)', () => {
  let prisma: PrismaService;
  let profiles: MeriHermesProfileLeaseService;
  let tenantId: string;
  let userId: string;
  let ctx: TenantContext;
  let scopeId: string;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
    const governor = new MeriHermesDbGovernor();
    governor.env = { ...process.env, MERI_HERMES_DB_MAX_CONCURRENCY: '24' };
    profiles = new MeriHermesProfileLeaseService(prisma, governor);

    tenantId = randomUUID();
    userId = randomUUID();
    ctx = {
      tenantId,
      tenantSlug: `meri-hermes-profile-spec-${tenantId}`,
      userId,
      clerkUserId: userId,
      role: 'standard_user',
    };
    scopeId = privateExecutionScopeId(tenantId, userId);

    await prisma.withSystem(async (tx) => {
      await tx.tenant.create({
        data: {
          id: tenantId,
          slug: `meri-hermes-profile-spec-${tenantId}`,
          name: 'Meri Hermes profile-coordination spec fixture',
          status: 'active',
        },
      });
      await tx.user.create({ data: { id: userId, clerkUserId: userId, email: `${userId}@example.test` } });
    });
    await prisma.withTenant(tenantId, (tx) =>
      tx.meriExecutionScope.create({
        data: {
          id: scopeId,
          tenantId,
          principalType: 'user',
          principalId: userId,
          kind: 'private',
          authorizationVersion: 'v1:profile-spec',
        },
      }),
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

  async function resetProfileState(): Promise<void> {
    await prisma.withTenant(
      tenantId,
      (tx) => tx.$executeRaw`
        UPDATE meri_execution_scopes SET profile_state_jsonb = '{}'::jsonb WHERE id = ${scopeId}
      `,
    );
    await prisma.withTenant(
      tenantId,
      (tx) => tx.$executeRaw`DELETE FROM meri_agent_profile_leases WHERE scope_id = ${scopeId}`,
    );
  }

  // =========================================================================
  // §A — transcript identity: verified, not reimplemented
  // =========================================================================

  describe('A. transcripts cannot contaminate each other', () => {
    test('A1. two conversations of ONE user share one execution scope but get DISTINCT Hermes session keys — verified through the real adapter', async () => {
      const conversationOne = await makeConversation('S-3 conversation one');
      const conversationTwo = await makeConversation('S-3 conversation two');

      /**
       * The only test double is the Hermes HTTP worker itself (none runs in
       * CI). `createRun` records exactly what the adapter hands the runtime and
       * then fails, so each turn takes the adapter's own documented
       * runtime-unavailable path and finalizes honestly — which is all this
       * test needs, since the assertion is about what was SENT.
       */
      const sent: Array<{ sessionKey?: string | null; sessionId?: string | null; input: string }> = [];
      const fakeClient = {
        forScope: jest.fn(() => ({
          createRun: jest.fn(async (args: { sessionKey?: string | null; sessionId?: string | null; input: string }) => {
            sent.push({ sessionKey: args.sessionKey, sessionId: args.sessionId, input: args.input });
            throw new Error('no Hermes worker in this test');
          }),
        })),
      } as unknown as MeriHermesRuntimeClient;

      const runs = new MeriHermesPrismaRunRepository(prisma);
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
        MERI_HERMES_API_KEY: 's3-profile-spec-placeholder-key',
        MERI_HERMES_BROKER_SIGNING_KEY: 's3-profile-spec-signing-key-0123456789',
      };
      const sse = { write: () => undefined };

      await adapter.streamMessage(ctx, conversationOne, 'first conversation question', sse);
      await adapter.streamMessage(ctx, conversationTwo, 'second conversation question', sse);

      expect(sent).toHaveLength(2);
      const [keyOne, keyTwo] = sent.map((s) => s.sessionKey);
      // The premise: ONE shared execution scope / writable home...
      expect(keyOne).toContain(scopeId);
      expect(keyTwo).toContain(scopeId);
      // ...and yet two different transcripts, named per CONVERSATION. On the
      // pinned build the session key IS the transcript name, so this is the
      // property that keeps the two conversations from blending (Phase 0
      // harness D3/D6 found the per-user key doing exactly that).
      expect(keyOne).toBe(`${scopeId}:conversation:${conversationOne}`);
      expect(keyTwo).toBe(`${scopeId}:conversation:${conversationTwo}`);
      expect(keyOne).not.toBe(keyTwo);
      // Neither turn resumed the other's Hermes session.
      expect(sent[0]!.sessionId).toBeNull();
      expect(sent[1]!.sessionId).toBeNull();

      // And each conversation kept its own durable record and its own text.
      const runsOne = await runs.listForConversation(tenantId, userId, conversationOne);
      const runsTwo = await runs.listForConversation(tenantId, userId, conversationTwo);
      expect(runsOne).toHaveLength(1);
      expect(runsTwo).toHaveLength(1);
      expect(runsOne[0]!.runId).not.toBe(runsTwo[0]!.runId);
      expect(sent[0]!.input).toContain('first conversation question');
      expect(sent[1]!.input).toContain('second conversation question');
      expect(sent[1]!.input).not.toContain('first conversation question');
    });
  });

  // =========================================================================
  // §B — shared-file updates
  // =========================================================================

  describe('B. shared profile updates are not lost', () => {
    beforeEach(resetProfileState);

    test('B1. the hazard is REAL: an unguarded read-modify-write of the shared profile column loses one of two concurrent updates', async () => {
      // Exactly what a naive "read the profile, change it, write it back" does.
      const unguarded = async (key: string): Promise<void> => {
        const rows = await prisma.withTenant(tenantId, (tx) =>
          tx.$queryRaw<Array<{ profile_state_jsonb: Record<string, unknown> }>>(Prisma.sql`
            SELECT profile_state_jsonb FROM meri_execution_scopes WHERE id = ${scopeId}
          `),
        );
        const current = rows[0]?.profile_state_jsonb ?? {};
        await new Promise((r) => setTimeout(r, 60)); // the window every RMW has
        const next = { ...current, [key]: true } as Prisma.InputJsonValue;
        await prisma.withTenant(
          tenantId,
          (tx) => tx.$executeRaw`
            UPDATE meri_execution_scopes SET profile_state_jsonb = ${next} WHERE id = ${scopeId}
          `,
        );
      };

      await Promise.all([unguarded('fromConversationOne'), unguarded('fromConversationTwo')]);

      const state = await profiles.readSharedProfileState(tenantId, scopeId);
      const landed = ['fromConversationOne', 'fromConversationTwo'].filter((k) => state[k] === true);
      expect(landed).toHaveLength(1); // one update was silently lost
    });

    test('B2. the fenced single-writer path does NOT lose either update — both concurrent conversations land', async () => {
      const runOne = randomUUID();
      const runTwo = randomUUID();

      const guarded = (runId: string, key: string) =>
        profiles.withProfileWrite({ scopeId, tenantId, runId, waitMs: 10_000, pollMs: 10 }, (lease) =>
          profiles.writeSharedProfileState({
            scopeId,
            tenantId,
            runId,
            fence: lease.fence,
            mutate: (current) => ({ ...current, [key]: true }),
          }),
        );

      await Promise.all([guarded(runOne, 'fromConversationOne'), guarded(runTwo, 'fromConversationTwo')]);

      const state = await profiles.readSharedProfileState(tenantId, scopeId);
      expect(state.fromConversationOne).toBe(true);
      expect(state.fromConversationTwo).toBe(true);
    });

    test('B3. and it holds under more pressure: 10 concurrent writers each add their own key, all 10 survive', async () => {
      const keys = Array.from({ length: 10 }, (_, i) => `writer${i}`);
      await Promise.all(
        keys.map((key) => {
          const runId = randomUUID();
          return profiles.withProfileWrite({ scopeId, tenantId, runId, waitMs: 20_000, pollMs: 5 }, (lease) =>
            profiles.writeSharedProfileState({
              scopeId,
              tenantId,
              runId,
              fence: lease.fence,
              mutate: (current) => ({ ...current, [key]: (Number(current[key] ?? 0) as number) + 1 }),
            }),
          );
        }),
      );
      const state = await profiles.readSharedProfileState(tenantId, scopeId);
      for (const key of keys) expect(state[key]).toBe(1);
    });
  });

  // =========================================================================
  // §C — one writer, stale-writer rejection, visible serialization
  // =========================================================================

  describe('C. one writer per writable profile, with stale-writer rejection', () => {
    beforeEach(resetProfileState);

    test('C1. only one run holds the writable profile at a time; a second run is told who has it rather than corrupting it', async () => {
      const holder = randomUUID();
      const other = randomUUID();

      const lease = await profiles.acquire({ scopeId, tenantId, runId: holder, ttlMs: 30_000 });
      expect(lease).not.toBeNull();
      expect(lease!.holderRunId).toBe(holder);

      expect(await profiles.acquire({ scopeId, tenantId, runId: other, ttlMs: 30_000 })).toBeNull();
      await expect(profiles.holder(tenantId, scopeId)).resolves.toMatchObject({
        holderRunId: holder,
        expired: false,
      });

      // Released, then freely available.
      expect(await profiles.release({ scopeId, tenantId, runId: holder, fence: lease!.fence })).toBe(true);
      expect(await profiles.acquire({ scopeId, tenantId, runId: other, ttlMs: 30_000 })).not.toBeNull();
    });

    test('C2. renewing your OWN live lease keeps your fence, so a holder does not invalidate its own token', async () => {
      const holder = randomUUID();
      const first = await profiles.acquire({ scopeId, tenantId, runId: holder, ttlMs: 30_000 });
      const renewed = await profiles.renew({ scopeId, tenantId, runId: holder, fence: first!.fence, ttlMs: 30_000 });
      const reacquired = await profiles.acquire({ scopeId, tenantId, runId: holder, ttlMs: 30_000 });
      expect(renewed.fence).toBe(first!.fence);
      expect(reacquired!.fence).toBe(first!.fence);

      // The fenced write still works with the original token.
      await expect(
        profiles.writeSharedProfileState({
          scopeId,
          tenantId,
          runId: holder,
          fence: first!.fence,
          mutate: (c) => ({ ...c, stillMine: true }),
        }),
      ).resolves.toMatchObject({ stillMine: true });
    });

    test('C3. STALE WRITER: a holder whose lease expired and was taken over has BOTH its renew and its write rejected at the database', async () => {
      const oldWriter = randomUUID();
      const newWriter = randomUUID();

      // A lease that is already over by the time the takeover happens.
      const stale = await profiles.acquire({ scopeId, tenantId, runId: oldWriter, ttlMs: 1 });
      expect(stale).not.toBeNull();
      await new Promise((r) => setTimeout(r, 30));

      const taken = await profiles.acquire({ scopeId, tenantId, runId: newWriter, ttlMs: 30_000 });
      expect(taken).not.toBeNull();
      // A takeover bumps the fence. That is what makes the old token stale.
      expect(taken!.fence).toBe(stale!.fence + 1);

      await expect(
        profiles.renew({ scopeId, tenantId, runId: oldWriter, fence: stale!.fence, ttlMs: 30_000 }),
      ).rejects.toBeInstanceOf(MeriHermesStaleProfileWriterError);

      const rejected = await profiles
        .writeSharedProfileState({
          scopeId,
          tenantId,
          runId: oldWriter,
          fence: stale!.fence,
          mutate: (c) => ({ ...c, writtenByStaleWriter: true }),
        })
        .catch((e) => e);
      expect(rejected).toBeInstanceOf(MeriHermesStaleProfileWriterError);
      expect((rejected as MeriHermesStaleProfileWriterError).code).toBe('stale_profile_writer');
      expect((rejected as MeriHermesStaleProfileWriterError).currentHolder?.holderRunId).toBe(newWriter);

      // Nothing was written — the rejection is not advisory.
      const state = await profiles.readSharedProfileState(tenantId, scopeId);
      expect(state.writtenByStaleWriter).toBeUndefined();

      // And the CURRENT writer is unaffected.
      await expect(
        profiles.writeSharedProfileState({
          scopeId,
          tenantId,
          runId: newWriter,
          fence: taken!.fence,
          mutate: (c) => ({ ...c, writtenByCurrentWriter: true }),
        }),
      ).resolves.toMatchObject({ writtenByCurrentWriter: true });
    });

    test('C4. a stale writer cannot RELEASE the current writer’s lease either', async () => {
      const oldWriter = randomUUID();
      const newWriter = randomUUID();
      const stale = await profiles.acquire({ scopeId, tenantId, runId: oldWriter, ttlMs: 1 });
      await new Promise((r) => setTimeout(r, 30));
      const taken = await profiles.acquire({ scopeId, tenantId, runId: newWriter, ttlMs: 30_000 });

      expect(await profiles.release({ scopeId, tenantId, runId: oldWriter, fence: stale!.fence })).toBe(false);
      await expect(profiles.holder(tenantId, scopeId)).resolves.toMatchObject({
        holderRunId: newWriter,
        fence: taken!.fence,
      });
    });

    test('C5. required serialization is VISIBLE: a waiting writer is told who holds the profile, and a bounded wait ends in an actionable error rather than a hang', async () => {
      const holder = randomUUID();
      const waiter = randomUUID();
      await profiles.acquire({ scopeId, tenantId, runId: holder, ttlMs: 30_000 });

      const seen: Array<{ holderRunId: string | undefined; waitedMs: number }> = [];
      const busy = await profiles
        .acquireOrWait({
          scopeId,
          tenantId,
          runId: waiter,
          waitMs: 150,
          pollMs: 20,
          onWait: (h, waitedMs) => seen.push({ holderRunId: h?.holderRunId, waitedMs }),
        })
        .catch((e) => e);

      expect(busy).toBeInstanceOf(MeriHermesProfileBusyError);
      expect((busy as MeriHermesProfileBusyError).code).toBe('profile_write_busy');
      expect((busy as MeriHermesProfileBusyError).message).toMatch(/Another conversation in this workspace/);
      // It was surfaced while waiting, not only at the end, and it names the
      // run that is holding the profile.
      expect(seen.length).toBeGreaterThan(0);
      expect(seen[0]!.holderRunId).toBe(holder);
    });

    test('C6. a contended profile write is surfaced in RUN STATE, not as a silent block: the adapter appends a public waiting event', async () => {
      const conversationId = await makeConversation('S-3 contended profile write');
      const foreignHolder = randomUUID();
      // Someone else is holding the writable profile for the whole turn.
      await profiles.acquire({ scopeId, tenantId, runId: foreignHolder, ttlMs: 30_000 });

      const fakeClient = {
        forScope: jest.fn(() => ({
          createRun: jest.fn(async () => {
            throw new Error('no Hermes worker in this test');
          }),
        })),
      } as unknown as MeriHermesRuntimeClient;
      const runs = new MeriHermesPrismaRunRepository(prisma);
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
        MERI_HERMES_API_KEY: 's3-profile-spec-placeholder-key',
        MERI_HERMES_BROKER_SIGNING_KEY: 's3-profile-spec-signing-key-0123456789',
      };
      // A short, bounded wait so the test does not sit out the 15 s default.
      const contendedProfiles = new MeriHermesProfileLeaseService(prisma, new MeriHermesDbGovernor());
      contendedProfiles.env = {
        ...process.env,
        MERI_HERMES_PROFILE_LEASE_WAIT_MS: '120',
        MERI_HERMES_PROFILE_LEASE_POLL_MS: '20',
      };
      adapter.profiles = contendedProfiles;

      const frames: Array<Record<string, unknown>> = [];
      const sse = {
        write(data: string) {
          const match = /^data: (.*)\n\n$/.exec(data);
          if (match) frames.push(JSON.parse(match[1]!));
        },
      };
      await adapter.streamMessage(ctx, conversationId, 'a turn that must wait for the profile', sse);

      const [run] = await runs.listForConversation(tenantId, userId, conversationId);
      expect(run).toBeDefined();
      const events = await runs.eventsAfter(run!.runId, 0, 'all');

      // VISIBLE in run state: a public event a reconnecting browser replays...
      const waiting = events.find((e) => e.payload.waitingFor === 'profile_write');
      expect(waiting).toBeDefined();
      expect(waiting!.visibility).toBe('public');
      expect(waiting!.payload.holderRunId).toBe(foreignHolder);
      // ...and on the live stream too.
      expect(frames.some((f) => f.state === 'waiting_for_profile_write')).toBe(true);

      // The wait is bounded and the turn still reached a terminal state rather
      // than hanging on a profile it could not get.
      const skipped = events.find((e) => e.payload.profileWrite === 'skipped');
      expect(skipped?.payload.reason).toBe('busy');
      const finished = await runs.get(run!.runId);
      expect(['failed', 'interrupted', 'completed', 'cancelled', 'expired']).toContain(finished!.status);
    });
  });
});
