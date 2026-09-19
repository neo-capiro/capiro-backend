/**
 * Phase 1 backlog #19 — "Isolation acceptance suite in CI".
 *
 * Promotes the Phase 0 manual harness checks ISO1, ISO2, ISO3, ISO5 and D2c
 * (docs/meri/hermes/phase-0/checks-report.md §A; evidence under
 * docs/meri/hermes/phase-0/evidence/2026-09-19T13-48-15-436Z/{ISO1,ISO2,ISO3,ISO5,D2c}.json;
 * harness described in docs/meri/hermes/phase-0/harness.md) into real jest specs
 * that run in CI on every PR touching src/meri/hermes, instead of a script a
 * human has to remember to run against a live worker.
 *
 * Rather than the harness's own HTTP-level fixture-identity login flow
 * (scripts/meri-hermes-phase0-harness-api.ts's FixtureIdentityMiddleware), this
 * suite follows the established in-repo convention (see
 * meri-hermes-prisma-run-repository.spec.ts, funding-opportunity-pipeline-source-access.integration.spec.ts)
 * of constructing `TenantContext` objects directly for two fixture users and
 * exercising the REAL controller / adapter / feature-flag service against the
 * LOCAL fixture Postgres (container `capiro-postgres`) — never a remote or
 * production database. The only test doubles are the Hermes HTTP worker
 * itself (no worker runs in CI) and turn maintenance (fire-and-forget in
 * production); everything else (MeriHermesController, MeriHermesRuntimeAdapter,
 * MeriFeatureFlagsService, MeriHermesRunStore, DirectSecurityEnvelopePort,
 * DirectMemoryItemsRecallPort) is the real production class.
 *
 * ISO4 (the worker-facing broker credential boundary) lives in the sibling
 * file meri-hermes-broker-isolation.spec.ts — a natural split, since it
 * exercises MeriHermesBrokerService.authorize() (worker token / HTTP layer)
 * rather than the browser-facing controller/adapter/gate exercised here.
 */
