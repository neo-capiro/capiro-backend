/**
 * Closeout defects A1 / A2 — the ethical wall in BOTH layers, against the
 * local fixture Postgres.
 *
 * A1/A2 were recorded as "a revoked or expired client grant still authorizes
 * a walled client", on the premise that the grant model behind
 * `Client.memoryAccessGrants` carries `status` / `expiresAt` / `revokedAt`
 * that neither layer tests. It does not. Two DIFFERENT models exist:
 *
 *   Client.memoryAccessGrants   -> ClientMemoryAccess  (client_memory_access)
 *       ethical-wall MEMBERSHIP. Columns: id, tenant_id, client_id, user_id,
 *       granted_by, created_at. No lifecycle columns at all — see migration
 *       20260719220000_client_memory_walls. Revocation is a hard DELETE
 *       performed by ClientsService.setMemoryAccess()'s replace-set write.
 *   Client.governedMemoryGrants -> MemoryAccessGrant   (memory_access_grant)
 *       governed-memory PERMISSIONS (read/propose/approve), WITH status /
 *       expires_at / revoked_at, enforced separately by
 *       MemoryAuthorizationService.evaluateInTx().
 *
 * So the predicate A1 asks for does not type-check and the column it names
 * does not exist. What this suite does instead is pin the property A1/A2
 * exist to protect — revocation actually takes effect, in both layers — and
 * assert the structural facts that make the "lifecycle-blind" reading
 * impossible, so the finding is not re-raised against code that cannot carry
 * it.
 *
 * Layer 1 is `DirectSecurityEnvelopePort.securityEnvelope()`, which builds
 * `authorizedClientIds` — the single input the whole client dimension rests
 * on (proposeMemory checks it, recall filters on it). Layer 2 is
 * `fetchDeniedClientIds()` / `clientMemoryAllowed()` in
 * src/memory/memory-wall.helpers.ts, the shared downstream probe.
 *
 * Local fixture database only (container `capiro-postgres`). Every fixture
 * id is a fresh `randomUUID()` and everything is cascade-deleted via the
 * fixture tenant in `afterAll`.
 */
import { randomUUID } from 'node:crypto';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { clientMemoryAllowed, fetchDeniedClientIds } from '../../memory/memory-wall.helpers.js';
import { DirectSecurityEnvelopePort } from './meri-hermes-security.port.js';

function assertLocalFixtureDatabase(url: string | undefined): void {
  if (!url) throw new Error('DATABASE_URL is required to run meri-hermes-client-grant-liveness.spec.ts');
  const parsed = new URL(url);
  if (!['localhost', '127.0.0.1'].includes(parsed.hostname)) {
    throw new Error(
      `meri-hermes-client-grant-liveness.spec.ts refuses to run against a non-local DATABASE_URL host (${parsed.hostname}). ` +
        'This suite writes and deletes rows and must only ever target the local fixture Postgres.',
    );
  }
}
assertLocalFixtureDatabase(process.env.DATABASE_URL);

