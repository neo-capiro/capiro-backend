import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import { execSync } from 'node:child_process';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { DraftsService } from '../src/drafts/drafts.service.js';
import { DocumentsService } from '../src/documents/documents.service.js';
import { CommentsService } from '../src/comments/comments.service.js';
import { ContextService } from '../src/context/context.service.js';
import { TemplatesService } from '../src/templates/templates.service.js';
import { ExportService } from '../src/export/export.service.js';

/**
 * Engine API integration (AC-3.2..3.6) against an isolated Postgres schema.
 * Requires a local Postgres (docker compose). Skipped automatically when
 * WS_TEST_DATABASE_URL is not set.
 *
 * Verifies: draft create→get round-trip, packet/ask derivation, tenant
 * isolation, templates primary/secondary, document tabs, comment threads +
 * commenter resolve guard, context items.
 */
const TEST_DB = process.env.WS_TEST_DATABASE_URL;
const TENANT_A = '11111111-1111-1111-1111-111111111111';
const TENANT_B = '22222222-2222-2222-2222-222222222222';
const OWNER = 'user_test_owner';

const d = TEST_DB ? describe : describe.skip;

d('Workspace engine API integration', () => {
  let prisma: PrismaService;
  let drafts: DraftsService;
  let documents: DocumentsService;
  let comments: CommentsService;
  let context: ContextService;
  let templates: TemplatesService;
  let exportService: ExportService;

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    // Apply migrations + seed into the isolated schema.
    execSync('pnpm exec prisma migrate deploy', { stdio: 'inherit', env: process.env });
    execSync('pnpm exec tsx prisma/seed-workspace.ts', { stdio: 'inherit', env: process.env });
    prisma = new PrismaService();
    await prisma.$connect();
    drafts = new DraftsService(prisma);
    documents = new DocumentsService(prisma);
    comments = new CommentsService(prisma);
    context = new ContextService(prisma);
    templates = new TemplatesService(prisma);
    exportService = new ExportService(prisma);
  }, 120_000);

  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
  });

  test('AC-3.3 draft create→get round-trips; funding product carries ask object', async () => {
    const created = await drafts.create(TENANT_A, OWNER, {
      industry: 'Defense & Aerospace',
      product: 'Appropriations Justification',
      client: 'Aerovance Systems',
    });
    expect(created.id).toBeTruthy();
    expect(created.product).toBe('Appropriations Justification');
    expect(created.ask).toMatchObject({ amount: '', pb: '', delta: '' });
    expect(created.documents).toHaveLength(1); // primary tab seeded
    const fetched = await drafts.byId(TENANT_A, created.id);
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
    const updated = await drafts.update(TENANT_A, created.id, {
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
    await documents.add(TENANT_A, created.id, { name: 'Cover letter' });
    const after = await drafts.byId(TENANT_A, created.id);
    expect(after.isPacket).toBe(true);
    expect(after.docCount).toBe(2);
  });

  test('tenant isolation: tenant B cannot read tenant A draft', async () => {
    const created = await drafts.create(TENANT_A, OWNER, { product: 'White paper' });
    await expect(drafts.byId(TENANT_B, created.id)).rejects.toThrow('Draft not found');
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
      comments.update(TENANT_A, docId, c.id, 'commenter', { resolved: true }),
    ).rejects.toThrow('Commenter role cannot resolve');
    // editor can resolve
    const resolved = await comments.update(TENANT_A, docId, c.id, 'editor', { resolved: true });
    expect(resolved.resolved).toBe(true);
  });

  test('AC-3.6 context items add + list + remove', async () => {
    const draft = await drafts.create(TENANT_A, OWNER, {
      product: 'White paper',
      client: 'Aerovance Systems',
    });
    const item = await context.addItem(TENANT_A, draft.id, {
      kind: 'free-text',
      payload: { text: 'Emphasize ROI over technical feasibility' },
    });
    const items = await context.listItems(TENANT_A, draft.id);
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toBe(item.id);
    // (The client/office-scoped mock `sources()`/`news()` catalog was removed in
    // the Phase 3 cleanup — never wired to real data, no consumer.)
    await context.removeItem(TENANT_A, draft.id, item.id);
    expect(await context.listItems(TENANT_A, draft.id)).toHaveLength(0);
  });

  test('AC-7.1 export docx returns a valid .docx (zip/OOXML) buffer', async () => {
    const draft = await drafts.create(TENANT_A, OWNER, {
      product: 'White paper',
      docTitle: 'JaiaBot HYDRO White Paper',
    });
    await drafts.update(TENANT_A, draft.id, {
      config: { sectionContent: { 'Problem statement': 'The Navy faces a coverage gap.' } },
    });
    const { filename, buffer } = await exportService.buildDocx(TENANT_A, draft.id);
    expect(filename).toMatch(/\.docx$/);
    // OOXML .docx is a ZIP archive — first two bytes are 'PK'.
    expect(buffer.length).toBeGreaterThan(1000);
    expect(buffer[0]).toBe(0x50); // P
    expect(buffer[1]).toBe(0x4b); // K
  });

  test('AC-7.1 export rejects cross-tenant access', async () => {
    const draft = await drafts.create(TENANT_A, OWNER, { product: 'White paper' });
    await expect(exportService.buildDocx(TENANT_B, draft.id)).rejects.toThrow('Draft not found');
  });
});
