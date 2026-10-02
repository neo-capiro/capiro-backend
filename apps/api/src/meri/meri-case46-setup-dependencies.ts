import { ConfigService } from '@nestjs/config';
import { VALIDATED_ENV_PROPNAME } from '@nestjs/config/dist/config.constants.js';
import { MERI_CASE46 } from '@capiro/meriv2-core';
import type { TenantContext } from '@capiro/shared';
import type { AppConfig } from '../config/config.schema.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { EngagementService } from '../engagement/engagement.service.js';
import { AttachmentContentService } from '../engagement/attachment-content.service.js';
import { AttachmentScannerService } from '../engagement/attachment-scanner.service.js';
import { EvidenceSourceService } from '../engagement/generation/evidence-source.service.js';
import { EngagementRuntimePolicyService } from '../engagement/runtime/engagement-runtime-policy.service.js';
import {
  parseExactBooleanEnvironment,
  resolveEngagementRuntimeEnvironment,
} from '../engagement/runtime/engagement-runtime-env.js';
import { ClientKbService } from '../embeddings/client-kb.service.js';
import { ClientDocumentWriterService } from '../client-documents/client-document-writer.service.js';
import { runWithCase46SourceIndexing } from '../client-documents/case46-source-indexing.js';
import { MeriService } from './meri.service.js';
import { assertCase46CurrentActorInTx, case46SourceIdentity } from './meri-case46-authority.js';

/** Exact document-only operator composition. Like the canonical fixture runtime,
 * unrelated Engagement collaborators are refusing ports, never success stubs.
 * No AppModule, timer, bulk worker, controller, or chat model is bootstrapped. */
