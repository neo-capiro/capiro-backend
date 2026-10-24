import { afterAll, beforeAll, describe, expect, jest, test } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { DraftsService } from '../src/drafts/drafts.service.js';
import { DocumentsService } from '../src/documents/documents.service.js';
import { CommentsService } from '../src/comments/comments.service.js';
import { ContextService } from '../src/context/context.service.js';
import { TemplatesService } from '../src/templates/templates.service.js';
import { ExportService } from '../src/export/export.service.js';
import { CollaboratorsService } from '../src/collaborators/collaborators.service.js';
import { NotificationsService } from '../src/notifications/notifications.service.js';
import type { GenerationService } from '../src/generation/generation.service.js';

/**
 * Engine API integration (AC-3.2..3.6) against an isolated Postgres schema.
 * Uses the existing A1 disposable PG16 helper, shared with WS-03. Requires
 * A1_NATIVE_PG_URL + A1_NATIVE_PG_ALLOW_DISPOSABLE=1; no default DB fallback.
 * The combined Core/Workspace schema supplies real membership/client facts.
 * Schema push is not proof of migration-installed RLS, grants or triggers.
 *
 * Verifies: draft create→get round-trip, packet/ask derivation, tenant
 * isolation, templates primary/secondary, document tabs, comment threads +
 * commenter resolve guard, context items.
 */
const repoRoot = resolve(__dirname, '../../..');
const helper = require(join(repoRoot, 'scripts/testing/a1-disposable-postgres.cjs')) as {
  nativePostgresReadiness(options: { repoRoot: string }): { available: boolean; reason: string };
  createDisposableSchema(options: { repoRoot: string; coreSchemaPath: string; workspaceSchemaPath: string; extraModels: string }):
    Promise<{ url: string; cleanup(): Promise<void> }>;
  childEnvironment(url: string): NodeJS.ProcessEnv;
};
const readiness = helper.nativePostgresReadiness({ repoRoot });
const TENANT_A = '11111111-1111-1111-1111-111111111111';
const TENANT_B = '22222222-2222-2222-2222-222222222222';
const OWNER = 'user_test_owner';
const COMMENTER = 'user_test_commenter';
const EDITOR = 'user_test_editor';
const UNRELATED = 'user_test_unrelated';
const CLIENT = '33333333-3333-4333-8333-333333333333';

const d = readiness.available ? describe : describe.skip;

