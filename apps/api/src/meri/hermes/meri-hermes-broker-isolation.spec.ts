/**
 * Phase 1 backlog #19 — "Isolation acceptance suite in CI": ISO4, the worker
 * credential boundary (docs/meri/hermes/phase-0/checks-report.md §A;
 * evidence docs/meri/hermes/phase-0/evidence/2026-09-19T13-48-15-436Z/ISO4.json).
 *
 * ISO4 lives in its own file (see meri-hermes-isolation.spec.ts's header
 * comment for the split rationale): it exercises MeriHermesBrokerService's
 * worker-token authorize() boundary — the ONLY path a Hermes WORKER has into
 * application data — rather than the browser-facing controller/adapter/gate.
 *
 * `authorize()` is exercised directly (the same call the real
 * MeriHermesWorkerTokenGuard makes; see meri-hermes-broker.controller.ts) so
 * every assertion is against the real production error code / HTTP status
 * pair, not a re-implementation of it. Only the run repository is the fast
 * in-memory MeriHermesRunStore (Phase 1 also ships MeriHermesPrismaRunRepository
 * behind the identical interface — see that class's own real-Postgres spec);
 * the tenant/membership check inside authorize() runs against the LOCAL
 * fixture Postgres (container `capiro-postgres`) exactly as production does.
 */
