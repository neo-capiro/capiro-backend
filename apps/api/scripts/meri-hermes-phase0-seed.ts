/**
 * Seed the LOCAL fixture data for the Meri/Hermes Phase 0 harness.
 *
 *   DATABASE_URL=postgresql://capiro:capiro@localhost:5432/capiro tsx scripts/meri-hermes-phase0-seed.ts
 *
 * Idempotent (fixed ids, upserts). Creates two fixture tenants, three users,
 * memberships, two clients (one behind an ethical wall granted to Alice only),
 * conversations, memory_items with distinguishable marker facts, and one DOCX
 * attachment owned by Alice whose bytes contain a unique sentence.
 *
 * SAFE: refuses to run against anything but a localhost/127.0.0.1 database.
 * `tenants` and `memory_items` are FORCE-RLS tables, so everything runs in one
 * transaction with `app.bypass_rls` on (same pattern as set-tenant-flag.ts).
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { Document, Packer, Paragraph, TextRun } from 'docx';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

// Fixture definitions live at the repo root so the runner (Node) and this seed
// (TypeScript under tsx or compiled CJS) read the same file. Resolved from the
// process cwd (apps/api) with a fallback for running from the repo root.
const FIXTURE_CANDIDATES = [
  path.resolve(process.cwd(), '../../scripts/meri-hermes/phase0-fixtures.json'),
  path.resolve(process.cwd(), 'scripts/meri-hermes/phase0-fixtures.json'),
];
const fixturePath = FIXTURE_CANDIDATES.find((candidate) => existsSync(candidate));
if (!fixturePath) throw new Error('phase0-fixtures.json not found relative to cwd');
const FIX = JSON.parse(readFileSync(fixturePath, 'utf8')) as typeof import('../../../scripts/meri-hermes/phase0-fixtures.json');

const url = process.env.DATABASE_URL ?? '';
if (!/localhost|127\.0\.0\.1/.test(url)) {
  throw new Error('Refusing to seed: DATABASE_URL must point at a local fixture database');
}
const prisma = new PrismaClient();

async function buildDocx(sentence: string): Promise<Buffer> {
  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({ children: [new TextRun({ text: 'Phase 0 fixture — markup notes', bold: true })] }),
          new Paragraph({ children: [new TextRun('These notes exist only to prove native document ingestion in the Hermes worker.')] }),
          new Paragraph({ children: [new TextRun(sentence)] }),
          new Paragraph({ children: [new TextRun('Action items: confirm the October 7 date with committee staff; circulate the Section 4 cap to the client.')] }),
        ],
      },
    ],
  });
  return Buffer.from(await Packer.toBuffer(doc));
}

async function main(): Promise<void> {
  const docxBytes = await buildDocx(FIX.attachments.aliceDocx.uniqueSentence);
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;

    for (const tenant of Object.values(FIX.tenants)) {
      const isPilot = tenant.slug === FIX.tenants.pilot.slug;
      await tx.tenant.upsert({
        where: { id: tenant.id },
        create: {
          id: tenant.id,
          slug: tenant.slug,
          name: tenant.name,
          status: 'active',
          settings: isPilot ? { clioFeatureFlags: { 'meri.hermesRuntime': true }, phase0Fixture: true } : { phase0Fixture: true },
        },
        update: {
          name: tenant.name,
          status: 'active',
          settings: isPilot ? { clioFeatureFlags: { 'meri.hermesRuntime': true }, phase0Fixture: true } : { phase0Fixture: true },
        },
      });
    }

    for (const user of Object.values(FIX.users)) {
      await tx.user.upsert({
        where: { id: user.id },
        create: { id: user.id, clerkUserId: user.clerkUserId, email: user.email, firstName: 'Phase0', lastName: user.email.split('.')[0] },
        update: { clerkUserId: user.clerkUserId, email: user.email },
      });
      const tenantId = FIX.tenants[user.tenant as keyof typeof FIX.tenants].id;
      await tx.tenantMembership.upsert({
        where: { tenantId_userId: { tenantId, userId: user.id } },
        create: { tenantId, userId: user.id, role: user.role as 'standard_user', status: 'active', joinedAt: new Date() },
        update: { role: user.role as 'standard_user', status: 'active' },
      });
    }

    const pilot = FIX.tenants.pilot.id;
    for (const client of Object.values(FIX.clients)) {
      await tx.client.upsert({
        where: { id: client.id },
        create: { id: client.id, tenantId: pilot, name: client.name, memoryWall: client.memoryWall },
        update: { name: client.name, memoryWall: client.memoryWall, status: 'active' },
      });
    }
    await tx.clientMemoryAccess.deleteMany({ where: { tenantId: pilot, clientId: FIX.clients.walled.id } });
    for (const grantee of FIX.clients.walled.grants) {
      const userId = FIX.users[grantee as keyof typeof FIX.users].id;
      await tx.clientMemoryAccess.create({ data: { tenantId: pilot, clientId: FIX.clients.walled.id, userId } });
    }

    for (const conversation of Object.values(FIX.conversations)) {
      const tenantId = FIX.tenants[conversation.tenant as keyof typeof FIX.tenants].id;
      const userId = FIX.users[conversation.user as keyof typeof FIX.users].id;
      await tx.clioConversation.upsert({
        where: { id: conversation.id },
        create: { id: conversation.id, tenantId, userId, title: `Phase 0 fixture conversation (${conversation.user})`, metadata: { phase0Fixture: true } },
        update: { archivedAt: null, metadata: { phase0Fixture: true } },
      });
      // Fresh transcript per seed so evidence starts from a known state.
      await tx.clioMessage.deleteMany({ where: { conversationId: conversation.id } });
      await tx.clioArtifact.deleteMany({ where: { conversationId: conversation.id } });
    }

    for (const item of Object.values(FIX.memoryItems)) {
      const ownerUserId = 'owner' in item && item.owner ? FIX.users[item.owner as keyof typeof FIX.users].id : null;
      const clientId = 'client' in item && item.client ? FIX.clients[item.client as keyof typeof FIX.clients].id : null;
      const sections = JSON.stringify([{ key: 'summary', heading: 'Summary', owner: 'human', body: item.body }]);
      await tx.$executeRaw`
        INSERT INTO memory_items (id, tenant_id, client_id, owner_user_id, type, visibility, slug, title, source, provenance, sections_jsonb, status)
        VALUES (${item.id}::uuid, ${pilot}::uuid, ${clientId}::uuid, ${ownerUserId}::uuid, ${item.type}, ${item.visibility}, ${item.slug}, ${item.title},
                'manual', 'human', ${sections}::jsonb, 'active')
        ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, sections_jsonb = EXCLUDED.sections_jsonb, visibility = EXCLUDED.visibility,
                owner_user_id = EXCLUDED.owner_user_id, client_id = EXCLUDED.client_id, status = 'active', revoked_at = NULL, expires_at = NULL, updated_at = now()`;
    }

    const attachment = FIX.attachments.aliceDocx;
    await tx.clioAttachment.upsert({
      where: { id: attachment.id },
      create: {
        id: attachment.id,
        tenantId: pilot,
        userId: FIX.users.alice.id,
        filename: attachment.filename,
        kind: 'docx',
        status: 'parsed',
        mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        byteSize: docxBytes.byteLength,
        pages: 1,
        textContent: attachment.applicationExtractionMarker,
        data: docxBytes,
      },
      update: { messageId: null, byteSize: docxBytes.byteLength, data: docxBytes, textContent: attachment.applicationExtractionMarker },
    });

    // Remove candidates from previous harness runs so counts are meaningful.
    await tx.$executeRaw`DELETE FROM memory_candidate WHERE tenant_id = ${pilot}::uuid AND source_kind = 'model_extraction' AND provenance_jsonb->>'source' = 'hermes_runtime'`;
  });

  const summary = {
    seededAt: new Date().toISOString(),
    database: url.replace(/\/\/[^@]+@/, '//<redacted>@'),
    tenants: Object.values(FIX.tenants).map((t) => ({ id: t.id, slug: t.slug })),
    users: Object.values(FIX.users).map((u) => ({ id: u.id, tenant: u.tenant, role: u.role })),
    docxBytes: docxBytes.byteLength,
  };
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ seeded: true, ...summary }, null, 2));
}

main()
  .catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

// Prisma.InputJsonValue is referenced for settings typing above.
void Prisma;
