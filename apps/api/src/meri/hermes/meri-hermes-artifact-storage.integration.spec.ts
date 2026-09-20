/**
 * Phase 1 backlog #11 — "Artifact storage parity".
 *
 * `MeriHermesBrokerService.publishArtifact()` used to inline artifact bytes
 * as base64 inside `ClioArtifact.metadata.inlineBase64` (2 MiB cap,
 * `storage: 'inline_prototype'`, Phase 0 prototype). It now stores real bytes
 * via `MeriHermesArtifactStorageService` (S3, same per-feature-service
 * pattern as `EngagementService`/`ClientsService` elsewhere in this
 * codebase — there is no shared S3 wrapper to reuse) and records the object
 * key on `ClioArtifact.s3Key` (a column that already existed, unused, on the
 * Prisma model — no migration needed). `GET /api/clio/hermes/artifacts/:id`
 * (`MeriHermesController.artifact`) now serves bytes from S3 when `s3Key` is
 * set, and still serves `bodyText` unchanged for text-only artifacts, and
 * still serves a legacy Phase-0 `metadata.inlineBase64` row unchanged (rows
 * published before this change).
 *
 * The AWS SDK v3 S3Client constructor does low-level protocol init that
 * throws in this jest environment; the real class is replaced with a no-op
 * plus a `send()` spy (same pattern as `capiro-admin.service.spec.ts`), so
 * every S3 call in this file is a local assertion, never a real network call.
 * Everything else (PrismaService, MeriHermesBrokerService, MeriHermesController,
 * real `ClioArtifact`/`ClioConversation` rows) is real, against the LOCAL
 * fixture Postgres (container `capiro-postgres`).
 */