d(`Workspace engine API integration${readiness.available ? '' : ` [SKIP: ${readiness.reason}]`}`, () => {
  let database: Awaited<ReturnType<typeof helper.createDisposableSchema>> | undefined;
  let prisma: PrismaService;
  let drafts: DraftsService;
  let documents: DocumentsService;
  let comments: CommentsService;
  let context: ContextService;
  let templates: TemplatesService;
  let exportService: ExportService;
  const suggestCommentEdit = jest.fn(async () => { throw new Error('Generation is outside engine CRUD qualification'); });

  beforeAll(async () => {
    database = await helper.createDisposableSchema({
      repoRoot, coreSchemaPath: join(repoRoot, 'apps/api/prisma/schema.prisma'),
      workspaceSchemaPath: join(repoRoot, 'apps/workspace/prisma/schema.prisma'),
      extraModels: await readFile(join(__dirname, 'support/ws-source-action.fixture.prisma'), 'utf8'),
    });
    // Invoke the actual template seed CLI with its required explicit verb.
    execFileSync(process.execPath, [require.resolve('tsx/cli'), 'prisma/seed-workspace.ts', '--seed'], {
      cwd: join(repoRoot, 'apps/workspace'), env: helper.childEnvironment(database.url), timeout: 30_000,
    });
    prisma = new PrismaService({ datasources: { db: { url: database.url } } });
    await prisma.$connect();
    for (const [id, slug] of [[TENANT_A, 'engine-a'], [TENANT_B, 'engine-b']]) {
      await prisma.$executeRaw`INSERT INTO tenants (id,slug,name,status,updated_at)
        VALUES (${id}::uuid,${slug},${slug},'active',now())`;
    }
    for (const [index, actor] of [OWNER, COMMENTER, EDITOR, UNRELATED].entries()) {
      const id = `44444444-4444-4444-8444-${String(index + 1).padStart(12, '0')}`;
      await prisma.$executeRaw`INSERT INTO users (id,clerk_user_id,email,updated_at)
        VALUES (${id}::uuid,${actor},${`${actor}@engine.invalid`},now())`;
      await prisma.$executeRaw`INSERT INTO tenant_memberships (id,tenant_id,user_id,role,status,updated_at)
        VALUES (${id}::uuid,${TENANT_A}::uuid,${id}::uuid,'standard_user','active',now())`;
    }
    await prisma.$executeRaw`INSERT INTO clients (id,tenant_id,name,status,updated_at)
      VALUES (${CLIENT}::uuid,${TENANT_A}::uuid,'Synthetic engine client','active',now())`;
    const collaborators = new CollaboratorsService(prisma, new NotificationsService(prisma));
    drafts = new DraftsService(prisma, collaborators);
    documents = new DocumentsService(prisma, collaborators);
    // No model operation is exercised; all authorization uses the real owner.
    comments = new CommentsService(prisma, { suggestCommentEdit } as unknown as GenerationService, collaborators);
    context = new ContextService(prisma, collaborators);
    templates = new TemplatesService(prisma);
    exportService = new ExportService(prisma, collaborators);
  }, 240_000);

  afterAll(async () => {
    try { if (prisma) await prisma.$disconnect(); } finally { await database?.cleanup(); }
    expect(suggestCommentEdit).not.toHaveBeenCalled();
  }, 60_000);

  test('AC-3.3 draft create→get round-trips; funding product carries ask object', async () => {
    const created = await drafts.create(TENANT_A, OWNER, {
      industry: 'Defense & Aerospace',
      product: 'Appropriations Justification',
      clientId: CLIENT,
    });
    expect(created.id).toBeTruthy();
    expect(created.product).toBe('Appropriations Justification');
    expect(created.ask).toMatchObject({ amount: '', pb: '', delta: '' });
    expect(created.documents).toHaveLength(1); // primary tab seeded
    expect(created.clientId).toBe(CLIENT);
    expect(created.client).toBe('Synthetic engine client');
    const fetched = await drafts.byId(TENANT_A, created.id, OWNER);
    expect(fetched.docTitle).toBe(created.docTitle);
  });

  test('AC-3.3 non-funding product persists ask = "n/a"', async () => {
    const created = await drafts.create(TENANT_A, OWNER, {
      industry: 'Commerce & Tech',
      product: 'Report Language Request',
    });
    expect(created.ask).toBe('n/a');
  });

  test('AC-3.3 autosave PATCH merges config + promotes hot fields', async () => {
    const created = await drafts.create(TENANT_A, OWNER, { product: 'White paper' });
    const updated = await drafts.update(TENANT_A, created.id, OWNER, {
      docTitle: 'JaiaBot HYDRO White Paper',
      config: { tone: 'Persuasive', pages: 3 },
    });
    expect(updated.docTitle).toBe('JaiaBot HYDRO White Paper');
    expect((updated.config as Record<string, unknown>).tone).toBe('Persuasive');
    expect((updated.config as Record<string, unknown>).pages).toBe(3);
  });

  test('AC-3.4 adding a 2nd document tab flips draft to packet', async () => {
    const created = await drafts.create(TENANT_A, OWNER, { product: 'White paper' });
    expect(created.isPacket).toBe(false);
    await documents.add(TENANT_A, created.id, OWNER, { name: 'Cover letter' });
    const after = await drafts.byId(TENANT_A, created.id, OWNER);
    expect(after.isPacket).toBe(true);
    expect(after.docCount).toBe(2);
  });

  test('tenant isolation: tenant B cannot read tenant A draft', async () => {
    const created = await drafts.create(TENANT_A, OWNER, { product: 'White paper' });
    await expect(drafts.byId(TENANT_B, created.id, OWNER)).rejects.toThrow('Draft not found');
  });

  test('AC-3.2 templates: 1 primary + 1 secondary per product', async () => {
    const res = await templates.forProduct(TENANT_A, 'NDAA Authorization Request');
    expect(res.primary).toBeTruthy();
    expect(res.secondary).toBeTruthy();
    expect(res.primary?.meriPrimary).toBe(true);
    expect(res.secondary?.meriSecondary).toBe(true);
    expect(res.all.length).toBeGreaterThanOrEqual(2);
  });

  test('AC-3.5 comments thread + commenter cannot resolve', async () => {
    const draft = await drafts.create(TENANT_A, OWNER, { product: 'White paper' });
    const docId = draft.documents[0]!.id;
    await prisma.wsCollaborator.createMany({ data: [
      { tenantId: TENANT_A, draftId: draft.id, subjectId: COMMENTER, role: 'commenter', status: 'active' },
      { tenantId: TENANT_A, draftId: draft.id, subjectId: EDITOR, role: 'editor', status: 'active' },
    ] });
    const c = await comments.create(TENANT_A, docId, OWNER, {
      body: 'Tighten the ask',
      quote: 'the program',
      anchor: { start: 10, end: 21 },
    });
    expect(c.id).toBeTruthy();
    const reply = await comments.create(TENANT_A, docId, OWNER, {
      body: 'Agreed',
      parentId: c.id,
    });
    expect(reply.parentId).toBe(c.id);
    // commenter role cannot resolve
    await expect(
      comments.update(TENANT_A, docId, c.id, COMMENTER, { resolved: true }),
    ).rejects.toThrow('Only owners, editors and reviewers can resolve comments');
    expect((await prisma.wsComment.findUniqueOrThrow({ where: { id: c.id } })).resolved).toBe(false);
    // editor can resolve
    const resolved = await comments.update(TENANT_A, docId, c.id, EDITOR, { resolved: true });
    expect(resolved.resolved).toBe(true);
  });

  test('AC-3.6 context items add + list + remove', async () => {
    const draft = await drafts.create(TENANT_A, OWNER, {
      product: 'White paper',
      clientId: CLIENT,
    });
    const item = await context.addItem(TENANT_A, draft.id, {
      kind: 'free-text',
      payload: { text: 'Emphasize ROI over technical feasibility' },
    }, OWNER);
    const items = await context.listItems(TENANT_A, draft.id, OWNER);
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toBe(item.id);
    // (The client/office-scoped mock `sources()`/`news()` catalog was removed in
    // the Phase 3 cleanup — never wired to real data, no consumer.)
    await context.removeItem(TENANT_A, draft.id, item.id, OWNER);
    expect(await context.listItems(TENANT_A, draft.id, OWNER)).toHaveLength(0);
  });

  test('AC-7.1 export docx returns a valid .docx (zip/OOXML) buffer', async () => {
    const draft = await drafts.create(TENANT_A, OWNER, {
      product: 'White paper',
      docTitle: 'JaiaBot HYDRO White Paper',
    });
    await drafts.update(TENANT_A, draft.id, OWNER, {
      config: { sectionContent: { 'Problem statement': 'The Navy faces a coverage gap.' } },
    });
    const { filename, buffer } = await exportService.buildDocx(TENANT_A, draft.id, undefined, OWNER);
    expect(filename).toMatch(/\.docx$/);
    // OOXML .docx is a ZIP archive — first two bytes are 'PK'.
    expect(buffer.length).toBeGreaterThan(1000);
    expect(buffer[0]).toBe(0x50); // P
    expect(buffer[1]).toBe(0x4b); // K
  });

  test('AC-7.1 export rejects cross-tenant access', async () => {
    const draft = await drafts.create(TENANT_A, OWNER, { product: 'White paper' });
    await expect(exportService.buildDocx(TENANT_B, draft.id, undefined, OWNER)).rejects.toThrow('Draft not found');
  });

  test('an active same-tenant member without a collaborator grant cannot read or edit', async () => {
    const draft = await drafts.create(TENANT_A, OWNER, { product: 'White paper' });
    await expect(drafts.byId(TENANT_A, draft.id, UNRELATED)).rejects.toThrow('Draft not found');
    await expect(drafts.update(TENANT_A, draft.id, UNRELATED, { docTitle: 'Unauthorized' }))
      .rejects.toThrow('Only owners and editors can edit this document');
    expect((await drafts.byId(TENANT_A, draft.id, OWNER)).docTitle).toBe(draft.docTitle);
  });

  test('revoked membership refuses creation even for a known actor', async () => {
    await prisma.$executeRaw`UPDATE tenant_memberships SET status='removed'
      WHERE tenant_id=${TENANT_A}::uuid AND user_id IN (SELECT id FROM users WHERE clerk_user_id=${UNRELATED})`;
    const before = await prisma.wsDraft.count({ where: { tenantId: TENANT_A, ownerId: UNRELATED } });
    try {
      await expect(drafts.create(TENANT_A, UNRELATED, { product: 'White paper' })).rejects.toThrow('Draft not found');
      expect(await prisma.wsDraft.count({ where: { tenantId: TENANT_A, ownerId: UNRELATED } })).toBe(before);
    } finally {
      await prisma.$executeRaw`UPDATE tenant_memberships SET status='active'
        WHERE tenant_id=${TENANT_A}::uuid AND user_id IN (SELECT id FROM users WHERE clerk_user_id=${UNRELATED})`;
    }
  });

  test('a display name cannot substitute for explicit client authority', async () => {
    const before = await prisma.wsDraft.count({ where: { tenantId: TENANT_A } });
    await expect(drafts.create(TENANT_A, OWNER, { product: 'White paper', client: 'Synthetic engine client' }))
      .rejects.toThrow('Select an explicit client UUID');
    expect(await prisma.wsDraft.count({ where: { tenantId: TENANT_A } })).toBe(before);
  });
});
