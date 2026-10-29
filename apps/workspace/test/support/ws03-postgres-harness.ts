import 'reflect-metadata';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ClerkService, ORG_TENANT_RESOLVER } from '@capiro/auth';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import { PrismaOrgTenantResolver } from '../../src/auth/org-tenant-resolver.provider.js';
import { CollaboratorsService } from '../../src/collaborators/collaborators.service.js';
import { CommentsService } from '../../src/comments/comments.service.js';
import { CommentsController } from '../../src/comments/comments.controller.js';
import { ChecksService } from '../../src/checks/checks.service.js';
import { ChecksController } from '../../src/checks/checks.controller.js';
import { DraftsService } from '../../src/drafts/drafts.service.js';
import { DraftsController } from '../../src/drafts/drafts.controller.js';
import { EditLockService } from '../../src/edit-lock/edit-lock.service.js';
import { EditLockController } from '../../src/edit-lock/edit-lock.controller.js';
import { DocumentsService } from '../../src/documents/documents.service.js';
import { DocumentsController } from '../../src/documents/documents.controller.js';
import { VersionsService } from '../../src/versions/versions.service.js';
import { VersionsController } from '../../src/versions/versions.controller.js';
import { ProspectPublicationController } from '../../src/versions/prospect-publication.controller.js';
import { ProspectPublicationService } from '../../src/versions/prospect-publication.service.js';
import { DocumentAgentController } from '../../src/document-agent/document-agent.controller.js';
import { DocumentAgentService } from '../../src/document-agent/document-agent.service.js';
import { DocumentAgentQualityService } from '../../src/document-agent/document-agent-quality.service.js';
import { ProspectGenerationController } from '../../src/document-agent/prospect-generation/prospect-generation.controller.js';
import { ProspectGenerationService } from '../../src/document-agent/prospect-generation/prospect-generation.service.js';
import { DocumentAgentRevisionService } from '../../src/document-agent/document-agent-revision.service.js';
import type { ProspectGenerationBootstrapClient } from '../../src/document-agent/prospect-generation/bootstrap.client.js';
import type { NativeGenerationTurnPort } from '../../src/document-agent/native-generation.bridge.js';
import { DESCENDANT_ROUTES, ADJACENT_ROUTES, WS03_IDS } from './ws03-descendant-harness.js';

export { DESCENDANT_ROUTES, ADJACENT_ROUTES, WS03_IDS };
export const NATIVE_TOKEN = 'synthetic-trusted-session';
const { tenantId, draftId, documentId, commentId, versionId } = WS03_IDS;
const ownerUserId = '00000000-0000-4000-8000-000000000020';
const unrelatedUserId = '00000000-0000-4000-8000-000000000021';
const config = { clientId: null, sections: ['Overview'], sectionContent: { Overview: 'PRIVATE_DESCENDANT_CONTENT' } };
const documentBody = { blocks: [{ content: 'PRIVATE_DESCENDANT_CONTENT' }] };

/** Real PostgreSQL/Prisma/authority/TenantGuard, with only external Clerk token
 * verification and text generation replaced. db push intentionally does not
 * reproduce migration-installed RLS, grants or immutable triggers. */