describe('A1/A2 — ethical-wall grants in the envelope builder and the downstream wall probe', () => {
  let prisma: PrismaService;
  let port: DirectSecurityEnvelopePort;

  const tenantId = randomUUID();
  const graceId = randomUUID(); // holds a grant
  const heidiId = randomUUID(); // holds no grant
  const openClientId = randomUUID(); // memoryWall = false
  const walledClientId = randomUUID(); // memoryWall = true
  let graceCtx: TenantContext;
  let heidiCtx: TenantContext;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
    port = new DirectSecurityEnvelopePort(prisma);
    await prisma.withSystem(async (tx) => {
      await tx.tenant.create({
        data: {
          id: tenantId,
          slug: `meri-hermes-grant-liveness-${tenantId}`,
          name: 'Meri Hermes grant-liveness fixture',
          status: 'active',
        },
      });
      for (const id of [graceId, heidiId]) {
        await tx.user.create({
          data: { id, clerkUserId: id, email: `${id}@meri-hermes-grant-liveness.example.test` },
        });
        await tx.tenantMembership.create({
          data: { tenantId, userId: id, role: 'standard_user', status: 'active', joinedAt: new Date() },
        });
      }
      await tx.client.create({
        data: { id: openClientId, tenantId, name: 'Open client (no wall)', memoryWall: false },
      });
      await tx.client.create({
        data: { id: walledClientId, tenantId, name: 'Walled client', memoryWall: true },
      });
    });
    graceCtx = {
      tenantId,
      tenantSlug: `meri-hermes-grant-liveness-${tenantId}`,
      userId: graceId,
      clerkUserId: graceId,
      role: 'standard_user',
    };
    heidiCtx = { ...graceCtx, userId: heidiId, clerkUserId: heidiId };
  });

  afterAll(async () => {
    await prisma.withSystem((tx) => tx.tenant.delete({ where: { id: tenantId } })).catch(() => undefined);
    for (const id of [graceId, heidiId]) {
      await prisma.withSystem((tx) => tx.user.delete({ where: { id } })).catch(() => undefined);
    }
    await prisma.$disconnect();
  });

  async function grantWallAccess(userId: string): Promise<void> {
    await prisma.withSystem((tx) =>
      tx.clientMemoryAccess.create({
        data: { tenantId, clientId: walledClientId, userId, grantedBy: graceId },
      }),
    );
  }

  /**
   * The ONLY revocation mechanism this model has — the same `deleteMany` that
   * `ClientsService.setMemoryAccess()` issues when a user drops off the
   * roster.
   */
  async function revokeWallAccess(userId: string): Promise<void> {
    await prisma.withSystem((tx) =>
      tx.clientMemoryAccess.deleteMany({ where: { tenantId, clientId: walledClientId, userId } }),
    );
  }

  const deniedFor = (ctx: TenantContext): Promise<string[]> =>
    prisma.withTenantUser(ctx.tenantId, ctx.userId, (tx) => fetchDeniedClientIds(tx, ctx.tenantId, ctx.userId));

  const allowedFor = (ctx: TenantContext, clientId: string): Promise<boolean> =>
    prisma.withTenantUser(ctx.tenantId, ctx.userId, (tx) =>
      clientMemoryAllowed(tx, ctx.tenantId, ctx.userId, clientId),
    );

  // -------------------------------------------------------------------------
  // The structural facts A1/A2 rest on
  // -------------------------------------------------------------------------

  test('client_memory_access has NO status / expires_at / revoked_at column — there is no dead row for either layer to miss', async () => {
    const columns = await prisma.withSystem((tx) =>
      tx.$queryRaw<Array<{ column_name: string }>>`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'client_memory_access'
        ORDER BY ordinal_position
      `,
    );
    expect(columns.map((c) => c.column_name)).toEqual([
      'id',
      'tenant_id',
      'client_id',
      'user_id',
      'granted_by',
      'created_at',
    ]);
  });

  test('memory_access_grant is a DIFFERENT table, and it is the one that carries the lifecycle columns', async () => {
    const columns = await prisma.withSystem((tx) =>
      tx.$queryRaw<Array<{ column_name: string }>>`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'memory_access_grant'
      `,
    );
    const names = columns.map((c) => c.column_name);
    expect(names).toEqual(expect.arrayContaining(['status', 'expires_at', 'revoked_at']));
  });

  // -------------------------------------------------------------------------
  // Layer 1 — authorizedClientIds
  // -------------------------------------------------------------------------

  describe('layer 1 — DirectSecurityEnvelopePort.securityEnvelope()', () => {
    test('an unwalled client is authorized for everyone; a walled client with no grant is authorized for no one', async () => {
      const envelope = await port.securityEnvelope(heidiCtx);
      expect(envelope.authorizedClientIds).toContain(openClientId);
      expect(envelope.authorizedClientIds).not.toContain(walledClientId);
    });

    test('a granted user gets the walled client; revoking the grant removes it immediately', async () => {
      await grantWallAccess(graceId);
      const granted = await port.securityEnvelope(graceCtx);
      expect(granted.authorizedClientIds).toContain(walledClientId);

      await revokeWallAccess(graceId);
      const revoked = await port.securityEnvelope(graceCtx);
      expect(revoked.authorizedClientIds).not.toContain(walledClientId);
      expect(revoked.authorizedClientIds).toContain(openClientId);
    });

    test("another user's grant does not authorize this user", async () => {
      await grantWallAccess(graceId);
      try {
        const heidi = await port.securityEnvelope(heidiCtx);
        expect(heidi.authorizedClientIds).not.toContain(walledClientId);
      } finally {
        await revokeWallAccess(graceId);
      }
    });

    test('a LIVE governed memory_access_grant does not by itself open the wall (the two models are separate layers)', async () => {
      const grantId = randomUUID();
      await prisma.withSystem((tx) =>
        tx.memoryAccessGrant.create({
          data: {
            id: grantId,
            tenantId,
            clientId: walledClientId,
            userId: heidiId,
            // Vocabulary fixed by memory_access_grant_permissions_check
            // (migration 20260729010000_memory_governance_context_v2).
            permissions: ['propose', 'review'],
            status: 'active',
            grantedByUserId: graceId,
            reason: 'grant-liveness fixture',
            expiresAt: new Date(Date.now() + 3_600_000),
          },
        }),
      );
      try {
        const envelope = await port.securityEnvelope(heidiCtx);
        // If this ever flips to `toContain`, `authorizedClientIds` has been
        // WIDENED, which is the opposite of what A1 asked for.
        expect(envelope.authorizedClientIds).not.toContain(walledClientId);
      } finally {
        await prisma.withSystem((tx) => tx.memoryAccessGrant.delete({ where: { id: grantId } }));
      }
    });
  });

  // -------------------------------------------------------------------------
  // Layer 2 — the shared downstream wall probe
  // -------------------------------------------------------------------------

  describe('layer 2 — memory-wall.helpers (fetchDeniedClientIds / clientMemoryAllowed)', () => {
    test('a walled client with no grant is denied and never appears as allowed', async () => {
      await expect(deniedFor(heidiCtx)).resolves.toContain(walledClientId);
      await expect(deniedFor(heidiCtx)).resolves.not.toContain(openClientId);
      await expect(allowedFor(heidiCtx, walledClientId)).resolves.toBe(false);
      await expect(allowedFor(heidiCtx, openClientId)).resolves.toBe(true);
    });

    test('granting then revoking flips both probes, in step with layer 1', async () => {
      await grantWallAccess(graceId);
      await expect(deniedFor(graceCtx)).resolves.not.toContain(walledClientId);
      await expect(allowedFor(graceCtx, walledClientId)).resolves.toBe(true);

      await revokeWallAccess(graceId);
      await expect(deniedFor(graceCtx)).resolves.toContain(walledClientId);
      await expect(allowedFor(graceCtx, walledClientId)).resolves.toBe(false);
    });

    test('a null user denies every walled client (fail-closed by construction)', async () => {
      const denied = await prisma.withSystem((tx) => fetchDeniedClientIds(tx, tenantId, null));
      expect(denied).toContain(walledClientId);
      expect(denied).not.toContain(openClientId);
      await expect(
        prisma.withSystem((tx) => clientMemoryAllowed(tx, tenantId, null, walledClientId)),
      ).resolves.toBe(false);
    });

    test('a client id that does not resolve in this tenant is denied, not defaulted to allowed', async () => {
      await expect(allowedFor(graceCtx, randomUUID())).resolves.toBe(false);
    });
  });
});