export async function createCase46SetupDependencies() {
  if (
    arguments.length !== 0 ||
    process.env.MERI_SYNTHETIC_FIXTURE_NAMESPACE !== MERI_CASE46.namespace ||
    !process.env.ASSETS_BUCKET ||
    !process.env.DATABASE_URL ||
    !process.env.INTERNAL_SERVICE_SECRET
  )
    throw new Error('meri_case46_setup_configuration_required');
  let database: URL;
  try {
    database = new URL(process.env.DATABASE_URL);
  } catch {
    throw new Error('meri_case46_setup_database_invalid');
  }
  if (!['postgres:', 'postgresql:'].includes(database.protocol))
    throw new Error('meri_case46_setup_database_invalid');
  const runtime = new EngagementRuntimePolicyService(
    resolveEngagementRuntimeEnvironment(process.env),
  );
  runtime.assertExternalAction('attachment_external_read');
  runtime.assertExternalAction('attachment_external_write');
  const values = {
    ASSETS_BUCKET: process.env.ASSETS_BUCKET,
    AWS_REGION_DEFAULT: process.env.AWS_REGION_DEFAULT ?? 'us-east-1',
    ENGAGEMENT_ATTACHMENT_SCAN_REQUIRED: parseExactBooleanEnvironment(
      'ENGAGEMENT_ATTACHMENT_SCAN_REQUIRED',
      process.env.ENGAGEMENT_ATTACHMENT_SCAN_REQUIRED,
      false,
    ),
    CLIO_CLIENT_KB_ENABLED: parseExactBooleanEnvironment(
      'CLIO_CLIENT_KB_ENABLED',
      process.env.CLIO_CLIENT_KB_ENABLED,
      true,
    ),
  };
  // ConfigService checks raw process strings before ordinary internal values.
  // Use the same validated-value slot as ConfigModule; otherwise "false" is
  // truthy in Scanner/ClientKb and silently changes their configured behavior.
  const config = new ConfigService<AppConfig, true>({ [VALIDATED_ENV_PROPNAME]: values });
  const refused = new Proxy(
    {},
    {
      get() {
        throw new Error('meri_case46_setup_unrelated_dependency_refused');
      },
    },
  ) as never;
  const prisma = new PrismaService();
  let closed = false;
  let closePromise: Promise<void> | undefined;
  const close = () => {
    closed = true;
    return (closePromise ??= prisma.$disconnect());
  };
  try {
    await prisma.$connect();
    const content = new AttachmentContentService();
    const scanner = new AttachmentScannerService(config);
    const clientKb = new ClientKbService(prisma, config);
    const sources = new EvidenceSourceService(prisma, refused, refused, content, refused);
    const engagement = new EngagementService(
      prisma,
      refused,
      refused,
      refused,
      refused,
      refused,
      refused,
      refused,
      clientKb,
      refused,
      refused,
      refused,
      content,
      scanner,
      sources,
      refused,
      config,
    );
    const writer = new ClientDocumentWriterService(engagement, runtime);
    const open = () => {
      if (closed) throw new Error('meri_case46_setup_closed');
    };
    const assertActor = async (ctx: TenantContext) => {
      open();
      await prisma.withTenantUser(ctx.tenantId, ctx.userId, (tx) =>
        assertCase46CurrentActorInTx(tx, ctx),
      );
    };
    const sourceReader = Object.freeze({
      extractAttachmentText: async (
        ctx: TenantContext,
        id: string,
        options: Parameters<EngagementService['extractAttachmentText']>[2],
      ) => {
        open();
        runtime.assertExternalAction('attachment_external_read');
        if (
          ctx.tenantId !== MERI_CASE46.tenantId ||
          ctx.userId !== MERI_CASE46.actorUserId ||
          options?.clientId !== MERI_CASE46.clientId ||
          options.contextSourceOnly !== true ||
          Object.keys(options).some(
            (key) => !['clientId', 'contextSourceOnly', 'signal'].includes(key),
          )
        )
          throw new Error('meri_case46_setup_source_read_scope');
        return engagement.extractAttachmentText(ctx, id, options);
      },
    });
    async function createSource(context: TenantContext, captureRunId: string) {
      const ctx = structuredClone(context);
      await assertActor(ctx);
      const identity = case46SourceIdentity(captureRunId);
      const input = {
        clientId: MERI_CASE46.clientId,
        fileName: MERI_CASE46.filename,
        contentType: 'text/plain',
        buffer: Buffer.from(MERI_CASE46.text, 'utf8'),
        source: 'meri_synthetic_fixture',
        sourceEntityType: 'meri_synthetic_fixture',
        sourceEntityId: identity.ownershipSha256,
        idempotencyKey: identity.idempotencyKey,
        sourceVersion: 1,
        sourceContentHash: MERI_CASE46.sha256,
        untrustedUpload: true,
      };
      const result = await runWithCase46SourceIndexing(ctx, captureRunId, input, () =>
        writer.createAttachmentFromBuffer(ctx, input),
      );
      if (result.reused || result.id !== identity.physicalId || result.lifecycleStatus !== 'ready')
        throw new Error('meri_case46_setup_source_not_new_and_ready');
      return {
        id: result.id,
        sourceSha256: MERI_CASE46.sha256,
        ownershipSha256: identity.ownershipSha256,
        byteLength: MERI_CASE46.byteLength,
      };
    }
    async function createConversation(context: TenantContext, captureRunId: string) {
      const ctx = structuredClone(context);
      case46SourceIdentity(captureRunId);
      open();
      return prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
        await assertCase46CurrentActorInTx(tx, ctx);
        // Existing canonical product create, on this same authorized transaction.
        // No model/prospect/RP collaborator can be selected by these fixed args.
        const receiver = Object.create(MeriService.prototype) as MeriService;
        Object.assign(receiver, {
          prisma: Object.freeze({
            withTenant: (tenantId: string, work: (value: typeof tx) => unknown) => {
              if (tenantId !== ctx.tenantId) throw new Error('meri_case46_setup_tenant_changed');
              return work(tx);
            },
          }),
        });
        const row = await MeriService.prototype.createConversation.call(receiver, ctx, {
          clientId: MERI_CASE46.clientId,
          title: `${MERI_CASE46.namespace} case46 ${captureRunId}`,
        });
        return { id: row.id, tenantId: row.tenantId, userId: row.userId, clientId: row.clientId };
      });
    }
    return Object.freeze({
      deps: Object.freeze({ prisma, engagement: sourceReader }),
      assertActor,
      createSource,
      createConversation,
      close,
    });
  } catch (error) {
    await close();
    throw error;
  }
}