export async function createNativeWorkspaceHarness(url: string, options: {
  generation?: { bootstrap: ProspectGenerationBootstrapClient; native: NativeGenerationTurnPort };
} = {}) {
  const db = new PrismaService({ datasources: { db: { url } } });
  const reads: string[] = [], effects: string[] = [];
  const state = { actorId: 'user_owner' };
  let observing = false;
  db.$use(async (params, next) => {
    if (observing && params.model) {
      const isRead = ['findFirst', 'findFirstOrThrow', 'findMany', 'findUnique'].includes(params.action);
      if (isRead && (
        ['WsComment', 'WsEditLock', 'WsDocVersion'].includes(params.model)
        || (params.model === 'WsDocument' && (!params.args?.select || params.action === 'findMany'))
        || (params.model === 'WsDraft' && (!params.args?.select || params.args?.include?.documents))
      )) reads.push(`${params.model}.${params.action}`);
      if (['create', 'createMany', 'update', 'updateMany', 'delete', 'deleteMany', 'upsert'].includes(params.action))
        effects.push(`${params.model}.${params.action}`);
    }
    return next(params);
  });
  let app: INestApplication | undefined;
  try {
  await db.$connect();
  // All identity facts are native rows, never mocked lookup return values.
  await db.$executeRaw`
    INSERT INTO tenants (id,slug,name,status,clerk_org_id,updated_at)
    VALUES (${tenantId}::uuid,'a1-native-workspace','A1 disposable tenant','active','org_a1_native',now())`;
  for (const [id, actor] of [[ownerUserId, 'user_owner'], [unrelatedUserId, 'user_unrelated']] as const) {
    await db.$executeRaw`
      INSERT INTO users (id,clerk_user_id,email,updated_at)
      VALUES (${id}::uuid,${actor},${`${actor}@a1.invalid`},now())`;
    await db.$executeRaw`
      INSERT INTO tenant_memberships (id,tenant_id,user_id,role,status,updated_at)
      VALUES (${id}::uuid,${tenantId}::uuid,${id}::uuid,'standard_user','active',now())`;
  }

  async function snapshot() {
    const previous = observing;
    observing = false;
    try {
      return {
        drafts: await db.wsDraft.findMany({ where: { tenantId }, orderBy: { id: 'asc' } }),
        documents: await db.wsDocument.findMany({ where: { tenantId }, orderBy: { id: 'asc' } }),
        comments: await db.wsComment.findMany({ where: { tenantId }, orderBy: { id: 'asc' } }),
        locks: await db.wsEditLock.findMany({ where: { tenantId }, orderBy: { draftId: 'asc' } }),
        versions: await db.wsDocVersion.findMany({ where: { tenantId }, orderBy: { id: 'asc' } }),
        proposals: await db.wsAgentProposal.findMany({ where: { tenantId }, orderBy: { id: 'asc' } }),
      };
    } finally { observing = previous; }
  }
  let before = {} as Awaited<ReturnType<typeof snapshot>>;
  async function reset(overrides: Record<string, unknown> = {}) {
    if (Object.keys(overrides).some(key => key !== 'actorId')
      || (overrides.actorId !== undefined && !['user_owner', 'user_unrelated'].includes(String(overrides.actorId))))
      throw new Error('Native fixture supports only the explicitly selected owner/unrelated cases');
    observing = false;
    state.actorId = overrides.actorId === 'user_unrelated' ? 'user_unrelated' : 'user_owner';
    await db.$transaction(async tx => {
      await tx.wsDraft.deleteMany({ where: { tenantId } });
      await tx.wsDraft.create({ data: {
        id: draftId, tenantId, ownerId: 'user_owner', docTitle: 'PRIVATE_DESCENDANT_CONTENT',
        product: 'brief', clientId: null, client: null, config,
      } });
      await tx.wsDocument.create({ data: {
        id: documentId, tenantId, draftId, name: 'Native fixture document', ordinal: 0, body: documentBody,
      } });
      await tx.wsComment.create({ data: {
        id: commentId, tenantId, documentId, authorId: 'user_owner', role: 'editor',
        body: 'PRIVATE_DESCENDANT_CONTENT', quote: 'Private quoted passage',
      } });
      await tx.wsEditLock.create({ data: {
        tenantId, draftId, holderId: 'user_owner', holderName: 'PRIVATE_DESCENDANT_CONTENT',
      } });
      await tx.wsDocVersion.create({ data: {
        id: versionId, tenantId, draftId, authorId: 'user_owner', authorKind: 'person',
        label: 'Native saved revision', snapshot: {
          docTitle: 'PRIVATE_DESCENDANT_CONTENT', config, ask: null,
          documents: [{ id: documentId, name: 'Native fixture document', ordinal: 0, body: documentBody }],
        },
      } });
    });
    before = await snapshot();
    reads.length = 0; effects.length = 0; observing = true;
  }
  const collaborators = new CollaboratorsService(db, {} as never);
  const generation = { suggestCommentEdit: async () => {
    effects.push('generation.suggest');
    return { before: 'Private quoted passage', after: 'Rewritten passage' };
  } };
  const comments = new CommentsService(db, generation as never, collaborators);
  const checks = new ChecksService(db, collaborators);
  const quality = new DocumentAgentQualityService(db, checks, collaborators);
  const resolver = new PrismaOrgTenantResolver(db);
  const module = await Test.createTestingModule({
    controllers: [CommentsController, ChecksController, DraftsController, EditLockController,
      DocumentsController, VersionsController, ProspectPublicationController, DocumentAgentController, ProspectGenerationController],
    providers: [
      { provide: ClerkService, useValue: { verifySessionToken: async (token: string) => {
        if (token !== NATIVE_TOKEN) throw new Error('Unknown local fixture token');
        return { sub: state.actorId, org_id: 'org_a1_native', capiro_tenant_id: tenantId };
      } } },
      { provide: ORG_TENANT_RESOLVER, useValue: resolver },
      { provide: CommentsService, useValue: comments },
      { provide: ChecksService, useValue: checks },
      { provide: DraftsService, useValue: new DraftsService(db, collaborators) },
      { provide: EditLockService, useValue: new EditLockService(db, collaborators) },
      { provide: DocumentsService, useValue: new DocumentsService(db, collaborators) },
      { provide: VersionsService, useValue: new VersionsService(db, collaborators) },
      { provide: ProspectPublicationService, useValue: new ProspectPublicationService(db) },
      { provide: DocumentAgentQualityService, useValue: quality },
      { provide: DocumentAgentService, useValue: {} },
      { provide: ProspectGenerationService, useValue: new ProspectGenerationService(db, collaborators,
        new DocumentAgentRevisionService(db), options.generation?.bootstrap ??
        ({ configured: () => false } as ProspectGenerationBootstrapClient), options.generation?.native ?? null) },
    ],
  }).compile();
  app = module.createNestApplication();
  app.setGlobalPrefix('workspace-api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true,
    transformOptions: { enableImplicitConversion: false } }));
  await app.listen(0, '127.0.0.1');
  await reset();
  return {
    app, db, state, reads, effects, reset, snapshot,
    original: () => before,
    async close() { try { await app?.close(); } finally { await db.$disconnect(); } },
  };
  } catch (error) {
    try { await app?.close(); } finally { await db.$disconnect(); }
    throw error;
  }
}