import { randomUUID } from 'node:crypto';
import { ConflictException, ForbiddenException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { MemoryCandidateService } from '../../memory/memory-candidate.service.js';
import type { MeriHermesAuthorizationEnvelope } from './hermes-runtime.contracts.js';
import { MeriHermesBrokerService } from './meri-hermes-broker.service.js';
import { MeriHermesRuntimeAdapter } from './meri-hermes-runtime.adapter.js';
import type { MeriHermesRuntimeClient } from './meri-hermes-runtime.client.js';
import type { MeriFeatureFlagsService } from '../meri-feature-flags.service.js';
import type { MeriHermesSecurityEnvelopePort } from './meri-hermes-security.port.js';
import type { MeriTurnMaintenance } from '../meri-turn-maintenance.js';
import type { MeriHermesArtifactStorageService } from './meri-hermes-artifact-storage.service.js';
import { MeriHermesRunStore } from './meri-hermes-run-store.js';
import type { MeriHermesRecallPort } from './meri-hermes-recall.ports.js';
import { mintMeriHermesWorkerToken, privateExecutionScopeId } from './meri-hermes-worker-token.js';

function assertLocalFixtureDatabase(url: string | undefined): void {
  if (!url) throw new Error('DATABASE_URL is required to run meri-hermes-broker-isolation.spec.ts');
  const parsed = new URL(url);
  if (!['localhost', '127.0.0.1'].includes(parsed.hostname)) {
    throw new Error(
      `meri-hermes-broker-isolation.spec.ts refuses to run against a non-local DATABASE_URL host (${parsed.hostname}). ` +
        'This suite writes and deletes rows and must only ever target the local fixture Postgres.',
    );
  }
}
assertLocalFixtureDatabase(process.env.DATABASE_URL);

const SIGNING_KEY = 'iso4-broker-isolation-spec-signing-key-0123456789';

describe('ISO4 — broker worker-token credential boundary (MeriHermesBrokerService.authorize)', () => {
  let prisma: PrismaService;
  let runs: MeriHermesRunStore;
  let broker: MeriHermesBrokerService;
  const tenantId = randomUUID();
  const aliceId = randomUUID();
  const bobId = randomUUID();
  let aliceCtx: TenantContext;
  let bobCtx: TenantContext;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
    runs = new MeriHermesRunStore();
    broker = new MeriHermesBrokerService(
      prisma,
      runs,
      {} as MemoryCandidateService, // unused by authorize()
      {} as MeriHermesRecallPort, // unused by authorize()
      // Revocation-fencing (backlog #7): authorize() calls
      // adapter.stopWorkerAndFinalize() only on the expiry / authorization-
      // version-mismatch / membership-revoked branches, none of which this
      // suite's scenarios reach (they all throw earlier: bad token, unknown
      // run, scope mismatch, or an already-non-live run) — a dummy is safe.
      {} as MeriHermesRuntimeAdapter,
      {} as MeriHermesArtifactStorageService, // unused by authorize()
    );
    broker.env = { MERI_HERMES_BROKER_SIGNING_KEY: SIGNING_KEY };

    await prisma.withSystem(async (tx) => {
      await tx.tenant.create({
        data: { id: tenantId, slug: `meri-hermes-broker-iso-${tenantId}`, name: 'Meri Hermes broker ISO4 fixture', status: 'active' },
      });
      for (const id of [aliceId, bobId]) {
        await tx.user.create({ data: { id, clerkUserId: id, email: `${id}@meri-hermes-broker-iso.example.test` } });
        await tx.tenantMembership.create({ data: { tenantId, userId: id, role: 'standard_user', status: 'active', joinedAt: new Date() } });
      }
    });

    aliceCtx = { tenantId, tenantSlug: 'fixture', userId: aliceId, clerkUserId: aliceId, role: 'standard_user' };
    bobCtx = { tenantId, tenantSlug: 'fixture', userId: bobId, clerkUserId: bobId, role: 'standard_user' };
  });

  afterAll(async () => {
    await prisma.withSystem((tx) => tx.tenant.delete({ where: { id: tenantId } })).catch(() => undefined);
    await prisma.withSystem((tx) => tx.user.delete({ where: { id: aliceId } })).catch(() => undefined);
    await prisma.withSystem((tx) => tx.user.delete({ where: { id: bobId } })).catch(() => undefined);
    await prisma.$disconnect();
  });

  function envelope(ctx: TenantContext, over: Partial<MeriHermesAuthorizationEnvelope> = {}): MeriHermesAuthorizationEnvelope {
    return {
      version: 1,
      tenantId: ctx.tenantId,
      actorType: 'user',
      actorId: ctx.userId,
      conversationId: randomUUID(),
      workspaceId: null,
      executionScopeId: privateExecutionScopeId(ctx.tenantId, ctx.userId),
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

  async function makeLiveRun(
    ctx: TenantContext,
    hermesRunId: string,
    envelopeOver: Partial<MeriHermesAuthorizationEnvelope> = {},
  ) {
    const run = await runs.create({
      envelope: envelope(ctx, envelopeOver),
      actorContext: ctx,
      idempotencyKey: `meri:${randomUUID()}`,
      userMessageId: null,
    });
    await runs.update(run.runId, { hermesRunId, status: 'running' });
    return (await runs.get(run.runId))!;
  }

  function tokenFor(ctx: TenantContext, run: { envelope: MeriHermesAuthorizationEnvelope }) {
    return mintMeriHermesWorkerToken(
      {
        executionScopeId: run.envelope.executionScopeId,
        tenantId: ctx.tenantId,
        actorType: 'user',
        actorId: ctx.userId,
        authorizationVersion: run.envelope.authorizationVersion,
      },
      SIGNING_KEY,
    ).token;
  }

  test('baseline: the owning actor with a valid token on her own live run authorizes successfully', async () => {
    const aliceRun = await makeLiveRun(aliceCtx, `hermes-baseline-${randomUUID()}`);
    const auth = await broker.authorize(tokenFor(aliceCtx, aliceRun), aliceRun.hermesRunId);
    expect(auth.run.runId).toBe(aliceRun.runId);
    expect(auth.claims.actorId).toBe(aliceId);
    expect(auth.membershipRole).toBe('standard_user');
  });

  test('a tampered token (flipped signature byte) is refused: 401 unauthorized', async () => {
    const aliceRun = await makeLiveRun(aliceCtx, `hermes-tampered-${randomUUID()}`);
    const good = tokenFor(aliceCtx, aliceRun);
    const [prefix, payload, signature] = good.split('.');
    // Flip a whole byte of the DECODED signature (not a character of its
    // base64url text): the last base64 character of a 32-byte HMAC digest
    // encodes two padding bits that base64 doesn't use, so toggling only the
    // last character can — depending on which character it happens to be —
    // leave the decoded bytes unchanged and make this test flaky. Flipping a
    // full decoded byte is unconditionally a real signature change.
    const sigBytes = Buffer.from(signature!, 'base64url');
    sigBytes[0] = sigBytes[0]! ^ 0xff;
    const tamperedSig = sigBytes.toString('base64url');
    const tampered = `${prefix}.${payload}.${tamperedSig}`;

    let caught: unknown;
    try {
      await broker.authorize(tampered, aliceRun.hermesRunId);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(UnauthorizedException);
    expect((caught as UnauthorizedException).getStatus()).toBe(401);
    expect((caught as UnauthorizedException).getResponse()).toMatchObject({ code: 'worker_token_bad_signature' });
  });

  test("Bob's own valid token used against Alice's run is refused: 403 scope_mismatch (never treated as Bob's own run)", async () => {
    const aliceRun = await makeLiveRun(aliceCtx, `hermes-scope-alice-${randomUUID()}`);
    const bobRun = await makeLiveRun(bobCtx, `hermes-scope-bob-${randomUUID()}`);
    const bobToken = tokenFor(bobCtx, bobRun);

    let caught: unknown;
    try {
      await broker.authorize(bobToken, aliceRun.hermesRunId);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ForbiddenException);
    expect((caught as ForbiddenException).getStatus()).toBe(403);
    expect((caught as ForbiddenException).getResponse()).toMatchObject({ code: 'scope_mismatch' });
  });

  test('an unknown Hermes run id (never admitted, or from a run this broker has no record of) is refused: 404 run_not_found', async () => {
    const aliceRun = await makeLiveRun(aliceCtx, `hermes-known-${randomUUID()}`);
    const aliceToken = tokenFor(aliceCtx, aliceRun);

    let caught: unknown;
    try {
      await broker.authorize(aliceToken, `hermes-never-existed-${randomUUID()}`);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(NotFoundException);
    expect((caught as NotFoundException).getStatus()).toBe(404);
    expect((caught as NotFoundException).getResponse()).toMatchObject({ code: 'run_not_found' });
  });

  test('a missing token (no Authorization header parsed at all) is refused: 401 missing_worker_token', async () => {
    let caught: unknown;
    try {
      await broker.authorize(null, `hermes-anything-${randomUUID()}`);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(UnauthorizedException);
    expect((caught as UnauthorizedException).getStatus()).toBe(401);
    expect((caught as UnauthorizedException).getResponse()).toMatchObject({ code: 'missing_worker_token' });
  });

  test('a call against an already-finished (terminal) run is refused: 409 run_not_live, even with an otherwise perfectly valid token', async () => {
    const aliceRun = await makeLiveRun(aliceCtx, `hermes-terminal-${randomUUID()}`);
    const aliceToken = tokenFor(aliceCtx, aliceRun);
    await runs.update(aliceRun.runId, { status: 'completed', finishReason: 'stop' });

    let caught: unknown;
    try {
      await broker.authorize(aliceToken, aliceRun.hermesRunId);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConflictException);
    expect((caught as ConflictException).getStatus()).toBe(409);
    expect((caught as ConflictException).getResponse()).toMatchObject({ code: 'run_not_live', status: 'completed' });
  });

  test('a cancelling run is refused before worker finalization, even without a Stop timestamp', async () => {
    const aliceRun = await makeLiveRun(aliceCtx, `hermes-cancelling-${randomUUID()}`);
    const aliceToken = tokenFor(aliceCtx, aliceRun);
    await runs.update(aliceRun.runId, { status: 'cancelling' });

    let caught: unknown;
    try {
      await broker.authorize(aliceToken, aliceRun.hermesRunId);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConflictException);
    expect((caught as ConflictException).getStatus()).toBe(409);
    expect((caught as ConflictException).getResponse()).toMatchObject({ code: 'run_not_live', status: 'cancelling' });
  });

  test('the durable Stop timestamp still refuses a call if an older operation overwrote the nonterminal status', async () => {
    const aliceRun = await makeLiveRun(aliceCtx, `hermes-stop-timestamp-${randomUUID()}`);
    const aliceToken = tokenFor(aliceCtx, aliceRun);
    await runs.update(aliceRun.runId, { status: 'cancelling', stopRequestedAt: new Date().toISOString() });
    await runs.update(aliceRun.runId, { status: 'waiting_for_clarification' });

    let caught: unknown;
    try {
      await broker.authorize(aliceToken, aliceRun.hermesRunId);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConflictException);
    expect((caught as ConflictException).getStatus()).toBe(409);
    expect((caught as ConflictException).getResponse()).toMatchObject({
      code: 'run_not_live',
      status: 'waiting_for_clarification',
    });
  });

  /**
   * Phase 1 backlog #7 — revocation fencing. contracts.md §2: checking the
   * NEXT tool call cannot undo context the model already loaded into its
   * window, so a live authorization failure (expiry, authorization-version
   * mismatch, membership removal) must not just deny THIS call -- it must
   * stop the Hermes worker and fence the Meri run to a terminal state. These
   * tests use a SEPARATE broker instance wired to a real
   * `MeriHermesRuntimeAdapter` (with a fake, spy-able runtime client) instead
   * of the shared `broker` above (which uses a dummy adapter because none of
   * the tests above reach these branches).
   */
  describe('Phase 1 backlog #7 — revocation fencing (authorize() stops the Hermes worker and fences the run, not just denies the call)', () => {
    let stopRunSpy: ReturnType<typeof jest.fn>;
    let revocationBroker: MeriHermesBrokerService;
    const daveId = randomUUID();
    let daveCtx: TenantContext;

    beforeAll(async () => {
      stopRunSpy = jest.fn(async () => undefined);
      const fakeRuntimeClient = {
        forScope: () => fakeRuntimeClient,
        stopRun: stopRunSpy,
      } as unknown as MeriHermesRuntimeClient;
      const revocationAdapter = new MeriHermesRuntimeAdapter(
        prisma,
        {} as MeriFeatureFlagsService, // unused: shouldHandle()/streamMessage() are not exercised here
        fakeRuntimeClient,
        runs,
        {} as MeriHermesSecurityEnvelopePort, // unused: buildEnvelope() is not exercised here
        {} as MeriTurnMaintenance, // unused: finalize() with no conversation never schedules maintenance
      );
      revocationBroker = new MeriHermesBrokerService(
        prisma,
        runs,
        {} as MemoryCandidateService, // unused by authorize()
        {} as MeriHermesRecallPort, // unused by authorize()
        revocationAdapter,
        {} as MeriHermesArtifactStorageService, // unused by authorize()
      );
      revocationBroker.env = { MERI_HERMES_BROKER_SIGNING_KEY: SIGNING_KEY };

      await prisma.withSystem(async (tx) => {
        await tx.user.create({ data: { id: daveId, clerkUserId: daveId, email: `${daveId}@meri-hermes-broker-iso.example.test` } });
        await tx.tenantMembership.create({ data: { tenantId, userId: daveId, role: 'standard_user', status: 'active', joinedAt: new Date() } });
      });
      daveCtx = { tenantId, tenantSlug: 'fixture', userId: daveId, clerkUserId: daveId, role: 'standard_user' };
    });

    afterAll(async () => {
      await prisma.withSystem((tx) => tx.user.delete({ where: { id: daveId } })).catch(() => undefined);
    });

    beforeEach(() => {
      stopRunSpy.mockClear();
    });

    test('authorization version mismatch mid-run: denied AND the run is fenced to interrupted, with the Hermes worker actually asked to stop', async () => {
      const run = await makeLiveRun(aliceCtx, `hermes-version-mismatch-${randomUUID()}`);
      // Models a worker credential whose authorizationVersion claim no longer
      // matches this run's frozen envelope (e.g. a grant changed after
      // admission) -- authorize()'s equality check is what's under test, not
      // how a mismatched token would come to exist in production.
      const staleToken = mintMeriHermesWorkerToken(
        {
          executionScopeId: run.envelope.executionScopeId,
          tenantId: aliceCtx.tenantId,
          actorType: 'user',
          actorId: aliceCtx.userId,
          authorizationVersion: 'v1:stale-does-not-match-envelope',
        },
        SIGNING_KEY,
      ).token;

      let caught: unknown;
      try {
        await revocationBroker.authorize(staleToken, run.hermesRunId);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ForbiddenException);
      expect((caught as ForbiddenException).getStatus()).toBe(403);
      expect((caught as ForbiddenException).getResponse()).toMatchObject({ code: 'authorization_version_mismatch' });

      expect(stopRunSpy).toHaveBeenCalledTimes(1);
      expect(stopRunSpy).toHaveBeenCalledWith(run.hermesRunId);

      const after = await runs.get(run.runId);
      expect(after?.status).toBe('interrupted');
      expect(after?.finishReason).toBe('interrupted');
      expect(String(after?.error)).toMatch(/authorization_downgrade/);

      // A SUBSEQUENT call on the same (now-interrupted) run is rejected for
      // being non-live, never re-triggering another stop.
      let secondCaught: unknown;
      try {
        await revocationBroker.authorize(staleToken, run.hermesRunId);
      } catch (error) {
        secondCaught = error;
      }
      expect(secondCaught).toBeInstanceOf(ConflictException);
      expect((secondCaught as ConflictException).getResponse()).toMatchObject({ code: 'run_not_live', status: 'interrupted' });
      expect(stopRunSpy).toHaveBeenCalledTimes(1);
    });

    test('membership removed mid-run: a call with valid-at-admission-time claims is denied AND the run is fenced to interrupted, with the worker actually asked to stop', async () => {
      const run = await makeLiveRun(daveCtx, `hermes-membership-revoked-${randomUUID()}`);
      const token = tokenFor(daveCtx, run);

      // Succeeds while membership is active.
      const auth = await revocationBroker.authorize(token, run.hermesRunId);
      expect(auth.membershipRole).toBe('standard_user');
      expect(stopRunSpy).not.toHaveBeenCalled();

      // Revoke Dave's membership -- the run must now be fenced, not just this call denied.
      await prisma.withSystem((tx) =>
        tx.tenantMembership.update({
          where: { tenantId_userId: { tenantId, userId: daveId } },
          data: { status: 'removed' },
        }),
      );

      let caught: unknown;
      try {
        await revocationBroker.authorize(token, run.hermesRunId);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ForbiddenException);
      expect((caught as ForbiddenException).getStatus()).toBe(403);
      expect((caught as ForbiddenException).getResponse()).toMatchObject({ code: 'authorization_revoked' });

      expect(stopRunSpy).toHaveBeenCalledTimes(1);
      expect(stopRunSpy).toHaveBeenCalledWith(run.hermesRunId);

      const after = await runs.get(run.runId);
      expect(after?.status).toBe('interrupted');
      expect(after?.finishReason).toBe('interrupted');
      expect(String(after?.error)).toMatch(/authorization_downgrade/);

      // A SUBSEQUENT call on the same (now-interrupted) run is rejected for
      // being non-live, never re-triggering another stop.
      let secondCaught: unknown;
      try {
        await revocationBroker.authorize(token, run.hermesRunId);
      } catch (error) {
        secondCaught = error;
      }
      expect(secondCaught).toBeInstanceOf(ConflictException);
      expect((secondCaught as ConflictException).getResponse()).toMatchObject({ code: 'run_not_live', status: 'interrupted' });
      expect(stopRunSpy).toHaveBeenCalledTimes(1);
    });

    test('run envelope expiry mid-run: denied AND the run is fenced to expired, with the worker actually asked to stop', async () => {
      const run = await makeLiveRun(aliceCtx, `hermes-expired-${randomUUID()}`, {
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      });
      const token = tokenFor(aliceCtx, run);

      let caught: unknown;
      try {
        await revocationBroker.authorize(token, run.hermesRunId);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ConflictException);
      expect((caught as ConflictException).getStatus()).toBe(409);
      expect((caught as ConflictException).getResponse()).toMatchObject({ code: 'run_expired' });

      expect(stopRunSpy).toHaveBeenCalledTimes(1);
      expect(stopRunSpy).toHaveBeenCalledWith(run.hermesRunId);

      const after = await runs.get(run.runId);
      expect(after?.status).toBe('expired');
      expect(after?.finishReason).toBe('expired');
    });
  });
});