import { randomUUID } from 'node:crypto';
import { NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { MeriFeatureFlagsService } from '../meri-feature-flags.service.js';
import { MERI_HERMES_RUNTIME_FLAG } from '../../common/meri-hermes-flags.js';
import { MeriHermesController } from './meri-hermes.controller.js';
import { MeriHermesRuntimeAdapter } from './meri-hermes-runtime.adapter.js';
import { MeriHermesRunStore } from './meri-hermes-run-store.js';
import { privateExecutionScopeId } from './meri-hermes-worker-token.js';
import { DirectSecurityEnvelopePort } from './meri-hermes-security.port.js';
import { DirectMemoryItemsRecallPort } from './meri-hermes-recall.ports.js';
import type { MeriHermesAuthorizationEnvelope } from './hermes-runtime.contracts.js';
import type { MeriHermesRuntimeClient } from './meri-hermes-runtime.client.js';
import type { MeriHermesSecurityEnvelopePort } from './meri-hermes-security.port.js';
import type { MeriTurnMaintenance } from '../meri-turn-maintenance.js';
import type { MeriHermesArtifactStorageService } from './meri-hermes-artifact-storage.service.js';

function assertLocalFixtureDatabase(url: string | undefined): void {
  if (!url) throw new Error('DATABASE_URL is required to run meri-hermes-isolation.spec.ts');
  const parsed = new URL(url);
  if (!['localhost', '127.0.0.1'].includes(parsed.hostname)) {
    throw new Error(
      `meri-hermes-isolation.spec.ts refuses to run against a non-local DATABASE_URL host (${parsed.hostname}). ` +
        'This suite writes and deletes rows and must only ever target the local fixture Postgres.',
    );
  }
}
assertLocalFixtureDatabase(process.env.DATABASE_URL);

describe('Meri Hermes isolation acceptance suite (ISO1, ISO2, ISO3, ISO5, D2c)', () => {
  let prisma: PrismaService;
  let flags: MeriFeatureFlagsService;
  let runs: MeriHermesRunStore;

  // "pilot" mirrors the Phase 0 fixture: two users of ONE tenant, gate ON.
  const pilotTenantId = randomUUID();
  const aliceId = randomUUID();
  const bobId = randomUUID();
  // "outside" mirrors the Phase 0 fixture: a different tenant never added to
  // the pilot allowlist — the gate must stay closed no matter what its own
  // per-tenant flag says.
  const outsideTenantId = randomUUID();
  const carolId = randomUUID();
  // A third, independently-flagged tenant so the ISO5 flip test never
  // disturbs the gate the other describe blocks rely on staying open.
  const iso5TenantId = randomUUID();
  const iso5UserId = randomUUID();

  let aliceCtx: TenantContext;
  let bobCtx: TenantContext;
  let carolCtx: TenantContext;
  let iso5Ctx: TenantContext;

  let savedEnv: { enabled: string | undefined; pilotIds: string | undefined };

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
    flags = new MeriFeatureFlagsService(prisma);
    runs = new MeriHermesRunStore();

    savedEnv = {
      enabled: process.env.MERI_HERMES_ENABLED,
      pilotIds: process.env.MERI_HERMES_PILOT_TENANT_IDS,
    };
    process.env.MERI_HERMES_ENABLED = 'true';
    process.env.MERI_HERMES_PILOT_TENANT_IDS = [pilotTenantId, iso5TenantId].join(',');

    await prisma.withSystem(async (tx) => {
      await tx.tenant.create({
        data: {
          id: pilotTenantId,
          slug: `meri-hermes-iso-pilot-${pilotTenantId}`,
          name: 'Meri Hermes isolation spec — pilot fixture',
          status: 'active',
          settings: { clioFeatureFlags: { [MERI_HERMES_RUNTIME_FLAG]: true } },
        },
      });
      await tx.tenant.create({
        data: {
          id: outsideTenantId,
          slug: `meri-hermes-iso-outside-${outsideTenantId}`,
          name: 'Meri Hermes isolation spec — outside tenant fixture',
          status: 'active',
          // Even if the per-tenant flag were somehow flipped true, this
          // tenant is never on the canonical allowlist — the gate is
          // three-key AND, not "any key open" (see meri-hermes-flags.ts).
          settings: { clioFeatureFlags: { [MERI_HERMES_RUNTIME_FLAG]: true } },
        },
      });
      await tx.tenant.create({
        data: {
          id: iso5TenantId,
          slug: `meri-hermes-iso5-${iso5TenantId}`,
          name: 'Meri Hermes isolation spec — ISO5 flag-flip fixture',
          status: 'active',
          settings: { clioFeatureFlags: { [MERI_HERMES_RUNTIME_FLAG]: false } },
        },
      });
      for (const [id, tenantId] of [
        [aliceId, pilotTenantId],
        [bobId, pilotTenantId],
        [carolId, outsideTenantId],
        [iso5UserId, iso5TenantId],
      ] as const) {
        await tx.user.create({ data: { id, clerkUserId: id, email: `${id}@meri-hermes-iso.example.test` } });
        await tx.tenantMembership.create({
          data: { tenantId, userId: id, role: 'standard_user', status: 'active', joinedAt: new Date() },
        });
      }
    });

    aliceCtx = { tenantId: pilotTenantId, tenantSlug: 'pilot', userId: aliceId, clerkUserId: aliceId, role: 'standard_user' };
    bobCtx = { tenantId: pilotTenantId, tenantSlug: 'pilot', userId: bobId, clerkUserId: bobId, role: 'standard_user' };
    carolCtx = { tenantId: outsideTenantId, tenantSlug: 'outside', userId: carolId, clerkUserId: carolId, role: 'standard_user' };
    iso5Ctx = { tenantId: iso5TenantId, tenantSlug: 'iso5', userId: iso5UserId, clerkUserId: iso5UserId, role: 'standard_user' };
  });

  afterAll(async () => {
    process.env.MERI_HERMES_ENABLED = savedEnv.enabled;
    process.env.MERI_HERMES_PILOT_TENANT_IDS = savedEnv.pilotIds;
    // Cascades: tenant -> tenant_memberships, clio_conversations, clients, etc.
    await prisma.withSystem((tx) => tx.tenant.delete({ where: { id: pilotTenantId } })).catch(() => undefined);
    await prisma.withSystem((tx) => tx.tenant.delete({ where: { id: outsideTenantId } })).catch(() => undefined);
    await prisma.withSystem((tx) => tx.tenant.delete({ where: { id: iso5TenantId } })).catch(() => undefined);
    await prisma.withSystem((tx) => tx.user.delete({ where: { id: aliceId } })).catch(() => undefined);
    await prisma.withSystem((tx) => tx.user.delete({ where: { id: bobId } })).catch(() => undefined);
    await prisma.withSystem((tx) => tx.user.delete({ where: { id: carolId } })).catch(() => undefined);
    await prisma.withSystem((tx) => tx.user.delete({ where: { id: iso5UserId } })).catch(() => undefined);
    await prisma.$disconnect();
  });

  function envelope(
    ctx: TenantContext,
    over: Partial<MeriHermesAuthorizationEnvelope> & { conversationId: string },
  ): MeriHermesAuthorizationEnvelope {
    return {
      version: 1,
      tenantId: ctx.tenantId,
      actorType: 'user',
      actorId: ctx.userId,
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

  // ---------------------------------------------------------------------
  // ISO1 — cross-user: Bob cannot read Alice's run by id (404, not a leak)
  // ---------------------------------------------------------------------
  describe('ISO1 — cross-user run ownership through the real controller', () => {
    let controller: MeriHermesController;
    let aliceRunId: string;

    beforeAll(async () => {
      controller = new MeriHermesController(
        prisma,
        flags,
        {} as MeriHermesRuntimeClient, // unused: capabilities() is not exercised in this block
        {} as MeriHermesRuntimeAdapter, // unused: the ownership check throws before any adapter call
        {} as MeriHermesArtifactStorageService, // unused: no artifact download is exercised in this block
        runs,
      );
      const run = await runs.create({
        envelope: envelope(aliceCtx, { conversationId: randomUUID() }),
        actorContext: aliceCtx,
        idempotencyKey: `meri:${randomUUID()}`,
        userMessageId: null,
      });
      aliceRunId = run.runId;
    });

    test('the owning user can read her own run', async () => {
      const projected = await controller.run(aliceCtx, aliceRunId);
      expect(projected.runId).toBe(aliceRunId);
    });

    test('a different user in the SAME tenant guessing the run id gets exactly "Run not found" (404), never data or a distinguishing error', async () => {
      await expect(controller.run(bobCtx, aliceRunId)).rejects.toThrow(NotFoundException);
      await expect(controller.run(bobCtx, aliceRunId)).rejects.toThrow('Run not found');
      await expect(controller.stop(bobCtx, aliceRunId)).rejects.toThrow('Run not found');
    });

    test('a random, never-issued run id gets the SAME "Run not found" — existence is never leaked by a different message', async () => {
      await expect(controller.run(aliceCtx, randomUUID())).rejects.toThrow('Run not found');
    });
  });

  // ---------------------------------------------------------------------
  // ISO2 — cross-tenant: an outside identity never reaches Hermes
  // ---------------------------------------------------------------------
  describe('ISO2 — cross-tenant: the outside tenant is refused, not merely unrouted', () => {
    let adapter: MeriHermesRuntimeAdapter;
    let controller: MeriHermesController;

    beforeAll(() => {
      adapter = new MeriHermesRuntimeAdapter(
        prisma,
        flags,
        {} as MeriHermesRuntimeClient,
        runs,
        {} as MeriHermesSecurityEnvelopePort,
        {} as MeriTurnMaintenance,
      );
      controller = new MeriHermesController(
        prisma,
        flags,
        {} as MeriHermesRuntimeClient,
        adapter,
        {} as MeriHermesArtifactStorageService, // unused: no artifact download is exercised in this block
        runs,
      );
    });

    test('shouldHandle — the exact gate meriv3-runtime.proxy.ts checks before routing a turn to Hermes — is false for the outside tenant and true for the pilot tenant', async () => {
      await expect(adapter.shouldHandle(carolCtx)).resolves.toBe(false);
      await expect(adapter.shouldHandle(aliceCtx)).resolves.toBe(true);
    });

    test('every Hermes browser-facing route refuses the outside identity: NotFoundException (404), the SAME shape a non-pilot tenant gets everywhere else in this control surface', async () => {
      await expect(controller.capabilities(carolCtx)).rejects.toThrow(NotFoundException);
      await expect(controller.capabilities(carolCtx)).rejects.toThrow('Hermes runtime is not enabled for this tenant');
      await expect(controller.run(carolCtx, randomUUID())).rejects.toThrow(NotFoundException);
      await expect(controller.stop(carolCtx, randomUUID())).rejects.toThrow(NotFoundException);
    });

    // Evidence drift note (ISO2.json / checks-report.md §A said "409 NOT_ROUTED_TO_HERMES"):
    // that response is synthesized by the Phase 0 harness's OWN bespoke route
    // (apps/api/scripts/meri-hermes-phase0-harness-api.ts `HarnessController.stream`,
    // res.status(409).json({ code: 'NOT_ROUTED_TO_HERMES', ... })) because the
    // standalone harness has no legacy/V3 runtime to fall back to and must not
    // pretend it does. The SHIPPED production code has no "409 NOT_ROUTED_TO_HERMES"
    // anywhere: the real routing seam (createMeriRuntimeService in
    // meriv3-runtime.proxy.ts) just silently falls through to MeriV3/legacy when
    // hermes.shouldHandle(ctx) is false — already covered by
    // meriv3-runtime.proxy.spec.ts's "a non-pilot tenant never touches Hermes and
    // keeps its existing runtime" (asserts hermes.streamMessage is never called).
    // The only place a closed gate produces an HTTP status today is the Hermes
    // control surface itself (MeriHermesController), and that status is 404, as
    // asserted above — not 409.
  });

  // ---------------------------------------------------------------------
  // ISO3 — spoof: server-derived identity, never a client-supplied one
  // ---------------------------------------------------------------------
  describe('ISO3 — spoof: client-supplied tenant/actor/runtime fields are ignored', () => {
    let adapter: MeriHermesRuntimeAdapter;
    let conversationId: string;
    let createRunSpy: jest.Mock;

    beforeAll(async () => {
      conversationId = randomUUID();
      await prisma.withTenant(pilotTenantId, (tx) =>
        tx.clioConversation.create({
          data: { id: conversationId, tenantId: pilotTenantId, userId: bobId, title: 'ISO3 spoof fixture' },
        }),
      );
      createRunSpy = jest.fn().mockRejectedValue(new Error('no Hermes worker in this test'));
      const fakeClient = { forScope: jest.fn(() => ({ createRun: createRunSpy })) } as unknown as MeriHermesRuntimeClient;
      const noopSecurity: MeriHermesSecurityEnvelopePort = {
        securityEnvelope: async () => ({ authorizedClientIds: [], authorizedMailboxConnectionIds: [] }),
      };
      const noopMaintenance: MeriTurnMaintenance = { scheduleAfterTurnMaintenance: () => undefined };
      adapter = new MeriHermesRuntimeAdapter(prisma, flags, fakeClient, runs, noopSecurity, noopMaintenance);
      // meriHermesConfigurationError() gates admission on runtimeUrl/apiKey/
      // signingKey being PRESENT before the envelope is ever built — it never
      // dials out (the client itself is the fake above), so these can be any
      // well-formed placeholder values. Without this, streamMessage() returns
      // a config-error `done` frame (no runId) before a run is ever created.
      adapter.env = {
        ...process.env,
        MERI_HERMES_RUNTIME_URL: 'http://127.0.0.1:19999',
        MERI_HERMES_API_KEY: 'iso3-spoof-spec-placeholder-key',
        MERI_HERMES_BROKER_SIGNING_KEY: 'iso3-spoof-spec-signing-key-0123456789',
      };
    });

    afterAll(async () => {
      await prisma.withTenant(pilotTenantId, (tx) => tx.clioConversation.delete({ where: { id: conversationId } })).catch(() => undefined);
    });

    test('a spoofed impersonated tenant id and a spoofed bearer token (positional args the adapter explicitly ignores) never reach the run: the envelope is built from the AUTHENTICATED TenantContext', async () => {
      const frames: Array<Record<string, unknown>> = [];
      const sse = {
        write(data: string) {
          const match = /^data: (.*)\n\n$/.exec(data);
          if (match) frames.push(JSON.parse(match[1]!));
        },
      };
      const spoofedTenantId = randomUUID(); // an id Bob has no membership in and no right to
      const spoofedBearer = 'Bearer stolen-admin-token';

      await adapter.streamMessage(
        bobCtx,
        conversationId,
        'What is on my calendar today?',
        sse,
        undefined,
        'new',
        [],
        spoofedBearer,
        spoofedTenantId,
      );

      const doneFrame = frames.find((f) => f.type === 'done');
      expect(doneFrame).toBeDefined();
      const runId = String(doneFrame!.runId);
      const run = await runs.get(runId);
      expect(run).not.toBeNull();
      // The run was admitted and its authorization envelope reflects Bob's
      // OWN authenticated identity — never the spoofed tenant id, and the
      // execution scope is Bob's private scope, not a scope derived from the
      // spoofed value.
      expect(run!.envelope.tenantId).toBe(bobCtx.tenantId);
      expect(run!.envelope.actorId).toBe(bobCtx.userId);
      expect(run!.envelope.tenantId).not.toBe(spoofedTenantId);
      expect(run!.envelope.executionScopeId).toBe(privateExecutionScopeId(bobCtx.tenantId, bobCtx.userId));
      expect(run!.actorContext.userId).toBe(bobCtx.userId);
      // The fake Hermes client's createRun was reached (proving the turn was
      // really admitted, not short-circuited earlier) — its input never
      // carries the spoofed tenant id either, because HermesCreateRunInput
      // has no tenant/actor field at all: identity travels only in the
      // server-built envelope, never in the wire payload to the worker.
      expect(createRunSpy).toHaveBeenCalledTimes(1);
      const callArg = createRunSpy.mock.calls[0]![0] as Record<string, unknown>;
      expect(JSON.stringify(callArg)).not.toContain(spoofedTenantId);
    });

    // Note on scope: ISO3's OTHER half in the Phase 0 evidence (a non-member
    // identity asserting the pilot tenant gets 403) is identity-resolution
    // performed by the Clerk-backed tenant-context middleware
    // (src/tenant/tenant-context.middleware.ts), not by anything under
    // src/meri/hermes — it is already covered by
    // tenant-context.middleware.spec.ts ("403s when there is no membership and
    // no org claim to heal from"). Duplicating an Express-middleware identity
    // test here would not exercise src/meri/hermes and is out of this ticket's
    // CI-trigger scope.
  });

  // ---------------------------------------------------------------------
  // ISO5 — feature flag off at runtime, back on, proven not cached
  // ---------------------------------------------------------------------
  describe('ISO5 — feature flag off at runtime for a tenant, then back on, never from a stale cache', () => {
    let adapter: MeriHermesRuntimeAdapter;
    let controller: MeriHermesController;

    beforeAll(() => {
      adapter = new MeriHermesRuntimeAdapter(
        prisma,
        flags,
        {} as MeriHermesRuntimeClient,
        runs,
        {} as MeriHermesSecurityEnvelopePort,
        {} as MeriTurnMaintenance,
      );
      controller = new MeriHermesController(
        prisma,
        flags,
        {} as MeriHermesRuntimeClient,
        adapter,
        {} as MeriHermesArtifactStorageService, // unused: no artifact download is exercised in this block
        runs,
      );
    });

    test('OFF: gate is false; everything that creates new work or grants new execution is refused BY THE GATE, while control of an already-admitted run falls through to ownership', async () => {
      await expect(adapter.shouldHandle(iso5Ctx)).resolves.toBe(false);
      await expect(controller.capabilities(iso5Ctx)).rejects.toThrow('Hermes runtime is not enabled for this tenant');
      // New work / new execution: closed by the gate itself.
      await expect(
        controller.approval(iso5Ctx, randomUUID(), { requestId: 'req_x', decision: 'deny' }),
      ).rejects.toThrow('Hermes runtime is not enabled for this tenant');
      await expect(controller.steer(iso5Ctx, randomUUID(), { text: 'more guidance' })).rejects.toThrow(
        'Hermes runtime is not enabled for this tenant',
      );
      /**
       * Control and OBSERVATION of an already-admitted run are ownership-only
       * by design: `deployment-validation-and-rollback.md` requires the kill
       * switch to be a DRAIN (stop in-flight runs via
       * `POST .../runs/:id/stop`), and "a flag change must not make active
       * workers uncontrollable". So an unknown run id is refused as "Run not
       * found" here, not by the gate — see `MeriHermesController.ownedRun`.
       */
      await expect(controller.run(iso5Ctx, randomUUID())).rejects.toThrow('Run not found');
      await expect(controller.stop(iso5Ctx, randomUUID())).rejects.toThrow('Run not found');
    });

    test('ON: flipping ONLY the per-tenant DB flag (and invalidating the 60s cache the service documents) brings it back immediately — proving live config, not a cached read', async () => {
      await prisma.withTenant(iso5TenantId, (tx) =>
        tx.tenant.update({
          where: { id: iso5TenantId },
          data: { settings: { clioFeatureFlags: { [MERI_HERMES_RUNTIME_FLAG]: true } } },
        }),
      );
      flags.invalidate(iso5TenantId);

      await expect(adapter.shouldHandle(iso5Ctx)).resolves.toBe(true);
      // assertEnabled no longer trips: a GATED surface now falls through to the
      // REAL ownership check and 404s for a different reason ("Run not
      // found", not "not enabled") — proof the gate itself opened, not that
      // the 404 message coincidentally repeats. The gated surface has to be
      // one the gate still guards; `run()` is ownership-only in both states
      // now, so it can no longer tell the two apart.
      await expect(
        controller.approval(iso5Ctx, randomUUID(), { requestId: 'req_x', decision: 'deny' }),
      ).rejects.toThrow('Run not found');
      await expect(controller.run(iso5Ctx, randomUUID())).rejects.toThrow('Run not found');
    });

    test('back OFF again: the tenant flag is a live, reversible switch, not a one-way migration', async () => {
      await prisma.withTenant(iso5TenantId, (tx) =>
        tx.tenant.update({
          where: { id: iso5TenantId },
          data: { settings: { clioFeatureFlags: { [MERI_HERMES_RUNTIME_FLAG]: false } } },
        }),
      );
      flags.invalidate(iso5TenantId);
      await expect(adapter.shouldHandle(iso5Ctx)).resolves.toBe(false);
      await expect(controller.capabilities(iso5Ctx)).rejects.toThrow('Hermes runtime is not enabled for this tenant');
    });
  });

  // ---------------------------------------------------------------------
  // D2c — cross-scope memory isolation (DirectMemoryItemsRecallPort)
  // ---------------------------------------------------------------------
  describe('D2c — cross-scope memory isolation: recall never crosses a user or an ethical wall', () => {
    const walledClientId = randomUUID();
    const alicePrivateItemId = randomUUID();
    const bobPrivateItemId = randomUUID();
    const walledFactItemId = randomUUID();
    let recallPort: DirectMemoryItemsRecallPort;
    let security: DirectSecurityEnvelopePort;

    beforeAll(async () => {
      recallPort = new DirectMemoryItemsRecallPort(prisma);
      security = new DirectSecurityEnvelopePort(prisma);

      await prisma.withSystem(async (tx) => {
        await tx.client.create({
          data: { id: walledClientId, tenantId: pilotTenantId, name: 'D2c walled client fixture', memoryWall: true },
        });
        // Alice is granted access to the walled client; Bob is not (mirrors
        // the Phase 0 fixture's "Fixture Client Walled", grants: [alice]).
        await tx.clientMemoryAccess.create({ data: { tenantId: pilotTenantId, clientId: walledClientId, userId: aliceId } });

        const insertItem = (
          id: string,
          opts: { ownerUserId?: string | null; clientId?: string | null; visibility: string; slug: string; title: string; body: string },
        ) => {
          const sections = JSON.stringify([{ key: 'summary', heading: 'Summary', owner: 'human', body: opts.body }]);
          return tx.$executeRaw`
            INSERT INTO memory_items (id, tenant_id, client_id, owner_user_id, type, visibility, slug, title, source, provenance, sections_jsonb, status)
            VALUES (${id}::uuid, ${pilotTenantId}::uuid, ${opts.clientId ?? null}::uuid, ${opts.ownerUserId ?? null}::uuid,
                    'note', ${opts.visibility}, ${opts.slug}, ${opts.title}, 'manual', 'human', ${sections}::jsonb, 'active')`;
        };
        await insertItem(alicePrivateItemId, {
          ownerUserId: aliceId,
          visibility: 'user',
          slug: `d2c-alice-private-${alicePrivateItemId}`,
          title: 'Alice private fact',
          body: 'D2C-ALICE-PRIVATE-FACT: only Alice should ever recall this.',
        });
        await insertItem(bobPrivateItemId, {
          ownerUserId: bobId,
          visibility: 'user',
          slug: `d2c-bob-private-${bobPrivateItemId}`,
          title: 'Bob private fact',
          body: 'D2C-BOB-PRIVATE-FACT: only Bob should ever recall this.',
        });
        await insertItem(walledFactItemId, {
          clientId: walledClientId,
          visibility: 'tenant',
          slug: `d2c-walled-fact-${walledFactItemId}`,
          title: 'Walled client fact',
          body: 'D2C-WALLED-CLIENT-FACT: granted to Alice only.',
        });
      });
    });

    afterAll(async () => {
      await prisma.withSystem(async (tx) => {
        await tx.$executeRaw`DELETE FROM memory_items WHERE id = ANY(${[alicePrivateItemId, bobPrivateItemId, walledFactItemId]}::uuid[])`;
        await tx.clientMemoryAccess.deleteMany({ where: { tenantId: pilotTenantId, clientId: walledClientId } });
        await tx.client.delete({ where: { id: walledClientId } }).catch(() => undefined);
      });
    });

    test("Bob's execution scope: recall never returns Alice's private fact or the walled-client fact Alice alone is granted", async () => {
      const bobEnvelope = await security.securityEnvelope(bobCtx);
      expect(bobEnvelope.authorizedClientIds).not.toContain(walledClientId); // real, server-derived — Bob holds no grant

      const result = await recallPort.recall(bobCtx, {
        query: 'D2C-',
        limit: 10,
        authorizedClientIds: bobEnvelope.authorizedClientIds,
      });
      const bodies = JSON.stringify(result.items.map((i) => i.excerpt));
      expect(bodies).not.toMatch(/D2C-ALICE-PRIVATE-FACT/);
      expect(bodies).not.toMatch(/D2C-WALLED-CLIENT-FACT/);
      expect(result.items.some((i) => i.sourceId === bobPrivateItemId)).toBe(true); // Bob still sees his OWN fact
    });

    test("Alice's execution scope: recall never returns Bob's private fact, and DOES surface the walled fact she is actually granted", async () => {
      const aliceEnvelope = await security.securityEnvelope(aliceCtx);
      expect(aliceEnvelope.authorizedClientIds).toContain(walledClientId); // real, server-derived — Alice holds the grant

      const result = await recallPort.recall(aliceCtx, {
        query: 'D2C-',
        limit: 10,
        authorizedClientIds: aliceEnvelope.authorizedClientIds,
      });
      const bodies = JSON.stringify(result.items.map((i) => i.excerpt));
      expect(bodies).not.toMatch(/D2C-BOB-PRIVATE-FACT/);
      expect(result.items.some((i) => i.sourceId === walledFactItemId)).toBe(true);
      expect(result.items.some((i) => i.sourceId === alicePrivateItemId)).toBe(true);
    });

    test('an explicit clientId request for the walled client from an unauthorized caller fails CLOSED (a labelled refusal), not an empty-looking success that could be mistaken for "nothing found"', async () => {
      const result = await recallPort.recall(bobCtx, {
        query: 'D2C-',
        clientId: walledClientId,
        limit: 10,
        authorizedClientIds: [],
      });
      expect(result.items).toEqual([]);
      expect(result.coverage.sourceStatus).toBe('unauthorized');
      expect(result.coverage.detail).toBe('client_not_authorized');
    });
  });
});
