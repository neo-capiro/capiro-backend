import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  CanonicalOwnerAdapter,
  createClientDocumentOwnerPort,
} from './canonical-owner-adapter.mjs';
import { createClientDocumentOwnerReader } from './client-document-owner-reader.mjs';
import { createClientDocumentDeletionPort } from './client-document-deletion-owner.mjs';
import { AUTHORIZED_TENANTS, FIXTURE_NAMESPACE, FixtureProvisioningError } from './contract.mjs';

const DOCUMENT_ACTIONS = new Set(['attachment_external_read', 'attachment_external_write']);

export function assertClientDocumentRuntimeConfig({ config, env = process.env }) {
  if (
    config?.target !== 'capiro-dev' ||
    config.fixtureNamespace !== FIXTURE_NAMESPACE ||
    env.MERI_SYNTHETIC_FIXTURE_NAMESPACE !== FIXTURE_NAMESPACE ||
    !env.DATABASE_URL ||
    !env.ASSETS_BUCKET ||
    config.availableOwners?.length !== 1 ||
    config.availableOwners[0] !== 'engagement_attachment'
  ) {
    throw new FixtureProvisioningError(
      'CLIENT_DOCUMENT_RUNTIME_CONFIG_INVALID',
      'capiro-dev, the exact synthetic namespace, application database and asset bucket, and engagement_attachment-only owner selection are required',
    );
  }
  for (const [key, expected] of Object.entries(AUTHORIZED_TENANTS)) {
    const configured = config.tenants?.[key];
    if (configured?.id !== expected.id || configured?.slug !== expected.slug) {
      throw new FixtureProvisioningError('TENANT_NOT_AUTHORIZED', key);
    }
  }
}

export function documentAssetRoot(moduleUrl = import.meta.url) {
  return new URL('../source-binaries/', moduleUrl);
}

function resolveActor(config, mapping, tenantId) {
  const key = Object.keys(AUTHORIZED_TENANTS).find(
    (candidate) => AUTHORIZED_TENANTS[candidate].id === tenantId,
  );
  const actorKey = mapping[key];
  const actor = config.actors?.[actorKey];
  if (actor?.tenantId !== key) return null;
  return actor.physicalId ?? actor.userId ?? null;
}

/**
 * Direct, narrow fixture composition. This deliberately avoids AppModule and
 * EngagementModule bootstrap so schedulers, provider workers, and callbacks do
 * not start inside the one-shot fixture CLI.
 */
export async function createAdapter({ config }) {
  assertClientDocumentRuntimeConfig({ config });
  const require = createRequire(new URL('../../../../apps/api/package.json', import.meta.url));
  const dist = (path) =>
    require(fileURLToPath(new URL(`../../../../apps/api/dist/${path}`, import.meta.url)));
  const { PrismaService } = dist('prisma/prisma.service.js');
  const { EngagementService } = dist('engagement/engagement.service.js');
  const { ClientDocumentWriterService } = dist(
    'client-documents/client-document-writer.service.js',
  );
  const { AttachmentContentService } = dist('engagement/attachment-content.service.js');
  const { AttachmentScannerService } = dist('engagement/attachment-scanner.service.js');
  const { ClientKbService } = dist('embeddings/client-kb.service.js');
  const { clientMemoryAllowed } = dist('memory/memory-wall.helpers.js');
  const { parseExactBooleanEnvironment } = dist('engagement/runtime/engagement-runtime-env.js');

  const values = {
    ASSETS_BUCKET: process.env.ASSETS_BUCKET,
    AWS_REGION_DEFAULT: process.env.AWS_REGION_DEFAULT ?? 'us-east-1',
    OPENAI_API_KEY: undefined,
    OUTREACH_DAILY_TOKEN_BUDGET: undefined,
    ENGAGEMENT_VERSIONED_OUTREACH: false,
    ENGAGEMENT_EXTERNAL_SEND_V2_REQUIRED: false,
    ENGAGEMENT_ARTIFACT_SHARING_V2: false,
    ENGAGEMENT_ATTACHMENT_SCAN_REQUIRED: parseExactBooleanEnvironment(
      'ENGAGEMENT_ATTACHMENT_SCAN_REQUIRED',
      process.env.ENGAGEMENT_ATTACHMENT_SCAN_REQUIRED,
      false,
    ),
    CLIO_CLIENT_KB_ENABLED: !['false', '0', 'no', 'off'].includes(
      (process.env.CLIO_CLIENT_KB_ENABLED ?? 'true').trim().toLowerCase(),
    ),
  };
  const configService = {
    get(name) {
      if (!Object.hasOwn(values, name)) {
        throw new FixtureProvisioningError('CLIENT_DOCUMENT_RUNTIME_CONFIG_INVALID', name);
      }
      return values[name];
    },
  };
  const forbidden = new Proxy(
    {},
    {
      get(_target, property) {
        throw new FixtureProvisioningError(
          'CLIENT_DOCUMENT_EFFECT_REFUSED',
          `unexpected Engagement dependency access: ${String(property)}`,
        );
      },
    },
  );
  const prisma = new PrismaService();
  try {
    await prisma.$connect();
    for (const [key, expected] of Object.entries(AUTHORIZED_TENANTS)) {
      const rows = await prisma.withTenant(expected.id, (tx) =>
        tx.$queryRawUnsafe(
          'SELECT id::text, slug FROM tenants WHERE id=$1::uuid AND slug=$2',
          expected.id,
          expected.slug,
        ),
      );
      if (rows.length !== 1) throw new FixtureProvisioningError('SYNTHETIC_TENANT_NOT_FOUND', key);
    }

    const attachmentContent = new AttachmentContentService();
    const scanner = new AttachmentScannerService(configService);
    const clientKb = new ClientKbService(prisma, configService);
    // The source reader and deletion operations below use only these canonical
    // service methods. Every other Engagement dependency is a throwing guard.
    const engagement = new EngagementService(
      prisma,
      forbidden,
      forbidden,
      forbidden,
      forbidden,
      forbidden,
      forbidden,
      forbidden,
      clientKb,
      forbidden,
      forbidden,
      forbidden,
      attachmentContent,
      scanner,
      { setAttachmentReader() {} },
      forbidden,
      configService,
    );
    const runtimePolicy = {
      assertExternalAction(action) {
        if (
          process.env.MERI_SYNTHETIC_FIXTURE_NAMESPACE !== FIXTURE_NAMESPACE ||
          !DOCUMENT_ACTIONS.has(action)
        ) {
          throw new FixtureProvisioningError('CLIENT_DOCUMENT_ACTION_REFUSED', String(action));
        }
      },
    };
    const documentWriter = new ClientDocumentWriterService(engagement, runtimePolicy);
    const actorForTenant = (tenantId) =>
      resolveActor(
        config,
        config.uploaderActors ?? config.candidateActors ?? { T1: 'PAT' },
        tenantId,
      );
    const reader = createClientDocumentOwnerReader({
      prisma,
      engagement,
      actorForTenant,
      clientMemoryAllowed,
      storageBucket: process.env.ASSETS_BUCKET,
    });
    const deletion = createClientDocumentDeletionPort({ prisma, documentWriter, actorForTenant });
    const port = createClientDocumentOwnerPort({
      documentWriter,
      reader,
      actorForTenant,
      assetRoot: documentAssetRoot(),
      deletion,
    });
    const adapter = new CanonicalOwnerAdapter({ ownerPorts: { engagement_attachment: port } });
    adapter.authority = 'canonical_readback';
    adapter.close = () => prisma.$disconnect();
    return adapter;
  } catch (error) {
    await prisma.$disconnect();
    throw error;
  }
}
