import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { CanonicalOwnerAdapter } from './canonical-owner-adapter.mjs';
import { createMemoryCandidateOwnerPort } from './memory-candidate-owner.mjs';
import { AUTHORIZED_TENANTS, FIXTURE_NAMESPACE, FixtureProvisioningError } from './contract.mjs';

/** Offline command runtime over the built application's canonical owner method.
 * No AppModule bootstrap: scheduled jobs and provider workers must not start.
 * Database credentials remain in the application's process environment.
 */
export async function createAdapter({ config }) {
  if (
    config?.target !== 'capiro-dev' ||
    config.fixtureNamespace !== FIXTURE_NAMESPACE ||
    process.env.MERI_SYNTHETIC_FIXTURE_NAMESPACE !== FIXTURE_NAMESPACE ||
    !process.env.DATABASE_URL ||
    config.availableOwners?.length !== 1 ||
    config.availableOwners[0] !== 'memory_candidate'
  ) {
    throw new FixtureProvisioningError(
      'MEMORY_CANDIDATE_RUNTIME_CONFIG_INVALID',
      'Explicit synthetic namespace, application database environment and memory_candidate-only owner selection are required',
    );
  }
  const require = createRequire(new URL('../../../../apps/api/package.json', import.meta.url));
  const { PrismaService } = require(
    fileURLToPath(new URL('../../../../apps/api/dist/prisma/prisma.service.js', import.meta.url)),
  );
  const { SettingsAwareMemoryCandidateService } = require(
    fileURLToPath(
      new URL(
        '../../../../apps/api/dist/memory/settings-aware-memory-candidate.service.js',
        import.meta.url,
      ),
    ),
  );
  const prisma = new PrismaService();
  const { clientMemoryAllowed } = require(
    fileURLToPath(
      new URL('../../../../apps/api/dist/memory/memory-wall.helpers.js', import.meta.url),
    ),
  );
  const forbidden = new Proxy(
    {},
    {
      get() {
        throw new FixtureProvisioningError(
          'PENDING_FIXTURE_EFFECT_REFUSED',
          'Pending fixture proposals must not invoke projection, provider or approval dependencies',
        );
      },
    },
  );
  try {
    await prisma.$connect();
    for (const [key, expected] of Object.entries(AUTHORIZED_TENANTS)) {
      const configured = config.tenants?.[key];
      if (configured?.id !== expected.id || configured?.slug !== expected.slug) {
        throw new FixtureProvisioningError('TENANT_NOT_AUTHORIZED', key);
      }
      const rows = await prisma.withTenant(expected.id, (tx) =>
        tx.$queryRawUnsafe(
          'SELECT id::text, slug FROM tenants WHERE id=$1::uuid AND slug=$2',
          expected.id,
          expected.slug,
        ),
      );
      if (rows.length !== 1) throw new FixtureProvisioningError('SYNTHETIC_TENANT_NOT_FOUND', key);
    }
    const memoryCandidates = new SettingsAwareMemoryCandidateService(
      prisma,
      forbidden,
      forbidden,
      forbidden,
      forbidden,
      forbidden,
      forbidden,
      forbidden,
      forbidden,
    );
    const port = createMemoryCandidateOwnerPort({
      memoryCandidates,
      prisma,
      clientMemoryAllowed,
      actorForTenant(tenantId) {
        const key = Object.keys(AUTHORIZED_TENANTS).find(
          (key) => AUTHORIZED_TENANTS[key].id === tenantId,
        );
        const actorKey = (config.candidateActors ?? { T1: 'PAT' })[key];
        const actor = config.actors?.[actorKey];
        if (actor?.tenantId !== key) return null;
        return actor.physicalId ?? actor.userId;
      },
    });
    const adapter = new CanonicalOwnerAdapter({ ownerPorts: { memory_candidate: port } });
    adapter.authority = 'canonical_readback';
    adapter.close = () => prisma.$disconnect();
    return adapter;
  } catch (error) {
    await prisma.$disconnect();
    throw error;
  }
}