jest.mock('@aws-sdk/client-s3', () => ({
  __esModule: true,
  S3Client: class {
    send() {}
  },
  PutObjectCommand: class {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
  GetObjectCommand: class {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
}));

import { randomUUID } from 'node:crypto';
import { NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { MemoryCandidateService } from '../../memory/memory-candidate.service.js';
import type { MeriHermesRecallPort } from './meri-hermes-recall.ports.js';
import type { MeriHermesRuntimeAdapter } from './meri-hermes-runtime.adapter.js';
import type { MeriFeatureFlagsService } from '../meri-feature-flags.service.js';
import type { MeriHermesRuntimeClient } from './meri-hermes-runtime.client.js';
import { MeriHermesBrokerService, type MeriHermesBrokerAuth } from './meri-hermes-broker.service.js';
import { MeriHermesArtifactStorageService } from './meri-hermes-artifact-storage.service.js';
import { MeriHermesController } from './meri-hermes.controller.js';
import { MeriHermesRunStore } from './meri-hermes-run-store.js';
import type { MeriHermesAuthorizationEnvelope } from './hermes-runtime.contracts.js';
import { privateExecutionScopeId } from './meri-hermes-worker-token.js';

function assertLocalFixtureDatabase(url: string | undefined): void {
  if (!url) throw new Error('DATABASE_URL is required to run meri-hermes-artifact-storage.integration.spec.ts');
  const parsed = new URL(url);
  if (!['localhost', '127.0.0.1'].includes(parsed.hostname)) {
    throw new Error(
      `meri-hermes-artifact-storage.integration.spec.ts refuses to run against a non-local DATABASE_URL host (${parsed.hostname}). ` +
        'This suite writes and deletes rows and must only ever target the local fixture Postgres.',
    );
  }
}
assertLocalFixtureDatabase(process.env.DATABASE_URL);

/** A minimal Express-`Response` double: only what `MeriHermesController.artifact()` calls. */
function fakeResponse() {
  return {
    headers: {} as Record<string, string>,
    ended: null as Buffer | string | null,
    setHeader(name: string, value: string) {
      this.headers[name.toLowerCase()] = value;
    },
    end(body: Buffer | string) {
      this.ended = body;
    },
  };
}

describe('Phase 1 backlog #11 — artifact storage parity (real S3 upload path, mocked S3 wire)', () => {
  let prisma: PrismaService;
  let runs: MeriHermesRunStore;
  let storage: MeriHermesArtifactStorageService;
  let broker: MeriHermesBrokerService;
  let controller: MeriHermesController;
  let s3send: jest.Mock;
  const tenantId = randomUUID();
  const aliceId = randomUUID();
  const bobId = randomUUID();
  const conversationId = randomUUID();
  let aliceCtx: TenantContext;
  let bobCtx: TenantContext;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
    runs = new MeriHermesRunStore();
    storage = new MeriHermesArtifactStorageService({
      get: (key: string) =>
        ({
          ASSETS_BUCKET: 'meri-hermes-test-bucket',
          AWS_REGION_DEFAULT: 'us-east-1',
        })[key],
    } as never);
    s3send = jest.fn();
    // Replace the real (mocked-class) S3Client instance with a send() spy.
    (storage as unknown as { s3: { send: typeof s3send } }).s3 = { send: s3send };

    const fakeFlags = { isMeriHermesRuntimeEnabled: async () => true } as unknown as MeriFeatureFlagsService;
    broker = new MeriHermesBrokerService(
      prisma,
      runs,
      {} as MemoryCandidateService, // unused by publishArtifact()
      {} as MeriHermesRecallPort, // unused by publishArtifact()
      {} as MeriHermesRuntimeAdapter, // unused by publishArtifact()
      storage,
    );
    controller = new MeriHermesController(
      prisma,
      fakeFlags,
      {} as MeriHermesRuntimeClient, // unused: only capabilities() touches this
      {} as MeriHermesRuntimeAdapter, // unused: only run control routes touch this
      storage,
      runs,
    );

    await prisma.withSystem(async (tx) => {
      await tx.tenant.create({
        data: { id: tenantId, slug: `meri-hermes-artifact-${tenantId}`, name: 'Meri Hermes artifact storage fixture', status: 'active' },
      });
      for (const id of [aliceId, bobId]) {
        await tx.user.create({ data: { id, clerkUserId: id, email: `${id}@meri-hermes-artifact.example.test` } });
        await tx.tenantMembership.create({ data: { tenantId, userId: id, role: 'standard_user', status: 'active', joinedAt: new Date() } });
      }
      await tx.clioConversation.create({
        data: { id: conversationId, tenantId, userId: aliceId, title: 'Artifact storage fixture conversation' },
      });
    });

    aliceCtx = { tenantId, tenantSlug: 'fixture', userId: aliceId, clerkUserId: aliceId, role: 'standard_user' };
    bobCtx = { tenantId, tenantSlug: 'fixture', userId: bobId, clerkUserId: bobId, role: 'standard_user' };
  });

  afterAll(async () => {
    await prisma.withSystem((tx) => tx.clioConversation.delete({ where: { id: conversationId } })).catch(() => undefined);
    await prisma.withSystem((tx) => tx.tenant.delete({ where: { id: tenantId } })).catch(() => undefined);
    await prisma.withSystem((tx) => tx.user.delete({ where: { id: aliceId } })).catch(() => undefined);
    await prisma.withSystem((tx) => tx.user.delete({ where: { id: bobId } })).catch(() => undefined);
    await prisma.$disconnect();
  });

  beforeEach(() => {
    s3send.mockReset();
  });

  function envelope(ctx: TenantContext): MeriHermesAuthorizationEnvelope {
    return {
      version: 1,
      tenantId: ctx.tenantId,
      actorType: 'user',
      actorId: ctx.userId,
      conversationId,
      workspaceId: null,
      executionScopeId: privateExecutionScopeId(ctx.tenantId, ctx.userId),
      audience: 'private',
      authorizedClientIds: [],
      authorizedMailboxConnectionIds: [],
      toolPolicy: { allow: ['meri_publish_artifact'], deny: [], readOnly: false },
      authorizationVersion: 'v1',
      runId: randomUUID(),
      traceId: randomUUID(),
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      budget: { maxToolCalls: 40, maxOutputTokens: 8000, maxWallClockMs: 600_000 },
    };
  }

  async function authFor(ctx: TenantContext): Promise<MeriHermesBrokerAuth> {
    const run = await runs.create({
      envelope: envelope(ctx),
      actorContext: ctx,
      idempotencyKey: `meri:${randomUUID()}`,
      userMessageId: null,
    });
    await runs.update(run.runId, { hermesRunId: `hermes-artifact-${randomUUID()}`, status: 'running' });
    return { claims: {} as never, run: (await runs.get(run.runId))!, membershipRole: 'standard_user' };
  }

  test('an artifact with real bytes (well over the old 2 MiB inline cap) uploads to S3, records s3Key, and round-trips for the owner; a different user gets 404', async () => {
    const bytes = Buffer.concat([
      Buffer.from('%PDF-1.4 fixture artifact bytes\n'),
      Buffer.alloc(3 * 1024 * 1024, 'a'), // 3 MiB > the removed Phase 0 2 MiB inline cap
    ]);
    s3send.mockResolvedValueOnce({}); // PutObjectCommand response

    const auth = await authFor(aliceCtx);
    const published = await broker.publishArtifact(auth, {
      title: 'Large report',
      kind: 'hermes_file',
      contentType: 'application/pdf',
      filename: 'report.pdf',
      dataBase64: bytes.toString('base64'),
    });

    expect(s3send).toHaveBeenCalledTimes(1);
    const putCall = s3send.mock.calls[0]![0] as { input: { Bucket: string; Key: string; Body: Buffer; ContentType: string } };
    expect(putCall.input.Bucket).toBe('meri-hermes-test-bucket');
    expect(putCall.input.Key).toContain(tenantId);
    expect(putCall.input.ContentType).toBe('application/pdf');
    expect(Buffer.from(putCall.input.Body).equals(bytes)).toBe(true);

    const row = await prisma.withTenant(tenantId, (tx) =>
      tx.clioArtifact.findUniqueOrThrow({
        where: { id: published.artifactId },
        select: { s3Key: true, bodyText: true, contentType: true, metadata: true },
      }),
    );
    expect(row.s3Key).toBe(putCall.input.Key);
    expect(row.bodyText).toBeNull();
    const metadata = row.metadata as Record<string, unknown>;
    expect(metadata.storage).toBe('s3');
    expect(metadata.inlineBase64).toBeUndefined();
    expect(metadata.byteLength).toBe(bytes.byteLength);

    // Download, as the owner: bytes come back from S3 (mocked), not inline JSON.
    s3send.mockResolvedValueOnce({ Body: { transformToByteArray: async () => new Uint8Array(bytes) } });
    const ownerRes = fakeResponse();
    await controller.artifact(aliceCtx, published.artifactId, ownerRes as never);
    expect(s3send).toHaveBeenCalledTimes(2);
    const getCall = s3send.mock.calls[1]![0] as { input: { Bucket: string; Key: string } };
    expect(getCall.input.Key).toBe(row.s3Key);
    expect(Buffer.isBuffer(ownerRes.ended)).toBe(true);
    expect((ownerRes.ended as Buffer).equals(bytes)).toBe(true);
    expect(ownerRes.headers['content-type']).toBe('application/pdf');

    // A different user in the same tenant gets 404, never bytes or a distinguishing error.
    await expect(controller.artifact(bobCtx, published.artifactId, fakeResponse() as never)).rejects.toThrow(
      NotFoundException,
    );
    await expect(controller.artifact(bobCtx, published.artifactId, fakeResponse() as never)).rejects.toThrow(
      'Artifact not found',
    );
  });

  test('a bodyText-only artifact (no bytes) still works unchanged: no S3 call on publish, s3Key stays null, and download serves bodyText directly', async () => {
    const auth = await authFor(aliceCtx);
    const published = await broker.publishArtifact(auth, {
      title: 'Quick note',
      kind: 'note',
      bodyText: 'Just a short text artifact, no bytes at all.',
    });

    expect(s3send).not.toHaveBeenCalled();

    const row = await prisma.withTenant(tenantId, (tx) =>
      tx.clioArtifact.findUniqueOrThrow({
        where: { id: published.artifactId },
        select: { s3Key: true, bodyText: true, metadata: true },
      }),
    );
    expect(row.s3Key).toBeNull();
    expect(row.bodyText).toBe('Just a short text artifact, no bytes at all.');
    expect((row.metadata as Record<string, unknown>).storage).toBe('body_text');

    const res = fakeResponse();
    await controller.artifact(aliceCtx, published.artifactId, res as never);
    expect(s3send).not.toHaveBeenCalled();
    expect(res.ended).toBe('Just a short text artifact, no bytes at all.');
  });

  test('a legacy Phase 0 row (metadata.inlineBase64, s3Key null) still downloads correctly — backward compatibility for rows published before this change', async () => {
    const legacyBytes = Buffer.from('legacy inline-base64 phase 0 artifact bytes');
    const legacy = await prisma.withTenant(tenantId, (tx) =>
      tx.clioArtifact.create({
        data: {
          tenantId,
          userId: aliceId,
          conversationId,
          title: 'Legacy inline artifact',
          kind: 'hermes_file',
          contentType: 'application/octet-stream',
          bodyText: null,
          s3Key: null,
          metadata: {
            runtime: 'hermes',
            storage: 'inline_prototype',
            inlineBase64: legacyBytes.toString('base64'),
          },
        },
        select: { id: true },
      }),
    );

    const res = fakeResponse();
    await controller.artifact(aliceCtx, legacy.id, res as never);
    expect(s3send).not.toHaveBeenCalled();
    expect(Buffer.isBuffer(res.ended)).toBe(true);
    expect((res.ended as Buffer).equals(legacyBytes)).toBe(true);
  });
});
