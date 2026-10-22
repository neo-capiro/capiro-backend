import 'reflect-metadata';
import { ValidationPipe, type ExecutionContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { TenantGuard } from '../../src/auth/tenant.guard.js';
import { CollaboratorsService } from '../../src/collaborators/collaborators.service.js';
import { CommentsService } from '../../src/comments/comments.service.js';
import { CommentsController } from '../../src/comments/comments.controller.js';
import { ChecksService } from '../../src/checks/checks.service.js';
import { ChecksController } from '../../src/checks/checks.controller.js';
import { DraftsService } from '../../src/drafts/drafts.service.js';
import { DraftsController } from '../../src/drafts/drafts.controller.js';
import { EditLockService } from '../../src/edit-lock/edit-lock.service.js';
import { EditLockController } from '../../src/edit-lock/edit-lock.controller.js';
import { DocumentsController } from '../../src/documents/documents.controller.js';
import { DocumentsService } from '../../src/documents/documents.service.js';
import { VersionsController } from '../../src/versions/versions.controller.js';
import { VersionsService } from '../../src/versions/versions.service.js';
import { DocumentAgentController } from '../../src/document-agent/document-agent.controller.js';
import { DocumentAgentService } from '../../src/document-agent/document-agent.service.js';
import { DocumentAgentQualityService } from '../../src/document-agent/document-agent-quality.service.js';

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
export const WS03_IDS = {
  tenantId: id(1), foreignTenantId: id(2), draftId: id(3), documentId: id(4),
  commentId: id(5), clientId: id(6), prospectId: id(7), foreignId: id(8), userId: id(9), versionId: id(11),
};
const { tenantId, draftId, documentId, commentId, clientId, prospectId, userId, versionId } = WS03_IDS;

export type DescendantRoute = {
  name: string; method: 'get' | 'post' | 'patch' | 'delete'; path: string;
  body?: Record<string, unknown>; policy: 'read' | 'comment' | 'review' | 'edit'; status: number;
};
export const DESCENDANT_ROUTES: DescendantRoute[] = [
  { name: 'comment list', method: 'get', path: `documents/${documentId}/comments`, policy: 'read', status: 200 },
  { name: 'comment create', method: 'post', path: `documents/${documentId}/comments`, body: { body: 'Requested comment' }, policy: 'comment', status: 201 },
  { name: 'comment update', method: 'patch', path: `documents/${documentId}/comments/${commentId}`, body: { resolved: true }, policy: 'review', status: 200 },
  { name: 'comment delete', method: 'delete', path: `documents/${documentId}/comments/${commentId}`, policy: 'review', status: 200 },
  { name: 'comment suggestion', method: 'post', path: `documents/${documentId}/comments/${commentId}/suggest`, policy: 'review', status: 201 },
  { name: 'checks', method: 'get', path: `drafts/${draftId}/checks`, policy: 'read', status: 200 },
  { name: 'lock status', method: 'get', path: `drafts/${draftId}/lock`, policy: 'read', status: 200 },
  { name: 'lock acquire', method: 'post', path: `drafts/${draftId}/lock/acquire`, body: { name: 'Fixture actor' }, policy: 'edit', status: 201 },
  { name: 'lock heartbeat', method: 'post', path: `drafts/${draftId}/lock/heartbeat`, policy: 'edit', status: 201 },
  { name: 'lock release', method: 'post', path: `drafts/${draftId}/lock/release`, policy: 'read', status: 201 },
  { name: 'lock request', method: 'post', path: `drafts/${draftId}/lock/request`, body: { name: 'Fixture actor' }, policy: 'edit', status: 201 },
  { name: 'lock take-over', method: 'post', path: `drafts/${draftId}/lock/take-over`, body: { name: 'Fixture actor' }, policy: 'edit', status: 201 },
  { name: 'anonymization', method: 'post', path: `drafts/${draftId}/anonymize/detect`, policy: 'read', status: 201 },
];

/** Separately classified WS-03 follow-up; the original 13-route matrix stays unchanged. */
export const ADJACENT_ROUTES: DescendantRoute[] = [
  { name: 'document list', method: 'get', path: `drafts/${draftId}/documents`, policy: 'read', status: 200 },
  { name: 'quality fix', method: 'post', path: `drafts/${draftId}/agent/quality/issues/missing-context/fix`, body: { expectedRevision: 0, instruction: 'Synthetic fix' }, policy: 'edit', status: 201 },
  { name: 'version list', method: 'get', path: `drafts/${draftId}/versions`, policy: 'read', status: 200 },
  { name: 'version create', method: 'post', path: `drafts/${draftId}/versions`, body: { label: 'Synthetic revision' }, policy: 'edit', status: 201 },
  { name: 'version restore', method: 'post', path: `drafts/${draftId}/versions/${versionId}/restore`, policy: 'edit', status: 201 },
];

type FixtureState = {
  actorId: string; tenantId: string; member: boolean; tenantActive: boolean; clientActive: boolean;
  wallAllowed: boolean; prospect: boolean; prospectEnabled: boolean; exists: boolean; held: boolean; revokedCollaborator: boolean; invalidCopiedBrief: boolean;
  sourceRows: Array<{ source_key: string; owner_id: string; source_type: string }>;
  roles: Record<string, string | null>; removedActors: string[];
};

/** Synthetic Prisma seam only: no database, provider or production identity is contacted.
 * Real authority helpers execute against exact parent/tenant-aware query results.
 * reads tracks nominated full descendant operations, not all content-bearing
 * bytes: the existing authority lookup legitimately selects draft config. */
export function createDescendantHarness() {
  const state = {} as FixtureState;
  const reads: string[] = [], effects: string[] = [], authorityQueries: string[] = [];
  const draft: any = {};
  let comment: any;
  let lock: any;
  let version: any;
  const now = () => new Date('2026-10-21T00:00:00Z');
  function clearObservations() { reads.length = 0; effects.length = 0; authorityQueries.length = 0; }
  function reset(overrides: Partial<FixtureState> = {}) {
    Object.assign(state, {
      actorId: 'user_owner', tenantId, member: true, tenantActive: true, clientActive: true,
      wallAllowed: true, prospect: false, prospectEnabled: true, exists: true, held: false, revokedCollaborator: false, invalidCopiedBrief: false, sourceRows: [],
      roles: { user_editor: 'editor', user_reviewer: 'reviewer', user_commenter: 'commenter', user_viewer: 'viewer' },
      removedActors: [], ...overrides,
    });
    Object.assign(draft, {
      id: draftId, tenantId, ownerId: 'user_owner', prospectId: state.prospect ? prospectId : null,
      clientId: state.prospect || state.held ? null : clientId, client: 'Private client',
      config: { ...(state.prospect || state.held ? {} : { clientId }), client: 'Private client', sections: ['Overview'], sectionContent: { Overview: 'PRIVATE_DESCENDANT_CONTENT Private client' } },
      docTitle: 'PRIVATE_DESCENDANT_CONTENT Private client', product: 'brief', ask: null,
      status: 'draft', updatedAt: now(), documents: [{ id: documentId, tenantId, draftId, name: 'Synthetic document', ordinal: 0, body: { blocks: [{ content: 'PRIVATE_DESCENDANT_CONTENT' }] } }],
    });
    comment = { id: commentId, tenantId, documentId, authorId: 'user_owner', role: 'editor', body: 'PRIVATE_DESCENDANT_CONTENT', quote: 'Private quoted passage', parentId: null, createdAt: now(), replies: [], resolved: false };
    lock = { tenantId, draftId, holderId: state.actorId, holderName: 'PRIVATE_DESCENDANT_CONTENT', acquiredAt: now(), lastHeartbeatAt: new Date(), requestedById: null, requestedByName: null, requestedAt: null };
    version = { id: versionId, tenantId, draftId, label: 'Synthetic saved revision', authorId: 'user_owner', authorKind: 'person', createdAt: now(), snapshot: { docTitle: draft.docTitle, config: { ...draft.config, clientId: draft.clientId }, ask: draft.ask, documents: structuredClone(draft.documents) } };
    clearObservations();
  }
  reset();
  const member = (actor: unknown, tenant: unknown) => state.member && state.tenantActive && tenant === tenantId && typeof actor === 'string' && actor.startsWith('user_') && !state.removedActors.includes(actor);
  const matchDraft = (where: any) => state.exists && where.id === draftId && where.tenantId === tenantId;
  const matchDocument = (where: any) => state.exists && where.id === documentId && where.tenantId === tenantId;
  const matchComment = (where: any) => comment && where.id === commentId && where.documentId === documentId && where.tenantId === tenantId;
  const select = (row: any, fields: any): any => fields
    ? Object.fromEntries(Object.keys(fields).filter(key => fields[key]).map(key => [
      key, typeof fields[key] === 'object' && fields[key].select ? select(row[key], fields[key].select) : row[key],
    ]))
    : row;
  const roleFor = (actor: string) => actor === draft.ownerId ? 'owner' : state.revokedCollaborator ? null : state.roles[actor] ?? null;

  const db: any = {
    wsDraft: {
      findFirst: async (args: any) => {
        if (!args.select || args.include?.documents) reads.push('draft.content');
        return matchDraft(args.where) ? select(draft, args.select) : null;
      },
      findFirstOrThrow: async (args: any) => {
        if (!args.select || args.include?.documents) reads.push('draft.content');
        if (!matchDraft(args.where)) throw new Error('Missing fixture draft');
        return select(draft, args.select);
      },
      update: async ({ where, data }: any) => {
        if (where.id !== draftId) throw new Error('Wrong fixture draft update');
        effects.push('draft.update'); Object.assign(draft, data); return draft;
      },
    },
    wsCollaborator: { findFirst: async ({ where }: any) => {
      if (where.tenantId !== tenantId || where.draftId !== draftId || where.status !== 'active') return null;
      const role = state.revokedCollaborator ? null : state.roles[where.subjectId];
      return role ? { role } : null;
    } },
    wsDocument: {
      findFirst: async (args: any) => {
        if (!args.select) reads.push('document.content');
        if (!matchDocument(args.where)) return null;
        const row = { id: documentId, tenantId, draftId, draft, body: draft.documents[0].body };
        return select(row, args.select);
      },
      findMany: async ({ where }: any) => {
        reads.push('document.list');
        return state.exists && where.tenantId === tenantId && where.draftId === draftId ? structuredClone(draft.documents) : [];
      },
      update: async ({ where, data }: any) => {
        if (where.id !== documentId) throw new Error('Wrong fixture document update');
        effects.push('document.update'); Object.assign(draft.documents[0], data); return draft.documents[0];
      },
    },
    wsDocVersion: {
      findMany: async ({ where }: any) => {
        reads.push('version.list');
        return where.tenantId === tenantId && where.draftId === draftId ? [structuredClone(version)] : [];
      },
      findFirst: async ({ where }: any) => {
        reads.push('version.read');
        return where.tenantId === tenantId && where.draftId === draftId && where.id === versionId ? structuredClone(version) : null;
      },
      create: async ({ data }: any) => {
        if (data.tenantId !== tenantId || data.draftId !== draftId) throw new Error('Wrong fixture version creation');
        effects.push('version.create'); return { id: id(12), createdAt: now(), ...data };
      },
    },
    wsAgentProposal: { create: async ({ data }: any) => {
      if (data.tenantId !== tenantId || data.draftId !== draftId) throw new Error('Wrong fixture proposal creation');
      effects.push('proposal.create'); return { id: id(13), ...data };
    } },
    wsComment: {
      findMany: async ({ where }: any) => { reads.push('comment.list'); return where.tenantId === tenantId && where.documentId === documentId && comment ? [comment] : []; },
      findFirst: async ({ where }: any) => { reads.push('comment.read'); return matchComment(where) ? comment : null; },
      create: async ({ data }: any) => { effects.push('comment.create'); return { id: id(10), parentId: null, createdAt: now(), resolved: false, replies: [], ...data }; },
      update: async ({ data }: any) => { effects.push('comment.update'); Object.assign(comment, data); return comment; },
      delete: async () => { effects.push('comment.delete'); const old = comment; comment = null; return old; },
    },
    wsEditLock: {
      findFirst: async ({ where }: any) => { reads.push('lock.read'); return where.tenantId === tenantId && where.draftId === draftId ? lock : null; },
      create: async ({ data }: any) => { effects.push('lock.create'); lock = { ...data, acquiredAt: new Date(), lastHeartbeatAt: new Date(), requestedById: null, requestedByName: null, requestedAt: null }; return lock; },
      update: async ({ data }: any) => { effects.push('lock.update'); Object.assign(lock, data); return lock; },
      delete: async () => { effects.push('lock.delete'); const old = lock; lock = null; return old; },
    },
    $executeRaw: async () => 1,
    $queryRaw: async (parts: TemplateStringsArray, ...values: unknown[]) => {
      const sql = parts.join('?'); authorityQueries.push(sql);
      if (sql.includes('FROM users u JOIN tenant_memberships')) return member(values[1], values[0]) ? [{ id: userId }] : [];
      if (sql.includes('FROM clients')) return values[0] === tenantId && values[1] === clientId && state.clientActive ? [{ id: clientId, name: 'Private client' }] : [];
      if (sql.includes('FROM ws_source_action')) return state.sourceRows;
      if (sql.includes('FROM ws_draft')) return values[0] === tenantId && values[1] === draftId && state.exists ? [{ ownerId: draft.ownerId, prospectId: draft.prospectId }] : [];
      if (sql.includes('FROM ws_collaborator')) { const role = roleFor(String(values[2])); return role ? [{ role }] : []; }
      if (sql.includes('FROM ws_document') && sql.includes('source_brief_version')) return state.invalidCopiedBrief ? [{ sourceBriefVersion: {} }] : [];
      throw new Error(`Unexpected fixture authority query: ${sql}`);
    },
    $queryRawUnsafe: async (sql: string, ...values: unknown[]) => {
      authorityQueries.push(sql);
      if (sql.includes('FROM business_development_prospects')) return state.prospect && values[0] === tenantId && values[1] === prospectId ? [{ status: 'active', dismissedAt: null, linkedClientId: clientId }] : [];
      if (sql.includes('FROM tenants')) return state.tenantActive && values[0] === tenantId ? [{ settings: { clioFeatureFlags: { 'businessDevelopment.enabled': state.prospectEnabled } } }] : [];
      if (sql.includes('FROM tenant_memberships')) return member(values[2], values[0]) ? [{ userId, clerkUserId: values[2] }] : [];
      if (sql.includes('set_config')) return [];
      if (sql.includes('SELECT status,memory_wall')) return state.clientActive ? [{ status: 'active', memoryWall: true }] : [];
      if (sql.includes('SELECT id FROM client_memory_access')) return state.wallAllowed ? [{ id: 'grant' }] : [];
      if (sql.includes('AS allowed')) return [{ allowed: state.wallAllowed && state.clientActive }];
      throw new Error(`Unexpected fixture authority query: ${sql}`);
    },
  };
  db.$transaction = async (fn: (tx: any) => unknown) => fn(db);
  db.withSystem = async (fn: (tx: any) => unknown) => fn(db);
  const collaborators = new CollaboratorsService(db, {} as never);
  const generation = { suggestCommentEdit: async () => { effects.push('generation.suggest'); return { before: 'Private quoted passage', after: 'Rewritten passage' }; } };
  const comments = new CommentsService(db, generation as never, collaborators);
  const checks = new ChecksService(db, collaborators);
  const drafts = new DraftsService(db, collaborators);
  const locks = new EditLockService(db, collaborators);
  const documents = new DocumentsService(db, collaborators);
  const versions = new VersionsService(db, collaborators);
  const quality = new DocumentAgentQualityService(db, checks, collaborators);
  const setCommentAuthor = (actorId: string) => { comment.authorId = actorId; };
  return { state, draft, reads, effects, authorityQueries, reset, clearObservations, setCommentAuthor, db, collaborators, comments, checks, drafts, locks, documents, versions, quality };
}

export async function createDescendantApp(h: ReturnType<typeof createDescendantHarness>) {
  const module = await Test.createTestingModule({
    controllers: [CommentsController, ChecksController, DraftsController, EditLockController, DocumentsController, VersionsController, DocumentAgentController],
    providers: [
      { provide: CommentsService, useValue: h.comments }, { provide: ChecksService, useValue: h.checks },
      { provide: DraftsService, useValue: h.drafts }, { provide: EditLockService, useValue: h.locks },
      { provide: DocumentsService, useValue: h.documents }, { provide: VersionsService, useValue: h.versions },
      { provide: DocumentAgentQualityService, useValue: h.quality }, { provide: DocumentAgentService, useValue: {} },
    ],
  }).overrideGuard(TenantGuard).useValue({
    canActivate(context: ExecutionContext) {
      // Trusted fixture identity; browser headers/body never supply this context.
      context.switchToHttp().getRequest().tenantContext = { tenantId: h.state.tenantId, clerkUserId: h.state.actorId, role: null };
      return true;
    },
  }).compile();
  const app = module.createNestApplication();
  app.setGlobalPrefix('workspace-api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, transformOptions: { enableImplicitConversion: false } }));
  await app.init();
  return app;
}
